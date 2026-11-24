// What the HerdrUp account panel (herdrupAccount.ts) shows, as values: a redraw that would show
// the same thing is skipped, so the control the person is on keeps keyboard focus when a sync
// finishes in the background.
import type { AccountState, AccountSyncStatus } from "./mygo";

/** Whether next shows the same account as shown (none shown yet: never): the fields the panel
 *  draws from the state. Whether the newest sync failed is SYNCED's (syncedView), which Settings
 *  reloads itself; the short panel doesn't show it. */
export function sameAccountState(shown: AccountState | null, next: AccountState): boolean {
  return shown !== null && shown.signedIn === next.signedIn && shown.persistent === next.persistent
    && (shown.displayHint ?? "") === (next.displayHint ?? "") && (shown.problem ?? "") === (next.problem ?? "");
}

/** SYNCED's line under Sync now: why the last sync didn't finish, or when the last one did (the
 *  minute, as shown), "" before the first. */
export function syncedLine(s: AccountState, sync: AccountSyncStatus | null): string {
  if (s.syncFailed) return "The last sync didn't finish. Try again.";
  return sync && sync.lastSyncedMs > 0 ? `Last synced ${new Date(sync.lastSyncedMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
}

/** Everything SYNCED shows: its counts and its line. */
export function syncedView(s: AccountState, sync: AccountSyncStatus | null): string {
  return JSON.stringify([sync?.machines ?? null, sync?.prompts ?? null, syncedLine(s, sync)]);
}
