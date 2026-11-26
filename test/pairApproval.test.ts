import { afterEach, expect, jest, test } from "bun:test";
import { initWebAccess, TYPING_PAUSE_MS, type SheetClock } from "../src/webAccess";
import {
 approveLabel, expiresText, failureLine, keyListedAs, keyNote, nameList, PAIR_ENDED, pairNotice, platformLine, probeReason, resultLead, retryLabel, rowStatusText,
} from "../src/pairApprovalModel";
import { OFFERED_RECHECK_MS } from "../src/webAccessModel";
import { FakeDocument, type FakeElement } from "./fakeDom";

test("the sheet's words: platform, time left, reasons, the approve count, results and retries", () => {
 expect(pairNotice({ deviceName: "MacBook Air" })).toBe("MacBook Air wants to pair with your machines.");
 expect(pairNotice({ deviceName: " " })).toBe("A new device wants to pair with your machines.");
 expect(platformLine("macos")).toBe("HerdrUp Desktop on macOS");
 expect(platformLine("ios")).toBe("HerdrUp on iPhone");
 expect(expiresText(552_000)).toBe("Expires in 9:12");
 expect(expiresText(-5)).toBe("Expires in 0:00");
 expect(probeReason("unreachable", "this Mac")).toBe("Can't reach it from this Mac right now");
 expect(probeReason("needs_update", "this Mac", "0.9.2")).toBe("Needs a herdr update (herdr 0.9.2)");
 expect(probeReason("needs_key", "this Mac")).toBe("Needs a key file");
 expect(probeReason("needs_pin", "this Mac")).toBe("Open it once on this Mac first");
 expect(probeReason("unsendable", "this Mac", "", "can't be sent to the new device: machine user or host has an @ or a space"))
  .toBe("Can't be sent to the new device: machine user or host has an @ or a space");
 expect([approveLabel(0), approveLabel(1), approveLabel(3)]).toEqual(["Approve", "Approve 1 machine", "Approve 3 machines"]);
 expect([rowStatusText("already"), rowStatusText("failed", "timed out")]).toEqual(["Already added", "Failed: timed out"]);
 expect(nameList(["a", "b", "c"])).toBe("a, b and c");
 const rows = [{ id: "1", label: "fleet-hel1", status: "added" }, { id: "2", label: "studio", status: "already" }, { id: "3", label: "build-box", status: "failed", reason: "timed out", retryable: true }];
 expect(resultLead("MacBook Air", rows)).toBe("MacBook Air can open fleet-hel1 and studio with its own key.");
 expect(failureLine(rows)).toBe("build-box didn't answer. Try again from here later, or use herdr pair there.");
 // A failure a retry can't mend is sent to herdr pair alone.
 const stuck = { id: "4", label: "old-pi", status: "failed", reason: "needs a herdr update" };
 expect(failureLine([...rows, stuck])).toBe("build-box didn't answer. Try again from here later, or use herdr pair there. old-pi: needs a herdr update. Use herdr pair there.");
 expect(failureLine([stuck, { ...stuck, id: "5", label: "pi-2" }])).toBe("old-pi and pi-2 couldn't be added from here. Use herdr pair on each.");
 expect(retryLabel(["build-box"])).toBe("Try build-box again");
 expect(retryLabel(["a", "b"])).toBe("Try 2 machines again");
 // Each row says the label herdr stored (its reply's), not the one sent; the note says how to remove it.
 expect(keyListedAs("MacBook Air via Mac Studio")).toBe("Listed as “MacBook Air via Mac Studio”");
 expect(keyNote("MacBook Air", [{ id: "1", label: "x", status: "added", keyLabel: "MacBook Air via Mac Studio" }]))
  .toBe("Remove a key with herdr pair --revoke and the name it's listed as.");
});

// ---- The sheet in the shared fake document (fakeDom.ts) ----

const G = globalThis as { document?: unknown; devicePixelRatio?: unknown; mygo?: unknown; ResizeObserver?: unknown };
const saved = { document: G.document, devicePixelRatio: G.devicePixelRatio, mygo: G.mygo, ResizeObserver: G.ResizeObserver };
// A sheet's test runs on the runner's fake timers (the poll), cleared after it.
let fakeTimers = false;
afterEach(() => {
 G.document = saved.document; G.devicePixelRatio = saved.devicePixelRatio; G.mygo = saved.mygo; G.ResizeObserver = saved.ResizeObserver;
 if (fakeTimers) { jest.clearAllTimers(); jest.useRealTimers(); fakeTimers = false; }
});

function handClock(start: number) {
 let now = start;
 const queued: { at: number; f: () => void }[] = [];
 const clock: SheetClock & { queued: typeof queued; to(t: number): void } = {
  queued,
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
 if (!reached()) throw new Error(`the sheet never showed ${what}`);
}

const MACHINES = [
 { id: "s", label: "studio", available: true }, { id: "f", label: "fleet-hel1", available: true },
 { id: "l", label: "laptop", available: true }, { id: "o", label: "old-pi", available: true },
 { id: "b", label: "build-box", available: false, unavailable: "needs_key" },
];

/** A signed-in window with the composer where MacBook Air asks to pair. The bridge's calls are
 *  recorded; probes and adds wait for the test (probe(), add()); emit() sends a Go event. The
 *  service lists MacBook Air's request (while listing.pair) and then browsers, or browsers first;
 *  health holds its next answers to "which approvals do you offer?" (both, once they run out). */
function pairingWindow({ browsers = [] as { id: string }[], browsersFirst = false } = {}) {
 jest.useFakeTimers(); fakeTimers = true;
 const doc = new FakeDocument();
 const on = new Map<string, (payload: unknown) => void>();
 const calls: unknown[][] = [];
 const probes = new Map<string, (p: unknown) => void>();
 const adds: ((r: unknown) => void)[] = [];
 const checks: unknown[] = [];
 const listing = { pair: true };
 const health: unknown[] = [];
 // A Retry (or Add) the bridge rejects, with this message.
 const refusals: string[] = [];
 G.document = doc;
 G.devicePixelRatio = 1;
 G.ResizeObserver = class { observe() {} };
 G.mygo = {
  on: (name: string, l: (payload: unknown) => void) => { on.set(name, l); return () => on.delete(name); },
  call: async (method: string, ...args: unknown[]) => {
   calls.push([method, ...args]);
   switch (method) {
    case "Desk.AccountState": return { signedIn: true };
    case "Desk.ApprovalsOffered": {
     const answer = health.shift() ?? { browsers: true, pairs: true };
     if (answer instanceof Error) throw answer;
     return answer;
    }
    case "Desk.ApprovalRequests": {
     const pair = listing.pair ? [{ kind: "pair", pair: { id: "p1", deviceName: "MacBook Air", platform: "macos", claimed: "no", expiresIn: 600 } }] : [];
     const listed = browsers.map(b => ({ kind: "browser", browser: b }));
     return browsersFirst ? [...listed, ...pair] : [...pair, ...listed];
    }
    case "Desk.WebAccessLengths": return [{ id: "1d", seconds: 86_400 }];
    case "Desk.WebAccessMachines": return MACHINES;
    case "Desk.PairApproveProbe": { const { promise, resolve } = Promise.withResolvers(); probes.set(args[1] as string, resolve); return promise; }
    case "Desk.PairApproveStart": return undefined;
    case "Desk.PairApproveCheckCode": return checks.shift();
    case "Desk.PairApproveAdd": case "Desk.PairApproveRetry": {
     if (refusals.length) throw new Error(refusals.shift());
     const { promise, resolve } = Promise.withResolvers(); adds.push(resolve); return promise;
    }
    case "Desk.PairApproveDeny": return undefined;
    default: return Promise.withResolvers<never>().promise;
   }
  },
 };
 const composer = doc.createElement("textarea");
 doc.body.append(composer);
 const clock = handClock(0);
 const dialog = () => doc.body.children.find(c => c.tagName === "dialog");
 const nodes = () => dialog()?.all() ?? [];
 const byClass = (cls: string) => nodes().find(n => n.className.split(" ").includes(cls));
 const notices = () => doc.getElementById("notices")?.children.filter(n => n.className === "web-access-notice") ?? [];
 const row = (label: string) => nodes().find(n => n.tagName === "label" && n.className.includes("pair-approve-machine") && n.text().includes(label))!;
 const box = (label: string) => row(label).children[0]!;
 return {
  doc, composer, clock, dialog, calls, probes, adds, checks, refusals, notices, listing, health,
  sent: (method: string) => calls.filter(c => c[0] === method).map(c => c.slice(1)),
  start: () => { initWebAccess(clock); doc.dispatchEvent(new Event("visibilitychange")); },
  emit: (name: string, payload: unknown) => on.get(name)?.(payload),
  ready: () => on.get("pair-approve:update")?.({ id: "p1", state: "ready" }),
  title: () => nodes().find(n => n.tagName === "h2")?.textContent,
  lead: () => byClass("web-access-lead")?.textContent,
  status: () => { const s = byClass("pair-approve-status"); return s && s.shown() ? s.all().filter(n => n.shown()).map(n => n.textContent).join(" ").trim() : undefined; },
  problem: () => { const p = byClass("web-access-problem"); return p?.shown() ? p.textContent : ""; },
  code: () => byClass("web-access-code") as FakeElement | undefined,
  button: (text: string) => nodes().find(n => n.tagName === "button" && n.shown() && n.textContent === text),
  buttons: () => nodes().filter(n => n.tagName === "button" && n.shown()).map(n => n.textContent),
  row, box,
  rowText: (label: string) => row(label).all().filter(n => n.shown()).map(n => n.textContent).filter(Boolean).join(" | "),
  type: (text: string) => { const c = byClass("web-access-code")!; c.value = text; c.dispatchEvent(new Event("input")); },
 };
}

test("a1: while the user types, a quiet notice says the device wants to pair; Review opens the sheet. One list is read for both kinds", async () => {
 const w = pairingWindow();
 w.composer.focus();
 w.doc.dispatchEvent(new Event("keydown"));
 w.start();
 await until("the notice", () => w.notices().length === 1);
 expect(w.notices()[0]!.text()).toBe("MacBook Air wants to pair with your machines.Review");
 expect(w.dialog()).toBeUndefined();
 expect(w.doc.activeElement).toBe(w.composer);
 expect(w.sent("Desk.ApprovalRequests")).toHaveLength(1);
 expect(w.calls.some(c => c[0] === "Desk.WebAccessRequests" || c[0] === "Desk.PairRequests")).toBe(false);
 w.notices()[0]!.children.find(n => n.textContent === "Review")!.click();
 await until("an open sheet", () => w.dialog()?.open === true);
 expect(w.notices()).toHaveLength(0);
 expect(w.title()).toBe("Pair MacBook Air?");
});

test("a1: with nothing taking typing the sheet opens at once, for the first request of either kind in the service's order", async () => {
 const chrome = { id: "r1", browserName: "Chrome", claimed: "no", expiresIn: 600 };
 const w = pairingWindow({ browsers: [chrome] });
 w.start();
 await until("an open sheet", () => w.dialog()?.open === true);
 expect(w.title()).toBe("Pair MacBook Air?");
 expect(w.sent("Desk.PairApproveStart")).toEqual([["p1"]]);
});

test("a1: a browser the service lists before the new device opens first", async () => {
 const w = pairingWindow({ browsers: [{ id: "r1", browserName: "Chrome", claimed: "no", expiresIn: 600 }], browsersFirst: true });
 w.start();
 await until("an open sheet", () => w.dialog()?.open === true);
 expect(w.title()).not.toBe("Pair MacBook Air?");
 expect(w.sent("Desk.PairApproveStart")).toEqual([]);
});

test("a1: a failed refresh of what the service offers keeps its last answer: new devices are still looked for", async () => {
 const w = pairingWindow();
 w.listing.pair = false;
 w.health.push({ browsers: false, pairs: true }, new Error("account service health: 502 Bad Gateway"));
 w.start();
 await until("the first look's end", () => w.sent("Desk.ApprovalRequests").length === 1 && jest.getTimerCount() === 1);
 // Past the recheck the service is asked again; the ask fails, and the list is still read.
 w.clock.to(OFFERED_RECHECK_MS);
 w.listing.pair = true;
 w.doc.dispatchEvent(new Event("visibilitychange"));
 await until("an open sheet", () => w.dialog()?.open === true);
 expect(w.title()).toBe("Pair MacBook Air?");
 expect(w.sent("Desk.ApprovalsOffered")).toHaveLength(2);
});

test("a1: the sheet waits for a pause in typing", async () => {
 const w = pairingWindow();
 w.composer.focus();
 w.start();
 await until("the notice", () => w.notices().length === 1);
 w.clock.to(TYPING_PAUSE_MS);
 await until("an open sheet", () => w.dialog()?.open === true);
});

test("a2 step 1: the device, its platform and the code; three wrong codes deny the request", async () => {
 const w = pairingWindow();
 w.start();
 await until("an open sheet", () => w.dialog()?.open === true);
 expect(w.lead()).toBe("HerdrUp Desktop on macOS wants to add its key to your machines. Enter the code shown on MacBook Air.");
 expect(w.status()).toBe("Waiting for MacBook Air to show its code…");
 expect(w.code()!.disabled).toBe(true);
 expect(w.buttons()).toEqual(["Deny", "Continue"]);
 w.ready();
 expect(w.code()!.disabled).toBe(false);
 expect(w.doc.activeElement).toBe(w.code());
 expect(w.status()).toBe("Step 1 of 2 · Expires in 10:00");
 // The time left follows the clock.
 w.clock.to(48_000);
 expect(w.status()).toBe("Step 1 of 2 · Expires in 9:12");
 expect(w.button("Continue")!.disabled).toBe(true);
 w.type("12a3");
 expect(w.code()!.value).toBe("123");
 w.type("1234");
 expect(w.button("Continue")!.disabled).toBe(false);
 w.checks.push({ ok: false, left: 2, denied: false }, { ok: false, left: 1, denied: false }, { ok: false, left: 0, denied: true });
 w.button("Continue")!.click();
 await until("the wrong code", () => w.problem() === "That code doesn't match MacBook Air's. 2 tries left.");
 expect(w.code()!.value).toBe("");
 w.type("1234"); w.button("Continue")!.click();
 await until("the second wrong code", () => w.problem() === "That code doesn't match MacBook Air's. 1 try left.");
 w.type("1234"); w.button("Continue")!.click();
 await until("the denial", () => w.status() === "Too many wrong codes. The request was denied.");
 expect(w.buttons()).toEqual(["Done"]);
 expect(w.sent("Desk.PairApproveAdd")).toHaveLength(0);
 w.button("Done")!.click();
 expect(w.dialog()).toBeUndefined();
});

/** A sheet past step 1: the code typed and matched. */
async function matched() {
 const w = pairingWindow();
 w.start();
 await until("an open sheet", () => w.dialog()?.open === true);
 w.ready();
 w.type("4821");
 w.checks.push({ ok: true, left: 3, denied: false });
 // No machine is reached before the code matches.
 expect(w.sent("Desk.PairApproveProbe")).toEqual([]);
 w.button("Continue")!.click();
 await until("step 2", () => w.lead() === "Tick the machines that get MacBook Air's key.");
 return w;
}

test("a2 step 2: every machine; the probes fill the rows in as they land, ticking the reachable ones; the rest greyed with the reason", async () => {
 const w = await matched();
 expect(w.status()).toBe("The code matches Expires in 10:00");
 // Probed only once the code matched (matched() checks step 1 probed nothing), the password machine not at all.
 expect(w.sent("Desk.PairApproveProbe")).toEqual([["p1", "s"], ["p1", "f"], ["p1", "l"], ["p1", "o"]]);
 expect(w.rowText("studio")).toBe("studio | Checking…");
 expect(w.rowText("build-box")).toBe("build-box | Needs a key file");
 expect(w.box("build-box").disabled).toBe(true);
 expect(w.button("Approve")!.disabled).toBe(true);
 w.probes.get("s")!({ state: "ready" });
 await until("studio ticked", () => w.box("studio").checked);
 expect(w.button("Approve 1 machine")!.disabled).toBe(false);
 w.probes.get("l")!({ state: "unreachable" });
 w.probes.get("o")!({ state: "needs_update", version: "0.9.2" });
 await until("old-pi's reason", () => w.rowText("old-pi") === "old-pi | Needs a herdr update (herdr 0.9.2)");
 expect(w.rowText("laptop")).toBe("laptop | Can't reach it from this computer right now");
 expect([w.box("laptop").checked, w.box("laptop").disabled]).toEqual([false, true]);
 // The user unticks studio: a probe that lands later ticks fleet-hel1, studio stays as the user left it.
 w.box("studio").click();
 expect(w.button("Approve")!.disabled).toBe(true);
 w.probes.get("f")!({ state: "ready" });
 await until("fleet ticked", () => w.box("fleet-hel1").checked);
 expect(w.box("studio").checked).toBe(false);
 expect(w.button("Approve 1 machine")).toBeDefined();
 w.box("studio").click();
 expect(w.button("Approve 2 machines")).toBeDefined();
 expect(w.dialog()!.text()).toContain("Approving adds MacBook Air's key to the machines you tick, with a herdr command on each. Remove it with herdr pair --revoke.");
});

test("a3 and a4: keys are added one machine at a time with a spinner per row; a failure offers Try ‹machine› again", async () => {
 const w = await matched();
 for (const id of ["s", "f"]) w.probes.get(id)!({ state: "ready" });
 w.probes.get("l")!({ state: "unreachable" });
 w.probes.get("o")!({ state: "ready" });
 await until("three ticked", () => w.button("Approve 3 machines") !== undefined);
 w.button("Approve 3 machines")!.click();
 await until("adding", () => w.button("Adding keys…")?.disabled === true);
 expect(w.lead()).toBe("Adding MacBook Air's key, one machine at a time.");
 expect(w.sent("Desk.PairApproveAdd")).toEqual([["p1", ["s", "f", "o"]]]);
 expect(w.button("Deny")!.disabled).toBe(true);
 expect(w.rowText("studio")).toBe("studio | Waiting");
 w.emit("pair-approve:progress", { id: "p1", machineId: "s", status: "adding" });
 expect(w.row("studio").all().some(n => n.className === "ring-spinner")).toBe(true);
 expect(w.rowText("studio")).toBe("studio | Adding…");
 w.emit("pair-approve:progress", { id: "p1", machineId: "s", status: "added", keyLabel: "MacBook Air approved on Mac Studio" });
 expect(w.rowText("studio")).toBe("studio | Listed as “MacBook Air approved on Mac Studio” | Added");
 // laptop was never ticked: its reason stays, no status.
 expect(w.rowText("laptop")).toBe("laptop | Can't reach it from this computer right now");
 w.adds.shift()!({ sent: true, machines: [
  { id: "s", label: "studio", status: "added", keyLabel: "MacBook Air approved on Mac Studio" },
  { id: "f", label: "fleet-hel1", status: "failed", reason: "timed out", retryable: true },
  { id: "o", label: "old-pi", status: "already", keyLabel: "MacBook Air approved on Mac Studio" },
 ] });
 await until("the results", () => w.lead() === "MacBook Air can open studio and old-pi with its own key.");
 expect(w.rowText("fleet-hel1")).toBe("fleet-hel1 | Failed: timed out");
 expect(w.row("fleet-hel1").all().some(n => n.className === "pair-approve-dot")).toBe(true);
 expect(w.rowText("old-pi")).toBe("old-pi | Listed as “MacBook Air approved on Mac Studio” | Already added");
 expect(w.problem()).toBe("fleet-hel1 didn't answer. Try again from here later, or use herdr pair there.");
 expect(w.dialog()!.text()).toContain("Remove a key with herdr pair --revoke and the name it's listed as.");
 expect(w.buttons()).toEqual(["Try fleet-hel1 again", "Done"]);
 // a4: Try again re-adds that machine only.
 w.button("Try fleet-hel1 again")!.click();
 await until("retrying", () => w.sent("Desk.PairApproveRetry").length === 1);
 expect(w.sent("Desk.PairApproveRetry")).toEqual([["p1", ["f"]]]);
 // The rows stay as last confirmed until Go says otherwise.
 expect(w.rowText("fleet-hel1")).toBe("fleet-hel1 | Failed: timed out");
 w.adds.shift()!({ sent: true, machines: [
  { id: "s", label: "studio", status: "added" }, { id: "f", label: "fleet-hel1", status: "added" }, { id: "o", label: "old-pi", status: "already" },
 ] });
 await until("all added", () => w.lead() === "MacBook Air can open studio, fleet-hel1 and old-pi with its own key.");
 expect(w.buttons()).toEqual(["Done"]);
 expect(w.problem()).toBe("");
 w.button("Done")!.click();
 expect(w.dialog()).toBeUndefined();
});

/** A sheet showing a result where fleet-hel1 failed and studio got the key. */
async function failedOne() {
 const w = await matched();
 for (const id of ["s", "f"]) w.probes.get(id)!({ state: "ready" });
 await until("two ticked", () => w.button("Approve 2 machines") !== undefined);
 w.button("Approve 2 machines")!.click();
 await until("adding", () => w.adds.length === 1);
 w.adds.shift()!({ sent: true, machines: [
  { id: "s", label: "studio", status: "added", keyLabel: "MacBook Air approved on Mac Studio" },
  { id: "f", label: "fleet-hel1", status: "failed", reason: "timed out", retryable: true },
 ] });
 await until("the results", () => w.button("Try fleet-hel1 again") !== undefined);
 return w;
}

test("a machine without a pin here, or one the list can't carry, is greyed with the reason", async () => {
 const w = await matched();
 w.probes.get("l")!({ state: "needs_pin" });
 w.probes.get("o")!({ state: "unsendable", reason: "can't be sent to the new device: machine user or host has an @ or a space" });
 await until("old-pi's reason", () => w.rowText("old-pi") === "old-pi | Can't be sent to the new device: machine user or host has an @ or a space");
 expect(w.rowText("laptop")).toBe("laptop | Open it once on this computer first");
 expect([w.box("laptop").disabled, w.box("old-pi").disabled]).toEqual([true, true]);
});

test("a4: a Try again the bridge refuses keeps the rows as last confirmed and says why", async () => {
 const w = await failedOne();
 w.refusals.push("The request isn't approved any more.");
 w.button("Try fleet-hel1 again")!.click();
 await until("the refusal", () => w.problem() === "The request isn't approved any more.");
 expect(w.rowText("fleet-hel1")).toBe("fleet-hel1 | Failed: timed out");
 expect(w.rowText("studio")).toBe("studio | Listed as “MacBook Air approved on Mac Studio” | Added");
 expect(w.lead()).toBe("MacBook Air can open studio with its own key.");
 expect(w.buttons()).toEqual(["Try fleet-hel1 again", "Done"]);
 expect(w.button("Try fleet-hel1 again")!.disabled).toBe(false);
});

test("a4: once retries are over, Try again stays off and only the reason is said", async () => {
 const w = await failedOne();
 w.button("Try fleet-hel1 again")!.click();
 await until("retrying", () => w.adds.length === 1);
 const late = "Too late to try again: retries end 10 minutes after approving. Use herdr pair there.";
 w.adds.shift()!({ sent: false, ended: true, problem: late, machines: [
  { id: "s", label: "studio", status: "added", keyLabel: "MacBook Air approved on Mac Studio" },
  { id: "f", label: "fleet-hel1", status: "failed", reason: "timed out", retryable: true },
 ] });
 await until("the reason", () => w.problem() === late);
 expect(w.button("Try fleet-hel1 again")!.disabled).toBe(true);
 expect(w.button("Done")!.disabled).toBe(false);
});

test("only failures a retry may mend get Try again; the rest are sent to herdr pair", async () => {
 const w = await matched();
 for (const id of ["s", "f", "o"]) w.probes.get(id)!({ state: "ready" });
 await until("three ticked", () => w.button("Approve 3 machines") !== undefined);
 w.button("Approve 3 machines")!.click();
 await until("adding", () => w.adds.length === 1);
 w.adds.shift()!({ sent: true, machines: [
  { id: "s", label: "studio", status: "added" },
  { id: "f", label: "fleet-hel1", status: "failed", reason: "timed out", retryable: true },
  { id: "o", label: "old-pi", status: "failed", reason: "needs a herdr update" },
 ] });
 await until("the results", () => w.button("Try fleet-hel1 again") !== undefined);
 expect(w.buttons()).toEqual(["Try fleet-hel1 again", "Done"]);
 expect(w.problem()).toBe("fleet-hel1 didn't answer. Try again from here later, or use herdr pair there. old-pi: needs a herdr update. Use herdr pair there.");
 w.button("Try fleet-hel1 again")!.click();
 await until("retrying", () => w.adds.length === 1);
 expect(w.sent("Desk.PairApproveRetry")).toEqual([["p1", ["f"]]]);
 w.adds.shift()!({ sent: true, machines: [
  { id: "s", label: "studio", status: "added" },
  { id: "f", label: "fleet-hel1", status: "added" },
  { id: "o", label: "old-pi", status: "failed", reason: "needs a herdr update" },
 ] });
 await until("no retry left", () => w.buttons().join() === "Done");
 expect(w.problem()).toBe("old-pi: needs a herdr update. Use herdr pair there.");
});

test("while an earlier send's outcome is unknown the ticks are frozen: Try again sends the same list", async () => {
 const w = await matched();
 for (const id of ["s", "f"]) w.probes.get(id)!({ state: "ready" });
 await until("two ticked", () => w.button("Approve 2 machines") !== undefined);
 w.button("Approve 2 machines")!.click();
 await until("adding", () => w.adds.length === 1);
 w.adds.shift()!({ sent: false, unsure: true, problem: "timed out", machines: [] });
 await until("unsure", () => w.button("Try again") !== undefined);
 expect(w.problem()).toBe("Couldn't tell whether MacBook Air got the list (timed out). Try again sends the same list.");
 expect([w.box("studio").disabled, w.box("fleet-hel1").disabled, w.box("studio").checked]).toEqual([true, true, true]);
 // A probe landing now doesn't tick another machine.
 w.probes.get("l")!({ state: "ready" });
 await until("laptop checked", () => w.rowText("laptop") === "laptop");
 expect([w.box("laptop").checked, w.box("laptop").disabled]).toEqual([false, true]);
 w.button("Try again")!.click();
 await until("sent again", () => w.sent("Desk.PairApproveAdd").length === 2);
 expect(w.sent("Desk.PairApproveAdd")[1]).toEqual(["p1", ["s", "f"]]);
});

test("a5: the request ends while the sheet is open: This request ended, Done", async () => {
 const w = await matched();
 w.emit("pair-approve:update", { id: "p1", state: "ended", problem: PAIR_ENDED });
 expect(w.status()).toBe(PAIR_ENDED);
 expect(w.buttons()).toEqual(["Done"]);
 expect(w.row("studio").shown()).toBe(false);
 w.button("Done")!.click();
 expect(w.dialog()).toBeUndefined();
});

test("a5: the time running out ends the request on the sheet too", async () => {
 const w = await matched();
 w.clock.to(599_000);
 expect(w.status()).toBe("The code matches Expires in 0:01");
 w.clock.to(600_000);
 expect(w.status()).toBe(PAIR_ENDED);
 expect(w.buttons()).toEqual(["Done"]);
});

test("an approval that finds the request over says it ended", async () => {
 const w = await matched();
 w.probes.get("s")!({ state: "ready" });
 await until("ticked", () => w.button("Approve 1 machine") !== undefined);
 w.button("Approve 1 machine")!.click();
 await until("adding", () => w.adds.length === 1);
 w.adds.shift()!({ sent: false, ended: true, problem: PAIR_ENDED, machines: [] });
 await until("ended", () => w.status() === PAIR_ENDED);
 expect(w.buttons()).toEqual(["Done"]);
});

test("Deny tells the service and closes the sheet", async () => {
 const w = pairingWindow();
 w.start();
 await until("an open sheet", () => w.dialog()?.open === true);
 w.button("Deny")!.click();
 await until("closed", () => w.dialog() === undefined);
 expect(w.sent("Desk.PairApproveDeny")).toEqual([["p1"]]);
});
