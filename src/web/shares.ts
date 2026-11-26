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
export const SYNC_LOCK_PREFIX = "herdrup.web.shares.sync.";

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
/** An account share as pulled; id is its grant's key, "<host_id>/<guest_id>" (§5.1; grantKey). */
export interface RemoteShare { id: string; rev: number; body: ShareBody }
/** A write not yet taken: the body to put, or a delete. */
interface PendingWrite { id: string; deleted?: true; body?: ShareBody }
/** A write as a push sent it: based on base_rev. */
interface SentWrite extends PendingWrite { base_rev: number }
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
 *  sent: the writes handed to a request whose answer no tab heard (written before the request
 *  goes; one that request was refused, 4xx or never sent, goes again): each may still land, however
 *  late. Until one is answered, it is sent again, as it was, before any other write of its share,
 *  so it can't land after a later one: with its base_rev, the copy and the late request write at
 *  most once between them, and once either is answered the other can't write (the share has moved
 *  off that base, or holds it already). Base 0 assumes no request outlives the 90 days a tombstone
 *  is kept (sync.ts), as the prompts' journal (prompts.ts PromptAttempt). */
interface SharesRecord { rev: number; shares: RemoteShare[]; gone: Record<string, number>; pending: PendingWrite[]; drop?: string[]; sent?: SentWrite[] }

type KeyValue = Pick<Storage, "getItem" | "setItem">;

/** Where the record lives and how tabs take turns writing it; name is this browser's device name.
 *  background: the shares sync on their own, at each sign-in and every SYNC_EVERY_MS (tests sync
 *  by hand). roundMs: how long a round may hold its turn (ROUND_MS unless a test passes its own). */
export interface SharesPlace { storage(): KeyValue; locks: AbortableLocks | null; name: string; background: boolean; roundMs?: number }

/** How long one round may run once it has its turn: its requests are then cancelled, so a stalled
 *  one can't keep every other tab's round (a Leave's delete) waiting (as the prompts' round). */
const ROUND_MS = 60_000;

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
  *  account.ts batches). Each push is made at dispatch from the record as it is then, read again
  *  for every one: first the writes sent before that no answer settled (SharesRecord sent), as they
  *  were sent; then the writes queued whose share has none such, each based on the revision last
  *  seen. A write replaced since (a put by a Leave's delete, in this tab or another) is never sent,
  *  and a write kept since goes in a later push. Each push is journaled (sent) before it goes and
  *  settled as it is answered: one that fails leaves its writes for the next round, and the others
  *  still go. A write goes at most once a round. */
 async function pushQueue(acct: string, signal: AbortSignal, generation: number, attempted: Set<string>): Promise<void> {
  const sentKey = (s: SentWrite) => JSON.stringify({ ...bare(s), base_rev: s.base_rev });
  const change = (s: SentWrite): SyncChange => s.deleted
   ? { collection: "shares", id: s.id, base_rev: s.base_rev, deleted: true }
   : { collection: "shares", id: s.id, base_rev: s.base_rev, body: s.body };
  /** p as it goes now: based on the revision last seen of its share. */
  const based = (r: SharesRecord, p: PendingWrite): SentWrite => ({ ...bare(p), base_rev: r.shares.find(s => s.id === p.id)?.rev ?? r.gone[p.id] ?? 0 });
  /** Settles the writes sent that the answer (or refused: the service refused them alone) does.
   *  Each answered leaves the journal: it can't land after. Off the queue go one applied, a put
   *  refused for its base (the service's item stands), a delete of a share already gone, and one
   *  refused alone. A delete refused while the share is still live stays, based next on the
   *  service's row. A write replaced since it was sent stays (it goes next). What an applied write
   *  left the share at is what its next write is based on. */
  const settle = (sent: SentWrite[], answer: SyncPushAnswer | null, refused: SentWrite[] = []) => update(acct, r => {
   const sentAs = new Map(sent.map(s => [s.id, s] as const));
   const done = new Set(refused.map(writeKey)), closed = new Set(refused.map(sentKey));
   const rows: { id: string; rev: number; body: ShareBody | null }[] = [];
   for (const c of answer?.applied ?? []) {
    const s = c.collection === "shares" ? sentAs.get(c.id) : undefined;
    if (s === undefined) continue;
    done.add(writeKey(s)); closed.add(sentKey(s));
    rows.push({ id: c.id, rev: c.rev, body: s.deleted ? null : s.body! });
   }
   for (const c of answer?.conflicts ?? []) {
    const s = c.collection === "shares" ? sentAs.get(c.id) : undefined;
    if (s === undefined) continue;
    closed.add(sentKey(s));
    const server = c.server;
    if (s.deleted && server !== null && !server.deleted && validBody(server.body)) rows.push({ id: c.id, rev: server.rev, body: server.body });
    else done.add(writeKey(s));
   }
   r.pending = r.pending.filter(p => !done.has(writeKey(p)));
   r.sent = (r.sent ?? []).filter(s => !closed.has(sentKey(s)));
   for (const row of rows) {
    if ((r.shares.find(s => s.id === row.id)?.rev ?? r.gone[row.id] ?? -1) >= row.rev) continue;
    r.shares = r.shares.filter(s => s.id !== row.id);
    delete r.gone[row.id];
    if (row.body !== null) r.shares = r.shares.concat({ id: row.id, rev: row.rev, body: row.body }).sort((a, b) => a.rev - b.rev);
    else if (row.rev > 0) r.gone[row.id] = row.rev;
   }
  });
  let failed: { error: unknown } | null = null;
  /** One push of what pick takes from the record at dispatch, journaled, then settled; how many
   *  writes it sent. A request refused (a 4xx, or cancelled before it went) leaves the journal
   *  as it was. A failure other than a 400 is kept (failed) and leaves its writes queued and
   *  journaled. A 400 refuses the whole push for one change the service won't keep, and none of
   *  it is written: each write then goes alone, while it is still the one queued (or journaled),
   *  and only one refused alone (malformed, never to be taken) leaves unwritten. */
  const push = async (pick: (r: SharesRecord) => SentWrite[]): Promise<number> => {
   let sent: SentWrite[] = [], added: string[] = [];
   let answer: SyncPushAnswer | null;
   try {
    answer = await account.syncPush({
     prepare: () => update(acct, r => {
      sent = pick(r);
      const journal = r.sent ?? [], had = new Set(journal.map(sentKey));
      added = sent.map(sentKey).filter(k => !had.has(k));
      if (added.length > 0) r.sent = journal.concat(sent.filter(s => added.includes(sentKey(s))));
      return sent.length === 0 ? null : { changes: sent.map(change) };
     }),
     sending() {},
     refused: async () => {
      const gone = added;
      added = [];
      if (gone.length > 0) await update(acct, r => { r.sent = (r.sent ?? []).filter(s => !gone.includes(sentKey(s))); });
     },
    }, acct, signal, generation);
   } catch (error) {
    for (const s of sent) attempted.add(writeKey(s));
    if (!(error instanceof AccountServiceError && error.status === 400)) { failed ??= { error }; return sent.length; }
    if (sent.length === 1) await settle([], null, sent);
    else for (const w of sent) await push(r => still(r, w));
    return sent.length;
   }
   for (const s of sent) attempted.add(writeKey(s));
   await settle(sent, answer);
   return sent.length;
  };
  /** w, sent in a push the service refused whole, as it goes alone now: as journaled while it is,
   *  else while it is still the write queued and its share has no other journaled; else none. */
  const still = (r: SharesRecord, w: SentWrite): SentWrite[] => {
   const journal = r.sent ?? [];
   if (journal.some(s => sentKey(s) === sentKey(w))) return [w];
   if (journal.some(s => s.id === w.id)) return [];
   return r.pending.filter(p => writeKey(p) === writeKey(w)).map(p => based(r, p));
  };
  /** The next push: the journaled writes, then the writes queued whose share has none journaled,
   *  none sent yet this round, as many as one push takes. */
  const next = (r: SharesRecord) => {
   const journal = r.sent ?? [], held = new Set(journal.map(s => s.id));
   const left = [...journal, ...r.pending.filter(p => !held.has(p.id)).map(p => based(r, p))].filter(s => !attempted.has(writeKey(s)));
   return left.slice(0, batches(left.map(change))[0]?.length ?? 0);
  };
  // Cancelled, or another sign-in now: nothing more goes for this one.
  while (await push(next) > 0 && !signal.aborted && account.generation === generation);
  if (failed !== null) throw (failed as { error: unknown }).error;
 }

 /** One round for acct: this browser's writes, then what the account holds since the last pull.
  *  attempted gets each write handed to a request (writeKey), as it goes: a round that fails
  *  after still says what it sent. */
 async function round(acct: string, signal: AbortSignal, attempted: Set<string>): Promise<SharesChange> {
  const generation = account.generation;
  await pushQueue(acct, signal, generation, attempted);
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
   const puts = new Set(r.pending.filter(p => p.body).map(p => p.id)), deletes = new Set(r.pending.filter(p => p.deleted).map(p => p.id));
   const tombstoned = pulled.items.filter(it => it.collection === "shares" && it.deleted).map(it => it.id);
   // A share left here stays until its grant is gone, live on the account or not (its delete
   // not taken yet).
   r.drop = [...new Set([...r.drop ?? [], ...before, ...tombstoned])].filter(id => !puts.has(id) && (deletes.has(id) || !live.has(id)));
   return { account: acct, shares: visible(r) };
  });
 }

 /** Runs f as acct's sync turn across this browser's tabs (Web Locks, SYNC_LOCK_PREFIX): one
  *  tab's round at a time, so no tab sends or settles writes while another does (a push of
  *  another tab's still answering can't come after a Leave this tab sent and settled). f's signal
  *  aborts roundMs after the turn was granted: its requests are cancelled and the turn passes, a
  *  stalled request holding no other tab's round. What a push cancelled so may still write stays
  *  journaled (pushQueue), and goes again first. Without Web Locks nothing runs
  *  (SharesUnsupported); a lock the browser refuses fails the turn. */
 async function turn<T>(acct: string, f: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const locks = place.locks;
  if (locks === null) throw new SharesUnsupported();
  return locks.request(SYNC_LOCK_PREFIX + acct, () => f(AbortSignal.timeout(place.roundMs ?? ROUND_MS)));
 }

 /** A turn of this tab's: the account it ran for (null: signed out, none ran), the writes its round
  *  handed to a request (writeKey), and why it failed. */
 interface Turn { account: string | null; sent: Set<string>; error?: unknown }
 let running: Promise<Turn> | null = null, queued: Promise<Turn> | null = null;
 /** A turn now, for the account signed in as it starts. */
 const turnNow = (): Promise<Turn> => {
  const now = (async (): Promise<Turn> => {
   const acct = account.current?.accountID;
   if (acct === undefined) return { account: null, sent: new Set() };
   const sent = new Set<string>();
   try {
    await tell(await turn(acct, signal => round(acct, signal, sent)));
    return { account: acct, sent };
   } catch (error) { return { account: acct, sent, error }; }
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
  r.drop = change.body ? (r.drop ?? []).filter(id => id !== change.id) : [...new Set([...r.drop ?? [], change.id])];
 });
 /** Sends acct's kept writes while acct is signed in here, in a turn begun after this call: never
  *  to another account. Under another sign-in (or none) they wait for acct's next round on this
  *  browser (null); a round that fails sends them with the next one. */
 const send = async (acct: string): Promise<Turn | null> => {
  if (account.current?.accountID !== acct) return null;
  await tell({ account: acct, shares: visible(read(acct)) });
  return nextTurn();
 };

 // Another sign-in shows its own account's shares (and pulls them); signed out, none.
 account.onSessionChange(() => {
  const acct = account.current?.accountID;
  void tell({ account: acct ?? null, shares: acct === undefined ? [] : visible(read(acct)) });
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
  /** The shares left here, or a pull saw leave acct (in any tab of this browser), whose grants may
   *  still be held here: each until cleared, and none put here again or pulled live since (but
   *  for one left here, while its delete waits). */
  dropping(acct: string): string[] {
   const r = read(acct), shown = new Set(visible(r).map(s => s.id));
   return (r.drop ?? []).filter(id => !shown.has(id));
  },
  /** The grants of ids are gone from this browser (removed, or never held): they leave dropping. */
  cleared: (acct: string, ids: string[]) => update(acct, r => { r.drop = (r.drop ?? []).filter(id => !ids.includes(id)); }),
  sync,
  /** Writes a bound grant's share to the account it is bound to (Access.account), its id the
   *  grant's key. */
  put: async (access: Access) => {
   if (access.account === undefined) throw new Error("This shared access isn't bound to a HerdrUp account.");
   await keep(access.account, { id: grantKey(access), body: shareBody(access) });
   const sent = await send(access.account);
   if (sent?.error instanceof SharesUnsupported) throw sent.error;
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
   let failed: { error: unknown } | null = null;
   try { await forget(); } catch (error) { failed = { error }; }
   const sent = await send(acct);
   if (failed !== null) throw (failed as { error: unknown }).error;
   if (sent?.error instanceof SharesUnsupported) throw sent.error;
   const queued = read(acct).pending.some(p => writeKey(p) === writeKey(remove));
   if (queued && !sent?.sent.has(writeKey(remove))) throw new LeaveUnsent();
  },
  /** Binds this sign-in's session to key as an account device (the statements a bound share
   *  needs are issued only to a session with a device); a session bound already is fine. Where
   *  this browser can't sync shares (SharesUnsupported), nothing is bound: a share isn't taken
   *  into the account (accepted, opened) only to never reach it. */
  async bindDevice(key: StaticKey, signal?: AbortSignal): Promise<void> {
   if (place.locks === null) throw new SharesUnsupported();
   try { await account.enrol(key, place.name, undefined, signal); }
   catch (error) { if (!(error instanceof AccountServiceError && error.code === "session_has_device")) throw error; }
  },
  /** Hears every change: after each round (which waits for it), each local write, and each
   *  session change. */
  onChange(f: (change: SharesChange) => void | Promise<void>): () => void { listeners.add(f); return () => { listeners.delete(f); }; },
 };
}

export type ShareSync = ReturnType<typeof createShareSync>;
