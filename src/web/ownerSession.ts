// The owner page and its account session (hosts.ts). The account's sign-out attempt is the one
// record of a sign-out (WebAccount.signOutAttempt); the page follows what it says, as
// onSessionChange tells it:
// - A sign-out starting ends the session's owner links and approval at once ("sign-out-sending").
// - The page starts over for whoever is signed in now (boot.ts chooses again) once the sign-out
//   went through, or the service said there is no session ("no-session": after a refusal, or for
//   a page the last load handed a session the service no longer has, bootChoice.ts).
// - A refused sign-out leaves the page: the account panel says why and offers Sign out again. Its
//   own account read back ("restored") starts again, under a new owner session, all the work the
//   sign-out stopped (OwnerWork, resumeWork); another account ("restored-other-account"), as any
//   change with no sign-out around, starts over.
// - The page's first session ("signed-in": a load the last one found signed in opens the owner's
//   page before the lookup answers, bootChoice.ts) is the one the page was loaded for: it goes on.
// - The page leaves (a reload, the guest page, a provider's sign-in) only once no sign-out is being
//   sent: leaving would cancel the request and the cookie would stay signed in. Every way this
//   document leaves goes through its one PageExit (mygo.ts pageExit), and a boot mark is written
//   only by the exit that wins.

import type { SessionChange, WebAccount } from "./account";
import type { OwnerPhase } from "./ownerApproval";

export interface SessionFollower {
 /** The session's links and work end (at a sign-out's start, or a change). */
 end(): void;
 /** The page loads again, for whoever is signed in now. */
 startOver(): void;
 /** A refused sign-out's account came back: its screen again. */
 restored(): void;
}

export function followSession(account: Pick<WebAccount, "onSessionChange">, page: SessionFollower): void {
 account.onSessionChange((change: SessionChange) => {
  switch (change) {
   case "sign-out-sending": page.end(); return;
   case "signed-in": case "sign-out-refused": return;
   case "restored": page.restored(); return;
   case "signed-out": case "no-session": page.startOver(); return;
   case "session": case "restored-other-account": page.end(); page.startOver(); return;
  }
 });
}

/** The owner page's work that was running when its session ended: an approval in flight, the
 *  machine list's refresh, its probes, and the machine (M) whose link was open or opening. */
export interface StoppedWork<M> { approval: boolean; listRefresh: boolean; probes: boolean; link: M | null }

/** Whether an approval in phase kind is still running (asking, waiting for a device, showing the
 *  code). One that ended (approved, denied, expired, failed, held elsewhere, unsupported) isn't: a
 *  restored session leaves it as it is, for the person to try again. */
export function approvalRunning(kind: OwnerPhase["kind"]): boolean {
 return kind === "starting" || kind === "waiting" || kind === "code";
}

/** The link a session's end closes, for the record: the machine being opened (its connect is
 *  cancelled), else the owner link that is open (ownerLink.ts's record), whatever its last list
 *  said: a link between a failed list and the next one is still the open link. */
export function closingLink<M>(opening: M | null, open: { machine: M } | null): M | null {
 return opening ?? open?.machine ?? null;
}

/** The owner page's work for its account session (owner links, probes, the approval, the list's
 *  refresh): the signal it runs under, or null from a sign-out's start until its own account is
 *  read back. Nothing new starts while it is null.
 *  The one record of what to start again: end writes it once, at the moment a running session
 *  actually stops, with exactly what was running then; an end while nothing runs (a second
 *  refusal's sign-out) is a no-op that never overwrites it. resume consumes it once, under a new
 *  session. Work that had ended by itself (an approval denied or expired) isn't in it, so a
 *  restored session doesn't start it again. */
export class OwnerWork<M> {
 /** The session's work runs under; null from a session's end until resume. */
 #session: AbortController | null = new AbortController();
 /** What the end stopped; null while a session runs. */
 #stopped: StoppedWork<M> | null = null;
 get signal(): AbortSignal | null { return this.#session?.signal ?? null; }
 /** The session ended: its work stops, and none starts until resume. running is what runs now,
  *  read only when a session was running. */
 end(running: () => StoppedWork<M>): void {
  if (this.#session === null) return;
  this.#stopped = running();
  this.#session.abort(); this.#session = null;
 }
 /** The same account was read back: work goes on under a new session; what to start again, once
  *  (null when no session had ended). */
 resume(): StoppedWork<M> | null {
  const stopped = this.#stopped;
  if (stopped === null) return null;
  this.#session = new AbortController();
  this.#stopped = null;
  return stopped;
 }
}

/** A document's one way out (one per page: mygo.ts pageExit). leave(exit) runs exit once no
 *  sign-out is being sent; exit holds everything leaving does, its boot mark included, so a mark is
 *  written only by the exit that runs. One exit is pending at a time, and the page leaves once: a
 *  choice the person makes (chosen: the guest page, a provider's sign-in) takes the place of the
 *  one pending before it, the latest choice winning, and a default exit (the page starting over)
 *  never takes the place of a choice. */
export class PageExit {
 #pending: { exit: () => void | "stayed"; chosen: boolean } | null = null;
 #left = false;
 constructor(private readonly account: Pick<WebAccount, "signOutSettled" | "signOutAttempt">) {}
 /** exit leaves, or returns "stayed" when it found it can't (the page goes on, and may leave
  *  later). The check that no sign-out is being sent and the exit run in the same continuation,
  *  never before a later turn has had its chance to start one (leave, then Sign out in the same
  *  turn: the exit waits for that sign-out). */
 leave(exit: () => void | "stayed", chosen = false): void {
  if (this.#left || (this.#pending?.chosen === true && !chosen)) return;
  const waiting = this.#pending !== null;
  this.#pending = { exit, chosen };
  if (waiting) return;
  void (async () => {
   do await this.account.signOutSettled(); while (this.account.signOutAttempt?.phase === "sending");
   const pending = this.#pending!;
   this.#pending = null;
   // Claimed before it runs: a leave from inside the exit finds the page left, and queues nothing.
   this.#left = true;
   if (pending.exit() === "stayed") this.#left = false;
  })();
 }
}
