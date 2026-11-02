import { expect, test } from "bun:test";
import {
  clampZoom, cropRect, dragOffset, encodeWithinLimit, existingTransfer, harnessDisplayName, integralCropRect,
  normalizeAgentName, renameField, transferPhaseIsConclusive, transferPhaseIsTerminal, workingSize,
} from "../src/agentActionsModel";
import { MASCOTS, mascotName } from "../src/avatars";
import { readdirSync } from "node:fs";

// herdrup Tests/HerdrKitTests AgentName cases, and what the grammar implies.
test("normalizeAgentName follows herdr's agent-name grammar", () => {
  expect(normalizeAgentName("Herdr-iOS")).toBe("herdr-ios");
  expect(normalizeAgentName("~/My Project")).toBe("my-project");
  expect(normalizeAgentName("工作")).toBe("agent");
  expect(normalizeAgentName("42planner")).toBe("planner");
  expect(normalizeAgentName("build logs")).toBe("build-logs");
  expect(normalizeAgentName("a_b-c9")).toBe("a_b-c9");
  expect(normalizeAgentName("")).toBe("agent");
  expect(normalizeAgentName("x".repeat(40))).toBe("x".repeat(32));
  // An emoji is one scalar: one separator, not two.
  expect(normalizeAgentName("a🙂b")).toBe("a-b");
});

test("renameField shows the preview only when normalising changes the trimmed input", () => {
  expect(renameField("  planner  ")).toEqual({ effective: "planner", canSave: true, showPreview: false });
  expect(renameField("Build Logs")).toEqual({ effective: "build-logs", canSave: true, showPreview: true });
  expect(renameField("   ")).toEqual({ effective: "agent", canSave: false, showPreview: false });
});

test("cropRect keeps the square inside the image", () => {
  expect(cropRect(400, 200, 1, 0, 0)).toEqual({ x: 100, y: 0, side: 200 });
  expect(cropRect(400, 200, 1, -1, 0)).toEqual({ x: 0, y: 0, side: 200 });
  expect(cropRect(400, 200, 1, 5, 0)).toEqual({ x: 200, y: 0, side: 200 });
  expect(cropRect(400, 200, 2, 1, 1)).toEqual({ x: 300, y: 100, side: 100 });
  // Zoom below 1 is 1.
  expect(cropRect(300, 300, 0.5, 0, 0)).toEqual({ x: 0, y: 0, side: 300 });
});

test("integralCropRect rounds outward to whole pixels", () => {
  // side 66.67, x 175.75, y 66.67: like CGRect.integral, the edges move outward.
  expect(integralCropRect(301, 200, 3, 0.5, 0)).toEqual({ x: 175, y: 66, width: 68, height: 68 });
  const r = integralCropRect(1600, 1067, 6, 1, 1);
  expect(r.x + r.width).toBeLessThanOrEqual(1600);
  expect(r.y + r.height).toBeLessThanOrEqual(1067);
});

test("dragOffset moves the crop against the drag and clamps it", () => {
  // 400×200 at zoom 1: side 200, 200/280 px per point, travel 100 px on x, none on y.
  const right = dragOffset({ x: 0, y: 0 }, 28, 50, 280, 400, 200, 1);
  expect(right.x).toBeCloseTo(-0.2);
  expect(right.y).toBe(0);
  expect(dragOffset({ x: 0.9, y: 0 }, -1000, 0, 280, 400, 200, 1)).toEqual({ x: 1, y: 0 });
});

test("clampZoom holds the pinch to 1 ... 6", () => {
  expect(clampZoom(0.2)).toBe(1);
  expect(clampZoom(3)).toBe(3);
  expect(clampZoom(9)).toBe(6);
});

test("workingSize decodes at most 1600 px on the longest edge", () => {
  expect(workingSize(4032, 3024)).toEqual({ width: 1600, height: 1200 });
  expect(workingSize(800, 600)).toEqual({ width: 800, height: 600 });
});

test("encodeWithinLimit takes the first quality that fits", async () => {
  const tried: number[] = [];
  const out = await encodeWithinLimit(async q => { tried.push(q); return new Uint8Array(q > 0.6 ? 70_000 : 60_000); });
  expect(tried).toEqual([0.85, 0.75, 0.65, 0.55]);
  expect(out?.length).toBe(60_000);
  expect(await encodeWithinLimit(async () => new Uint8Array(0))).toBeNull();
  expect(await encodeWithinLimit(async () => null)).toBeNull();
});

test("the mascot list is herdrup's picker order and every one has art", () => {
  expect([...MASCOTS]).toEqual(["herdy", "bot", "blip", "tri", "squib", "zag", "cub", "dome", "pip", "prism", "nib", "drop"]);
  const art = readdirSync(new URL("../public/herdrup/mascots", import.meta.url)).map(f => f.replace(/\.svg$/, "")).sort();
  expect(art).toEqual([...MASCOTS].sort());
  expect(mascotName("herdy")).toBe("Herdy");
});

test("transfer phases and harness names follow herdrup's wire types", () => {
  expect(harnessDisplayName("claude")).toBe("Claude Code");
  expect(harnessDisplayName("omp")).toBe("Oh My Pi");
  expect(harnessDisplayName("gemini")).toBe("gemini");
  expect(transferPhaseIsTerminal("ready")).toBe(false);
  expect(transferPhaseIsTerminal("rolled_back")).toBe(true);
  expect(transferPhaseIsTerminal("something_new")).toBe(true);
  expect(transferPhaseIsConclusive("something_new")).toBe(false);
  const info = { id: "t1", source: "claude", target: "codex", phase: "ready" };
  expect(existingTransfer({ session_transfer: info }, "claude", "codex")).toBe(info);
  expect(existingTransfer({ session_transfer: info }, "codex", "claude")).toBeNull();
  expect(existingTransfer({ session_transfer: { ...info, phase: "completed" } }, "claude", "codex")).toBeNull();
});
