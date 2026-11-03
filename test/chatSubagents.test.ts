import { expect, test } from "bun:test";
import { chatDuration, subagentRow, subagentsSummary } from "../src/interactionModel";

// Owner report 2026-11-03: Chat's Subagents card did not read like native's. Rows word as
// ChatSubagentRow (ChatView.swift): running, the newest intent and how long it has run;
// finished, how it ended and how long it took; the heading counts running ones first.
const now = 1_000_000_000;
test("a running subagent shows its intent and elapsed time", () => {
 const row = subagentRow({ id: "AppHeadReview", label: "Review the app head", status: "running", started_ms: now - 125_000, last_intent: "Reading ChatView.swift", has_transcript: true }, now);
 expect(row).toEqual({ mark: "running", title: "AppHeadReview", label: ": Review the app head", detail: "Reading ChatView.swift · 2 min", spoken: "AppHeadReview, Review the app head, running, Reading ChatView.swift" });
 expect(subagentRow({ id: "A", status: "running", started_ms: 0, has_transcript: false }, now).detail).toBe("");
});
test("a finished subagent shows how it ended and how long it took", () => {
 expect(subagentRow({ id: "M", status: "completed", started_ms: now - 600_000, finished_ms: now - 300_000, duration_ms: 300_000, has_transcript: true }, now))
  .toMatchObject({ mark: "completed", label: "", detail: "Completed · 5 min", spoken: "M, completed, 5 min" });
 // Without duration_ms, finished minus started; aborted draws as failed but reads as aborted.
 expect(subagentRow({ id: "X", status: "aborted", started_ms: now - 90_000, finished_ms: now, has_transcript: false }, now))
  .toMatchObject({ mark: "failed", detail: "Aborted · 1 min" });
 expect(subagentRow({ id: "N", status: "paused", started_ms: now, has_transcript: false }, now))
  .toMatchObject({ mark: "unknown", detail: "Status Unknown", spoken: "N, status unknown" });
});
test("durations and the heading count read as native's", () => {
 expect([0, 59_999, 60_000, 3_599_999, 3_600_000, 7_500_000].map(chatDuration)).toEqual(["1 s", "59 s", "1 min", "59 min", "1 h", "2 h 5 min"]);
 const finished = { id: "F", status: "completed", has_transcript: false };
 expect(subagentsSummary([{ id: "R", status: "running", has_transcript: false }, finished])).toBe("1 running");
 expect(subagentsSummary([finished, { ...finished, id: "G" }])).toBe("2 finished");
});
