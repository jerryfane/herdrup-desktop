import type { Terminal, IDisposable } from "@xterm/xterm";
import { PredictionEngine, type PredictionScreen } from "./predictiveEcho";
import { predictionMode, onPredictionModeChanged } from "./typingPreference";
import { typingLatency } from "./typingLatency";

// Separate canvas: a prediction is never fed back to xterm's authoritative buffer.
export class TerminalPrediction {
  private engine = new PredictionEngine(predictionMode());
  private canvas = document.createElement("canvas");
  private surface: HTMLElement;
  private listeners: IDisposable[];
  private removePreference: () => void;
  private timer = 0;
  private batch = 0;
  private keys = new Map<number, number>();
  private pending = new Set<number>();
  private alternate: string;
  private outputPending = false;
  private confirmed = 0;
  private wrong = 0;
  private encoder = new TextEncoder();
  private disposed = false;
  private visibilityChanged = () => { if (document.hidden) this.reset(); };

  constructor(private term: Terminal, private host: string) {
    const surface = term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!surface) throw new Error("Terminal screen is unavailable");
    this.surface = surface;
    this.alternate = term.buffer.active.type;
    this.canvas.className = "terminal-prediction";
    this.canvas.style.cssText = "pointer-events:none;position:absolute;left:0;top:0;z-index:5";
    this.canvas.setAttribute("aria-hidden", "true"); this.canvas.hidden = true; surface.append(this.canvas);
    this.removePreference = onPredictionModeChanged(() => { this.engine.setMode(predictionMode()); this.sync(); });
    document.addEventListener("visibilitychange", this.visibilityChanged);
    this.listeners = [term.onResize(() => this.reset()), term.onScroll(() => { this.screen(); }),
      term.buffer.onBufferChange(() => this.reset()), term.onRender(() => {
        if (term.modes.synchronizedOutputMode) return;
        if (this.outputPending) { this.outputPending = false; typingLatency.rendered(this.pending); this.pruneKeys(); }
        this.draw();
      })];
  }
  userBytes(text: string): number {
    const batch = ++this.batch, id = typingLatency.pressed(this.host);
    this.keys.set(batch, id); this.pending.add(id);
    const screen = this.screen();
    if (screen && !this.term.modes.synchronizedOutputMode) this.engine.userBytes(this.encoder.encode(text), screen, batch);
    else this.reset();
    this.pruneKeys(); this.sync(); return batch;
  }
  sent(batch: number) { const id = this.keys.get(batch); if (id !== undefined) typingLatency.sent(id); }
  acked(batch: number, failed = false) {
    if (this.disposed) return;
    const id = this.keys.get(batch); if (id !== undefined) typingLatency.acked(id, failed);
    if (failed) { typingLatency.abandon(this.pending); this.pending.clear(); this.keys.clear(); }
    this.engine.batchAcked(batch, failed, this.screen()); this.pruneKeys(); this.sync();
  }
  outputReceived() { typingLatency.output(this.pending); }
  outputParsed() {
    if (this.disposed || this.term.modes.synchronizedOutputMode) return;
    const screen = this.screen();
    if (screen) this.engine.outputArrived(screen);
    this.outputPending = true; this.sync();
  }
  reset() {
    this.engine.reset(); clearTimeout(this.timer); this.timer = 0;
    this.canvas.hidden = true; this.outputPending = false;
  }
  dispose() {
    this.disposed = true; this.reset(); typingLatency.abandon(this.pending);
    this.keys.clear(); this.pending.clear(); this.removePreference();
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    for (const listener of this.listeners) listener.dispose(); this.canvas.remove();
  }
  private screen(): PredictionScreen | undefined {
    const buffer = this.term.buffer.active;
    if (buffer.type !== this.alternate) { this.reset(); this.alternate = buffer.type; }
    if (document.hidden || this.surface.closest("[inert]") || buffer.viewportY !== buffer.baseY || !this.surface.getClientRects().length) { this.reset(); return; }
    return { columns: this.term.cols, rows: this.term.rows, cursor: { col: buffer.cursorX, row: buffer.cursorY },
      text: (col, row) => buffer.getLine(buffer.baseY + row)?.getCell(col)?.getChars() || " " };
  }
  private pruneKeys() {
    for (const [batch, id] of this.keys) if (!typingLatency.has(id)) { this.keys.delete(batch); this.pending.delete(id); }
  }
  private sync() {
    typingLatency.verdict(this.host, this.engine.confirmed - this.confirmed, this.engine.wrong - this.wrong);
    this.confirmed = this.engine.confirmed; this.wrong = this.engine.wrong;
    this.draw();
    if (!this.timer && this.engine.needsTick) this.timer = window.setTimeout(() => {
      this.timer = 0; const screen = this.screen(); if (screen) this.engine.tick(screen); this.sync();
    }, 40);
  }
  private draw() {
    if (this.disposed || !this.screen()) return;
    const overlay = this.engine.overlay;
    if (!overlay.cells.length && !overlay.cursor) { this.canvas.hidden = true; this.engine.takeFirstPaints(); return; }
    const width = this.surface.clientWidth, height = this.surface.clientHeight;
    if (!width || !height) return;
    const scale = window.devicePixelRatio || 1, cw = width / this.term.cols, ch = height / this.term.rows;
    const pixelWidth = Math.round(width * scale), pixelHeight = Math.round(height * scale);
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`;
    const ctx = this.canvas.getContext("2d"); if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.clearRect(0, 0, width, height);
    const theme = this.term.options.theme, fg = theme?.foreground || "#ffffff", bg = theme?.background || "#000000";
    ctx.font = `${this.term.options.fontWeight || "normal"} ${this.term.options.fontSize}px ${this.term.options.fontFamily}`;
    ctx.textBaseline = "middle";
    const glyph = (col: number, row: number, text: string, foreground = fg, background = bg) => {
      ctx.fillStyle = background; ctx.fillRect(col * cw, row * ch, cw, ch);
      ctx.save(); ctx.beginPath(); ctx.rect(col * cw, row * ch, cw, ch); ctx.clip();
      ctx.fillStyle = foreground; ctx.fillText(text, col * cw, (row + .5) * ch); ctx.restore();
    };
    // Cover only the real caret while the predicted caret is elsewhere. The
    // terminal's cursor state and its underlying buffer are left untouched.
    const buffer = this.term.buffer.active;
    if (overlay.cursor) glyph(buffer.cursorX, buffer.cursorY, buffer.getLine(buffer.baseY + buffer.cursorY)?.getCell(buffer.cursorX)?.getChars() || " ");
    for (const cell of overlay.cells) {
      if (cell.text !== null) glyph(cell.col, cell.row, cell.text);
      if (cell.underlined) { ctx.fillStyle = fg; ctx.fillRect(cell.col * cw, (cell.row + 1) * ch - 1, cw, 1); }
    }
    if (overlay.cursor) {
      const { col, row } = overlay.cursor, focused = this.term.element?.contains(document.activeElement);
      ctx.fillStyle = ctx.strokeStyle = theme?.cursor || fg;
      if (!focused) ctx.strokeRect(col * cw + .5, row * ch + .5, cw - 1, ch - 1);
      else if (this.term.options.cursorStyle === "bar") ctx.fillRect(col * cw, row * ch, this.term.options.cursorWidth || 1, ch);
      else if (this.term.options.cursorStyle === "underline") ctx.fillRect(col * cw, (row + 1) * ch - 1, cw, 1);
      else {
        const predicted = overlay.cells.find(cell => cell.col === col && cell.row === row)?.text;
        glyph(col, row, predicted ?? buffer.getLine(buffer.baseY + row)?.getCell(col)?.getChars() ?? " ", theme?.cursorAccent || bg, theme?.cursor || fg);
      }
    }
    this.canvas.hidden = false;
    const now = performance.now() / 1000;
    for (const first of this.engine.takeFirstPaints()) typingLatency.prediction(this.host, (now - first.pressedAt) * 1000);
  }
}
