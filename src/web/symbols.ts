// Symbols for the browser build: symbols.go's Symbols.Image as Windows and Linux draw it
// (symbols_other.go), a Phosphor stand-in fitted to the SF Symbol's box, from the tables
// `go run ./cmd/websymbols` reads out of the Go sources into symbols.data.ts. The ink bounds there
// come precomputed, so drawing is IEEE arithmetic only and matches Go's to the byte
// (test/websymbols.test.ts against testdata/websymbols.golden.json).

import type { SymbolImage } from "../mygo";
import { phosphor, phosphorWeights, sfMetrics, standIns, symbolWeights } from "./symbols.data";

export const Symbols = {
 /** Image draws the SF Symbol name as SwiftUI draws
  *  Image(systemName: name).font(.system(size: pointSize, weight: weight)), scale pixels per
  *  point (1 to 3). Results are cached; a failure rejects with the CallError Go's would. */
 image(name: string, pointSize: number, weight: string, scale: number): Promise<SymbolImage> {
  try {
   return Promise.resolve(image(name, pointSize, weight, scale));
  } catch (err) {
   return Promise.reject(err);
  }
 },
} as const;

// symbols.go:71
const maxSymbolPointSize = 512;

// symbols.go:90-100: by size, weight, scale and name; failures are not kept.
const cache = new Map<string, SymbolImage>();

// symbols.go:39-68, after the bridge has decoded the arguments from their JSON (mygo ipc.go
// decodeArg): NaN and ±Infinity go as null, Go's zero; -0 goes as 0; scale must be an int.
function image(name: string, size: number, weight: string, scaleArg: number): SymbolImage {
 const pointSize = Number.isFinite(size) ? size + 0 : 0;
 const scaleJSON = Number.isFinite(scaleArg) ? JSON.stringify(scaleArg) : "0";
 if (!/^-?\d+$/.test(scaleJSON)) {
  throw callError(`invalid argument 4: json: cannot unmarshal JSON number ${scaleJSON} into Go int: invalid syntax`);
 }
 if (BigInt(scaleJSON) > 0x7fffffffffffffffn || BigInt(scaleJSON) < -0x8000000000000000n) {
  throw callError(`invalid argument 4: json: cannot unmarshal JSON number ${scaleJSON} into Go int: value out of range`);
 }
 const scale = Number(scaleJSON);
 const w = symbolWeights.indexOf(weight);
 if (w < 0) throw callError(`symbols: unknown weight ${quote(weight)}`);
 if (name === "") throw callError("symbols: no symbol name");
 if (!(pointSize > 0 && pointSize <= maxSymbolPointSize)) {
  throw callError(`symbols: point size ${formatV(pointSize)} is not in (0, ${maxSymbolPointSize}]`);
 }
 if (scale < 1 || scale > 3) throw callError(`symbols: scale ${scaleJSON} is not 1, 2 or 3`);
 const key = `${pointSize}/${w}/${scale}/${name}`;
 let img = cache.get(key);
 if (!img) {
  img = drawSymbol(name, pointSize, w, scale);
  cache.set(key, img);
 }
 return { ...img };
}

/** A Go method's error as mygo-runtime rejects with it: a CallError. */
function callError(message: string): Error {
 const err = new Error(message);
 err.name = "CallError";
 return Object.assign(err, { method: "Symbols.Image" });
}

// symbols_other.go:33-41
function phosphorFile(s: { icon: string; solid: boolean }, w: number): string {
 if (s.solid) return `third_party/phosphor/fill/${s.icon}-fill.svg`;
 const pw = phosphorWeights[w] ?? "regular";
 if (pw !== "regular") return `third_party/phosphor/${pw}/${s.icon}-${pw}.svg`;
 return `third_party/phosphor/regular/${s.icon}.svg`;
}

// symbols_other.go:43-80
function drawSymbol(name: string, pointSize: number, w: number, scale: number): SymbolImage {
 const s = standIns.find((s) => s.symbol === name);
 const box = sfMetrics.find((m) => m.symbol === name)?.weights[w];
 if (!s || !box) throw callError(`symbols: no stand-in for SF Symbol ${quote(name)}`);
 const file = phosphorFile(s, w);
 const path = phosphor[file];
 // embed.FS's ReadFile error; the generator writes every file a stand-in draws.
 if (!path) throw callError(`symbols: open ${file}: file does not exist`);
 const [boxWidth, boxHeight, baseline, left, top, right, bottom] = box;
 const [minX, minY, maxX, maxY] = path.ink;

 // The box macOS gives the symbol at this size and scale. Scale the icon's ink into the
 // symbol's, keeping its aspect, and centre it there.
 const width = snap(boxWidth * pointSize, scale), height = snap(boxHeight * pointSize, scale);
 const k = Math.min((right - left) / (maxX - minX), (bottom - top) / (maxY - minY)) * pointSize;
 const vx = (minX + maxX) / 2 - (left + right) / 2 * pointSize / k;
 const vy = (minY + maxY) / 2 - (top + bottom) / 2 * pointSize / k;
 const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="${num(vx)} ${num(vy)} ${num(width / k)} ${num(height / k)}"><path fill="#fff" d="${path.d}"/></svg>`;
 return {
  dataURL: "data:image/svg+xml;base64," + base64(svg),
  width,
  height,
  baseline: goRound(baseline * pointSize * scale) / scale, // symbols_other.go:89-93 snapBaseline
 };
}

// symbols_other.go:81-86: up to whole pixels at scale.
function snap(points: number, scale: number): number {
 return Math.ceil(points * scale - 1e-3) / scale;
}

// symbols_other.go:95: strconv.FormatFloat(math.Round(v*1e4)/1e4, 'f', -1, 64).
function num(v: number): string {
 return formatF(goRound(v * 1e4) / 1e4);
}

/** Go's math.Round: half away from zero, keeping the sign of zero (JS rounds half up). */
function goRound(x: number): number {
 const t = Math.trunc(x); // x - t is exact
 return Math.abs(x - t) >= 0.5 ? t + Math.sign(x) : t;
}

/** strconv.FormatFloat(v, 'f', -1, 64): the shortest digits, never an exponent. */
function formatF(v: number): string {
 if (Object.is(v, -0)) return "-0";
 if (!Number.isFinite(v)) return Number.isNaN(v) ? "NaN" : v > 0 ? "+Inf" : "-Inf";
 const s = String(v);
 if (!s.includes("e")) return s;
 const [mantissa = "", e = "0"] = v.toExponential().split("e");
 const sign = mantissa.startsWith("-") ? "-" : "";
 const digits = mantissa.replace("-", "").replace(".", "");
 const exp = Number(e);
 return sign + (exp < 0 ? "0." + "0".repeat(-exp - 1) + digits : digits.padEnd(exp + 1, "0"));
}

/** fmt's %v of a float64 (strconv 'g', shortest): an exponent below 1e-4 and from 1e6 on. */
function formatV(v: number): string {
 if (Object.is(v, -0)) return "-0";
 if (!Number.isFinite(v)) return formatF(v);
 const [mantissa = "", e = "0"] = v.toExponential().split("e");
 const exp = Number(e);
 if (v !== 0 && (exp < -4 || exp >= 6)) return `${mantissa}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
 return formatF(v);
}

const printable = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u;
const shortEscapes: Readonly<Record<number, string>> = { 7: "\\a", 8: "\\b", 9: "\\t", 10: "\\n", 11: "\\v", 12: "\\f", 13: "\\r" };

/** fmt's %q of a string (strconv.Quote): printable runes as they are, the rest escaped. */
function quote(s: string): string {
 let out = "\"";
 for (const ch of s) {
  const r = ch.codePointAt(0) ?? 0;
  const hex = r.toString(16);
  if (ch === "\"" || ch === "\\") out += "\\" + ch;
  else if (printable.test(ch)) out += ch;
  else if (shortEscapes[r]) out += shortEscapes[r];
  else if (r < 0x20 || r === 0x7f) out += "\\x" + hex.padStart(2, "0");
  else if (r < 0x10000) out += "\\u" + hex.padStart(4, "0");
  else out += "\\U" + hex.padStart(8, "0");
 }
 return out + "\"";
}

/** base64.StdEncoding of the string's UTF-8. */
function base64(s: string): string {
 let bin = "";
 for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
 return btoa(bin);
}
