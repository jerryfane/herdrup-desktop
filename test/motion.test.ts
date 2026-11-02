import { expect, test } from "bun:test";
import { easeOut, MOTIONS, smooth, spring, springAt, springSettle } from "../src/motion";

const peak = (response: number, damping: number) => {
  let best = 0;
  for (let t = 0; t < 2; t += 0.0005) best = Math.max(best, springAt(t, response, damping));
  return best;
};

// A damped oscillator overshoots by exp(-ζπ / √(1-ζ²)): 1.52 % for SwiftUI's rearrange spring.
test("an underdamped spring overshoots by the damping's textbook amount", () => {
  expect(peak(0.38, 0.8) - 1).toBeCloseTo(Math.exp((-0.8 * Math.PI) / Math.sqrt(1 - 0.64)), 3);
});

test(".smooth never overshoots and settles near its duration", () => {
  expect(peak(0.3, 1)).toBeLessThanOrEqual(1);
  // A critically damped spring with response r is within 0.1 % after about 1.47 r.
  expect(springSettle(0.3, 1)).toBeGreaterThan(0.3);
  expect(springSettle(0.3, 1)).toBeLessThan(0.5);
});

test("the CSS curve starts at 0, ends exactly at 1 and keeps the overshoot", () => {
  const stops = spring(0.38, 0.8).ease.slice(7, -1).split(", ").map(Number);
  expect(stops[0]).toBe(0);
  expect(stops.at(-1)).toBe(1);
  expect(Math.max(...stops)).toBeGreaterThan(1.005);
  expect(Math.max(...smooth(0.35).ease.slice(7, -1).split(", ").map(Number))).toBeLessThanOrEqual(1);
});

test("every named motion is short enough to feel immediate", () => {
  for (const [name, m] of Object.entries(MOTIONS)) {
    expect(m.duration, name).toBeGreaterThan(0.1);
    expect(m.duration, name).toBeLessThan(0.7);
  }
});

// CSS ease-out, cubic-bezier(0, 0, 0.58, 1), is 0.6847 halfway through; reading the curve at the
// Bézier parameter instead of solving for time would give 0.5 there.
test("easeOut draws CSS ease-out from 0 to exactly 1 without going back", () => {
  expect(easeOut(0)).toBe(0);
  expect(easeOut(1)).toBe(1);
  expect(easeOut(0.5)).toBeCloseTo(0.6847, 3);
  let last = 0;
  for (let x = 0.01; x <= 1; x += 0.01) { expect(easeOut(x)).toBeGreaterThanOrEqual(last); last = easeOut(x); }
});
