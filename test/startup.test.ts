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

// Real time on purpose: the limit passing after the first render is what is under test.
test("once the first render is up, the limit no longer applies and a later failure is only reported", async () => {
 const { h, hooks: k } = hooks();
 const later = Promise.withResolvers<void>();
 const run = startWithFallback(async rendered => { rendered(); await later.promise; }, k, 20);
 await Bun.sleep(50);
 expect(h).toEqual({ renders: 0, reports: [] });
 later.reject(new Error("pending agent lost"));
 await run;
 expect(h.renders).toBe(0);
 expect(h.reports).toHaveLength(1);
 expect(h.reports[0]).toContain("after the first render: Error: pending agent lost");
});

test("a rejection that can't be turned into text still renders and is reported", async () => {
 const { h, hooks: k } = hooks();
 await startWithFallback(() => Promise.reject(Object.create(null)), k, 10_000);
 expect(h.renders).toBe(1);
 expect(h.reports[0]).toContain("startup failed: (an error that can't be shown as text)");
});

test("reporting that throws doesn't stop the render", async () => {
 let renders = 0;
 await startWithFallback(async () => { throw new Error("x"); }, { firstRender: () => { renders++; }, report: () => { throw new Error("bridge gone"); } }, 10_000);
 expect(renders).toBe(1);
});
