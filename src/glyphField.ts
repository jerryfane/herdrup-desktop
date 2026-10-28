// The glyph field behind "Select an agent" in the empty detail column: herdrup's
// TerminalGlyphFieldView (App/SelectAgentField.swift) as its reference screenshots hold it,
// one resting picture from a fixed seed with no lens, twinkle, ripples or typing
// (`DesktopReferenceMock.holdsStill`). The label itself is the page's, not drawn here.

/** A cell's size in points (SelectAgentField.swift:89-90). */
const CELL_W = 8;
const CELL_H = 15;
/** The glyphs' point size, IBM Plex Mono regular (SelectAgentField.swift:91,131). */
const GLYPH_SIZE = 11;
/** IBM Plex Mono's hhea ascender and descender in em: the bundled IBMPlexMono-Regular.ttf,
 *  the same file herdrup ships, is 1025 / -275 per 1000 with no line gap. UIFont's
 *  `ascender` and `lineHeight` come from these; Chromium's canvas metrics round them to
 *  whole pixels (11 and 3 at 11 px), so they are taken from the font file here. */
const PLEX_ASCENT = 1.025;
const PLEX_DESCENT = 0.275;

/** What the field draws from; a resting cell's glyph is an index into this
 *  (`scrambleCharacters`, SelectAgentField.swift:97). The first is U+00B7. */
export const SCRAMBLE = Array.from("·.:-=+*#%$_/\\|[]{}<>01agen");

/** The label over the field, Geist medium 15 pt in textDim (SelectAgentField.swift:21-23).
 *  Its width sizes the field's quiet zone. */
const SELECT_AGENT_LABEL = "Select an agent";
const LABEL_FONT = '500 15px "Geist"';

/** The seed herdrup's reference screenshots draw the field from
 *  (`DesktopReferenceMock.glyphFieldSeed`, DesktopReferenceMock.swift:33). */
export const REFERENCE_FIELD_SEED = 0x4845524452555031n;

const MASK64 = (1n << 64n) - 1n;
const LOW53 = (1n << 53n) - 1n;

/** herdrup's `FieldDice` with a seed: SplitMix64 (SelectAgentField.swift:726-742), and the
 *  two ways the Swift standard library draws from it for the resting field. */
export class FieldDice {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = BigInt.asUintN(64, seed);
  }

  next(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return z ^ (z >> 31n);
  }

  /** `UInt8.random(in: 0..<upperBound, using:)`, upperBound in 1...255: the low byte of
   *  `next()`, then Lemire's nearly divisionless method on the 16-bit product, as Swift's
   *  `RandomNumberGenerator.next(upperBound:)` does it. */
  nextByte(upperBound: number): number {
    let m = Number(this.next() & 0xffn) * upperBound;
    if ((m & 0xff) < upperBound) {
      const t = (256 - upperBound) % upperBound;
      while ((m & 0xff) < t) m = Number(this.next() & 0xffn) * upperBound;
    }
    return m >> 8;
  }

  /** `Double.random(in: 0..<1, using:)`: the low 53 bits of `next()` times 2⁻⁵³. */
  nextUnit(): number {
    return Number(this.next() & LOW53) * 2 ** -53;
  }
}

/** The resting picture: one glyph (index into SCRAMBLE) and one opacity per cell, row-major. */
export interface RestingField {
  cols: number;
  rows: number;
  glyphs: Uint8Array;
  alpha: Float32Array;
}

/** herdrup's `rebuild` (SelectAgentField.swift:248-269) for a field of the given size in
 *  points. null when herdrup draws no field, only ground. */
export function restingField(widthPt: number, heightPt: number, labelWidthPt: number, seed: bigint): RestingField | null {
  const cols = Math.ceil(widthPt / CELL_W);
  const rows = Math.ceil(heightPt / CELL_H);
  if (cols <= 4 || rows <= 2) return null;

  // The label's clear zone: centre and radii in points.
  const qx = widthPt / 2, qy = heightPt / 2, qrx = labelWidthPt / 2 + 30, qry = 30;
  const n = cols * rows;
  const dice = new FieldDice(seed);
  const glyphs = new Uint8Array(n);
  for (let i = 0; i < n; i++) glyphs[i] = dice.nextByte(SCRAMBLE.length);
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i % cols) * CELL_W + CELL_W / 2;
    const y = Math.floor(i / cols) * CELL_H + CELL_H / 2;
    const edge = Math.min(x, y, widthPt - x, heightPt - y);
    const vignette = Math.min(Math.max(edge / 120, 0.25), 1);
    const noise = 0.55 + 0.45 * Math.sin(x * 0.021 + Math.sin(y * 0.013) * 2.1) * Math.cos(y * 0.017);
    const keep = dice.nextUnit() < 0.12 ? 0 : 1;
    const ex = (x - qx) / (qrx * 1.1), ey = (y - qy) / (qry * 1.05);
    const quiet = Math.min(Math.max((ex * ex + ey * ey - 0.55) / 0.9, 0), 1);
    alpha[i] = keep * vignette * quiet * (0.5 + 0.5 * noise);
  }
  return { cols, rows, glyphs, alpha };
}

/** Where a cell's glyph is drawn, in points from the field's top-left, at `scale` device
 *  pixels per point. herdrup centres the glyph's advance in the cell and its line box too,
 *  nudged down half a point (`RestFieldJob.render`, SelectAgentField.swift:777-787):
 *  0.7 pt across and a 12.125 pt baseline in IBM Plex Mono 11. CoreGraphics then puts the
 *  glyph on whole device pixels: in ref-ipad-11-populated.png every one of the 26 glyphs
 *  sits 1.0 px across and 25.0 px down in its 16×30 px cell (ink centroids against the
 *  outlines' centroids, ±0.05 px), not 1.4 and 24.25. So x snaps down and the baseline
 *  down the page, which is floor in CoreGraphics' bottom-up device space. */
export function glyphOrigin(cell: number, cols: number, advance: number, scale: number): { x: number; baseline: number } {
  const ascender = PLEX_ASCENT * GLYPH_SIZE;
  const lineHeight = (PLEX_ASCENT + PLEX_DESCENT) * GLYPH_SIZE;
  const x = (cell % cols) * CELL_W + (CELL_W - advance) / 2;
  const baseline = Math.floor(cell / cols) * CELL_H + (CELL_H - lineHeight) / 2 + 0.5 + ascender;
  return { x: Math.floor(x * scale) / scale, baseline: Math.ceil(baseline * scale) / scale };
}

/** Draws herdrup's resting glyph field into `canvas`, `widthPt`×`heightPt` points at `scale`
 *  device pixels per point: ground, then every kept cell's glyph in hairline at its opacity.
 *  `colours` needs `groundMachine` and `hairline`; `font` is the glyphs' CSS font family
 *  (the page's `--font-machine`). Call it once the IBM Plex Mono and Geist medium faces
 *  have loaded: the glyphs and the label's width (the quiet zone) are measured here. */
export function drawRestingGlyphField(
  canvas: HTMLCanvasElement,
  opts: { widthPt: number; heightPt: number; scale: number; seed: bigint; colours: Record<string, string>; font: string },
): void {
  const { widthPt, heightPt, scale, seed, colours, font } = opts;
  const ground = colours.groundMachine, ink = colours.hairline;
  if (!ground || !ink) throw new Error("drawRestingGlyphField needs the groundMachine and hairline colours");

  canvas.width = Math.ceil(widthPt * scale);
  canvas.height = Math.ceil(heightPt * scale);
  canvas.style.width = `${widthPt}px`;
  canvas.style.height = `${heightPt}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("drawRestingGlyphField: no 2D context");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, widthPt, heightPt);

  ctx.font = LABEL_FONT;
  const field = restingField(widthPt, heightPt, ctx.measureText(SELECT_AGENT_LABEL).width, seed);
  if (!field) return;

  ctx.font = `${GLYPH_SIZE}px ${font}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = ink;
  // Apple's rasteriser does not hint. Chromium on Linux does, which moves bars and stems by
  // up to a pixel (2.6 % of the reference column off by more than 8 levels, against 0.06 %
  // without); geometricPrecision turns it off. Browsers without the property ignore it.
  ctx.textRendering = "geometricPrecision";
  const advances = SCRAMBLE.map((glyph) => ctx.measureText(glyph).width);
  // herdrup skips a cell whose Float opacity is 0.01 or less (SelectAgentField.swift:783).
  const faintest = Math.fround(0.01);
  for (let i = 0; i < field.glyphs.length; i++) {
    const a = field.alpha[i]!;
    if (a <= faintest) continue;
    const k = field.glyphs[i]!;
    const { x, baseline } = glyphOrigin(i, field.cols, advances[k]!, scale);
    ctx.globalAlpha = a;
    ctx.fillText(SCRAMBLE[k]!, x, baseline);
  }
  ctx.globalAlpha = 1;
}
