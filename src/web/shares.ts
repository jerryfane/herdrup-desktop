// The account's shares collection for the web guest (AccountService DESIGN §5.1, sync.ts shares;
// herdrup#700): a share bound to the account is written there when it is accepted, read on every
// device of the account (SHARED WITH YOU, "Open on this device"), and deleted when it is left, which
// leaves it on every device. One record per account in localStorage: the shares as last pulled
// (with the revisions of those seen deleted), the revision to pull from next, and this browser's
// writes not yet taken by the service. As every sync write, each carries base_rev: the revision
// last seen for its id (0: none). A put's conflict leaves the service's item standing: the write
// goes, and the pull that follows shows what the account holds. A delete's conflict with a live
// item keeps the delete, based next on that item's revision: it goes only once the share is gone.

import { grantKey } from "../grantKey";
import { toB64url } from "../webguest/b64url";
import type { StaticKey } from "../webguest/noise";
import type { Access } from "../webguest/transport";
import { AccountServiceError, batches, pullSince, type SyncChange, type SyncPushAnswer, type WebAccount } from "./account";
import { withStorageLock, type AbortableLocks } from "./locks";

/** One account's record: SHARES_KEY_PREFIX + the account id. */
export const SHARES_KEY_PREFIX = "herdrup.web.shares.";
/** The Web Lock a tab holds for an account's sync round: SYNC_LOCK_PREFIX + the account id. */
const SYNC_LOCK_PREFIX = "herdrup.web.shares.sync.";

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
/** An account share as pulled; id is its grant's key, "<host_id>/<guest_id>" (§5.1; grantKey). */
export interface RemoteShare { id: string; rev: number; body: ShareBody }
/** A write not yet taken: the body to put, or a delete. */
interface PendingWrite { id: string; deleted?: true; body?: ShareBody }
/** gone: the revisions of the shares seen deleted, which a write of the same id is based on. */
interface SharesRecord { rev: number; shares: RemoteShare[]; gone: Record<string, number>; pending: PendingWrite[] }

type KeyValue = Pick<Storage, "getItem" | "setItem">;

/** Where the record lives and how tabs take turns writing it; name is this browser's device name.
 *  background: the shares sync on their own, at each sign-in and every SYNC_EVERY_MS (tests sync
 *  by hand). */
export interface SharesPlace { storage(): KeyValue; locks: AbortableLocks | null; name: string; background: boolean }

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
 *  (null: signed out), the account's shares now, and those a pull saw deleted (by this device or
 *  another): every share the pull shows a tombstone of, seen live here or not (a put whose
 *  readback failed never was), and, after a full pull, those seen live that it no longer holds.
 *  A pull in another tab of this browser takes the tombstones it sees: a listener reconciles with
 *  the record (deleted), not with removed alone. */
export interface SharesChange { account: string | null; shares: RemoteShare[]; removed: string[] }

export function createShareSync(account: WebAccount, place: SharesPlace) {
 const listeners = new Set<(change: SharesChange) => void | Promise<void>>();
 const keyOf = (acct: string) => SHARES_KEY_PREFIX + acct;
 const read = (acct: string): SharesRecord => {
  const raw = place.storage().getItem(keyOf(acct));
  return raw === null ? { rev: 0, shares: [], gone: {}, pending: [] } : JSON.parse(raw) as SharesRecord;
 };
 /** Reads, changes and writes acct's record in one step under its storage lock. */
 const update = async <T>(acct: string, change: (record: SharesRecord) => T): Promise<T> => {
  let out: { value: T } | null = null;
  const ran = await withStorageLock(keyOf(acct), () => {
   const record = read(acct);
   out = { value: change(record) };
   place.storage().setItem(keyOf(acct), JSON.stringify(record));
  }, place.locks);
  if (!ran || out === null) throw new Error("This browser's storage is locked by another tab. Try again.");
  return (out as { value: T }).value;
 };
 /** The shares as last pulled, with this browser's own unsent puts and without its unsent deletes. */
 const visible = (record: SharesRecord): RemoteShare[] => {
  const pending = new Set(record.pending.map(p => p.id));
  const shown = record.shares.filter(s => !pending.has(s.id)).concat(record.pending.flatMap(p => p.body ? [{ id: p.id, rev: 0, body: p.body }] : []));
  return shown.sort((a, b) => a.id.localeCompare(b.id));
 };
 /** Tells the listeners, and waits for them: a sync is done once what it pulled is reconciled. */
 const tell = async (change: SharesChange): Promise<void> => {
  await Promise.allSettled([...listeners].map(async f => f(change)));
 };

 /** Sends acct's queue in pushes the service takes (at most 100 changes and 256 KiB each,
  *  account.ts batches). Each push is made at dispatch from the queue as it is then, read again for
  *  every one: a write replaced since (a put by a Leave's delete, in this tab or another) is never
  *  sent, and a write kept since goes in a later push. Each is settled as it is answered: one that
  *  fails leaves its writes for the next round, and the others still go. A write goes at most once
  *  a round. */
 async function pushQueue(acct: string, signal: AbortSignal | undefined, generation: number): Promise<void> {
  const writeKey = (p: PendingWrite) => JSON.stringify(p);
  /** The writes sent this round, as sent. */
  const attempted = new Set<string>();
  const change = (r: SharesRecord, p: PendingWrite): SyncChange => {
   const base_rev = r.shares.find(s => s.id === p.id)?.rev ?? r.gone[p.id] ?? 0;
   return p.deleted ? { collection: "shares", id: p.id, base_rev, deleted: true } : { collection: "shares", id: p.id, base_rev, body: p.body };
  };
  /** Leaves the queue the writes sent that the answer settles: applied, a put refused for its
   *  base (the service's item stands), a delete of a share already gone, or (refused) one the
   *  service refused alone. A delete refused while the share is still live stays, based next on
   *  the service's row. A write replaced since it was sent stays (it goes next). */
  const settle = (sent: PendingWrite[], answer: SyncPushAnswer | null, refused: PendingWrite[] = []) => update(acct, r => {
   const sentAs = new Map(sent.map(p => [p.id, p] as const));
   const done = new Set(refused.map(writeKey));
   const rebased: RemoteShare[] = [];
   for (const c of answer?.applied ?? []) { const p = c.collection === "shares" ? sentAs.get(c.id) : undefined; if (p) done.add(writeKey(p)); }
   for (const c of answer?.conflicts ?? []) {
    const p = c.collection === "shares" ? sentAs.get(c.id) : undefined;
    if (p === undefined) continue;
    const server = c.server;
    if (p.deleted && server !== null && !server.deleted && validBody(server.body)) rebased.push({ id: c.id, rev: server.rev, body: server.body });
    else done.add(writeKey(p));
   }
   r.pending = r.pending.filter(p => !done.has(writeKey(p)));
   for (const row of rebased) {
    if ((r.shares.find(s => s.id === row.id)?.rev ?? r.gone[row.id] ?? -1) >= row.rev) continue;
    r.shares = r.shares.filter(s => s.id !== row.id).concat(row).sort((a, b) => a.rev - b.rev);
    delete r.gone[row.id];
   }
  });
  let failed: { error: unknown } | null = null;
  /** One push of what pick takes from the queue at dispatch, settled; how many writes it sent.
   *  A failure other than a 400 is kept (failed) and leaves its writes queued. A 400 refuses the
   *  whole push for one change the service won't keep, and none of it is written: each write then
   *  goes alone, while it is still the one queued, and only one refused alone (malformed, never to
   *  be taken) leaves unwritten. */
  const push = async (pick: (r: SharesRecord) => PendingWrite[]): Promise<number> => {
   let sent: PendingWrite[] = [];
   let answer: SyncPushAnswer | null;
   try {
    answer = await account.syncPush({
     prepare: async () => {
      const r = read(acct);
      sent = pick(r);
      return sent.length === 0 ? null : { changes: sent.map(p => change(r, p)) };
     },
     sending() {}, async refused() {},
    }, acct, signal, generation);
   } catch (error) {
    for (const p of sent) attempted.add(writeKey(p));
    if (!(error instanceof AccountServiceError && error.status === 400)) { failed ??= { error }; return sent.length; }
    if (sent.length === 1) await settle([], null, sent);
    else for (const w of sent) await push(r => r.pending.filter(p => writeKey(p) === writeKey(w)));
    return sent.length;
   }
   for (const p of sent) attempted.add(writeKey(p));
   await settle(sent, answer);
   return sent.length;
  };
  /** The next push: the writes queued now not yet sent this round, as many as one push takes. */
  const next = (r: SharesRecord) => {
   const left = r.pending.filter(p => !attempted.has(writeKey(p)));
   return left.slice(0, batches(left.map(p => change(r, p)))[0]?.length ?? 0);
  };
  // Cancelled, or another sign-in now: nothing more goes for this one.
  while (await push(next) > 0 && !signal?.aborted && account.generation === generation);
  if (failed !== null) throw (failed as { error: unknown }).error;
 }

 /** One round for acct: this browser's writes, then what the account holds since the last pull. */
 async function round(acct: string, signal?: AbortSignal): Promise<SharesChange> {
  const generation = account.generation;
  await pushQueue(acct, signal, generation);
  const pulled = await pullSince(account, acct, read(acct).rev, signal, generation);
  return update(acct, r => {
   const before = new Set(r.shares.map(s => s.id));
   const live = new Map(pulled.full ? [] : r.shares.map(s => [s.id, s] as const));
   const gone = pulled.full ? {} : r.gone;
   for (const it of [...pulled.items].sort((a, b) => a.rev - b.rev)) {
    if (it.collection !== "shares" || Math.max(live.get(it.id)?.rev ?? -1, gone[it.id] ?? -1) > it.rev) continue;
    if (it.deleted) { live.delete(it.id); gone[it.id] = it.rev; }
    else if (validBody(it.body)) { live.set(it.id, { id: it.id, rev: it.rev, body: it.body }); delete gone[it.id]; }
   }
   r.rev = pulled.rev;
   r.shares = [...live.values()].sort((a, b) => a.rev - b.rev);
   r.gone = gone;
   const puts = new Set(r.pending.filter(p => p.body).map(p => p.id));
   const tombstoned = pulled.items.filter(it => it.collection === "shares" && it.deleted).map(it => it.id);
   const removed = new Set([...before, ...tombstoned].filter(id => !live.has(id) && !puts.has(id)));
   return { account: acct, shares: visible(r), removed: [...removed] };
  });
 }

 /** Runs f as acct's sync turn across this browser's tabs (Web Locks, SYNC_LOCK_PREFIX): one
  *  tab's round at a time, so no tab sends or settles writes while another does (a push of
  *  another tab's still answering can't come after a Leave this tab sent and settled). Without
  *  Web Locks, or where the browser refuses the lock, f runs at once: each push is still made from
  *  the queue as it is then (pushQueue). */
 async function turn<T>(acct: string, f: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const locks = place.locks;
  if (locks === null) return f();
  let ran = false;
  const run = () => { ran = true; return f(); };
  try {
   return await (signal ? locks.request(SYNC_LOCK_PREFIX + acct, { signal }, run) : locks.request(SYNC_LOCK_PREFIX + acct, run));
  } catch (error) {
   if (ran || signal?.aborted) throw error;
   return f();
  }
 }

 let running: Promise<void> | null = null, again = false;
 /** A round now, or right after the one running (callers share it); a round that fails leaves the
  *  writes for the next one. Signed out: nothing to do. */
 function sync(signal?: AbortSignal): Promise<void> {
  if (running !== null) { again = true; return running; }
  running = (async () => {
   try {
    do {
     again = false;
     const acct = account.current?.accountID;
     if (acct === undefined) return;
     await tell(await turn(acct, () => round(acct, signal), signal));
    } while (again);
   } finally { running = null; }
  })();
  return running;
 }

 /** Keeps change for acct, the account the share is bound to, in this browser's record: one
  *  storage refuses rejects, and nothing is kept. */
 const keep = (acct: string, change: PendingWrite): Promise<void> =>
  update(acct, r => { r.pending = r.pending.filter(p => p.id !== change.id).concat(change); });
 /** Sends acct's kept writes while acct is signed in here: never to another account. Under
  *  another sign-in (or none) they wait for acct's next round on this browser; a round that fails
  *  sends them with the next one. */
 const send = async (acct: string): Promise<void> => {
  if (account.current?.accountID !== acct) return;
  await tell({ account: acct, shares: visible(read(acct)), removed: [] });
  await sync().catch(() => {});
 };

 // Another sign-in shows its own account's shares (and pulls them); signed out, none.
 account.onSessionChange(() => {
  const acct = account.current?.accountID;
  void tell({ account: acct ?? null, shares: acct === undefined ? [] : visible(read(acct)), removed: [] });
  if (acct !== undefined && place.background) void sync().catch(() => {});
 });
 if (place.background) setInterval(() => { if (account.current) void sync().catch(() => {}); }, SYNC_EVERY_MS);

 return {
  /** The current account's shares as this browser knows them; none signed out. */
  list(): RemoteShare[] {
   const acct = account.current?.accountID;
   return acct === undefined ? [] : visible(read(acct));
  },
  /** Whether share id is on acct as this browser knows it (pulled live or put here, and neither
   *  seen deleted nor left here), read under acct's record lock: a round's update of the record
   *  (what its pull showed) is wholly before or after it. */
  async listed(acct: string, id: string): Promise<boolean> {
   let listed = false;
   const ran = await withStorageLock(keyOf(acct), () => { listed = visible(read(acct)).some(s => s.id === id); }, place.locks);
   if (!ran) throw new Error("This browser's storage is locked by another tab. Try again.");
   return listed;
  },
  /** Whether this browser's record shows share id deleted from acct: seen deleted by a pull (in
   *  any tab of it) or left here, and not put here since. */
  deleted(acct: string, id: string): boolean {
   const r = read(acct);
   return !visible(r).some(s => s.id === id) && (r.gone[id] !== undefined || r.pending.some(p => p.id === id && p.deleted));
  },
  sync,
  /** Writes a bound grant's share to the account it is bound to (Access.account), its id the
   *  grant's key. */
  put: async (access: Access) => {
   if (access.account === undefined) throw new Error("This shared access isn't bound to a HerdrUp account.");
   await keep(access.account, { id: grantKey(access), body: shareBody(access) });
   await send(access.account);
  },
  /** Keeps the delete of share id from acct, the account it is bound to (it leaves every device
   *  once sent): resolved, it is kept, and send(acct) sends it; rejected, storage refused it. */
  remove: (id: string, acct: string) => keep(acct, { id, deleted: true }),
  send,
  /** Binds this sign-in's session to key as an account device (the statements a bound share
   *  needs are issued only to a session with a device); a session bound already is fine. */
  async bindDevice(key: StaticKey, signal?: AbortSignal): Promise<void> {
   try { await account.enrol(key, place.name, undefined, signal); }
   catch (error) { if (!(error instanceof AccountServiceError && error.code === "session_has_device")) throw error; }
  },
  /** Hears every change: after each round (which waits for it), each local write, and each
   *  session change. */
  onChange(f: (change: SharesChange) => void | Promise<void>): () => void { listeners.add(f); return () => { listeners.delete(f); }; },
 };
}

export type ShareSync = ReturnType<typeof createShareSync>;
