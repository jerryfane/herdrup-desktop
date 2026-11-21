// The host home's account avatar (src/accountAvatar.ts, host-status proposal 1).
import { expect, test } from "bun:test";
import { accountAvatar } from "../src/accountAvatar";

test("signed out: a person with no dot, and nothing when the service offers no sign-in", () => {
 expect(accountAvatar({ signedIn: false }, ["apple"])).toEqual({ shown: true, initial: null, dot: null, value: "Signed out" });
 expect(accountAvatar({ signedIn: false, displayHint: "jerry@example.com" }, ["apple"])).toMatchObject({ initial: null, dot: null });
 expect(accountAvatar({ signedIn: false }, [])).toEqual({ shown: false });
 expect(accountAvatar(null, [])).toEqual({ shown: false });
});

test("signed in: the address's initial, or a person for Apple's private relay or no address", () => {
 expect(accountAvatar({ signedIn: true, displayHint: "jerry@example.com" }, [])).toEqual({ shown: true, initial: "J", dot: "done", value: "Signed in as jerry@example.com" });
 expect(accountAvatar({ signedIn: true, displayHint: "émile@example.com" }, [])).toMatchObject({ initial: "É" });
 expect(accountAvatar({ signedIn: true, displayHint: "x7k2@privaterelay.appleid.com" }, [])).toEqual({ shown: true, initial: null, dot: "done", value: "Signed in" });
 expect(accountAvatar({ signedIn: true }, [])).toMatchObject({ initial: null, dot: "done", value: "Signed in" });
 expect(accountAvatar({ signedIn: true, displayHint: "_x@example.com" }, [])).toMatchObject({ initial: null });
});

test("a failed sync turns the one dot to waiting: Needs attention", () => {
 expect(accountAvatar({ signedIn: true, displayHint: "jerry@example.com", syncFailed: true }, [])).toEqual({ shown: true, initial: "J", dot: "waiting", value: "Needs attention" });
});
