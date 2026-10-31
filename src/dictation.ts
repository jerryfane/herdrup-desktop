import { Dictation, events } from "./mygo";
import { composerGlyph } from "./composer";
import "./dictation.css";

// Serialize ownership changes across composers. A new capture cannot start until
// the previous helper has exited and released its microphone.
let transition: Promise<void> = Promise.resolve();
let owner: ComposerDictation | null = null;
function enqueue(action: () => Promise<void>) {
  transition = transition.then(action, action);
}

export class ComposerDictation {
  readonly button = document.createElement("button");
  readonly strip = document.createElement("div");
  private canvas = document.createElement("canvas");
  private timer = document.createElement("span");
  private token: string | null = null;
  private base = "";
  private recording = false;
  private started = 0;
  private clock: number | undefined;
  private levels = new Float32Array(256);
  private cursor = 0;
  private count = 0;
  private disposed = false;
  private off: () => void;
  private hidden = () => { if (document.hidden) this.stop(); };
  constructor(private readonly input: HTMLTextAreaElement, private readonly changed: () => void, private readonly onStart: () => void) {
    this.button.type = "button";
    this.button.className = "composer-action composer-microphone";
    this.button.onclick = () => { if (this.busy) this.stop(); else this.start(); };
    this.strip.className = "composer-recording";
    this.strip.setAttribute("aria-label", "Recording");
    this.strip.setAttribute("role", "status");
    const dot = document.createElement("span"); dot.className = "composer-recording-dot";
    this.strip.append(dot, this.canvas, this.timer);
    this.off = events.dictationChanged.on(event => {
      if (this.disposed || !this.token || event.token !== this.token) return;
      if (event.error) { this.stop(); this.showError(event.error); return; }
      if (event.state === "stopped") { this.stop(); return; }
      if (event.state === "recording" && !this.recording) {
        this.recording = true; this.started = Date.now();
        this.clock = window.setInterval(() => this.draw(), 100);
        this.render();
      }
      if (event.text?.trim()) {
        this.input.value = this.base ? this.base + " " + event.text : event.text;
        this.input.dispatchEvent(new Event("input")); this.render();
      }
      if (event.level !== undefined) {
        this.levels[this.cursor] = Math.max(0, Math.min(1, event.level));
        this.cursor = (this.cursor + 1) % this.levels.length;
        this.count = Math.min(this.count + 1, this.levels.length); this.draw();
      }
    });
    document.addEventListener("visibilitychange", this.hidden);
    this.render(false);
  }
  get busy() { return this.token !== null; }
  start() {
    if (this.disposed || this.busy || this.button.disabled) return;
    owner?.stop(); owner = this;
    const token = crypto.randomUUID(); this.token = token;
    this.base = this.input.value; this.count = 0; this.cursor = 0;
    this.onStart(); this.render();
    enqueue(async () => {
      if (this.token !== token || this.disposed) return;
      try { await Dictation.start(token, navigator.language || "en"); }
      catch (error) {
        if (this.token === token && !this.disposed) { this.stop(); this.showError(String(error)); }
      }
    });
  }
  stop() {
    const token = this.token;
    if (!token) return;
    this.token = null; this.recording = false;
    if (owner === this) owner = null;
    clearInterval(this.clock); this.clock = undefined;
    this.render();
    enqueue(async () => {
      try { await Dictation.stop(token); }
      catch (error) { if (!this.disposed) this.showError(String(error)); }
    });
  }
  private render(notify = true) {
    this.button.setAttribute("aria-label", this.busy ? "Stop dictation" : "Dictate");
    this.button.setAttribute("aria-pressed", String(this.busy));
    if (this.recording) {
      const stop = document.createElement("span"); stop.className = "composer-recording-stop";
      this.button.replaceChildren(stop);
    } else if (this.busy) {
      const spinner = document.createElement("span"); spinner.className = "composer-mic-spinner";
      this.button.replaceChildren(spinner);
    } else this.button.replaceChildren(composerGlyph("mic", 20));
    this.input.disabled = this.busy;
    this.input.hidden = this.recording && !this.input.value;
    this.strip.hidden = !this.recording;
    if (notify) this.changed();
  }
  private draw() {
    if (!this.recording || !this.canvas.isConnected) return;
    const width = this.canvas.clientWidth, height = 22, scale = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * scale) || this.canvas.height !== Math.round(height * scale)) {
      this.canvas.width = Math.round(width * scale); this.canvas.height = Math.round(height * scale);
    }
    const ctx = this.canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.clearRect(0, 0, width, height);
      const styles = getComputedStyle(this.strip), count = Math.floor(width / 5);
      for (let i = 0; i < Math.min(count, this.count); i++) {
        const value = this.levels[(this.cursor - 1 - i + this.levels.length) % this.levels.length]!;
        const bar = Math.max(2, value * height);
        ctx.globalAlpha = i < 2 ? 1 : Math.max(.3, 1 - i / count);
        ctx.fillStyle = styles.getPropertyValue(i < 2 ? "--color-text" : "--color-text-dim");
        ctx.beginPath(); ctx.roundRect(width - (i + 1) * 5 + 2, (height - bar) / 2, 3, bar, 1.5); ctx.fill();
      }
    }
    const seconds = Math.floor((Date.now() - this.started) / 1000);
    this.timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  private showError(message: string) {
    const dialog = document.createElement("dialog"); dialog.className = "dictation-error";
    const title = document.createElement("h2"); title.textContent = "Dictation";
    const text = document.createElement("p"); text.textContent = message;
    const ok = document.createElement("button"); ok.textContent = "OK"; ok.onclick = () => dialog.close();
    dialog.append(title, text, ok); dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.append(dialog); dialog.showModal();
  }
  dispose() {
    this.stop(); this.disposed = true; this.off();
    document.removeEventListener("visibilitychange", this.hidden);
  }
}
