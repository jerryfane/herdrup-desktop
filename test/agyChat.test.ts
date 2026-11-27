import { expect, test } from "bun:test";
import { agyHarness, chatAvailableFor, chatHarness, ompHarness } from "../src/topicsModel";

test("agyHarness matches agy plain or named builds, and stays distinct from ompHarness", () => {
  expect(["agy", "AGY", "agy-cli", "agy 1.5", "agyx", "omp", "claude", ""].map(agyHarness)).toEqual([
    true, true, true, true, false, false, false, false,
  ]);
  expect(ompHarness("agy")).toBe(false);
  expect(chatHarness("agy")).toBe(true);
  expect(chatHarness("omp")).toBe(true);
  expect(chatHarness("claude")).toBe(false);
});

test("chatAvailableFor gates agy on transcript_agy for both desktop owner and web/guest views", () => {
  // Desktop owner view (guest: false)
  expect(chatAvailableFor("omp", false, false, undefined)).toBe(true);
  expect(chatAvailableFor("agy", false, false, undefined)).toBe(false);
  expect(chatAvailableFor("agy", false, undefined, undefined)).toBe(false);
  expect(chatAvailableFor("agy", false, true, undefined)).toBe(true);
  expect(chatAvailableFor("claude", false, true, undefined)).toBe(false);

  // Web / guest view (guest: true)
  expect(chatAvailableFor("omp", true, false, { available: true })).toBe(true);
  expect(chatAvailableFor("omp", true, false, { available: false })).toBe(false);
  expect(chatAvailableFor("agy", true, false, { available: true })).toBe(false);
  expect(chatAvailableFor("agy", true, false, { available: false, transcriptAgy: true })).toBe(false);
  expect(chatAvailableFor("agy", true, false, { available: true, transcriptAgy: true })).toBe(true);
  expect(chatAvailableFor("agy", true, false, null)).toBe(false);
  expect(chatAvailableFor("claude", true, false, { available: true, transcriptAgy: true })).toBe(false);
});
