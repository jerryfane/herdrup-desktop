import { afterEach, expect, jest, test } from "bun:test";
import { initWebAccess, type SheetClock } from "../src/webAccess";
import { FakeDocument } from "./fakeDom";

const G = globalThis as { document?: unknown; devicePixelRatio?: unknown; mygo?: unknown };
const saved = { document: G.document, devicePixelRatio: G.devicePixelRatio, mygo: G.mygo };
afterEach(() => { G.document = saved.document; G.devicePixelRatio = saved.devicePixelRatio; G.mygo = saved.mygo; });

function handClock(start: number) {
 let now = start;
 const queued: { at: number; f: () => void }[] = [];
 const clock: SheetClock & { to(t: number): void } = {
  now: () => now,
  after(ms, f) {
   const q = { at: now + ms, f }; queued.push(q);
   return () => { const i = queued.indexOf(q); if (i >= 0) queued.splice(i, 1); };
  },
  to(t) {
   now = t;
   for (const q of queued.filter(q => q.at <= now)) { queued.splice(queued.indexOf(q), 1); q.f(); }
  },
 };
 return clock;
}

async function until(what: string, reached: () => boolean): Promise<void> {
 for (let i = 0; i < 1000 && !reached(); i++) { const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); await promise; }
 if (!reached()) throw new Error(`never reached ${what}`);
}

test("initWebAccess backs off on 429 and honors cooldown across visibilitychange and own pairing", async () => {
 jest.useFakeTimers();
 const doc = new FakeDocument();
 const on = new Map<string, (payload: unknown) => void>();
 let approvalCalls = 0;
 let failWith: Error | null = new Error("account service: 429 too_many_requests");
 let ownPairing = false;
 G.document = doc;
 G.devicePixelRatio = 1;
 G.mygo = {
  on: (name: string, l: (payload: unknown) => void) => { on.set(name, l); return () => on.delete(name); },
  call: async (method: string) => {
   switch (method) {
    case "Desk.AccountState": return { signedIn: true };
    case "Desk.ApprovalsOffered": return { browsers: true, pairs: true };
    case "Desk.ApprovalRequests":
     approvalCalls++;
     if (failWith) throw failWith;
     return [];
    default: return Promise.withResolvers<never>().promise;
   }
  },
 };
 const clock = handClock(1_000);
 try {
  (initWebAccess as (c?: SheetClock, paused?: () => boolean) => void)(clock, () => ownPairing);
  // Trigger initial look via visibilitychange -> hits 429 -> backs off 16 s.
  doc.dispatchEvent(new Event("visibilitychange"));
  await until("first 429 poll", () => approvalCalls === 1 && jest.getTimerCount() === 1);
  // Returning to the window during cooldown (5 s later) must NOT fire Desk.ApprovalRequests early.
  clock.to(1_000 + 5_000);
  doc.dispatchEvent(new Event("visibilitychange"));
  await until("microtasks settle", () => true);
  expect(approvalCalls).toBe(1);
  // After 8 s (normal interval), backoff is still active so no second call yet.
  clock.to(1_000 + 8_000);
  jest.advanceTimersByTime(8_000);
  expect(approvalCalls).toBe(1);
  // After full 16 s cooldown -> second 429 -> backs off 32 s.
  clock.to(1_000 + 16_000);
  jest.advanceTimersByTime(8_000);
  await until("second 429 poll", () => approvalCalls === 2 && jest.getTimerCount() === 1);
  // 16 s later is still inside the 32 s cooldown: neither timer nor visibilitychange polls yet.
  clock.to(1_000 + 32_000);
  jest.advanceTimersByTime(16_000 - 1);
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(approvalCalls).toBe(2);
  // Once the 32 s cooldown finishes and the server recovers, failures reset and normal polling resumes.
  failWith = null;
  clock.to(1_000 + 48_000);
  jest.advanceTimersByTime(16_000 + 1);
  await until("recovered poll", () => approvalCalls === 3 && jest.getTimerCount() === 1);
  // While this computer is waiting on its own pair request, approval list polling pauses.
  ownPairing = true;
  jest.advanceTimersByTime(8_000);
  await until("paused poll tick", () => jest.getTimerCount() === 1);
  expect(approvalCalls).toBe(3);
  // When own pairing ends, polling resumes on the next tick.
  ownPairing = false;
  jest.advanceTimersByTime(8_000);
  await until("resumed poll after pairing", () => approvalCalls === 4);
 } finally {
  jest.clearAllTimers();
  jest.useRealTimers();
 }
});

test("sync-only account:changed preserves 429 cooldown and failure count while sign-out resets them", async () => {
 jest.useFakeTimers();
 const doc = new FakeDocument();
 const on = new Map<string, (payload: unknown) => void>();
 let approvalCalls = 0;
 let signedIn = true;
 let displayHint = "owner@example.com";
 G.document = doc;
 G.devicePixelRatio = 1;
 G.mygo = {
  on: (name: string, l: (payload: unknown) => void) => { on.set(name, l); return () => on.delete(name); },
  call: async (method: string) => {
   switch (method) {
    case "Desk.AccountState": return { signedIn, displayHint, persistent: true };
    case "Desk.ApprovalsOffered": return { browsers: true, pairs: true };
    case "Desk.ApprovalRequests":
     approvalCalls++;
     throw new Error("account service: 429 too_many_requests");
    default: return Promise.withResolvers<never>().promise;
   }
  },
 };
 const clock = handClock(0);
 try {
  initWebAccess(clock);
  doc.dispatchEvent(new Event("visibilitychange"));
  await until("first 429", () => approvalCalls === 1 && jest.getTimerCount() === 1);
  // Sync-status-only account:changed for the SAME session must NOT clear the 16 s cooldown.
  on.get("account:changed")?.({ signedIn: true, displayHint, persistent: true, syncFailed: true });
  clock.to(5_000);
  doc.dispatchEvent(new Event("visibilitychange"));
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
  expect(approvalCalls).toBe(1);
  // Next failure after 16 s must advance backoff to 32 s (not restart at 16 s).
  clock.to(16_000);
  jest.advanceTimersByTime(16_000);
  await until("second 429", () => approvalCalls === 2 && jest.getTimerCount() === 1);
  clock.to(32_000);
  jest.advanceTimersByTime(16_000);
  expect(approvalCalls).toBe(2);
  // Real sign-out then sign-in resets cooldown so visibilitychange polls immediately.
  signedIn = false;
  on.get("account:changed")?.({ signedIn: false, displayHint: "", persistent: true });
  signedIn = true;
  on.get("account:changed")?.({ signedIn: true, displayHint, persistent: true });
  doc.dispatchEvent(new Event("visibilitychange"));
  await until("poll after session change", () => approvalCalls === 3);
 } finally {
  jest.clearAllTimers();
  jest.useRealTimers();
 }
});
