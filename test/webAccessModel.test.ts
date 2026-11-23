import { expect, test } from "bun:test";
import { ACCESS_CHOICES, askOffered, canApprove, choiceLabel, codeInput, machinesNote, machinesSummary, nextRequest, OFFERED_RECHECK_MS, resultLines, showsTerminalWarning, TIME_CHOICES, timeSummary,
 wrongCode } from "../src/webAccessModel";

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

test("the sheet's rows, closed, say the choice: ticked machines by name, access, and how long until when", () => {
 const ms = ["hetzner", "mars-mini", "nas", "pi", "box"].map((label, i) => ({ id: String(i), label }));
 expect(machinesSummary(ms, new Set(["0", "1"]))).toBe("hetzner, mars-mini");
 expect(machinesSummary(ms, new Set(["0", "1", "2"]))).toBe("hetzner, mars-mini, nas");
 expect(machinesSummary(ms, new Set(["0", "1", "2", "3", "4"]))).toBe("hetzner, mars-mini and 3 more");
 expect(machinesSummary(ms, new Set())).toBe("None ticked");
 expect(machinesSummary([], new Set())).toBe("None yet");
 expect(choiceLabel(ACCESS_CHOICES, "terminal")).toBe("Chat and terminal");
 expect(choiceLabel(ACCESS_CHOICES, "chat")).toBe("Chat only");
 const now = Date.UTC(2026, 10, 23, 12);
 const day = (d: number) => new Date(now + d * 86_400_000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
 expect(TIME_CHOICES.map(([v]) => timeSummary(v, now))).toEqual([`1 day, until ${day(1)}`, `7 days, until ${day(7)}`, `30 days, until ${day(30)}`]);
});

test("the terminal warning shows whenever terminal access is chosen, and only then", () => {
 expect(showsTerminalWarning("terminal")).toBe(true);
 expect(showsTerminalWarning("chat")).toBe(false);
});

test("the line under the rows says what Approve turns on and why a machine can't be ticked, with Machines closed", () => {
 expect(machinesNote([{ label: "hetzner", available: true }])).toBe("Approving turns on web access on the machines you tick.");
 expect(machinesNote([{ label: "hetzner", available: true }, { label: "win-box", available: false, unavailable: "unsupported" }, { label: "nas", available: false, unavailable: "needs_key" }]))
  .toBe("Approving turns on web access on the machines you tick. win-box can't share with the web (Windows). nas needs a key file (connect it once with a key).");
});
