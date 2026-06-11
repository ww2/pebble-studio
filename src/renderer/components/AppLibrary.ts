/** Extract the filename from an absolute path (works on both / and \ separators). */
function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * AppLibrary panel: drag-drop zone for .pbw files + persistent list of
 * installed apps with remove buttons.
 */
export class AppLibrary {
  readonly el: HTMLElement;
  private readonly dropZone: HTMLElement;
  private readonly list: HTMLUListElement;
  private readonly errorMsg: HTMLElement;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "lib-panel";

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

  async refresh(): Promise<void> {
    const entries = await window.studio.libList();
    this.list.replaceChildren();
    for (const p of entries) {
      const li = document.createElement("li");
      li.className = "lib-item";
      const name = document.createTextNode(basename(p));
      const removeBtn = document.createElement("button");
      removeBtn.className = "lib-remove";
      removeBtn.type = "button";
      removeBtn.textContent = "×";
      removeBtn.title = `Remove ${basename(p)}`;
      removeBtn.addEventListener("click", () => {
        void window.studio.libRemove(p).then(() => this.refresh());
      });
      li.appendChild(name);
      li.appendChild(removeBtn);
      this.list.appendChild(li);
    }
  }
}
