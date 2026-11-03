import { expect, test } from "bun:test";
import { reconcileOutgoing, type Outgoing } from "../src/chatPoll";

// Owner report 2026-11-03: sending in Chat did not feel responsive. A sent prompt shows at the
// tail at once and stays until the transcript shows that prompt (motion spec §1,
// TranscriptOutbox.reconcile: same author, same text).
const sent = (text: string, more: Partial<Outgoing> = {}): Outgoing => ({ id: text, text, files: 0, guest: "", state: "submitted", until: 60_000, ...more });
const user = (id: string, text: string, author = "owner", author_name?: string) => ({ kind: "user", id, ts_ms: 1, text, author, author_name });
const ids = (o: Outgoing[]) => o.map(m => m.id);

test("the reader's own prompt in the tail removes its outgoing bubble", () => {
 const held = new Set(["u1"]);
 expect(ids(reconcileOutgoing([sent("a"), sent("b")], held, [user("u1", "a"), user("u2", "b\r\n")], 0))).toEqual(["a"]);
 // Older history and replies are not the send.
 expect(ids(reconcileOutgoing([sent("a")], held, [user("u1", "a"), { kind: "reply", id: "r2", ts_ms: 2, text: "a" }], 0))).toEqual(["a"]);
});

test("other authors keep the bubble", () => {
 // The owner's pending prompt; a guest writes meanwhile, even with the same words.
 expect(ids(reconcileOutgoing([sent("hi")], new Set(), [user("u2", "hi", "guest", "nike")], 0))).toEqual(["hi"]);
 // A guest's pending prompt: the owner's and another guest's prompts are not it; its own is.
 const mine = sent("hi", { guest: "nike" });
 expect(ids(reconcileOutgoing([mine], new Set(), [user("u2", "hi"), user("u3", "hi", "guest", "jerry-2")], 0))).toEqual(["hi"]);
 expect(ids(reconcileOutgoing([mine], new Set(), [user("u4", "hi", "guest", "nike")], 0))).toEqual([]);
 // A different prompt by the same author is not it either.
 expect(ids(reconcileOutgoing([sent("hi")], new Set(), [user("u5", "other")], 0))).toEqual(["hi"]);
});

test("an accepted prompt still unseen after its minute says so; one still sending waits", () => {
 const out = reconcileOutgoing([sent("a"), sent("b", { state: "sending" })], new Set(), [], 60_000);
 expect(out.map(o => o.state)).toEqual(["notSeen", "sending"]);
 expect(reconcileOutgoing([sent("a")], new Set(), [], 59_999)[0]!.state).toBe("submitted");
 // Seen late, it still leaves.
 expect(ids(reconcileOutgoing([sent("a", { state: "notSeen" })], new Set(), [user("u9", "a")], 70_000))).toEqual([]);
});
