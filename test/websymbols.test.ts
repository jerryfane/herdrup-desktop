import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Symbols } from "../src/web/symbols";
import { standIns, symbolWeights } from "../src/web/symbols.data";
import golden from "../app/testdata/websymbols.golden.json";

// app/symbols_web_test.go writes the golden from Go's Symbols.Image on Windows and Linux: every
// stand-in at every size and weight the screens use, at 1, 2 and 3x, and refused calls' errors.
type ImageRow = [string, number, string, number, number, number, number, string];
type ErrorRow = [string, number, string, number, string];
const images = golden.images as ImageRow[];
const errors = golden.errors as ErrorRow[];

test("every image is Go's, byte for byte", async () => {
 const differ: string[] = [];
 for (const [name, size, weight, scale, width, height, baseline, hash] of images) {
  const img = await Symbols.image(name, size, weight, scale);
  const sum = createHash("sha256").update(img.dataURL).digest("hex").slice(0, 16);
  const got = JSON.stringify([img.width, img.height, img.baseline, sum]);
  if (got !== JSON.stringify([width, height, baseline, hash])) differ.push(`${name} ${size} ${weight} ${scale}x: ${got}, Go [${width},${height},${baseline},"${hash}"]`);
 }
 expect(differ).toEqual([]);
 expect(images.length).toBe(standIns.length * new Set(images.map((r) => `${r[1]} ${r[2]}`)).size * 3);
});

test("refused calls fail with Go's error", async () => {
 for (const [name, size, weight, scale, message] of errors) {
  const err = await Symbols.image(name, size, weight, scale).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect({ name: (err as Error).name, message: (err as Error).message }).toEqual({ name: "CallError", message });
 }
});

test("a drawn image is cached but not shared", async () => {
 const a = await Symbols.image("xmark", 12, "semibold", 2);
 a.width = -1;
 expect((await Symbols.image("xmark", 12, "semibold", 2)).width).not.toBe(-1);
});

// The screens: src/*.ts (src/web and src/webguest are the browser's Go stand-ins, not screens).
const srcDir = join(import.meta.dir, "../src");
const sources = readdirSync(srcDir).filter((f) => f.endsWith(".ts")).map((f): [string, string] => [`src/${f}`, readFileSync(join(srcDir, f), "utf8")]);

test("the golden covers every size and weight the screens draw at", () => {
 const weights = symbolWeights.join("|");
 const drawn = new Set<string>();
 for (const [, src] of sources) {
  for (const m of src.matchAll(new RegExp(`\\b(\\d+(?:\\.\\d+)?),\\s*"(${weights})"\\s*[,)]`, "g"))) drawn.add(`${Number(m[1])} ${m[2]}`);
  // agentActions.ts glyphBox draws semibold; settings.ts glyph defaults to regular.
  for (const m of src.matchAll(/\bglyphBox\([^()]*,\s*(\d+)\)/g)) drawn.add(`${Number(m[1])} semibold`);
  for (const m of src.matchAll(/\bglyph\([^()]*,\s*(\d+)\)/g)) drawn.add(`${Number(m[1])} regular`);
 }
 const covered = new Set(images.map((r) => `${r[1]} ${r[2]}`));
 expect([...drawn].filter((p) => !covered.has(p))).toEqual([]);
});

// Names the screens draw only on macOS (navigator.platform "Mac" branches) or, off it, as the
// bundled Phosphor SVG beside them (settings.ts settingIcons, interaction.ts noteStyles and plan
// markers, gram.ts line icons), so Windows and Linux have no stand-in for them either.
const drawnOnlyOnMac = [
 "arrow.down", "arrow.down.circle", "arrow.right", "arrow.right.circle.fill",
 "arrow.triangle.2.circlepath", "arrow.up.right", "arrow.uturn.backward.circle.fill",
 "bell", "bell.slash", "bubble.left.and.bubble.right", "chart.bar", "checkmark.circle.fill",
 "checkmark.shield.fill", "chevron.left.forwardslash.chevron.right", "chevron.up.chevron.down", "circle",
 "desktopcomputer", "doc.on.clipboard", "doc.text", "envelope", "exclamationmark.bubble", "exclamationmark.circle",
 "exclamationmark.triangle.fill", "gauge.with.needle",
 "key.horizontal", "keyboard", "lightbulb", "lock.open", "lock.shield", "pause.circle", "person.2",
 "photo.on.rectangle", "plus.circle", "qrcode.viewfinder", "questionmark.circle.fill",
 "shield.lefthalf.filled", "sparkles", "stop.circle", "textformat.size",
];

/** The SF Symbol names src/*.ts passes to a symbol drawer: dotted literals anywhere (no other
 *  string literal in the screens is dotted lowercase) and literals given as a drawer's name. */
function screenSymbolNames(): Map<string, string> {
 const names = new Map<string, string>();
 const literal = /"([a-z][a-z0-9]*(?:\.[a-z0-9]+)*)"/g;
 const add = (text: string, file: string) => { for (const m of text.matchAll(literal)) if (!names.has(m[1]!)) names.set(m[1]!, file); };
 for (const [file, src] of sources) {
  for (const m of src.matchAll(/"([a-z][a-z0-9]*(?:\.[a-z0-9]+)+)"/g)) if (!names.has(m[1]!)) names.set(m[1]!, file);
  // symbol("name", …), symbol(a ? "x" : "y", …), place(host, "name", …), glyph/glyphBox/icon,
  // `icon:` / `symbol:` fields, a `const name = …` or `icon = …` choice, settings rows
  // (row/link's icon, the [name, title, text] tips) and settingIcons' keys.
  for (const m of src.matchAll(/\b(?:symbol|symbolNow|icon|glyph)\(([^,()]*),\s*\d/g)) add(m[1]!, file);
  for (const m of src.matchAll(/\b(?:place\([^,()]*|glyphBox\([^,()]*),([^,()]*),\s*\d/g)) add(m[1]!, file);
  for (const m of src.matchAll(/\b(?:icon|symbol): ([^,}\n]*)/g)) add(m[1]!, file);
  for (const m of src.matchAll(/\b(?:const name|icon) = ([^;\n]*)/g)) add(m[1]!.match(/(?:^|[?:]\s*)"[^"]*"/g)?.join(" ") ?? "", file);
  for (const m of src.matchAll(/\b(?:row|link)\("[^"]*", ("[^"]*")/g)) add(m[1]!, file);
  for (const m of src.matchAll(/^\s*\[("[^"]*"), "[A-Z]/gm)) add(m[1]!, file);
  for (const m of src.matchAll(/("[^"]*"): \w+Icon\b/g)) add(m[1]!, file);
 }
 // gram.ts's glyph("send") and status icons ("retry", "spinner", "arrow") are not SF Symbols.
 for (const name of ["send", "sending", "retry", "spinner", "arrow"]) names.delete(name);
 return names;
}

test("every symbol name the screens use has a stand-in, or is drawn only on macOS", () => {
 const known = new Set(standIns.map((s) => s.symbol));
 const used = screenSymbolNames();
 expect([...used].filter(([name]) => !known.has(name) && !drawnOnlyOnMac.includes(name))).toEqual([]);
 expect(drawnOnlyOnMac.filter((name) => known.has(name) || !used.has(name))).toEqual([]);
 expect(standIns.filter((s) => !used.has(s.symbol)).map((s) => s.symbol)).toEqual([]);
});
