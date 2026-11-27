// The browser's grants (src/web/storage.ts): one per share, the one opened last first, and the
// single grant an earlier version kept read as the record's only (and active) grant, then moved
// to the current record at the next write.
import { expect, test } from "bun:test";
import { IndexedDBGrantStore, MemoryGrantStore } from "../src/web/storage";
import type { Access } from "../src/webguest/transport";

const grant = (guestID: string, hostID = "H"): Access => ({
 guestID, guestName: "visitor", machineLabel: "Mac Studio", ownerName: "Ana", agentName: "docs", agentTarget: "%7",
 endpoint: { relay: "https://relay.example", hostID, hostPublicKey: new Uint8Array(32) }, acceptedAt: new Date(0),
});

// Bun has no IndexedDB; this fake keeps the parts the store uses: one object store, requests that
// answer in a later microtask (a readwrite transaction's next request made in a callback), and a
// transaction that completes once its requests have.
function fakeIndexedDB() {
 const data = new Map<string, unknown>();
 let created = 0;
 const db = {
  createObjectStore: () => { created++; },
  transaction: () => {
   let open = 0;
   const tx = { oncomplete: null as null | (() => void), onerror: null, onabort: null, objectStore: () => store };
   const request = <T>(run: () => T) => {
    const req = { result: undefined as T | undefined, error: null as unknown, onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
    open++;
    queueMicrotask(() => {
     try { req.result = run(); req.onsuccess?.(); } catch (error) { req.error = error; req.onerror?.(); }
     if (--open === 0) setTimeout(() => { if (open === 0) tx.oncomplete?.(); });
    });
    return req;
   };
   const store = {
    get: (key: string) => request(() => data.get(key)),
    put: (value: unknown, key: string) => request(() => { data.set(key, structuredClone(value)); }),
    delete: (key: string) => request(() => { data.delete(key); }),
   };
   return tx;
  },
 };
 const factory = { open: () => { const req = { result: db, onupgradeneeded: null as null | (() => void), onsuccess: null as null | (() => void), onerror: null, onblocked: null }; queueMicrotask(() => { if (created === 0) req.onupgradeneeded?.(); req.onsuccess?.(); }); return req; } };
 return { factory: factory as unknown as IDBFactory, data };
}

test("the one grant an earlier version kept is read as the only one, active, and moved to the record at the next write", async () => {
 const { factory, data } = fakeIndexedDB();
 data.set("grant", grant("g1"));
 const store = new IndexedDBGrantStore(factory);
 expect((await store.list()).map(g => g.guestID)).toEqual(["g1"]);
 expect((await store.get("H/g1"))?.guestID).toBe("g1");
 await store.put(grant("g2"));
 expect([...data.keys()]).toEqual(["grants"]);
 // The earlier grant stays the one opened last.
 expect((await new IndexedDBGrantStore(factory).list()).map(g => g.guestID)).toEqual(["g1", "g2"]);
 await store.activate("H/g2");
 expect((await store.list()).map(g => g.guestID)).toEqual(["g2", "g1"]);
 await store.remove("H/g2");
 expect((await store.list()).map(g => g.guestID)).toEqual(["g1"]);
});

test("a grant is saved beside the others; one of the same share updates it, and none replaces another", async () => {
 for (const store of [new MemoryGrantStore(), new IndexedDBGrantStore(fakeIndexedDB().factory)]) {
  await store.put(grant("g1"));
  await store.put(grant("g1", "H2"));
  await store.activate("H2/g1");
  await store.put({ ...grant("g1"), agentName: "renamed" });
  expect((await store.list()).map(g => [g.endpoint.hostID, g.agentName])).toEqual([["H2", "docs"], ["H", "renamed"]]);
  await store.remove("H2/g1");
  expect((await store.list()).map(g => g.endpoint.hostID)).toEqual(["H"]);
 }
});
