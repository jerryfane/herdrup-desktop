import { COLUMN, displayedWidth, draggedWidth, storedWidth, widthReadout } from "./gramModel";

const key = "conversation.columnWidth";

// ConversationColumn.swift: Chat and Gram share the saved width, edge drags,
// Readable/Wide/Full snapping and double-click reset. Resizing never remounts text.
export class ConversationColumn {
  readonly handles: HTMLElement[];
  readonly readout = document.createElement("div");
  private width = 0;
  private timer: number | undefined;
  constructor(private readonly host: HTMLElement, private readonly changed: () => void) {
    this.readout.className = "gcol-readout";
    this.readout.hidden = true;
    this.handles = (["leading", "trailing"] as const).map(edge => {
      const handle = document.createElement("div"); handle.className = `gcol-handle ${edge}`;
      for (const name of ["gcol-line", "gcol-grip"]) { const part = document.createElement("span"); part.className = name; handle.append(part); }
      let start: { x: number; width: number } | null = null;
      handle.onpointerdown = event => {
        if (event.button !== 0) return;
        event.preventDefault();
        start = { x: event.clientX, width: this.width };
        handle.setPointerCapture(event.pointerId);
        handle.classList.add("dragging"); host.classList.add("resizing");
      };
      handle.onpointermove = event => {
        if (!start) return;
        const available = host.clientWidth;
        const width = draggedWidth(start.width, event.clientX - start.x, edge, available);
        localStorage.setItem(key, String(storedWidth(width, available)));
        this.update(); this.showReadout();
      };
      const end = () => {
        if (!start) return;
        start = null; handle.classList.remove("dragging"); host.classList.remove("resizing");
        this.hideReadoutSoon(); changed();
      };
      handle.onpointerup = end; handle.onpointercancel = end;
      handle.ondblclick = () => {
        localStorage.setItem(key, String(COLUMN.wide));
        this.update(); this.showReadout(); this.hideReadoutSoon(); changed();
      };
      return handle;
    });
  }
  update() {
    const saved = localStorage.getItem(key);
    const available = this.host.clientWidth;
    this.width = displayedWidth(saved === null ? COLUMN.wide : Number(saved), available);
    this.host.style.setProperty("--gram-column", `${this.width}px`);
    this.host.style.setProperty("--gram-reach", `${Math.max(0, Math.min(this.width, available - 20) / 2)}px`);
  }
  setVisible(visible: boolean) {
    this.handles.forEach(handle => { handle.hidden = !visible; });
    if (!visible) this.readout.hidden = true;
    else this.update();
  }
  private showReadout() {
    clearTimeout(this.timer);
    this.readout.textContent = widthReadout(this.width, this.host.clientWidth);
    this.readout.hidden = false;
  }
  private hideReadoutSoon() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { this.readout.hidden = true; }, 600);
  }
  dispose() {
    clearTimeout(this.timer); this.handles.forEach(handle => handle.remove()); this.readout.remove();
  }
}
