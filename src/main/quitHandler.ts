/**
 * before-quit handler factory (DOM/electron-free so it is unit-testable).
 *
 * Electron fires `before-quit` synchronously and quits as soon as the handler
 * returns — there is no async await point. So the FIRST quit is deferred with
 * preventDefault(), the async `shutdown()` runs (reap qemu/python + log stream),
 * and only then do we actually exit. A `cleaning` guard makes shutdown run
 * exactly once; while cleaning we KEEP deferring (preventDefault) every further
 * quit attempt so a second X-click / "End task" mid-teardown can't quit early
 * and orphan the children. Only the deliberate exit() path (guarded by
 * `exiting`) is allowed through, so it is never blocked.
 *
 * TERMINATION PATHS: the X button, app.quit(), and Task Manager "End task" all
 * send WM_CLOSE → before-quit fires here. "End task" hard-kills after a short
 * grace window, so we BOUND the wait: exit after shutdown() resolves OR
 * `timeoutMs`, whichever is first (the quit-path shutdown force-kills FIRST —
 * driver.stopFast's direct sweep, no liveness probe or graceful `pebble kill`
 * ahead of it — so the children are reaped even if we exit on timeout).
 * "End process"/TerminateProcess cannot be intercepted — its aftermath is handled
 * by the startup reap in backend:init.
 */
export function createQuitHandler(
  shutdown: () => Promise<void>,
  exit: () => void,
  timeoutMs = 3000,
): (e: { preventDefault(): void }) => void {
  let cleaning = false;
  let exiting = false;
  return (e: { preventDefault(): void }): void => {
    if (exiting) return; // the deliberate exit() is underway — let the quit proceed
    if (cleaning) {
      e.preventDefault(); // still tearing down — keep deferring so children aren't orphaned
      return;
    }
    cleaning = true;
    e.preventDefault();
    const exitOnce = (): void => { if (!exiting) { exiting = true; exit(); } };
    const timer = setTimeout(exitOnce, timeoutMs);
    void shutdown()
      .catch(() => { /* never block exit on a teardown error */ })
      .then(() => { clearTimeout(timer); exitOnce(); });
  };
}
