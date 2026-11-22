// The window's first render comes whatever startup does (src/startup.ts; RoverOS preview.22
// stayed blank when a startup step failed after the bars were drawn).
import { expect, test } from "bun:test";
import { startWithFallback } from "../src/startup";

function hooks() {
 const h = { renders: 0, reports: [] as string[] };
 return { h, hooks: { firstRender: () => { h.renders++; }, report: (m: string) => { h.reports.push(m); } } };
}

test("a startup that finishes renders by itself: no fallback render and nothing reported", async () => {
 const { h, hooks: k } = hooks();
 await startWithFallback(async () => {}, k, 50);
 await Bun.sleep(80); // past the limit: the watch was cleared
 expect(h).toEqual({ renders: 0, reports: [] });
});

test("a startup that throws still renders, and reports the error with its stack", async () => {
 const { h, hooks: k } = hooks();
 await startWithFallback(async () => { throw new TypeError("x.toSorted is not a function"); }, k, 10_000);
 expect(h.renders).toBe(1);
 expect(h.reports[0]).toContain("startup failed: TypeError: x.toSorted is not a function");
});

// Real time on purpose: the limit is the behaviour under test, injected at 30 ms.
test("a startup that never finishes renders after the limit and says it is stuck", async () => {
 const { h, hooks: k } = hooks();
 void startWithFallback(() => new Promise<void>(() => {}), k, 30);
 await Bun.sleep(60);
 expect(h.renders).toBe(1);
 expect(h.reports[0]).toContain("no first render");
});
