// Topic suggestions, Organise and the Topics switch (src/topicSuggestionsModel.ts), against herdrup
// #788: ChatView.swift ChatRow.rows / setListedSuggestions, ChatTopicSuggestion.swift, TopicsView.swift
// proposals and TopicsSwitch.swift. Every fixture is synthetic.
import { expect, test } from "bun:test";
import type { ChatRow, Entry } from "../src/interactionModel";
import type { AgentTopicSuggestionInfo } from "../src/mygo";
import { carriedText, createLabel, dismissedText, inboxRows, keptUnticks, messagesText, ORGANISE_WAIT_MS, organiseAnswered, organiseNote, organiseOver, proposalsHeading, settledLine, settlePlan, suggestionFromEntry, switchStatusText, switchTitle, tickedCount, yieldSettled, type Settled } from "../src/topicSuggestionsModel";

const entry = (e: Partial<Entry> & { id: string; kind: string }): ChatRow => ({ kind: "entry", id: e.id, entry: { ts_ms: 1, ...e } as Entry });
const suggestion = (id: string, state: string, extra: Record<string, unknown> = {}) => entry({ kind: "topic_suggestion", id, title: "iPad build times", reason: "40 min", message_ids: ["u1", "r1"], message_count: 12, state, ...extra });
const listed = (id: string, ids = ["u2"]): AgentTopicSuggestionInfo => ({ suggestion_id: id, title: "Guest invites", reason: "", message_ids: ids, created_unix_ms: 1 });
const kinds = (rows: { kind: string; id: string }[]) => rows.map(r => `${r.kind}:${r.id}`);

test("a suggestion entry reads leniently: message_count wins, ids counted without it, an unknown state", () => {
 expect(suggestionFromEntry(suggestion("sg1", "open").kind === "entry" ? (suggestion("sg1", "open") as { entry: Entry }).entry : ({} as Entry)).messageCount).toBe(12);
 expect(suggestionFromEntry({ kind: "topic_suggestion", id: "s", ts_ms: 1, message_ids: ["a", "b", "c"], state: "open" }).messageCount).toBe(3);
 expect(suggestionFromEntry({ kind: "topic_suggestion", id: "s", ts_ms: 1, state: "merged" }).state).toBe("unknown");
});

test("the newest state wins by id: one row, where the entry first appears, with a mark above its first message only while open", () => {
 const rows = [entry({ kind: "user", id: "u1" }), entry({ kind: "reply", id: "r1", text: "hi" }), suggestion("sg1", "open"), suggestion("sg1", "accepted", { topic_id: "t9" })];
 const out = inboxRows(rows, [], new Map());
 expect(kinds(out)).toEqual(["entry:u1", "entry:r1", "suggestion:sg1"]);
 expect((out[2] as { suggestion: { state: string; topicID?: string } }).suggestion).toMatchObject({ state: "accepted", topicID: "t9" });
 const open = inboxRows([entry({ kind: "user", id: "u1" }), suggestion("sg1", "open")], [], new Map());
 expect(kinds(open)).toEqual(["mark:mark:sg1", "entry:u1", "suggestion:sg1"]);
 expect(kinds(inboxRows([suggestion("sg1", "merged")], [], new Map()))).toEqual([]);
});

test("a listed suggestion shows at the end until its entry arrives; a local line hides it, and yields to a later list", () => {
 const rows = [entry({ kind: "user", id: "u2" })];
 expect(kinds(inboxRows(rows, [listed("sg2")], new Map()))).toEqual(["mark:mark:sg2", "entry:u2", "suggestion:sg2"]);
 const local = settledLine("sg2", "dismissed", undefined, [listed("sg2")], [], 100)!;
 const settled = new Map<string, Settled>([["sg2", local]]);
 const shown = inboxRows(rows, [listed("sg2")], settled);
 expect(kinds(shown)).toEqual(["entry:u2", "suggestion:sg2"]);
 expect((shown[1] as { suggestion: { state: string } }).suggestion.state).toBe("dismissed");
 expect(yieldSettled(settled, [listed("sg2")], 50).has("sg2")).toBe(true);
 expect(yieldSettled(settled, [listed("sg2")], 150).has("sg2")).toBe(false);
 expect(yieldSettled(settled, [], 150).has("sg2")).toBe(true);
});

test("words: the count, the Not now line and the switch", () => {
 expect(carriedText(1)).toBe("1 earlier message comes along");
 expect(carriedText(12)).toBe("12 earlier messages come along");
 expect(dismissedText({ id: "s", title: "T", reason: "", messageIDs: [], messageCount: 0, state: "dismissed", by: "plotarmordev" })).toBe("Not now: T · set aside by plotarmordev");
 expect(dismissedText({ id: "s", title: "", reason: "", messageIDs: [], messageCount: 0, state: "dismissed", by: "owner" })).toBe("Not now: Untitled topic");
 const request = { paneID: "w1:p2", title: "docs", enable: true };
 expect(switchTitle(request)).toBe("Turn on topics for docs?");
 expect(switchStatusText({ kind: "done", request, changed: false })).toBe("Topics were already on for docs.");
 expect(switchStatusText({ kind: "failed", request, why: "x" })).toBe("Couldn't turn on topics: x");
});

test("Create N is the ticked count; the plan accepts the ticked and dismisses the rest", () => {
 const all = [listed("a"), listed("b"), listed("c")];
 expect(tickedCount(all, new Set(["b"]))).toBe(2);
 expect(createLabel(1)).toBe("Create 1 topic");
 expect(createLabel(2)).toBe("Create 2 topics");
 expect(settlePlan(all, new Set(["b"]))).toEqual({ accept: ["a", "c"], dismiss: ["b"] });
});

test("Organise: answered by a new proposal only, unticks kept while open, and the list's words", () => {
 expect(organiseAnswered([listed("sg1")], [listed("sg1")])).toBe(false);
 expect(organiseAnswered([listed("sg1")], [listed("sg1"), listed("sg2")])).toBe(true);
 expect(organiseAnswered([listed("sg1"), listed("sg2")], [listed("sg2")])).toBe(false);
 expect([...keptUnticks(new Set(["sg1", "sg9"]), [listed("sg1"), listed("sg2")])]).toEqual(["sg1"]);
 expect(organiseNote(true)).toBe("Organise starts when the agent's current turn ends.");
 expect(organiseNote(false)).toBe("The agent is reading the Inbox to propose topics.");
 expect(proposalsHeading(" docs ")).toBe("Suggested by docs");
 expect(proposalsHeading("")).toBe("Suggested by the agent");
 expect([messagesText(0), messagesText(1), messagesText(4)]).toEqual([null, "1 msg", "4 msgs"]);
});

test("Organise is over when new proposals arrive or its wait runs out, not only on a new id (herdrup #797)", () => {
 const t0 = 1_000_000;
 expect(organiseOver([listed("sg1")], [listed("sg1")], t0, t0 + 1000)).toBe(false);
 expect(organiseOver([listed("sg1")], [listed("sg1"), listed("sg2")], t0, t0 + 1000)).toBe(true);
 // A turn that proposed nothing: the same list, or none, once the wait ran out.
 expect(organiseOver([listed("sg1")], [listed("sg1")], t0, t0 + ORGANISE_WAIT_MS)).toBe(true);
 expect(organiseOver([], [], t0, t0 + ORGANISE_WAIT_MS)).toBe(true);
 // Before the agent took it, there is no wait to run out.
 expect(organiseOver([], [], Infinity, t0 + 10 * ORGANISE_WAIT_MS)).toBe(false);
});
