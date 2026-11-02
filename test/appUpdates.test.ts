import { expect, test } from "bun:test";
import type { AppUpdateState } from "../src/mygo";
import { appUpdateCheckedLine, appUpdateProgress, appUpdateSummary } from "../src/appUpdates";

const state = (fields: Partial<AppUpdateState>): AppUpdateState => ({
  current: "0.1.0-preview.5", phase: "idle", reason: "", version: "", notes: "", downloaded: 0, total: 0, error: "", checkedAt: 0, ...fields,
});

test("the App updates row says what the last check found", () => {
  expect(appUpdateSummary(null)).toBe("");
  expect(appUpdateSummary(state({ phase: "idle" }))).toBe("");
  expect(appUpdateSummary(state({ phase: "disabled", reason: "This build can't update itself." }))).toBe("Off");
  expect(appUpdateSummary(state({ phase: "upToDate" }))).toBe("Up to date");
  expect(appUpdateSummary(state({ phase: "available", version: "0.1.0-preview.6" }))).toBe("Update available");
  expect(appUpdateSummary(state({ phase: "failed", error: "offline" }))).toBe("Couldn't check");
});

test("an installing update shows how much is downloaded, whole percents, never past 100", () => {
  expect(appUpdateSummary(state({ phase: "installing", downloaded: 0, total: 0 }))).toBe("Updating…");
  expect(appUpdateSummary(state({ phase: "installing", downloaded: 999, total: 1000 }))).toBe("Updating · 99%");
  // A delta that failed starts over with the archive; the callback can briefly report more than the total.
  expect(appUpdateSummary(state({ phase: "installing", downloaded: 2000, total: 1000 }))).toBe("Updating · 100%");
});

test("the download line gives megabytes, also before the size is known", () => {
  expect(appUpdateProgress(state({ phase: "installing" }))).toBe("Downloading…");
  expect(appUpdateProgress(state({ phase: "installing", downloaded: 3 * 1048576 }))).toBe("Downloading · 3.0 MB");
  expect(appUpdateProgress(state({ phase: "installing", downloaded: 5767168, total: 20 * 1048576 }))).toBe("Downloading · 5.5 of 20.0 MB");
});

test("the last check's time leaves out today's date", () => {
  const now = new Date(2026, 10, 2, 18, 0);
  expect(appUpdateCheckedLine(0, now)).toBe("");
  const today = new Date(2026, 10, 2, 9, 5), yesterday = new Date(2026, 10, 1, 9, 5);
  const time = today.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  expect(appUpdateCheckedLine(today.getTime(), now)).toBe(`Last checked at ${time}.`);
  expect(appUpdateCheckedLine(yesterday.getTime(), now)).toBe(`Last checked ${yesterday.toLocaleDateString()} at ${time}.`);
});
