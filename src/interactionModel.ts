import type { AskForm, AskFormAnswer, AskFormStatus } from "./askFormModel";
export interface Question { question: string; options: string[]; multi: boolean; recommended?: number }
export interface PlanItem { text: string; status?: string; done?: boolean; phase?: string; blocker?: string }
export interface Entry {
 kind: string; id: string; ts_ms: number; text?: string; body?: string; title?: string;
 intent?: string; detail?: string; tool?: string; status?: string; error?: string;
 source?: string; from?: string;
 questions?: Question[]; answer?: string[]; items?: PlanItem[];
 /** omp's HTML-form ask (herdr ask-form contract): the form, and once the tool result arrives
  *  its answers and how it ended. */
 form?: AskForm | null; form_answer?: AskFormAnswer[] | null; form_status?: AskFormStatus | null;
 [key: string]: unknown;
}
export interface TranscriptPage {
 after: string; before?: string; session_id: string; entries: Entry[];
 plan?: PlanItem[] | null;
 pending_ask?: { id: string; answerable: boolean; questions: Question[]; form?: AskForm | null; form_answerable?: boolean };
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
export function mergeTranscript(current: Entry[], page: Entry[], older = false): Entry[] {
 const updates = new Map(page.map(e => [e.id, e]));
 const oldIDs = new Set(current.map(e => e.id));
 const merged = current.map(e => updates.get(e.id) ?? e);
 const added = page.filter(e => !oldIDs.has(e.id));
 return older ? [...added, ...merged] : [...merged, ...added];
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

// TranscriptGrouping.turns: consecutive thoughts/steps form one run. A prompt or
// compaction starts a new turn; only that turn's newest plan remains visible.
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
  if (!["user", "reply", "note", "plan", "ask", "turn_end", "summary"].includes(entry.kind)) continue;
  close(entry.ts_ms);
  if (entry.kind === "user" || entry.kind === "summary") plan = null;
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
