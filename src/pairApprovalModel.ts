// Pair from another device, the approving computer's side (herdr-app PLAN, 26 Nov 2026, option B),
// kept free of the DOM so bun tests it: what "Pair ‹device›?" says at each step.

/** One new device asking to pair (Desk.approvalRequests). */
export interface PairRequestView { id: string; deviceName: string; platform: string; claimed: string; expiresIn: number }

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

/** What the sheet knows of a machine before keys are added: checking (a probe is out, or waits for
 *  the code), ready, or a reason it can't be ticked (Desk.pairApproveProbe; needs_key from
 *  Desk.webAccessMachines). */
export type ProbeState = "checking" | "ready" | "unreachable" | "needs_update" | "needs_key" | "needs_pin" | "unsendable";

/** Why a machine can't be ticked, or that it is still being checked. here names this computer
 *  ("this Mac"); why is Go's reason for an unsendable one. */
export function probeReason(state: ProbeState, here: string, version = "", why = ""): string {
 switch (state) {
  case "checking": return "Checking…";
  case "unreachable": return `Can't reach it from ${here} right now`;
  case "needs_update": return version ? `Needs a herdr update (herdr ${version})` : "Needs a herdr update";
  case "needs_key": return "Needs a key file";
  case "needs_pin": return `Open it once on ${here} first`;
  case "unsendable": return why ? why.charAt(0).toUpperCase() + why.slice(1) : "Can't be sent to the new device";
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

/** A ticked machine's outcome (Desk.pairApproveAdd); retryable: a failure Try again may mend. */
export interface PairRowView { id: string; label: string; status: string; reason?: string; keyLabel?: string; retryable?: boolean }

/** The line under the title once keys were added: which machines the new device can open now. */
export function resultLead(name: string, rows: readonly PairRowView[]): string {
 const opened = rows.filter(r => r.status === "added" || r.status === "already").map(r => r.label);
 return opened.length ? `${name} can open ${nameList(opened)} with its own key.` : `${name} couldn't be added to any machine.`;
}

/** What to do about the machines that failed, or "" when none did: Try again only for those a retry
 *  may mend (retryable), herdr pair there for the rest. */
export function failureLine(rows: readonly PairRowView[]): string {
 const failed = rows.filter(r => r.status === "failed");
 const again = failed.filter(r => r.retryable), stuck = failed.filter(r => !r.retryable);
 const lines: string[] = [];
 if (again.length === 1) {
  const [f] = again;
  lines.push(f!.reason === "timed out"
   ? `${f!.label} didn't answer. Try again from here later, or use herdr pair there.`
   : `${f!.label}: ${f!.reason}. Try again from here, or use herdr pair there.`);
 } else if (again.length) {
  lines.push(`${nameList(again.map(f => f.label))} couldn't be added. Try again from here, or use herdr pair there.`);
 }
 if (stuck.length === 1) lines.push(`${stuck[0]!.label}: ${stuck[0]!.reason}. Use herdr pair there.`);
 else if (stuck.length) lines.push(`${nameList(stuck.map(f => f.label))} couldn't be added from here. Use herdr pair on each.`);
 return lines.join(" ");
}

/** The retry button for the failed machines. */
export function retryLabel(failed: readonly string[]): string {
 return failed.length === 1 ? `Try ${failed[0]} again` : `Try ${failed.length} machines again`;
}

/** The line under the machines: what Approve does, and once keys exist, how to remove one (each row
 *  says the label herdr stored it under, keyListedAs). */
export function keyNote(name: string, rows: readonly PairRowView[] = []): string {
 if (rows.some(r => r.keyLabel)) return "Remove a key with herdr pair --revoke and the name it's listed as.";
 return `Approving adds ${name}'s key to the machines you tick, with a herdr command on each. Remove it with herdr pair --revoke.`;
}

/** A row's line once its key is there: the label herdr stored it under (its reply's, which may
 *  differ from the one sent). */
export function keyListedAs(label: string): string {
 return `Listed as “${label}”`;
}

/** The sheet's line for a request that ended before it was approved. */
export const PAIR_ENDED = "This request ended: it expired before anyone approved it.";
