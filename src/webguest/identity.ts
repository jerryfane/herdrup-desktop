// The browser's guest identity: one X25519 static key, shared by every connection to the grant it
// was accepted with (internal/guest/identity.go). Where WebCrypto has X25519 the secret is a
// non-extractable CryptoKey: page script can use it through deriveBits but never read it out.
// Elsewhere it is 32 raw bytes, used through @noble/curves. Like Go's LoadIdentity, a saved key is
// never replaced: losing it would sever the share.

import { x25519 } from "@noble/curves/ed25519.js";
import type { StaticKey } from "./noise";

/** What a store keeps. publicKey is X25519(secret, 9), saved so the CryptoKey form needs no export. */
export type IdentityRecord =
 | { v: 1; kind: "webcrypto"; privateKey: CryptoKey; publicKey: Uint8Array }
 | { v: 1; kind: "raw"; secret: Uint8Array; publicKey: Uint8Array };

/** Where the identity lives. add keeps an existing record: it returns the record now saved, which
 *  is another tab's when that tab saved first (identity.go:512-525's os.Link). */
export interface IdentityStore {
 get(): Promise<IdentityRecord | undefined>;
 add(record: IdentityRecord): Promise<IdentityRecord>;
}

const damaged = () => new Error("The saved guest identity is damaged. It was not replaced; replacing it would disconnect existing shares.");

/** The static key a record holds, for the Noise handshake. */
export function staticKey(record: IdentityRecord, subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null): StaticKey {
 if (record?.v !== 1 || !(record.publicKey instanceof Uint8Array) || record.publicKey.length !== 32) throw damaged();
 if (record.kind === "raw") {
  if (!(record.secret instanceof Uint8Array) || record.secret.length !== 32) throw damaged();
  // identity.go:456-465: the public key follows from the secret.
  if (!x25519.getPublicKey(record.secret).every((byte, i) => byte === record.publicKey[i])) throw new Error("The saved guest identity cannot be read. It was not replaced.");
  const secret = record.secret;
  return { publicKey: record.publicKey, dh: async (peer) => x25519.getSharedSecret(secret, peer) };
 }
 if (record.kind !== "webcrypto" || typeof CryptoKey === "undefined" || !(record.privateKey instanceof CryptoKey) || subtle === null) throw damaged();
 const privateKey = record.privateKey;
 return {
  publicKey: record.publicKey,
  async dh(peer) {
   const peerKey = await subtle.importKey("raw", peer as BufferSource, { name: "X25519" }, false, []);
   // deriveBits refuses an all-zero result, as noble refuses a low-order point.
   return new Uint8Array(await subtle.deriveBits({ name: "X25519", public: peerKey }, privateKey, 256));
  },
 };
}

/** A new identity: a non-extractable WebCrypto key where the browser supports X25519, else raw. */
export async function generateIdentity(subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null): Promise<IdentityRecord> {
 if (subtle !== null) {
  try {
   const pair = await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]) as CryptoKeyPair;
   const publicKey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
   return { v: 1, kind: "webcrypto", privateKey: pair.privateKey, publicKey };
  } catch {
   // No X25519 in this browser's WebCrypto (before Chrome 133, Firefox 130, Safari 17).
  }
 }
 const secret = x25519.utils.randomSecretKey();
 return { v: 1, kind: "raw", secret, publicKey: x25519.getPublicKey(secret) };
}

/** The saved identity, or a new one saved first (Go LoadIdentity). */
export async function loadIdentity(store: IdentityStore, subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null): Promise<StaticKey> {
 const saved = await store.get();
 return staticKey(saved === undefined ? await store.add(await generateIdentity(subtle)) : saved, subtle);
}

/** The saved identity only: a guest returning to a grant never gets an unrelated key (Go
 *  ExistingIdentity). null when storage holds none. */
export async function existingIdentity(store: IdentityStore, subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null): Promise<StaticKey | null> {
 const saved = await store.get();
 return saved === undefined ? null : staticKey(saved, subtle);
}

/** For tests: holds the record as given, CryptoKey included. */
export class MemoryIdentityStore implements IdentityStore {
 record: IdentityRecord | undefined;
 async get() { return this.record; }
 async add(record: IdentityRecord) { this.record ??= record; return this.record; }
}

const RECORD_KEY = "guest";

function request<T>(req: IDBRequest<T>): Promise<T> {
 const { promise, resolve, reject } = Promise.withResolvers<T>();
 req.onsuccess = () => resolve(req.result);
 req.onerror = () => reject(req.error);
 return promise;
}

/** One record in an IndexedDB object store; a CryptoKey is structured-cloned as itself, so the
 *  secret stays inside the browser's key storage. */
export class IndexedDBIdentityStore implements IdentityStore {
 #db: Promise<IDBDatabase> | undefined;
 constructor(private readonly factory: IDBFactory = globalThis.indexedDB, private readonly name = "herdrup-guest", private readonly storeName = "identity") {}

 #open(): Promise<IDBDatabase> {
  if (this.#db === undefined) {
   const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
   const open = this.factory.open(this.name, 1);
   open.onupgradeneeded = () => { open.result.createObjectStore(this.storeName); };
   open.onsuccess = () => resolve(open.result);
   open.onerror = () => reject(open.error);
   open.onblocked = () => reject(new Error("The guest identity storage is open in an older tab. Close it and try again."));
   this.#db = promise;
  }
  return this.#db;
 }

 async get(): Promise<IdentityRecord | undefined> {
  const db = await this.#open();
  return await request(db.transaction(this.storeName, "readonly").objectStore(this.storeName).get(RECORD_KEY)) as IdentityRecord | undefined;
 }

 async add(record: IdentityRecord): Promise<IdentityRecord> {
  const db = await this.#open();
  // Readwrite transactions on one store run one at a time, so this get then add is atomic: a
  // record another tab saved first is read back, never overwritten (and add would refuse it).
  const tx = db.transaction(this.storeName, "readwrite");
  const done = Promise.withResolvers<void>();
  tx.oncomplete = () => done.resolve();
  tx.onerror = () => done.reject(tx.error);
  tx.onabort = () => done.reject(tx.error ?? new Error("Saving the guest identity was aborted."));
  const store = tx.objectStore(this.storeName);
  const existing = await request(store.get(RECORD_KEY)) as IdentityRecord | undefined;
  if (existing !== undefined) return existing;
  store.add(record, RECORD_KEY);
  await done.promise;
  return record;
 }
}
