// The host home's account avatar (src/accountAvatar.ts, host-status proposal 1).
import { expect, test } from "bun:test";
import { accountAvatar } from "../src/accountAvatar";

test("signed out: a person with no dot, and nothing when the service offers no sign-in", () => {
 expect(accountAvatar({ signedIn: false }, ["apple"])).toMatchObject({ shown: true, initial: null, dot: null });
 expect(accountAvatar({ signedIn: false, displayHint: "jerry@example.com" }, ["apple"])).toMatchObject({ initial: null, dot: null });
 expect(accountAvatar({ signedIn: false }, [])).toEqual({ shown: false });
 expect(accountAvatar(null, [])).toEqual({ shown: false });
});

test("signed in: the address's initial, or a person for Apple's private relay or no address", () => {
 expect(accountAvatar({ signedIn: true, displayHint: "jerry@example.com" }, [])).toMatchObject({ shown: true, initial: "J", dot: "done" });
 expect(accountAvatar({ signedIn: true, displayHint: "émile@example.com" }, [])).toMatchObject({ initial: "É" });
 expect(accountAvatar({ signedIn: true, displayHint: "x7k2@privaterelay.appleid.com" }, [])).toMatchObject({ initial: null, dot: "done" });
 expect(accountAvatar({ signedIn: true }, [])).toMatchObject({ initial: null, dot: "done" });
 expect(accountAvatar({ signedIn: true, displayHint: "_x@example.com" }, [])).toMatchObject({ initial: null });
});

test("a failed sync turns the one dot to waiting and says so", () => {
 const look = accountAvatar({ signedIn: true, displayHint: "jerry@example.com", syncFailed: true }, []);
 expect(look).toMatchObject({ initial: "J", dot: "waiting" });
 expect(look.shown && look.label).toContain("needs attention");
});
