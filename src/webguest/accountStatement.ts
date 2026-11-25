// The account statement (AccountService DESIGN §3.3) that an owner link's hello and an
// account-bound guest share's hello carry, and that their sessions send again in-band before each
// deadline (transport.ts keepAccount): what a source of them gives, the timing policy, and the pin
// that keeps one redemption's or one link's statements to the account session it started with.

import { GuestError } from "./errors";

/** An account statement (POST /v1/statements): its JWS, when it expires (ms), and whether the
 *  session it was issued in is still the page's. live() is required: nothing is sent with a
 *  statement whose session has ended. It is false then, or throws the reason (pinned). */
export interface AccountStatement { jws: string; expMs: number; live(): boolean }

/** A statement the hello or a refresh sends: enough of it left, or a fresh one. */
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
/** Before an account-bound session's deadline, the in-band refresh goes this long ahead. */
export const REFRESH_AHEAD_MS = 120_000;

/** The account session a redemption or a link started in is no longer the page's. */
export const accountChanged = () => new GuestError("account_changed", "Your HerdrUp account changed; open the invite again");

/** source pinned to the account session of the first statement it gives: a later one (a retry
 *  after a refusal, a reconnect, a refresh) is asked for, and is live, only while that session
 *  is still the page's, so nothing goes out under another sign-in (an invite herdr would bind to
 *  it, a share's hello or refresh). Past the switch, get throws accountChanged, and the later
 *  statements' live() throws it right before they would be sent. */
export function pinned(source: StatementSource): StatementSource {
 let first: (() => boolean) | null = null;
 const check = (session: () => boolean) => { if (!session()) throw accountChanged(); };
 return {
  async get(hostID, minLeftMs, signal) {
   if (first !== null) check(first);
   const got = await source.get(hostID, minLeftMs, signal);
   if (first === null) { first = got.live; return got; }
   const session = first;
   return { ...got, live: () => { check(session); return got.live(); } };
  },
  drop: (hostID, jws) => source.drop(hostID, jws),
 };
}
