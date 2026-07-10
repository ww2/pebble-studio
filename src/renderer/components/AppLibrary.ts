import {
  fetchConfigUrlResilient,
  sendConfigResult,
  NoConfigPageError,
  BridgeUnreachableError,
} from "../clayClient.js";

/** Extract the filename from an absolute path (works on both / and \ separators). */
function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * AppLibrary panel: drag-drop zone for .pbw files + persistent list of
 * installed apps with remove buttons.
 *
 * E1: Each item that is currently loaded on the running emulator is marked
 *     with a "loaded" pill using the --success color token.
 * E2: A "Clear emulator" button wipes all apps from the running emulator
 *     (calls loaded:clear), then refreshes. The persisted library is NOT
 *     affected. The button is disabled while no apps are loaded.
 *
 * B3: A per-row gear opens the app's Clay config page (phonesim AppConfig
 *     round-trip) — enabled only while the emulator is live and no other
 *     config round-trip is in flight.
 */
export class AppLibrary {
  readonly el: HTMLElement;
  private readonly dropZone: HTMLElement;
  private readonly pickBtn: HTMLButtonElement;
  private readonly list: HTMLUListElement;
  private readonly errorMsg: HTMLElement;
  private readonly header: HTMLElement;
  private readonly loadedCount: HTMLElement;
  private readonly clearBtn: HTMLButtonElement;

  /** Returns the currently active platform id (injected from main.ts). */
  private readonly getPlatformId: () => string;
  /** Called after a successful clear so the EmulatorView can reconnect VNC. */
  private readonly onClear: ((platformId: string) => Promise<void>) | undefined;
  /** Is the emulator currently live? Injected from main.ts (EmulatorView state).
   * When not live we queue installs (libAdd only) instead of running `pebble
   * install` against a dead emulator — that would error or boot a stray non-VNC
   * qemu. Queued apps install on the next Launch via libInstallAll. */
  private readonly isLive: (() => boolean) | undefined;
  /** True while a Clay config round-trip is running — all gears disabled
   * (prevents a second Setup overwriting pypkjs' pending config_callback). */
  private clayInFlight = false;
  /** Monotonic token for refresh(): concurrent refreshes (the apps-changed event
   * fires on boot/relaunch/force-close/clear, plus direct drop/pick calls) race,
   * and whichever IPC pair resolves last would paint — letting pre-clear "loaded"
   * pills reappear after a clear. Only the newest refresh paints. */
  private refreshSeq = 0;

  constructor(
    getPlatformId: () => string,
    onClear?: (platformId: string) => Promise<void>,
    isLive?: () => boolean,
  ) {
    this.getPlatformId = getPlatformId;
    this.onClear = onClear;
    this.isLive = isLive;

    this.el = document.createElement("div");
    this.el.className = "lib-panel";

    // Header row: loaded count + Clear button
    this.header = document.createElement("div");
    this.header.className = "lib-header";

    this.loadedCount = document.createElement("span");
    this.loadedCount.className = "lib-loaded-count";
    this.loadedCount.textContent = "";

    this.clearBtn = document.createElement("button");
    this.clearBtn.className = "lib-clear-btn";
    this.clearBtn.type = "button";
    this.clearBtn.textContent = "Clear emulator";
    this.clearBtn.title = "Wipe all user apps from the running emulator (library is preserved)";
    this.clearBtn.disabled = false; // available at all times; handleClear guards double-clicks

    this.clearBtn.addEventListener("click", () => void this.handleClear());

    this.header.appendChild(this.loadedCount);
    this.header.appendChild(this.clearBtn);

    this.dropZone = document.createElement("div");
    this.dropZone.className = "lib-drop-zone";

    const dropIcon = document.createElement("span");
    dropIcon.className = "lib-drop-icon";
    dropIcon.textContent = "↓";
    dropIcon.setAttribute("aria-hidden", "true");

    const dropLabel = document.createElement("span");
    dropLabel.className = "lib-drop-label";
    dropLabel.textContent = "Drop .pbw files here to install";

    this.errorMsg = document.createElement("span");
    this.errorMsg.className = "lib-error";

    // "Select file" button — opens a native picker as an alternative to drag-drop.
    this.pickBtn = document.createElement("button");
    this.pickBtn.className = "lib-pick-btn";
    this.pickBtn.type = "button";
    this.pickBtn.textContent = "Select file…";
    this.pickBtn.title = "Choose one or more .pbw files to install";
    this.pickBtn.addEventListener("click", () => void this.handlePick());

    this.dropZone.appendChild(dropIcon);
    this.dropZone.appendChild(dropLabel);
    this.dropZone.appendChild(this.pickBtn);
    this.dropZone.appendChild(this.errorMsg);

    this.list = document.createElement("ul");
    this.list.className = "lib-list";

    this.el.appendChild(this.header);
    this.el.appendChild(this.dropZone);
    this.el.appendChild(this.list);

    this.dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      this.dropZone.classList.add("over");
    });

    this.dropZone.addEventListener("dragleave", () => {
      this.dropZone.classList.remove("over");
    });

    this.dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      this.dropZone.classList.remove("over");
      void this.handleDrop(e);
    });

    // Refresh when the emulator's loaded-app set changes outside this panel —
    // e.g. after a boot/relaunch reinstalls the library (libInstallAll) or a
    // Clear wipes it. EmulatorView dispatches this once those complete, keeping
    // the "N loaded" count + pills in sync rather than only after a drop/pick.
    window.addEventListener("pebble-studio:apps-changed", () => void this.refresh());
  }

  private async handleDrop(e: DragEvent): Promise<void> {
    this.errorMsg.textContent = "";
    const files = Array.from(e.dataTransfer?.files ?? []);
    for (const file of files) {
      await this.installPath(window.studio.pathForFile(file));
    }
    await this.refresh();
  }

  /** Open the native file picker and install whatever the user selects. */
  /** Public entry point for the File → Install PBW… menu item. */
  async pickAndInstall(): Promise<void> { await this.handlePick(); }

  /** Public entry point for the File → Clear Emulator menu item. */
  async clearEmulator(): Promise<void> { await this.handleClear(); }

  private async handlePick(): Promise<void> {
    this.errorMsg.textContent = "";
    const paths = await window.studio.pickPbw();
    if (paths.length === 0) return; // cancelled — no-op, no error shown
    for (const filePath of paths) {
      await this.installPath(filePath);
    }
    await this.refresh();
  }

  /**
   * Shared install routine for both drag-drop and the file picker (DRY).
   * Validates the extension, then runs the libAdd + install pair. On failure
   * surfaces the real reason (first line of the driver's error message), which
   * already includes the underlying stderr.
   */
  private async installPath(filePath: string): Promise<void> {
    const name = basename(filePath);
    // Reset the benign "info" styling up front so a rejection (or install error)
    // never renders in the leftover info color from a prior "Added X…" message.
    this.errorMsg.classList.remove("lib-error--info");
    if (!filePath.endsWith(".pbw")) {
      this.errorMsg.textContent = `Not a .pbw file: ${name}`;
      return;
    }
    try {
      await window.studio.libAdd(filePath);
      // No running emulator → just add to the library; it installs on the next
      // Launch (libInstallAll). Installing against a dead emulator errors or
      // spawns a stray non-VNC qemu. Same code path for drag-drop AND file-pick.
      if (this.isLive && !this.isLive()) {
        this.errorMsg.classList.add("lib-error--info");
        this.errorMsg.textContent = `Added ${name} — it will install when the watch launches`;
        return;
      }
      this.errorMsg.classList.remove("lib-error--info");
      await window.studio.install(filePath);
    } catch (err) {
      console.error("[lib] install failed", filePath, err);
      this.errorMsg.classList.remove("lib-error--info");
      const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0].trim();
      this.errorMsg.textContent = reason
        ? `Install failed: ${name} — ${reason}`
        : `Install failed: ${name}`;
    }
  }

  private async handleClear(): Promise<void> {
    this.clearBtn.disabled = true;
    this.errorMsg.textContent = "";
    const platformId = this.getPlatformId();
    try {
      await window.studio.loadedClear(platformId);
      // Notify EmulatorView to reconnect VNC (main process already rebooted the emu).
      if (this.onClear) await this.onClear(platformId);
    } catch (err) {
      console.error("[lib] clear failed", err);
      this.errorMsg.textContent = "Clear failed — see console";
    }
    await this.refresh();
  }

  /** Same liveness signal the install path uses (absent injection = live,
   * mirroring installPath's `this.isLive && !this.isLive()` queue check). */
  private live(): boolean {
    return this.isLive ? this.isLive() : true;
  }

  /** Re-apply the disabled state to every gear without a full refresh —
   * used to lock the gears while a config round-trip is in flight. */
  private updateGearButtons(): void {
    const disabled = this.clayInFlight || !this.live();
    for (const btn of this.list.querySelectorAll<HTMLButtonElement>(".lib-gear")) {
      btn.disabled = disabled;
    }
    // Clear stays available at all times (see refresh()); never gate it on liveness.
  }

  /**
   * Clay config round-trip: ask pypkjs for the foreground app's config URL,
   * open it in a window (main process), send the result back. A cancelled
   * window resolves with "" and still sends the cancel frame — not an error.
   */
  private async handleClayConfig(pbwPath: string): Promise<void> {
    if (this.clayInFlight) return; // double-click guard
    this.clayInFlight = true;
    this.updateGearButtons();
    this.errorMsg.classList.remove("lib-error--info");
    this.errorMsg.textContent = "";
    try {
      const port = await window.studio.clayPhonesimPort();
      if (port == null) throw new Error("emulator not running");
      // Resilient against the first-boot bridge-readiness race: a fresh boot can
      // report "Live" before pypkjs/the app's JS is ready to answer Setup, which
      // otherwise surfaced a misleading "No config page". Retries a few times.
      const url = await fetchConfigUrlResilient(port);
      // RAW still-percent-encoded fragment ("" = cancelled) — passed back
      // undecoded; the app's JS decodes it itself.
      const rawFragment = await window.studio.clayOpenWindow(url);
      await sendConfigResult(port, rawFragment);
    } catch (err) {
      console.error("[lib] clay config failed", pbwPath, err);
      this.errorMsg.classList.remove("lib-error--info");
      if (err instanceof BridgeUnreachableError) {
        this.errorMsg.textContent = "Couldn't reach the watch — try Relaunch.";
      } else if (err instanceof NoConfigPageError) {
        this.errorMsg.textContent =
          "No config page (app may not support Clay — make sure it's running)";
      } else {
        const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0].trim();
        this.errorMsg.textContent = reason || "App config failed";
      }
    } finally {
      this.clayInFlight = false;
      this.updateGearButtons();
    }
  }

  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    const [entries, loadedPaths] = await Promise.all([
      window.studio.libList(),
      window.studio.loadedList(),
    ]);
    // A newer refresh started while our IPC was in flight — let it own the paint
    // so a stale (pre-clear) snapshot can't clobber the current one.
    if (seq !== this.refreshSeq) return;
    const loadedSet = new Set(loadedPaths);

    // Update header. Count ONLY apps that are both in the library AND loaded, so
    // the "N loaded" badge can never claim more than the visible list shows
    // (the count used to track a main-process set that outlived removals).
    const count = entries.filter((p) => loadedSet.has(p)).length;
    this.loadedCount.textContent = count > 0 ? `${count} loaded` : "";
    // Clear wipes the whole running emulator (not just tracked apps). Keep it
    // available at ALL times — even when Studio's loaded view looks empty but stale
    // apps remain, or liveness tracking is momentarily out of sync. (The "N loaded"
    // badge above still reflects library∩loaded.) handleClear disables it only for
    // the duration of the wipe to guard against a double-click.
    this.clearBtn.disabled = false;

    this.list.replaceChildren();
    for (const p of entries) {
      const li = document.createElement("li");
      li.className = "lib-item";

      const name = document.createTextNode(basename(p));

      if (loadedSet.has(p)) {
        const pill = document.createElement("span");
        pill.className = "lib-loaded-pill";
        pill.textContent = "● loaded";
        pill.title = "Currently installed on the running emulator";
        li.appendChild(name);
        li.appendChild(pill);
      } else {
        li.appendChild(name);
      }

      // Per-app config (Clay). The bridge configures whichever app is in the
      // foreground on the watch, so the gear only makes sense while live.
      const gearBtn = document.createElement("button");
      gearBtn.className = "lib-gear";
      gearBtn.type = "button";
      gearBtn.textContent = "⚙";
      gearBtn.title = "App settings (Clay) — the app must be running on the watch";
      gearBtn.disabled = this.clayInFlight || !this.live();
      gearBtn.addEventListener("click", () => void this.handleClayConfig(p));
      li.appendChild(gearBtn);

      const removeBtn = document.createElement("button");
      removeBtn.className = "lib-remove";
      removeBtn.type = "button";
      removeBtn.textContent = "×";
      removeBtn.title = `Remove ${basename(p)}`;
      removeBtn.addEventListener("click", () => {
        void window.studio.libRemove(p).then(() => this.refresh());
      });
      li.appendChild(removeBtn);
      this.list.appendChild(li);
    }
  }
}
