export interface Question { question: string; options: string[]; multi: boolean; recommended?: number }
export interface Entry {
 kind: string; id: string; ts_ms: number; text?: string; body?: string; title?: string;
 intent?: string; detail?: string; tool?: string; status?: string; error?: string;
 questions?: Question[]; answer?: string[]; items?: { text: string; status?: string; done: boolean }[];
 [key: string]: unknown;
}
export interface TranscriptPage {
 after: string; before?: string; session_id: string; entries: Entry[];
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
