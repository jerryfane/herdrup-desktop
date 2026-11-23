import { afterEach, expect, test } from "bun:test";
import { choiceRows } from "../src/webAccess";
import { ACCESS_CHOICES, askOffered, canApprove, choiceLabel, codeInput, codeSlots, lengthLabel, machinesNote, machinesSummary, nextRequest, OFFERED_RECHECK_MS, plainClick, resultLines,
 slotSelection, timeSummary, wrongCode } from "../src/webAccessModel";

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

test("only a plain click takes a box's digit; a drag, double click or shift-click keeps its own selection", () => {
 expect(plainClick({ detail: 1, shiftKey: false }, 2, 2)).toBe(true);
 // Dragging across 12 of 1234 selected [0, 2]: releasing keeps it, so Backspace leaves 34.
 expect(plainClick({ detail: 1, shiftKey: false }, 0, 2)).toBe(false);
 expect(plainClick({ detail: 2, shiftKey: false }, 0, 4)).toBe(false);
 expect(plainClick({ detail: 2, shiftKey: false }, 4, 4)).toBe(false);
 expect(plainClick({ detail: 1, shiftKey: true }, 1, 1)).toBe(false);
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

test("For says the length in whole days and the day it ends from the duration the computer grants", () => {
 const now = Date.UTC(2026, 10, 23, 12);
 const day = (d: number) => new Date(now + d * 86_400_000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
 expect(timeSummary(7 * 86_400, now)).toBe(`7 days, until ${day(7)}`);
 expect(timeSummary(86_400, now)).toBe(`1 day, until ${day(1)}`);
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

test("the rows repaint their own choice and the terminal warning: shown with Access closed, not with Chat only", () => {
 G.document = { createElement: (tag: string) => new FakeElement(tag) };
 // The rows' chevron glyph asks the app for an image; here that answer never comes.
 G.devicePixelRatio = 1;
 G.mygo = { call: () => new Promise(() => {}) };
 const rows = choiceRows(new FakeElement("div") as unknown as HTMLElement, false, [{ id: "1d", seconds: 86_400 }, { id: "30d", seconds: 30 * 86_400 }]);
 rows.showMachines("hetzner");
 const all = (rows.rows as unknown as FakeElement).all();
 const warning = all.find(n => n.className === "web-access-warning")!;
 const access = all.find(n => n.tagName === "button" && n.children[0]?.textContent === "Access")!;
 const pick = (value: string) => { const radio = all.find(n => n.type === "radio" && n.value === value)!; radio.checked = true; radio.onchange!(); };
 const value = (key: string) => all.find(n => n.tagName === "button" && n.children[0]?.textContent === key)!.children[1]!.textContent;
 expect(rows.choice.length).toBe("30d");
 expect(value("Machines")).toBe("hetzner");
 expect(value("For")).toStartWith("30 days, until ");
 pick("1d");
 expect(rows.choice.length).toBe("1d");
 expect(value("For")).toStartWith("1 day, until ");
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

test("the line under the rows says what Approve turns on and why a machine can't be ticked, with Machines closed", () => {
 expect(machinesNote([{ label: "hetzner", available: true }])).toBe("Approving turns on web access on the machines you tick.");
 expect(machinesNote([{ label: "hetzner", available: true }, { label: "win-box", available: false, unavailable: "unsupported" }, { label: "nas", available: false, unavailable: "needs_key" }]))
  .toBe("Approving turns on web access on the machines you tick. win-box can't share with the web (Windows). nas needs a key file (connect it once with a key).");
});
