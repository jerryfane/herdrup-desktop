// How the browser guest starts (contract "Flow" 3-5): the invite arrives in the page's fragment,
// /web/#<payload>, which no server sees; it leaves the address bar at once, is redeemed as the app
// redeems an invitation, and the grant is kept. Later visits resume the kept grant.

import { grantKey } from "../grantKey";
import type { Desk } from "../mygo";
import type { WebAccount } from "./account";
import type { AcceptedAccess, ShareAdd } from "./shares";
import { APP_LINK_PREFIX, shortSegment } from "../webguest/invite";
import { notInvite } from "../webguest/errors";

/** The Desk methods starting needs: the browser Desk's accept tells how writing a bound share to
 *  the account went (AcceptedAccess). */
type StartDesk = Pick<typeof Desk, "sharedConnections" | "connectGuest"> & { acceptGuestInvitation(text: string, keep: string): Promise<AcceptedAccess> };

interface Welcome { title: string; body: string; error?: string }
/** connected: the grant opened; bound, when this start had herdr bind it to the HerdrUp account
 *  (Access.accountBound), the agent's name and how writing it to the account went (an accept that
 *  told none counts as unknown), for the notice that says so. The landing's "Add to my account"
 *  while this browser is signed out (bindChoice.ts): signIn, that provider's sign-in starts at
 *  once; bind, the page asks, with problem, how the last sign-in for it ended, in words ("" when
 *  there is nothing to say). */
export type Started = { kind: "connected"; id: string; bound?: { agentName: string; added: ShareAdd } } | { kind: "welcome"; welcome: WelcomeState }
 | { kind: "signIn"; payload: string; provider: BindProvider } | { kind: "bind"; payload: string; problem: string };

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

/** The plain screen without a grant: first visit, or a share left or wiped. owner is who shared
 *  the last grant this browser held, when it remembers; error is why an invite just failed. */
export interface WelcomeState { owner: string | null; error?: string }

/** A first visit's welcome: no share left (owner) and no invite's failure to say. The guest page
 *  may show the sign-in only in its place (bootChoice.ts signInFirst), and waits for the account
 *  lookup only before it (main.ts init). */
export function plainWelcome(state: WelcomeState): boolean {
 return state.owner === null && !state.error;
}

/** The screen's words for state. A signed-in owner's first visit shows the approval instead
 *  (main.ts, ownerScreen.ts). */
export function welcome(state: WelcomeState): Welcome {
 const { owner, error } = state;
 const words = owner !== null
  ? { title: `Ask ${owner} for a new invite`, body: "This browser no longer holds the shared access. Open the new invite link here to use the agent again." }
  : { title: "Open the invite link the owner sent you", body: "It opens the agent they share with you here. If you used this page before and this browser's data was cleared, ask them for a new invite." };
 return { ...words, ...(error ? { error } : {}) };
}

/** The web sign-ins the landing may name. */
export type BindProvider = "apple" | "google";

/** The fragment as the invite landing (GuestRelay, themartianapp/herdrup#858) links it: `<payload>`, or
 *  `<payload>&bind=1` ("Add to my account"), or `<payload>&bind=1&provider=apple|google` when the
 *  guest chose a sign-in there. Returns the payload alone (all the invite decoder may see), whether
 *  bind was there, and the provider; null for any other shape (another key or value, a repeat, a
 *  provider without bind=1), which is refused as a malformed invite is. */
export function bindRequest(fragment: string): { payload: string; bind: boolean; provider: BindProvider | null } | null {
 const [payload = "", ...params] = fragment.split("&");
 if (params.length === 0) return { payload, bind: false, provider: null };
 if (payload === "" || params[0] !== "bind=1" || params.length > 2) return null;
 if (params.length === 1) return { payload, bind: true, provider: null };
 const provider = params[1] === "provider=apple" ? "apple" : params[1] === "provider=google" ? "google" : null;
 return provider === null ? null : { payload, bind: true, provider };
}

/** sessionStorage, this tab: an invite whose "Add to my account" waits for the web sign-in. The
 *  account service comes back to a fixed /web/?account=1 (or ?account_error=), so the fragment is
 *  gone by then: the page keeps {payload, bind} here just before the sign-in leaves, and the next
 *  load takes it (and so clears it). Never in localStorage or the address. */
export const PENDING_BIND_KEY = "herdrup.web.pendingBind";
export type TabStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Keeps payload for the sign-in's return; false when this tab can't keep it. */
export function savePendingBind(storage: () => TabStorage, payload: string): boolean {
 try { storage().setItem(PENDING_BIND_KEY, JSON.stringify({ payload, bind: true })); return true; } catch { return false; }
}
/** The kept invite's payload, cleared as it is read; null when none is kept (or it can't be read). */
export function takePendingBind(storage: () => TabStorage): string | null {
 try {
  const raw = storage().getItem(PENDING_BIND_KEY);
  if (raw === null) return null;
  storage().removeItem(PENDING_BIND_KEY);
  const kept: unknown = JSON.parse(raw);
  if (typeof kept !== "object" || kept === null) return null;
  const { payload, bind } = kept as { payload?: unknown; bind?: unknown };
  return typeof payload === "string" && payload !== "" && bind === true ? payload : null;
 } catch { return null; }
}
export function clearPendingBind(storage: () => TabStorage): void {
 try { storage().removeItem(PENDING_BIND_KEY); } catch { /* nothing kept */ }
}
/** Whether an invite waits for its sign-in (boot.ts: such a load is the guest page's). */
export function pendingBindWaits(storage: () => TabStorage): boolean {
 try { return storage().getItem(PENDING_BIND_KEY) !== null; } catch { return false; }
}

/** What a start knows about the account: whether this browser is signed in now (a rejection: the
 *  check failed, which is not a sign-out), the invite whose sign-in this load ends
 *  (takePendingBind), and how that sign-in ended (null when this load isn't a sign-in's return;
 *  problem null for a session, else the error in words, "" for a cancel). */
export interface StartAccount { signedIn(): Promise<boolean>; pending: string | null; signIn: { problem: string | null } | null }

/** The start's account facts on this page (main.ts). signedIn asks the service for the session the
 *  cookie holds (WebAccount.check, a refresh), never the new document's empty memory: an invite
 *  load skips boot's own lookup (bootChoice.ts choosePage), and a bind must know before it chooses
 *  between binding and signing in. */
export function startAccount(account: Pick<WebAccount, "check">, pending: string | null, signIn: StartAccount["signIn"]): StartAccount {
 return { signedIn: async () => await account.check() !== null, pending, signIn };
}

/** The bind's choice when the sign-in check itself failed (the service unreachable, a timeout). */
export const CHECK_FAILED = "HerdrUp couldn't check your sign-in. Sign in, or choose Only this device.";

/** Redeems payload, keeping it as keep says, and opens it. */
export async function acceptInvite(desk: StartDesk, payload: string, origin: string, keep: "account" | "device"): Promise<Started> {
 const access = await desk.acceptGuestInvitation(inviteText(payload, origin), keep);
 await desk.connectGuest(grantKey(access));
 if (keep !== "account" || !access.accountBound) return { kind: "connected", id: grantKey(access) };
 return { kind: "connected", id: grantKey(access), bound: { agentName: access.agentName, added: access.added ?? { outcome: "unknown", error: new Error("no outcome told") } } };
}

/** Redeems the fragment's invitation, or resumes the kept grant. A failed redemption with a grant
 *  already kept resumes it (most often the same link opened again: "already used"), and so does a
 *  fragment of another shape (bindRequest null), refused as a malformed invite. The grant goes
 *  in the HerdrUp account (keep "account") only when the landing asked for it (bindRequest) and
 *  this browser is signed in, whatever provider it named; signed out, the named provider's sign-in
 *  starts ("signIn"), or the page asks ("bind"), never keeping it on this browser alone unasked.
 *  An invite back from its sign-in (account.pending) goes on as asked when the sign-in made a
 *  session; one that ended otherwise (an error, a cancel, Back) is asked again. */
export async function start(desk: StartDesk, fragment: string, origin: string, owner: () => string | null, account: StartAccount): Promise<Started> {
 const kept = (await desk.sharedConnections())[0];
 const failed = (error: unknown): Started | null =>
  kept === undefined ? { kind: "welcome", welcome: { owner: owner(), error: error instanceof Error ? error.message : String(error) } } : null;
 const request = bindRequest(fragment);
 let { payload, bind, provider } = request ?? { payload: "", bind: false, provider: null };
 if (request === null) {
  const refused = failed(notInvite());
  if (refused) return refused;
 } else if (payload === "" && account.pending !== null) {
  payload = account.pending; bind = true; provider = null;
  if (account.signIn === null || account.signIn.problem !== null) return { kind: "bind", payload, problem: account.signIn?.problem ?? "" };
 }
 if (payload !== "") {
  if (bind) {
   let signedIn: boolean;
   try { signedIn = await account.signedIn(); } catch { return { kind: "bind", payload, problem: CHECK_FAILED }; }
   if (!signedIn) return provider !== null ? { kind: "signIn", payload, provider } : { kind: "bind", payload, problem: "" };
  }
  try {
   return await acceptInvite(desk, payload, origin, bind ? "account" : "device");
  } catch (error) {
   const refused = failed(error);
   if (refused) return refused;
  }
 }
 if (kept === undefined) return { kind: "welcome", welcome: { owner: owner() } };
 await desk.connectGuest(grantKey(kept));
 return { kind: "connected", id: grantKey(kept) };
}
