// An agent row's status as plain muted words (Topics A-v2, owner 2026-11-23: no badges; one small
// dot only for Working and Needs you), and the row's second line built from it. `badge` is the
// row's group as Go names it (internal/herdr/board.go badgeOf, plus "offline"). Stateless: the
// owner's roster (main.ts) and the guest's list (guestHome.ts) both draw with it, and the browser
// guest loads nothing of the owner's sidebar widgets for it.

import type { Row } from "./mygo";

export interface RowStatus { text: string; dot: "working" | "waiting" | null }

export function rowStatus(badge: string): RowStatus {
  switch (badge) {
    case "waiting": return { text: "Needs you", dot: "waiting" };
    case "working": return { text: "Working", dot: "working" };
    case "stopped": return { text: "Stopped", dot: null };
    case "unrecognised": return { text: "Unrecognised", dot: null };
    case "offline": return { text: "Offline", dot: null };
  }
  return { text: "Idle", dot: null };
}

/** An agent row's second line, the owner's roster and the guest's list alike: the status as
 *  muted words, a small dot only for Needs you and Working, then `detail` (the roster's preview,
 *  the guest's agent kind): "• Needs you · Merge #305 and update…". */
export function rowPreview(r: Row, detail: string): HTMLElement {
  const line = document.createElement("div"); line.className = "preview t-row-preview";
  const s = rowStatus(r.badge);
  const status = document.createElement("span"); status.className = "row-status";
  if (s.dot) {
    const dot = document.createElement("span"); dot.className = "row-status-dot";
    dot.dataset.dot = s.dot; dot.setAttribute("aria-hidden", "true"); status.append(dot);
  }
  status.append(s.text);
  line.append(status);
  if (detail) { const sep = document.createElement("span"); sep.className = "row-status-sep"; sep.textContent = "·"; line.append(sep, detail); }
  return line;
}

/** The guest list's second line, by which of three rows it is: "unavailable" with no listed agent
 *  or one the host says isn't running; "archived" with "<kind> · <note>"; "live" with the row,
 *  drawn as the status line (rowPreview). `archivedNote` is undefined for a live agent ("" for an
 *  archived one without a note). */
export type GuestRowLine<R> = { kind: "unavailable" } | { kind: "archived"; text: string } | { kind: "live"; row: R };
export function guestRowLine<R extends Pick<Row, "agent">>(row: R | undefined, running: boolean, archivedNote: string | undefined): GuestRowLine<R> {
  if (!row || !running) return { kind: "unavailable" };
  if (archivedNote === undefined) return { kind: "live", row };
  return { kind: "archived", text: [row.agent, archivedNote].filter(Boolean).join(" · ") };
}
