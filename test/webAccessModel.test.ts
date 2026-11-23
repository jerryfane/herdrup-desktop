import { afterEach, expect, test } from "bun:test";
import { choiceRows, followPresses, type SheetClock } from "../src/webAccess";
import { ACCESS_CHOICES, askOffered, canApprove, choiceLabel, CodePress, codeInput, codeSlots, DRAG_PX, lengthLabel, machinesNote, machinesSummary, nextRequest, OFFERED_RECHECK_MS,
 resultLines, slotSelection, timeSummary, wrongCode } from "../src/webAccessModel";

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

test("For says the length in whole days and the day it ends", () => {
 const now = Date.UTC(2026, 10, 23, 12);
 const day = (d: number) => new Date(now + d * 86_400_000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
 expect(timeSummary(7 * 86_400, now + 7 * 86_400_000)).toBe(`7 days, until ${day(7)}`);
 expect(timeSummary(86_400, now + 86_400_000)).toBe(`1 day, until ${day(1)}`);
 expect(lengthLabel(30 * 86_400)).toBe("30 days");
});

// ---- The rows as choiceRows draws them, on a fake document (Bun has no DOM) ----

/** The few DOM calls the rows make: createElement, plain properties, attributes, append, and the
 *  onclick/onchange handlers the test calls as a click or a pick would. */
class FakeElement {
 className = ""; textContent = ""; hidden = false; type = ""; name = ""; value = ""; id = ""; htmlFor = ""; checked = false;
 onclick: (() => void) | null = null; onchange: (() => void) | null = null;
 parent: FakeElement | null = null;
 readonly children: FakeElement[] = [];
 readonly attributes = new Map<string, string>();
 constructor(readonly tagName: string) {}
 setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
 getAttribute(name: string) { return this.attributes.get(name) ?? null; }
 append(...nodes: FakeElement[]) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
 all(): FakeElement[] { return [this, ...this.children.flatMap(c => c.all())]; }
 /** Drawn: neither it nor anything it sits in is hidden. */
 shown(): boolean { return !this.hidden && (this.parent?.shown() ?? true); }
}
const G = globalThis as { document?: unknown; devicePixelRatio?: unknown; mygo?: unknown };
const saved = { document: G.document, devicePixelRatio: G.devicePixelRatio, mygo: G.mygo };
afterEach(() => { G.document = saved.document; G.devicePixelRatio = saved.devicePixelRatio; G.mygo = saved.mygo; });

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
 G.document = { createElement: (tag: string) => new FakeElement(tag) };
 // The rows' chevron glyph asks the app for an image; here that answer never comes.
 G.devicePixelRatio = 1;
 G.mygo = { call: () => new Promise(() => {}) };
 const rows = choiceRows(new FakeElement("div") as unknown as HTMLElement, false, [{ id: "1d", seconds: 86_400 }, { id: "30d", seconds: 30 * 86_400 }], clock);
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

test("once a grant exists For says the expiry it was made with, past midnight too, or no date if unknown (#371)", () => {
 const evening = new Date(2026, 11, 22, 23, 59, 30).getTime(), midnight = new Date(2026, 11, 23).getTime();
 const clock = handClock(evening);
 const { rows, value } = drawRows(clock);
 const until = (from: number) => `30 days, until ${new Date(from + 30 * 86_400_000).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
 // Approved before midnight; the answer was lost, so the sheet waits for Try again.
 rows.granted(evening + 30 * 86_400_000);
 expect(clock.queued).toHaveLength(0);
 clock.to(midnight + 1000);
 expect(value("For")).toBe(until(evening));
 rows.granted(undefined);
 expect(value("For")).toBe("30 days");
});

/** An owner that keeps the pointermove listeners it holds, to see the press stop being followed. */
class Owner extends EventTarget {
 readonly moves = new Set<unknown>();
 override addEventListener(type: string, l: EventListenerOrEventListenerObject | null, o?: AddEventListenerOptions | boolean) {
  if (type === "pointermove") this.moves.add(l);
  super.addEventListener(type, l, o);
 }
 override removeEventListener(type: string, l: EventListenerOrEventListenerObject | null, o?: EventListenerOptions | boolean) {
  if (type === "pointermove") this.moves.delete(l);
  super.removeEventListener(type, l, o);
 }
}

test("the dialog follows one primary press until release, cancel or close; a cancelled or closed press is no click", () => {
 const owner = new Owner();
 const presses = followPresses(owner);
 const pointer = (type: string, x: number, more = {}) => Object.assign(new Event(type), { clientX: x, clientY: 40, isPrimary: true, button: 0, ...more });
 const at = (type: string, x: number, more = {}) => owner.dispatchEvent(pointer(type, x, more));
 const down = (x: number, more = {}) => presses.down(pointer("pointerdown", x, more) as unknown as PointerEvent);
 const click = { detail: 1, shiftKey: false };
 // Out and back from where it went down is a drag (#362).
 down(200); at("pointermove", 60); at("pointermove", 200); at("pointerup", 200);
 expect(owner.moves.size).toBe(0);
 expect(presses.plainClick(click)).toBe(false);
 // Moves after the release, or of another pointer, aren't this press's.
 down(200); at("pointermove", 60, { isPrimary: false }); at("pointerup", 200); at("pointermove", 60);
 expect(presses.plainClick(click)).toBe(true);
 // A press that was cancelled, or that the sheet closed on, stops being followed and is no click.
 down(200); at("pointercancel", 200);
 expect(owner.moves.size).toBe(0);
 expect(presses.plainClick(click)).toBe(false);
 down(200); presses.close();
 expect(owner.moves.size).toBe(0);
 expect(presses.plainClick(click)).toBe(false);
 // Only the primary button presses.
 down(200, { button: 2 });
 expect(owner.moves.size).toBe(0);
 expect(presses.plainClick(click)).toBe(false);
});

test("the line under the rows says what Approve turns on and why a machine can't be ticked, with Machines closed", () => {
 expect(machinesNote([{ label: "hetzner", available: true }])).toBe("Approving turns on web access on the machines you tick.");
 expect(machinesNote([{ label: "hetzner", available: true }, { label: "win-box", available: false, unavailable: "unsupported" }, { label: "nas", available: false, unavailable: "needs_key" }]))
  .toBe("Approving turns on web access on the machines you tick. win-box can't share with the web (Windows). nas needs a key file (connect it once with a key).");
});
