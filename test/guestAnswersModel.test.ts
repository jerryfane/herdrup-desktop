import { describe, expect, test } from "bun:test";
import { canAnswer, chooser, guestQuestion, waitingForOwner, withheldFromCaller } from "../src/guestAnswersModel";

// herdrup f2df68b ChatView.swift (ChatAskCard) and GuestPaneView.swift (noteRow, showsMenuKeys).
const single = (answerable: boolean, options = ["Yes", "No"], multi = false) =>
  ({ id: "a1", answerable, questions: [{ question: "Proceed?", options, multi }] });
const guest = { guest: true as const, owner: "Jerry" };

describe("guest answers", () => {
  test("a guest answers like the owner until the host refuses", () => {
    expect(canAnswer(single(true), waitingForOwner(guest, false))).toBe(true);
    expect(canAnswer(single(true), waitingForOwner(guest, true))).toBe(false);
    // The owner never waits for anyone, even after a refusal.
    expect(waitingForOwner({ guest: false }, true)).toBeNull();
  });

  test("only a withheld single-select question marks an older host", () => {
    expect(withheldFromCaller(single(false))).toBe(true);
    expect(withheldFromCaller(single(true))).toBe(false);
    expect(withheldFromCaller(single(false, ["a", "b"], true))).toBe(false);
    expect(withheldFromCaller(single(false, []))).toBe(false);
    expect(withheldFromCaller({ id: "a2", answerable: false, questions: [single(false).questions[0]!, single(false).questions[0]!] })).toBe(false);
  });

  test("an answer is credited as native does", () => {
    expect(chooser({ guest: false }, null)).toBe("You chose ");
    expect(chooser(guest, null)).toBe("Chosen: ");
    expect(chooser(guest, "Jerry")).toBe("Jerry chose ");
  });

  test("menu keys show only on the terminal while the agent waits and the host lets the guest answer", () => {
    expect(guestQuestion("docs", "Jerry", "needsYou", false, true)).toEqual({ banner: "docs is asking a question · answer with the keys below", menuKeys: true, label: null });
    expect(guestQuestion("docs", "Jerry", "needsYou", false, false)).toEqual({ banner: "docs is asking a question", menuKeys: false, label: null });
    expect(guestQuestion("docs", "Jerry", "needsYou", true, true)).toEqual({ banner: "docs is asking a question only Jerry can answer", menuKeys: false, label: "needs Jerry" });
    expect(guestQuestion("docs", "Jerry", "working", false, true)).toEqual({ banner: null, menuKeys: false, label: null });
  });
});
