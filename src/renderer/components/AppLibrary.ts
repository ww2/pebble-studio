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
 */
export class AppLibrary {
  readonly el: HTMLElement;
  private readonly dropZone: HTMLElement;
  private readonly list: HTMLUListElement;
  private readonly errorMsg: HTMLElement;
  private readonly header: HTMLElement;
  private readonly loadedCount: HTMLElement;
  private readonly clearBtn: HTMLButtonElement;

  /** Returns the currently active platform id (injected from main.ts). */
  private readonly getPlatformId: () => string;
  /** Called after a successful clear so the EmulatorView can reconnect VNC. */
  private readonly onClear: ((platformId: string) => Promise<void>) | undefined;

  constructor(getPlatformId: () => string, onClear?: (platformId: string) => Promise<void>) {
    this.getPlatformId = getPlatformId;
    this.onClear = onClear;

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
    this.clearBtn.disabled = true;

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

    this.dropZone.appendChild(dropIcon);
    this.dropZone.appendChild(dropLabel);
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
  }

  private async handleDrop(e: DragEvent): Promise<void> {
    this.errorMsg.textContent = "";
    const files = Array.from(e.dataTransfer?.files ?? []);
    for (const file of files) {
      const filePath = window.studio.pathForFile(file);
      if (!filePath.endsWith(".pbw")) {
        this.errorMsg.textContent = `Not a .pbw file: ${file.name}`;
        continue;
      }
      try {
        await window.studio.libAdd(filePath);
        await window.studio.install(filePath);
      } catch (err) {
        console.error("[lib] install failed", filePath, err);
        this.errorMsg.textContent = `Install failed: ${file.name}`;
      }
    }
    await this.refresh();
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

  async refresh(): Promise<void> {
    const [entries, loadedPaths] = await Promise.all([
      window.studio.libList(),
      window.studio.loadedList(),
    ]);
    const loadedSet = new Set(loadedPaths);

    // Update header
    const count = loadedSet.size;
    this.loadedCount.textContent = count > 0 ? `${count} loaded` : "";
    this.clearBtn.disabled = count === 0;

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
