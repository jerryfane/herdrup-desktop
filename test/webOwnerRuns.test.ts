import { expect, test } from "bun:test";
import { OwnerRuns } from "../src/web/ownerRuns";

test("a new run starts only once the one it replaces has let go; one replaced before its turn never starts", async () => {
 const runs = new OwnerRuns();
 const started: string[] = [];
 const firstHeld = Promise.withResolvers<void>();
 const first = runs.begin("acct-A", async signal => { started.push("A"); await firstHeld.promise; expect(signal.aborted).toBe(true); }, () => {});
 await Promise.resolve();
 expect(started).toEqual(["A"]);
 runs.begin("acct-B", async () => { started.push("B1"); }, () => {});
 const b2 = Promise.withResolvers<void>();
 const last = runs.begin("acct-B", async () => { started.push("B2"); b2.resolve(); }, () => {});
 expect(first.aborted).toBe(true);
 for (let i = 0; i < 5; i++) await Promise.resolve();
 // A still holds the lock: B waits for it.
 expect(started).toEqual(["A"]);
 firstHeld.resolve();
 await b2.promise;
 expect(started).toEqual(["A", "B2"]);
 expect(runs.isCurrent(last)).toBe(true);
});

test("a run belongs to its account: another account or none makes it stale; a replaced run's failure isn't reported", async () => {
 const runs = new OwnerRuns();
 expect(runs.staleFor("acct-A")).toBe(false);
 const failures: unknown[] = [];
 const reported = Promise.withResolvers<void>();
 const failing = Promise.withResolvers<void>();
 runs.begin("acct-A", () => failing.promise, error => failures.push(error));
 expect(runs.staleFor("acct-A")).toBe(false);
 expect(runs.staleFor("acct-B")).toBe(true);
 expect(runs.staleFor(undefined)).toBe(true);
 await Promise.resolve();
 runs.begin("acct-A", () => Promise.reject(new Error("now")), error => { failures.push(error); reported.resolve(); });
 failing.reject(new Error("old"));
 await reported.promise;
 expect(failures.map(e => (e as Error).message)).toEqual(["now"]);
 runs.stop();
 expect(runs.staleFor("acct-B")).toBe(false);
});
