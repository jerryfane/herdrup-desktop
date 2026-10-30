import { expect, test } from "bun:test";
import { groupTranscript, mergeTranscript, remainingDraft, TerminalSequence } from "../src/interactionModel";

test("incremental transcript replaces changed entries without duplicating older pages", () => {
 const initial = [{ kind: "reply", id: "r", ts_ms: 2, text: "Partial" }];
 const update = [{ kind: "reply", id: "r", ts_ms: 2, text: "Complete" }, { kind: "step", id: "s", ts_ms: 3, status: "done" }];
 const merged = mergeTranscript(initial, update);
 const earlier = [{ kind: "user", id: "u", ts_ms: 1, text: "Prompt" }, update[0]!];
 const paged = mergeTranscript(merged, earlier, true);
 expect(paged.map(e => e.id)).toEqual(["u", "r", "s"]);
 expect(paged[1]?.text).toBe("Complete");
 expect(mergeTranscript(paged, earlier, true)).toEqual(paged);
});

test("prompt acknowledgement clears only the submitted draft", () => {
 expect(remainingDraft("first", "first")).toBe("");
 expect(remainingDraft("first\nnew instructions", "first")).toBe("first\nnew instructions");
 expect(remainingDraft("replacement", "first")).toBe("replacement");
});

test("terminal rejects deltas from another runtime until its reset", () => {
 const stream = new TerminalSequence();
 expect(stream.accept({ frame: "data", epoch: 1, seq: 1 })).toBe(false);
 expect(stream.accept({ frame: "reset", epoch: 1, seq: 100 })).toBe(true);
 expect(stream.accept({ frame: "data", epoch: 1, seq: 110 })).toBe(true);
 expect(stream.accept({ frame: "data", epoch: 1, seq: 105 })).toBe(false);
 expect(stream.accept({ frame: "data", epoch: 2, seq: 120 })).toBe(false);
 expect(stream.accept({ frame: "reset", epoch: 2, seq: 0 })).toBe(true);
 expect(stream.accept({ frame: "data", epoch: 2, seq: 10 })).toBe(true);
});

test("chat work groups end at a visible reply and keep only the unfinished run live", () => {
 const rows = groupTranscript([
  { kind: "user", id: "u", ts_ms: 1000, text: "Review the changes" },
  { kind: "thinking", id: "t", ts_ms: 2000, text: "  Read the changed paths.  " },
  { kind: "step", id: "s", ts_ms: 3000, tool: "read", intent: "Reading changes", status: "done" },
  { kind: "reply", id: "empty", ts_ms: 4000, text: " " },
  { kind: "reply", id: "r", ts_ms: 5000, text: "The interface changed." },
  { kind: "step", id: "next", ts_ms: 6000, tool: "bash", intent: "Checking callers", status: "running" },
 ], true);
 expect(rows.map(row => row.id)).toEqual(["u", "t", "r", "next"]);
 expect(rows[1]).toMatchObject({ kind: "work", thoughts: ["Read the changed paths."], startMs: 2000, endMs: 5000, live: false });
 expect(rows[3]).toMatchObject({ kind: "work", steps: [{ id: "next", status: "running" }], live: true });
});

test("chat plans replace within a turn without erasing previous turns or summaries", () => {
 const rows = groupTranscript([
  { kind: "user", id: "u1", ts_ms: 1 },
  { kind: "plan", id: "old", ts_ms: 2, items: [{ text: "Read", done: false }] },
  { kind: "plan", id: "updated", ts_ms: 3, items: [{ text: "Read", done: true }] },
  { kind: "turn_end", id: "end", ts_ms: 4, status: "done" },
  { kind: "user", id: "u2", ts_ms: 5 },
  { kind: "plan", id: "second", ts_ms: 6, items: [{ text: "Write", done: false }] },
  { kind: "summary", id: "summary", ts_ms: 7, text: "Read complete" },
  { kind: "plan", id: "after-summary", ts_ms: 8, items: [{ text: "Verify", done: false }] },
  { kind: "future-entry", id: "unknown", ts_ms: 9 },
  { kind: "turn_end", id: "failed", ts_ms: 10, status: "failed", error: "Connection lost" },
 ], false);
 expect(rows.map(row => row.id)).toEqual(["u1", "updated", "u2", "second", "summary", "after-summary", "failed"]);
 expect(rows.at(-1)).toMatchObject({ kind: "entry", entry: { error: "Connection lost" } });
});
