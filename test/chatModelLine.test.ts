import { expect, test } from "bun:test";
import { modelLine } from "../src/interactionModel";

// Owner report 2026-11-03: Chat showed no model or effort. The line reads as native's
// TranscriptModel.label / accessibilityLabel (AgentTranscript.swift).
test("the model line words the effort as native does", () => {
 const m = { id: "claude-opus-5-5", provider: "anthropic" };
 expect(modelLine({ ...m, thinking_level: "high" })).toEqual({ label: "claude-opus-5-5 · high", accessibilityLabel: "Model: anthropic, claude-opus-5-5, effort high" });
 expect(modelLine({ ...m, thinking_level: "high", thinking_auto: true }).label).toBe("claude-opus-5-5 · high (auto)");
 expect(modelLine({ ...m, thinking_auto: true }).label).toBe("claude-opus-5-5 · auto");
 expect(modelLine(m)).toEqual({ label: "claude-opus-5-5", accessibilityLabel: "Model: anthropic, claude-opus-5-5" });
 expect(modelLine({ ...m, thinking_level: null, thinking_auto: null }).label).toBe("claude-opus-5-5");
});
