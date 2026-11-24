import { afterEach, expect, jest, test } from "bun:test";
import { choiceRows, followPresses, initWebAccess, takesTyping, TYPING_PAUSE_MS, type SheetClock } from "../src/webAccess";
import { ACCESS_CHOICES, askOffered, canApprove, choiceLabel, CodePress, codeInput, codeSlots, DRAG_PX, lengthLabel, machinesNote, machinesSummary, nextRequest, OFFERED_RECHECK_MS,
 resultLines, slotSelection, timeSummary, wrongCode } from "../src/webAccessModel";
import { FakeDocument, FakeElement, Listened } from "./fakeDom";

const req = (id: string, claimed = "no", expiresIn = 600) => ({ id, browserName: "Chrome on macOS", claimed, expiresIn });

test("the sheet opens for the oldest request nobody is approving and the user hasn't closed", () => {
 expect(nextRequest([req("a", "other"), req("b"), req("c")], new Set())?.id).toBe("b");
 expect(nextRequest([req("b"), req("c")], new Set(["b"]))?.id).toBe("c");
 expect(nextRequest([req("a", "you"), req("b", "no", 0)], new Set())).toBeNull();
});

test("the code is four digits and Approve needs a code and a machine", () => {
 expect(codeInput(" 4 7-2a9 1")).toBe("4729");
 expect(canApprove("4729", 1)).toBe(true);
 expect(canApprove("472", 1)).toBe(false);
 expect(canApprove("4729", 0)).toBe(false);
});

test("the code boxes follow the one input's caret and selection, and a click on a box takes its digit", () => {
 const off = { filled: true, selected: false, active: false };
 // 1234 with the caret at the end: the last box is the ringed one, so focus shows on a full code.
 expect(codeSlots(4, 4, 4)).toEqual([off, off, off, { ...off, active: true }]);
 // A click on the second box of 1234 selects its digit: Backspace or Delete leaves 134.
 expect(slotSelection(1, 4)).toEqual([1, 2]);
 expect(codeSlots(4, 1, 2)).toEqual([off, { filled: true, selected: true, active: true }, off, off]);
 // A click past the digits puts the caret after the last one, ringing the box the next one fills.
 expect(slotSelection(3, 2)).toEqual([2, 2]);
 expect(codeSlots(2, 2, 2).map(s => [s.filled, s.active])).toEqual([[true, false], [true, false], [false, true], [false, false]]);
});

test("only a plain click takes a box's digit; a press that moved, even back to its start, a double click or a shift-click doesn't", () => {
 const click = { detail: 1, shiftKey: false };
 // A press at x 200 (the third box), moved through each point, then released.
 const plain = (moves: readonly (readonly [number, number])[], release = click) => {
  const press = new CodePress(200, 40);
  for (const [x, y] of moves) press.move(x, y);
  return press.plainClick(release);
 };
 expect(plain([])).toBe(true);
 expect(plain([[202, 41], [199, 39]])).toBe(true);
 expect(plain([[200 + DRAG_PX, 40]])).toBe(true);
 expect(plain([[200 + DRAG_PX + 1, 40]])).toBe(false);
 // From the third box across 12 and back to where it started before release (#362): a drag.
 expect(plain([[150, 40], [60, 40], [130, 40], [200, 40]])).toBe(false);
 expect(plain([], { detail: 2, shiftKey: false })).toBe(false);
 expect(plain([], { detail: 1, shiftKey: true })).toBe(false);
});

test("an approval with no machine granted leaves the request open and says why", () => {
 const none = resultLines({ granted: [], skipped: [{ label: "nas", reason: "relay_not_allowed" }], failed: [] });
 expect(none.done).toBe(false);
 expect(none.lines).toEqual(["nas uses a relay the web app can't reach.", "The browser isn't approved yet. Choose another machine, or Deny."]);
 const some = resultLines({ granted: ["dev2306"], skipped: [], failed: [{ label: "pi", reason: "timeout" }] });
 expect(some).toEqual({ done: true, unsure: false, lines: ["Approved on dev2306.", "pi: timeout"] });
});

test("a lost answer is neither approved nor refused", () => {
 const r = resultLines({ granted: ["dev2306"], skipped: [], failed: [], unsure: true, problem: "503" });
 expect(r.done).toBe(false);
 expect(r.unsure).toBe(true);
 expect(r.lines[0]).toBe("Couldn't tell whether the browser was approved (503).");
});

test("wrong codes show the computer's count, and a lockout whose denial failed says Deny again", () => {
 expect(wrongCode({ left: 2, denied: false })).toBe("That code doesn't match the browser's. 2 tries left.");
 expect(wrongCode({ left: 1, denied: false })).toBe("That code doesn't match the browser's. 1 try left.");
 expect(wrongCode({ left: 0, denied: true })).toBe("Too many wrong codes. The request was denied.");
 expect(wrongCode({ left: 0, denied: false, problem: "account service: 503" })).toContain("Deny to try again");
});

test("a 'not offered' answer is asked again later; 'offered' holds", () => {
 expect(askOffered(null, 0)).toBe(true);
 expect(askOffered({ offered: false, at: 1000 }, 1000 + OFFERED_RECHECK_MS - 1)).toBe(false);
 expect(askOffered({ offered: false, at: 1000 }, 1000 + OFFERED_RECHECK_MS)).toBe(true);
 expect(askOffered({ offered: true, at: 1000 }, 1000 + 10 * OFFERED_RECHECK_MS)).toBe(false);
});

test("the sheet's rows, closed, say the choice: ticked machines by name, and access", () => {
 const ms = ["hetzner", "mars-mini", "nas", "pi", "box"].map((label, i) => ({ id: String(i), label }));
 expect(machinesSummary(ms, new Set(["0", "1"]))).toBe("hetzner, mars-mini");
 expect(machinesSummary(ms, new Set(["0", "1", "2"]))).toBe("hetzner, mars-mini, nas");
 expect(machinesSummary(ms, new Set(["0", "1", "2", "3", "4"]))).toBe("hetzner, mars-mini and 3 more");
 expect(machinesSummary(ms, new Set())).toBe("None ticked");
 expect(machinesSummary([], new Set())).toBe("None yet");
 expect(choiceLabel(ACCESS_CHOICES, "terminal")).toBe("Chat and terminal");
 expect(choiceLabel(ACCESS_CHOICES, "chat")).toBe("Chat only");
});

test("For says the length in whole days and the day it ends; grants that end on two days say both", () => {
 const now = Date.UTC(2026, 10, 23, 12);
 const day = (d: number) => new Date(now + d * 86_400_000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
 expect(timeSummary(7 * 86_400, [now + 7 * 86_400_000])).toBe(`7 days, until ${day(7)}`);
 expect(timeSummary(86_400, [now + 86_400_000])).toBe(`1 day, until ${day(1)}`);
 expect(timeSummary(86_400, [now + 86_400_000, now + 86_400_000 + 60_000])).toBe(`1 day, until ${day(1)}`);
 expect(timeSummary(86_400, [now + 2 * 86_400_000, now + 86_400_000])).toBe(`1 day, until ${day(1)} or ${day(2)}`);
 expect(timeSummary(30 * 86_400, [])).toBe("30 days");
 expect(lengthLabel(30 * 86_400)).toBe("30 days");
});

// ---- The rows, the code field and the sheet run in the shared fake document (fakeDom.ts) ----

const G = globalThis as { document?: unknown; devicePixelRatio?: unknown; mygo?: unknown; window?: unknown };
const saved = { document: G.document, devicePixelRatio: G.devicePixelRatio, mygo: G.mygo, window: G.window };
afterEach(() => { G.document = saved.document; G.devicePixelRatio = saved.devicePixelRatio; G.mygo = saved.mygo; G.window = saved.window; });

/** A clock the test moves by hand: after() queues a call, to() moves the time and runs what's due. */
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

function drawRows(clock: SheetClock) {
 const doc = new FakeDocument();
 G.document = doc;
 // The rows' chevron glyph asks the app for an image; here that answer never comes.
 G.devicePixelRatio = 1;
 G.mygo = { call: () => new Promise(() => {}) };
 const rows = choiceRows(doc.createElement("div") as unknown as HTMLElement, false, [{ id: "1d", seconds: 86_400 }, { id: "30d", seconds: 30 * 86_400 }], clock);
 const all = (rows.rows as unknown as FakeElement).all();
 const value = (key: string) => all.find(n => n.tagName === "button" && n.children[0]?.textContent === key)!.children[1]!.textContent;
 return { rows, all, value };
}

test("the rows repaint their own choice and the terminal warning: shown with Access closed, not with Chat only", () => {
 const clock = handClock(Date.UTC(2026, 10, 23, 12));
 const { rows, all, value } = drawRows(clock);
 rows.showMachines("hetzner");
 const warning = all.find(n => n.className === "web-access-warning")!;
 const access = all.find(n => n.tagName === "button" && n.children[0]?.textContent === "Access")!;
 const pick = (v: string) => { const radio = all.find(n => n.type === "radio" && n.value === v)!; radio.checked = true; radio.onchange!(); };
 expect(rows.choice.length).toBe("30d");
 expect(value("Machines")).toBe("hetzner");
 expect(value("For")).toStartWith("30 days, until ");
 pick("1d");
 expect(rows.choice.length).toBe("1d");
 expect(value("For")).toStartWith("1 day, until ");
 expect(clock.queued).toHaveLength(1);
 access.onclick!();
 expect(access.getAttribute("aria-expanded")).toBe("false");
 expect(warning.shown()).toBe(true);
 pick("chat");
 expect(rows.choice.scope).toBe("chat");
 expect(value("Access")).toBe("Chat only");
 expect(warning.shown()).toBe(false);
 pick("terminal");
 expect(warning.shown()).toBe(true);
});

test("For's end date follows the clock past midnight while the sheet is open, and stops with it", () => {
 const evening = new Date(2026, 11, 22, 23, 59, 30).getTime(), midnight = new Date(2026, 11, 23).getTime();
 const clock = handClock(evening);
 const { rows, value } = drawRows(clock);
 const until = (from: number) => `30 days, until ${new Date(from + 30 * 86_400_000).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
 expect(until(midnight)).not.toBe(until(evening));
 expect(value("For")).toBe(until(evening));
 clock.to(midnight + 1000);
 expect(value("For")).toBe(until(midnight));
 expect(clock.queued).toHaveLength(1);
 rows.stop();
 expect(clock.queued).toHaveLength(0);
});

test("once grants exist For says the length sent and the machines' recorded expiry, past midnight too (#371, #379)", () => {
 const evening = new Date(2026, 11, 22, 23, 59, 30).getTime(), midnight = new Date(2026, 11, 23).getTime();
 const clock = handClock(evening);
 const { rows, all, value } = drawRows(clock);
 const radios = all.filter(n => n.type === "radio");
 const until = (end: number) => `30 days, until ${new Date(end).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
 // Approve sent with 30 days holds the choices until it settles.
 rows.freeze(true);
 expect(radios.length).toBeGreaterThan(0);
 expect(radios.every(r => r.disabled)).toBe(true);
 // Even were For moved to 1 day meanwhile, the grants say what was sent: 30 days, until the day
 // the machine recorded. The answer was lost, so the sheet waits for Try again past midnight.
 const pick = radios.find(r => r.value === "1d")!; pick.checked = true; pick.onchange!();
 const recorded = evening + 30 * 86_400_000 + 5000;
 rows.granted("30d", [recorded]);
 expect(value("For")).toBe(until(recorded));
 expect(clock.queued).toHaveLength(0);
 clock.to(midnight + 1000);
 expect(value("For")).toBe(until(recorded));
 rows.granted("30d", []);
 expect(value("For")).toBe("30 days");
 rows.freeze(false);
 expect(radios.some(r => r.disabled)).toBe(false);
});

test("the code field follows one primary press until release, cancel or close; a cancelled or closed press is no click", () => {
 const doc = new FakeDocument();
 // A window other than the field's own, as a page's might be: the field's own is the one watched.
 G.window = new Listened();
 const input = doc.createElement("input");
 const presses = followPresses(input as unknown as HTMLInputElement);
 const win = doc.defaultView;
 const pointer = (type: string, x: number, more = {}) => Object.assign(new Event(type), { clientX: x, clientY: 40, isPrimary: true, button: 0, pointerId: 1, ...more });
 const at = (type: string, x: number, more = {}) => input.dispatchEvent(pointer(type, x, more));
 const down = (x: number, more = {}) => at("pointerdown", x, more);
 const click = { detail: 1, shiftKey: false };
 // Out and back from where it went down is a drag (#362).
 down(200); at("pointermove", 60); at("pointermove", 200); at("pointerup", 200);
 expect(input.count("pointermove")).toBe(0);
 expect(presses.plainClick(click)).toBe(false);
 // Moves after the release aren't this press's.
 down(200); at("pointerup", 200); at("pointermove", 60);
 expect(presses.plainClick(click)).toBe(true);
 // Another pointer's moves, release and cancel don't touch the press (#376 review): it's still
 // followed, and released where it went down it's a plain click.
 down(200); at("pointermove", 60, { pointerId: 2 }); at("pointerup", 60, { pointerId: 2 }); at("pointercancel", 60, { pointerId: 2 });
 expect(input.count("pointermove")).toBe(1);
 at("pointerup", 200);
 expect(presses.plainClick(click)).toBe(true);
 // Another device's primary pointer (a pen or a touch while the mouse is held) can't take the
 // press over (#383 review): the mouse's out and back stays a drag.
 down(200); at("pointermove", 60); at("pointermove", 200);
 down(200, { pointerId: 2 }); at("pointerup", 200, { pointerId: 2 });
 at("pointerup", 200);
 expect(presses.plainClick(click)).toBe(false);
 // A click the browser says came from another pointer isn't the press's ending; its own is.
 down(200); at("pointerup", 200);
 expect(presses.plainClick({ ...click, pointerId: 2 })).toBe(false);
 expect(presses.plainClick({ ...click, pointerId: 1 })).toBe(true);
 // The same pointer pressing again (its release never reached the sheet) starts a new press.
 down(200); at("pointermove", 60); down(200); at("pointerup", 200);
 expect(presses.plainClick(click)).toBe(true);
 // A press that was cancelled stops being followed and is no click.
 down(200); at("pointercancel", 200);
 expect(input.count("pointermove")).toBe(0);
 expect(presses.plainClick(click)).toBe(false);
 // Only the primary pointer's primary button presses.
 down(200, { button: 2 }); down(200, { isPrimary: false });
 expect(input.count("pointermove")).toBe(0);
 expect(presses.plainClick(click)).toBe(false);
 // The field captures the pressing pointer on itself, so its release arrives even off the window
 // (#389 review).
 expect(input.captured.length).toBeGreaterThan(0);
 expect(input.captured.every(id => id === 1)).toBe(true);
 // Capture lost before the release (the window took the pointer): the press is over, and a touch
 // pressing next is followed and its tap is a click.
 down(200); at("lostpointercapture", 200);
 expect(input.count("pointermove")).toBe(0);
 down(200, { pointerId: 3 }); at("pointerup", 200, { pointerId: 3 });
 expect(presses.plainClick({ ...click, pointerId: 3 })).toBe(true);
 // Capture is always lost after the release; that keeps the press for its click.
 down(200); at("pointerup", 200); at("lostpointercapture", 200);
 expect(presses.plainClick(click)).toBe(true);
 // The field's window losing focus ends a press still down.
 down(200); win.dispatchEvent(new Event("blur"));
 down(200, { pointerId: 3 }); at("pointerup", 200, { pointerId: 3 });
 expect(presses.plainClick({ ...click, pointerId: 3 })).toBe(true);
 // A press the sheet closed on stops being followed and is no click, and close() takes off every
 // listener it put on the field and its window (#398 review) and lets go of the pointer the field
 // holds (#402 review): a field still in the document follows no further press, and holds and
 // captures no pointer.
 expect(input.total()).toBeGreaterThan(0);
 expect(win.count("blur")).toBe(1);
 down(200);
 expect(input.hasPointerCapture(1)).toBe(true);
 presses.close();
 expect(input.hasPointerCapture(1)).toBe(false);
 expect(input.total()).toBe(0);
 expect(win.total()).toBe(0);
 expect(presses.plainClick(click)).toBe(false);
 const captures = input.captured.length;
 down(200); at("pointermove", 60); at("pointerup", 200);
 expect(input.captured.length).toBe(captures);
 expect(input.total()).toBe(0);
 expect(presses.plainClick(click)).toBe(false);
});

/** Waits for the sheet to reach a state a person would see; what says what never came. */
async function until(what: string, reached: () => boolean): Promise<void> {
 for (let i = 0; i < 1000 && !reached(); i++) { const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); await promise; }
 if (!reached()) throw new Error(`the sheet never showed ${what}`);
}

test("the sheet opens on Ready; Approve checks the code and sends the choices, held while it's out; after a lost answer Try again resends them without a second check", async () => {
 // The sheet's poll and For's clock: the runner's timers, not run during the test.
 jest.useFakeTimers();
 const doc = new FakeDocument();
 const on = new Map<string, (payload: unknown) => void>();
 const calls: unknown[][] = [];
 const firstAnswer = Promise.withResolvers<void>();
 let approvals = 0;
 G.document = doc;
 G.devicePixelRatio = 1;
 // Only the app's IPC is stubbed.
 G.mygo = {
  on: (name: string, l: (payload: unknown) => void) => { on.set(name, l); return () => on.delete(name); },
  call: async (method: string, ...args: unknown[]) => {
   calls.push([method, ...args]);
   switch (method) {
    case "Desk.AccountState": return { signedIn: true };
    case "Desk.WebAccessOffered": return true;
    case "Desk.WebAccessRequests": return [{ id: "r1", browserName: "Chrome on macOS", claimed: "no", expiresIn: 600, createdMs: 0 }];
    case "Desk.WebAccessLengths": return [{ id: "1d", seconds: 86_400 }, { id: "30d", seconds: 30 * 86_400 }];
    case "Desk.WebAccessMachines": return [{ id: "a", label: "hetzner", available: true }];
    case "Desk.WebAccessStart": queueMicrotask(() => on.get("web-access:update")?.({ id: "r1", state: "ready" })); return undefined;
    case "Desk.WebAccessCheckCode": return { ok: true, left: 3, denied: false };
    case "Desk.WebAccessApprove":
     if (++approvals > 1) return { granted: ["hetzner"], skipped: [], failed: [], expires: [Date.UTC(2026, 11, 22)] };
     await firstAnswer.promise;
     return { granted: ["hetzner"], skipped: [], failed: [], unsure: true, problem: "account service: 503", expires: [Date.UTC(2026, 11, 22)] };
    default: return Promise.withResolvers<never>().promise;
   }
  },
 };
 try {
  initWebAccess();
  doc.dispatchEvent(new Event("visibilitychange"));
  const dialog = () => doc.body.children.find(c => c.tagName === "dialog");
  const nodes = () => dialog()?.all() ?? [];
  const code = () => nodes().find(n => n.className === "web-access-code");
  const status = () => nodes().find(n => n.className === "web-access-status")?.textContent;
  const button = (text: string) => nodes().find(n => n.tagName === "button" && !n.hidden && n.textContent === text);
  const rowHead = (key: string) => nodes().find(n => n.tagName === "button" && n.children[0]?.textContent === key)!;
  const forValue = () => rowHead("For").children[1]!.textContent;
  // A choice as a person picks it: its radio isn't clickable (pointer-events: none), its label is.
  const choose = (label: string) => nodes().find(n => n.tagName === "label" && n.textContent === label)!.click();
  const sent = (method: string) => calls.filter(c => c[0] === method).map(c => c.slice(1));

  await until("Ready in an open dialog with the code field focused", () =>
   dialog()?.open === true && status() === "The browser shows a code now." && code() !== undefined && doc.activeElement === code());
  // Typed into the focused field, as a person would.
  const field = code()!;
  field.value = "1234"; field.dispatchEvent(new Event("input"));
  await until("an enabled Approve", () => button("Approve")?.disabled === false);
  const accessValue = () => rowHead("Access").children[1]!.textContent;
  const picked = (group: string) => nodes().find(n => n.name === `web-access-${group}` && n.checked)?.value;
  // Both rows' labels pick a choice other than the default: Chat only, and (For opened) 1 day.
  choose("Chat only");
  expect([picked("access"), accessValue()]).toEqual(["chat", "Chat only"]);
  rowHead("For").click();
  choose("1 day");
  expect(picked("time")).toBe("1d");
  expect(forValue()).toStartWith("1 day, until ");
  button("Approve")!.click();
  await until("Approving…", () => button("Approving…") !== undefined);
  // While the approval is out the choices are held: the default's labels pick nothing.
  const unchanged = () => {
   expect([picked("access"), accessValue(), picked("time")]).toEqual(["chat", "Chat only", "1d"]);
   expect(forValue()).toStartWith("1 day, until ");
  };
  choose("Chat and terminal"); choose("30 days");
  unchanged();
  firstAnswer.resolve();
  await until("Try again", () => button("Try again")?.disabled === false);
  // After the lost answer they're still held, and Try again is about that approval.
  choose("Chat and terminal"); choose("30 days");
  unchanged();
  expect(sent("Desk.WebAccessCheckCode")).toEqual([["r1", "1234"]]);
  expect(sent("Desk.WebAccessApprove")).toEqual([["r1", ["a"], "chat", "1d"]]);
  // Try again resends what the lost approval sent, without checking the code again.
  button("Try again")!.click();
  await until("Approved", () => status() === "Approved. The browser can open your machines now.");
  expect(sent("Desk.WebAccessCheckCode")).toHaveLength(1);
  expect(sent("Desk.WebAccessApprove")).toEqual([["r1", ["a"], "chat", "1d"], ["r1", ["a"], "chat", "1d"]]);
  expect(button("Try again") ?? button("Approve")).toBeUndefined();
  button("Done")!.click();
  expect(dialog()).toBeUndefined();
 } finally {
  jest.clearAllTimers();
  jest.useRealTimers();
 }
});

/** A signed-in window with a sidebar foot and the composer, where one browser asks for approval and
 *  shows its code when ready() is called. type() presses keys as a person does: each goes to the
 *  element with focus, and the document hears its keydown and input. */
function askingWindow() {
 jest.useFakeTimers();
 const doc = new FakeDocument();
 const on = new Map<string, (payload: unknown) => void>();
 G.document = doc;
 G.devicePixelRatio = 1;
 G.mygo = {
  on: (name: string, l: (payload: unknown) => void) => { on.set(name, l); return () => on.delete(name); },
  call: async (method: string) => {
   switch (method) {
    case "Desk.AccountState": return { signedIn: true };
    case "Desk.WebAccessOffered": return true;
    case "Desk.WebAccessRequests": return [{ id: "r1", browserName: "Chrome on macOS", claimed: "no", expiresIn: 600, createdMs: 0 }];
    case "Desk.WebAccessLengths": return [{ id: "1d", seconds: 86_400 }];
    case "Desk.WebAccessMachines": return [{ id: "a", label: "hetzner", available: true }];
    case "Desk.WebAccessStart": return undefined;
    default: return Promise.withResolvers<never>().promise;
   }
  },
 };
 const foot = doc.createElement("div"); foot.id = "sidebar-foot";
 const composer = doc.createElement("textarea");
 doc.body.append(foot, composer);
 const clock = handClock(0);
 const dialog = () => doc.body.children.find(c => c.tagName === "dialog");
 return {
  doc, composer, clock, dialog,
  code: () => dialog()?.all().find(n => n.className === "web-access-code"),
  notice: () => foot.children.find(n => n.className === "web-access-notice"),
  start: () => { initWebAccess(clock); doc.dispatchEvent(new Event("visibilitychange")); },
  ready: () => on.get("web-access:update")?.({ id: "r1", state: "ready" }),
  type: (text: string) => {
   for (const ch of text) {
    const target = doc.activeElement;
    doc.dispatchEvent(new Event("keydown"));
    if (target) { target.value += ch; doc.dispatchEvent(new Event("input")); }
   }
  },
 };
}

test("a request while the composer has focus opens no sheet: a notice says so, the keys stay in the composer, and Review opens the sheet with its code field focused (#464)", async () => {
 const w = askingWindow();
 try {
  w.composer.focus();
  w.type("hel");
  w.start();
  await until("the notice", () => w.notice() !== undefined);
  expect(w.notice()!.text()).toBe("A browser wants to reach your machines.Review");
  expect(w.dialog()).toBeUndefined();
  expect(w.doc.activeElement).toBe(w.composer);
  // Typing on, a key a second: no pause long enough to open the sheet.
  for (const [i, ch] of [..."lo, world"].entries()) { w.clock.to((i + 1) * 1000); w.type(ch); }
  expect(w.composer.value).toBe("hello, world");
  expect(w.doc.activeElement).toBe(w.composer);
  expect(w.dialog()).toBeUndefined();
  w.notice()!.children.find(n => n.tagName === "button" && n.textContent === "Review")!.click();
  await until("an open sheet", () => w.dialog()?.open === true);
  expect(w.notice()).toBeUndefined();
  w.ready();
  expect(w.doc.activeElement).toBe(w.code());
  // Review cancelled the pause's look: it doesn't open the sheet again later.
  w.clock.to(60_000);
  for (let i = 0; i < 50; i++) { const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); await promise; }
  expect(w.doc.body.children.filter(c => c.tagName === "dialog")).toHaveLength(1);
 } finally {
  jest.clearAllTimers();
  jest.useRealTimers();
 }
});

test("the notice's sheet opens by itself once typing has paused for 5 s, counted from the last key (#464)", async () => {
 const w = askingWindow();
 try {
  w.composer.focus();
  w.start();
  await until("the notice", () => w.notice() !== undefined);
  w.clock.to(3000);
  w.type("x");
  w.clock.to(TYPING_PAUSE_MS);
  expect(w.dialog()).toBeUndefined();
  w.clock.to(3000 + TYPING_PAUSE_MS - 1);
  expect(w.dialog()).toBeUndefined();
  w.clock.to(3000 + TYPING_PAUSE_MS);
  await until("an open sheet", () => w.dialog()?.open === true);
  expect(w.notice()).toBeUndefined();
  // showModal took the focus into the sheet, so the code field takes it when the code is shown.
  w.ready();
  expect(w.doc.activeElement).toBe(w.code());
 } finally {
  jest.clearAllTimers();
  jest.useRealTimers();
 }
});

test("with no field taking typing focused the sheet opens at once, as before, and the code field takes the focus only from within the sheet (#464)", async () => {
 const w = askingWindow();
 try {
  const box = w.doc.createElement("input"); box.type = "checkbox";
  w.doc.body.append(box);
  box.focus();
  w.start();
  await until("an open sheet", () => w.dialog()?.open === true);
  expect(w.notice()).toBeUndefined();
  // A field outside the sheet has the focus when the code is shown: the code field leaves it there.
  w.composer.focus();
  w.ready();
  expect(w.code()!.disabled).toBe(false);
  expect(w.doc.activeElement).toBe(w.composer);
 } finally {
  jest.clearAllTimers();
  jest.useRealTimers();
 }
});

test("text fields, textareas and editable content take typing; checkboxes, buttons and the rest don't", () => {
 const doc = new FakeDocument();
 const node = (tag: string, type = "", editable = false) => Object.assign(doc.createElement(tag), { type, isContentEditable: editable }) as unknown as Element;
 for (const n of [node("textarea"), node("input"), node("input", "text"), node("input", "search"), node("input", "email"), node("div", "", true)]) expect(takesTyping(n)).toBe(true);
 for (const n of [null, node("input", "checkbox"), node("input", "radio"), node("input", "button"), node("input", "range"), node("button"), node("div"), node("dialog")]) expect(takesTyping(n)).toBe(false);
});

test("the line under the rows says what Approve turns on and why a machine can't be ticked, with Machines closed", () => {
 expect(machinesNote([{ label: "hetzner", available: true }])).toBe("Approving turns on web access on the machines you tick.");
 expect(machinesNote([{ label: "hetzner", available: true }, { label: "win-box", available: false, unavailable: "unsupported" }, { label: "nas", available: false, unavailable: "needs_key" }]))
  .toBe("Approving turns on web access on the machines you tick. win-box can't share with the web (Windows). nas needs a key file (connect it once with a key).");
});
