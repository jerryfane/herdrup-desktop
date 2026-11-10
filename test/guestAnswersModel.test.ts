import { describe, expect, test } from "bun:test";
import { canAnswer, chooser, guestQuestion, promptByline, waitingForOwner, withheldFromCaller } from "../src/guestAnswersModel";

// herdrup f2df68b ChatView.swift (ChatAskCard) and GuestPaneView.swift (noteRow, showsMenuKeys).
const single = (answerable: boolean, options = ["Yes", "No"], multi = false) =>
  ({ id: "a1", answerable, questions: [{ question: "Proceed?", options, multi }] });
const guest = { guest: true as const, me: "nike", owner: "Jerry" };

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
    // An HTML form's answerable is always false and its one-question fallback looks withheld;
    // form_answerable says whether this caller may answer.
    expect(withheldFromCaller({ ...single(false), form: { fields: [] }, form_answerable: true })).toBe(false);
  });

  test("an answer is credited as native does", () => {
    expect(chooser({ guest: false }, null)).toBe("You chose ");
    expect(chooser(guest, null)).toBe("Chosen: ");
    expect(chooser(guest, "Jerry")).toBe("Jerry chose ");
  });

  test("menu keys show only on the terminal while the agent waits and the host lets the guest answer", () => {
    expect(guestQuestion("docs", "Jerry", "needsYou", false, true)).toEqual({ banner: "docs is asking a question · answer with the keys below", tone: "waiting", menuKeys: true, label: null });
    expect(guestQuestion("docs", "Jerry", "needsYou", false, false)).toEqual({ banner: "docs is asking a question", tone: "waiting", menuKeys: false, label: null });
    expect(guestQuestion("docs", "Jerry", "needsYou", true, true)).toEqual({ banner: "docs is asking a question only Jerry can answer", tone: "waiting", menuKeys: false, label: "needs Jerry" });
  });

  test("otherwise the line is the view-only reminder, never a resize error", () => {
    expect(guestQuestion("docs", "Jerry", "working", false, true).banner).toBe("Terminal is view-only · send messages below");
    expect(guestQuestion("docs", "Jerry", "idle", false, false, true)).toEqual({ banner: "View-only · this host doesn't support guest resizing", tone: "faint", menuKeys: false, label: null });
    expect(guestQuestion("docs", "Jerry", "stopped", false, true).banner).toBeNull();
  });
});

// Owner report 2026-11-03: Chat did not say when a shared user sent a prompt. ChatView.swift's
// byline names a prompt that is not the reader's own; herdr reports author and author_name.
describe("prompt byline", () => {
  test("the owner sees who of the guests wrote a prompt", () => {
    expect(promptByline({ guest: false }, "guest", "nike")).toBe("nike · guest");
    expect(promptByline({ guest: false }, "guest", undefined)).toBe("Guest · guest");
    expect(promptByline({ guest: false }, "owner", undefined)).toBeNull();
  });
  test("a guest sees the owner's and other guests' prompts named, never their own", () => {
    expect(promptByline(guest, "owner", undefined)).toBe("Jerry");
    expect(promptByline(guest, undefined, undefined)).toBe("Jerry");
    expect(promptByline(guest, "guest", "nike")).toBeNull();
    expect(promptByline(guest, "guest", "jerry-2")).toBe("jerry-2 · guest");
    expect(promptByline({ ...guest, owner: "" }, "owner", undefined)).toBeNull();
  });
});
