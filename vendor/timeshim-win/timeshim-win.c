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
#include <stdarg.h>
#include <string.h>

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

/* -------------------------------------------------------------------------
 * DIAGNOSTIC INSTRUMENTATION (session 7 — "custom time reverts" investigation)
 * Behind PEBBLE_FAKETIME_DEBUG (default ON in this diagnostic build; set "0" to
 * silence). Appends to PEBBLE_FAKETIME_LOG, else %TEMP%\pb-faketime-dll.log.
 * Purpose: bisect WHERE the watch reverts — is the ctl being clobbered (TS
 * write-log shows it), or does qemu keep calling our hooks yet the watch still
 * snaps to real time (→ an UNHOOKED clock source)? The heartbeat below logs the
 * fake time we'd return + per-hook call counts once/sec, so a frozen counter or
 * a still-custom fake-time-vs-reverted-watch is directly visible.
 * REMOVE / gate-off before shipping a release build.
 * ------------------------------------------------------------------------- */
static int      g_debug       = 0;
static char     g_logPath[MAX_PATH] = {0};
static int64_t  g_lastHbQpc   = 0;
static volatile LONG64 g_cnt_gstaft  = 0;  /* GetSystemTimeAsFileTime calls */
static volatile LONG64 g_cnt_precise = 0;  /* GetSystemTimePreciseAsFileTime calls */
static volatile LONG64 g_cnt_t64     = 0;  /* _time64 calls */
static volatile LONG64 g_cnt_t32     = 0;  /* _time32 calls */
static volatile LONG64 g_cnt_ntqst   = 0;  /* ntdll NtQuerySystemTime calls */
static volatile LONG64 g_cnt_rtlprec = 0;  /* ntdll RtlGetSystemTimePrecise calls */

/* Append one preformatted line to the debug log. Open/append/close per line so
 * the main process (TS writer) and qemu (this DLL) never share a handle, and a
 * crash can't lose buffered data. No-op unless g_debug && g_logPath set. */
static void dbg_log(const char *fmt, ...) {
    if (!g_debug || !g_logPath[0]) return;
    char line[512];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(line, sizeof(line), fmt, ap);
    va_end(ap);
    if (n <= 0) return;
    if (n > (int)sizeof(line)) n = (int)sizeof(line);
    HANDLE h = CreateFileA(g_logPath, FILE_APPEND_DATA,
                           FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    DWORD wrote = 0;
    WriteFile(h, line, (DWORD)n, &wrote, NULL);
    CloseHandle(h);
}

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

    /* DIAG heartbeat (~1s): the fake time we'd serve right now + how many times
     * each hooked source has been called. If the watch reverts while this keeps
     * logging a CUSTOM fake_unix with RISING counts → qemu is reading an UNHOOKED
     * source. If a counter stops rising → qemu stopped calling that hook. */
    if (g_debug && (mono - g_lastHbQpc) >= g_qpcFreq) {
        g_lastHbQpc = mono;
        int64_t fu = (fake_now_locked(real) - EPOCH_DIFF_100NS) / TEN_MILLION;
        dbg_log("[hb] fake_unix=%lld rate=%.3f calls gstaft=%lld precise=%lld t64=%lld t32=%lld ntqst=%lld rtlprec=%lld\r\n",
                (long long)fu, g_rate,
                (long long)g_cnt_gstaft, (long long)g_cnt_precise,
                (long long)g_cnt_t64, (long long)g_cnt_t32,
                (long long)g_cnt_ntqst, (long long)g_cnt_rtlprec);
    }

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
        /* DIAG: the ctl file changed (mtime moved) and we re-read it. Shows WHEN
         * the control value flips and to WHAT — e.g. a stray System "<now> 1"
         * write a few seconds after a custom set would appear here. */
        dbg_log("[ctl] reread tgt=%s rate=%.3f\r\n", tgt, r);
    }
}

/* Current fake time in 100ns FILETIME units (locked). */
static int64_t fake_100ns(void) {
    EnterCriticalSection(&g_lock);
    int64_t real = real_now_100ns();
    check_ctl_file(real);
    int64_t f = fake_now_locked(real);
    LeaveCriticalSection(&g_lock);
    return f;
}

static void fill_fake(LPFILETIME ft) {
    i64_to_ft(fake_100ns(), ft);
}

/* Current fake time in unix seconds (for the CRT time() family). */
static int64_t fake_unix_seconds(void) {
    return (fake_100ns() - EPOCH_DIFF_100NS) / TEN_MILLION;
}

/* Replacement KERNEL32 exports — same signature as the originals (return void). */
static void WINAPI Fake_GetSystemTimeAsFileTime(LPFILETIME ft) { InterlockedIncrement64(&g_cnt_gstaft); if (ft) fill_fake(ft); }
static void WINAPI Fake_GetSystemTimePreciseAsFileTime(LPFILETIME ft) { InterlockedIncrement64(&g_cnt_precise); if (ft) fill_fake(ft); }

/* Replacement msvcrt time sources. qemu-pebble imports _time64 + _time32 and
 * calls them (via time()) to re-jam the firmware RTC; on Windows the CRT reads
 * these straight from KUSER_SHARED_DATA, bypassing the KERNEL32 hooks above, so
 * WITHOUT faking them the watch snapped back to real time a few seconds after a
 * custom set. __cdecl (one x64 convention); time_t* in/out like the originals. */
static long long __cdecl Fake_time64(long long *t) {
    InterlockedIncrement64(&g_cnt_t64);
    long long s = (long long)fake_unix_seconds();
    if (t) *t = s;
    return s;
}
static long __cdecl Fake_time32(long *t) {
    InterlockedIncrement64(&g_cnt_t32);
    long s = (long)fake_unix_seconds();
    if (t) *t = s;
    return s;
}

/* ntdll layer — the source BELOW the KERNEL32 exports. v2.1.2 logs proved every
 * imported KERNEL32/msvcrt/glib wall-clock path is hooked + frozen yet the guest
 * RTC still reverts, so the firmware re-jam must read host time via a DIRECT
 * ntdll call (NtQuerySystemTime[Precise]) that bypasses our export patches.
 * Both fill a LARGE_INTEGER with 100ns-since-1601 (identical units to FILETIME /
 * our fake_100ns) and return STATUS_SUCCESS. Trampoline-free: we never call the
 * originals (real time is synthesized from QPC). NTSTATUS=LONG; x64 has a single
 * calling convention so the __stdcall tag is cosmetic. */
static long __stdcall Fake_NtQuerySystemTime(LARGE_INTEGER *t) {
    InterlockedIncrement64(&g_cnt_ntqst);
    if (t) t->QuadPart = fake_100ns();
    return 0; /* STATUS_SUCCESS */
}
/* RtlGetSystemTimePrecise (Win8+) is the precise wall-clock primitive — it
 * RETURNS the 100ns-since-1601 value (in RAX), it does NOT take an out-pointer.
 * GetSystemTimePreciseAsFileTime bottoms out here; a direct caller would bypass
 * our kernel32 patch, so we fake it too. */
static long long __stdcall Fake_RtlGetSystemTimePrecise(void) {
    InterlockedIncrement64(&g_cnt_rtlprec);
    return (long long)fake_100ns();
}

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

    /* DIAG: default ON in this diagnostic build (set PEBBLE_FAKETIME_DEBUG=0 to
     * silence). Log path: PEBBLE_FAKETIME_LOG, else %TEMP%\pb-faketime-dll.log. */
    char dbgEnv[8] = {0};
    GetEnvironmentVariableA("PEBBLE_FAKETIME_DEBUG", dbgEnv, sizeof(dbgEnv));
    g_debug = (dbgEnv[0] != '0');
    if (!GetEnvironmentVariableA("PEBBLE_FAKETIME_LOG", g_logPath, sizeof(g_logPath))) {
        char tmp[MAX_PATH] = {0};
        DWORD tn = GetEnvironmentVariableA("TEMP", tmp, sizeof(tmp));
        if (tn == 0 || tn >= sizeof(tmp)) GetEnvironmentVariableA("TMP", tmp, sizeof(tmp));
        _snprintf(g_logPath, sizeof(g_logPath), "%s\\pb-faketime-dll.log", tmp);
    }

    g_anchorReal = g_realFT0;
    g_anchorFake = g_realFT0 + off * TEN_MILLION;
    g_ready = 1;

    int ok_gstaft = install_jmp((void *)realGetTime, (void *)Fake_GetSystemTimeAsFileTime);
    int ok_precise = 0;
    if (realPrecise)
        ok_precise = install_jmp(realPrecise, (void *)Fake_GetSystemTimePreciseAsFileTime);

    /* Also hook the CRT time() sources qemu imports from msvcrt. msvcrt is mapped
     * by the time we run (our own DLL imports it), so GetModuleHandle succeeds. */
    int ok_t64 = 0, ok_t32 = 0;
    HMODULE crt = GetModuleHandleW(L"msvcrt.dll");
    void *t64 = NULL, *t32 = NULL;
    if (crt) {
        t64 = (void *)GetProcAddress(crt, "_time64");
        t32 = (void *)GetProcAddress(crt, "_time32");
        if (t64) ok_t64 = install_jmp(t64, (void *)Fake_time64);
        if (t32) ok_t32 = install_jmp(t32, (void *)Fake_time32);
    }

    /* v2.1.3 FIX ATTEMPT #3: hook the ntdll layer below KERNEL32. ntdll is always
     * mapped. NtQuerySystemTimePrecise exists on Win8+; NtQuerySystemTime is
     * universal. If the guest RTC reads host time through either, this catches it. */
    int ok_ntqst = 0, ok_rtlprec = 0;
    HMODULE nt = GetModuleHandleW(L"ntdll.dll");
    void *p_ntqst = NULL, *p_rtlprec = NULL;
    if (nt) {
        p_ntqst   = (void *)GetProcAddress(nt, "NtQuerySystemTime");
        p_rtlprec = (void *)GetProcAddress(nt, "RtlGetSystemTimePrecise");
        if (p_ntqst)   ok_ntqst   = install_jmp(p_ntqst,   (void *)Fake_NtQuerySystemTime);
        if (p_rtlprec) ok_rtlprec = install_jmp(p_rtlprec, (void *)Fake_RtlGetSystemTimePrecise);
    }

    /* DIAG load marker: proves the DLL actually attached to THIS qemu at REAL
     * boot, with which hooks live + the ctl path it will watch. Absent from the
     * log ⇒ injection never happened (AV block / suspended-loader fragility). */
    dbg_log("[attach] pid=%lu off=%lld rate=%.3f ctl=\"%s\" hooks: "
            "gstaft=%d precise=%d msvcrt=%d t64=%d t32=%d ntqst=%d rtlprec=%d\r\n",
            (unsigned long)GetCurrentProcessId(), (long long)off, g_rate, g_ctlPath,
            ok_gstaft, ok_precise, crt ? 1 : 0,
            t64 ? ok_t64 : -1, t32 ? ok_t32 : -1,
            p_ntqst ? ok_ntqst : -1, p_rtlprec ? ok_rtlprec : -1);
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved) {
    (void)inst; (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        if (!g_ready) init_once();
    }
    return TRUE;
}
