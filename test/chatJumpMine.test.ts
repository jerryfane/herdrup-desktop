import { expect, test } from "bun:test";
import { isMine, previousMine } from "../src/chatJumpMine";

const user = (extra: Record<string, unknown> = {}) => ({ kind: "user", id: "u", ts_ms: 1, text: "hi", ...extra });

test("only prompts the owner sent count as mine", () => {
  expect(isMine(user())).toBe(true);
  expect(isMine(user({ author: "owner" }))).toBe(true);
  expect(isMine(user({ author: "guest", author_name: "nike" }))).toBe(false);
  expect(isMine(user({ origin: "other" }))).toBe(false);
  expect(isMine(user({ author: "owner", origin: "other" }))).toBe(false);
  expect(isMine({ kind: "reply", id: "r", ts_ms: 1, text: "hi" })).toBe(false);
});

test("each tap goes to the next prompt above the view and stops at the first", () => {
  const rows = [{ id: "a", top: 100 }, { id: "b", top: 900 }, { id: "c", top: 1800 }];
  expect(previousMine(rows, 2000)).toBe("c");
  // The tap left c at the top of the view (12 px margin): the next tap goes to b.
  expect(previousMine(rows, 1788)).toBe("b");
  expect(previousMine(rows, 1800)).toBe("b");
  expect(previousMine(rows, 888)).toBe("a");
  expect(previousMine(rows, 100)).toBeNull();
  expect(previousMine([], 5000)).toBeNull();
});
