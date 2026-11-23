// When herdr may be updated from the app (desk_updates.go updateMissing / updateOffer): one policy for
// the update card and Settings' suggestion (settingsUpdates.ts) and the browser's apply guard
// (web/serverUpdateDesk.ts), so the button and the guard agree when the rules change. The state is
// desk_updates.go serverUpdateState as the card reads it.

export interface UpdateAttempt {
  attempt_id: string; build_id: string; from: string; to: string; phase: string;
  bytes_done: number; bytes_total: number; restart_later: boolean;
  outcome?: string | null; message?: string; panes?: number;
}
export interface UpdateCheck {
  running: { version: string; build_id?: string | null; commit_time?: number | null };
  latest?: { version: string; build_id: string; commit_time: number; notes: string } | null;
  update_available: boolean; mode: string; reason?: string;
}
/** The capabilities herdr's ping reports. */
export type UpdateCapabilities = Readonly<Record<string, unknown>>;
export interface UpdateState {
  known: boolean; version: string; flow: string; code: string; message: string;
  forbidden: boolean; restartLater: boolean; missing: string[];
  capabilities?: UpdateCapabilities; check?: UpdateCheck; pending?: UpdateAttempt; attempt?: UpdateAttempt;
}

/** The accepted Swift ServerRequirement.current, not the desktop build date. */
export const UPDATE_MIN_COMMIT_TIME = 1793108998;

/** What this app needs of herdr that the running one lacks. */
export function updateMissing(caps: UpdateCapabilities | undefined): string[] {
  const missing: string[] = [];
  if (caps?.agent_groups !== true) missing.push("folders");
  if (caps?.agent_avatar !== true) missing.push("avatars");
  if (caps?.agent_answer !== true) missing.push("answers from notifications");
  return missing;
}

/** Whether the running herdr is all this app needs: it updates itself, lacks nothing, and is no
 *  older than the accepted requirement. */
export function requirementMet(caps: UpdateCapabilities | undefined, check: UpdateCheck): boolean {
  const time = check.running.commit_time;
  return updateMissing(caps).length === 0 && caps?.server_update === true && (time == null || time >= UPDATE_MIN_COMMIT_TIME);
}

/** Whether the check offers a newer build worth taking: a host short of the requirement takes only
 *  one that meets it. */
export function newerBuildOffered(check: UpdateCheck, caps: UpdateCapabilities | undefined): boolean {
  const latest = check.latest;
  return check.update_available && !!latest && latest.build_id !== "" && (requirementMet(caps, check) || latest.commit_time >= UPDATE_MIN_COMMIT_TIME);
}

/** Whether herdr can install the offer itself: switching live, or on its next restart. */
export const installsItself = (check: UpdateCheck) => check.mode === "live" || check.mode === "restart_required";

/** A download installed earlier that waits for a restart (not yet the running build). */
export function waitingRestart(check: UpdateCheck, pending: UpdateAttempt | undefined): boolean {
  return !!pending && pending.outcome === "downloaded_restart_required" && (check.running.build_id == null || check.running.build_id !== pending.build_id);
}

/** desk_updates.go updateOffer: whether the card may offer, and Apply accept, the checked build. */
export function updateOffer(s: UpdateState): boolean {
  const c = s.check;
  return !s.forbidden && !!c && newerBuildOffered(c, s.capabilities) && installsItself(c) && !waitingRestart(c, s.pending);
}
