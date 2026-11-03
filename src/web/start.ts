// How the browser guest starts (contract "Flow" 3-5): the invite arrives in the page's fragment,
// /web/#<payload>, which no server sees; it leaves the address bar at once, is redeemed as the app
// redeems an invitation, and the grant is kept. Later visits resume the kept grant.

import type { Access, Desk } from "../mygo";
import { APP_LINK_PREFIX, shortSegment } from "../webguest/invite";

/** The Desk methods starting needs. */
type StartDesk = Pick<typeof Desk, "sharedConnections" | "acceptGuestInvitation" | "connectGuest">;

export interface Welcome { title: string; body: string; error?: string }
export type Started = { kind: "connected"; id: string } | { kind: "welcome"; welcome: Welcome };

/** The fragment's payload, removed from the address bar before anything else runs; "" when none. */
export function takeFragment(location: Pick<Location, "hash" | "pathname" | "search">, history: Pick<History, "replaceState" | "state">): string {
 const hash = location.hash;
 if (hash === "") return "";
 history.replaceState(history.state, "", location.pathname + location.search);
 let payload = hash.slice(1);
 try { payload = decodeURIComponent(payload); } catch { /* keep it as sent */ }
 return payload.trim();
}

/** The invitation text a payload stands for: a whole link as sent, a short link's 34-character
 *  segment on this page's own relay, or else the long v1 payload (the app link's fragment). */
export function inviteText(payload: string, origin: string): string {
 if (payload.startsWith(APP_LINK_PREFIX) || payload.startsWith("https://")) return payload;
 if (shortSegment(payload)) return `${origin}/i/${payload}`;
 return APP_LINK_PREFIX + payload;
}

export const shareID = (access: Pick<Access, "endpoint" | "guestID">) => `${access.endpoint.hostID}/${access.guestID}`;

/** The plain screen without a grant: first visit, or a share left or wiped. owner is who shared
 *  the last grant this browser held, when it remembers. */
export function welcome(owner: string | null, error?: string): Welcome {
 const who = owner ?? "the owner";
 return owner === null
  ? { title: `Open the invite link ${who} sent you`, body: "It opens the agent they share with you here. If you used this page before and this browser's data was cleared, ask them for a new invite.", ...(error ? { error } : {}) }
  : { title: `Ask ${who} for a new invite`, body: "This browser no longer holds the shared access. Open the new invite link here to use the agent again.", ...(error ? { error } : {}) };
}

/** Redeems the fragment's invitation, or resumes the kept grant. A failed redemption with a grant
 *  already kept resumes it (most often the same link opened again: "already used"). */
export async function start(desk: StartDesk, payload: string, origin: string, owner: () => string | null): Promise<Started> {
 const kept = (await desk.sharedConnections())[0];
 if (payload !== "") {
  try {
   const access = await desk.acceptGuestInvitation(inviteText(payload, origin));
   await desk.connectGuest(shareID(access));
   return { kind: "connected", id: shareID(access) };
  } catch (error) {
   if (kept === undefined) return { kind: "welcome", welcome: welcome(owner(), error instanceof Error ? error.message : String(error)) };
  }
 }
 if (kept === undefined) return { kind: "welcome", welcome: welcome(owner()) };
 await desk.connectGuest(shareID(kept));
 return { kind: "connected", id: shareID(kept) };
}
