/**
 * before-quit handler factory (DOM/electron-free so it is unit-testable).
 *
 * Electron fires `before-quit` synchronously and quits as soon as the handler
 * returns — there is no async await point. So the FIRST quit is deferred with
 * preventDefault(), the async `shutdown()` runs (reap qemu/python + log stream),
 * and only then do we actually exit. A `cleaning` guard makes repeated quit
 * attempts (and the exit-triggered re-fire) no-ops so shutdown runs exactly once.
 *
 * TERMINATION PATHS: the X button, app.quit(), and Task Manager "End task" all
 * send WM_CLOSE → before-quit fires here. "End task" hard-kills after a short
 * grace window, so we BOUND the wait: exit after shutdown() resolves OR
 * `timeoutMs`, whichever is first (the taskkill /F calls inside shutdown are
 * dispatched up front, so the children are reaped even if we exit on timeout).
 * "End process"/TerminateProcess cannot be intercepted — its aftermath is handled
 * by the startup reap in backend:init.
 */
export function createQuitHandler(
  shutdown: () => Promise<void>,
  exit: () => void,
  timeoutMs = 3000,
): (e: { preventDefault(): void }) => void {
  let cleaning = false;
  return (e: { preventDefault(): void }): void => {
    if (cleaning) return; // already tearing down (or the exit() re-fire) — let it proceed
    cleaning = true;
    e.preventDefault();
    let exited = false;
    const exitOnce = (): void => { if (!exited) { exited = true; exit(); } };
    const timer = setTimeout(exitOnce, timeoutMs);
    void shutdown()
      .catch(() => { /* never block exit on a teardown error */ })
      .then(() => { clearTimeout(timer); exitOnce(); });
  };
}
