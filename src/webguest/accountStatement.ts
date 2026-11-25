// The account statement (AccountService DESIGN §3.3) that an owner link's hello and an
// account-bound guest share's hello carry, and that their sessions send again in-band before each
// deadline (transport.ts keepAccount): what a source of them gives, and the timing policy. A
// retry within one handshake, and the refreshes of one admitted session, stay in the sign-in that
// handshake started in (transport.ts acceptInvite, guestLink, keepAccount).

import { GuestError } from "./errors";

/** An account statement (POST /v1/statements): its JWS, when it expires (ms), and whether the
 *  session it was issued in is still the page's. live() is required: nothing is sent with a
 *  statement whose session has ended (live false). */
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

/** The sign-in a redemption started in is no longer the page's: its retry isn't sent. */
export const accountChanged = () => new GuestError("account_changed", "Your HerdrUp account changed; open the invite again");
/** The sign-in a saved share's connect started in is no longer the page's: its retry isn't sent.
 *  Whose account the share is herdr alone says (account_mismatch); a new connect tries again. */
export const shareSignInChanged = () => new GuestError("sign_in_changed", "Your HerdrUp sign-in changed. Try again.");
