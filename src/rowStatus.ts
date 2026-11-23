// An agent row's status as plain muted words (Topics A-v2, owner 2026-11-23: no badges; one small
// dot only for Working and Needs you). `badge` is the row's group as Go names it
// (internal/herdr/board.go badgeOf, plus "offline").

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
