// This browser's device key, as owner access (ownerApproval.ts) and the account's devices
// (accountDesk.ts) both use it: one policy for which key the browser has, and when it makes one.
import { generateIdentity, staticKey, type IdentityStore } from "../webguest/identity";
import type { StaticKey } from "../webguest/noise";

/** The browser's key for owner access: the guest identity, only when WebCrypto keeps it
 *  non-extractable. With none saved, a key is made and saved only if it is a WebCrypto one, so an
 *  unsupported visit leaves nothing behind that a later, supported one would be refused for. A
 *  saved raw key is never replaced: it may hold a share. */
export async function ownerKey(identities: IdentityStore, subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null): Promise<StaticKey | null> {
 let record = await identities.get();
 if (record === undefined) {
  const made = await generateIdentity(subtle);
  if (made.kind !== "webcrypto") return null;
  // A key this browser can't give back would be a new key at every read, and an approved browser
  // would lose its approval at the next one: such a browser can't be approved, and says so.
  record = await identities.add(made);
  if (record === undefined) return null;
 }
 return record.kind === "webcrypto" ? staticKey(record, subtle) : null;
}
