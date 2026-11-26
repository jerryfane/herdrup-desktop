// A guest grant's key on this device: "<host_id>/<guest_id>", as Go's guest store keys its grants
// (internal/guest/store.go). The desk, the browser's grant store, its shares sync and the page all
// name a grant by it; an account share's id is the same key (AccountService DESIGN §5.1), which the
// shares sync takes at its boundary (web/shares.ts).

/** The key of grant: its guest id on its host. */
export const grantKey = (grant: { endpoint: { hostID: string }; guestID: string }): string => `${grant.endpoint.hostID}/${grant.guestID}`;
