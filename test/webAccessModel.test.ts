import { expect, test } from "bun:test";
import { canApprove, codeInput, nextRequest, resultLines, wrongCode } from "../src/webAccessModel";

const req = (id: string, claimed = "no", expiresIn = 600) => ({ id, browserName: "Chrome on macOS", claimed, expiresIn });

test("the sheet opens for the oldest request nobody is approving and the user hasn't closed", () => {
 expect(nextRequest([req("a", "other"), req("b"), req("c")], new Set())?.id).toBe("b");
 expect(nextRequest([req("b"), req("c")], new Set(["b"]))?.id).toBe("c");
 expect(nextRequest([req("a", "you"), req("b", "no", 0)], new Set())).toBeNull();
});

test("the code is four digits and Approve needs a code and a machine", () => {
 expect(codeInput(" 4 7-2a9 1")).toBe("4729");
 expect(canApprove("4729", 1, false)).toBe(true);
 expect(canApprove("472", 1, false)).toBe(false);
 expect(canApprove("4729", 0, false)).toBe(false);
 expect(canApprove("4729", 2, true)).toBe(false);
});

test("an approval with no machine granted leaves the request open and says why", () => {
 const none = resultLines({ granted: [], skipped: [{ label: "nas", reason: "relay_not_allowed" }], failed: [] });
 expect(none.done).toBe(false);
 expect(none.lines).toEqual(["nas uses a relay the web app can't reach.", "The browser isn't approved yet. Choose another machine, or Deny."]);
 const some = resultLines({ granted: ["dev2306"], skipped: [], failed: [{ label: "pi", reason: "timeout" }] });
 expect(some).toEqual({ done: true, lines: ["Approved on dev2306.", "pi: timeout"] });
});

test("wrong codes count down to a denial", () => {
 expect(wrongCode(1)).toBe("That code doesn't match the browser's. 2 tries left.");
 expect(wrongCode(2)).toBe("That code doesn't match the browser's. 1 try left.");
 expect(wrongCode(3)).toBe("Denied after three wrong codes.");
});
