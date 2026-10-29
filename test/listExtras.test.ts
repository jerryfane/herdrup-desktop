import { expect, test } from "bun:test";
import { accountLabel, needsYouText, timeInState, waitingOutOfSight } from "../src/listExtras";

test("timeInState is herdrup's compactTimeInState", () => {
  const now = 1_700_000_000_000;
  expect(timeInState(undefined, now)).toBeNull();
  expect(timeInState(now + 1, now)).toBeNull();
  expect(timeInState(now, now)).toBe("0m");
  expect(timeInState(now - 59_999, now)).toBe("0m");
  expect(timeInState(now - 60_000, now)).toBe("1m");
  expect(timeInState(now - 3_599_999, now)).toBe("59m");
  expect(timeInState(now - 3_600_000, now)).toBe("1h");
  expect(timeInState(now - 86_399_999, now)).toBe("23h");
  expect(timeInState(now - 86_400_000, now)).toBe("1d");
  expect(timeInState(now - 3 * 86_400_000, now)).toBe("3d");
});

test("accountLabel names the account, else shows its id", () => {
  const labels = { a1: "Work", empty: "" };
  expect(accountLabel(undefined, labels)).toBeNull();
  expect(accountLabel("", labels)).toBeNull();
  expect(accountLabel("a1", labels)).toBe("Work");
  expect(accountLabel("gone", labels)).toBe("gone");
  expect(accountLabel("toString", labels)).toBe("toString");
});

test("needsYouText", () => {
  expect(needsYouText(1)).toBe("1 agent needs you");
  expect(needsYouText(2)).toBe("2 agents need you");
});

test("waitingOutOfSight is NeedsYouSight.sample", () => {
  expect(waitingOutOfSight(0, 160)).toBe(false);
  expect(waitingOutOfSight(159, 160)).toBe(false);
  expect(waitingOutOfSight(160, 160)).toBe(true);
  expect(waitingOutOfSight(1, null)).toBe(false);
  expect(waitingOutOfSight(2, null)).toBe(true);
});
