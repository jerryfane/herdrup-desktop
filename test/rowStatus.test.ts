// An agent row's status words (src/rowStatus.ts): the avatar badge's label and the guest list's
// "<kind> · <status>", and which of its three second lines the guest list draws.
import { expect, test } from "bun:test";
import { guestRowLine, rowStatus } from "../src/rowStatus";

test("each board group reads as words", () => {
  expect(rowStatus("waiting")).toBe("Needs you");
  expect(rowStatus("working")).toBe("Working");
  expect(rowStatus("stopped")).toBe("Stopped");
  expect(rowStatus("unrecognised")).toBe("Unrecognised");
  expect(rowStatus("offline")).toBe("Offline");
  expect(rowStatus("none")).toBe("Idle");
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
