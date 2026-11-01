import { expect, test } from "bun:test";
import { chatDayLabel, groupTranscript, mergeTranscript, needsDaySeparator, remainingDraft, TerminalSequence } from "../src/interactionModel";

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
 expect(rows.map(row => row.id)).toEqual(["day:u", "u", "t", "r", "next"]);
 expect(rows[2]).toMatchObject({ kind: "work", thoughts: ["Read the changed paths."], startMs: 2000, endMs: 5000, live: false });
 expect(rows[4]).toMatchObject({ kind: "work", steps: [{ id: "next", status: "running" }], live: true });
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
 expect(rows.map(row => row.id)).toEqual(["day:u1", "u1", "updated", "u2", "second", "summary", "after-summary", "failed"]);
 expect(rows.at(-1)).toMatchObject({ kind: "entry", entry: { error: "Connection lost" } });
});

// ChatDay.needsSeparator: the first prompt, a new local day, or an hour's quiet between prompts.
test("chat day rows mark the first prompt, a new day and an hour's quiet", () => {
 const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
 const rows = groupTranscript([
  { kind: "user", id: "a", ts_ms: at(27, 23, 30) },
  { kind: "reply", id: "ar", ts_ms: at(27, 23, 31), text: "ok" },
  { kind: "user", id: "b", ts_ms: at(28, 0, 10) },
  { kind: "user", id: "c", ts_ms: at(28, 1, 9) },
  { kind: "user", id: "d", ts_ms: at(28, 2, 9) },
 ], false);
 expect(rows.filter(row => row.kind === "day").map(row => row.id)).toEqual(["day:a", "day:b", "day:d"]);
 expect(needsDaySeparator(at(28, 1), at(28, 1, 59))).toBe(false);
});

test("chat day labels follow ChatDay.label", () => {
 const now = new Date(2026, 9, 28, 9, 41);
 const at = (y: number, m: number, d: number) => new Date(y, m, d, 16, 12).getTime();
 const day = (ms: number) => chatDayLabel(ms, now, "en-US").day;
 expect(chatDayLabel(at(2026, 9, 28), now, "en-US")).toEqual({ day: "Today", time: "4:12 PM" });
 expect(day(at(2026, 9, 27))).toBe("Yesterday");
 expect(day(at(2026, 9, 23))).toBe("Friday");
 expect(day(at(2026, 9, 20))).toBe("Oct 20");
 expect(day(at(2025, 9, 20))).toBe("Oct 20, 2025");
});
