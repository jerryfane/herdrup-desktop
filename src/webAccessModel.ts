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

export interface WebAccessResultView { granted: string[]; skipped: { label: string; reason: string }[]; failed: { label: string; reason: string }[] }

/** What the sheet says after Approve. done: the browser is approved (at least one machine). */
export function resultLines(r: WebAccessResultView): { done: boolean; lines: string[] } {
 const lines: string[] = [];
 if (r.granted.length) lines.push(`Approved on ${r.granted.join(", ")}.`);
 for (const s of r.skipped) lines.push(`${s.label} ${skipReason(s.reason)}.`);
 for (const f of r.failed) lines.push(`${f.label}: ${f.reason}`);
 if (!r.granted.length) lines.push("The browser isn't approved yet. Choose another machine, or Deny.");
 return { done: r.granted.length > 0, lines };
}

/** After a wrong code: the message, and whether the request is now denied. */
export function wrongCode(tries: number, max = 3): string {
 const left = max - tries;
 return left > 0 ? `That code doesn't match the browser's. ${left} ${left === 1 ? "try" : "tries"} left.` : "Denied after three wrong codes.";
}
