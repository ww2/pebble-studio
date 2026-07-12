# Release Integration Guide

How to pull in a new upstream release of Pebble Studio and re-apply the
macOS-support changes on top of it, release after release.

This repo is a fork of `therealjasonlin/pebble-studio`. Upstream ships new
releases fairly often; this document is the repeatable procedure for absorbing
each one without losing (or silently breaking) the macOS work.

---

## 1. Repository topology

### Remotes

| Remote     | URL                                          | Role                                        |
|------------|----------------------------------------------|---------------------------------------------|
| `upstream` | `github.com/therealjasonlin/pebble-studio`   | The real source. **Fetch** releases from here. |
| `origin`   | `github.com/ww2/pebble-studio` (your fork)   | **Push** branches here; open PRs from here. |

`upstream`'s push URL should be disabled so a stray push can't target the source:

```bash
git remote set-url --push upstream DISABLE
```

### Branch roles

| Branch                | Purpose                                                                 | Must mirror upstream? |
|-----------------------|-------------------------------------------------------------------------|------------------------|
| `main`                | A **pristine mirror** of `upstream/main`. Never commit local work here. | **Yes — keep it 0 commits ahead.** |
| `macos-support-vNNN`  | Per-release integration branch: upstream `vN.N.N` + the macOS patch set (which also carries `CLAUDE.md` and this file — see §4). | No |

> **Invariant:** `main` must stay identical to `upstream/main` so that
> `git merge --ff-only upstream/main` always fast-forwards. Verify any time with:
>
> ```bash
> git rev-list --left-right --count main...upstream/main   # must print "0    0"
> ```
>
> The moment `main` is even one commit ahead, fast-forward integration breaks.
> That is why release notes, this guide, and the macOS patches all live on
> *other* branches.

### The macOS patch set

At the time of writing, the macOS work is these commits on `macos-support-v311`,
sitting on top of upstream `v3.0.11` (`dd64ef5`):

```
501da75 build: compile the macOS time-shim dylib
4c1f40a feat(backend): macOS native driver + DYLD time-shim
609d6a7 feat(backend): macOS pebble-CLI adjustments
523356c fix(backend): darwin-gate the bridge-health probe
ac25ac7 feat(backend): drop setsid + skip keymap preseed on macOS boot
```

Plus a `docs:` commit adding `CLAUDE.md` and this file (see §4). Keep this list
current — it is the whole payload you carry forward to each new release.
Regenerate it any time with:

```bash
git log --oneline upstream/main..macos-support-v311
```

---

## 2. Integrating a new upstream release

Assume upstream has just tagged, say, `v3.0.12`. You'll produce
`macos-support-v312`.

### Step 1 — Fetch upstream

```bash
git fetch upstream --prune
git log --oneline main..upstream/main        # what's new since your last mirror
```

### Step 2 — Fast-forward your pristine mirror

```bash
git checkout main
git merge --ff-only upstream/main
```

If this refuses to fast-forward, `main` has drifted — something got committed to
it by mistake. Do **not** force it. Inspect with
`git log --oneline upstream/main..main`, move those commits to their proper
branch, and reset `main` back onto `upstream/main`.

### Step 3 — (Optional) sync your fork's main

Your fork's `origin/main` tends to lag. Bring it up to date so PRs diff cleanly:

```bash
git push origin main
```

### Step 4 — Cut the new release integration branch

Branch from the current integration branch, then rebase it onto the new upstream
release. `git rebase upstream/main` replays exactly the commits that aren't in
upstream — the macOS patch set plus the `docs:` commit — onto the new tip, and
finds the merge-base automatically:

```bash
git checkout -b macos-support-v312 macos-support-v311
git rebase upstream/main
```

This leaves `macos-support-v311` intact as a record of that release and lands the
patch set on top of `v3.0.12`.

Cherry-pick is an equivalent alternative when you'd rather be explicit about which
commits move (use the patch-set range from the `git log` in §1):

```bash
git checkout -b macos-support-v312 upstream/main
git cherry-pick ac25ac7^..501da75
```

### Step 5 — Resolve conflicts

See §3 for where conflicts are most likely and how to reason about them. After
each conflicted commit:

```bash
git status                 # see conflicted files
# ...edit, then...
git add <files>
git rebase --continue      # or: git cherry-pick --continue
```

### Step 6 — Rebuild all three toolchains

The build spans three toolchains (see `CLAUDE.md` → "Build layout"). A clean
integration must pass all of:

```bash
npm install         # runs scripts/repair-electron.mjs (electron unzip fix)
npm run build       # timeshim-mac dylib + main (esbuild) + renderer (vite)
npm run typecheck   # tsc for main/shared/capture AND the renderer project
npm test            # vitest run (whole suite)
```

### Step 7 — Smoke-test on macOS

Automated tests never touch a real emulator, so a green suite is necessary but
not sufficient. Manually confirm the macOS-specific paths still work:

```bash
npm start
```

Verify, at minimum:
- Emulator boots (native driver selected — see `selectDriverKind`).
- Custom/frozen time works (DYLD time-shim dylib loaded; falls back to host clock
  + offset if Xcode CLT is missing).
- Buttons, battery, and install each still reassert time afterward (the SetUTC
  clobber — see §3).

### Step 8 — Push and (optionally) PR

```bash
git push -u origin macos-support-v312
```

If you're offering the changes upstream, open a PR from
`ww2:macos-support-v312` against `therealjasonlin:main`. Either way, the
`macos-support-vNNN` branch on your fork is the source of truth for your builds.

Upstream `.gitignore`s `CLAUDE.md` and `.claude/`, so the `docs:` commit must
**not** go into an upstream PR — it would add files they deliberately exclude.
Keep that commit topmost and open the PR from the commit just below it (the macOS
code only):

```bash
# publish a PR head that stops before the docs commit, then open the PR from it
git push origin macos-support-v312~1:refs/heads/pr/macos-support-v312
```

Do not "fix" the ignore with a `!CLAUDE.md` negation rule: that edits the
upstream-tracked `.gitignore` and would conflict on every release. The file is
already tracked on your branch, so the ignore rule doesn't affect it there — `-f`
was only needed once, to start tracking it.

---

## 3. Conflict hot-spots (what upstream changes tend to disturb)

The macOS changes are concentrated in a few load-bearing subsystems. When a
release conflicts, it's almost always one of these. Before resolving, read the
upstream diff for the file so you understand *their* intent, then re-apply the
macOS adaptation on top of it — don't just take "ours".

### Backend drivers — `src/main/backend/`
The macOS path is the `native` driver (`NativeDriver.ts`, `createDriver.ts`,
`driverFactory.ts::selectDriverKind`). Upstream frequently reworks the driver
interface (`BackendDriver.ts`) and the Windows/WSL drivers. When the interface
changes, the macOS driver must adopt the new method signatures.

- Check whether new **optional** `BackendDriver` methods appeared
  (`insertSamplePin`, `streamLogs`, `screenshotFramebuffer`, …). Callers must
  tolerate their absence (`?.` / `false`) — don't assume the native driver
  implements them.

### Boot orchestration — `bootEmulator.ts`
The macOS commits drop `setsid`, skip keymap preseed, and darwin-gate the
bridge-health probe. If upstream restructures the boot sequence, re-apply those
platform gates rather than reverting to the shared path.

### Time control — the hardest subsystem
Per-platform mechanisms (`timeController.ts`, `ensureTimeShim()`):
- **macOS**: `DYLD_INSERT_LIBRARIES` dylib, built by `npm run build:timeshim-mac`
  (`macTimeShim.ts`, sources under `vendor/timeshim`).
- Linux/WSL `LD_PRELOAD` and Windows `PEBBLE_FAKETIME_FILE` are the other two.

If upstream touches how the shim is selected or how frozen/rated time is pushed,
make sure the macOS branch of `ensureTimeShim()` still gates correctly and the
dylib still builds. Also re-verify the **SetUTC clobber** handling: every
`pebble` command re-syncs host→watch time on connect, so `ipc.ts` calls
`reassertTime()` after install/button/battery/clay/etc. New handlers upstream may
need the same call added.

### IPC / host branching — `ipc.ts`
Several handlers branch on `driverKind`. macOS uses `native`, so it usually
follows the non-Windows path — but confirm any new handler doesn't accidentally
route macOS through a Windows-only code path (e.g. reading
`%TEMP%\pb-emulator.json` directly).

### Build scripts — `package.json`, `esbuild`, `vite.config.ts`, electron-builder
The macOS build adds `build:timeshim-mac` to the `build` script. If upstream
rewrites the build pipeline, re-insert the dylib compile step and confirm
`repair-electron.mjs` still runs on postinstall.

---

## 4. Where the personal docs live (`CLAUDE.md` and this file)

Neither file exists upstream, and neither may live on `main` (a commit there
breaks the ff-only invariant). `CLAUDE.md` additionally **must** be present in
the working tree while you develop, because Claude Code loads it from the
checked-out tree — an orphan branch would not put it there.

**Recommended: carry both in the macOS patch set.** Add one `docs:` commit
(containing `CLAUDE.md` + `RELEASE_INTEGRATION.md`) on top of the code commits on
`macos-support-vNNN`. Because upstream ships neither file, this commit rebases
forward with zero conflicts, travels with every release branch, keeps both files
versioned on your fork, and leaves `main` pristine. One mechanism carries
everything.

```bash
# first time (both files are currently untracked):
git add CLAUDE.md RELEASE_INTEGRATION.md
git commit -m "docs: project guide + release integration guide"
git push origin macos-support-v311
```

On the next release the docs commit is simply part of the range you replay
(`git log --oneline upstream/main..macos-support-v311`), so it comes along with
the code automatically.

**Alternative — orphan `meta` branch.** Only worthwhile if you specifically want
docs *out* of the build tree. It does **not** satisfy `CLAUDE.md`'s need to be in
the working tree, so it would apply to `RELEASE_INTEGRATION.md` only, and it adds
a second mechanism to remember:

```bash
git checkout --orphan meta
git rm -r --cached . >/dev/null 2>&1 || true
git add RELEASE_INTEGRATION.md
git commit -m "docs: release integration guide"
git push -u origin meta
git checkout macos-support-v311
# retrieve any time, from any branch: git show meta:RELEASE_INTEGRATION.md
```

---

## 5. Quick reference

```bash
# Health checks
git remote -v
git rev-list --left-right --count main...upstream/main     # must be "0    0"
git log --oneline upstream/main..macos-support-vNNN         # current macOS patch set

# Integrate a new release
git fetch upstream --prune
git checkout main && git merge --ff-only upstream/main
git push origin main                                        # optional: refresh fork
git checkout -b macos-support-v<next> macos-support-v<prev>
git rebase upstream/main                                    # or cherry-pick the patch-set range
npm install && npm run build && npm run typecheck && npm test
npm start                                                   # manual macOS smoke test
git push -u origin macos-support-v<next>
```
