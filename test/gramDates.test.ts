// herdrup 9876878 has no GramDates unit tests; these pin the day buckets of
// App/GramCards.swift `GramDates.day(of:)` and the strings of `separator` / `rowTime`.
import { expect, test } from "bun:test";
import { rowTime, separator } from "../src/gramDates";

const opts = { locale: "en-US", timeZone: "Europe/Rome" };
// Thursday 29 October 2026, 10:00 in Rome (UTC+1 after the 25 October DST change).
const now = new Date("2026-10-29T09:00:00Z");
const at = (iso: string) => new Date(iso);

test("rowTime: today is the time", () => {
  expect(rowTime(at("2026-10-28T23:05:00Z"), now, opts)).toBe("12:05 AM"); // 00:05 local, today
});

test("rowTime: yesterday by calendar day, not 24 hours", () => {
  expect(rowTime(at("2026-10-28T22:59:00Z"), now, opts)).toBe("Yesterday"); // 23:59 local
  expect(rowTime(at("2026-10-27T23:00:00Z"), now, opts)).toBe("Yesterday"); // 00:00 local
});

test("rowTime: two to six days back is the weekday", () => {
  expect(rowTime(at("2026-10-27T12:00:00Z"), now, opts)).toBe("Tuesday");
  expect(rowTime(at("2026-10-23T12:00:00Z"), now, opts)).toBe("Friday");
});

test("rowTime: a week or more back is a short date", () => {
  expect(rowTime(at("2026-10-22T12:00:00Z"), now, opts)).toBe("10/22/26");
  expect(rowTime(at("2025-12-31T12:00:00Z"), now, opts)).toBe("12/31/25");
});

test("separator: Today / Yesterday / weekday / this year / earlier, with the time", () => {
  expect(separator(at("2026-10-29T08:30:00Z"), now, opts)).toEqual({ day: "Today", time: "9:30 AM" });
  expect(separator(at("2026-10-28T16:00:00Z"), now, opts)).toEqual({ day: "Yesterday", time: "5:00 PM" });
  expect(separator(at("2026-10-24T16:00:00Z"), now, opts).day).toBe("Saturday");
  expect(separator(at("2026-10-22T16:00:00Z"), now, opts).day).toBe("Thu, Oct 22");
  expect(separator(at("2025-10-22T16:00:00Z"), now, opts).day).toBe("Oct 22, 2025");
});

test("the calendar day of now is read in the given time zone", () => {
  // 02:00 on 30 October in Kiritimati (UTC+14); 23:00 on the 29th there is yesterday.
  const kiritimati = { locale: "en-US", timeZone: "Pacific/Kiritimati" };
  expect(rowTime(at("2026-10-29T09:00:00Z"), at("2026-10-29T12:00:00Z"), kiritimati)).toBe("Yesterday");
});

test("a future date this year is a date, not a weekday", () => {
  expect(separator(at("2026-11-01T12:00:00Z"), now, opts).day).toBe("Sun, Nov 1");
});
