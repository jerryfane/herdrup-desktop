import { expect, test } from "bun:test";
import { reconcileOutgoing, type Outgoing } from "../src/chatPoll";

// Owner report 2026-11-03: sending in Chat did not feel responsive. A sent prompt shows at the
// tail at once and stays until the transcript shows it (motion spec §1, TranscriptOutbox.swift).
const sent = (id: string, state: Outgoing["state"] = "submitted", until = 60_000): Outgoing => ({ id, text: id, files: 0, state, until });
const user = (id: string) => ({ kind: "user", id, ts_ms: 1 });

test("a new user entry in the tail replaces the oldest outgoing prompt", () => {
 const held = new Set(["u1"]);
 expect(reconcileOutgoing([sent("a"), sent("b")], held, [user("u1"), user("u2")], 0).map(o => o.id)).toEqual(["b"]);
 // Older history and replies are not the send.
 expect(reconcileOutgoing([sent("a")], held, [user("u1"), { kind: "reply", id: "r2", ts_ms: 2 }], 0).map(o => o.id)).toEqual(["a"]);
});

test("an accepted prompt still unseen after its minute says so; one still sending waits", () => {
 const out = reconcileOutgoing([sent("a"), sent("b", "sending")], new Set(), [], 60_000);
 expect(out.map(o => o.state)).toEqual(["notSeen", "sending"]);
 expect(reconcileOutgoing([sent("a")], new Set(), [], 59_999)[0]!.state).toBe("submitted");
});
