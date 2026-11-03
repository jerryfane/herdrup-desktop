import { expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { existingIdentity, generateIdentity, IndexedDBIdentityStore, loadIdentity, MemoryIdentityStore, staticKey, type IdentityRecord } from "../src/webguest/identity";

test("a new identity is a non-extractable WebCrypto key whose DH agrees with X25519", async () => {
 const record = await generateIdentity();
 if (record.kind !== "webcrypto") throw new Error("Bun's WebCrypto has X25519; expected the CryptoKey form");
 expect(record.privateKey.extractable).toBe(false);
 expect(record.privateKey.usages).toEqual(["deriveBits"]);
 await expect(crypto.subtle.exportKey("pkcs8", record.privateKey)).rejects.toThrow();
 const peer = x25519.utils.randomSecretKey();
 const shared = await staticKey(record).dh(x25519.getPublicKey(peer));
 expect(shared).toEqual(x25519.getSharedSecret(peer, record.publicKey));
});

test("without WebCrypto X25519 the identity is raw bytes used through @noble/curves", async () => {
 const unsupported = { generateKey: async () => { throw new DOMException("X25519", "NotSupportedError"); } } as unknown as SubtleCrypto;
 for (const subtle of [unsupported, null]) {
  const record = await generateIdentity(subtle);
  if (record.kind !== "raw") throw new Error("expected the raw form");
  expect(record.publicKey).toEqual(x25519.getPublicKey(record.secret));
  const peer = x25519.utils.randomSecretKey();
  expect(await staticKey(record, subtle).dh(x25519.getPublicKey(peer))).toEqual(x25519.getSharedSecret(peer, record.publicKey));
 }
});

// identity.go: a saved key is never replaced, and a damaged one is an error, not a new key.
test("a saved identity is loaded, never replaced, and refused when damaged", async () => {
 const store = new MemoryIdentityStore();
 expect(await existingIdentity(store)).toBeNull();
 const first = await loadIdentity(store);
 const again = await loadIdentity(store);
 expect(again.publicKey).toEqual(first.publicKey);
 expect((await existingIdentity(store))?.publicKey).toEqual(first.publicKey);
 // A second tab's add loses to the record already saved.
 const other = await generateIdentity();
 expect((await store.add(other)).publicKey).toEqual(first.publicKey);
 const secret = x25519.utils.randomSecretKey();
 const damaged: unknown[] = [
  { v: 1, kind: "raw", secret: secret.subarray(0, 31), publicKey: x25519.getPublicKey(secret) },
  { v: 1, kind: "raw", secret, publicKey: new Uint8Array(32) },
  { v: 2, kind: "raw", secret, publicKey: x25519.getPublicKey(secret) },
  { v: 1, kind: "webcrypto", privateKey: "not a key", publicKey: x25519.getPublicKey(secret) },
  null,
 ];
 for (const record of damaged) {
  const broken = new MemoryIdentityStore();
  broken.record = record as IdentityRecord;
  await expect(loadIdentity(broken)).rejects.toThrow("guest identity");
  expect(broken.record).toBe(record as IdentityRecord);
 }
});

// Bun has no IndexedDB; this fake keeps the parts the store uses (one object store, readwrite
// transactions that complete after their requests) so the store's own flow is checked. A browser
// structured-clones the CryptoKey into it; that is checked in the browser build.
function fakeIndexedDB() {
 const data = new Map<string, unknown>();
 let created = 0;
 const request = <T>(run: () => T) => {
  const req = { result: undefined as T | undefined, error: null as unknown, onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
  queueMicrotask(() => { try { req.result = run(); req.onsuccess?.(); } catch (error) { req.error = error; req.onerror?.(); } });
  return req;
 };
 const db = {
  createObjectStore: () => { created++; },
  transaction: () => {
   const tx = { oncomplete: null as null | (() => void), onerror: null, onabort: null, objectStore: () => ({
    get: (key: string) => request(() => data.get(key)),
    add: (value: unknown, key: string) => request(() => { if (data.has(key)) throw new DOMException("exists", "ConstraintError"); data.set(key, value); setTimeout(() => tx.oncomplete?.()); }),
   }) };
   return tx;
  },
 };
 const factory = { open: () => { const req = { result: db, onupgradeneeded: null as null | (() => void), onsuccess: null as null | (() => void), onerror: null, onblocked: null }; queueMicrotask(() => { if (created === 0) req.onupgradeneeded?.(); req.onsuccess?.(); }); return req; } };
 return { factory: factory as unknown as IDBFactory, data };
}

test("the IndexedDB store saves one record and returns an earlier one instead of overwriting it", async () => {
 const { factory, data } = fakeIndexedDB();
 const store = new IndexedDBIdentityStore(factory);
 expect(await store.get()).toBeUndefined();
 const key = await loadIdentity(store);
 expect(data.size).toBe(1);
 expect((await loadIdentity(new IndexedDBIdentityStore(factory))).publicKey).toEqual(key.publicKey);
 const later = await generateIdentity();
 expect((await store.add(later)).publicKey).toEqual(key.publicKey);
});
