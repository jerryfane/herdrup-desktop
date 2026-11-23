// An owner browser's link to one of its machines (web owner access WIRE-PLAN §1.2; herdr guest/
// owner.rs admit_in). The hello carries the browser's own account statement for that machine:
// {"v":1,"mode":"owner","account":"<jws>","device":"Chrome on macOS"}. The machine admits it only
// with a live grant for this key AND that statement, and ends the session at the statement's
// deadline unless a newer one comes in-band (transport.ts keepAccount).

import { other } from "./errors";
import type { Endpoint } from "./invite";
import type { AccountStatement, TransportLink } from "./transport";

/** A statement the hello or a refresh sends: enough of it left, or a fresh one; live says
 *  whether the session it was issued in is still the page's. */
export interface StatementSource {
 get(hostID: string, minLeftMs: number, signal: AbortSignal): Promise<AccountStatement>;
 /** Forgets jws for hostID if it is still the statement held: the machine refused it. A newer
  *  one another connection already took stays. */
 drop(hostID: string, jws: string): void;
}

/** A hello's statement must outlive the handshake and a first round trip. */
export const HELLO_MIN_LEFT_MS = 120_000;
/** A refresh goes 2 minutes before the deadline; the statement it sends should be a new one. */
export const REFRESH_MIN_LEFT_MS = 300_000;

export function ownerLink(endpoint: Endpoint, device: string, statements: StatementSource): TransportLink {
 return {
  endpoint,
  async hello(signal) {
   const { jws, live } = await statements.get(endpoint.hostID, HELLO_MIN_LEFT_MS, signal);
   return {
    payload: new TextEncoder().encode(JSON.stringify({ v: 1, mode: "owner", account: jws, device })),
    refused: () => statements.drop(endpoint.hostID, jws),
    live,
   };
  },
  admit(reply) {
   if (reply.mode !== "owner") throw other("The machine didn't admit this browser as its owner.");
  },
  statement: signal => statements.get(endpoint.hostID, REFRESH_MIN_LEFT_MS, signal),
 };
}
