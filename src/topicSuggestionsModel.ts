// An agent's topic suggestions, the Organise proposals and the owner's Topics switch, kept free of
// the DOM so bun tests them (herdrup #788: ChatTopicSuggestion.swift, ChatView.swift ChatRow.rows
// and setListedSuggestions, TopicsView.swift proposals, TopicsSwitch.swift; herdr #489, #490).

import type { AgentTopicSuggestionInfo } from "./mygo";
import type { ChatRow, Entry } from "./interactionModel";

export type SuggestionState = "open" | "accepted" | "dismissed" | "unknown";

/** One suggestion as the chat draws it (TranscriptTopicSuggestion). */
export interface ChatSuggestion {
 id: string; title: string; reason: string; messageIDs: string[]; messageCount: number;
 state: SuggestionState; topicID?: string; by?: string;
}

/** The chat's rows for suggestions: the card or line of one suggestion, and the quiet "<TITLE>
 *  STARTS HERE" mark above the first message an open one picked. */
export type SuggestionRow =
 | { kind: "suggestion"; id: string; suggestion: ChatSuggestion }
 | { kind: "mark"; id: string; suggestionID: string; title: string };

/** "Untitled topic" for a suggestion without a title. */
export function suggestionTitle(title: string): string {
 return title.trim() === "" ? "Untitled topic" : title;
}

/** A `topic_suggestion` entry, read leniently (AgentTranscript.swift): message_count wins over the
 *  ids it sends, the ids are counted without it, and a state this build does not know is
 *  "unknown" (drawn as nothing). */
export function suggestionFromEntry(e: Entry): ChatSuggestion {
 const ids = Array.isArray(e.message_ids) ? (e.message_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
 const count = typeof e.message_count === "number" ? e.message_count : ids.length;
 const state = e.state === "open" || e.state === "accepted" || e.state === "dismissed" ? e.state : "unknown";
 const s: ChatSuggestion = { id: e.id, title: typeof e.title === "string" ? e.title : "", reason: typeof e.reason === "string" ? e.reason : "", messageIDs: ids, messageCount: count, state };
 if (typeof e.topic_id === "string" && e.topic_id) s.topicID = e.topic_id;
 if (typeof e.by === "string" && e.by) s.by = e.by;
 return s;
}

/** An open suggestion from `agent.topics.list`, before its transcript entry arrives. */
export function suggestionFromList(s: AgentTopicSuggestionInfo): ChatSuggestion {
 const ids = s.message_ids ?? [];
 return { id: s.suggestion_id, title: s.title, reason: s.reason ?? "", messageIDs: ids, messageCount: ids.length, state: "open" };
}

/** "12 earlier messages come along"; "1 earlier message comes along". */
export function carriedText(count: number): string {
 return count === 1 ? "1 earlier message comes along" : `${count} earlier messages come along`;
}

/** The faint line of a suggestion set aside, naming who did when it was not the owner. */
export function dismissedText(s: ChatSuggestion): string {
 const who = s.by && s.by !== "owner" ? ` · set aside by ${s.by}` : "";
 return `Not now: ${suggestionTitle(s.title)}${who}`;
}

/** A suggestion this reader started or set aside, shown at once, and when its call returned (ms). */
export interface Settled { suggestion: ChatSuggestion; at: number }

/** The local line after a Start or Not now went through (ChatModel.settleLocally): the suggestion
 *  as last known, from the list or the transcript, in its new state. Null when it is not known. */
export function settledLine(id: string, state: "accepted" | "dismissed", topicID: string | undefined, listed: readonly AgentTopicSuggestionInfo[], entries: readonly Entry[], at: number): Settled | null {
 const fromList = listed.find(s => s.suggestion_id === id);
 const entry = [...entries].reverse().find(e => e.kind === "topic_suggestion" && e.id === id);
 const known = fromList ? suggestionFromList(fromList) : entry ? suggestionFromEntry(entry) : null;
 if (!known) return null;
 const suggestion: ChatSuggestion = { ...known, state, by: "owner" };
 if (topicID) suggestion.topicID = topicID; else delete suggestion.topicID;
 return { suggestion, at };
}

/** One `agent.topics.list` answer, asked for at requestedMs (ChatModel.setListedSuggestions): a
 *  list asked for after a local line was recorded is the server's word, so a suggestion it still
 *  lists open drops its local line and shows its card again. */
export function yieldSettled(settled: ReadonlyMap<string, Settled>, listed: readonly AgentTopicSuggestionInfo[], requestedMs: number): Map<string, Settled> {
 const next = new Map(settled);
 for (const s of listed) {
  const local = next.get(s.suggestion_id);
  if (local && local.at < requestedMs) next.delete(s.suggestion_id);
 }
 return next;
}

/** The Inbox's rows with its suggestions (ChatRow.rows): each `topic_suggestion` entry drawn once,
 *  where it first appears, in its newest state (an after page re-sends it under the same id); a
 *  mark above the first message each open one picked; then the reader's local lines for
 *  suggestions the transcript does not hold yet, then the listed open ones it does not hold. An
 *  entry in a state this build does not know draws nothing. */
export function inboxRows(rows: readonly ChatRow[], listed: readonly AgentTopicSuggestionInfo[], settled: ReadonlyMap<string, Settled>): (ChatRow | SuggestionRow)[] {
 const newest = new Map<string, ChatSuggestion>();
 for (const row of rows) if (row.kind === "entry" && row.entry.kind === "topic_suggestion") newest.set(row.entry.id, suggestionFromEntry(row.entry));
 const local = [...settled.entries()].filter(([id]) => !newest.has(id)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, s]) => s.suggestion);
 const pending = listed.filter(s => !newest.has(s.suggestion_id) && !settled.has(s.suggestion_id)).map(suggestionFromList);
 const marks = new Map<string, SuggestionRow>();
 for (const s of [...newest.values()].filter(s => s.state === "open").concat(pending)) {
  const first = s.messageIDs[0];
  if (first !== undefined && !marks.has(first)) marks.set(first, { kind: "mark", id: `mark:${s.id}`, suggestionID: s.id, title: s.title });
 }
 const out: (ChatRow | SuggestionRow)[] = [];
 const drawn = new Set<string>();
 for (const row of rows) {
  if (row.kind === "entry" && row.entry.kind === "topic_suggestion") {
   const s = newest.get(row.entry.id)!;
   if (drawn.has(s.id) || s.state === "unknown") continue;
   drawn.add(s.id);
   out.push({ kind: "suggestion", id: row.id, suggestion: s });
   continue;
  }
  const mark = marks.get(row.id);
  if (mark) out.push(mark);
  out.push(row);
 }
 for (const s of [...local, ...pending]) out.push({ kind: "suggestion", id: s.id, suggestion: s });
 return out;
}

// ---- Organise (TopicsView.swift proposals) ----

/** Whether a proposal is ticked: all are, until the reader unticks one. */
export function isTicked(unticked: ReadonlySet<string>, id: string): boolean {
 return !unticked.has(id);
}
/** The proposals ticked now: what Create N topics starts. */
export function tickedCount(suggestions: readonly AgentTopicSuggestionInfo[], unticked: ReadonlySet<string>): number {
 return suggestions.filter(s => isTicked(unticked, s.suggestion_id)).length;
}
/** "Create 1 topic", "Create 3 topics". */
export function createLabel(count: number): string {
 return count === 1 ? "Create 1 topic" : `Create ${count} topics`;
}
/** Create N topics: the ticked proposals start topics, the rest are set aside. */
export function settlePlan(suggestions: readonly AgentTopicSuggestionInfo[], unticked: ReadonlySet<string>): { accept: string[]; dismiss: string[] } {
 const accept: string[] = [], dismiss: string[] = [];
 for (const s of suggestions) (isTicked(unticked, s.suggestion_id) ? accept : dismiss).push(s.suggestion_id);
 return { accept, dismiss };
}
/** The unticks that still name an open proposal. */
export function keptUnticks(unticked: ReadonlySet<string>, suggestions: readonly AgentTopicSuggestionInfo[]): Set<string> {
 const open = new Set(suggestions.map(s => s.suggestion_id));
 return new Set([...unticked].filter(id => open.has(id)));
}
/** Organise has answered once a proposal arrives that the list did not hold before. */
export function organiseAnswered(before: readonly AgentTopicSuggestionInfo[], after: readonly AgentTopicSuggestionInfo[]): boolean {
 const held = new Set(before.map(s => s.suggestion_id));
 return after.some(s => !held.has(s.suggestion_id));
}
/** How long Organise shows as running once the agent took it: agent.topics.organise only says the
 *  turn started (or is queued), and a turn that proposes nothing is a finished Organise with no
 *  event to say so (herdrup #797). After this the button works again; a second Organise while the
 *  first still runs gets the server's organise_running. */
export const ORGANISE_WAIT_MS = 3 * 60_000;

/** Organise is over: new proposals arrived, or its wait ran out. */
export function organiseOver(before: readonly AgentTopicSuggestionInfo[], after: readonly AgentTopicSuggestionInfo[], answeredMs: number, nowMs: number): boolean {
 return organiseAnswered(before, after) || nowMs - answeredMs >= ORGANISE_WAIT_MS;
}
/** What Organise is doing once it started. */
export function organiseNote(queued: boolean): string {
 return queued ? "Organise starts when the agent's current turn ends." : "The agent is reading the Inbox to propose topics.";
}
/** "Suggested by docs"; "Suggested by the agent" without a name (sentence case, Topics A-v2). */
export function proposalsHeading(agent: string): string {
 return agent.trim() === "" ? "Suggested by the agent" : `Suggested by ${agent.trim()}`;
}
/** A proposal's message count: "1 msg", "4 msgs", nothing for none. */
export function messagesText(count: number): string | null {
 return count <= 0 ? null : count === 1 ? "1 msg" : `${count} msgs`;
}

// ---- The owner's Topics switch (TopicsSwitch.swift) ----

/** One switch request: the agent as its row shows it, and whether topics go on. */
export interface SwitchRequest { paneID: string; title: string; enable: boolean }

export function switchTitle(r: SwitchRequest): string {
 return r.enable ? `Turn on topics for ${r.title}?` : `Turn off topics for ${r.title}?`;
}
export function switchMessage(r: SwitchRequest): string {
 return r.enable
  ? "herdr restarts it on the omp build with topics. Its conversation and name stay."
  : "herdr restarts it on the standard omp build. Its conversation and name stay; its topics stay saved.";
}
export function switchAction(r: SwitchRequest): string {
 return r.enable ? "Restart with topics" : "Restart without topics";
}

/** The switch at work, or how it ended (TopicsSwitchStatus). */
export type SwitchStatus =
 | { kind: "working"; request: SwitchRequest }
 | { kind: "done"; request: SwitchRequest; changed: boolean }
 | { kind: "failed"; request: SwitchRequest; why: string };

/** The banner's words. */
export function switchStatusText(s: SwitchStatus): string {
 const { enable, title } = s.request;
 switch (s.kind) {
  case "working": return enable ? `Restarting ${title} with topics…` : `Restarting ${title} without topics…`;
  case "done":
   if (!s.changed) return enable ? `Topics were already on for ${title}.` : `Topics were already off for ${title}.`;
   return enable ? `Topics are on for ${title}.` : `Topics are off for ${title}.`;
  case "failed": return (enable ? "Couldn't turn on topics: " : "Couldn't turn off topics: ") + s.why;
 }
}
