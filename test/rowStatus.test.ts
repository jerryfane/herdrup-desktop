// An agent row's status words (src/rowStatus.ts, Topics A-v2): a dot only for Needs you and Working.
import { expect, test } from "bun:test";
import { rowStatus } from "../src/rowStatus";

test("each board group reads as words; only Needs you and Working carry a dot", () => {
  expect(rowStatus("waiting")).toEqual({ text: "Needs you", dot: "waiting" });
  expect(rowStatus("working")).toEqual({ text: "Working", dot: "working" });
  expect(rowStatus("stopped")).toEqual({ text: "Stopped", dot: null });
  expect(rowStatus("unrecognised")).toEqual({ text: "Unrecognised", dot: null });
  expect(rowStatus("offline")).toEqual({ text: "Offline", dot: null });
  expect(rowStatus("none")).toEqual({ text: "Idle", dot: null });
});
