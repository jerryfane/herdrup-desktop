import { expect, test } from "bun:test";
import type { AppUpdateState } from "../src/mygo";
import { appUpdateAsk } from "../src/appUpdateAsk";
import { appUpdateNewer } from "../src/appUpdates";

const state = (fields: Partial<AppUpdateState>): AppUpdateState => ({
  current: "0.1.0-preview.12", phase: "idle", reason: "", version: "", notes: "", downloaded: 0, total: 0, error: "", checkedAt: 0, ...fields,
});

// Owner 2026-11-08: a newer app was only flagged inside Settings; it now shows over the agents list.
test("the capsule shows a newer version until dismissed and each new one again", () => {
  expect(appUpdateAsk(state({ phase: "upToDate" }), null)).toBeNull();
  expect(appUpdateAsk(state({ phase: "disabled", reason: "This build can't update itself." }), null)).toBeNull();
  expect(appUpdateAsk(state({ phase: "available", version: "0.1.0-preview.13" }), null))
    .toEqual({ title: "Update ready", body: "0.1.0-preview.13", action: "update", busy: false });
  expect(appUpdateAsk(state({ phase: "available", version: "0.1.0-preview.13" }), "0.1.0-preview.13")).toBeNull();
  expect(appUpdateAsk(state({ phase: "available", version: "0.1.0-preview.14" }), "0.1.0-preview.13")?.body).toBe("0.1.0-preview.14");
});

test("an install that cannot update itself is sent to the release", () => {
  expect(appUpdateAsk(state({ phase: "outdated", version: "0.1.0-preview.13", reason: "Installed by your package manager; update it there." }), null))
    .toEqual({ title: "New version", body: "0.1.0-preview.13", action: "download", busy: false });
});

test("an update under way shows its progress even after a dismissal", () => {
  const installing = state({ phase: "installing", version: "0.1.0-preview.13", downloaded: 45, total: 100 });
  expect(appUpdateAsk(installing, "0.1.0-preview.13")).toEqual({ title: "Updating", body: "Downloading · 45%", action: "update", busy: true });
  expect(appUpdateAsk(state({ phase: "restarting", version: "0.1.0-preview.13" }), null)?.body).toBe("Restarting…");
});

test("the Settings badge counts every newer version, to install or to download", () => {
  for (const phase of ["available", "installing", "restarting", "outdated"]) expect(appUpdateNewer(state({ phase, version: "0.1.0-preview.13" }))).toBe(true);
  for (const phase of ["idle", "checking", "upToDate", "failed", "disabled"]) expect(appUpdateNewer(state({ phase }))).toBe(false);
  expect(appUpdateNewer(null)).toBe(false);
});
