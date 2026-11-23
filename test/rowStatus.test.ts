// An agent row's status words (src/rowStatus.ts, Topics A-v2): a dot only for Needs you and Working,
// and which of its three second lines the guest list draws.
import { expect, test } from "bun:test";
import { guestRowLine, rowStatus } from "../src/rowStatus";

test("each board group reads as words; only Needs you and Working carry a dot", () => {
  expect(rowStatus("waiting")).toEqual({ text: "Needs you", dot: "waiting" });
  expect(rowStatus("working")).toEqual({ text: "Working", dot: "working" });
  expect(rowStatus("stopped")).toEqual({ text: "Stopped", dot: null });
  expect(rowStatus("unrecognised")).toEqual({ text: "Unrecognised", dot: null });
  expect(rowStatus("offline")).toEqual({ text: "Offline", dot: null });
  expect(rowStatus("none")).toEqual({ text: "Idle", dot: null });
});

test("the guest row: unavailable without a running agent, kind and note when archived, the live row for the status line", () => {
  const row = { agent: "omp" };
  expect(guestRowLine(undefined, true, undefined)).toEqual({ kind: "unavailable" });
  expect(guestRowLine(row, false, undefined)).toEqual({ kind: "unavailable" });
  expect(guestRowLine(row, false, "archived 3 Nov")).toEqual({ kind: "unavailable" });
  expect(guestRowLine(row, true, "archived 3 Nov")).toEqual({ kind: "archived", text: "omp · archived 3 Nov" });
  expect(guestRowLine(row, true, "")).toEqual({ kind: "archived", text: "omp" });
  const live = guestRowLine(row, true, undefined);
  expect(live).toEqual({ kind: "live", row });
  expect(live.kind === "live" && live.row).toBe(row);
});
