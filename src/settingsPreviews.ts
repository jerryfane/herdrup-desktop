import { Desk } from "./mygo";

export class PreviewSettings {
  readonly root = document.createElement("label");
  private input = document.createElement("input");
  private subtitle = document.createElement("span");
  private status = document.createElement("span");
  private saved: boolean | undefined;
  private pending: boolean | undefined;
  private running = false;
  private revision = 0;

  constructor(icon: HTMLElement) {
    this.root.className = "settings-row";
    const lines = document.createElement("span"), title = document.createElement("span");
    lines.className = "settings-row-lines";
    title.className = "settings-row-label"; title.textContent = "Run JavaScript in previews";
    this.subtitle.className = "settings-row-subtitle";
    lines.append(title, this.subtitle);
    this.input.type = "checkbox"; this.input.className = "settings-switch";
    this.input.setAttribute("role", "switch"); this.input.setAttribute("aria-label", title.textContent);
    this.status.className = "settings-row-subtitle settings-preference-status";
    this.status.setAttribute("role", "status"); this.status.hidden = true;
    this.input.onchange = () => {
      this.status.hidden = true; this.revision++; this.pending = this.input.checked; this.render();
      if (!this.running) void this.save();
    };
    lines.append(this.status);
    this.root.append(icon, lines, this.input); this.render();
  }
  async refresh() {
    if (this.running) return;
    const revision = ++this.revision;
    try {
      const saved = await Desk.getPreviewJavaScript();
      if (revision === this.revision) { this.status.hidden = true; this.saved = saved; this.render(); }
    } catch (error) { if (revision === this.revision) this.report(error); }
  }
  private report(error: unknown) {
    this.status.textContent = String(error); this.status.hidden = false;
  }
  private render() {
    const enabled = this.pending ?? this.saved ?? false;
    this.input.checked = enabled; this.input.disabled = this.saved === undefined;
    this.subtitle.textContent = enabled
      ? "Scripts run in new previews. Remote loads and navigation stay blocked, but a crafted file could still signal that you opened it."
      : "HTML and SVG previews ignore scripts. Inline images and styles still display. Changes apply to the next preview.";
  }
  private async save() {
    this.running = true;
    try {
      while (this.pending !== undefined) {
        const value = this.pending;
        await Desk.setPreviewJavaScript(value);
        this.saved = value;
        if (this.pending === value) this.pending = undefined;
      }
    } catch (error) { this.pending = undefined; this.report(error); }
    finally { this.running = false; this.render(); }
  }
}
