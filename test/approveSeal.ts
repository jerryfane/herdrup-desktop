// The approving device's side of an envelope, for tests: Go internal/account/approve.go
// SealEnvelope (HKDF-SHA256 over X25519(t, B), salt B‖T; AES-256-GCM, AAD label‖0‖B‖T‖u64be(seq)).
// AccountService's approve-v1.json pins the opening side (test/webguestApprove.test.ts).
import { gcm } from "@noble/ciphers/aes.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { toB64url } from "../src/webguest/b64url";

const enc = new TextEncoder();
const label = enc.encode("herdrup-approve-v1|envelope");
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

/** approver secret t seals json to browser key B at seq. */
export function seal(t: Uint8Array, B: Uint8Array, seq: number, json: object): string {
 const T = x25519.getPublicKey(t);
 const k = hkdf(sha256, x25519.getSharedSecret(t, B), cat(B, T), label, 32);
 const s = new Uint8Array(8); new DataView(s.buffer).setBigUint64(0, BigInt(seq));
 const iv = crypto.getRandomValues(new Uint8Array(12));
 return toB64url(cat(iv, gcm(k, iv, cat(label, new Uint8Array([0]), B, T, s)).encrypt(enc.encode(JSON.stringify(json)))));
}
