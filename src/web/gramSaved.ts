// The Saved Grams list in this browser's storage, shared by every document (tab) of the origin.
// Each document renders from its own decoded copy; every change (Save, Unsave, expiry) is a
// read-modify-write of what storage holds now, never of that copy, under the list's storage lock
// (locks.ts withStorageLock, the key as its name), so two documents saving at once both land.
// Without Web Locks the change is still made on a fresh read, just not taking turns with other
// tabs.

import { browserLocks, type Locks, withStorageLock } from "./locks";

const NOT_UPDATED = "Couldn't update the saved messages: ";

export class SavedStore {
 #cache: unknown = undefined;

 /** key: the list's storage key (a storage event names it); storage: the origin's storage (null
  *  without one). */
 constructor(readonly key: string, private readonly storage: () => Pick<Storage, "getItem" | "setItem"> | null,
  private readonly locks: Locks | null = browserLocks()) {}

 /** The stored list as decoded once (for rendering); read again only after drop. */
 read(): unknown {
  if (this.#cache === undefined) this.#cache = this.#fresh();
  return this.#cache;
 }

 /** Another document changed the list (its storage event): the next read decodes it again. */
 drop() { this.#cache = undefined; }

 /** Changes the list as storage holds it now: mutate, called under the lock right before the
  *  write, gets that list and returns the next one, or null for no change. A change that isn't
  *  stored (the lock refused; storage refused or not to be had: quota, private mode, a denied
  *  localStorage) is returned as the error, never thrown; the copy is then the list storage still
  *  holds. */
 async update(mutate: (current: unknown) => unknown): Promise<Error | null> {
  let failed: Error | null = null;
  // false: the lock was refused (withStorageLock), the change didn't run and nothing was written.
  const ran = await withStorageLock(this.key, () => { failed = this.#write(mutate); }, this.locks);
  return ran ? failed : new Error(NOT_UPDATED + "this browser refused the lock that keeps its tabs' changes apart");
 }

 #write(mutate: (current: unknown) => unknown): Error | null {
  const current = this.#fresh();
  const next = mutate(current);
  if (next === null) { this.#cache = current; return null; }
  // Getting the storage can throw as its write can (a SecurityError): one error path for both.
  try {
   const storage = this.storage();
   if (storage === null) throw new Error("this browser keeps no storage for this page");
   storage.setItem(this.key, JSON.stringify(next));
  } catch (error) {
   this.#cache = current;
   return new Error(NOT_UPDATED + (error instanceof Error ? error.message : String(error)));
  }
  this.#cache = next;
  return null;
 }

 #fresh(): unknown {
  try { return JSON.parse(this.storage()?.getItem(this.key) ?? "[]") as unknown; } catch { return []; }
 }
}
