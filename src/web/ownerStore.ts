// What owner access keeps in this browser (web owner access WIRE-PLAN §2.3): each approver whose
// key this browser verified with a code, the highest envelope seq taken from it, and the machine
// list that envelope carried. Only these approvers' envelopes are ever opened, and only with a
// higher seq, so the account service can neither add an approver nor replay an older list.

import type { Envelope } from "../webguest/approve";

export interface VerifiedApprover {
 /** The approver's X25519 key, unpadded base64url, as the code covered it. */
 pub: string;
 name: string;
 envelope: Envelope;
}

export interface OwnerRecord { v: 1; approvers: VerifiedApprover[] }

export interface OwnerStore {
 get(): Promise<OwnerRecord | undefined>;
 put(record: OwnerRecord): Promise<void>;
 remove(): Promise<void>;
}

const KEY = "owner";

function request<T>(req: IDBRequest<T>): Promise<T> {
 const { promise, resolve, reject } = Promise.withResolvers<T>();
 req.onsuccess = () => resolve(req.result);
 req.onerror = () => reject(req.error);
 return promise;
}

export class IndexedDBOwnerStore implements OwnerStore {
 #db: Promise<IDBDatabase> | undefined;
 constructor(private readonly factory: IDBFactory = globalThis.indexedDB, private readonly name = "herdrup-owner", private readonly storeName = "owner") {}

 #open(): Promise<IDBDatabase> {
  if (this.#db === undefined) {
   const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
   const open = this.factory.open(this.name, 1);
   open.onupgradeneeded = () => { open.result.createObjectStore(this.storeName); };
   open.onsuccess = () => resolve(open.result);
   open.onerror = () => reject(open.error);
   open.onblocked = () => reject(new Error("Owner access storage is open in an older tab. Close it and try again."));
   this.#db = promise;
  }
  return this.#db;
 }

 async #write(run: (store: IDBObjectStore) => void): Promise<void> {
  const tx = (await this.#open()).transaction(this.storeName, "readwrite");
  const done = Promise.withResolvers<void>();
  tx.oncomplete = () => done.resolve();
  tx.onerror = () => done.reject(tx.error);
  tx.onabort = () => done.reject(tx.error ?? new Error("Saving owner access was aborted."));
  run(tx.objectStore(this.storeName));
  await done.promise;
 }

 async get(): Promise<OwnerRecord | undefined> {
  const db = await this.#open();
  return await request(db.transaction(this.storeName, "readonly").objectStore(this.storeName).get(KEY)) as OwnerRecord | undefined;
 }

 put(record: OwnerRecord): Promise<void> { return this.#write(store => store.put(record, KEY)); }
 remove(): Promise<void> { return this.#write(store => store.delete(KEY)); }
}

export class MemoryOwnerStore implements OwnerStore {
 record: OwnerRecord | undefined;
 async get() { return this.record; }
 async put(record: OwnerRecord) { this.record = structuredClone(record); }
 async remove() { this.record = undefined; }
}
