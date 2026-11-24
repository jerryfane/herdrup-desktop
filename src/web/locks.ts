// The Web Locks API (navigator.locks): one holder per name across this origin's tabs. The account
// session takes turns on its refresh cookie with it (account.ts); state several tabs write in
// localStorage takes turns on its key (withStorageLock).

export interface Locks { request<T>(name: string, callback: () => Promise<T>): Promise<T> }

/** This browser's Web Locks, null where there are none. */
export const browserLocks = (): Locks | null => (globalThis.navigator as { locks?: Locks } | undefined)?.locks ?? null;

/** Runs update, which reads, changes and writes what this origin keeps under name (a localStorage
 *  key), while no other tab runs one for the same name: what it read is still what is there when
 *  it writes. update is synchronous, so nothing in this page comes between either. Without Web
 *  Locks it runs at once (tabs then don't take turns).
 *  Resolves true once update ran. Resolves false only when the lock was refused (the request
 *  rejected before granting it: a SecurityError in a sandboxed or opaque origin, an abort):
 *  update did NOT run, nothing was written, and the caller keeps what it meant to write as not yet
 *  stored, as for a write storage refused. An update that throws rejects, with or without Web
 *  Locks. */
export function withStorageLock(name: string, update: () => void, locks: Locks | null = browserLocks()): Promise<boolean> {
 if (locks === null) return new Promise<boolean>(resolve => { update(); resolve(true); });
 let ran = false;
 return locks.request(name, async () => { ran = true; update(); return true; })
  .catch((error: unknown) => { if (ran) throw error; return false; });
}
