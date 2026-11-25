import type { AskForm, AskFormAnswer, AskFormStatus } from "./askFormModel";
import type { SuggestionRow } from "./topicSuggestionsModel";
export interface Question { question: string; options: string[]; multi: boolean; recommended?: number }
export interface PlanItem { text: string; status?: string; done?: boolean; phase?: string; blocker?: string }
export interface Entry {
 kind: string; id: string; ts_ms: number; text?: string; body?: string; title?: string;
 intent?: string; detail?: string; tool?: string; status?: string; error?: string;
 source?: string; from?: string;
 /** A relay's way (chatRelay.ts): "to_topic" from the Inbox, "to_inbox" from a topic. */
 direction?: string;
 questions?: Question[]; answer?: string[]; items?: PlanItem[];
 /** omp's HTML-form ask (herdr ask-form contract): the form, and once the tool result arrives
  *  its answers and how it ended. */
 form?: AskForm | null; form_answer?: AskFormAnswer[] | null; form_status?: AskFormStatus | null;
 [key: string]: unknown;
}
export interface TranscriptPage {
 after: string; before?: string; session_id: string; entries: Entry[];
 /** On an after page from herdr with #452: the ids of the entries re-sent from before the cursor
  *  (origin-mark replays, changed steps), `[]` when none. Absent on older servers. */
 resent?: string[];
 plan?: PlanItem[] | null;
 /** `dismissable`: this caller may close the ask as cancelled (agent.dismiss_ask, herdr #484);
  *  absent from an older herdr, which offers no Dismiss. */
 pending_ask?: { id: string; answerable: boolean; questions: Question[]; form?: AskForm | null; form_answerable?: boolean; dismissable?: boolean };
 working?: { intent?: string; [key: string]: unknown };
 subagents?: TranscriptSubagent[];
 /** The model omp runs and its effort (herdr TranscriptModel); the newest page's. */
 model?: TranscriptModel | null;
 /** omp's recap of its last finished turn (herdr TranscriptRecap); the newest page's. */
 recap?: TranscriptRecap | null;
}
export interface TranscriptModel { id: string; provider: string; thinking_level?: string | null; thinking_auto?: boolean | null }
export interface TranscriptRecap { turn_id: string; text: string }
/** omp's `task` subagent, as herdr reports it (TranscriptSubagent); a guest gets no `task`. */
export interface TranscriptSubagent {
 id: string; agent?: string; label?: string | null; task?: string | null; status?: string;
 started_ms?: number; finished_ms?: number | null; duration_ms?: number | null;
 last_intent?: string | null; last_ms?: number | null; has_transcript: boolean;
}
/** ChatDay.duration (ChatView.swift): "1 s" at least, then whole minutes, then "2 h 5 min". */
export function chatDuration(ms: number): string {
 const seconds = Math.max(0, Math.floor(ms / 1000));
 if (seconds < 60) return `${Math.max(seconds, 1)} s`;
 const minutes = Math.floor(seconds / 60);
 if (minutes < 60) return `${minutes} min`;
 const hours = Math.floor(minutes / 60), rest = minutes % 60;
 return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
export type SubagentMark = "running" | "completed" | "failed" | "unknown";
/** One row of the chat's Subagents card, worded as ChatSubagentRow (ChatView.swift): running,
 *  its newest intent and how long it has run; finished, how it ended and how long it took. A
 *  status this build doesn't know reads "status unknown", as TranscriptSubagentStatus.unknown. */
export function subagentRow(agent: TranscriptSubagent, nowMs: number): { mark: SubagentMark; title: string; label: string; detail: string; spoken: string } {
 const status = ["running", "completed", "failed", "aborted"].includes(agent.status ?? "") ? agent.status! : "unknown";
 const word = status === "unknown" ? "status unknown" : status;
 const started = agent.started_ms ?? 0, running = status === "running";
 let duration: string | null = null;
 if (agent.duration_ms != null) duration = chatDuration(agent.duration_ms);
 else if (agent.finished_ms != null && agent.finished_ms > started && started > 0) duration = chatDuration(agent.finished_ms - started);
 const elapsed = started > 0 && nowMs > started ? chatDuration(nowMs - started) : null;
 const intent = agent.last_intent || null;
 const detail = running
  ? [intent, elapsed].filter(Boolean).join(" · ")
  : [word.replace(/\b\w/g, letter => letter.toUpperCase()), duration].filter(Boolean).join(" · ");
 const spoken = [agent.id, agent.label || null, word, running ? intent : duration].filter(Boolean).join(", ");
 return {
  mark: status === "aborted" ? "failed" : status as SubagentMark,
  title: agent.id, label: agent.label != null ? `: ${agent.label}` : "", detail, spoken,
 };
}
/** The card's heading count: the running ones, else the finished ones. */
export function subagentsSummary(agents: TranscriptSubagent[]): string {
 const running = agents.filter(agent => agent.status === "running").length;
 return running ? `${running} running` : `${agents.length - running} finished`;
}
/** The chat's model line, as AgentTranscript.swift TranscriptModel words it: "claude-opus-5-5 · high",
 *  "high (auto)" once omp's auto picked a level, "auto" before it has, the id alone without a level. */
export function modelLine(model: TranscriptModel): { label: string; accessibilityLabel: string } {
 const level = model.thinking_level || null, auto = !!model.thinking_auto;
 const effort = level ? (auto ? `${level} (auto)` : level) : auto ? "auto" : null;
 return {
  label: effort ? `${model.id} · ${effort}` : model.id,
  accessibilityLabel: `Model: ${model.provider}, ${model.id}` + (effort ? `, effort ${effort}` : ""),
 };
}
/** A live (`after`) page's entries the chat takes (TranscriptStore.mergeAfter, herdrup #684, #710,
 *  #736). When the pane's remembered non-owner prompts change, herdr re-sends earlier entries
 *  before the cursor. A page that lists them (`resent`, herdr #452) says exactly which: a listed
 *  entry the chat holds is updated in place, one it does not hold is history not loaded yet (an
 *  older page brings it) and is dropped, and every unlisted entry is new and appended, whatever
 *  its timestamp or origin. Without the list (servers before herdr #454) every entry is kept: the
 *  after cursor moves past it, so a dropped one is lost. The one page that might hold an unloaded
 *  replay (replayUnknown) is read again as the newest page first (refreshChat), never guessed at. */
export function liveEntries(current: readonly Entry[], page: Entry[], resent?: readonly string[]): Entry[] {
 if (!resent) return page;
 const held = new Set(current.map(e => e.id));
 const listed = new Set(resent);
 return page.filter(e => held.has(e.id) || !listed.has(e.id));
}
/** An after page without `resent` that may re-send history the chat has not loaded: a prompt it
 *  does not hold, marked origin "other", older than the oldest it holds, while older history is
 *  unloaded. A new guest prompt (clock skew) looks the same, so neither is guessed: the chat reads
 *  the newest page instead, which holds only the conversation's tail (herdrup #736). */
export function replayUnknown(current: readonly Entry[], page: TranscriptPage, hasOlder: boolean): boolean {
 const oldest = current[0]?.ts_ms;
 if (page.resent || !hasOlder || !oldest) return false;
 const held = new Set(current.map(e => e.id));
 return (page.entries ?? []).some(e => !held.has(e.id) && e.kind === "user" && e.origin === "other" && e.ts_ms > 0 && e.ts_ms < oldest);
}
/** The ambiguous after page (replayUnknown) replaced by the newest page read after it: first the
 *  ambiguous page's updates to entries the chat holds (a prompt newly marked, a changed step; no
 *  later poll sends them again, herdrup-desktop #242), then the newest page by position
 *  (mergeNewest); null when the newest page shares nothing with the chat. */
export function rereadMerge(current: Entry[], ambiguous: readonly Entry[], newest: Entry[]): Entry[] | null {
 const held = new Set(current.map(e => e.id));
 return mergeNewest(mergeTranscript(current, ambiguous.filter(e => held.has(e.id))), newest);
}
/** The newest page read in place of an ambiguous after page (replayUnknown), merged by position:
 *  herdr renders it in conversation order, so entries before the first one the chat holds are
 *  older history (they go above, as an older page's do) and every other one it does not hold is
 *  new. A page sharing nothing with the chat leaves a gap: null, and the chat starts over from it. */
export function mergeNewest(current: Entry[], page: Entry[]): Entry[] | null {
 const held = new Set(current.map(e => e.id));
 const first = page.findIndex(e => held.has(e.id));
 if (first < 0) return current.length ? null : page;
 return mergeTranscript(mergeTranscript(current, page.slice(0, first), { older: true }), page.slice(first), { resent: [] });
}
/** One live read of a chat's tail, the agent's or a topic's (herdrup #736 / #749 review F2).
 *  `read(after)` fetches a page after that cursor ("" for the newest page) and returns null once
 *  the reply is stale. An after page that may re-send unloaded history (replayUnknown) is replaced
 *  by the newest page, merged by position (rereadMerge). `reset`: the chat starts over from
 *  `page` (a new session, a first read, or a newest page sharing nothing with it).
 *  `current()` is the chat's entries now and whether older history is left: it is read after each
 *  request, never before, so history loaded while a read is pending is kept (#253). */
export interface LiveRead { page: TranscriptPage; entries: Entry[]; reset: boolean }
export async function readLive(held: TranscriptPage | null, current: () => { entries: Entry[]; hasOlder: boolean }, read: (after: string) => Promise<TranscriptPage | null>): Promise<LiveRead | null> {
 let page = await read(held?.after ?? "");
 if (!page) return null;
 const now = current();
 const reread = !!held && held.session_id === page.session_id && replayUnknown(now.entries, page, now.hasOlder);
 const ambiguous = page.entries ?? [];
 if (reread) {
  const newest = await read("");
  if (!newest) return null;
  page = newest;
 }
 const entries = current().entries;
 const merged = reread && held?.session_id === page.session_id ? rereadMerge(entries, ambiguous, page.entries ?? []) : undefined;
 const reset = !held || held.session_id !== page.session_id || merged === null;
 return { page, reset, entries: merged ?? mergeTranscript(reset ? [] : entries, page.entries ?? [], { resent: page.resent }) };
}
/** Merges a transcript page into the held entries: an older page before them, a live page after
 *  (liveEntries; resent is the page's list). */
export function mergeTranscript(current: Entry[], page: Entry[], opts: { older?: boolean; resent?: readonly string[] } = {}): Entry[] {
 const older = opts.older ?? false;
 if (!older) page = liveEntries(current, page, opts.resent);
 const updates = new Map(page.map(e => [e.id, e]));
 const oldIDs = new Set(current.map(e => e.id));
 const merged = current.map(e => updates.get(e.id) ?? e);
 const added = page.filter(e => !oldIDs.has(e.id));
 return older ? [...added, ...merged] : [...merged, ...added];
}
/** A composer send's receipt, as the page settles it: how it went (submitted, unconfirmed, a plain
 *  terminal's written) and what to say about it. */
export interface ComposerReceipt { delivery: string; note?: string }
/** Desk.chatPrompt's receipt, JSON at that binding. The text already went out, so a reply in
 *  another shape is an unconfirmed send, never a failed one (which would put the text back). */
export function chatReceipt(raw: string): ComposerReceipt {
 try {
  const r = JSON.parse(raw) as { delivery?: unknown; note?: unknown } | null;
  if (typeof r?.delivery === "string") return typeof r.note === "string" ? { delivery: r.delivery, note: r.note } : { delivery: r.delivery };
 } catch { /* below */ }
 return { delivery: "unconfirmed" };
}
export function remainingDraft(current: string, sent: string): string {
 return current === sent ? "" : current;
}
export interface WorkRow {
 kind: "work"; id: string; thoughts: string[]; steps: Entry[];
 startMs: number; endMs: number; live: boolean;
}
export type ChatRow = WorkRow | { kind: "entry"; id: string; entry: Entry } | { kind: "day"; id: string; ms: number };

/** ChatDay.needsSeparator (herdrup 9845ecf ChatView.swift 1948-1955): before the first prompt,
 *  a prompt on a new local day, or one an hour or more after the previous prompt. */
export function needsDaySeparator(previousMs: number | null, ms: number): boolean {
 if (previousMs === null) return true;
 const a = new Date(previousMs), b = new Date(ms);
 if (a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate()) return true;
 return ms > previousMs && ms - previousMs >= 60 * 60 * 1000;
}

/** ChatDay.label (ChatView.swift 1957-1972): ("Today", "4:12 PM"), ("Yesterday", …), the
 *  weekday within seven days, "Oct 28" this year, else "Oct 28, 2025". */
export function chatDayLabel(ms: number, now: Date, locale?: string): { day: string; time: string } {
 const date = new Date(ms);
 const time = date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
 const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
 if (sameDay(date, now)) return { day: "Today", time };
 const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
 if (sameDay(date, yesterday)) return { day: "Yesterday", time };
 // Calendar.dateComponents([.day], from: date, to: now): whole days elapsed.
 if (Math.trunc((now.getTime() - ms) / 86_400_000) < 7) return { day: date.toLocaleDateString(locale, { weekday: "long" }), time };
 if (date.getFullYear() === now.getFullYear()) return { day: date.toLocaleDateString(locale, { month: "short", day: "numeric" }), time };
 return { day: date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" }), time };
}

/** A transcript row as its kept node is matched against (interaction.ts drawChat, topicsView.ts
 *  TopicChat.draw): a day separator with the label it reads now (chatDayLabel), which turns from
 *  Today to Yesterday at midnight while the row stays the same; any other row as it is. */
export function rowShown(row: ChatRow | SuggestionRow, now: Date): unknown {
 return row.kind === "day" ? [row, chatDayLabel(row.ms, now)] : row;
}

// TranscriptGrouping.turns: consecutive thoughts/steps form one run. A prompt, a handover from
// the Inbox or a topic (relay) or a compaction starts a new turn; only that turn's newest plan
// remains visible.
export function groupTranscript(entries: Entry[], working: boolean): ChatRow[] {
 const rows: (ChatRow | null)[] = [];
 let work: WorkRow | null = null;
 let plan: number | null = null;
 let previousPrompt: number | null = null;
 const close = (at?: number) => {
  if (!work) return;
  if (at !== undefined) work.endMs = Math.max(work.endMs, at);
  rows.push(work); work = null;
 };
 for (const entry of entries) {
  if (entry.kind === "thinking" || entry.kind === "step") {
   work ??= { kind: "work", id: entry.id, thoughts: [], steps: [], startMs: entry.ts_ms, endMs: entry.ts_ms, live: false };
   work.endMs = Math.max(work.endMs, entry.ts_ms);
   if (entry.kind === "thinking") { const text = (entry.text ?? "").trim(); if (text) work.thoughts.push(text); }
   else work.steps.push(entry);
   continue;
  }
  if (entry.kind === "reply" && !(entry.text ?? "").trim()) continue;
  if (!["user", "relay", "reply", "note", "plan", "ask", "turn_end", "summary", "topic_suggestion"].includes(entry.kind)) continue;
  close(entry.ts_ms);
  if (entry.kind === "user" || entry.kind === "relay" || entry.kind === "summary") plan = null;
  if (entry.kind === "user" && entry.ts_ms > 0) {
   if (needsDaySeparator(previousPrompt, entry.ts_ms)) rows.push({ kind: "day", id: `day:${entry.id}`, ms: entry.ts_ms });
   previousPrompt = entry.ts_ms;
  }
  if (entry.kind === "turn_end" && entry.status === "done") continue;
  if (entry.kind === "plan") { if (plan !== null) rows[plan] = null; plan = rows.length; }
  rows.push({ kind: "entry", id: entry.id, entry });
 }
 if (work && working) work.live = true;
 close();
 return rows.filter((row): row is ChatRow => row !== null);
}

// The latest live snapshot wins, including an explicitly empty plan. Older
// transcript pages contribute history, never live metadata.
export function currentPlan(page: TranscriptPage | null, entries: Entry[]): PlanItem[] {
 if (page?.plan != null) return page.plan;
 for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.kind === "plan") return entries[i]!.items ?? [];
 return [];
}
export function planDone(item: PlanItem): boolean {
 if (["pending", "completed", "blocked", "unknown", "in_progress"].includes(item.status ?? "")) return item.status === "completed";
 return item.done ?? false;
}
// TranscriptPlanWindow: favor current work, then pending work ahead, then
// completed context immediately behind it. Finished plans collapse to a header.
export function planWindow(items: PlanItem[]): number[] {
 let start = items.findIndex(item => item.status === "in_progress");
 if (start < 0) start = items.findIndex(item => !planDone(item));
 if (start < 0) return [];
 const shown = [start];
 for (let i = start + 1; i < items.length && shown.length < 3; i++) if (!planDone(items[i]!)) shown.push(i);
 for (let i = start - 1; i >= 0 && shown.length < 3; i--) if (planDone(items[i]!)) shown.push(i);
 return shown.sort((a, b) => a - b);
}

export interface ByteFrame { frame: string; seq: number; epoch: number; data_b64?: string; history_b64?: string; cols?: number; rows?: number; history_cursor?: string }
export function bytes(encoded: string | undefined): Uint8Array {
 return Uint8Array.from(atob(encoded ?? ""), c => c.charCodeAt(0));
}
// SSH preserves frame order. A new epoch requires a reset; offsets may not
// go backwards. A reset is a rendered seed, not a raw offset-length payload.
export class TerminalSequence {
 epoch: number | null = null;
 seq = 0;
 accept(frame: ByteFrame): boolean {
  if (frame.frame === "reset") { this.epoch = frame.epoch; this.seq = frame.seq; return true; }
  if (frame.epoch !== this.epoch || frame.seq < this.seq) return false;
  this.seq = frame.seq;
  return true;
 }
}
