// This browser's account statements per machine (POST /v1/statements; AccountService
// statements.ts: 600 s each, exp absolute). An owner hello and its in-band refresh carry one. A
// statement belongs to the account signed in when it was issued: each one is held under that
// account, and a get first reads the account signed in now (none after sign-out), so another
// sign-in never gets the last one's. A statement is asked for again once too little of it is
// left; callers that ask at once share one request, and each stops waiting when its own signal
// aborts while the request goes on for the others.

import { untilAborted } from "../webguest/abort";
import type { StatementSource } from "../webguest/owner";
import type { WebAccount } from "./account";

type Held = { jws: string; expMs: number };

export function statementCache(account: Pick<WebAccount, "statements" | "currentAccount">, now: () => number = Date.now): StatementSource {
 const held = new Map<string, Held>();
 const asking = new Map<string, Promise<Held>>();
 const keyOf = (acct: string, hostID: string) => `${acct}\n${hostID}`;
 return {
  async get(hostID, minLeftMs, signal) {
   const acct = await untilAborted(account.currentAccount(), signal);
   const key = keyOf(acct, hostID);
   const h = held.get(key);
   if (h !== undefined && h.expMs - now() >= minLeftMs) return h;
   let flight = asking.get(key);
   if (flight === undefined) {
    flight = account.statements([hostID], acct).then(reply => {
     const s = reply.statements.find(x => x.host === hostID);
     if (s === undefined || typeof s.jws !== "string" || !Number.isSafeInteger(reply.exp)) throw new Error("The account service gave no statement for this machine.");
     const got = { jws: s.jws, expMs: reply.exp * 1000 };
     held.set(key, got);
     return got;
    }).finally(() => asking.delete(key));
    asking.set(key, flight);
   }
   // The newest the service gives, even with less left than asked: it is all there is.
   return await untilAborted(flight, signal);
  },
  drop(hostID, jws) {
   for (const [key, h] of held) if (key.endsWith(`\n${hostID}`) && h.jws === jws) held.delete(key);
  },
 };
}
