// The account's shares collection for the web guest (AccountService DESIGN §5.1, sync.ts shares;
// herdrup#700), as far as "Add to my account" goes: this browser joins the account as a device, and
// a share herdr bound to the account is written there in one request, whose outcome is told as the
// service answered it, never guessed (ShareAdd). The grant stays on this browser whatever the
// outcome. Reading the account's shares, leaving a share on every device and settling a write whose
// outcome wasn't known belong to the shares sync (#543's second part), not to this module yet.

import type { Access as PageAccess } from "../mygo";
import { grantKey } from "../grantKey";
import { accountShareNotice } from "../notices";
import { toB64url } from "../webguest/b64url";
import type { StaticKey } from "../webguest/noise";
import type { Access } from "../webguest/transport";
import { AccountServiceError, SignedOutError, type SyncChange, type WebAccount } from "./account";

/** The shares collection's allowlist (sync.ts SCHEMAS.shares). */
export interface ShareBody {
 relay: string;
 host_id: string;
 node_pub: string;
 guest_id: string;
 agent_name?: string;
 owner_name?: string;
 machine_label?: string;
 share_gram?: boolean;
}

// The service's label caps (sync.ts text(): at most this many code points).
const MAX_AGENT_NAME = 128, MAX_OWNER_NAME = 64, MAX_MACHINE_LABEL = 128;

/** Whether the service stores text as a label of at most max code points (sync.ts text()):
 *  well-formed, with no control character. An invite's labels are capped in graphemes, which
 *  may hold more code points. */
const storable = (text: string, max: number) => text.isWellFormed() && !/\p{Cc}/u.test(text) && Array.from(text).length <= max;

/** The item a bound grant writes (§5.1: public fields only; no secret has a field). The relay is
 *  the invite's base URL without a trailing "/"; Gram sharing isn't written (share_gram). A label
 *  the service wouldn't store is left out: it would refuse the whole item. */
export function shareBody(access: Access): ShareBody {
 const body: ShareBody = { relay: access.endpoint.relay.replace(/\/+$/, ""), host_id: access.endpoint.hostID, node_pub: toB64url(access.endpoint.hostPublicKey), guest_id: access.guestID };
 if (access.agentName && storable(access.agentName, MAX_AGENT_NAME)) body.agent_name = access.agentName;
 if (access.ownerName && storable(access.ownerName, MAX_OWNER_NAME)) body.owner_name = access.ownerName;
 if (access.machineLabel && storable(access.machineLabel, MAX_MACHINE_LABEL)) body.machine_label = access.machineLabel;
 return body;
}

/** How writing a share to the account went, as the service told it:
 *  - added: it holds the share (it wrote the item, or answered that the account has it live);
 *  - refused: it didn't write it, and said so (a 4xx, the share's item deleted there), or nothing
 *    was sent (signed out, or this browser now signed in to another account); error says why;
 *  - unknown: no answer said (a timeout, the network, a 5xx, an answer that names no outcome for
 *    it): the item may be there or not. The shares sync settles it later. */
export type ShareAdd = { outcome: "added" } | { outcome: "refused"; error: unknown } | { outcome: "unknown"; error: unknown };

/** The browser Desk's acceptGuestInvitation result: the access, and for a share herdr bound to the
 *  account, how writing it there went. The desktop's Go writes its item through its own sync. */
export type AcceptedAccess = PageAccess & { added?: ShareAdd };

/** The words for an add that isn't confirmed (owner's text, herdr-app msg 561930). */
export const ADD_UNKNOWN = "Added on this device; we'll finish adding it to your account.";

/** The words for a refused add: the share is on this browser only. */
export function addRefused(error: unknown): string {
 const why = error instanceof SignedOutError ? "you're signed out of HerdrUp"
  : error instanceof AccountServiceError && error.code === "account_changed" ? "this browser is now signed in to another HerdrUp account"
  : error instanceof Error ? error.message : String(error);
 return `Added on this device only. Your HerdrUp account didn't take it: ${why}.`;
}

/** The notice after a share herdr bound to the account: in the account only once the service said
 *  so (frame com-g3's words); else that it is on this device, and why. */
export function boundNotice(agentName: string, added: ShareAdd): string {
 if (added.outcome === "added") return accountShareNotice(agentName);
 return added.outcome === "refused" ? addRefused(added.error) : ADD_UNKNOWN;
}

/** How long the write may take before its outcome counts as unknown. */
export const ADD_MS = 15_000;

/** Whether error says the request wrote nothing: the service refused it (a 4xx), or it never went
 *  (signed out; another sign-in now, account_changed, refused before sending). Anything else (a
 *  5xx, the network, a timeout) leaves the write's outcome unknown. */
const refusal = (error: unknown) =>
 error instanceof SignedOutError || (error instanceof AccountServiceError && error.status >= 400 && error.status < 500);

/** "Add to my account" against account: name is this browser's on the account's devices. */
export function createShareAdder(account: WebAccount, name: string, options: { addMs?: number } = {}) {
 return {
  /** Binds this sign-in's session to key as an account device (the statements a bound share
   *  needs are issued only to a session with a device); a session bound already is fine. */
  async bindDevice(key: StaticKey, signal?: AbortSignal): Promise<void> {
   try { await account.enrol(key, name, undefined, signal); }
   catch (error) { if (!(error instanceof AccountServiceError && error.code === "session_has_device")) throw error; }
  },
  /** Writes a bound grant's share to the account it is bound to (Access.account), its id the
   *  grant's key, as one POST /v1/sync of one change based on no item (base_rev 0: the key is
   *  new, as the grant is), sent once. Never rejects: the outcome is ShareAdd's. */
  async add(access: Access): Promise<ShareAdd> {
   if (access.account === undefined) return { outcome: "refused", error: new Error("this shared access isn't bound to a HerdrUp account") };
   const id = grantKey(access);
   const change: SyncChange = { collection: "shares", id, base_rev: 0, body: shareBody(access) };
   // The deadline's own timer, cleared once answered (a timeout signal nothing holds may be
   // collected before it fires, in some engines).
   const deadline = new AbortController();
   const timer = setTimeout(() => deadline.abort(new DOMException("The account service didn't answer in time.", "TimeoutError")), options.addMs ?? ADD_MS);
   let answer;
   try {
    answer = await account.syncPush({ prepare: async () => ({ changes: [change] }), sending() {}, refused: async () => {} }, access.account, deadline.signal);
   } catch (error) {
    return refusal(error) ? { outcome: "refused", error } : { outcome: "unknown", error };
   } finally {
    clearTimeout(timer);
   }
   const mine = (c: { collection: string; id: string }) => c.collection === "shares" && c.id === id;
   if (answer?.applied.some(mine)) return { outcome: "added" };
   const conflict = answer?.conflicts.find(mine);
   if (conflict?.server?.deleted === false) return { outcome: "added" };
   if (conflict !== undefined) return { outcome: "refused", error: new Error("this shared access was removed from your account") };
   return { outcome: "unknown", error: new Error("the account service's answer didn't name this shared access") };
  },
 };
}
export type ShareAdder = ReturnType<typeof createShareAdder>;
