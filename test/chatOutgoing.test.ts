import { expect, test } from "bun:test";
import { reconcileOutgoing, type Outgoing } from "../src/chatPoll";

// Owner report 2026-11-03: sending in Chat did not feel responsive. A sent prompt shows at the
// tail at once and stays until the transcript shows that prompt (motion spec §1,
// TranscriptOutbox.reconcile: same author, same text).
const sent = (text: string, more: Partial<Outgoing> = {}): Outgoing => ({ id: text, text, files: [], guest: "", state: "submitted", until: 60_000, ...more });
const photo1 = [{ name: "photo.png", isImage: true }];
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

test("a send with files matches only its files prompt", () => {
 // As paneAttachmentPrompt writes it: caption, blank line, reference; or the reference alone.
 const ref = "[Photo attached via Herdr Gram message g1. Download it with `herdr gram get-file g1 -o /tmp/herdr-photo-g1.png`, then inspect /tmp/herdr-photo-g1.png.]";
 const photo = sent("look at this", { files: photo1 });
 expect(ids(reconcileOutgoing([photo], new Set(), [user("u1", "something else")], 0))).toEqual(["look at this"]);
 expect(ids(reconcileOutgoing([photo], new Set(), [user("u2", "look at this")], 0))).toEqual(["look at this"]);
 expect(ids(reconcileOutgoing([photo], new Set(), [user("u3", "look at this\n\n" + ref)], 0))).toEqual([]);
 const bare = sent("", { id: "bare", files: photo1 });
 expect(ids(reconcileOutgoing([bare], new Set(), [user("u4", "hi")], 0))).toEqual(["bare"]);
 expect(ids(reconcileOutgoing([bare], new Set(), [user("u5", ref)], 0))).toEqual([]);
});

test("a files caption ending in whitespace still matches", () => {
 // The bubble keeps the trimmed caption; herdr records the one typed (#138).
 const ref = "[Photo attached via Herdr Gram message g1. Download it with `herdr gram get-file g1 -o /tmp/herdr-photo-g1.png`, then inspect /tmp/herdr-photo-g1.png.]";
 for (const typed of ["look ", "look\n", "look\t", "look\r\n", "  look"]) {
  const out = sent(typed.trim(), { files: photo1 });
  expect(ids(reconcileOutgoing([out], new Set(), [user("u1", typed + "\n\n" + ref)], 0))).toEqual([]);
 }
 // A longer word that starts with the caption is not it.
 expect(ids(reconcileOutgoing([sent("look", { files: photo1 })], new Set(), [user("u2", "lookup\n\n" + ref)], 0))).toEqual(["look"]);
});

test("an accepted prompt still unseen after its minute says so; one still sending waits", () => {
 const out = reconcileOutgoing([sent("a"), sent("b", { state: "sending" })], new Set(), [], 60_000);
 expect(out.map(o => o.state)).toEqual(["notSeen", "sending"]);
 expect(reconcileOutgoing([sent("a")], new Set(), [], 59_999)[0]!.state).toBe("submitted");
 // Seen late, it still leaves.
 expect(ids(reconcileOutgoing([sent("a", { state: "notSeen" })], new Set(), [user("u9", "a")], 70_000))).toEqual([]);
});
