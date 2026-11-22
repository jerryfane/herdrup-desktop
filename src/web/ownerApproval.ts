// Approving this browser for the owner's machines, the browser's half (web owner access WIRE-PLAN
// §2.2-2.3, mockup 1). The browser enrols its key as an account device, commits to nonce_b and
// waits with no code: the code exists only once a trusted device claims the request and sends
// nonce_t. Then the browser reveals nonce_b and shows the 4 digits the person types there. On
// approval it opens the machine list sealed to it by that device, whose key the code covered, and
// keeps it (ownerStore.ts). Later loads take newer lists only from approvers kept that way.

import { approveCode, approveCommit, newApproveNonce, openEnvelope, parseEnvelope, type Envelope } from "../webguest/approve";
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
 | { kind: "approved"; approver: VerifiedApprover }
 | { kind: "denied" }
 | { kind: "expired" }
 | { kind: "failed"; problem: string };

type Account = Pick<WebAccount, "enrol" | "requestApproval" | "approvalState" | "reveal" | "browserSelf">;

export interface ApprovalDeps {
 account: Account;
 identities: IdentityStore;
 store: OwnerStore;
 /** What the account and the approving device call this browser ("Chrome on macOS"). */
 deviceName: string;
 sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
 now?: () => number;
 random?: (n: number) => Uint8Array;
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

/** The browser's key for owner access: the guest identity (made now if there is none), and only
 *  when WebCrypto keeps it non-extractable. A raw key is never replaced: it may hold a share. */
export async function ownerKey(identities: IdentityStore, subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null): Promise<StaticKey | null> {
 const record = await identities.get() ?? await identities.add(await generateIdentity(subtle));
 return record.kind === "webcrypto" ? staticKey(record, subtle) : null;
}

const problemOf = (error: unknown): string => {
 if (error instanceof AccountServiceError) {
  if (error.code === "too_many_requests") return "Too many approval requests from this account. Try again in an hour.";
  if (error.code === "device_in_other_account") return "This browser is already a device of another HerdrUp account.";
  if (error.code === "too_many_devices") return "The account has too many devices. Remove one in HerdrUp, then try again.";
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
 onPhase({ kind: "starting" });
 let id: string, expiresAt: number;
 const nonceB = newApproveNonce(deps.random);
 try {
  try { await deps.account.enrol(key, deps.deviceName); }
  catch (error) { if (!(error instanceof AccountServiceError && error.code === "session_has_device")) throw error; }
  const created = await deps.account.requestApproval(approveCommit(key.publicKey, nonceB));
  id = created.id; expiresAt = now() + created.expires_in * 1000;
 } catch (error) { if (!signal.aborted) onPhase({ kind: "failed", problem: problemOf(error) }); return; }
 if (signal.aborted) return;
 onPhase({ kind: "waiting" });

 const started = now();
 let approver: { pub: Uint8Array; name: string } | null = null;
 for (;;) {
  try { await sleep(pollDelay(now() - started), signal); } catch { return; }
  let st: ApprovalStatus;
  try { st = await deps.account.approvalState(id); }
  catch (error) {
   if (signal.aborted) return;
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
   try { await deps.account.reveal(id, nonceB); }
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
   const taken = approver !== null && await takeApproval(deps, key, approver, onPhase, signal, sleep);
   if (taken || signal.aborted) return;
   onPhase({ kind: "failed", problem: "HerdrUp approved this browser, but its list of machines didn't arrive or didn't open. Ask again." });
   return;
  }
  if (now() >= expiresAt) { onPhase({ kind: "expired" }); return; }
 }
}

/** After approval: the envelope from the approver the code covered, opened and kept. */
async function takeApproval(deps: ApprovalDeps, key: StaticKey, approver: { pub: Uint8Array; name: string }, onPhase: (p: OwnerPhase) => void,
 signal: AbortSignal, sleep: NonNullable<ApprovalDeps["sleep"]>): Promise<boolean> {
 const pub = toB64url(approver.pub);
 for (let attempt = 0; attempt < ENVELOPE_TRIES; attempt++) {
  if (attempt > 0) { try { await sleep(2_000, signal); } catch { return true; } }
  let self: BrowserSelf;
  try { self = await deps.account.browserSelf(); } catch { if (signal.aborted) return true; continue; }
  const sealed = self.envelopes.find(e => e.approver_pub === pub);
  if (sealed === undefined) continue;
  let envelope: Envelope;
  try { envelope = parseEnvelope(await openEnvelope(key, approver.pub, sealed.seq, sealed.sealed), sealed.seq); }
  catch { return false; }
  const verified: VerifiedApprover = { pub, name: approver.name, envelope };
  const record = await deps.store.get();
  await deps.store.put(withApprover(record, verified));
  if (!signal.aborted) onPhase({ kind: "approved", approver: verified });
  return true;
 }
 return false;
}

function withApprover(record: OwnerRecord | undefined, approver: VerifiedApprover): OwnerRecord {
 const others = (record?.approvers ?? []).filter(a => a.pub !== approver.pub);
 return { v: 1, approvers: [...others, approver] };
}

/** On later loads: the newer lists from approvers this browser verified, opened and kept. A list
 *  from any other key, an older seq, or one that doesn't open is left out (the service carries
 *  them, so it could offer any). Returns the record as kept. */
export async function refreshLists(account: Pick<WebAccount, "browserSelf">, key: StaticKey, store: OwnerStore): Promise<OwnerRecord | undefined> {
 const record = await store.get();
 if (record === undefined || record.approvers.length === 0) return record;
 const self = await account.browserSelf();
 let changed = false;
 const approvers = await Promise.all(record.approvers.map(async a => {
  const sealed = self.envelopes.find(e => e.approver_pub === a.pub);
  if (sealed === undefined || sealed.seq <= a.envelope.seq) return a;
  try {
   const envelope = parseEnvelope(await openEnvelope(key, fromB64url(a.pub, 32)!, sealed.seq, sealed.sealed), sealed.seq);
   changed = true;
   return { ...a, envelope };
  } catch { return a; }
 }));
 if (!changed) return record;
 const next: OwnerRecord = { v: 1, approvers };
 await store.put(next);
 return next;
}
