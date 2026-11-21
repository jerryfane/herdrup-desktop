// The host home's account avatar (src/accountAvatar.ts, host-status proposal 1).
import { expect, test } from "bun:test";
import { accountAvatar } from "../src/accountAvatar";

test("signed out: a person with no dot, and nothing once the service says it offers no sign-in", () => {
 expect(accountAvatar({ signedIn: false }, true)).toEqual({ shown: true, initial: null, dot: null, value: "Signed out" });
 expect(accountAvatar({ signedIn: false, displayHint: "jerry@example.com" }, true)).toMatchObject({ initial: null, dot: null });
 expect(accountAvatar({ signedIn: false }, false)).toEqual({ shown: false });
 expect(accountAvatar(null, false)).toEqual({ shown: false });
});

test("signed in: the address's initial, or a person for Apple's private relay or no address", () => {
 expect(accountAvatar({ signedIn: true, displayHint: "jerry@example.com" }, false)).toEqual({ shown: true, initial: "J", dot: "done", value: "Signed in as jerry@example.com" });
 expect(accountAvatar({ signedIn: true, displayHint: "émile@example.com" }, false)).toMatchObject({ initial: "É" });
 expect(accountAvatar({ signedIn: true, displayHint: "x7k2@privaterelay.appleid.com" }, false)).toEqual({ shown: true, initial: null, dot: "done", value: "Signed in" });
 expect(accountAvatar({ signedIn: true }, false)).toMatchObject({ initial: null, dot: "done", value: "Signed in" });
 expect(accountAvatar({ signedIn: true, displayHint: "_x@example.com" }, false)).toMatchObject({ initial: null });
});

test("a failed sync turns the one dot to waiting: Needs attention", () => {
 expect(accountAvatar({ signedIn: true, displayHint: "jerry@example.com", syncFailed: true }, false)).toEqual({ shown: true, initial: "J", dot: "waiting", value: "Needs attention" });
});
