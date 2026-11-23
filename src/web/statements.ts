// This browser's account statements per machine (POST /v1/statements; AccountService
// statements.ts: 600 s each, exp absolute). An owner hello and its in-band refresh carry one. A
// statement belongs to the session it was issued in (WebAccount.generation and the account):
// the cache holds only the current session's, drops them all when the session changes, and
// stores or hands one out only while that session is still the page's; each statement it gives
// says live() for the transport to check again right before it dials and sends. A statement is
// asked for again once too little of it is left; callers that ask at once share one request,
// and each stops waiting when its own signal aborts while the request goes on.

import type { StatementSource } from "../webguest/owner";
import { AccountServiceError, type WebAccount } from "./account";

type Held = { jws: string; expMs: number };

/** p, or the abort's reason as soon as signal aborts (p goes on for anyone else waiting on it,
 *  and its outcome is still observed, so a rejection nobody waits for doesn't go unhandled). */
function waitFor<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
 if (signal.aborted) { p.catch(() => {}); return Promise.reject(signal.reason); }
 return new Promise<T>((resolve, reject) => {
  const stop = () => reject(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  p.then(v => { signal.removeEventListener("abort", stop); resolve(v); }, e => { signal.removeEventListener("abort", stop); reject(e); });
 });
}

/** The session a statement was issued in is no longer this page's (signed out, or another
 *  sign-in): nothing from it is kept or used. */
const stale = () => new AccountServiceError(409, "account_changed");

export function statementCache(account: Pick<WebAccount, "statements" | "currentAccount" | "current" | "generation" | "onSessionChange">, now: () => number = Date.now): StatementSource {
 // The current session's statements and requests, by host; replaced when the session changes.
 let session = "";
 let held = new Map<string, Held>();
 let asking = new Map<string, Promise<Held>>();
 // Nothing signed is kept past its session: a sign-out or another sign-in empties the cache
 // at once, not at the next lookup.
 account.onSessionChange(() => { session = ""; held = new Map(); asking = new Map(); });
 return {
  async get(hostID, minLeftMs, signal) {
   signal.throwIfAborted();
   const acct = await waitFor(account.currentAccount(), signal);
   const generation = account.generation;
   const live = () => account.generation === generation && account.current?.accountID === acct;
   if (!live()) throw stale();
   if (session !== `${generation}\n${acct}`) { session = `${generation}\n${acct}`; held = new Map(); asking = new Map(); }
   const mine = { held, asking };
   const h = held.get(hostID);
   if (h !== undefined && h.expMs - now() >= minLeftMs) return { ...h, live };
   let flight = asking.get(hostID);
   if (flight === undefined) {
    flight = account.statements([hostID], acct).then(reply => {
     const s = reply.statements.find(x => x.host === hostID);
     if (s === undefined || typeof s.jws !== "string" || !Number.isSafeInteger(reply.exp)) throw new Error("The account service gave no statement for this machine.");
     const got = { jws: s.jws, expMs: reply.exp * 1000 };
     // An answer that comes after its session ended isn't kept.
     if (live()) mine.held.set(hostID, got);
     return got;
    }).finally(() => mine.asking.delete(hostID));
    asking.set(hostID, flight);
   }
   // The newest the service gives, even with less left than asked: it is all there is.
   const got = await waitFor(flight, signal);
   if (!live()) throw stale();
   return { ...got, live };
  },
  drop(hostID, jws) {
   if (held.get(hostID)?.jws === jws) held.delete(hostID);
  },
 };
}
