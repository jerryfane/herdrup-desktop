import { expect, test } from "bun:test";
import { reconcileOutgoing, sendShown, type Outgoing } from "../src/chatPoll";
import { groupTranscript, liveEntries, mergeTranscript, type Entry } from "../src/interactionModel";

// Captured 2026-11-15 from a live host (herdr 0.9.5) for enyo, shared with a guest; ids and
// timestamps are real, text replaced (herdrup #684's fixture). When the pane's remembered
// non-owner prompts change, the `after` page re-sends every earlier user entry now marked
// origin "other", back to the start of the session (herdr resend_origins). The chat appended
// the ones it had not loaded after the newest turn: a wall of old prompts with no replies.
const user = (id: string, ts_ms: number, text: string, guest: boolean): Entry => ({ id, ts_ms, kind: "user", text, ...(guest ? { author: "guest", author_name: "nike", origin: "other" } : { author: "owner" }) }) as Entry;
const reply = (id: string, ts_ms: number, text: string): Entry => ({ id, ts_ms, kind: "reply", text }) as Entry;
const end = (id: string, ts_ms: number): Entry => ({ id, ts_ms, kind: "turn_end", status: "done" }) as Entry;
const newest = [
 user("a7902a04", 1_794_753_108_363, "Send the latest file again", false),
 reply("c2592b34:reply", 1_794_753_112_999, "Sent."),
 end("c2592b34:end", 1_794_753_115_998),
 user("bcf1ae30", 1_794_753_889_379, "Comments should stay visible", true),
 reply("b46a7d09:reply", 1_794_753_900_013, "Added."),
 end("b46a7d09:end", 1_794_753_904_047),
];
const resent = [
 user("abe83412", 1_794_665_461_081, "Proposals v7: my comments", true),
 user("f505eb3c", 1_794_674_624_471, "When will it be ready?", true),
 user("23cbfb00", 1_794_735_060_803, "I received the email", true),
 user("bcf1ae30", 1_794_753_889_379, "Comments should stay visible", true),
];
const appended = [
 user("b2f25ccb", 1_794_754_423_482, "Tell me when it is ready", true),
 { id: "2db84f2f:thinking", ts_ms: 1_794_754_423_554, kind: "thinking", text: "Noting it." } as Entry,
 { id: "2db84f2f:toolu_015EWurddNboHwrfLZKfJmEh", ts_ms: 1_794_754_423_554, kind: "step", tool: "todo", intent: "Noting it", status: "ok" } as Entry,
 reply("63568b78:reply", 1_794_754_428_208, "I'll tell you."),
 end("63568b78:end", 1_794_754_431_057),
];

test("a live page re-sending older marked prompts does not append them after the newest turn", () => {
 const page = [...resent, ...appended];
 const merged = mergeTranscript(newest, page);
 expect(merged.map(e => e.id)).toEqual([
  "a7902a04", "c2592b34:reply", "c2592b34:end", "bcf1ae30", "b46a7d09:reply", "b46a7d09:end",
  "b2f25ccb", "2db84f2f:thinking", "2db84f2f:toolu_015EWurddNboHwrfLZKfJmEh", "63568b78:reply", "63568b78:end",
 ]);
 // The held prompt the page re-sends is replaced in place, so it takes the page's copy.
 expect(merged[3]).toBe(resent[3]!);
 // The chat ends in the newest prompt, its work and its reply, not a stack of old prompts.
 expect(groupTranscript(merged, false).slice(-3).map(r => r.kind === "entry" ? r.entry.id : r.kind)).toEqual(["b2f25ccb", "work", "63568b78:reply"]);
 // An old prompt of the same guest with the same words is not the send in flight.
 const outgoing: Outgoing = { id: "outgoing:1", text: "When will it be ready?", files: [], guest: "nike", state: "sending", until: Number.MAX_SAFE_INTEGER };
 const held = new Set(newest.map(e => e.id));
 // refreshChat reads the merged entries against what it held before the read.
 expect(reconcileOutgoing([outgoing], held, merged, 0).map(o => o.id)).toEqual(["outgoing:1"]);
 expect(sendShown(held, merged.filter(e => e.id !== "b2f25ccb"))).toBe(false);
});

test("an older page still brings the history a live page skipped", () => {
 const merged = mergeTranscript(mergeTranscript(newest, [...resent, ...appended]), resent.slice(0, 3), true);
 expect(merged.slice(0, 4).map(e => e.id)).toEqual(["abe83412", "f505eb3c", "23cbfb00", "a7902a04"]);
});

test("a first page or a new session is taken whole", () => {
 expect(liveEntries([], resent)).toEqual(resent);
});
