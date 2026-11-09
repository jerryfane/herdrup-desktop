import { expect, test } from "bun:test";
import { composerEnterSends } from "../src/composer";

const key = (fields: Partial<Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing">>) =>
  ({ key: "Enter", shiftKey: false, isComposing: false, ...fields });

// Owner 2026-11-09: Shift+Return sent the prompt instead of starting a new line.
test("Return sends and Shift+Return writes a new line", () => {
  expect(composerEnterSends(key({}))).toBe(true);
  expect(composerEnterSends(key({ shiftKey: true }))).toBe(false);
  expect(composerEnterSends(key({ isComposing: true }))).toBe(false);
  expect(composerEnterSends(key({ key: "a" }))).toBe(false);
});
