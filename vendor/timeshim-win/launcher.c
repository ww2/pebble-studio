/* launcher.exe — the Windows analog of the Linux qemu-pebble wrapper script.
 *
 * pebble-tool's emulator.py honors PEBBLE_QEMU_PATH as the qemu executable to
 * spawn. We point that at THIS launcher; it then:
 *   1. locates the real qemu  (env PEBBLE_FAKETIME_REAL_QEMU, else
 *      <launcher dir>\qemu-pebble.exe),
 *   2. starts it SUSPENDED with the exact same arguments pebble-tool passed us,
 *   3. injects timeshim-win.dll  (env PEBBLE_FAKETIME_DLL, else
 *      <launcher dir>\timeshim-win.dll)  via remote LoadLibraryW,
 *   4. resumes it and propagates its exit code.
 *
 * The child inherits our environment, so PEBBLE_FAKETIME_FILE reaches the DLL.
 * If injection fails the child still runs (unshimmed) rather than hard-failing,
 * mirroring the Linux wrapper's "missing .so -> unshimmed boot" behavior.
 *
 * Build: x86_64-w64-mingw32-gcc -O2 -o launcher.exe launcher.c
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>

/* Directory of this executable, including trailing backslash. */
static void exe_dir(wchar_t *out, DWORD cap) {
    DWORD n = GetModuleFileNameW(NULL, out, cap);
    while (n > 0 && out[n - 1] != L'\\') n--;
    out[n] = L'\0';
}

/* Return a pointer past argv[0] in the raw command line (quote-aware), so we can
 * splice the real qemu path in front of the original arguments. */
static wchar_t *skip_argv0(wchar_t *cmd) {
    wchar_t *p = cmd;
    if (*p == L'"') {
        p++;
        while (*p && *p != L'"') p++;
        if (*p == L'"') p++;
    } else {
        while (*p && *p != L' ' && *p != L'\t') p++;
    }
    while (*p == L' ' || *p == L'\t') p++;
    return p;
}

static void inject(HANDLE proc, const wchar_t *dllPath) {
    SIZE_T bytes = (lstrlenW(dllPath) + 1) * sizeof(wchar_t);
    void *remote = VirtualAllocEx(proc, NULL, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) return;
    if (WriteProcessMemory(proc, remote, dllPath, bytes, NULL)) {
        /* kernel32 is mapped at the same base in every process of this arch in
         * the session, so LoadLibraryW's address here is valid in the child. */
        FARPROC loadLib = GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW");
        HANDLE th = CreateRemoteThread(proc, NULL, 0,
                                       (LPTHREAD_START_ROUTINE)loadLib, remote, 0, NULL);
        if (th) {
            WaitForSingleObject(th, 10000);
            CloseHandle(th);
        }
    }
    VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
}

int main(void) {
    wchar_t dir[MAX_PATH];
    exe_dir(dir, MAX_PATH);

    wchar_t realQemu[MAX_PATH], dllPath[MAX_PATH];
    if (!GetEnvironmentVariableW(L"PEBBLE_FAKETIME_REAL_QEMU", realQemu, MAX_PATH)) {
        _snwprintf(realQemu, MAX_PATH, L"%sqemu-pebble.exe", dir);
    }
    if (!GetEnvironmentVariableW(L"PEBBLE_FAKETIME_DLL", dllPath, MAX_PATH)) {
        _snwprintf(dllPath, MAX_PATH, L"%stimeshim-win.dll", dir);
    }

    /* Build the child command line: "<realQemu>" + original args (sans argv0). */
    wchar_t *origArgs = skip_argv0(GetCommandLineW());
    SIZE_T cap = lstrlenW(realQemu) + lstrlenW(origArgs) + 8;
    wchar_t *cmd = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, cap * sizeof(wchar_t));
    _snwprintf(cmd, cap, L"\"%s\" %s", realQemu, origArgs);

    STARTUPINFOW si = { sizeof(si) };
    PROCESS_INFORMATION pi = {0};
    if (!CreateProcessW(realQemu, cmd, NULL, NULL, TRUE,
                        CREATE_SUSPENDED, NULL, NULL, &si, &pi)) {
        fwprintf(stderr, L"launcher: CreateProcess failed (%lu): %s\n",
                 GetLastError(), realQemu);
        return 1;
    }

    inject(pi.hProcess, dllPath);
    ResumeThread(pi.hThread);

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return (int)code;
}
