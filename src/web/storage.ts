// One browser = one guest: the grants this browser holds (Go's guest store, internal/guest
// store.go: one per share, keyed "<host_id>/<guest_id>") in IndexedDB beside the identity
// (webguest/identity.ts), and which share it opened last. A grant holds no secret: the
// invitation's bearer secret is spent on redemption and never kept. The owner's name stays in
// localStorage after a share is left, so the page can say whom to ask for a new invite.

import { grantKey } from "../grantKey";
import type { Access } from "../webguest/transport";
import { browserLocks, withStorageLock, type Locks } from "./locks";

/** The grants this browser holds, one per share, and the share the page opened last (it resumes
 *  that one). Saving a grant adds it, or updates the one of its share: no grant replaces another,
 *  so opening another share never loses one held (a grant kept on this device alone can't be had
 *  again). */
export interface GrantStore {
 /** Every grant held, the one opened last first. */
 list(): Promise<Access[]>;
 get(id: string): Promise<Access | undefined>;
 put(access: Access): Promise<void>;
 /** Forgets the grant of share id (left, or deleted from its account). */
 remove(id: string): Promise<void>;
 /** Marks share id as the one opened last, when its grant is still held: the grant as saved
  *  then, in the same step (a grant forgotten meanwhile, in this tab or another, is undefined
  *  and nothing changes), so a connect uses only a grant still held as it starts. */
 activate(id: string): Promise<Access | undefined>;
 /** Names the machine machineLabel, as a hello's reply did at at (labeledAt), on the saved grant
  *  guestID of hostID, and nothing else: a grant forgotten or replaced meanwhile is left as it is
  *  (a late hello never brings one back). */
 relabel(hostID: string, guestID: string, machineLabel: string, at: Date): Promise<void>;
}

/** The grants as stored: active is the share opened last, null when none is (or it was left). */
interface GrantsRecord { grants: Access[]; active: string | null }

const emptyRecord = (): GrantsRecord => ({ grants: [], active: null });
/** The record's grants, its active one first. */
const heldFirst = (r: GrantsRecord): Access[] => [...r.grants].sort((a, b) => Number(grantKey(b) === r.active) - Number(grantKey(a) === r.active));
function putIn(r: GrantsRecord, access: Access) {
 const id = grantKey(access), at = r.grants.findIndex(g => grantKey(g) === id);
 if (at < 0) r.grants.push(access); else r.grants[at] = access;
}
function removeFrom(r: GrantsRecord, id: string) {
 r.grants = r.grants.filter(g => grantKey(g) !== id);
 if (r.active === id) r.active = null;
}
function activateIn(r: GrantsRecord, id: string): Access | undefined {
 const grant = r.grants.find(g => grantKey(g) === id);
 if (grant !== undefined) r.active = id;
 return grant;
}
/** Names the machine on the record's grant guestID of hostID, the one share it is, as a hello did
 *  at at, when that grant is still held; the others, and a grant removed meanwhile, stay as they are. */
function relabelIn(r: GrantsRecord, hostID: string, guestID: string, machineLabel: string, at: Date) {
 r.grants = r.grants.map(g => g.endpoint.hostID === hostID && g.guestID === guestID ? { ...g, machineLabel, labeledAt: at } : g);
}

/** Who shared the last grant this browser held: kept when the grant goes. */
export interface OwnerHint {
 get(): string | null;
 set(owner: string): void;
}

const GRANTS_KEY = "grants";
/** Where an earlier version kept its one grant: read as a record holding it (active), and gone
 *  once a write stores the record. */
const OLD_GRANT_KEY = "grant";
const OWNER_KEY = "herdrup.guest.owner";

/** Reads the record in store, an earlier version's one grant as a record of it, and runs then
 *  within the request's own callback, so a readwrite transaction is still open for its writes. */
function withRecord(store: IDBObjectStore, then: (record: GrantsRecord) => void, fail: (error: unknown) => void) {
 const got = store.get(GRANTS_KEY);
 got.onerror = () => fail(got.error);
 got.onsuccess = () => {
  const record = got.result as GrantsRecord | null | undefined;
  if (record) { then(record); return; }
  const old = store.get(OLD_GRANT_KEY);
  old.onerror = () => fail(old.error);
  old.onsuccess = () => {
   const grant = old.result as Access | null | undefined;
   then(grant ? { grants: [grant], active: grantKey(grant) } : emptyRecord());
  };
 };
}

/** The grants as one record; Date and Uint8Array are structured-cloned as themselves. */
export class IndexedDBGrantStore implements GrantStore {
 #db: Promise<IDBDatabase> | undefined;
 constructor(private readonly factory: IDBFactory = globalThis.indexedDB, private readonly name = "herdrup-guest-grant", private readonly storeName = "grant") {}

 #open(): Promise<IDBDatabase> {
  if (this.#db === undefined) {
   const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
   const open = this.factory.open(this.name, 1);
   open.onupgradeneeded = () => { open.result.createObjectStore(this.storeName); };
   open.onsuccess = () => resolve(open.result);
   open.onerror = () => reject(open.error);
   open.onblocked = () => reject(new Error("The shared access storage is open in an older tab. Close it and try again."));
   this.#db = promise;
  }
  return this.#db;
 }

 /** Changes the record in one readwrite transaction, storing it in the current form; what change
  *  returns once that is committed. */
 async #change<T>(change: (record: GrantsRecord) => T): Promise<T> {
  const tx = (await this.#open()).transaction(this.storeName, "readwrite");
  const done = Promise.withResolvers<void>();
  tx.oncomplete = () => done.resolve();
  tx.onerror = () => done.reject(tx.error);
  tx.onabort = () => done.reject(tx.error ?? new Error("Saving the shared access was aborted."));
  const store = tx.objectStore(this.storeName);
  let out: { value: T } | null = null;
  withRecord(store, record => {
   out = { value: change(record) };
   store.put(record, GRANTS_KEY);
   store.delete(OLD_GRANT_KEY);
  }, error => done.reject(error));
  await done.promise;
  return (out as { value: T } | null)!.value;
 }

 async #read(): Promise<GrantsRecord> {
  const store = (await this.#open()).transaction(this.storeName, "readonly").objectStore(this.storeName);
  const read = Promise.withResolvers<GrantsRecord>();
  withRecord(store, read.resolve, read.reject);
  return read.promise;
 }

 async list(): Promise<Access[]> { return heldFirst(await this.#read()); }
 async get(id: string): Promise<Access | undefined> { return (await this.#read()).grants.find(g => grantKey(g) === id); }
 put(access: Access): Promise<void> { return this.#change(r => putIn(r, access)); }
 remove(id: string): Promise<void> { return this.#change(r => removeFrom(r, id)); }
 /** One read-write transaction (#change): the grant is read and marked with no write between. */
 activate(id: string): Promise<Access | undefined> { return this.#change(r => activateIn(r, id)); }
 /** One read-write transaction (#change): no other write comes between the read and the write. */
 relabel(hostID: string, guestID: string, machineLabel: string, at: Date): Promise<void> { return this.#change(r => relabelIn(r, hostID, guestID, machineLabel, at)); }
}

export class MemoryGrantStore implements GrantStore {
 record = emptyRecord();
 async list() { return heldFirst(this.record); }
 async get(id: string) { return this.record.grants.find(g => grantKey(g) === id); }
 async put(access: Access) { putIn(this.record, access); }
 async remove(id: string) { removeFrom(this.record, id); }
 async activate(id: string) { return activateIn(this.record, id); }
 async relabel(hostID: string, guestID: string, machineLabel: string, at: Date) { relabelIn(this.record, hostID, guestID, machineLabel, at); }
}

export const localOwnerHint: OwnerHint = {
 get() { try { return localStorage.getItem(OWNER_KEY); } catch { return null; } },
 set(owner) { try { localStorage.setItem(OWNER_KEY, owner); } catch { /* storage unavailable: the plain first-visit screen then */ } },
};

export class MemoryOwnerHint implements OwnerHint {
 owner: string | null = null;
 get() { return this.owner; }
 set(owner: string) { this.owner = owner; }
}

/** Lists of ids per machine (hostID) this browser keeps in localStorage under one key, for state
 *  the desktop keeps in Go's per-device files (open folders, muted panes). localStorage is the
 *  value, shared by this origin's tabs. This page's changes not yet stored are kept by machine and
 *  id, never as a copy of a list: a write reads what storage holds, applies all of them one by one,
 *  and writes, under the key's lock (withStorageLock), so no other tab writes between the read
 *  and the write; one that goes through clears them. A write storage refuses (quota, privacy
 *  mode), or a lock refused (nothing is written outside it), leaves them pending, so the change
 *  still holds for this page and goes in with the next write. */
export interface MachineLists {
 /** hostID's list: what storage holds, with this page's pending changes applied. */
 get(hostID: string): string[];
 /** Puts id into hostID's list (on) or takes it out: at once for get, stored in the key's turn
  *  (settled when written or kept pending; it never rejects). */
 set(hostID: string, id: string, on: boolean): Promise<void>;
}

/** Whether value is an object, not an array: the shape of a record by machine. */
function byMachine(value: unknown): value is Record<string, unknown> {
 return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether ids is one machine's list: an array of strings. */
function idList(ids: unknown): ids is string[] {
 return Array.isArray(ids) && ids.every(id => typeof id === "string");
}

export function machineLists(key: string, storage: () => Pick<Storage, "getItem" | "setItem"> = () => localStorage,
 locks: Locks | null = browserLocks()): MachineLists {
 /** hostID → id → on: changes not yet stored. */
 const pending = new Map<string, Map<string, boolean>>();
 /** What storage holds, decoded (an absent key is an empty record); undefined when it can't be
  *  read or isn't JSON. */
 const decoded = (): unknown => {
  try { const raw = storage().getItem(key); return raw === null ? {} : JSON.parse(raw); } catch { return undefined; }
 };
 /** What storage holds for writing, null unless every machine's entry is a list of ids: another
  *  version's or a damaged record is not written over (edits stay pending). */
 const stored = (): Record<string, string[]> | null => {
  const value = decoded();
  return byMachine(value) && Object.values(value).every(idList) ? value as Record<string, string[]> : null;
 };
 /** ids (just decoded, so this page's own) with hostID's pending changes: as they are when there
  *  are none, else through one set, made a list once. */
 const applied = (hostID: string, ids: string[]): string[] => {
  const changes = pending.get(hostID);
  if (changes === undefined) return ids;
  const out = new Set(ids);
  for (const [id, on] of changes) { if (on) out.add(id); else out.delete(id); }
  return [...out];
 };
 /** The pending changes go into what storage holds now (just decoded, so this page's own to
  *  change), written once. Unreadable: nothing is written over it (it may hold another tab's
  *  lists); the changes wait. */
 const write = () => {
  if (pending.size === 0) return;
  const now = stored();
  if (now === null) return;
  for (const host of pending.keys()) now[host] = applied(host, now[host] ?? []);
  try { storage().setItem(key, JSON.stringify(now)); pending.clear(); } catch { /* kept in pending */ }
 };
 return {
  // Only hostID's entry need be a list of ids: another machine's damaged entry doesn't hide this
  // one's (it only stops writes, above).
  get(hostID) {
   const value = decoded();
   const ids = byMachine(value) && Object.hasOwn(value, hostID) ? value[hostID] : undefined;
   return applied(hostID, idList(ids) ? ids : []);
  },
  set(hostID, id, on) {
   let changes = pending.get(hostID);
   if (!changes) pending.set(hostID, changes = new Map());
   changes.set(id, on);
   // false: the lock was refused and write didn't run; the changes stay pending, for the next write.
   return withStorageLock(key, write, locks).then(() => {});
  },
 };
}
