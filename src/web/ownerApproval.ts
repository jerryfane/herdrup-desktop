// Approving this browser for the owner's machines, the browser's half (web owner access WIRE-PLAN
// §2.2-2.3, mockup 1). The browser enrols its key as an account device, commits to nonce_b and
// waits with no code: the code exists only once a trusted device claims the request and sends
// nonce_t. Then the browser reveals nonce_b and shows the 4 digits the person types there. On
// approval it opens the machine list sealed to it by that device, whose key the code covered, and
// keeps it (ownerStore.ts). Later loads take newer lists only from approvers kept that way.

import { untilAborted } from "../webguest/abort";
import { approveCode, approveCommit, newApproveNonce, openEnvelope, type Envelope } from "../webguest/approve";
import { fromB64url, toB64url } from "../webguest/b64url";
import { generateIdentity, staticKey, type IdentityStore } from "../webguest/identity";
import type { StaticKey } from "../webguest/noise";
import { AccountServiceError, type ApprovalStatus, type BrowserSelf, type WebAccount } from "./account";
import type { OwnerRecord, OwnerStore, VerifiedApprover } from "./ownerStore";

export type OwnerPhase =
 /** This browser can't hold a key that page scripts can't read (WIRE-PLAN §5.3). */
 | { kind: "unsupported" }
 /** Another tab of this browser is running the approval. */
 | { kind: "elsewhere" }
 | { kind: "starting" }
 /** Asked; no trusted device has opened the request yet, so there is no code. */
 | { kind: "waiting" }
 /** A trusted device opened it: the person types these digits there. */
 | { kind: "code"; code: string; approver: string }
 | { kind: "approved"; record: OwnerRecord }
 | { kind: "denied" }
 | { kind: "expired" }
 | { kind: "failed"; problem: string };

type Account = Pick<WebAccount, "currentAccount" | "enrol" | "requestApproval" | "approvalState" | "reveal" | "browserSelf">;

export interface ApprovalDeps {
 account: Account;
 identities: IdentityStore;
 store: OwnerStore;
 /** What the account and the approving device call this browser ("Chrome on macOS"). */
 deviceName: string;
 sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
 now?: () => number;
 subtle?: SubtleCrypto | null;
 /** navigator.locks: one tab at a time runs an approval (each request replaces the last). */
 locks?: { request<T>(name: string, options: { ifAvailable: true }, run: (lock: unknown) => Promise<T>): Promise<T> } | null;
}

/** Polling, as WIRE-PLAN §2.4 sets it: every 2 s for the first minute, then every 5 s. */
export const pollDelay = (elapsedMs: number) => elapsedMs < 60_000 ? 2_000 : 5_000;
/** How long the list may take to appear after the service says approved. */
const ENVELOPE_TRIES = 5;

const sleepFor = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
 if (signal.aborted) { reject(signal.reason); return; }
 const t = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
 const stop = () => { clearTimeout(t); reject(signal.reason); };
 signal.addEventListener("abort", stop, { once: true });
});

/** The browser's key for owner access: the guest identity, only when WebCrypto keeps it
 *  non-extractable. With none saved, a key is made and saved only if it is a WebCrypto one, so an
 *  unsupported visit leaves nothing behind that a later, supported one would be refused for. A
 *  saved raw key is never replaced: it may hold a share. */
export async function ownerKey(identities: IdentityStore, subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null): Promise<StaticKey | null> {
 let record = await identities.get();
 if (record === undefined) {
  const made = await generateIdentity(subtle);
  if (made.kind !== "webcrypto") return null;
  await identities.add(made);
  // Only a key this browser can read back is one it keeps: a storage that saves it but can't
  // return it (WebKit answered null for it on the owner's iPad) would make a new key at every
  // read, and an approved browser would lose its approval on the next one. Such a browser can't
  // be approved, and says so.
  // (Another tab's key, saved first, is what reads back then, and is the one used.)
  record = await identities.get();
  if (record === undefined) return null;
 }
 return record.kind === "webcrypto" ? staticKey(record, subtle) : null;
}

const problemOf = (error: unknown): string => {
 if (error instanceof AccountServiceError) {
  if (error.code === "too_many_requests") return "Too many approval requests from this account. Try again in an hour.";
  if (error.code === "device_in_other_account") return "This browser is already a device of another HerdrUp account.";
  if (error.code === "too_many_devices") return "The account has too many devices. Remove one in HerdrUp, then try again.";
  if (error.code === "account_changed") return "This browser is now signed in to another account. Ask again to approve it there.";
  return error.status >= 500 ? "The account service is unavailable. Try again later." : `The account service refused the request (${error.code || error.status}).`;
 }
 return "Couldn't reach the account service. Check the connection and try again.";
};

/** Runs one approval until it ends, telling onPhase each step. abort ends it quietly. */
export async function runApproval(deps: ApprovalDeps, onPhase: (p: OwnerPhase) => void, signal: AbortSignal): Promise<void> {
 const locks = deps.locks === undefined ? (globalThis.navigator as { locks?: ApprovalDeps["locks"] } | undefined)?.locks ?? null : deps.locks;
 const run = () => approve(deps, onPhase, signal);
 if (locks === null) return run();
 await locks.request("herdrup-owner-approval", { ifAvailable: true }, async lock => {
  if (lock === null) { onPhase({ kind: "elsewhere" }); return; }
  await run();
 });
}

async function approve(deps: ApprovalDeps, onPhase: (p: OwnerPhase) => void, signal: AbortSignal): Promise<void> {
 const sleep = deps.sleep ?? sleepFor;
 const now = deps.now ?? Date.now;
 const key = await ownerKey(deps.identities, deps.subtle);
 if (key === null) { onPhase({ kind: "unsupported" }); return; }
 const devicePub = toB64url(key.publicKey);
 onPhase({ kind: "starting" });
 let id: string, expiresAt: number, acct: string;
 const nonceB = newApproveNonce();
 try {
  // The whole approval is the account's it starts in: a call after another sign-in sends nothing.
  acct = await deps.account.currentAccount(signal);
  // Under the lock, the first visit and Ask again alike: an approval this account already has
  // (another tab may have just finished one) shows instead of asking again.
  const saved = await untilAborted(deps.store.get(acct, devicePub), signal);
  if (saved !== undefined && saved.approvers.length > 0) { onPhase({ kind: "approved", record: saved }); return; }
  await untilAborted(bindDevice(deps.account, key, deps.deviceName, acct, signal), signal);
  const created = await untilAborted(deps.account.requestApproval(approveCommit(key.publicKey, nonceB), acct, signal), signal);
  id = created.id; expiresAt = now() + created.expires_in * 1000;
 } catch (error) { if (!signal.aborted) onPhase({ kind: "failed", problem: problemOf(error) }); return; }
 if (signal.aborted) return;
 onPhase({ kind: "waiting" });

 const started = now();
 let approver: { pub: Uint8Array; name: string } | null = null;
 for (;;) {
  try { await sleep(pollDelay(now() - started), signal); } catch { return; }
  let st: ApprovalStatus;
  try { st = await untilAborted(deps.account.approvalState(id, acct, signal), signal); }
  catch (error) {
   if (signal.aborted) return;
   if (error instanceof AccountServiceError && error.code === "account_changed") { onPhase({ kind: "failed", problem: problemOf(error) }); return; }
   // The browser asked again elsewhere (a new request replaces this one) or it was swept.
   if (error instanceof AccountServiceError && error.status === 404) { onPhase({ kind: "expired" }); return; }
   if (now() >= expiresAt) { onPhase({ kind: "expired" }); return; }
   continue; // a failed read is asked again; the request's own expiry ends the wait
  }
  if (signal.aborted) return;
  if (st.state === "denied") { onPhase({ kind: "denied" }); return; }
  if (st.state === "expired") { onPhase({ kind: "expired" }); return; }
  if (approver === null && (st.state === "claimed" || st.state === "revealed")) {
   const pub = fromB64url(st.approver?.device_pub, 32), nonceT = fromB64url(st.nonce_t, 32);
   if (pub === null || nonceT === null) continue; // not complete yet: read again
   // B reveals only now, holding nonce_t (§2.2 step 3); the code covers T, the key the list must come from.
   if (signal.aborted) return;
   try { await untilAborted(deps.account.reveal(id, nonceB, acct, signal), signal); }
   catch (error) {
    if (signal.aborted) return;
    if (!(error instanceof AccountServiceError && error.code === "already_revealed")) { onPhase({ kind: "failed", problem: problemOf(error) }); return; }
   }
   approver = { pub, name: st.approver!.name };
   onPhase({ kind: "code", code: approveCode(key.publicKey, pub, nonceB, nonceT), approver: approver.name });
   continue;
  }
  if (st.state === "approved") {
   // Approval needs the code, which exists only after this browser revealed: anything else is
   // a service this browser can't follow, never an approval to take.
   const taken = approver !== null && await takeApproval(deps, acct, devicePub, key, approver, onPhase, signal, sleep);
   if (taken || signal.aborted) return;
   onPhase({ kind: "failed", problem: "HerdrUp approved this browser, but its list of machines didn't arrive or didn't open. Ask again." });
   return;
  }
  if (now() >= expiresAt) { onPhase({ kind: "expired" }); return; }
 }
}

/** After approval: the envelope from the approver the code covered, opened and kept. */
async function takeApproval(deps: ApprovalDeps, acct: string, devicePub: string, key: StaticKey, approver: { pub: Uint8Array; name: string }, onPhase: (p: OwnerPhase) => void,
 signal: AbortSignal, sleep: NonNullable<ApprovalDeps["sleep"]>): Promise<boolean> {
 const pub = toB64url(approver.pub);
 for (let attempt = 0; attempt < ENVELOPE_TRIES; attempt++) {
  if (attempt > 0) { try { await sleep(2_000, signal); } catch { return true; } }
  let self: BrowserSelf;
  try { self = await untilAborted(deps.account.browserSelf(acct, signal), signal); } catch { if (signal.aborted) return true; continue; }
  const sealed = self.envelopes.find(e => e.approver_pub === pub);
  if (sealed === undefined) continue;
  let envelope: Envelope;
  try { envelope = await openEnvelope(key, approver.pub, sealed.seq, sealed.sealed); }
  catch { return false; }
  const verified: VerifiedApprover = { pub, name: approver.name, envelope };
  if (signal.aborted) return true;
  const record = await deps.store.merge(acct, devicePub, [verified]);
  if (!signal.aborted) onPhase({ kind: "approved", record });
  return true;
 }
 return false;
}

/** Binds this sign-in's session to the browser's key as an account device (enrolling it the first
 *  time); a session bound already is fine. The service serves a browser's own endpoints only to a
 *  session bound to its device. */
async function bindDevice(account: Pick<WebAccount, "enrol">, key: StaticKey, name: string, acct: string, signal?: AbortSignal): Promise<void> {
 try { await account.enrol(key, name, acct, signal); }
 catch (error) { if (!(error instanceof AccountServiceError && error.code === "session_has_device")) throw error; }
}

/** On later loads: account's newer lists from approvers this browser verified, opened and merged
 *  in (an approver's list only for a higher seq, compared when written). A list from any other key,
 *  an older seq, or one that doesn't open is left out (the service carries them, so it could
 *  offer any). Returns the record as kept, or undefined when this account has none here. */
export async function refreshLists(account: Pick<WebAccount, "browserSelf" | "enrol">, acct: string, key: StaticKey, store: OwnerStore, deviceName: string,
 signal?: AbortSignal): Promise<OwnerRecord | undefined> {
 const devicePub = toB64url(key.publicKey);
 const record = await store.get(acct, devicePub);
 if (record === undefined || record.approvers.length === 0) return record;
 let self: BrowserSelf;
 try { self = await account.browserSelf(acct, signal); }
 catch (error) {
  // A new sign-in's session isn't bound to this browser yet: bind it to the same key (no new
  // approval; the machines grant the key), then read once more.
  if (!(error instanceof AccountServiceError && error.code === "device_required")) throw error;
  await bindDevice(account, key, deviceName, acct, signal);
  self = await account.browserSelf(acct, signal);
 }
 const newer = (await Promise.all(record.approvers.map(async (a): Promise<VerifiedApprover | null> => {
  const sealed = self.envelopes.find(e => e.approver_pub === a.pub);
  if (sealed === undefined || sealed.seq <= a.envelope.seq) return null;
  try { return { ...a, envelope: await openEnvelope(key, fromB64url(a.pub, 32)!, sealed.seq, sealed.sealed) }; }
  catch { return null; }
 }))).filter((a): a is VerifiedApprover => a !== null);
 return newer.length === 0 ? record : await store.merge(acct, devicePub, newer);
}
