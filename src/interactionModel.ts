export interface Question { question: string; options: string[]; multi: boolean; recommended?: number }
export interface PlanItem { text: string; status?: string; done?: boolean; phase?: string; blocker?: string }
export interface Entry {
 kind: string; id: string; ts_ms: number; text?: string; body?: string; title?: string;
 intent?: string; detail?: string; tool?: string; status?: string; error?: string;
 source?: string; from?: string;
 questions?: Question[]; answer?: string[]; items?: PlanItem[];
 [key: string]: unknown;
}
export interface TranscriptPage {
 after: string; before?: string; session_id: string; entries: Entry[];
 plan?: PlanItem[] | null;
 pending_ask?: { id: string; answerable: boolean; questions: Question[] };
 working?: { intent?: string; [key: string]: unknown };
 subagents?: { id: string; label?: string; task?: string; status?: string; has_transcript: boolean }[];
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
export type ChatRow = WorkRow | { kind: "entry"; id: string; entry: Entry };

// TranscriptGrouping.turns: consecutive thoughts/steps form one run. A prompt or
// compaction starts a new turn; only that turn's newest plan remains visible.
export function groupTranscript(entries: Entry[], working: boolean): ChatRow[] {
 const rows: (ChatRow | null)[] = [];
 let work: WorkRow | null = null;
 let plan: number | null = null;
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
