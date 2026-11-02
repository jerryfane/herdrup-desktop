// The live glyph field behind "Select an agent": herdrup's TerminalGlyphFieldView
// (9845ecf App/SelectAgentField.swift), a quiet field of terminal glyphs that wakes under the
// pointer, ripples on a click, drifts under a slow invisible hand when nobody is pointing,
// twinkles, and has the roster's agents type their current activity into it. Hovering a
// sidebar row makes that agent type its line at the row's height.
//
// The resting picture is glyphField.ts's (one image, redrawn on each twinkle); only moving
// cells are drawn per frame, over a ground-coloured cover hiding their resting glyph. While
// `holdsStill` (herdrup's DesktopReferenceMock.holdsStill: the parity captures) the field is
// its first resting picture from the reference seed and nothing moves.

import { CELL_H, CELL_W, GLYPH_SIZE, REFERENCE_FIELD_SEED, SCRAMBLE, SELECT_AGENT_LABEL, drawRestingCells, glyphOrigin, restingField, type RestingField } from "./glyphField";

/** The status colours a line may type in; values index the palette (SelectAgentField.swift 60-62). */
export const Tone = { dim: 3, waiting: 5, working: 6, done: 7, died: 8 } as const;
export interface FieldLine { id: string; text: string; tone: number }

/** quiet, hair, faint, dim, ink, waiting, working, done, died (SelectAgentField.swift 99-103). */
const PALETTE_VARS = ["--color-hairline-quiet", "--color-hairline", "--color-text-faint", "--color-text-dim", "--color-text",
  "--status-waiting", "--status-working", "--status-done", "--status-died"];
const DIM = 3;
const TWINKLE_PERIOD = 1.6, TWINKLE_SHARE = 0.05;
const MAX_WRITERS = 4;
const RIPPLE_TONES = [Tone.waiting, Tone.working, Tone.done];

interface Ripple { x: number; y: number; r: number; tone: number }
interface Writer { cells: { index: number; glyph: string }[]; nameLength: number; tone: number; t: number; hold: number; speed: number }

const random = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const randomSeed = () => (BigInt(Math.floor(Math.random() * 2 ** 32)) << 32n) | BigInt(Math.floor(Math.random() * 2 ** 32));

export class LiveGlyphField {
  lines: FieldLine[] = [];
  private readonly ctx: CanvasRenderingContext2D;
  private readonly rest = document.createElement("canvas");
  private field: RestingField | null = null;
  private width = 0;
  private height = 0;
  private scale = 1;
  private quiet = { cx: 0, cy: 0, rx: 1, ry: 1 };
  private palette: string[] = [];
  private ground = "";
  private font = "";
  // Moving cells: glyph, energy, colour override (0 = by energy), and the active list.
  private chr: string[] = [];
  private energy = new Float32Array(0);
  private tint = new Uint8Array(0);
  private isActive = new Uint8Array(0);
  private active: number[] = [];
  private ripples: Ripple[] = [];
  private writers: Writer[] = [];
  private nextWrite = 1.2;
  private nextTwinkle = TWINKLE_PERIOD;
  private pointer = { x: 0, y: 0, inside: false, down: false, ghost: true, lastReal: -1e9 };
  private clock = 0;
  private lastTime = 0;
  private lensRadius = 115;
  private frame = 0;
  private skip = false;
  private advances = new Map<string, number>();
  private spokenID: string | null = null;
  private readonly reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

  /** `label` is the "Select an agent" text: hidden while an agent page covers the field, when
   *  the field costs nothing (herdrup pauses its SKView off screen). */
  constructor(private readonly canvas: HTMLCanvasElement, private readonly label: HTMLElement, private readonly holdsStill: boolean) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("LiveGlyphField: no 2D context");
    this.ctx = ctx;
    if (holdsStill) return;
    canvas.addEventListener("pointermove", e => this.pointed(e));
    canvas.addEventListener("pointerdown", e => {
      this.pointed(e);
      this.pointer.down = true;
      if (!this.reduceMotion.matches) this.ripples.push({ x: this.pointer.x, y: this.pointer.y, r: 0, tone: RIPPLE_TONES[Math.floor(Math.random() * 3)]! });
      this.wake();
    });
    // A mouse button release keeps hovering; leaving the field ends the lens.
    addEventListener("pointerup", () => { this.pointer.down = false; this.pointer.lastReal = this.clock; });
    canvas.addEventListener("pointerleave", () => { if (!this.pointer.down) this.pointer.inside = false; this.pointer.lastReal = this.clock; });
    document.addEventListener("visibilitychange", () => this.wake());
    new MutationObserver(() => this.wake()).observe(label, { attributes: true, attributeFilter: ["hidden"] });
  }

  /** Rebuilds the field for a new size (SelectAgentField.swift rebuild). */
  resize(opts: { widthPt: number; heightPt: number; scale: number; font: string; labelFont: string }) {
    const { widthPt, heightPt, scale } = opts;
    const style = getComputedStyle(document.documentElement);
    this.palette = PALETTE_VARS.map(name => style.getPropertyValue(name).trim());
    this.ground = style.getPropertyValue("--color-ground-machine").trim();
    this.font = opts.font;
    this.width = widthPt; this.height = heightPt; this.scale = scale;
    for (const c of [this.canvas, this.rest]) { c.width = Math.ceil(widthPt * scale); c.height = Math.ceil(heightPt * scale); }
    this.canvas.style.width = `${widthPt}px`; this.canvas.style.height = `${heightPt}px`;
    this.ctx.font = opts.labelFont;
    const label = this.ctx.measureText(SELECT_AGENT_LABEL).width;
    this.quiet = { cx: widthPt / 2, cy: heightPt / 2, rx: label / 2 + 30, ry: 30 };
    this.field = restingField(widthPt, heightPt, label, this.holdsStill ? REFERENCE_FIELD_SEED : randomSeed());
    const n = this.field ? this.field.cols * this.field.rows : 0;
    this.chr = new Array(n).fill(" ");
    this.energy = new Float32Array(n); this.tint = new Uint8Array(n); this.isActive = new Uint8Array(n);
    this.active = []; this.ripples = []; this.writers = [];
    this.ctx.font = `${GLYPH_SIZE}px ${this.font}`;
    this.advances.clear();
    if (this.holdsStill) {
      // The reference picture is drawn straight onto the visible canvas: copying it from the
      // offscreen one brightens antialiased glyphs ~14 % on macOS WebKit (parity 41400271237).
      drawRestingCells(this.ctx, this.field, { widthPt, heightPt, scale, ground: this.ground, ink: this.palette[1]!, font: this.font });
      return;
    }
    this.renderRest();
    this.draw();
    this.wake();
  }

  /** A sidebar row under the pointer: its agent types at the row's height, once per row
   *  entered (Spotlight.hover, speak). */
  hover(line: FieldLine, clientY: number) {
    if (this.holdsStill || !this.field || line.id === this.spokenID) return;
    this.spokenID = line.id;
    const rows = this.field.rows;
    if (rows <= 2) return;
    const y = clientY - this.canvas.getBoundingClientRect().top;
    const row = Math.min(Math.max(Math.round(y / CELL_H), 1), rows - 2);
    this.write(line, 2, row, 3.5);
    this.wake();
  }

  hoverEnded(id: string) { if (this.spokenID === id) this.spokenID = null; }

  /** Starts the frame loop if the field is on screen; it stops itself when it is not. */
  wake() {
    if (this.holdsStill || this.frame || !this.visible()) return;
    this.lastTime = 0;
    this.frame = requestAnimationFrame(t => this.tick(t));
  }

  private visible() {
    return !!this.field && !this.label.hidden && this.canvas.isConnected && !this.canvas.hidden && this.canvas.offsetParent !== null && document.visibilityState === "visible";
  }

  private pointed(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    Object.assign(this.pointer, { x: e.clientX - r.left, y: e.clientY - r.top, inside: true, ghost: false, lastReal: this.clock });
    this.wake();
  }

  private tick(time: number) {
    this.frame = 0;
    if (!this.visible()) return;
    const now = time / 1000;
    const dt = this.lastTime === 0 ? 1 / 60 : Math.min(0.05, now - this.lastTime);
    this.lastTime = now;
    this.clock += dt;
    this.step(dt);
    // 60 fps under a real pointer or a ripple; the slow autopilot reads the same at 30.
    this.skip = this.pointer.ghost && this.ripples.length === 0 ? !this.skip : false;
    if (!this.skip) this.draw();
    this.decay(dt);
    this.frame = requestAnimationFrame(t => this.tick(t));
  }

  private step(dt: number) {
    const reduce = this.reduceMotion.matches, p = this.pointer;
    // Autopilot: a slow invisible hand when nobody is pointing, so the page never looks dead.
    if (!p.down && this.clock - p.lastReal > 3.5) {
      if (reduce) p.inside = false;
      else {
        p.ghost = true; p.inside = true;
        const t = this.clock * 0.23;
        const gx = this.width * (0.5 + 0.34 * Math.sin(t * 1.3) * Math.cos(t * 0.37));
        const gy = this.height * (0.5 + 0.30 * Math.sin(t * 0.9 + 1.2));
        const k = Math.min(1, dt * 1.6);
        p.x += (gx - p.x) * k; p.y += (gy - p.y) * k;
      }
    }
    this.nextTwinkle -= dt;
    if (this.nextTwinkle <= 0 && !reduce && this.field) {
      this.nextTwinkle = TWINKLE_PERIOD;
      const g = this.field.glyphs;
      for (let i = 0; i < Math.floor(g.length * TWINKLE_SHARE); i++) g[Math.floor(Math.random() * g.length)] = Math.floor(Math.random() * SCRAMBLE.length);
      this.renderRest();
    }
    this.lensRadius = p.ghost ? 80 : 115;
    if (p.inside && !reduce) this.energizeLens(this.lensRadius);
    this.advanceRipples(dt);
    this.advanceWriters(dt);
  }

  private energizeLens(radius: number) {
    const f = this.field!, p = this.pointer;
    const c0 = Math.max(0, Math.floor((p.x - radius) / CELL_W)), c1 = Math.min(f.cols - 1, Math.floor((p.x + radius) / CELL_W));
    const r0 = Math.max(0, Math.floor((p.y - radius) / CELL_H)), r1 = Math.min(f.rows - 1, Math.floor((p.y + radius) / CELL_H));
    const strength = p.ghost ? 0.6 : 1;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const x = c * CELL_W + CELL_W / 2, y = r * CELL_H + CELL_H / 2;
      const d = Math.hypot(x - p.x, y - p.y);
      if (d >= radius) continue;
      const e = Math.pow(1 - d / radius, 1.4) * strength * (0.25 + 0.75 * this.quietFactor(x, y));
      if (e <= 0.02) continue;
      const i = r * f.cols + c;
      // A cell waking under the lens starts from the character it was resting as.
      if (!this.isActive[i]) this.chr[i] = SCRAMBLE[f.glyphs[i]!]!;
      if (e > this.energy[i]!) { this.energy[i] = e; if (this.tint[i]! > 4) this.tint[i] = 0; }
      this.activate(i);
    }
  }

  private advanceRipples(dt: number) {
    const f = this.field!, reach = Math.hypot(this.width, this.height);
    this.ripples = this.ripples.filter(ripple => {
      ripple.r += dt * 520;
      if (ripple.r > reach) return false;
      const step = (CELL_W * 0.8) / Math.max(ripple.r, 1), fade = Math.max(0.25, 1 - ripple.r / 900);
      for (let a = 0; a < Math.PI * 2; a += step) {
        const x = ripple.x + Math.cos(a) * ripple.r, y = ripple.y + Math.sin(a) * ripple.r;
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
        const i = Math.floor(y / CELL_H) * f.cols + Math.floor(x / CELL_W);
        if (i >= this.energy.length) continue;
        const e = 0.9 * this.quietFactor(x, y) * fade;
        if (e > this.energy[i]!) { this.energy[i] = e; this.tint[i] = ripple.tone; this.chr[i] = scramble(); this.activate(i); }
      }
      return true;
    });
  }

  private advanceWriters(dt: number) {
    this.nextWrite -= dt;
    if (this.nextWrite <= 0 && this.writers.length < 3) {
      this.nextWrite = random(1.4, 2.6);
      const speaking = this.lines.filter(l => l.tone !== Tone.dim);
      const pool = speaking.length ? speaking : this.lines;
      if (pool.length) this.placeAtRandom(pool[Math.floor(Math.random() * pool.length)]!);
    }
    this.writers = this.writers.filter(w => {
      w.t += dt;
      const shown = Math.min(w.cells.length, Math.floor(w.t * w.speed));
      for (let j = 0; j < shown; j++) {
        const cell = w.cells[j]!;
        this.chr[cell.index] = cell.glyph;
        const age = w.t - j / w.speed;
        const e = age < w.hold ? 1 : Math.max(0, 1 - (age - w.hold) * 0.8);
        this.energy[cell.index] = Math.max(this.energy[cell.index]! * 0.6, e * 0.95);
        this.tint[cell.index] = j < w.nameLength ? w.tone : DIM;
        this.activate(cell.index);
      }
      return w.t <= w.hold + w.cells.length / w.speed + 1.5;
    });
  }

  private placeAtRandom(line: FieldLine) {
    const f = this.field!, length = Array.from(line.text).length;
    for (let k = 0; k < 12; k++) {
      const r = Math.floor(Math.random() * f.rows), c = Math.floor(Math.random() * Math.max(1, f.cols - length - 2));
      const y = r * CELL_H, x0 = c * CELL_W, x1 = x0 + length * CELL_W;
      if (this.quietFactor((x0 + x1) / 2, y) < 1 || this.quietFactor(x0, y) < 1 || this.quietFactor(x1, y) < 1) continue;
      this.write(line, c, r, 2.8);
      return;
    }
  }

  /** At most MAX_WRITERS lines type at once; a new one evicts the oldest, whose cells fade. */
  private write(line: FieldLine, column: number, row: number, hold: number) {
    const f = this.field!;
    if (this.writers.length >= MAX_WRITERS) this.writers.splice(0, this.writers.length - MAX_WRITERS + 1);
    const chars = Array.from(line.text);
    const cells = chars.flatMap((glyph, j) => column + j < f.cols ? [{ index: row * f.cols + column + j, glyph }] : []);
    const name = chars.indexOf("›");
    this.writers.push({ cells, nameLength: name < 0 ? chars.length : name, tone: line.tone, t: 0, hold, speed: random(30, 50) });
  }

  /** Energy fades after drawing; hot cells that are not typed text keep scrambling. */
  private decay(dt: number) {
    const survivors: number[] = [];
    for (const i of this.active) {
      const typed = this.tint[i] !== 0;
      if (!typed && Math.random() < this.energy[i]! * dt * 22) this.chr[i] = scramble();
      this.energy[i] = this.energy[i]! - dt * (typed ? 0.35 : 1.5);
      if (this.energy[i]! <= 0.02) { this.energy[i] = 0; this.tint[i] = 0; this.isActive[i] = 0; }
      else survivors.push(i);
    }
    this.active = survivors;
  }

  private renderRest() {
    const ctx = this.rest.getContext("2d")!;
    drawRestingCells(ctx, this.field, { widthPt: this.width, heightPt: this.height, scale: this.scale, ground: this.ground, ink: this.palette[1]!, font: this.font });
  }

  /** The resting picture, then every moving cell: a cover, then its glyph pushed by the lens. */
  private draw() {
    const ctx = this.ctx, f = this.field, s = this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.rest, 0, 0);
    if (!f || !this.active.length && !this.writers.length) return;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.fillStyle = this.ground;
    for (const i of this.active) ctx.fillRect((i % f.cols) * CELL_W, Math.floor(i / f.cols) * CELL_H, CELL_W, CELL_H);
    ctx.font = `${GLYPH_SIZE}px ${this.font}`;
    ctx.textBaseline = "alphabetic";
    const p = this.pointer, lens = p.inside && !this.reduceMotion.matches, radius = this.lensRadius, push = p.ghost ? 2.5 : 5;
    for (const i of this.active) {
      const e = this.energy[i]!, glyph = this.chr[i]!;
      const colour = this.tint[i] !== 0 ? this.tint[i]! : e > 0.78 ? 4 : e > 0.45 ? 3 : 2;
      let advance = this.advances.get(glyph);
      if (advance === undefined) { advance = ctx.measureText(glyph).width; this.advances.set(glyph, advance); }
      let { x, baseline } = glyphOrigin(i, f.cols, advance, s);
      if (lens) {
        const dx = (i % f.cols) * CELL_W + CELL_W / 2 - p.x, dy = Math.floor(i / f.cols) * CELL_H + CELL_H / 2 - p.y;
        const d = Math.max(Math.hypot(dx, dy), 1);
        if (d < radius) { const m = Math.sin((Math.PI * d) / radius) * push; x += (dx / d) * m; baseline += (dy / d) * m; }
      }
      ctx.globalAlpha = Math.min(1, 0.2 + e);
      ctx.fillStyle = this.palette[colour]!;
      ctx.fillText(glyph, x, baseline);
    }
    // Each line's cursor: a dim block after the typed text, blinking while it holds.
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = this.palette[DIM]!;
    const blinkOn = Math.floor(this.clock * 2) % 2 === 1;
    for (const w of this.writers) {
      const shown = Math.min(w.cells.length, Math.floor(w.t * w.speed));
      if (!w.cells.length || !(shown < w.cells.length || (w.t < w.hold && blinkOn))) continue;
      const at = w.cells[Math.min(shown, w.cells.length - 1)]!.index;
      const x = (at % f.cols) * CELL_W + (shown >= w.cells.length ? CELL_W : 0), y = Math.floor(at / f.cols) * CELL_H;
      ctx.fillRect(x + 0.5, y + 2, CELL_W - 1, CELL_H - 4);
    }
    ctx.globalAlpha = 1;
  }

  private activate(i: number) {
    if (this.isActive[i]) return;
    this.isActive[i] = 1;
    this.active.push(i);
  }

  /** 0 inside the label's clear zone, rising to 1 outside it. */
  private quietFactor(x: number, y: number) {
    const q = this.quiet, ex = (x - q.cx) / (q.rx * 1.1), ey = (y - q.cy) / (q.ry * 1.05);
    return Math.min(Math.max((ex * ex + ey * ey - 0.55) / 0.9, 0), 1);
  }
}

const scramble = () => SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)]!;
