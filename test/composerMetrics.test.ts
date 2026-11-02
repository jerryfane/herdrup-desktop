import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { COMPOSER_TEXT_PITCH, GEIST_REGULAR } from "../src/composerMetrics";

/** The sfnt table's offset in a TrueType file, by tag. */
function table(font: DataView, tag: string): number {
  const count = font.getUint16(4);
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    const name = String.fromCharCode(...[0, 1, 2, 3].map(k => font.getUint8(record + k)));
    if (name === tag) return font.getUint32(record + 8);
  }
  throw new Error(`no ${tag} table`);
}

test("the composer metrics are the bundled Geist Regular's", () => {
  const bytes = readFileSync(new URL("../public/fonts/Geist-Regular.ttf", import.meta.url));
  const font = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect({
    unitsPerEm: font.getUint16(table(font, "head") + 18),
    descender: font.getInt16(table(font, "hhea") + 6),
    capHeight: font.getInt16(table(font, "OS/2") + 88),
  }).toEqual(GEIST_REGULAR);
});

// Measured in herdrup 9845ecf's detail-writer references, both devices: 22.3-22.5 pt.
test("the draft pitch is the one the native writer draws", () => {
  expect(COMPOSER_TEXT_PITCH).toBeGreaterThanOrEqual(22.3);
  expect(COMPOSER_TEXT_PITCH).toBeLessThanOrEqual(22.5);
});
