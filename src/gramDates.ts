// Day and time wording for the Gram feed's separators and the sidebar rows, like Messages.
// Ported from herdrup 9876878 App/GramCards.swift `GramDates` (≈L115-170). Swift's
// DateFormatter templates map to Intl options: "jmm" → hour numeric + minute 2-digit,
// "EEEE" → long weekday, "EEEdMMM" → short weekday + day + short month, "dMMMyyyy" →
// day + short month + year, `.short` date style → dateStyle "short".
//
// `now` is a parameter; `locale` and `timeZone` default to the system's (herdrup's
// `Calendar.current` and the formatters' default locale) and are fixed in tests.

export type GramDateOptions = { locale?: string; timeZone?: string };

type Day = "today" | "yesterday" | "thisWeek" | "thisYear" | "earlier";

/** The calendar date of `date` in `timeZone`, as a UTC-midnight day number and its year. */
function calendarDay(date: Date, timeZone: string | undefined): { day: number; year: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const year = get("year");
  return { day: Date.UTC(year, get("month") - 1, get("day")) / 86_400_000, year };
}

function dayOf(date: Date, now: Date, timeZone: string | undefined): Day {
  const d = calendarDay(date, timeZone);
  const n = calendarDay(now, timeZone);
  const days = n.day - d.day;
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days >= 2 && days < 7) return "thisWeek";
  return d.year === n.year ? "thisYear" : "earlier";
}

function format(date: Date, options: GramDateOptions, fields: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(options.locale, { timeZone: options.timeZone, ...fields }).format(date);
}

const TIME: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
const WEEKDAY: Intl.DateTimeFormatOptions = { weekday: "long" };

/** A feed separator: "Today" / "Yesterday" / a weekday within the week / a date, plus the time. */
export function separator(date: Date, now: Date, options: GramDateOptions = {}): { day: string; time: string } {
  const time = format(date, options, TIME);
  switch (dayOf(date, now, options.timeZone)) {
    case "today":
      return { day: "Today", time };
    case "yesterday":
      return { day: "Yesterday", time };
    case "thisWeek":
      return { day: format(date, options, WEEKDAY), time };
    case "thisYear":
      return { day: format(date, options, { weekday: "short", day: "numeric", month: "short" }), time };
    case "earlier":
      return { day: format(date, options, { day: "numeric", month: "short", year: "numeric" }), time };
  }
}

/** A sidebar row's time: the time today, then "Yesterday", a weekday, a short date. */
export function rowTime(date: Date, now: Date, options: GramDateOptions = {}): string {
  switch (dayOf(date, now, options.timeZone)) {
    case "today":
      return format(date, options, TIME);
    case "yesterday":
      return "Yesterday";
    case "thisWeek":
      return format(date, options, WEEKDAY);
    case "thisYear":
    case "earlier":
      return format(date, options, { dateStyle: "short" });
  }
}
