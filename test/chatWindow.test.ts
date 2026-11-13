import { expect, test } from "bun:test";
import { drawnStart, FOLLOWED_WINDOW_CAP, RENDER_WINDOW, revealedAbove, slidWindow, windowStarting, type WindowRow } from "../src/chatWindow";

// herdrup #672: a chat following an agent for hours kept every row it ever merged on the page.
// Desktop now draws a window of rows (herdrup ChatView drawWindow / slideWindowToTail).
const rows = (n: number, from = 0): WindowRow[] => Array.from({ length: n }, (_, i) => ({ kind: "entry", id: `e${from + i}` }));

test("a chat that follows its tail keeps at most the cap drawn, then slides back to the newest window", () => {
 let all = rows(30);
 let from = windowStarting(all, drawnStart(all, null));
 expect(from).toBe("e0");
 // An agent writes for hours; the reader stays at the tail.
 let mostDrawn = 0;
 for (let n = 31; n <= 1000; n++) {
  all = rows(n);
  from = slidWindow(all, from, true);
  mostDrawn = Math.max(mostDrawn, all.length - drawnStart(all, from));
 }
 expect(mostDrawn).toBe(FOLLOWED_WINDOW_CAP);
 expect(all.length - drawnStart(all, from)).toBeGreaterThanOrEqual(RENDER_WINDOW);
 expect(all.length - drawnStart(all, from)).toBeLessThanOrEqual(FOLLOWED_WINDOW_CAP);
});

test("a reader who scrolled up keeps every drawn row, and the top never moves under them", () => {
 const all = rows(500);
 expect(slidWindow(all, "e100", false)).toBe("e100");
 expect(drawnStart(all, "e100")).toBe(100);
 // The pinned top is a row id, so rows arriving at the tail never push it out.
 expect(drawnStart(rows(900), "e100")).toBe(100);
});

test("a day label draws with the row under it and is never the window's top", () => {
 const all: WindowRow[] = [...rows(5), { kind: "day", id: "day:e5" }, ...rows(5, 5)];
 expect(windowStarting(all, 5)).toBe("e5");
 expect(drawnStart(all, "e5")).toBe(5);
});

test("Earlier messages reveals one window above the row on top, also after older rows merged above it", () => {
 const all = rows(200);
 expect(drawnStart(all, revealedAbove(all, "e150"))).toBe(150 - RENDER_WINDOW);
 expect(drawnStart(all, revealedAbove(all, "e10"))).toBe(0);
 // A page of 100 older rows merged above e0.
 const merged = [...rows(100, -100), ...all];
 expect(revealedAbove(merged, "e0")).toBe(`e${-RENDER_WINDOW}`);
 expect(revealedAbove(merged, "gone")).toBeNull();
});
