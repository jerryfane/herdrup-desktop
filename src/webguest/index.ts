// The web guest's transport: what a browser needs to redeem an invitation and speak the herdr guest
// protocol over the guest relay, as the desktop's Go guest client does (internal/guest).
export { GuestError, HerdrAPIError, type GuestErrorKind } from "./errors";
export { existingIdentity, generateIdentity, IndexedDBIdentityStore, loadIdentity, MemoryIdentityStore, staticKey, type IdentityRecord, type IdentityStore } from "./identity";
export { APP_LINK_PREFIX, Invite, parseInvite, resolveInvite, type Endpoint } from "./invite";
export { MAX_NOISE_MESSAGE, MAX_NOISE_PLAINTEXT, type StaticKey } from "./noise";
export { acceptInvite, GuestStream, GuestTransport, RELAY_BACKOFF_FIRST_MS, RELAY_BACKOFF_MAX_MS, ROUND_TRIP_LIMIT_MS, type Access, type Features, type WebSocketFactory } from "./transport";
