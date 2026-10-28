import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { continuousPath } from "../src/continuous";

// Every cubic of a path as 8 numbers (start, cp1, cp2, end), drawn left to
// right (each corner curve's ends differ in x by at least 0.07 r), sorted.
// Lines carry nothing beyond the curves' end points, so they are skipped.
type Pt = [number, number];
function curves(d: string): number[][] {
  const toks = d.match(/[MLHVCZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const out: number[][] = [];
  let cur: Pt = [0, 0];
  let start: Pt = [0, 0];
  let cmd = "";
  const num = () => Number(toks.shift());
  while (toks.length) {
    if (/[A-Z]/.test(toks[0])) cmd = toks.shift() as string;
    switch (cmd) {
      case "M":
        cur = start = [num(), num()];
        break;
      case "L":
        cur = [num(), num()];
        break;
      case "H":
        cur = [num(), cur[1]];
        break;
      case "V":
        cur = [cur[0], num()];
        break;
      case "C": {
        const c1: Pt = [num(), num()], c2: Pt = [num(), num()], to: Pt = [num(), num()];
        out.push(cur[0] < to[0] ? [...cur, ...c1, ...c2, ...to] : [...to, ...c2, ...c1, ...cur]);
        cur = to;
        break;
      }
      case "Z":
        cur = start;
        break;
      default:
        throw new Error(`unexpected path command ${cmd}`);
    }
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** Fails unless the two curve lists match point for point within 0.001 pt. */
function expectSameCurves(ours: number[][], want: number[][]) {
  expect(ours).toHaveLength(want.length);
  ours.forEach((c, i) => {
    c.forEach((v, j) => {
      if (Math.abs(v - want[i][j]) > 1e-3) {
        throw new Error(`curve ${i} value ${j}: ${v} vs ${want[i][j]}\nours ${c.join(" ")}\nwant ${want[i].join(" ")}`);
      }
    });
  });
}

const fixture = readFileSync(new URL("./swiftui-paths.txt", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => {
    const [label, d] = l.split(" | ");
    const m = label.match(/([\d.]+)x([\d.]+)(?: r([\d.]+))?/);
    if (!m) throw new Error(`bad fixture label ${label}`);
    const w = Number(m[1]), h = Number(m[2]);
    return { label, w, h, r: m[3] ? Number(m[3]) : Math.min(w, h) / 2, d };
  });

test("the fixture covers normal, shortened and capsule sides", () => {
  // Normal corners (both sides long), a side just under the corner's reach
  // (40x30 r10), one well under it (100x30 r14) and capsules both ways.
  for (const label of ["rrect-default 100.0x100.0 r14.0", "rrect-default 40.0x30.0 r10.0", "rrect-default 100.0x30.0 r14.0", "capsule-default 60.0x30.0", "capsule-default 30.0x60.0"]) {
    expect(fixture.map((f) => f.label)).toContain(label);
  }
});

for (const f of fixture) {
  test(`continuousPath draws SwiftUI's ${f.label}`, () => {
    const ours = curves(continuousPath(f.w, f.h, f.r));
    expect(ours).toHaveLength(12);
    expectSameCurves(ours, curves(f.d));
  });
}

test("continuousPath offsets by (x, y)", () => {
  const moved = curves(continuousPath(87, 43, 21.5, 2, 3)).map((c) => c.map((v, j) => v - (j % 2 ? 3 : 2)));
  expectSameCurves(moved, curves(continuousPath(87, 43, 21.5)));
});
