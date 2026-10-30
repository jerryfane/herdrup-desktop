import { expect, test } from "bun:test";
import { mergeTranscript, remainingDraft, TerminalSequence } from "../src/interactionModel";

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
