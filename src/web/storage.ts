// One browser = one guest: the grant this browser accepted (Go's guest store, internal/guest
// store.go, one share) in IndexedDB beside the identity (webguest/identity.ts). The grant holds no
// secret: the invitation's bearer secret is spent on redemption and never kept. The owner's name
// stays in localStorage after a share is left, so the page can say whom to ask for a new invite.

import type { Access } from "../webguest/transport";
import { browserLocks, withStorageLock, type Locks } from "./locks";

export interface GrantStore {
 get(): Promise<Access | undefined>;
 put(access: Access): Promise<void>;
 remove(): Promise<void>;
}

/** Who shared the last grant this browser held: kept when the grant goes. */
export interface OwnerHint {
 get(): string | null;
 set(owner: string): void;
}

const GRANT_KEY = "grant";
const OWNER_KEY = "herdrup.guest.owner";

function request<T>(req: IDBRequest<T>): Promise<T> {
 const { promise, resolve, reject } = Promise.withResolvers<T>();
 req.onsuccess = () => resolve(req.result);
 req.onerror = () => reject(req.error);
 return promise;
}

/** The grant as one record; Date and Uint8Array are structured-cloned as themselves. */
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

 async #write(run: (store: IDBObjectStore) => void): Promise<void> {
  const tx = (await this.#open()).transaction(this.storeName, "readwrite");
  const done = Promise.withResolvers<void>();
  tx.oncomplete = () => done.resolve();
  tx.onerror = () => done.reject(tx.error);
  tx.onabort = () => done.reject(tx.error ?? new Error("Saving the shared access was aborted."));
  run(tx.objectStore(this.storeName));
  await done.promise;
 }

 async get(): Promise<Access | undefined> {
  const db = await this.#open();
  return await request(db.transaction(this.storeName, "readonly").objectStore(this.storeName).get(GRANT_KEY)) as Access | undefined;
 }

 put(access: Access): Promise<void> { return this.#write((store) => store.put(access, GRANT_KEY)); }
 remove(): Promise<void> { return this.#write((store) => store.delete(GRANT_KEY)); }
}

export class MemoryGrantStore implements GrantStore {
 access: Access | undefined;
 async get() { return this.access; }
 async put(access: Access) { this.access = access; }
 async remove() { this.access = undefined; }
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

/** Whether value is a record of id lists by machine: an object (not an array) whose every entry
 *  is an array of strings. */
function idLists(value: unknown): value is Record<string, string[]> {
 return typeof value === "object" && value !== null && !Array.isArray(value)
  && Object.values(value).every(ids => Array.isArray(ids) && ids.every(id => typeof id === "string"));
}

export function machineLists(key: string, storage: () => Pick<Storage, "getItem" | "setItem"> = () => localStorage,
 locks: Locks | null = browserLocks()): MachineLists {
 /** hostID → id → on: changes not yet stored. */
 const pending = new Map<string, Map<string, boolean>>();
 /** What storage holds, null when it can't be read: also when it isn't lists of ids by machine
  *  (another version's or a damaged record is not written over; edits stay pending). */
 const stored = (): Record<string, string[]> | null => {
  let value: unknown;
  try { const raw = storage().getItem(key); value = raw === null ? {} : JSON.parse(raw); } catch { return null; }
  return idLists(value) ? value : null;
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
  get(hostID) { return applied(hostID, stored()?.[hostID] ?? []); },
  set(hostID, id, on) {
   let changes = pending.get(hostID);
   if (!changes) pending.set(hostID, changes = new Map());
   changes.set(id, on);
   // false: the lock was refused and write didn't run; the changes stay pending, for the next write.
   return withStorageLock(key, write, locks).then(() => {});
  },
 };
}
