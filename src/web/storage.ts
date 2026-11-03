// One browser = one guest: the grant this browser accepted (Go's guest store, internal/guest
// store.go, one share) in IndexedDB beside the identity (webguest/identity.ts). The grant holds no
// secret: the invitation's bearer secret is spent on redemption and never kept. The owner's name
// stays in localStorage after a share is left, so the page can say whom to ask for a new invite.

import type { Access } from "../webguest/transport";

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
