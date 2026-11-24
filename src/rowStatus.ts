// An agent row's status in words, and which second line the guest list draws. `badge` is the
// row's group as Go names it (internal/herdr/board.go badgeOf, plus "offline"). Stateless: the
// avatar's status badge (faces.ts) is labelled with it, and the guest's list (guestHome.ts) says it
// after the agent's kind, so the browser guest loads nothing of the owner's sidebar widgets for it.

import type { Row } from "./mygo";

export function rowStatus(badge: string): string {
  switch (badge) {
    case "waiting": return "Needs you";
    case "working": return "Working";
    case "stopped": return "Stopped";
    case "unrecognised": return "Unrecognised";
    case "offline": return "Offline";
  }
  return "Idle";
}

/** The guest list's second line, by which of three rows it is: "unavailable" with no listed agent
 *  or one the host says isn't running; "archived" with "<kind> · <note>"; "live" with the row,
 *  drawn as "<kind> · <status>". `archivedNote` is undefined for a live agent ("" for an archived
 *  one without a note). */
export type GuestRowLine<R> = { kind: "unavailable" } | { kind: "archived"; text: string } | { kind: "live"; row: R };
export function guestRowLine<R extends Pick<Row, "agent">>(row: R | undefined, running: boolean, archivedNote: string | undefined): GuestRowLine<R> {
  if (!row || !running) return { kind: "unavailable" };
  if (archivedNote === undefined) return { kind: "live", row };
  return { kind: "archived", text: [row.agent, archivedNote].filter(Boolean).join(" · ") };
}
