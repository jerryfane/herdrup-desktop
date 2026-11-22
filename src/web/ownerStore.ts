// What owner access keeps in this browser (web owner access WIRE-PLAN §2.3), per account: each
// approver whose key this browser verified with a code, and the newest machine list taken from it.
// A record belongs to the account it was approved in and to the browser key the lists were sealed
// to; another account, or a new key, never sees it. Only these approvers' envelopes are opened,
// and an approver's list is replaced only by a higher seq, compared when the record is written, so
// neither the service nor two tabs refreshing at once can bring back an older list.

import type { Envelope } from "../webguest/approve";

export interface VerifiedApprover {
 /** The approver's X25519 key, unpadded base64url, as the code covered it. */
 pub: string;
 name: string;
 envelope: Envelope;
}

export interface OwnerRecord {
 v: 2;
 account: string;
 /** This browser's key (unpadded base64url) the lists were sealed to. */
 devicePub: string;
 approvers: VerifiedApprover[];
}

export interface OwnerStore {
 /** account's record, only when it was made with devicePub (the key this browser holds now). */
 get(account: string, devicePub: string): Promise<OwnerRecord | undefined>;
 /** Writes approvers into account's record in one step: an approver's list is kept unless the
  *  one offered has a higher seq. Returns the record as written. */
 merge(account: string, devicePub: string, approvers: VerifiedApprover[]): Promise<OwnerRecord>;
}

/** The merge, as the store applies it to the record it holds at write time. */
export function mergeRecord(current: OwnerRecord | undefined, account: string, devicePub: string, offered: VerifiedApprover[]): OwnerRecord {
 const kept = current?.v === 2 && current.devicePub === devicePub ? current.approvers : [];
 const byPub = new Map(kept.map(a => [a.pub, a] as const));
 for (const a of offered) {
  const had = byPub.get(a.pub);
  if (had === undefined || a.envelope.seq > had.envelope.seq) byPub.set(a.pub, a);
 }
 return { v: 2, account, devicePub, approvers: [...byPub.values()] };
}

const keyOf = (account: string) => `owner:${account}`;
const usable = (r: OwnerRecord | undefined, devicePub: string) => r?.v === 2 && r.devicePub === devicePub ? r : undefined;

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

 async get(account: string, devicePub: string): Promise<OwnerRecord | undefined> {
  const db = await this.#open();
  return usable(await request(db.transaction(this.storeName, "readonly").objectStore(this.storeName).get(keyOf(account))) as OwnerRecord | undefined, devicePub);
 }

 /** One readwrite transaction reads the record and writes the merge: transactions on a store take
  *  turns across tabs, so a write never lands on a record another tab changed meanwhile. */
 async merge(account: string, devicePub: string, approvers: VerifiedApprover[]): Promise<OwnerRecord> {
  const tx = (await this.#open()).transaction(this.storeName, "readwrite");
  const store = tx.objectStore(this.storeName);
  const done = Promise.withResolvers<void>();
  tx.oncomplete = () => done.resolve();
  tx.onerror = () => done.reject(tx.error);
  tx.onabort = () => done.reject(tx.error ?? new Error("Saving owner access was aborted."));
  let written: OwnerRecord | undefined;
  const read = store.get(keyOf(account));
  read.onsuccess = () => {
   written = mergeRecord(read.result as OwnerRecord | undefined, account, devicePub, approvers);
   store.put(written, keyOf(account));
  };
  await done.promise;
  return written!;
 }
}

export class MemoryOwnerStore implements OwnerStore {
 records = new Map<string, OwnerRecord>();
 async get(account: string, devicePub: string) { return usable(this.records.get(keyOf(account)), devicePub); }
 async merge(account: string, devicePub: string, approvers: VerifiedApprover[]) {
  const written = mergeRecord(this.records.get(keyOf(account)), account, devicePub, approvers);
  this.records.set(keyOf(account), structuredClone(written));
  return written;
 }
}
