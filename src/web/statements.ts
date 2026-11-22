// This browser's account statements per machine (POST /v1/statements; AccountService
// statements.ts: 600 s each, exp absolute). An owner hello and its in-band refresh carry one; a
// statement is asked for again once too little of it is left, and callers that ask at once share
// one request.

import type { StatementSource } from "../webguest/owner";
import type { WebAccount } from "./account";

export function statementCache(account: Pick<WebAccount, "statements">, now: () => number = Date.now): StatementSource {
 const held = new Map<string, { jws: string; expMs: number }>();
 const asking = new Map<string, Promise<{ jws: string; expMs: number }>>();
 return {
  async get(hostID, minLeftMs) {
   const h = held.get(hostID);
   if (h !== undefined && h.expMs - now() >= minLeftMs) return h;
   let flight = asking.get(hostID);
   if (flight === undefined) {
    flight = account.statements([hostID]).then(reply => {
     const s = reply.statements.find(x => x.host === hostID);
     if (s === undefined || typeof s.jws !== "string" || !Number.isSafeInteger(reply.exp)) throw new Error("The account service gave no statement for this machine.");
     const got = { jws: s.jws, expMs: reply.exp * 1000 };
     held.set(hostID, got);
     return got;
    }).finally(() => asking.delete(hostID));
    asking.set(hostID, flight);
   }
   // The newest the service gives, even with less left than asked: it is all there is.
   return await flight;
  },
  drop(hostID) { held.delete(hostID); },
 };
}
