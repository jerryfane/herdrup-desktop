// This browser's account statements per machine (POST /v1/statements; AccountService
// statements.ts: 600 s each, exp absolute). An owner hello and its in-band refresh carry one. A
// statement belongs to the session it was issued in: each one is held, and each request shared,
// under that session (its generation and account), and it is stored or handed out only while that
// session is still this page's, so nothing crosses a sign-out, even back into the same account.
// A statement is asked for again once too little of it is left; callers that ask at once share
// one request, and each stops waiting when its own signal aborts while the request goes on.

import { untilAborted } from "../webguest/abort";
import type { StatementSource } from "../webguest/owner";
import { AccountServiceError, type WebAccount } from "./account";

type Held = { jws: string; expMs: number };

/** The session a statement was issued in is no longer this page's (signed out, or another
 *  sign-in): nothing from it is kept or used. */
const stale = () => new AccountServiceError(409, "account_changed");

export function statementCache(account: Pick<WebAccount, "statements" | "currentAccount" | "current" | "generation">, now: () => number = Date.now): StatementSource {
 const held = new Map<string, Held>();
 const asking = new Map<string, Promise<Held>>();
 return {
  async get(hostID, minLeftMs, signal) {
   signal.throwIfAborted();
   const acct = await untilAborted(account.currentAccount(), signal);
   const generation = account.generation;
   const live = () => account.generation === generation && account.current?.accountID === acct;
   if (!live()) throw stale();
   const key = `${generation}\n${acct}\n${hostID}`;
   const h = held.get(key);
   if (h !== undefined && h.expMs - now() >= minLeftMs) return h;
   let flight = asking.get(key);
   if (flight === undefined) {
    flight = account.statements([hostID], acct).then(reply => {
     if (!live()) throw stale();
     const s = reply.statements.find(x => x.host === hostID);
     if (s === undefined || typeof s.jws !== "string" || !Number.isSafeInteger(reply.exp)) throw new Error("The account service gave no statement for this machine.");
     const got = { jws: s.jws, expMs: reply.exp * 1000 };
     held.set(key, got);
     return got;
    }).finally(() => asking.delete(key));
    asking.set(key, flight);
   }
   // The newest the service gives, even with less left than asked: it is all there is.
   const got = await untilAborted(flight, signal);
   if (!live()) throw stale();
   return got;
  },
  drop(hostID, jws) {
   for (const [key, h] of held) if (key.endsWith(`\n${hostID}`) && h.jws === jws) held.delete(key);
  },
 };
}
