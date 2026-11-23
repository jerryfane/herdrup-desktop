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

/** How the four code boxes show the one input's caret and selection (start, end): which hold a
 *  digit, which the selection covers, and the box the next digit goes into (the last once all four
 *  are typed), ringed while the input has focus. */
export function codeSlots(length: number, start: number, end: number): { filled: boolean; selected: boolean; active: boolean }[] {
 return [0, 1, 2, 3].map(i => ({ filled: i < length, selected: start <= i && i < end, active: i === Math.min(start, 3) }));
}

/** A click on a box: its digit is selected, so Backspace or Delete removes that digit and typing
 *  replaces it; on a box past the digits the caret goes after the last one. */
export function slotSelection(slot: number, length: number): [number, number] {
 return slot < length ? [slot, slot + 1] : [length, length];
}

/** How far, in CSS pixels, the pointer may wander during a press that still counts as a click. */
export const DRAG_PX = 4;

/** One press on the code, followed from mousedown through each move to the click. Only a plain
 *  click takes a box's digit (slotSelection). A press that moved past DRAG_PX at any point is a
 *  drag, even one that came back to where it started, and keeps what the field selected, as do a
 *  double click and a shift-click. */
export class CodePress {
 private dragged = false;
 constructor(private readonly x: number, private readonly y: number) {}
 move(x: number, y: number): void {
  if (Math.hypot(x - this.x, y - this.y) > DRAG_PX) this.dragged = true;
 }
 plainClick(click: { detail: number; shiftKey: boolean }): boolean {
  return !this.dragged && click.detail === 1 && !click.shiftKey;
 }
}

/** Approve needs 4 digits and at least one machine (the sheet also waits for calls in flight). */
export function canApprove(code: string, machines: number): boolean {
 return code.length === 4 && machines > 0;
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

/** The sheet's access choices, value and label. How long access lasts comes from the computer
 *  (Desk.webAccessLengths), which grants it. */
export const ACCESS_CHOICES: readonly (readonly [string, string])[] = [["terminal", "Chat and terminal"], ["chat", "Chat only"]];

export function choiceLabel(choices: readonly (readonly [string, string])[], value: string): string {
 return choices.find(([v]) => v === value)?.[1] ?? value;
}

/** A length as the For choices say it, in days: the computer offers whole days only
 *  (app/desk_web_access.go webAccessLengths). */
export function lengthLabel(seconds: number): string {
 const days = seconds / 86_400;
 return `${days} day${days === 1 ? "" : "s"}`;
}

/** The Machines row, closed: the ticked machines by name, the first two and a count past three. */
export function machinesSummary(machines: readonly { id: string; label: string }[], ticked: ReadonlySet<string>): string {
 if (!machines.length) return "None yet";
 const names = machines.filter(m => ticked.has(m.id)).map(m => m.label);
 if (!names.length) return "None ticked";
 return names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** The For row, closed: how long, and the day it ends ("30 days, until 23 Dec"); endMs is the
 *  previewed end (now plus the duration the computer grants) or the grant's own expiry. */
export function timeSummary(seconds: number, endMs: number): string {
 const end = new Date(endMs).toLocaleDateString(undefined, { day: "numeric", month: "short" });
 return `${lengthLabel(seconds)}, until ${end}`;
}

/** The line under the rows: what Approve turns on, and why any machine can't be ticked, so both
 *  show with the Machines row closed. */
export function machinesNote(machines: readonly { label: string; available: boolean; unavailable?: string }[]): string {
 return ["Approving turns on web access on the machines you tick.", ...machines.filter(m => !m.available).map(m => `${m.label} ${skipReason(m.unavailable ?? "")}.`)].join(" ");
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
