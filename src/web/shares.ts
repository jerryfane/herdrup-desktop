// The account's shares collection for the web guest (AccountService DESIGN §5.1, sync.ts shares;
// herdrup#700): a share bound to the account is written there when it is accepted, read on every
// device of the account (SHARED WITH YOU, "Open on this device"), and deleted when it is left, which
// leaves it on every device. One record per account in localStorage: the shares as last pulled
// (with the revisions of those seen deleted), the revision to pull from next, and this browser's
// writes not yet taken by the service. As every sync write, each carries base_rev: the revision
// last seen for its id (0: none). A put's conflict leaves the service's item standing: the write
// goes, and the pull that follows shows what the account holds. A delete's conflict with a live
// item keeps the delete, based next on that item's revision: it goes only once the share is gone.

import { toB64url } from "../webguest/b64url";
import type { StaticKey } from "../webguest/noise";
import type { Access } from "../webguest/transport";
import { AccountServiceError, type SyncChange, type SyncPushAnswer, type WebAccount } from "./account";
import { withStorageLock, type AbortableLocks } from "./locks";
import { pullSince } from "./prompts";

/** One account's record: SHARES_KEY_PREFIX + the account id. */
export const SHARES_KEY_PREFIX = "herdrup.web.shares.";

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
/** An account share as pulled; id is "<host_id>/<guest_id>". */
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

/** A grant's id on the account and on this page: "<host_id>/<guest_id>". */
export const shareID = (access: Pick<Access, "endpoint" | "guestID">) => `${access.endpoint.hostID}/${access.guestID}`;

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

/** What listeners hear: whose shares they are (null: signed out), the account's shares now, and
 *  those a pull saw deleted (by this device or another): every share the pull shows a tombstone
 *  of, seen live here or not (a put whose readback failed never was), and, after a full pull,
 *  those seen live that it no longer holds. */
export interface SharesChange { account: string | null; shares: RemoteShare[]; removed: string[] }

export function createShareSync(account: WebAccount, place: SharesPlace) {
 const listeners = new Set<(change: SharesChange) => void>();
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
 /** Tells the listeners when the shares differ from the last told, or some left. */
 let told = "";
 const tell = (change: SharesChange) => {
  const now = JSON.stringify(change.shares);
  if (now === told && change.removed.length === 0) return;
  told = now;
  for (const f of [...listeners]) f(change);
 };

 /** One round for acct: this browser's writes, then what the account holds since the last pull. */
 async function round(acct: string, signal?: AbortSignal): Promise<SharesChange> {
  const generation = account.generation;
  const record = read(acct);
  if (record.pending.length > 0) {
   const seen = (id: string) => record.shares.find(s => s.id === id)?.rev ?? record.gone[id] ?? 0;
   const sent = record.pending.map((p): SyncChange => p.deleted
    ? { collection: "shares", id: p.id, base_rev: seen(p.id), deleted: true }
    : { collection: "shares", id: p.id, base_rev: seen(p.id), body: p.body });
   const deletes = new Set(record.pending.filter(p => p.deleted).map(p => p.id));
   const settled = new Set<string>();
   // Deletes refused for their base while the share is still live: the service's rows they go on from.
   const rebased: RemoteShare[] = [];
   /** Sends changes and notes what each settles: applied, a put refused for its base (the
    *  service's item stands), or a delete of a share already gone. */
   const push = async (changes: SyncChange[]): Promise<void> => {
    let answer: SyncPushAnswer | null;
    try {
     answer = await account.syncPush({ prepare: async () => ({ changes }), sending() {}, async refused() {} }, acct, signal, generation);
    } catch (error) {
     // Anything but a 400 (offline, a rate limit, the quota) leaves the writes for the next round.
     if (!(error instanceof AccountServiceError && error.status === 400)) throw error;
     // A 400 refuses the whole push for one change the service won't keep, and none of it is
     // written: each change then goes alone, and only one refused alone (malformed, never to be
     // taken) goes unwritten.
     if (changes.length === 1) settled.add(changes[0]!.id);
     else for (const change of changes) await push([change]);
     return;
    }
    for (const c of answer?.applied ?? []) if (c.collection === "shares") settled.add(c.id);
    for (const c of answer?.conflicts ?? []) {
     if (c.collection !== "shares") continue;
     const server = c.server;
     if (deletes.has(c.id) && server !== null && !server.deleted && validBody(server.body)) rebased.push({ id: c.id, rev: server.rev, body: server.body });
     else settled.add(c.id);
    }
   };
   let failed: { error: unknown } | null = null;
   try { await push(sent); } catch (error) { failed = { error }; }
   // Only the writes sent leave: one made meanwhile for the same share goes next round. What was
   // settled before a push failed (sent alone after a 400) leaves too.
   const sentAs = new Set(record.pending.map(p => JSON.stringify(p)));
   await update(acct, r => {
    r.pending = r.pending.filter(p => !(settled.has(p.id) && sentAs.has(JSON.stringify(p))));
    for (const row of rebased) {
     if ((r.shares.find(s => s.id === row.id)?.rev ?? r.gone[row.id] ?? -1) >= row.rev) continue;
     r.shares = r.shares.filter(s => s.id !== row.id).concat(row).sort((a, b) => a.rev - b.rev);
     delete r.gone[row.id];
    }
   });
   if (failed !== null) throw failed.error;
  }
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
     tell(await round(acct, signal));
    } while (again);
   } finally { running = null; }
  })();
  return running;
 }

 /** Keeps change for acct, the account the share is bound to, and sends it while acct is signed in
  *  here: never to another account. Under another sign-in (or none) it waits for acct's next
  *  round on this browser. */
 const write = async (acct: string, change: PendingWrite): Promise<void> => {
  const shown = await update(acct, r => { r.pending = r.pending.filter(p => p.id !== change.id).concat(change); return visible(r); });
  if (account.current?.accountID !== acct) return;
  tell({ account: acct, shares: shown, removed: [] });
  // The write is kept: a round that fails sends it with the next one.
  await sync().catch(() => {});
 };

 // Another sign-in shows its own account's shares (and pulls them); signed out, none.
 account.onSessionChange(() => {
  const acct = account.current?.accountID;
  tell({ account: acct ?? null, shares: acct === undefined ? [] : visible(read(acct)), removed: [] });
  if (acct !== undefined && place.background) void sync().catch(() => {});
 });
 if (place.background) setInterval(() => { if (account.current) void sync().catch(() => {}); }, SYNC_EVERY_MS);

 return {
  /** The current account's shares as this browser knows them; none signed out. */
  list(): RemoteShare[] {
   const acct = account.current?.accountID;
   return acct === undefined ? [] : visible(read(acct));
  },
  sync,
  /** Writes a bound grant's share to the account it is bound to (Access.account). */
  put: (access: Access) => {
   if (access.account === undefined) return Promise.reject(new Error("This shared access isn't bound to a HerdrUp account."));
   return write(access.account, { id: shareID(access), body: shareBody(access) });
  },
  /** Deletes a share from acct, the account it is bound to: it leaves every device. */
  remove: (id: string, acct: string) => write(acct, { id, deleted: true }),
  /** Binds this sign-in's session to key as an account device (the statements a bound share
   *  needs are issued only to a session with a device); a session bound already is fine. */
  async bindDevice(key: StaticKey, signal?: AbortSignal): Promise<void> {
   try { await account.enrol(key, place.name, undefined, signal); }
   catch (error) { if (!(error instanceof AccountServiceError && error.code === "session_has_device")) throw error; }
  },
  /** Hears every change: after each round, each local write, and each session change. */
  onChange(f: (change: SharesChange) => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; },
 };
}

export type ShareSync = ReturnType<typeof createShareSync>;
