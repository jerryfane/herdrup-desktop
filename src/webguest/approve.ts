// The browser's side of approve-v1 (web owner access WIRE-PLAN §2.2-2.3; Go: internal/account/
// approve.go). The browser B commits to nonce_b, reveals it only once an approving device T has
// sent nonce_t, and shows the 4-digit code the person types on T. T then seals the machine list
// to B: AES-256-GCM under HKDF-SHA256(X25519(b, T)), with B, T and seq in the AAD, so the account
// service carries it without being able to read or swap it. AccountService's
// test/vectors/approve-v1.json pins every step.

import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromB64url } from "./b64url";
import type { StaticKey } from "./noise";

const COMMIT_LABEL = "herdrup-approve-v1|commit";
const CODE_LABEL = "herdrup-approve-v1|sas";
const ENVELOPE_LABEL = "herdrup-approve-v1|envelope";
const SIZE = 32;
const IV = 12;
const TAG = 16;

const text = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
 const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
 let at = 0;
 for (const p of parts) { out.set(p, at); at += p.length; }
 return out;
}

function sized(...parts: Uint8Array[]) {
 for (const p of parts) if (p.length !== SIZE) throw new Error(`approve-v1: ${p.length} bytes where 32 are needed`);
}

/** SHA-256(label ‖ 0x00 ‖ parts…) */
const labelled = (label: string, ...parts: Uint8Array[]) => sha256(concat(text.encode(label), new Uint8Array([0]), ...parts));

/** A fresh 32-byte nonce; never reuse one. */
export function newApproveNonce(random: (n: number) => Uint8Array = n => crypto.getRandomValues(new Uint8Array(n))): Uint8Array {
 return random(SIZE);
}

/** The browser's commitment to nonceB for its key B, sent before it learns anything of T. */
export function approveCommit(browserPub: Uint8Array, nonceB: Uint8Array): Uint8Array {
 sized(browserPub, nonceB);
 return labelled(COMMIT_LABEL, browserPub, nonceB);
}

/** The 4 digits the browser shows and the person types on the approving device. */
export function approveCode(browserPub: Uint8Array, approverPub: Uint8Array, nonceB: Uint8Array, nonceT: Uint8Array): string {
 sized(browserPub, approverPub, nonceB, nonceT);
 const h = labelled(CODE_LABEL, browserPub, approverPub, nonceB, nonceT);
 const n = new DataView(h.buffer, h.byteOffset, 4).getUint32(0);
 return String(n % 10000).padStart(4, "0");
}

/** Opens a sealed envelope as the browser (key holds b) from approverPub at seq: the plaintext
 *  bytes, or an error when it doesn't open (wrong key, seq or approver, or tampered). */
export async function openEnvelope(key: StaticKey, approverPub: Uint8Array, seq: number, sealed: string): Promise<Uint8Array> {
 const browserPub = key.publicKey;
 sized(browserPub, approverPub);
 if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("approve-v1: bad seq");
 const raw = fromB64url(sealed);
 if (raw === null || raw.length < IV + TAG) throw new Error("approve-v1: malformed envelope");
 const ikm = await key.dh(approverPub);
 if (ikm.every(b => b === 0)) throw new Error("approve-v1: all-zero shared secret");
 const k = hkdf(sha256, ikm, concat(browserPub, approverPub), text.encode(ENVELOPE_LABEL), 32);
 const seqBytes = new Uint8Array(8);
 new DataView(seqBytes.buffer).setBigUint64(0, BigInt(seq));
 const aad = concat(text.encode(ENVELOPE_LABEL), new Uint8Array([0]), browserPub, approverPub, seqBytes);
 return gcm(k, raw.subarray(0, IV), aad).decrypt(raw.subarray(IV));
}

/** One machine the approver granted this browser (app/desk_web_access.go webEnvelopeMachine). */
export interface EnvelopeMachine {
 hostItemID: string; label: string; relay: string; hostID: string; nodePub: string;
 grantID: string; scope: "chat" | "terminal"; expiresUnix: number;
}
export type SkipReason = "needs_update" | "unsupported" | "unreachable" | "relay_not_allowed";
export interface EnvelopeSkipped { hostItemID: string; label: string; reason: SkipReason; version?: string }
export interface Envelope { seq: number; issuedUnix: number; approver: string; machines: EnvelopeMachine[]; skipped: EnvelopeSkipped[] }

const SKIP_REASONS: readonly string[] = ["needs_update", "unsupported", "unreachable", "relay_not_allowed"];
const str = (v: unknown): v is string => typeof v === "string";
const int = (v: unknown): v is number => Number.isSafeInteger(v);

/** The machine list in an opened envelope, sealed for seq. Anything else in its shape is refused:
 *  the browser connects only to what this returns. */
export function parseEnvelope(plain: Uint8Array, seq: number): Envelope {
 let e: Record<string, unknown>;
 try { e = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)); }
 catch { throw new Error("approve-v1: the machine list isn't JSON"); }
 const bad = (what: string) => new Error(`approve-v1: the machine list has ${what}`);
 if (e === null || typeof e !== "object" || e.v !== 1) throw bad("an unknown version");
 if (e.seq !== seq) throw bad("another seq than it was sealed with");
 if (!int(e.issued_unix) || !str(e.approver) || !Array.isArray(e.machines) || !Array.isArray(e.skipped)) throw bad("a missing field");
 const machines = e.machines.map((m: Record<string, unknown>): EnvelopeMachine => {
  if (m === null || typeof m !== "object" || !str(m.host_item_id) || !str(m.label) || !str(m.relay) || !str(m.grant_id) || !int(m.expires_unix)
   || fromB64url(m.host_id, 16) === null || fromB64url(m.node_pub, 32) === null || (m.scope !== "chat" && m.scope !== "terminal")) throw bad("a malformed machine");
  return { hostItemID: m.host_item_id, label: m.label, relay: m.relay, hostID: m.host_id as string, nodePub: m.node_pub as string, grantID: m.grant_id, scope: m.scope, expiresUnix: m.expires_unix };
 });
 const skipped = e.skipped.map((s: Record<string, unknown>): EnvelopeSkipped => {
  if (s === null || typeof s !== "object" || !str(s.host_item_id) || !str(s.label) || !str(s.reason) || !SKIP_REASONS.includes(s.reason) || (s.version !== undefined && !str(s.version))) throw bad("a malformed skipped machine");
  return { hostItemID: s.host_item_id, label: s.label, reason: s.reason as SkipReason, ...(s.version !== undefined ? { version: s.version as string } : {}) };
 });
 return { seq, issuedUnix: e.issued_unix, approver: e.approver, machines, skipped };
}
