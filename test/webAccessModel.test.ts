import { expect, test } from "bun:test";
import { askOffered, canApprove, codeInput, nextRequest, OFFERED_RECHECK_MS, resultLines, wrongCode } from "../src/webAccessModel";

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
