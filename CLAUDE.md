# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Pebble Studio is an Electron desktop GUI that boots the `qemu-pebble` smartwatch
emulator, drives it (buttons, time, battery, capture), and embeds its VNC display
in-window.

This project is a fork of the active project which defines Pebble Studio
(`therealjasonlin/pebble-studio`, tracked as the `upstream` remote). Upstream
ships new releases fairly often, and I re-apply my changes on top of each one.

The only changes carried locally are the **macOS support** commits.

Branch model:
* `main` — a pristine mirror of `upstream/main`; kept 0 commits ahead so
  `git merge --ff-only upstream/main` always fast-forwards. Never commit here.
* `macos-support-vNNN` — the per-release integration branch: upstream `vN.N.N`
  plus the macOS patch set, plus one `docs:` commit that carries `CLAUDE.md` and
  `RELEASE_INTEGRATION.md` forward across releases.

The full procedure for absorbing a new upstream release lives in
`RELEASE_INTEGRATION.md`.


## Commands

```bash
npm install         # postinstall runs scripts/repair-electron.mjs
npm run build       # timeshim-mac (dylib) + main (esbuild→CJS) + renderer (vite)
npm start           # electron . (expects a prior build; loads dist/)
npm run dev         # vite dev server for the renderer only
npm test            # vitest run (whole suite)
npm run typecheck   # tsc for main+shared+capture AND the renderer project
npm run dist        # packaged Windows build (electron-builder --win)
```

Run a single test file / pattern:
```bash
npx vitest run tests/backend/timeController.test.ts
npx vitest run -t "reasserts after reboot"
npx vitest              # watch mode
```

There is no ESLint/Prettier config — match existing style (2-space indent,
`.js` extensions on relative TS imports as required by `nodenext`).

## Build layout (why three toolchains)

- **Main process** → esbuild bundles `src/main/index.ts` and `preload.cts` to
  CommonJS (`dist/main/*.cjs`). `package.json.main` points at `dist/main/index.cjs`.
- **Renderer** → Vite (`src/renderer`, root) → `dist/renderer`. Prod build injects
  a strict CSP meta tag (see `vite.config.ts`); dev skips it for HMR.
- **Type-checking** uses two tsconfigs: `tsconfig.json` (main/shared/capture, ESM
  nodenext) and `tsconfig.renderer.json`. The runtime CJS bundle re-declares
  ambient `__dirname` because the source typechecks as ESM.

## Architecture

### Three-layer process model
1. `src/main` — Electron main. Owns the emulator lifecycle, all filesystem/spawn
   access, and every `ipcMain.handle`. Entry: `index.ts` (window, single-instance
   lock, menu, quit handler) → `ipc.ts` (all IPC handlers, the real orchestration).
2. `preload.cts` — the *only* renderer↔main bridge. Exposes a frozen `studio`
   object on `window` (`contextIsolation: true`, `nodeIntegration: false`).
   `StudioApi = typeof studio` is the contract; the renderer re-declares it.
3. `src/renderer` — plain TypeScript + DOM (no framework). `main.ts` wires
   `components/*` (EmulatorView, VersionSwitcher, AppLibrary, CaptureBar, NavRail,
   SettingsPane). The watch display is noVNC over `ws://localhost:6080`.

`src/shared` holds types crossing the boundary (`types.ts`, `simEnv.ts`,
`clayProtocol.ts`, `changelog.ts`). `src/capture` is renderer-side PNG/GIF encoding.

### Backend drivers (the core abstraction)
`src/main/backend/BackendDriver.ts` is the interface every backend implements.
`createDriver.ts` probes the host and `driverFactory.ts::selectDriverKind` picks one:
- **`native`** — Linux/macOS dev with `pebble`+`qemu-pebble` on PATH or in the SDK
  toolchain dir (`NativeDriver.ts`). macOS is here.
- **`windows-native`** — Windows with the bundled self-contained stack
  (`WindowsNativeDriver.ts`); the shipping target. Uses a persistent input helper
  (`winInputChannel.ts`) instead of per-press `pebble` spawns.
- **`wsl`** — Windows fallback driving WSL2 via `wsl.exe` (`WslDriver.ts`).

`bootEmulator.ts` orchestrates the real boot via `pebble emu-control --vnc`, which
owns qemu + pypkjs + websockify and records pids/ports in a state file
(`pb-emulator.json`). Discrete commands (`install`, `emu-button`) reuse that
running stack by pid. A `BootToken.cancelled` flag lets abort/stop bail wait loops.

### Two host gotchas that recur throughout the code
1. **On a Windows host, `bash` is the WSL launcher.** So the `windows-native`
   driver must NEVER read the emulator state file / `/proc` through a shell — it
   reads `%TEMP%\pb-emulator.json` directly via Node `fs`. Several handlers in
   `ipc.ts` branch on `driverKind === "windows-native"` for exactly this reason.
2. **Every `pebble` command re-syncs host time to the watch on connect**
   (pebble-tool `post_connect` → `SetUTC`). This clobbers custom/timezone offsets,
   so `ipc.ts` calls `reassertTime()` after install/button/battery/clay/etc.

### Time control (the hardest subsystem)
Custom date / freeze / rate can't be done by offset alone — it needs to fake
qemu's wall clock. Each platform does this differently:
- **Linux/WSL**: `LD_PRELOAD` shim (`vendor/timeshim`, `timeShim.ts`).
- **macOS**: `DYLD_INSERT_LIBRARIES` dylib built during `npm run build:timeshim-mac`
  (`macTimeShim.ts`); needs Xcode CLT or it falls back to host clock + offset.
- **Windows**: baked into the bundled `qemu-pebble.exe`, which reads
  `PEBBLE_FAKETIME_FILE` (`winTimeShim.ts`). A companion `sitecustomize.py` in the
  bundled Python fakes `time.time()` so `post_connect` doesn't re-clobber a frozen
  clock (see the long comment in `createDriver.ts`).
`timeController.ts` decides what (if anything) to push; `ensureTimeShim()` gates
which mechanism is live and is called before each boot.

### Runtime bundles
Large components live in `vendor/` during dev and under `process.resourcesPath`
when packaged (`winRuntime.ts`, `hostPaths.ts` resolve both). `electron-builder.yml`
`extraResources` maps them; the `vendor/qemu-pebble-win`, `pebble-sdk` dirs are
release assets, not in git.

## Conventions

- Pure helpers are factored out and unit-tested in isolation (e.g.
  `resolveCapturePath`, `nextIndexedName` in `ipc.ts`; `selectDriverKind`). When
  adding logic to a handler, prefer extracting a pure function + a test over
  testing through Electron.
- Tests mirror source paths under `tests/` and never touch a real emulator —
  drivers/shells/spawns are injected as deps and mocked.
- Comments here are unusually load-bearing: they record *why* a workaround exists
  (bridge slot limits, WSL shell aliasing, SetUTC clobber). Preserve that context
  when editing; don't strip a comment that explains a non-obvious guard.
- The optional `BackendDriver` methods (`insertSamplePin`, `streamLogs`,
  `screenshotFramebuffer`) are implemented mainly by `windows-native`; callers must
  handle their absence (`?.` / `false` returns), not assume them.

## Git restriction

Do NOT run git commands that change repository state (add/commit/push/merge/rebase/
reset/checkout-to-modify/restore/stash). Read-only git (status/log/diff/branch) is fine.
