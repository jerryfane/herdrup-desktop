// An agent row's status words (src/rowStatus.ts, Topics A-v2): a dot only for Needs you and Working,
// and the guest list's plain second line.
import { expect, test } from "bun:test";
import { guestRowText, rowStatus } from "../src/rowStatus";

test("each board group reads as words; only Needs you and Working carry a dot", () => {
  expect(rowStatus("waiting")).toEqual({ text: "Needs you", dot: "waiting" });
  expect(rowStatus("working")).toEqual({ text: "Working", dot: "working" });
  expect(rowStatus("stopped")).toEqual({ text: "Stopped", dot: null });
  expect(rowStatus("unrecognised")).toEqual({ text: "Unrecognised", dot: null });
  expect(rowStatus("offline")).toEqual({ text: "Offline", dot: null });
  expect(rowStatus("none")).toEqual({ text: "Idle", dot: null });
});

test("the guest row: unavailable without a running agent, kind and note when archived, the status line when live", () => {
  const row = { agent: "omp" };
  expect(guestRowText(undefined, true, undefined)).toBe("Agent unavailable");
  expect(guestRowText(row, false, undefined)).toBe("Agent unavailable");
  expect(guestRowText(row, false, "archived 3 Nov")).toBe("Agent unavailable");
  expect(guestRowText(row, true, "archived 3 Nov")).toBe("omp · archived 3 Nov");
  expect(guestRowText(row, true, "")).toBe("omp");
  expect(guestRowText(row, true, undefined)).toBe(null);
});
