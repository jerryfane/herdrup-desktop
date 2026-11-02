import { expect, test } from "bun:test";
import { MOTIONS, smooth, spring, springAt, springSettle } from "../src/motion";

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
