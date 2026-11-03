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
 | "other";

export class GuestError extends Error {
 constructor(readonly kind: GuestErrorKind, message: string) {
  super(message);
  this.name = "GuestError";
 }
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

/** herdr's API error object (internal/bridge/client.go:59-68): code and message, and the whole
 *  object as sent for the fields some errors add. */
export class HerdrAPIError extends Error {
 constructor(readonly code: string, readonly apiMessage: string, readonly raw: unknown) {
  super("herdr: " + code + ": " + apiMessage);
  this.name = "HerdrAPIError";
 }
}
