import { describe, expect, test } from "bun:test";
import { FieldDice, REFERENCE_FIELD_SEED, SCRAMBLE, glyphOrigin, restingField } from "../src/glyphField";

// Expected values come from an independent Python implementation of herdrup's FieldDice
// (App/SelectAgentField.swift:726-742) and of the Swift standard library's
// `UInt8.random(in:using:)` and `Double.random(in:using:)`, run with Python 3.12:
//
//   M = (1 << 64) - 1
//   class Dice:
//       def __init__(s, seed): s.state = seed
//       def next(s):
//           s.state = (s.state + 0x9E3779B97F4A7C15) & M
//           z = s.state
//           z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & M
//           z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & M
//           return z ^ (z >> 31)
//       def u8_below(s, ub):                  # Swift's next(upperBound:), T = UInt8
//           m = (s.next() & 0xFF) * ub
//           if (m & 0xFF) < ub:
//               t = (256 - ub) % ub
//               while (m & 0xFF) < t: m = (s.next() & 0xFF) * ub
//           return m >> 8
//       def unit(s): return (s.next() & ((1 << 53) - 1)) * 2.0 ** -53
//
// and the alphas from that Dice through `rebuild` (SelectAgentField.swift:248-269), with
// numpy.float32 for Swift's Float.

describe("FieldDice", () => {
  test("is SplitMix64: the first outputs for the reference seed", () => {
    const dice = new FieldDice(REFERENCE_FIELD_SEED);
    const outputs = Array.from({ length: 8 }, () => dice.next());
    expect(outputs).toEqual([
      0x0919aef9b023b0d4n,
      0x992f02c4cb5e948en,
      0xb622e224255d72e2n,
      0x357f1afd96100186n,
      0x3704cf657ee58fc1n,
      0x449052e21fc7e2bbn,
      0x0ad139dfb0d1be61n,
      0x23c9bfe4d0c79439n,
    ]);
  });
});

describe("restingField", () => {
  // The reference ipad-11 field: the detail column right of the 330 pt sidebar, below the
  // 32 pt status bar and above the 20 pt home-indicator inset, under a label about 110 pt
  // wide ("Select an agent" in Geist medium 15).
  const field = restingField(850, 768, 110, REFERENCE_FIELD_SEED)!;

  test("has herdrup's grid for the reference column", () => {
    expect([field.cols, field.rows]).toEqual([107, 52]);
  });

  test("draws each cell's glyph from the low byte of the dice", () => {
    // By hand: cell 0 draws 0x…b0d4, low byte 212; 212 × 26 = 0x1588, low byte 0x88 ≥ 26,
    // so the glyph is 0x15 = 21, "1". Cell 1: 0x8e = 142; 142 × 26 = 0x0e6c → 14, "[".
    expect(SCRAMBLE[field.glyphs[0]!]).toBe("1");
    expect(SCRAMBLE[field.glyphs[1]!]).toBe("[");
    // ref-ipad-11-populated.png draws this row from cell 1 on; cells 0 and 25 are dropped
    // by their keep roll.
    const row = Array.from(field.glyphs.subarray(0, 40), (k) => SCRAMBLE[k]).join("");
    expect(row).toBe("1[a|><$+n>0%{e<+}[nne_=1][|$\\$*\\g.<%n*10");
  });

  test("redraws a low byte that Lemire's method rejects", () => {
    // Cell 13's first draw has low byte 128: 128 × 26 = 0x0d00, low byte 0 < (256 - 26) % 26
    // = 22, so it draws again: 245 × 26 = 0x18e2 → 24, "e". Taking the rejected draw
    // would give 128 × 26 = 0x0d00 → 13, "|", and shift every later cell by one draw.
    expect(SCRAMBLE[field.glyphs[13]!]).toBe("e");
    expect(SCRAMBLE[field.glyphs[14]!]).toBe("<");
    // Row 1 starts at cell 107, after 9 rejections in row 0.
    const row = Array.from(field.glyphs.subarray(107, 127), (k) => SCRAMBLE[k]).join("");
    expect(row).toBe("|1gg]]$.>0+]/1#e%[e]");
  });

  test("weighs each cell by keep roll, vignette, quiet zone and noise", () => {
    const cases: [cell: number, alpha: number][] = [
      [0, 0], // keep roll 0.0755 < 0.12: dropped
      [25, 0], // keep roll 0.0865: dropped
      [1154, 0.8447304368019104], // row 10 col 84: keep roll 0.12030, just kept
      [1176, 0], // row 10 col 106: keep roll 0.11916, just dropped
      [2200, 0.8580262064933777], // row 20 col 60: clear of the vignette and the quiet zone
      [2728, 0], // row 25 col 53: under the label
      [2715, 0.3823571801185608], // row 25 col 40: the quiet zone's rim, factor 0.688
      [2812, 0.7557818293571472], // row 26 col 30
      [4370, 0.914344310760498], // row 40 col 90: 126 pt from the right edge
      [5563, 0.154649555683136], // the last cell, centred past the right edge (x 852 > 850): vignette 0.25
    ];
    for (const [cell, alpha] of cases) expect(field.alpha[cell]!).toBeCloseTo(alpha, 6);
  });

  test("draws no field under five columns or three rows", () => {
    expect(restingField(32, 100, 110, REFERENCE_FIELD_SEED)).toBeNull(); // 4 columns
    expect(restingField(100, 30, 110, REFERENCE_FIELD_SEED)).toBeNull(); // 2 rows
    expect(restingField(33, 31, 110, REFERENCE_FIELD_SEED)).not.toBeNull(); // 5 × 3
  });
});

describe("glyphOrigin", () => {
  test("centres the glyph in its cell, then snaps it to whole device pixels", () => {
    // IBM Plex Mono 11: advance 6.6, ascender 11.275, line height 14.3. Row 2, column 3:
    // x = 3 × 8 + (8 - 6.6) / 2 = 24.7, baseline = 2 × 15 + (15 - 14.3) / 2 + 0.5 + 11.275
    // = 42.125. At @2x the reference draws it 1 px across and 25 px down its cell: 24.5, 42.5.
    const { x, baseline } = glyphOrigin(2 * 107 + 3, 107, 6.6, 2);
    expect(x).toBe(24.5);
    expect(baseline).toBe(42.5);
  });
});
