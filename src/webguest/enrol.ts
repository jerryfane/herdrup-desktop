// Enrolling the browser as a device of the account (design #698 §3.2; Go: internal/account/
// devices.go EnrolProof). The device proves it holds its key: k = X25519(d, server_pub),
// mk = HKDF-SHA256(k, salt, "herdrup account enrol v1"), mac = HMAC-SHA256(mk,
// "herdrup-enrol-v1|" account_id "|" device_pub "|" challenge_id). The device key is the
// browser's guest identity, as on the desktop: one key, never replaced.

import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromB64url, toB64url } from "./b64url";
import type { StaticKey } from "./noise";

/** POST /v1/devices/challenge's answer. */
export interface EnrolChallenge { challenge_id: string; server_pub: string; salt: string; account_id: string }

export class BadChallengeError extends Error {
 constructor() { super("account: malformed device challenge"); this.name = "BadChallengeError"; }
}

export async function enrolProof(key: StaticKey, ch: EnrolChallenge): Promise<{ devicePub: string; mac: string }> {
 const serverPub = fromB64url(ch.server_pub, 32);
 const salt = fromB64url(ch.salt, 32);
 if (serverPub === null || salt === null || typeof ch.challenge_id !== "string" || typeof ch.account_id !== "string") throw new BadChallengeError();
 let shared: Uint8Array;
 try { shared = await key.dh(serverPub); } catch { throw new BadChallengeError(); }
 if (shared.every(b => b === 0)) throw new BadChallengeError();
 const mk = hkdf(sha256, shared, salt, new TextEncoder().encode("herdrup account enrol v1"), 32);
 const devicePub = toB64url(key.publicKey);
 const mac = hmac(sha256, mk, new TextEncoder().encode(`herdrup-enrol-v1|${ch.account_id}|${devicePub}|${ch.challenge_id}`));
 return { devicePub, mac: toB64url(mac) };
}
