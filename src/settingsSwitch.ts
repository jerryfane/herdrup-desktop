import { errorText } from "./errors";

export interface SavedSwitchOptions {
  title: string;
  subtitle: (on: boolean) => string;
  /** Shown, disabled, until the saved value arrives. */
  fallback: boolean;
  load: () => Promise<boolean>;
  save: (on: boolean) => Promise<void>;
}

/** A Settings row whose switch is a preference Go keeps (desk_previews.go, usage_ping.go).
 *  Flips made while one is saving are saved after it, the last one winning. */
export class SavedSwitch {
  readonly root = document.createElement("label");
  private input = document.createElement("input");
  private subtitle = document.createElement("span");
  private status = document.createElement("span");
  private saved: boolean | undefined;
  private pending: boolean | undefined;
  private running = false;
  private revision = 0;

  constructor(icon: HTMLElement, private options: SavedSwitchOptions) {
    this.root.className = "settings-row";
    const lines = document.createElement("span"), title = document.createElement("span");
    lines.className = "settings-row-lines";
    title.className = "settings-row-label"; title.textContent = options.title;
    this.subtitle.className = "settings-row-subtitle";
    lines.append(title, this.subtitle);
    this.input.type = "checkbox"; this.input.className = "settings-switch";
    this.input.setAttribute("role", "switch"); this.input.setAttribute("aria-label", options.title);
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
      const saved = await this.options.load();
      if (revision === this.revision) { this.status.hidden = true; this.saved = saved; this.render(); }
    } catch (error) { if (revision === this.revision) this.report(error); }
  }
  private report(error: unknown) {
    this.status.textContent = errorText(error); this.status.hidden = false;
  }
  private render() {
    const enabled = this.pending ?? this.saved ?? this.options.fallback;
    this.input.checked = enabled; this.input.disabled = this.saved === undefined;
    this.subtitle.textContent = this.options.subtitle(enabled);
  }
  private async save() {
    this.running = true;
    try {
      while (this.pending !== undefined) {
        const value = this.pending;
        await this.options.save(value);
        this.saved = value;
        if (this.pending === value) this.pending = undefined;
      }
    } catch (error) { this.pending = undefined; this.report(error); }
    finally { this.running = false; this.render(); }
  }
}
