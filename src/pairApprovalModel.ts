// Pair from another device, the approving computer's side (herdr-app PLAN, 26 Nov 2026, option B),
// kept free of the DOM so bun tests it: what "Pair ‹device›?" says at each step.

/** One new device asking to pair (Desk.approvalRequests). */
export interface PairRequestView { id: string; deviceName: string; platform: string; claimed: string; expiresIn: number; createdMs: number }

/** The new device as the sheet names it. */
export function deviceName(r: { deviceName: string }): string {
 return r.deviceName.trim() || "A new device";
}

/** The notice for a request that came while the user was typing. */
export function pairNotice(r: { deviceName: string }): string {
 return `${deviceName(r)} wants to pair with your machines.`;
}

const PLATFORMS: Record<string, string> = {
 macos: "HerdrUp Desktop on macOS", windows: "HerdrUp Desktop on Windows", linux: "HerdrUp Desktop on Linux",
 ios: "HerdrUp on iPhone", ipados: "HerdrUp on iPad",
};

/** The app and platform the request came from ("HerdrUp Desktop on macOS"). */
export function platformLine(platform: string): string {
 return PLATFORMS[platform] ?? (platform ? `HerdrUp on ${platform}` : "HerdrUp");
}

/** The time a request has left, as m:ss. */
export function expiresText(ms: number): string {
 const s = Math.max(0, Math.ceil(ms / 1000));
 return `Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** What the sheet knows of a machine before keys are added: checking (a probe is out), ready, or a
 *  reason it can't be ticked (Desk.pairApproveProbe; needs_key from Desk.webAccessMachines). */
export type ProbeState = "checking" | "ready" | "unreachable" | "needs_update" | "needs_key";

/** Why a machine can't be ticked, or that it is still being checked. here names this computer
 *  ("this Mac"). */
export function probeReason(state: ProbeState, here: string, version = ""): string {
 switch (state) {
  case "checking": return "Checking…";
  case "unreachable": return `Can't reach it from ${here} right now`;
  case "needs_update": return version ? `Needs a herdr update (herdr ${version})` : "Needs a herdr update";
  case "needs_key": return "Needs a key file";
  default: return "";
 }
}

/** The approve button: how many machines get the key. */
export function approveLabel(ticked: number): string {
 return ticked === 0 ? "Approve" : `Approve ${ticked} machine${ticked === 1 ? "" : "s"}`;
}

/** One ticked machine while keys are added and after. */
export type RowStatus = "waiting" | "adding" | "added" | "already" | "failed";

/** A ticked machine's state, as its row says it on the right. */
export function rowStatusText(status: RowStatus, reason = ""): string {
 switch (status) {
  case "waiting": return "Waiting";
  case "adding": return "Adding…";
  case "added": return "Added";
  case "already": return "Already added";
  default: return reason ? `Failed: ${reason}` : "Failed";
 }
}

/** Names as a sentence lists them: "a", "a and b", "a, b and c". */
export function nameList(names: readonly string[]): string {
 return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export interface PairRowView { id: string; label: string; status: string; reason?: string; keyLabel?: string }

/** The line under the title once keys were added: which machines the new device can open now. */
export function resultLead(name: string, rows: readonly PairRowView[]): string {
 const opened = rows.filter(r => r.status === "added" || r.status === "already").map(r => r.label);
 return opened.length ? `${name} can open ${nameList(opened)} with its own key.` : `${name} couldn't be added to any machine.`;
}

/** What to do about the machines that failed, or "" when none did. */
export function failureLine(rows: readonly PairRowView[]): string {
 const failed = rows.filter(r => r.status === "failed");
 if (!failed.length) return "";
 if (failed.length === 1) {
  const [f] = failed;
  return f!.reason === "timed out"
   ? `${f!.label} didn't answer. Try again from here later, or use herdr pair there.`
   : `${f!.label}: ${f!.reason}. Try again from here, or use herdr pair there.`;
 }
 return `${nameList(failed.map(f => f.label))} couldn't be added. Try again from here, or use herdr pair there.`;
}

/** The retry button for the failed machines. */
export function retryLabel(failed: readonly string[]): string {
 return failed.length === 1 ? `Try ${failed[0]} again` : `Try ${failed.length} machines again`;
}

/** The line under the machines: what Approve does, and once keys exist, the label herdr stored
 *  them under (the reply's, which may differ from the one sent), to revoke them by. */
export function keyNote(name: string, rows: readonly PairRowView[] = []): string {
 const labels = [...new Set(rows.filter(r => r.keyLabel).map(r => r.keyLabel!))];
 const how = "Remove it with herdr pair --revoke.";
 if (labels.length === 1) return `Each machine lists the key as “${labels[0]}”. ${how}`;
 return `Approving adds ${name}'s key to the machines you tick, with a herdr command on each. ${how}`;
}

/** The sheet's line for a request that ended before it was approved. */
export const PAIR_ENDED = "This request ended: it expired before anyone approved it.";
