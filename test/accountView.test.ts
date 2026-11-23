import { expect, test } from "bun:test";
import { sameAccountState, syncedView } from "../src/accountView";

test("a background sync, failed or not, shows the same account; only SYNCED shows a failure, a new minute or new counts", () => {
  const s = { signedIn: true, persistent: true, displayHint: "jerry@example.com" };
  expect([sameAccountState(s, { ...s }), sameAccountState(s, { ...s, problem: "" }), sameAccountState(s, { ...s, syncFailed: true }), sameAccountState(null, s)]).toEqual([true, true, true, false]);
  expect([sameAccountState(s, { ...s, signedIn: false }), sameAccountState(s, { ...s, problem: "Couldn't sign out." }), sameAccountState(s, { ...s, displayHint: "" })]).toEqual([false, false, false]);
  const at = new Date(2026, 10, 23, 15, 4, 10).getTime();
  const sync = { lastSyncedMs: at, machines: 1, prompts: 2 };
  expect(syncedView(s, { ...sync, lastSyncedMs: at + 20_000 })).toBe(syncedView(s, sync));
  for (const other of [{ ...sync, lastSyncedMs: at + 60_000 }, { ...sync, prompts: 3 }]) expect(syncedView(s, other)).not.toBe(syncedView(s, sync));
  expect(syncedView({ ...s, syncFailed: true }, sync)).not.toBe(syncedView(s, sync));
});
