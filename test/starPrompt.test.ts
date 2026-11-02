import { describe, expect, test } from "bun:test";
import { dismissStarPrompt, onStarPromptChanged, recordOwnerSend, sentPrompts, showsStarPrompt, STAR_AFTER_SENDS } from "../src/starPrompt";

// Owner request 2026-11-01 (herdr-app 383362): one GitHub star ask after five owner prompts.
function store(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, values };
}
const live = {};

describe("star prompt", () => {
  test("appears on the fifth owner send, not the fourth", () => {
    const s = store();
    for (let i = 1; i < STAR_AFTER_SENDS; i++) recordOwnerSend(s);
    expect(showsStarPrompt(false, s, live)).toBe(false);
    recordOwnerSend(s);
    expect(showsStarPrompt(false, s, live)).toBe(true);
  });

  test("either answer hides it for good, even as sends continue", () => {
    const s = store({ "starPrompt.sentPrompts": "5" });
    dismissStarPrompt(s);
    recordOwnerSend(s);
    expect(showsStarPrompt(false, s, live)).toBe(false);
  });

  test("a guest never sees it", () => {
    expect(showsStarPrompt(true, store({ "starPrompt.sentPrompts": "5" }), live)).toBe(false);
  });

  test("captures hide it unless the test flag asks for it", () => {
    const s = store({ "starPrompt.sentPrompts": "5" });
    expect(showsStarPrompt(false, s, { herdrupHoldsStill: true })).toBe(false);
    expect(showsStarPrompt(false, s, { __herdrupSmokeErrors: [] })).toBe(false);
    expect(showsStarPrompt(false, s, { herdrupHoldsStill: true, __herdrupSmokeErrors: [], herdrupStarPrompt: true })).toBe(true);
  });

  test("a damaged count starts over instead of showing early", () => {
    for (const raw of ["-3", "2.5", "lots", ""]) expect(sentPrompts(store({ "starPrompt.sentPrompts": raw }))).toBe(0);
  });

  test("the count stops at the threshold and announces it once", () => {
    const s = store();
    let changes = 0;
    const stop = onStarPromptChanged(() => changes++);
    for (let i = 0; i < STAR_AFTER_SENDS + 3; i++) recordOwnerSend(s);
    stop();
    expect(s.values.get("starPrompt.sentPrompts")).toBe(String(STAR_AFTER_SENDS));
    expect(changes).toBe(1);
  });

  test("unreachable storage never fails a delivered send or the list (issue #80)", () => {
    // bun has no localStorage: reaching it throws, as a SecurityError does in a webview.
    expect(() => recordOwnerSend()).not.toThrow();
    expect(showsStarPrompt(false)).toBe(false);
    expect(sentPrompts()).toBe(0);
  });
});
