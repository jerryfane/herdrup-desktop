// The guest client's errors, worded as the Go guest client words them (internal/guest/invite.go:22-32,
// session.go:21-27). kind names Go's sentinel errors so a caller can branch the way Go's errors.Is does;
// every other failure is "other".

export type GuestErrorKind =
 | "not_invite" // ErrNotInvite
 | "expired" // ErrExpired
 | "invite_revoked" // ErrInviteRevoked
 | "invite_unreachable" // ErrInviteUnreachable
 | "revoked" // ErrRevoked
 | "host_offline" // ErrHostOffline
 | "rate_limited" // ErrRateLimited
 | "timeout" // a call's round-trip limit (session.go:18)
 | "closed" // the transport or socket was closed (context.Canceled)
 | "statement" // an owner hello's account statement was refused (missing, stale, another account)
 // An account-bound share's refusals and closes (herdr guest/account.rs codes), each its own kind
 // as Go has a sentinel for each (internal/guest ErrAccountRequired … ErrAccountsDisabled).
 | "account_required" // ErrAccountRequired
 | "account_mismatch" // ErrAccountMismatch
 | "statement_invalid" // ErrStatementInvalid
 | "statement_expired" // ErrStatementExpired
 | "account_keys_stale" // ErrAccountKeysStale
 | "device_removed" // ErrDeviceRemoved
 | "accounts_disabled" // ErrAccountsDisabled
 | "other";

export class GuestError extends Error {
 constructor(readonly kind: GuestErrorKind, message: string) {
  super(message);
  this.name = "GuestError";
 }
}

/** A call that failed before any frame of its request was handed to the socket, so herdr cannot have
 *  it and a mutating request may be made again. GuestTransport.call throws it for EVERY such failure:
 *  a refused or failed connect (relay admission 429, relay or host unreachable, a refused hello), a
 *  session that ended before the send, an abort or cancellation of the call before the send, the
 *  transport closed before the send. Once a frame was handed to the socket no failure is a
 *  NotSentError, whatever followed (a lost reply, a timeout, an abort, a closed connection): the
 *  request may have reached herdr. error is the failure itself; a GuestError's kind and message are
 *  kept, any other failure's message with kind "other". */
export class NotSentError extends GuestError {
 constructor(readonly error: unknown) {
  super(error instanceof GuestError ? error.kind : "other", error instanceof Error ? error.message : String(error));
 }
}

/** error marked as not sent (NotSentError), unless it already is. */
export function notSent(error: unknown): NotSentError {
 return error instanceof NotSentError ? error : new NotSentError(error);
}

export const notInvite = () => new GuestError("not_invite", "That isn't a herdr guest invitation. Open the invitation link sent by the owner.");
export const expired = () => new GuestError("expired", "This invitation has expired. Ask the owner for a new invitation.");
export const inviteRevoked = () => new GuestError("invite_revoked", "This invite has expired or was revoked.");
export const inviteUnreachable = () => new GuestError("invite_unreachable", "Couldn't reach the invite server; check your connection and try again");
export const revoked = () => new GuestError("revoked", "This shared access is no longer available. Ask the owner for a new invitation.");
export const hostOffline = () => new GuestError("host_offline", "The shared machine is offline. Try again when the owner reconnects it.");
export const rateLimited = () => new GuestError("rate_limited", "The relay is receiving too many connections. Try again shortly.");
/** A browser's refused relay upgrade: the relay's 429 rate_limited, or a refusal or failure the page
 *  cannot tell from it (transport.ts, top). */
export const relayRefused = () => new GuestError("rate_limited", "Couldn't connect to the guest relay: it may be receiving too many connections from this network, or the shared machine may be offline. Trying again shortly.");
export const timedOut = () => new GuestError("timeout", "The shared machine did not answer in time.");
export const closed = () => new GuestError("closed", "The shared connection was closed.");
export const other = (message: string) => new GuestError("other", message);

/** An owner hello refused (herdr guest/owner.rs admit_in): the grant, the cap, or the statement. */
export function ownerRefusal(code: string): GuestError {
 switch (code) {
  case "owner_not_granted": return new GuestError("revoked", "This browser isn't approved on this machine any more. Approve it again from HerdrUp.");
  case "owner_expired": return new GuestError("revoked", "This browser's access to this machine has ended. Renew it from HerdrUp.");
  case "owner_busy": return other("This browser has too many connections open to this machine. Close some tabs and try again.");
  case "account_required": case "statement_invalid": case "statement_expired": case "account_keys_stale": case "account_mismatch":
   return new GuestError("statement", "The machine didn't accept this browser's account statement. Sign in again if this persists.");
  default: return other("The machine refused this browser's connection.");
 }
}

/** A guest hello's or session's account code (herdr guest/account.rs codes): a hello refused with
 *  it, or a session closed with it as the reason. null for any other code. */
export function accountRefusal(code: string): GuestError | null {
 switch (code) {
  case "account_required": return new GuestError(code, "This shared access is linked to a HerdrUp account. Sign in to that account in this browser to use it.");
  case "account_mismatch": return new GuestError(code, "This shared access is linked to another HerdrUp account. Sign in to the account you added it to.");
  case "statement_invalid": return new GuestError(code, "The shared machine didn't accept this browser's HerdrUp sign-in. Try again, and sign in again if this persists.");
  case "statement_expired": return new GuestError(code, "This browser's HerdrUp sign-in for the shared machine expired. Try again.");
  case "account_keys_stale": return new GuestError(code, "The shared machine can't check HerdrUp accounts right now. Try again later.");
  case "device_removed": return new GuestError(code, "The owner removed this browser from the shared access. Ask the owner for a new invitation.");
  case "accounts_disabled": return new GuestError(code, "The owner doesn't allow adding shared access to a HerdrUp account on this machine. Accept it for this browser only.");
  default: return null;
 }
}

/** Whether a connect refused for error may be admitted with a fresh statement: the one sent may
 *  have gone stale or been refused on the way. Once is enough; other refusals stay. */
export function freshStatementMayAdmit(error: unknown): boolean {
 return error instanceof GuestError && (error.kind === "statement" || error.kind === "statement_expired" || error.kind === "statement_invalid");
}

/** herdr's API error object (internal/bridge/client.go:59-68): code and message, and the whole
 *  object as sent for the fields some errors add. */
export class HerdrAPIError extends Error {
 constructor(readonly code: string, readonly apiMessage: string, readonly raw: unknown) {
  super("herdr: " + code + ": " + apiMessage);
  this.name = "HerdrAPIError";
 }
}
