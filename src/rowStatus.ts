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

/** The guest list's second line as plain text, or null where it is the status line (rowPreview):
 *  "Agent unavailable" with no listed agent or one the host says isn't running; "<kind> · <note>"
 *  for an archived agent. `archivedNote` is undefined for a live agent ("" archived without one). */
export function guestRowText(row: Pick<Row, "agent"> | undefined, running: boolean, archivedNote: string | undefined): string | null {
  if (!row || !running) return "Agent unavailable";
  if (archivedNote === undefined) return null;
  return [row.agent, archivedNote].filter(Boolean).join(" · ");
}
