import { expect, test } from "bun:test";
import { reconcileOutgoing, sendShown, type Outgoing } from "../src/chatPoll";
import { cursorExpired, groupTranscript, liveEntries, mergeNewest, mergeOlder, mergeTranscript, readLive, replayUnknown, rereadMerge, type Entry, type TranscriptPage } from "../src/interactionModel";
import { HerdrAPIError } from "../src/webguest/errors";

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
 // herdr #454 lists the entries it re-sent before the cursor.
 const merged = mergeTranscript(newest, page, { resent: resent.map(e => e.id) });
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
 const merged = mergeTranscript(mergeTranscript(newest, [...resent, ...appended], { resent: resent.map(e => e.id) }), resent.slice(0, 3), { older: true });
 expect(merged.slice(0, 4).map(e => e.id)).toEqual(["abe83412", "f505eb3c", "23cbfb00", "a7902a04"]);
});

test("a first page or a new session is taken whole", () => {
 expect(liveEntries([], resent)).toEqual(resent);
});

// The same page from a server before herdr #454 (no `resent`) can't tell those replays from new
// prompts, so the chat reads the newest page instead, and merges it by position: the wall stays out
// and nothing new is lost.
test("without resent, the page that may re-send unloaded prompts is read again as the newest page", () => {
 const live: TranscriptPage = { after: "a2", session_id: "s", entries: [...resent, ...appended] };
 expect(replayUnknown(newest, live, true)).toBe(true);
 expect(mergeNewest(newest, [...newest, ...appended])!.map(e => e.id)).toEqual([...newest, ...appended].map(e => e.id));
});

// herdrup #707 (web counterpart of #686/#691): the after cursor moves past every entry of a live
// page, so one dropped is lost until a reload. herdrup #736: without `resent` nothing is dropped.
const at = (id: string, ts_ms: number | undefined, kind = "reply", extra: Partial<Entry> = {}): Entry => ({ id, kind, text: "x", ...(ts_ms === undefined ? {} : { ts_ms }), ...extra }) as Entry;
const held = [at("u", 2000, "user", { author: "owner" })];

test("without resent, new entries behind the window or without ts_ms are kept", () => {
 expect(mergeTranscript(held, [at("r1", 1999), at("r2", 0), at("r3", undefined)]).map(e => e.id)).toEqual(["u", "r1", "r2", "r3"]);
});

// herdrup #736, the reviewer's shape: held owner prompt u@2000 with older history unloaded, then a
// new guest prompt g@1999 (clock skew) and its reply r@2001, from a server without `resent`. The
// old timestamp guess dropped g and the cursor moved past it: r hung under u.
test("without resent, a new guest prompt behind the window is not lost", () => {
 const g = at("g", 1999, "user", { author: "guest", origin: "other" }), r = at("r", 2001);
 const live: TranscriptPage = { after: "a2", session_id: "s", entries: [g, r] };
 expect(replayUnknown(held, live, true)).toBe(true);
 expect(mergeTranscript(held, live.entries).map(e => e.id)).toEqual(["u", "g", "r"]);
 // The newest page the chat reads instead holds the tail in conversation order.
 expect(mergeNewest(held, [held[0]!, g, r])!.map(e => e.id)).toEqual(["u", "g", "r"]);
});

test("only an unknown older origin-marked prompt with history unloaded asks for the newest page", () => {
 const page = (entries: Entry[], resent?: string[]): TranscriptPage => ({ after: "a2", session_id: "s", entries, ...(resent ? { resent } : {}) });
 const old = at("old", 1999, "user", { author: "guest", origin: "other" });
 expect(replayUnknown(held, page([old]), false)).toBe(false);
 expect(replayUnknown(held, page([old], []), true)).toBe(false);
 expect(replayUnknown(held, page([at("r", 1999), at("p", 1000, "user", { author: "owner" }), at("z", 0, "user", { origin: "other" })]), true)).toBe(false);
 expect(replayUnknown(held, page([at("new", 2001, "user", { origin: "other" })]), true)).toBe(false);
 expect(replayUnknown([at("u", 2000, "user"), old], page([old]), true)).toBe(false);
});

test("the newest page merges by position: older entries above, new ones below; no overlap starts over", () => {
 const older = at("o", 1000, "user", { author: "owner" }), g = at("g", 1999, "user", { origin: "other" });
 expect(mergeNewest(held, [older, held[0]!, g])!.map(e => e.id)).toEqual(["o", "u", "g"]);
 expect(mergeNewest(held, [at("x", 5000), at("y", 5001)])).toBeNull();
 expect(mergeNewest([], [g])!.map(e => e.id)).toEqual(["g"]);
});

// herdr #452 / herdrup #710: an after page that lists its re-sent entries says exactly which are
// replays. Listed and not held: dropped (an older page brings them). Listed and held: updated in
// place. Unlisted: new and appended, whatever the timestamp or origin.
test("with resent listed, only listed entries the chat doesn't hold are dropped", () => {
 const page = [
  at("u", 2000, "user", { author: "owner", origin: "other" }),
  at("old", 1999, "user", { author: "guest", origin: "other" }),
  at("marked", 1500, "user", { author: "guest", origin: "other" }),
  at("r", 0),
 ];
 const merged = mergeTranscript(held, page, { resent: ["u", "old"] });
 expect(merged.map(e => e.id)).toEqual(["u", "marked", "r"]);
 expect(merged[0]!.origin).toBe("other");
});

test("an empty resent list keeps every entry", () => {
 const page = [at("old", 1999, "user", { author: "guest", origin: "other" })];
 expect(mergeTranscript(held, page, { resent: [] }).map(e => e.id)).toEqual(["u", "old"]);
});

// herdrup-desktop #242: the page read again keeps the ambiguous page's updates to held entries. A
// held prompt newly marked origin "other" arrives only once, on that page: the newest page may not
// reach it, and the cursor moves past it.
test("the re-read keeps the ambiguous page's updates to held entries", () => {
 const prompt = at("p", 1500, "user", { author: "owner" }), u = at("u", 2000, "user", { author: "owner" });
 const marked = at("p", 1500, "user", { author: "guest", origin: "other" }), replay = at("old", 900, "user", { author: "guest", origin: "other" });
 const merged = rereadMerge([prompt, u], [replay, marked], [u, at("r", 2100)])!;
 expect(merged.map(e => e.id)).toEqual(["p", "u", "r"]);
 expect(merged[0]!.origin).toBe("other");
 // A newest page that shares nothing starts the chat over, as mergeNewest does.
 expect(rereadMerge([prompt, u], [marked], [at("x", 5000)])).toBeNull();
});

// readLive is the live read of both the agent's chat and a topic's (#749 review F2): the captured
// replay above, from a server without `resent`, is read again as the newest page; the old prompts
// stay out and the new turn is kept.
test("a live read re-reads the newest page when an after page may replay unloaded prompts", async () => {
 const reads: string[] = [];
 const pages: Record<string, TranscriptPage> = {
  a1: { after: "a2", session_id: "s", entries: [...resent, ...appended] },
  "": { after: "a2", session_id: "s", entries: [...newest, ...appended] },
 };
 const live = await readLive({ after: "a1", session_id: "s", entries: [] }, () => ({ entries: newest, hasOlder: true }), async after => { reads.push(after); return pages[after]!; }, () => true);
 expect(reads).toEqual(["a1", ""]);
 expect(live!.reset).toBe(false);
 expect(live!.entries.map(e => e.id)).toEqual([...newest, ...appended].map(e => e.id));
});

test("a live read takes a new session whole, and stops on a stale reply", async () => {
 const fresh: TranscriptPage = { after: "b1", session_id: "t", entries: appended };
 const live = await readLive({ after: "a1", session_id: "s", entries: [] }, () => ({ entries: newest, hasOlder: true }), async () => fresh, () => true);
 expect([live!.reset, live!.entries.map(e => e.id)]).toEqual([true, appended.map(e => e.id)]);
 expect(await readLive({ after: "a1", session_id: "s", entries: [] }, () => ({ entries: newest, hasOlder: true }), async () => null, () => true)).toBeNull();
});

// #253: history loaded while a live read waits on the network is the chat's entries when the reply
// is applied; the merge starts from them, not from what the chat held when the read began.
test("a live read merges into the entries held when its reply arrives, keeping history loaded meanwhile", async () => {
 const history: Entry[] = [{ kind: "user", id: "h1", ts_ms: 1, text: "older" }];
 const tail: Entry[] = [{ kind: "reply", id: "t1", ts_ms: 2, text: "tail" }];
 const fresh: Entry[] = [{ kind: "reply", id: "n1", ts_ms: 3, text: "new" }];
 let entries = tail;
 const live = await readLive({ after: "a1", session_id: "s", entries: tail }, () => ({ entries, hasOlder: false }), async () => {
  entries = [...history, ...tail]; // "Earlier messages" finished during the request
  return { after: "a2", session_id: "s", entries: fresh, resent: [] };
 }, () => true);
 expect(live!.entries.map(e => e.id)).toEqual(["h1", "t1", "n1"]);
});

// herdr 31bd88e6 projects held entries otherwise, so a cursor read before the update fails its
// hash check: cursor_expired ("reload the newest page"). The chat read held.after forever and
// showed the error. Now the read starts over from the newest page, the held history dropped.
const EXPIRED = "herdr: cursor_expired: the transcript changed under this cursor; reload the newest page";
test("a live read whose cursor herdr expired starts over from the newest page", async () => {
 for (const expired of [new Error(EXPIRED), new HerdrAPIError("cursor_expired", "the transcript changed under this cursor; reload the newest page", {})]) {
  const reads: string[] = [];
  const held: Entry[] = [{ kind: "reply", id: "old", ts_ms: 1, text: "projected before the update" }];
  const fresh: Entry[] = [{ kind: "reply", id: "n1", ts_ms: 2, text: "newest" }];
  const live = await readLive({ after: "a1", session_id: "s", entries: held }, () => ({ entries: held, hasOlder: true }), async after => {
   reads.push(after);
   if (after) throw expired;
   return { after: "a2", before: "b2", session_id: "s", entries: fresh };
  }, () => true);
  expect(reads).toEqual(["a1", ""]);
  expect([live!.reset, live!.page.after, live!.page.before, live!.entries]).toEqual([true, "a2", "b2", fresh]);
 }
 // Another failure is the read's, and a newest page's read has no cursor to expire.
 await expect(readLive({ after: "a1", session_id: "s", entries: [] }, () => ({ entries: [], hasOlder: false }), async () => { throw new Error("herdr: owner_forbidden: no"); }, () => true)).rejects.toThrow("owner_forbidden");
 await expect(readLive(null, () => ({ entries: [], hasOlder: false }), async () => { throw new Error(EXPIRED); }, () => true)).rejects.toThrow("cursor_expired");
 expect([cursorExpired(new Error(`Chat: ${EXPIRED}`)), cursorExpired(new Error("herdr: owner_forbidden: cursor_expired")), cursorExpired("cursor_expired")]).toEqual([true, false, false]);
});
// #560 review: the chat owns its restart. readLive marks it (restart) before it reads the newest
// page, so a failed newest-page read leaves the next poll starting over too, never resending the
// expired cursor; a read that no longer owns the chat (Refresh or a later poll took over) reads
// nothing more.
test("a live read whose cursor herdr expired marks the chat to start over, and reads no newest page once superseded", async () => {
 const held: TranscriptPage = { after: "a1", session_id: "s", entries: [] };
 const reads: string[] = [];
 let restarts = 0;
 await expect(readLive(held, () => ({ entries: [], hasOlder: false }), async after => {
  reads.push(after);
  throw new Error(after ? EXPIRED : "herdr: owner_forbidden: no");
 }, () => { restarts++; return true; })).rejects.toThrow("owner_forbidden");
 expect([reads, restarts]).toEqual([["a1", ""], 1]);
 reads.length = 0;
 expect(await readLive(held, () => ({ entries: [], hasOlder: false }), async after => { reads.push(after); throw new Error(EXPIRED); }, () => false)).toBeNull();
 expect(reads).toEqual(["a1"]);
});
// #560 review: on the web the desk's HerdrAPIError carries herdr's code; cursorExpired reads it
// there, not the text it shows.
test("a web HerdrAPIError is read by its code, not its text", async () => {
 const reworded = new HerdrAPIError("cursor_expired", "the transcript changed under this cursor; reload the newest page", {});
 reworded.message = "Couldn't read the transcript.";
 const other = new HerdrAPIError("not_found", "no such pane", {});
 other.message = EXPIRED;
 expect([cursorExpired(reworded), cursorExpired(other)]).toEqual([true, false]);
});
// #555: herdr may leave relay_entries off a fallback page (the handover as the user entry it was
// sent as) and set it on a later page of the same session (a relay entry), or the other way. A
// page that shows handovers otherwise than the held history drops it and starts over from the
// newest page, in both directions; an older page in the other representation is never merged.
const asUser: Entry[] = [{ kind: "user", id: "u1", ts_ms: 1, text: "<irc from=\"inbox\">look at this</irc>" }, { kind: "reply", id: "r1", ts_ms: 2, text: "ok" }];
const asRelay: Entry[] = [{ kind: "relay", id: "u1", ts_ms: 1, from: "Inbox", direction: "to_topic", text: "look at this" }, { kind: "reply", id: "r1", ts_ms: 2, text: "ok" }];
const later: Entry[] = [{ kind: "reply", id: "r2", ts_ms: 3, text: "more" }];
for (const [name, heldRelays, held, newest] of [["plain to relay", false, asUser, asRelay], ["relay to plain", true, asRelay, asUser]] as const) {
 test(`a live read starts over from the newest page when the handovers change ${name}`, async () => {
  const reads: string[] = [];
  const pages: Record<string, TranscriptPage> = {
   a1: { after: "a2", session_id: "s", entries: later, resent: [], relay_entries: !heldRelays },
   "": { after: "a2", session_id: "s", entries: [...newest, ...later], relay_entries: !heldRelays },
  };
  let restarts = 0;
  const live = await readLive({ after: "a1", session_id: "s", entries: held, relay_entries: heldRelays }, () => ({ entries: held, hasOlder: true }), async after => { reads.push(after); return pages[after]!; }, () => { restarts++; return true; });
  expect(restarts).toBe(1);
  expect(reads).toEqual(["a1", ""]);
  expect(live!.reset).toBe(true);
  expect(live!.entries).toEqual([...newest, ...later]);
 });

 test(`an older page is not merged when the handovers change ${name}`, () => {
  const chat: TranscriptPage = { after: "a2", session_id: "s", entries: later, relay_entries: !heldRelays };
  expect(mergeOlder(chat, later, { after: "", before: "b1", session_id: "s", entries: held, relay_entries: heldRelays })).toBeNull();
  expect(mergeOlder(chat, later, { after: "", before: "b1", session_id: "s", entries: newest, relay_entries: !heldRelays })).toEqual([...newest, ...later]);
 });
}
