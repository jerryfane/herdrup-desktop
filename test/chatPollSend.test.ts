import { expect, test } from "bun:test";
import { sendShown } from "../src/chatPoll";
import { mergeTranscript, type Entry } from "../src/interactionModel";

const user = (id: string, ts_ms: number): Entry => ({ kind: "user", id, ts_ms, text: id });
const reply = (id: string, ts_ms: number): Entry => ({ kind: "reply", id, ts_ms, text: id });

/** One refreshChat read: what the page held before it, and the entries after the merge. */
function read(entries: Entry[], page: Entry[]) {
 const held = new Set(entries.map(entry => entry.id));
 return { shown: sendShown(held, page), entries: mergeTranscript(entries, page) };
}

// Post-merge review of #103 (F2): "Earlier messages" prepends older user entries, which the old
// count of retained user entries took for the unseen send, dropping the poll to 30 s.
test("older history loaded after a send does not acknowledge it", () => {
 let entries = [user("u5", 5), reply("r5", 6)];
 // The send; then the user loads earlier messages, with two older prompts.
 entries = mergeTranscript(entries, [user("u3", 3), reply("r3", 4)], true);
 entries = mergeTranscript(entries, [user("u1", 1), reply("r1", 2)], true);
 // The live tail brings only an updated reply: the prompt is still unseen.
 const tail = read(entries, [{ ...reply("r5", 6), text: "edited" }]);
 expect(tail.shown).toBe(false);
 // The prompt shows up in the tail.
 expect(read(tail.entries, [user("u7", 7)]).shown).toBe(true);
});

test("a user entry the page already held is not the send", () => {
 const entries = [user("u1", 1), reply("r1", 2)];
 expect(read(entries, [{ ...user("u1", 1), text: "rewritten" }, reply("r2", 3)]).shown).toBe(false);
 expect(read(entries, [reply("r2", 3), user("u2", 4)]).shown).toBe(true);
});
