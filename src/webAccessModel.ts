// Web owner access, the approving computer's side (WIRE-PLAN §2.2, D1), kept free of the DOM so bun
// tests it: when the approval sheet opens on its own, what the typed code may be, and what an
// approval's result says.

/** One browser waiting for approval (Desk.webAccessRequests). */
export interface WebAccessRequestView { id: string; browserName: string; claimed: string; expiresIn: number }

/** The request the sheet should open for, or null: the oldest one nobody is approving that the user
 *  hasn't closed on this computer. "you" is this computer's own claim (the sheet is already open). */
export function nextRequest(requests: readonly WebAccessRequestView[], closed: ReadonlySet<string>): WebAccessRequestView | null {
 return requests.find(r => r.claimed === "no" && r.expiresIn > 0 && !closed.has(r.id)) ?? null;
}

/** How long a "not offered" answer from the account service holds before the page asks again, so a
 *  rollout is seen without signing in again. */
export const OFFERED_RECHECK_MS = 10 * 60_000;

/** Whether to ask the service if it offers browser approval: never asked (or the answer was an
 *  error, which the page doesn't keep), or "no" asked long enough ago. */
export function askOffered(last: { offered: boolean; at: number } | null, now: number): boolean {
 return last === null || (!last.offered && now - last.at >= OFFERED_RECHECK_MS);
}

/** The code box keeps digits only, at most 4. */
export function codeInput(raw: string): string {
 return raw.replace(/\D+/g, "").slice(0, 4);
}

/** Approve is possible with 4 digits, at least one machine and nothing in flight. */
export function canApprove(code: string, machines: number, busy: boolean): boolean {
 return code.length === 4 && machines > 0 && !busy;
}

const SKIP_REASONS: Record<string, string> = {
 needs_update: "needs a newer herdr",
 unsupported: "can't share with the web (Windows)",
 unreachable: "couldn't be reached",
 relay_not_allowed: "uses a relay the web app can't reach",
 needs_key: "needs a key file (connect it once with a key)",
};

export function skipReason(reason: string): string {
 return SKIP_REASONS[reason] ?? reason;
}

export interface WebAccessResultView {
 granted: string[]; skipped: { label: string; reason: string }[]; failed: { label: string; reason: string }[];
 unsure?: boolean; problem?: string;
}

/** What the sheet says after Approve. done: the browser is approved (at least one machine). unsure:
 *  the service's answer was lost; the access stays until Approve (the same answer again) or Deny. */
export function resultLines(r: WebAccessResultView): { done: boolean; unsure: boolean; lines: string[] } {
 if (r.unsure) {
  return { done: false, unsure: true, lines: [
   `Couldn't tell whether the browser was approved${r.problem ? ` (${r.problem})` : ""}.`,
   "Try again sends the same answer; Deny removes the access it added.",
  ] };
 }
 const lines: string[] = [];
 if (r.granted.length) lines.push(`Approved on ${r.granted.join(", ")}.`);
 for (const s of r.skipped) lines.push(`${s.label} ${skipReason(s.reason)}.`);
 for (const f of r.failed) lines.push(`${f.label}: ${f.reason}`);
 if (!r.granted.length) lines.push("The browser isn't approved yet. Choose another machine, or Deny.");
 return { done: r.granted.length > 0, unsure: false, lines };
}

/** A wrong code as the computer counted it (Desk.webAccessCheckCode): left more may be typed; at 0
 *  this computer won't approve, and denied says the browser was told (else problem says why not). */
export function wrongCode(c: { left: number; denied: boolean; problem?: string }): string {
 if (c.left > 0) return `That code doesn't match the browser's. ${c.left} ${c.left === 1 ? "try" : "tries"} left.`;
 if (c.denied) return "Too many wrong codes. The request was denied.";
 return `Too many wrong codes, so this computer won't approve it. Telling the browser failed${c.problem ? ` (${c.problem})` : ""}: Deny to try again.`;
}
