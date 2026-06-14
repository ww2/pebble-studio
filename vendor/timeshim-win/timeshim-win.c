/* timeshim-win.dll — runtime-controllable fake-realtime shim for qemu-pebble.exe
 * on native Windows. The Windows analog of vendor/timeshim/timeshim.c (LD_PRELOAD).
 *
 * MECHANISM
 *   qemu-pebble re-jams the firmware RTC from the qemu PROCESS's wall clock. On
 *   Linux we LD_PRELOAD a shim faking clock_gettime(CLOCK_REALTIME). On Windows
 *   every C-runtime time path (MinGW clock_gettime(CLOCK_REALTIME), gettimeofday,
 *   time/_time64) bottoms out at one of two KERNEL32 exports:
 *       GetSystemTimeAsFileTime
 *       GetSystemTimePreciseAsFileTime
 *   (verified: qemu-pebble.exe imports both.) We INLINE-hook those two exports so
 *   EVERY caller — qemu's own code, the static MinGW CRT, msvcrt.dll — sees the
 *   faked time regardless of which module it calls from.
 *
 * FAKE CLOCK
 *   Real elapsed time is read from QueryPerformanceCounter (monotonic, NOT a
 *   time-of-day API, so we never hook it and never need a trampoline back into the
 *   patched functions). At load we anchor (realFT0, qpc0); thereafter
 *       real_now_100ns = realFT0 + (qpc_now - qpc0) * 1e7 / qpc_freq
 *   and the fake clock is
 *       fake = anchor_fake + (real_now - anchor_real) * rate.
 *
 * CONTROL FILE  (same contract as the Linux shim, set via PEBBLE_FAKETIME_FILE)
 *   one line: "<target_unix_seconds|-> <rate>", re-read on mtime change, throttled
 *   to once per 200ms of real time.
 *     "1577836800 1"  -> jump fake clock to 2020-01-01T00:00:00Z, run 1x
 *     "- 0"           -> keep current fake time, freeze
 *     "- 10"          -> keep current fake time, run 10x
 *   Env fallbacks (read once at load, like the Linux shim):
 *     PEBBLE_FAKETIME_OFFSET  initial offset seconds (default 0)
 *     PEBBLE_FAKETIME_RATE    initial rate (default 1.0)
 *
 * Build: x86_64-w64-mingw32-gcc -O2 -shared -o timeshim-win.dll timeshim-win.c
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>

/* 100ns ticks between 1601-01-01 (FILETIME epoch) and 1970-01-01 (unix epoch). */
#define EPOCH_DIFF_100NS 116444736000000000LL
#define TEN_MILLION      10000000LL

static CRITICAL_SECTION g_lock;
static int      g_ready       = 0;
static int64_t  g_realFT0     = 0;   /* real FILETIME (100ns) captured at anchor */
static int64_t  g_qpc0        = 0;   /* QPC counts at anchor */
static int64_t  g_qpcFreq     = 1;   /* QPC ticks per second */
static int64_t  g_anchorReal  = 0;   /* real 100ns at the last ctl change */
static int64_t  g_anchorFake  = 0;   /* fake 100ns at the last ctl change */
static double   g_rate        = 1.0;
static char     g_ctlPath[MAX_PATH] = {0};
static int64_t  g_ctlMtime    = 0;   /* last seen ctl mtime (FILETIME) */
static int64_t  g_lastCheckQpc = 0;

/* Pointers to the real exports (kept only so we can read the true time ONCE at
 * load, before the inline patch is installed). Not called afterwards. */
typedef void (WINAPI *GetTimeFn)(LPFILETIME);

static int64_t ft_to_i64(const FILETIME *ft) {
    return ((int64_t)ft->dwHighDateTime << 32) | (uint32_t)ft->dwLowDateTime;
}
static void i64_to_ft(int64_t v, LPFILETIME ft) {
    ft->dwLowDateTime  = (DWORD)(v & 0xFFFFFFFF);
    ft->dwHighDateTime = (DWORD)((uint64_t)v >> 32);
}

static int64_t qpc_now(void) {
    LARGE_INTEGER c;
    QueryPerformanceCounter(&c);
    return c.QuadPart;
}

/* real wall clock in 100ns FILETIME units, synthesized from the anchor + QPC. */
static int64_t real_now_100ns(void) {
    int64_t elapsed = ((qpc_now() - g_qpc0) * TEN_MILLION) / g_qpcFreq;
    return g_realFT0 + elapsed;
}

static int64_t fake_now_locked(int64_t real) {
    return g_anchorFake + (int64_t)((double)(real - g_anchorReal) * g_rate);
}

/* Re-read the control file if its mtime changed (throttled to 200ms real time). */
static void check_ctl_file(int64_t real) {
    if (!g_ctlPath[0]) return;
    int64_t mono = qpc_now();
    if ((mono - g_lastCheckQpc) < (g_qpcFreq / 5)) return; /* 200ms */
    g_lastCheckQpc = mono;

    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (!GetFileAttributesExA(g_ctlPath, GetFileExInfoStandard, &fad)) return;
    int64_t mtime = ((int64_t)fad.ftLastWriteTime.dwHighDateTime << 32)
                    | (uint32_t)fad.ftLastWriteTime.dwLowDateTime;
    if (mtime == g_ctlMtime) return;
    g_ctlMtime = mtime;

    HANDLE h = CreateFileA(g_ctlPath, GENERIC_READ,
                           FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    char buf[128] = {0};
    DWORD got = 0;
    ReadFile(h, buf, sizeof(buf) - 1, &got, NULL);
    CloseHandle(h);
    if (got == 0) return;
    buf[got] = '\0';

    char tgt[64] = {0};
    double r = 1.0;
    if (sscanf(buf, "%63s %lf", tgt, &r) == 2) {
        int64_t cur_fake = fake_now_locked(real);
        g_anchorReal = real;
        if (tgt[0] == '-' && tgt[1] == '\0') {
            g_anchorFake = cur_fake;                       /* keep current fake */
        } else {
            int64_t unix_s = _atoi64(tgt);
            g_anchorFake = unix_s * TEN_MILLION + EPOCH_DIFF_100NS;
        }
        g_rate = r;
    }
}

static void fill_fake(LPFILETIME ft) {
    EnterCriticalSection(&g_lock);
    int64_t real = real_now_100ns();
    check_ctl_file(real);
    int64_t f = fake_now_locked(real);
    LeaveCriticalSection(&g_lock);
    i64_to_ft(f, ft);
}

/* Replacement exports — same signature as the originals (return void). */
static void WINAPI Fake_GetSystemTimeAsFileTime(LPFILETIME ft) { if (ft) fill_fake(ft); }
static void WINAPI Fake_GetSystemTimePreciseAsFileTime(LPFILETIME ft) { if (ft) fill_fake(ft); }

/* Overwrite the first 14 bytes of `target` with an absolute jmp to `hook`:
 *   FF 25 00000000     jmp qword ptr [rip+0]
 *   <8-byte absolute target>
 * Position-independent, clobbers no registers, and — because we never call the
 * original again (real time comes from QPC) — needs no trampoline. */
static int install_jmp(void *target, void *hook) {
    unsigned char patch[14] = { 0xFF, 0x25, 0x00, 0x00, 0x00, 0x00 };
    memcpy(patch + 6, &hook, sizeof(hook));
    DWORD old;
    if (!VirtualProtect(target, sizeof(patch), PAGE_EXECUTE_READWRITE, &old)) return 0;
    memcpy(target, patch, sizeof(patch));
    VirtualProtect(target, sizeof(patch), old, &old);
    FlushInstructionCache(GetCurrentProcess(), target, sizeof(patch));
    return 1;
}

static void init_once(void) {
    InitializeCriticalSection(&g_lock);

    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    GetTimeFn realGetTime = (GetTimeFn)GetProcAddress(k32, "GetSystemTimeAsFileTime");
    void *realPrecise = (void *)GetProcAddress(k32, "GetSystemTimePreciseAsFileTime");

    /* Anchor the real clock BEFORE patching, using the genuine export. */
    FILETIME ft;
    realGetTime(&ft);
    g_realFT0 = ft_to_i64(&ft);

    LARGE_INTEGER f, c;
    QueryPerformanceFrequency(&f);
    QueryPerformanceCounter(&c);
    g_qpcFreq = f.QuadPart ? f.QuadPart : 1;
    g_qpc0    = c.QuadPart;
    g_lastCheckQpc = c.QuadPart - g_qpcFreq; /* force a ctl read on first call */

    /* Initial offset/rate from env (one-shot, like the Linux shim). */
    char env[256];
    int64_t off = 0;
    if (GetEnvironmentVariableA("PEBBLE_FAKETIME_OFFSET", env, sizeof(env)))
        off = _atoi64(env);
    if (GetEnvironmentVariableA("PEBBLE_FAKETIME_RATE", env, sizeof(env)))
        g_rate = atof(env);
    GetEnvironmentVariableA("PEBBLE_FAKETIME_FILE", g_ctlPath, sizeof(g_ctlPath));

    g_anchorReal = g_realFT0;
    g_anchorFake = g_realFT0 + off * TEN_MILLION;
    g_ready = 1;

    install_jmp((void *)realGetTime, (void *)Fake_GetSystemTimeAsFileTime);
    if (realPrecise)
        install_jmp(realPrecise, (void *)Fake_GetSystemTimePreciseAsFileTime);
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved) {
    (void)inst; (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        if (!g_ready) init_once();
    }
    return TRUE;
}
