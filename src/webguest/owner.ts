// An owner browser's link to one of its machines (web owner access WIRE-PLAN §1.2; herdr guest/
// owner.rs admit_in). The hello carries the browser's own account statement for that machine:
// {"v":1,"mode":"owner","account":"<jws>","device":"Chrome on macOS"}. The machine admits it only
// with a live grant for this key AND that statement, and ends the session at the statement's
// deadline unless a newer one comes in-band (transport.ts keepAccount).

import { HELLO_MIN_LEFT_MS, REFRESH_MIN_LEFT_MS, type StatementSource } from "./accountStatement";
import { accountRefusal, other, ownerRefusal } from "./errors";
import type { Endpoint } from "./invite";
import type { TransportLink } from "./transport";

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
  // The owner's grant and statement codes read as the owner's (a stale statement is retried);
  // the rest as a guest's.
  refusal: code => code.startsWith("owner_") || accountRefusal(code) !== null ? ownerRefusal(code) : null,
 };
}
