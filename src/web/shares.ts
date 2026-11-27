// The account's shares collection for the web guest (AccountService DESIGN §5.1, sync.ts shares;
// herdrup#700): a share bound to the account is written there when it is accepted, read on every
// device of the account (SHARED WITH YOU, "Open on this device"), and deleted when it is left, which
// leaves it on every device. One record per account in localStorage: the shares as last pulled
// (with the revisions of those seen deleted), the revision to pull from next, and this browser's
// writes not yet taken by the service. As every sync write, each carries base_rev: the revision
// last seen for its id (0: none). A put's conflict leaves the service's item standing: the write
// goes, and the pull that follows shows what the account holds. A delete's conflict with a live
// item keeps the delete, based next on that item's revision: it goes only once the share is gone.
// "Add to my account" is a put told as the service answered it, never guessed (ShareAdd).

import type { Access as PageAccess } from "../mygo";
import { grantKey } from "../grantKey";
import { accountShareNotice } from "../notices";
import { toB64url } from "../webguest/b64url";
import type { StaticKey } from "../webguest/noise";
import type { Access } from "../webguest/transport";
import { AccountServiceError, bindSessionDevice, firstBatch, pullSince, retains, SignedOutError, type SyncChange, type SyncPushAnswer, type WebAccount } from "./account";
import { withStorageLock, type AbortableLocks } from "./locks";

/** One account's record: SHARES_KEY_PREFIX + the account id. */
export const SHARES_KEY_PREFIX = "herdrup.web.shares.";
/** Per-account 410 reset counter shared across tabs on the same localStorage (fixed-width JSON
 *  so updating it in place never grows storage usage and stays valid JSON for storage wrappers). */
export const SHARES_RESET_PREFIX = "herdrup.web.shares.reset.";
/** The Web Lock a tab holds for an account's sync round: SYNC_LOCK_PREFIX + the account id. */
export const SYNC_LOCK_PREFIX = "herdrup.web.shares.sync.";

const RESET_DIGITS = 10;
const resetMark = (n: number) => JSON.stringify({ r: String(n).padStart(RESET_DIGITS, "0") });
const parseResetMark = (raw: string | null): number => {
 if (raw === null) return 0;
 try {
  const parsed = JSON.parse(raw) as unknown;
  return Number(typeof parsed === "object" && parsed !== null && "r" in parsed ? (parsed as { r: unknown }).r : parsed) || 0;
 } catch { return Number(raw) || 0; }
};
/** Fallback in-process reset counter keyed by Storage instance so tabs sharing a Storage object
 *  still observe a 410 reset even if every storage.setItem threw during a quota outage. */
const memoryResets = new WeakMap<object, Map<string, number>>();

/** A browser without Web Locks (none the page supports: its build targets browsers that all have
 *  them) can't take turns with its other tabs, so it syncs no share: it writes nothing to the
 *  account rather than race another tab's writes. */
export class SharesUnsupported extends Error {
 constructor() { super("This browser can't sync shared access. Update it."); this.name = "SharesUnsupported"; }
}
/** A Leave done on this browser whose delete no request carried yet (another sign-in here, or its
 *  round failed before sending it): kept, it goes with a later round. */
export class LeaveUnsent extends Error {
 constructor() { super("You left this shared access on this browser. Your HerdrUp account still lists it; it will be removed there at the next sync."); this.name = "LeaveUnsent"; }
}

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

/** How writing a share to the account went (ShareSync.add), as the service told it:
 *  - added: it holds the share (it wrote the item, or answered that the account has it live);
 *  - refused: it didn't write it and never will: it refused the write alone (a 400) or holds the
 *    share deleted, or this browser couldn't keep it; nothing of it is left to send, and the share
 *    is on this browser only. error says why;
 *  - unknown: no answer said yet (a timeout, the network, a 5xx, a 4xx of the whole push, an
 *    answer that names no outcome for it, signed out or another sign-in here, or the write still
 *    waiting its turn): the item may be there or not. It stays queued or journaled, and the
 *    shares sync settles it (SharesRecord sent). */
export type ShareAdd = { outcome: "added" } | { outcome: "refused"; error: unknown } | { outcome: "unknown"; error: unknown };

/** The browser Desk's acceptGuestInvitation result: the access, and for a share herdr bound to the
 *  account, how writing it there went. The desktop's Go writes its item through its own sync. */
export type AcceptedAccess = PageAccess & { added?: ShareAdd };

/** The words for an add that isn't confirmed (owner's text, herdr-app msg 561930). */
export const ADD_UNKNOWN = "Added on this device; we'll finish adding it to your account.";

/** The words for a refused add: the share is on this browser only. */
export function addRefused(error: unknown): string {
 return `Added on this device only. Your HerdrUp account didn't take it: ${error instanceof Error ? error.message : String(error)}.`;
}

/** The notice after a share herdr bound to the account: in the account only once the service said
 *  so (frame com-g3's words); else that it is on this device, and why. */
export function boundNotice(agentName: string, added: ShareAdd): string {
 if (added.outcome === "added") return accountShareNotice(agentName);
 return added.outcome === "refused" ? addRefused(added.error) : ADD_UNKNOWN;
}

/** How long an add may take before its outcome counts as unknown (its round goes on). */
export const ADD_MS = 15_000;

const record = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
/** A revision or a time in ms as the service writes one (AccountService src/sync.ts isRev; D1's
 *  INTEGER columns and clock): a safe integer, 0 up. */
const natural = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
/** Whether answer is POST /v1/sync's success envelope as the service writes it (AccountService
 *  src/sync.ts handlePush, DESIGN.md §5): {rev, applied: [{collection, id, rev}], conflicts:
 *  [{collection, id, server}], now_ms?}. Required: rev; applied and conflicts, each entry naming
 *  its collection and id; an applied entry's rev; a conflict's server, null or a whole item
 *  (itemJson: collection, id, rev, updated_ms, deleted, and body, null exactly when deleted, as
 *  migrations/0003_sync.sql's CHECK holds). Optional: now_ms, the clock extension (#826), absent
 *  from a service without it; when present, a time in ms. Revisions and times are naturals. A 2xx
 *  with a required field missing, or any field mistyped, tells no outcome, a matching entry in it
 *  included: its writes stay journaled. */
function pushAnswer(answer: unknown): answer is SyncPushAnswer {
 const named = (c: unknown): c is Record<string, unknown> => record(c) && typeof c.collection === "string" && typeof c.id === "string";
 const item = (s: unknown) => named(s) && natural(s.rev) && natural(s.updated_ms) && typeof s.deleted === "boolean" && "body" in s && s.deleted === (s.body === null);
 return record(answer) && natural(answer.rev) && (!("now_ms" in answer) || natural(answer.now_ms))
  && Array.isArray(answer.applied) && answer.applied.every(a => named(a) && natural(a.rev))
  && Array.isArray(answer.conflicts) && answer.conflicts.every(c => named(c) && (c.server === null || item(c.server)));
}
/** An account share as pulled; id is its grant's key, "<host_id>/<guest_id>" (§5.1; grantKey). */
export interface RemoteShare { id: string; rev: number; body: ShareBody }
/** A write not yet taken: the body to put, or a delete. */
interface PendingWrite { id: string; deleted?: true; body?: ShareBody }
/** A write as a push sent it: based on base_rev. */
interface SentWrite extends PendingWrite { base_rev: number }
/** A write handed to a request no answer came for (SharesRecord sent): not_after, the service's
 *  cutoff it went with (0: none, a service without now_ms); sent_at, the revision the record was
 *  pulled to when it went; unproven, a put of a new share (base 0) whose landing a pull since may
 *  have missed (a full pull past sent_at), until the service's history proves it either way. */
interface JournalEntry extends SentWrite { not_after: number; sent_at: number; unproven?: true }
/** p as written (its id, its delete or body), whatever else is stored with it. */
const bare = (p: PendingWrite): PendingWrite => p.deleted ? { id: p.id, deleted: true } : { id: p.id, body: p.body! };
/** p's key: one write of one share, whatever it is based on. */
const writeKey = (p: PendingWrite) => JSON.stringify(bare(p));
/** gone: the revisions of the shares seen deleted, which a write of the same id is based on.
 *  drop: the shares left here (kept in the same write as the delete) or a pull saw leave the
 *  account (a tombstone, or, in a full pull, a share seen live that it no longer holds) whose
 *  grants this browser may still hold. A pull's are stored in the same write that moves rev past
 *  them, so a pull never forgets one before its grant is gone. Each stays until a listener has
 *  removed its grant (cleared), whichever tab left or pulled it.
 *  sent: the journal, each write of unknown outcome: handed to a request no answer came for. It is
 *  written before the request goes; the request's answer, or its refusal (a 4xx, or cancelled
 *  before it went: nothing written), takes its entries out. The rule:
 *   - A write of unknown outcome is never sent again, and no other write of its share goes while
 *     it is journaled: it may still land, however late, until its not_after (the service writes
 *     nothing past it: sync.ts Deadline), and a write sent meanwhile could be undone by it (a
 *     tombstone the service prunes by count, 2,000 newer ones, makes a late put's base 0 good
 *     again).
 *   - The first pull whose now_ms (read before its rows) is past its not_after settles it against
 *     what that pull shows (settleJournal). A share still at the revision the write was based on:
 *     it never landed, and it goes again, as a fresh write, while it is still the one queued.
 *     Else the share moved on: by the write itself, or by another past it (another device's
 *     write, its Leave's tombstone). A put is then done or superseded: either way it is dropped,
 *     never put back over another's write. A delete stays while its share is live (a Leave
 *     wins), based next on the pulled revision, as when a delete is answered with a conflict.
 *  One sent without not_after (a service without now_ms, themartianapp/herdrup#826) can't be
 *  bounded: the next pull settles it.
 *  A put of a new share (base 0) that a full pull past its sent_at doesn't list may have landed
 *  and been deleted since, its tombstone pruned or the history started over (as Go's needsProof):
 *  the pull can't tell. It is settled only once the service's history from sent_at (at least 1:
 *  a pull from 0 is never refused) is asked (retains): held still, any landing since would have
 *  been listed, so it never landed and goes again, once; gone (410), what happened is past
 *  knowing, and it is superseded (dropped, its grant with it). Unasked or unanswered, it is
 *  unproven: kept, never sent, never dropped, and asked again at every later pull. */
interface SharesRecord {
 rev: number;
 /** Monotonic local commit sequence across tabs, bumped on every locked update. */
 seq?: number;
 /** Commit sequence when each live share id was last confirmed live (pull, settle, or put). */
 liveSeq?: Record<string, number>;
 /** Count of 410 history resets already folded by a committed full pull. */
 resetsFolded?: number;
 shares: RemoteShare[];
 gone: Record<string, number>;
 pending: PendingWrite[];
 drop?: string[];
 /** Conflict tombstone candidates waiting for post-push readback adjudication (never actionable drops until confirmed). */
 pendingDrop?: string[];
 sent?: JournalEntry[];
}

/** Where a pull starts that, not refused, proves a full pull lists any landing of e since it was
 *  sent (as Go's retainedFrom). */
const retainedFrom = (e: JournalEntry) => Math.max(e.sent_at, 1);

/** e's key in the journal: its write and the revision it was based on. */
const sentKey = (s: SentWrite) => JSON.stringify({ ...bare(s), base_rev: s.base_rev });

/** Settles r's journal entries a pull at now (its now_ms, null: none told; full, rev: whether it
 *  read the whole account, and to which revision) proves can't land any more, against r as that
 *  pull left it (SharesRecord sent). A share live is done (the write landed, or another's stands);
 *  one moved past the write's base is superseded; one still at it never landed, and its write
 *  goes again while it is still the one queued, but for a put of a new share whose landing a full
 *  pull may have missed: kept, it is marked unproven, and owed a proof (owed, keyed sentKey, from
 *  retainedFrom) once past its not_after. Returns the ids whose queued
 *  write it took off (done or superseded: a grant held here for one the account no longer holds
 *  goes) and the proofs owed. */
function settleJournal(r: SharesRecord, now: number | null, full: boolean, rev: number): { off: string[]; owed: { key: string; from: number }[] } {
 const off: string[] = [], owed: { key: string; from: number }[] = [];
 r.sent = (r.sent ?? []).filter(e => {
  const live = r.shares.find(s => s.id === e.id);
  const missed = !e.deleted && e.base_rev === 0 && live === undefined && (r.gone[e.id] ?? 0) === 0 && (e.unproven === true || (full && rev > e.sent_at));
  if (e.not_after !== 0 && (now === null || now <= e.not_after)) {
   if (missed) e.unproven = true;
   return true;
  }
  const queued = r.pending.some(p => writeKey(p) === writeKey(e));
  if (missed && queued) { e.unproven = true; owed.push({ key: sentKey(e), from: retainedFrom(e) }); return true; }
  const stays = e.deleted ? live !== undefined : live === undefined && (r.gone[e.id] ?? 0) === e.base_rev;
  if (!stays && queued) { r.pending = r.pending.filter(p => writeKey(p) !== writeKey(e)); off.push(e.id); }
  return false;
 });
 return { off, owed };
}

/** Notes in r.drop the grants of ids that may still be held here though the account no longer
 *  holds them: none put here and still queued, none live on the account unless left here (its
 *  delete queued). */
function noteDrops(r: SharesRecord, ids: Iterable<string>) {
 const puts = new Set(r.pending.filter(p => p.body).map(p => p.id)), deletes = new Set(r.pending.filter(p => p.deleted).map(p => p.id));
 const live = new Set(r.shares.map(s => s.id));
 r.drop = [...new Set([...r.drop ?? [], ...ids])].filter(id => !puts.has(id) && (deletes.has(id) || !live.has(id)));
}

type KeyValue = Pick<Storage, "getItem" | "setItem">;

/** Where the record lives and how tabs take turns writing it; name is this browser's device name.
 *  background: the shares sync on their own, at each sign-in and every SYNC_EVERY_MS (tests sync
 *  by hand). roundMs: how long a round may hold its turn (ROUND_MS unless a test passes its own);
 *  addMs: how long an add waits for its round (ADD_MS unless a test passes its own). */
export interface SharesPlace { storage(): KeyValue; locks: AbortableLocks | null; name: string; background: boolean; roundMs?: number; addMs?: number }

/** How long one round may run once it has its turn: its requests are then cancelled, so a stalled
 *  one can't keep every other tab's round (a Leave's delete) waiting (as the prompts' round). */
const ROUND_MS = 60_000;
/** How long past the service's newest now_ms a push may still be written (its not_after), longer
 *  than a round (as the prompts', prompts.ts NOT_AFTER_MS). */
const NOT_AFTER_MS = 2 * ROUND_MS;

/** How often a signed-in page pulls the account's shares while open (as its prompts). */
const SYNC_EVERY_MS = 15 * 60_000;

/** The most code points of each label the service keeps (sync.ts SCHEMAS.shares). */
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

function validBody(body: unknown): body is ShareBody {
 if (typeof body !== "object" || body === null) return false;
 const b = body as Record<string, unknown>;
 return typeof b.relay === "string" && typeof b.host_id === "string" && typeof b.node_pub === "string" && typeof b.guest_id === "string";
}

/** What listeners hear after every round, sign-in change and write here: whose shares they are
 *  (null: signed out) and the account's shares now. What a pull saw leave the account is in the
 *  record (dropping), whichever tab of this browser pulled it, until a listener clears it. */
export interface SharesChange { account: string | null; shares: RemoteShare[] }

export function createShareSync(account: WebAccount, place: SharesPlace) {
 const listeners = new Set<(change: SharesChange) => void | Promise<void>>();
 const maskListeners = new Set<(acct: string, ids: string[]) => void>();
 /** Shares whose deletion was observed in this tab (even if localStorage rejected the write, or
  *  IndexedDB failed to remove the grant, or a history proof is still pending), keyed by account
  *  id -> share id -> committed record seq at the time of observation. A strictly later committed
  *  live observation (`liveSeq[id] > maskSeq`) or a new put supersedes a tab-local mask under the
  *  storage lock even across 410 history resets where service revisions restart at 1. */
 const masked = new Map<string, Map<string, number>>();
 /** Account id for each share left in this tab whose delete is still pending, so retrying an
  *  unsent Leave after the IndexedDB grant was removed still retries the account deletion. */
 const pendingLeaveAccts = new Map<string, string>();
 const resetKeyOf = (acct: string) => SHARES_RESET_PREFIX + acct;
 const readReset = (acct: string): number => {
  const s = place.storage();
  return Math.max(parseResetMark(s.getItem(resetKeyOf(acct))), memoryResets.get(s)?.get(acct) ?? 0);
 };
 const reserveReset = (acct: string) => {
  const s = place.storage();
  try {
   if (s.getItem(resetKeyOf(acct)) === null) s.setItem(resetKeyOf(acct), resetMark(0));
  } catch { /* fallback map still tracks resets if quota is already full */ }
 };
 const recordReset = (acct: string): number => {
  const s = place.storage();
  const next = Math.max(readReset(acct), read(acct).resetsFolded ?? 0) + 1;
  let map = memoryResets.get(s);
  if (map === undefined) { map = new Map(); memoryResets.set(s, map); }
  map.set(acct, next);
  try {
   for (let i = 0; i < 4; i++) {
    if (parseResetMark(s.getItem(resetKeyOf(acct))) >= next) break;
    s.setItem(resetKeyOf(acct), resetMark(next));
   }
  } catch { /* fallback map preserves the reset across tabs sharing this Storage */ }
  return next;
 };
 const maskInMemory = (acct: string, entries: Iterable<[string, number]>) => {
  const added: string[] = [];
  let map = masked.get(acct);
  for (const [id, seq] of entries) {
   if (map === undefined) { map = new Map(); masked.set(acct, map); }
   const prev = map.get(id);
   if (prev === undefined) added.push(id);
   map.set(id, prev === undefined ? seq : Math.max(prev, seq));
  }
  if (added.length > 0) for (const f of maskListeners) { try { f(acct, added); } catch { /* ignore */ } }
 };
 const unmaskInMemory = (acct: string, ids: Iterable<string>) => {
  const map = masked.get(acct);
  if (map === undefined) return;
  for (const id of ids) map.delete(id);
  if (map.size === 0) masked.delete(acct);
 };
 /** Whether a tab-local mask for id in acct still holds against record r. If another tab committed
  *  a strictly newer live observation (`liveSeq[id] > maskSeq`, works across 410 revision resets)
  *  without a pending delete or durable drop marker, or queued a new put for id, the stale
  *  tab-local mask is cleared and returns false. */
 const maskActiveIn = (r: SharesRecord, acct: string, id: string): boolean => {
  const maskSeq = masked.get(acct)?.get(id);
  if (maskSeq === undefined) return false;
  if (r.pending.some(p => p.body && p.id === id)) { unmaskInMemory(acct, [id]); return false; }
  const live = r.shares.some(s => s.id === id);
  const liveSeq = r.liveSeq?.[id] ?? 0;
  if (live && liveSeq > maskSeq && !r.pending.some(p => p.deleted && p.id === id) && !(r.drop ?? []).includes(id)) {
   unmaskInMemory(acct, [id]);
   return false;
  }
  return true;
 };
 const keyOf = (acct: string) => SHARES_KEY_PREFIX + acct;
 const read = (acct: string): SharesRecord => {
  const raw = place.storage().getItem(keyOf(acct));
  return raw === null ? { rev: 0, shares: [], gone: {}, pending: [] } : JSON.parse(raw) as SharesRecord;
 };
 /** Reads, changes and writes acct's record in one step under its storage lock, advancing its
  *  monotonic local commit sequence `seq` so tabs can order observations across 410 resets. */
 const update = async <T>(acct: string, change: (record: SharesRecord, baseSeq: number) => T): Promise<T> => {
  let out: { value: T } | null = null;
  const ran = await withStorageLock(keyOf(acct), () => {
   const record = read(acct);
   const baseSeq = record.seq ?? 0;
   record.seq = baseSeq + 1;
   out = { value: change(record, baseSeq) };
   place.storage().setItem(keyOf(acct), JSON.stringify(record));
  }, place.locks);
  if (!ran || out === null) throw new Error("This browser's storage is locked by another tab. Try again.");
  return (out as { value: T }).value;
 };
 /** Whether a 410 history reset was observed for acct that has not yet been folded by a committed
  *  full pull, making cached pre-reset mirror rows unverified. */
 const hasPendingReset = (record: SharesRecord, acct?: string): boolean =>
  acct !== undefined && readReset(acct) > (record.resetsFolded ?? 0);
 /** The shares as last pulled, with this browser's own unsent puts and without its unsent deletes,
  *  active in-memory deletion masks, or pre-reset mirror rows still awaiting a committed full pull. */
 const visible = (record: SharesRecord, acct?: string): RemoteShare[] => {
  const pending = new Set(record.pending.map(p => p.id));
  const isHidden = (id: string) => acct !== undefined && maskActiveIn(record, acct, id);
  const liveRows = hasPendingReset(record, acct) ? [] : record.shares;
  const shown = liveRows.filter(s => !pending.has(s.id) && !isHidden(s.id))
   .concat(record.pending.flatMap(p => p.body && !isHidden(p.id) ? [{ id: p.id, rev: 0, body: p.body }] : []));
  return shown.sort((a, b) => a.id.localeCompare(b.id));
 };
 /** Tells the listeners, and waits for them: a sync is done once what it pulled is reconciled. */
 const tell = async (change: SharesChange): Promise<void> => {
  await Promise.allSettled([...listeners].map(async f => f(change)));
 };

 /** Sends acct's queue in pushes the service takes (at most 100 changes and 256 KiB each,
  *  account.ts firstBatch), each with notAfter as its not_after (0: none). Each push is made at
  *  dispatch from the record as it is then, read again for every one: the writes queued whose
  *  share has none journaled (SharesRecord sent), each based on the revision last seen. A write
  *  replaced since (a put by a Leave's delete, in this tab or another) is never sent, and a write
  *  kept since goes in a later push. Each push is journaled before it goes and settled as it is
  *  answered: one that fails leaves its writes for the next round, and the others still go. A
  *  write goes at most once a round; dispatched gets each as its request is handed to fetch
  *  (writeKey). Applied deletes stay pending until the post-push pullInto readback confirms the
  *  share was not restored (appliedDeletes). */
 async function pushQueue(acct: string, signal: AbortSignal, generation: number, notAfter: number, dispatched: Set<string>, refusedAlone: Map<string, unknown>, appliedDeletes: Set<string>): Promise<void> {
  const change = (s: SentWrite): SyncChange => s.deleted
   ? { collection: "shares", id: s.id, base_rev: s.base_rev, deleted: true }
   : { collection: "shares", id: s.id, base_rev: s.base_rev, body: s.body };
  /** p as it goes now: based on the revision last seen of its share. */
  const based = (r: SharesRecord, p: PendingWrite): SentWrite => ({ ...bare(p), base_rev: r.shares.find(s => s.id === p.id)?.rev ?? r.gone[p.id] ?? 0 });
  /** Settles the writes sent that the answer (or refused: the service refused them alone) names:
   *  only matched writes leave the journal, so a 2xx answer that omits a write keeps its replay
   *  fence in r.sent. An applied delete stays in r.pending (tracked in appliedDeletes) until
   *  readback confirms no restore revived the share. A put conflict with a tombstone persists its
   *  candidate separately in r.pendingDrop (never in actionable r.drop, and without masking) so
   *  neither another tab nor an early reconcile can disconnect or remove the grant before
   *  post-push readback adjudicates it. */
  const settle = async (sent: SentWrite[], answer: SyncPushAnswer | null, refused: SentWrite[] = []) => {
   await update(acct, r => {
    const sentAs = new Map(sent.map(s => [s.id, s] as const));
    const done = new Set(refused.map(writeKey)), known = new Set(refused.map(sentKey));
    const rows: { id: string; rev: number; body: ShareBody | null }[] = [];
    const conflictTombstones: string[] = [];
    for (const c of answer?.applied ?? []) {
     const s = c.collection === "shares" ? sentAs.get(c.id) : undefined;
     if (s === undefined) continue;
     known.add(sentKey(s));
     if (s.deleted) appliedDeletes.add(writeKey(s));
     else done.add(writeKey(s));
     rows.push({ id: c.id, rev: c.rev, body: s.deleted ? null : s.body! });
    }
    for (const c of answer?.conflicts ?? []) {
     const s = c.collection === "shares" ? sentAs.get(c.id) : undefined;
     if (s === undefined) continue;
     known.add(sentKey(s));
     const server = c.server;
     if (server !== null && (server.deleted || validBody(server.body))) rows.push({ id: c.id, rev: server.rev, body: server.deleted ? null : server.body as ShareBody });
     if (server !== null && server.deleted) conflictTombstones.push(c.id);
     if (!(s.deleted && server !== null && !server.deleted && validBody(server.body))) done.add(writeKey(s));
    }
    r.pending = r.pending.filter(p => !done.has(writeKey(p)));
    r.sent = (r.sent ?? []).filter(e => !known.has(sentKey(e)));
    const liveSeq = { ...r.liveSeq };
    for (const row of rows) {
     if ((r.shares.find(s => s.id === row.id)?.rev ?? r.gone[row.id] ?? -1) >= row.rev) continue;
     r.shares = r.shares.filter(s => s.id !== row.id);
     delete r.gone[row.id];
     if (row.body !== null) {
      r.shares = r.shares.concat({ id: row.id, rev: row.rev, body: row.body }).sort((a, b) => a.rev - b.rev);
      liveSeq[row.id] = r.seq!;
      r.pendingDrop = (r.pendingDrop ?? []).filter(id => id !== row.id);
     } else if (row.rev > 0) {
      r.gone[row.id] = row.rev;
      delete liveSeq[row.id];
     }
    }
    r.liveSeq = liveSeq;
    if (conflictTombstones.length > 0) {
     const shown = new Set(visible(r).map(s => s.id));
     const keep = conflictTombstones.filter(id => !shown.has(id));
     if (keep.length > 0) r.pendingDrop = [...new Set([...r.pendingDrop ?? [], ...keep])];
    }
   });
  };
  let failed: { error: unknown } | null = null;
  /** The writes a push of this round took (writeKey), whether or not its request went: none is
   *  taken twice. */
  const taken = new Set<string>();
  /** One push of what pick takes from the record at dispatch, journaled, then settled; how many
   *  writes it took. A request refused (a 4xx, or cancelled before it went) takes its entries out
   *  of the journal. A failure other than a 400 (the journal's own write refused included) is kept
   *  (failed) and leaves its writes queued, journaled if their request went. A 400 refuses the
   *  whole push for one change the service won't keep, and none of it is written: each write then
   *  goes alone, while it is still the one queued, and only one refused alone leaves unwritten. */
  const push = async (pick: (r: SharesRecord) => SentWrite[]): Promise<number> => {
   let sent: SentWrite[] = [];
   let answer: SyncPushAnswer | null;
   try {
    answer = await account.syncPush({
     prepare: () => update(acct, r => {
      sent = pick(r);
      r.sent = (r.sent ?? []).concat(sent.map(s => ({ ...s, not_after: notAfter, sent_at: r.rev })));
      if (sent.length === 0) return null;
      return notAfter === 0 ? { changes: sent.map(change) } : { changes: sent.map(change), not_after: notAfter };
     }),
     sending() { for (const s of sent) dispatched.add(writeKey(s)); },
     refused: async () => {
      for (const s of sent) dispatched.delete(writeKey(s));
      const out = new Set(sent.map(sentKey));
      if (out.size > 0) await update(acct, r => { r.sent = (r.sent ?? []).filter(e => !out.has(sentKey(e))); });
     },
    }, acct, signal, generation);
   } catch (error) {
    for (const s of sent) taken.add(writeKey(s));
    if (!(error instanceof AccountServiceError && error.status === 400)) { failed ??= { error }; return sent.length; }
    if (sent.length === 1) { refusedAlone.set(writeKey(sent[0]!), error); await settle([], null, sent); }
    else for (const w of sent) await push(r => still(r, w));
    return sent.length;
   }
   for (const s of sent) taken.add(writeKey(s));
   // An answer that isn't the service's tells no outcome: its writes stay journaled.
   if (answer !== null && !pushAnswer(answer)) { failed ??= { error: new Error("the account service's answer wasn't one it gives") }; return sent.length; }
   await settle(sent, answer);
   return sent.length;
  };
  /** w, sent in a push the service refused whole, as it goes alone now: while it is still the
   *  write queued and its share has none journaled; else none. */
  const still = (r: SharesRecord, w: SentWrite): SentWrite[] => (r.sent ?? []).some(e => e.id === w.id)
   ? [] : r.pending.filter(p => writeKey(p) === writeKey(w)).map(p => based(r, p));
  /** Lazily yields queued writes of the given kind (deletes or puts) whose share has none
   *  journaled and none taken yet this round so firstBatch stops examining and serializing
   *  entries as soon as the first batch fills. */
  function* eligible(r: SharesRecord, deletes: boolean): Iterable<SentWrite> {
   const held = new Set((r.sent ?? []).map(e => e.id));
   for (const p of r.pending) {
    if (Boolean(p.deleted) !== deletes) continue;
    if (held.has(p.id)) continue;
    if (taken.size > 0 && taken.has(writeKey(p))) continue;
    yield based(r, p);
   }
  }
  // Push quota-reducing deletes in their own batches before puts so blocked/over-quota puts can
  // never roll back or starve an unrelated Leave.
  const next = (r: SharesRecord) => {
   const deletes = firstBatch(eligible(r, true), change);
   return deletes.length > 0 ? deletes : firstBatch(eligible(r, false), change);
  };
  // Cancelled, or another sign-in now: nothing more goes for this one.
  while (await push(next) > 0 && !signal.aborted && account.generation === generation);
  if (failed !== null) throw (failed as { error: unknown }).error;
 }

 /** Pulls what acct holds since the record's revision and folds it in, in one write: the
  *  revision, the shares, the journal entries it settles (settleJournal), those it saw leave
  *  (drop), and the puts of new shares only the service's history can settle, marked unproven
  *  (owed, found in that same write from the record it read). Confirmed deletions are masked in
  *  memory before storage.setItem runs, so even a quota failure or a pending history proof
  *  immediately detaches and hides the removed share. When appliedDeletes is given (post-push
  *  readback), an applied delete is retired only if the share is absent from the readback; if a
  *  410/full restore brought it back live, the delete stays queued for the next round. */
 async function pullInto(acct: string, signal: AbortSignal, generation: number, appliedDeletes?: Set<string>): Promise<{ change: SharesChange; newestMs: number | null; unproven?: { error: unknown } }> {
  reserveReset(acct);
  const r0 = read(acct);
  const resetAtStart = readReset(acct);
  const since = resetAtStart > (r0.resetsFolded ?? 0) ? 0 : r0.rev;
  let resetSeen = resetAtStart;
  const pulled = await pullSince(account, acct, since, signal, generation, () => {
   resetSeen = Math.max(resetSeen, recordReset(acct));
  });
  const newestMs = pulled.nowMs === null ? null : pulled.newestMs;
  const { owed, liveToUnmask } = await update(acct, (r, baseSeq) => {
   const before = new Set(r.shares.map(s => s.id));
   const live = new Map(pulled.full ? [] : r.shares.map(s => [s.id, s] as const));
   const gone = pulled.full ? {} : r.gone;
   const liveSeq: Record<string, number> = pulled.full ? {} : { ...r.liveSeq };
   const observedLive = new Set<string>();
   for (const it of [...pulled.items].sort((a, b) => a.rev - b.rev)) {
    if (it.collection !== "shares" || Math.max(live.get(it.id)?.rev ?? -1, gone[it.id] ?? -1) > it.rev) continue;
    if (it.deleted) { live.delete(it.id); gone[it.id] = it.rev; delete liveSeq[it.id]; observedLive.delete(it.id); }
    else if (validBody(it.body)) { live.set(it.id, { id: it.id, rev: it.rev, body: it.body }); delete gone[it.id]; liveSeq[it.id] = r.seq!; observedLive.add(it.id); }
   }
   r.rev = pulled.rev;
   r.shares = [...live.values()].sort((a, b) => a.rev - b.rev);
   r.gone = gone;
   r.liveSeq = liveSeq;
   if (pulled.full) r.resetsFolded = Math.max(r.resetsFolded ?? 0, resetSeen);
   if (appliedDeletes && appliedDeletes.size > 0) {
    r.pending = r.pending.filter(p => !(p.deleted && appliedDeletes.has(writeKey(p)) && (!pulled.full || !live.has(p.id))));
   }
   const { off, owed } = settleJournal(r, pulled.nowMs, pulled.full, pulled.rev);
   const tombstoned = pulled.items.filter(it => it.collection === "shares" && it.deleted).map(it => it.id);
   const pendingCandidates = r.pendingDrop ?? [];
   r.pendingDrop = [];
   const candidates = [...before, ...tombstoned, ...off, ...pendingCandidates];
   // A share left here stays until its grant is gone, live on the account or not (its delete
   // not taken yet).
   noteDrops(r, candidates);
   const liveToUnmask = [...observedLive].filter(id => !r.pending.some(p => p.deleted && p.id === id));
   const shown = new Set(visible(r).map(s => s.id));
   maskInMemory(acct, [...new Set(candidates)].filter(id => !shown.has(id)).map(id => [id, baseSeq] as [string, number]));
   return { owed, liveToUnmask };
  });
  // Only a committed live observation may supersede a tab-local deletion mask: if setItem threw
  // above (e.g. QuotaExceededError), the mask stays intact and the share stays hidden/unopenable.
  unmaskInMemory(acct, liveToUnmask);
  const change: SharesChange = { account: acct, shares: visible(read(acct), acct) };
  if (owed.length === 0) return { change, newestMs };
  const froms = [...new Set(owed.map(o => o.from))].sort((a, b) => a - b);
  const proofs = new Map<number, boolean>();
  let unproven: { error: unknown } | undefined;
  try {
   for (const [i, from] of froms.entries()) {
    if (await retains(account, acct, from, signal, generation)) { for (const f of froms.slice(i)) proofs.set(f, true); break; }
    proofs.set(from, false);
   }
  } catch (error) { unproven = { error }; }
  // Applied only while the round is still this account's, in the session it began in.
  if (proofs.size === 0 || account.generation !== generation || account.current?.accountID !== acct) return unproven === undefined ? { change, newestMs } : { change, newestMs, unproven };
  const answered = new Map(owed.map(o => [o.key, proofs.get(o.from)] as const));
  const proven = await update(acct, (r, baseSeq) => {
   const off: string[] = [];
   r.sent = (r.sent ?? []).filter(e => {
    const held = answered.get(sentKey(e));
    if (held === undefined) return true;
    if (!held && r.pending.some(p => writeKey(p) === writeKey(e))) { r.pending = r.pending.filter(p => writeKey(p) !== writeKey(e)); off.push(e.id); }
    return false;
   });
   noteDrops(r, off);
   const shown = new Set(visible(r).map(s => s.id));
   maskInMemory(acct, off.filter(id => !shown.has(id)).map(id => [id, baseSeq] as [string, number]));
   return { account: acct, shares: visible(r, acct) };
  });
  return unproven === undefined ? { change: proven, newestMs } : { change: proven, newestMs, unproven };
 }

 /** One round for acct: this browser's writes, then what the account holds since the last pull.
  *  With writes to send it pulls first: the service's clock, which each push's not_after counts
  *  from (NOT_AFTER_MS past it), and the journal entries it settles. dispatched gets each write
  *  whose request was handed to fetch (writeKey), as it goes, and refusedAlone each the service
  *  refused alone, with why: a round that fails after still says what it sent. A write held
  *  behind a journal entry gets a round once the earliest such entry can be settled (followUp),
  *  and each round sets that again. A proof a pull couldn't get fails the round at its end, once
  *  the rest of it ran. */
 async function round(acct: string, signal: AbortSignal, dispatched: Set<string>, refusedAlone: Map<string, unknown>): Promise<SharesChange> {
  const generation = account.generation;
  const writes = (r: SharesRecord) => r.pending.length > 0 || (r.sent ?? []).length > 0;
  let unproven: { error: unknown } | undefined;
  const appliedDeletes = new Set<string>();
  let pushError: { error: unknown } | null = null;
  if (writes(read(acct))) {
   const first = await pullInto(acct, signal, generation);
   unproven = first.unproven;
   if (first.newestMs === null) console.warn("account sync: the service gives no now_ms; a share write of unknown outcome can't be fenced (themartianapp/herdrup#826)");
   try {
    await pushQueue(acct, signal, generation, first.newestMs === null ? 0 : first.newestMs + NOT_AFTER_MS, dispatched, refusedAlone, appliedDeletes);
   } catch (error) {
    pushError = { error };
   }
  }
  const clearUnconfirmedDeletes = () => {
   try {
    for (const p of read(acct).pending) if (p.deleted && appliedDeletes.has(writeKey(p))) dispatched.delete(writeKey(p));
   } catch { /* ignore */ }
  };
  if (pushError !== null) {
   // Even when a later batch fails (e.g. 403 quota or 429), adjudicate any earlier conflict
   // candidates or applied deletes before reconciliation runs.
   if (!signal.aborted && account.generation === generation) {
    let needsReadback = appliedDeletes.size > 0;
    try { needsReadback ||= (read(acct).pendingDrop?.length ?? 0) > 0; } catch { /* ignore */ }
    if (needsReadback) {
     try { await pullInto(acct, signal, generation, appliedDeletes); } catch { /* pendingDrop stays durable for next sync */ }
    }
   }
   clearUnconfirmedDeletes();
   throw pushError.error;
  }
  const pulled = await pullInto(acct, signal, generation, appliedDeletes);
  unproven ??= pulled.unproven;
  const r = read(acct), queued = new Set(r.pending.map(p => p.id));
  clearUnconfirmedDeletes();
  const holding = (r.sent ?? []).filter(e => e.not_after > 0 && queued.has(e.id)).map(e => e.not_after);
  if (holding.length > 0 && pulled.newestMs !== null) followUp(Math.min(...holding) - pulled.newestMs);
  if (unproven !== undefined) throw unproven.error;
  return pulled.change;
 }

 /** Runs f as acct's sync turn across this browser's tabs (Web Locks, SYNC_LOCK_PREFIX): one
  *  tab's round at a time, so no tab sends or settles writes while another does (a push of
  *  another tab's still answering can't come after a Leave this tab sent and settled). f's signal
  *  aborts roundMs after the turn was granted: its requests are cancelled and the turn passes, a
  *  stalled request holding no other tab's round. What a push cancelled so may still write stays
  *  journaled (SharesRecord sent) until a pull settles it. Without Web Locks nothing runs
  *  (SharesUnsupported); a lock the browser refuses fails the turn. */
 async function turn<T>(acct: string, f: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const locks = place.locks;
  if (locks === null) throw new SharesUnsupported();
  return locks.request(SYNC_LOCK_PREFIX + acct, () => f(AbortSignal.timeout(place.roundMs ?? ROUND_MS)));
 }

 /** A turn of this tab's: the account it ran for (null: signed out, none ran), the writes whose
  *  request its round handed to fetch (writeKey), those the service refused alone (writeKey: why),
  *  and why it failed. */
 interface Turn { account: string | null; sent: Set<string>; refused: Map<string, unknown>; error?: unknown }
 let running: Promise<Turn> | null = null, queued: Promise<Turn> | null = null;
 /** A turn now, for the account signed in as it starts. One that fails still tells what its pulls
  *  settled in the record (a share the account no longer holds: its grant goes), while that
  *  account is still the one signed in. */
 const turnNow = (): Promise<Turn> => {
  const now = (async (): Promise<Turn> => {
   const acct = account.current?.accountID;
   if (acct === undefined) return { account: null, sent: new Set(), refused: new Map() };
   const sent = new Set<string>(), refused = new Map<string, unknown>();
   try {
    await tell(await turn(acct, signal => round(acct, signal, sent, refused)));
    return { account: acct, sent, refused };
   } catch (error) {
    // Storage that can't be read now leaves it to the next change heard.
    if (account.current?.accountID === acct) await Promise.resolve().then(() => tell({ account: acct, shares: visible(read(acct), acct) })).catch(() => {});
    return { account: acct, sent, refused, error };
   }
  })();
  running = now;
  void now.then(() => { if (running === now) running = null; });
  return now;
 };
 /** A turn that starts after this call: now when none runs, else the one queued after the turn
  *  running (callers that come meanwhile share it), which starts once that one has settled, as it
  *  succeeded or failed. So whatever was kept before the call is in a round begun after it. */
 const nextTurn = (): Promise<Turn> => {
  if (queued !== null) return queued;
  if (running === null) return turnNow();
  return queued = running.then(() => { queued = null; return turnNow(); });
 };
 /** A round after this call (as nextTurn); a round that fails leaves the writes for the next one.
  *  Signed out: nothing to do. */
 const sync = async (): Promise<void> => {
  const done = await nextTurn();
  if (done.error !== undefined) throw done.error;
 };

 /** Keeps change for acct, the account the share is bound to, in this browser's record: one
  *  storage refuses rejects, and nothing is kept. */
 const keep = (acct: string, change: PendingWrite): Promise<void> => update(acct, r => {
  r.pending = r.pending.filter(p => p.id !== change.id).concat(change);
  // A share put here again is held again: its grant no longer goes. One left here owes the removal
  // of its grant here, kept with its delete (dropping) until it is done: whether or not the
  // service ever held the share, so whether or not a tombstone of it comes.
  if (change.body) {
   r.drop = (r.drop ?? []).filter(id => id !== change.id);
   r.pendingDrop = (r.pendingDrop ?? []).filter(id => id !== change.id);
   unmaskInMemory(acct, [change.id]);
   pendingLeaveAccts.delete(change.id);
  } else {
   r.drop = [...new Set([...r.drop ?? [], change.id])];
  }
 });
 /** Sends acct's kept writes while acct is signed in here, in a turn begun after this call: never
  *  to another account. Under another sign-in (or none) they wait for acct's next round on this
  *  browser (null); a round that fails sends them with the next one. */
 const send = async (acct: string): Promise<Turn | null> => {
  if (account.current?.accountID !== acct) return null;
  await tell({ account: acct, shares: visible(read(acct), acct) });
  return nextTurn();
 };

 // Another sign-in shows its own account's shares (and pulls them); signed out, none.
 account.onSessionChange(() => {
  const acct = account.current?.accountID;
  void tell({ account: acct ?? null, shares: acct === undefined ? [] : visible(read(acct), acct) });
  if (acct !== undefined && place.background) void sync().catch(() => {});
 });
 if (place.background) setInterval(() => { if (account.current) void sync().catch(() => {}); }, SYNC_EVERY_MS);
 let followed: ReturnType<typeof setTimeout> | undefined;
 /** A round ms from now plus a second: once the service's clock is past the not_after of the
  *  journal entry that a write queued waits on first (a Leave's delete goes then, not at the next
  *  round due). Only in the background (tests sync by hand). */
 function followUp(ms: number) {
  if (!place.background) return;
  clearTimeout(followed);
  followed = setTimeout(() => { if (account.current) void sync().catch(() => {}); }, Math.max(0, ms) + 1_000);
 }

 const isDroppedIn = (r: SharesRecord, acct: string, id: string): boolean => {
  if (maskActiveIn(r, acct, id)) return true;
  return (r.drop ?? []).includes(id) && !visible(r).some(s => s.id === id);
 };
 const grantStateIn = (r: SharesRecord, acct: string, id: string): "available" | "unverified" | "masked" => {
  if (isDroppedIn(r, acct, id)) return "masked";
  if (hasPendingReset(r, acct) && r.shares.some(s => s.id === id) && !r.pending.some(p => p.body && p.id === id)) {
   return "unverified";
  }
  return "available";
 };

 return {
  /** The current account's shares as this browser knows them; none signed out. */
  list(): RemoteShare[] {
   const acct = account.current?.accountID;
   return acct === undefined ? [] : visible(read(acct), acct);
  },
  /** Classifies a bound grant against acct's record in one storage read: "masked" for confirmed
   *  deletions, "unverified" for mirror-backed ids behind a pending 410 reset (never device-only
   *  grants that were never in the mirror), and "available" otherwise. */
  grantState(acct: string, id: string): "available" | "unverified" | "masked" {
   try {
    return grantStateIn(read(acct), acct, id);
   } catch {
    return masked.get(acct)?.has(id) ? "masked" : "available";
   }
  },
  /** Whether share id of acct is masked as deleted (in memory or durably in r.drop while not
   *  superseded by a newer live row or new put). */
  isMasked(acct: string, id: string): boolean {
   try {
    return isDroppedIn(read(acct), acct, id);
   } catch {
    return masked.get(acct)?.has(id) ?? false;
   }
  },
  /** Account id holding a pending Leave delete for share id (survives grant removal on retry). */
  pendingLeaveAccount(id: string): string | undefined {
   const remembered = pendingLeaveAccts.get(id);
   if (remembered !== undefined) {
    try {
     if (read(remembered).pending.some(p => p.deleted && p.id === id)) return remembered;
     pendingLeaveAccts.delete(id);
    } catch {
     return remembered;
    }
   }
   const cur = account.current?.accountID;
   if (cur !== undefined) {
    try {
     if (read(cur).pending.some(p => p.deleted && p.id === id)) return cur;
    } catch { /* ignore unreadable storage */ }
   }
   return undefined;
  },
  /** Classifies share id on acct under acct's record lock: "listed" when live/put and neither
   *  deleted nor behind a reset, "unverified" when backed by a pre-reset mirror row still awaiting
   *  a committed full pull (distinct from confirmed absence), and "absent" otherwise. */
  async listedState(acct: string, id: string): Promise<"listed" | "unverified" | "absent"> {
   let state: "listed" | "unverified" | "absent" = "absent";
   const ran = await withStorageLock(keyOf(acct), () => {
    const r = read(acct);
    if (visible(r, acct).some(s => s.id === id)) state = "listed";
    else if (grantStateIn(r, acct, id) === "unverified" && !r.pending.some(p => p.deleted && p.id === id)) state = "unverified";
   }, place.locks);
   if (!ran) throw new Error("This browser's storage is locked by another tab. Try again.");
   return state;
  },
  /** Whether share id is on acct as this browser knows it (pulled live or put here, and neither
   *  seen deleted nor left here), read under acct's record lock. */
  async listed(acct: string, id: string): Promise<boolean> {
   return (await this.listedState(acct, id)) === "listed";
  },
  /** The shares left here, or a pull saw leave acct (in any tab of this browser), whose grants may
   *  still be held here: each until cleared via dropLocked, and none put here again or pulled live
   *  since (but for one left here, while its delete waits). */
  dropping(acct: string): string[] {
   const r = read(acct), shown = new Set(visible(r).map(s => s.id));
   const durable = (r.drop ?? []).filter(id => !shown.has(id));
   const mem = [...(masked.get(acct)?.keys() ?? [])].filter(id => maskActiveIn(r, acct, id));
   return [...new Set([...durable, ...mem])];
  },
  /** Revalidates under acct's storage lock that id is still marked dropped before removing its
   *  local grant, so a second tab committing a newer live revision cannot race ahead and have its
   *  grant removed by a stale reconciliation pass. */
  async dropLocked(acct: string, id: string, remove: () => Promise<void>): Promise<void> {
   const run = async () => {
    const r = read(acct);
    if (!isDroppedIn(r, acct, id)) return;
    await remove();
    const hadDurable = (r.drop ?? []).includes(id);
    if (hadDurable) {
     r.drop = (r.drop ?? []).filter(x => x !== id);
     try { place.storage().setItem(keyOf(acct), JSON.stringify(r)); } catch { /* grant already removed; next write prunes r.drop */ }
     unmaskInMemory(acct, [id]);
    }
    // If the marker only existed in memory (localStorage quota prevented saving r.drop), keep the
    // in-memory mask so syncedShares/list still hide the unpersisted deletion until sync succeeds.
   };
   if (place.locks === null) { await run(); return; }
   await place.locks.request(keyOf(acct), run);
  },
  sync,
  /** "Add to my account": keeps a bound grant's share for the account it is bound to
   *  (Access.account), its id the grant's key, sends it in a round begun after (journaled as any
   *  write), and tells how that went (ShareAdd) as the record says once that round ends, or
   *  unknown past addMs (ADD_MS; the round goes on). Refused only when nothing of it is left to
   *  send (the service refused it alone, or holds the share deleted; or it couldn't be kept):
   *  the share is then this browser's only, as the notice says. Else, queued or journaled, the
   *  sync settles it (unknown): under another sign-in here, or none, at the account's next sync
   *  on this browser. Never rejects. */
  async add(access: Access): Promise<ShareAdd> {
   const acct = access.account;
   if (acct === undefined) return { outcome: "refused", error: new Error("this shared access isn't bound to a HerdrUp account") };
   if (place.locks === null) return { outcome: "refused", error: new SharesUnsupported() };
   const put: PendingWrite = { id: grantKey(access), body: shareBody(access) }, key = writeKey(put);
   try { await keep(acct, put); } catch (error) { return { outcome: "refused", error }; }
   let timer: ReturnType<typeof setTimeout> | undefined;
   const late = new Promise<"late">(resolve => { timer = setTimeout(() => resolve("late"), place.addMs ?? ADD_MS); });
   let turned: Turn | null | "late";
   try { turned = await Promise.race([send(acct), late]); } finally { clearTimeout(timer); }
   if (turned === "late") return { outcome: "unknown", error: new DOMException("The account service didn't answer in time.", "TimeoutError") };
   let r: SharesRecord;
   try { r = read(acct); } catch (error) { return { outcome: "unknown", error }; }
   if (!(r.sent ?? []).some(e => writeKey(e) === key) && !r.pending.some(p => writeKey(p) === key)) {
    if (r.shares.some(s => s.id === put.id) && !maskActiveIn(r, acct, put.id)) return { outcome: "added" };
    return { outcome: "refused", error: turned?.refused.get(key) ?? new Error("this shared access was removed from your account") };
   }
   const why = turned === null ? (account.current === null ? new SignedOutError() : new AccountServiceError(409, "account_changed")) : turned.error;
   return { outcome: "unknown", error: why ?? new Error("this shared access is still waiting its turn to be written to your account") };
  },
  /** Leaves share id of acct, the account it is bound to, as one operation: keeps its delete, and
   *  with it the removal of its grant owed here (dropping; rejected: storage refused them, and
   *  nothing else ran, so the Leave can be tried again), runs forget (this browser's own part: its
   *  link, its grant), then sends the delete in a turn of its own, whether forget succeeded or
   *  not: kept, it leaves every device either way, and a grant forget failed to remove goes at the
   *  next change heard (each round's), tombstone or not. Rejects as forget did; else where this
   *  browser can't sync (SharesUnsupported), or when the delete is still queued after that turn
   *  and no request of it carried it (LeaveUnsent: another sign-in here, a round that failed
   *  first; it goes with a later one). One another tab's round took meanwhile went. */
  async leave(id: string, acct: string, forget: () => Promise<void>): Promise<void> {
   const remove: PendingWrite = { id, deleted: true };
   await keep(acct, remove);
   pendingLeaveAccts.set(id, acct);
   let failed: { error: unknown } | null = null;
   try { await forget(); } catch (error) { failed = { error }; }
   const sent = await send(acct);
   if (failed !== null) throw (failed as { error: unknown }).error;
   if (sent?.error instanceof SharesUnsupported) throw sent.error;
   const queued = read(acct).pending.some(p => writeKey(p) === writeKey(remove));
   if (!queued) pendingLeaveAccts.delete(id);
   if (queued && !sent?.sent.has(writeKey(remove))) throw new LeaveUnsent();
  },
  /** Binds this sign-in's session to key as an account device (the statements a bound share
   *  needs are issued only to a session with a device); a session bound already is fine. Where
   *  this browser can't sync shares (SharesUnsupported), nothing is bound: a share isn't taken
   *  into the account (accepted, opened) only to never reach it. */
  async bindDevice(key: StaticKey, signal?: AbortSignal): Promise<void> {
   if (place.locks === null) throw new SharesUnsupported();
   await bindSessionDevice(account, key, place.name, await account.currentAccount(signal), signal);
  },
  /** Hears every change: after each round (which waits for it), each local write, and each
   *  session change. */
  onChange(f: (change: SharesChange) => void | Promise<void>): () => void { listeners.add(f); return () => { listeners.delete(f); }; },
  /** Fires synchronously as soon as a confirmed deletion is masked in memory (before storage
   *  commit or history proofs), so an open guest link detaches immediately. */
  onMasked(f: (acct: string, ids: string[]) => void): () => void { maskListeners.add(f); return () => { maskListeners.delete(f); }; },
 };
}

export type ShareSync = ReturnType<typeof createShareSync>;
