// Noise_IK_25519_ChaChaPoly_SHA256, the guest (initiator) half, as the Noise spec (revision 34)
// §5 and §7 define it, on @noble primitives. herdr is the responder (/root/herdr
// src/guest/link/noise.rs:12-22 at f0b7ae61) and Go's guest client the other initiator
// (internal/guest/session.go:16-20,133, flynn/noise). internal/guest/testdata/noise_ik_vector.json pins all three.
//
// DH with the guest's static key is asynchronous: in a browser that key is a non-extractable
// WebCrypto CryptoKey, usable only through crypto.subtle.deriveBits (identity.ts). The per-handshake
// ephemeral is raw bytes from @noble/curves.

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_SHA256";
/** The largest Noise message, and so the largest relay frame (session.go:16, noise.rs:14). */
export const MAX_NOISE_MESSAGE = 65535;
/** The largest transport plaintext, so every ciphertext fits one message (session.go:17). */
export const MAX_NOISE_PLAINTEXT = MAX_NOISE_MESSAGE - 16;
const KEY = 32;
const TAG = 16;
const EMPTY = new Uint8Array(0);

/** Every session is bound to the host's relay identity (session.go:133, noise.rs:19-22). */
export function guestPrologue(hostID: string): Uint8Array {
 return new TextEncoder().encode("herdr-guest/1:" + hostID);
}

/** A static X25519 key whose secret this module never sees: dh is X25519(secret, peerPublic). */
export interface StaticKey {
 readonly publicKey: Uint8Array;
 dh(peerPublic: Uint8Array): Promise<Uint8Array>;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
 let length = 0;
 for (const part of parts) length += part.length;
 const out = new Uint8Array(length);
 let at = 0;
 for (const part of parts) { out.set(part, at); at += part.length; }
 return out;
}

/** HKDF(chaining_key, input_key_material, 2) of spec §4.3 with HMAC-SHA256. */
function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
 const temp = hmac(sha256, ck, ikm);
 const first = hmac(sha256, temp, Uint8Array.of(1));
 const second = hmac(sha256, temp, concat(first, Uint8Array.of(2)));
 temp.fill(0);
 return [first, second];
}

/** Spec §5.1. ChaChaPoly's 96-bit nonce is 32 zero bits then n as 64-bit little-endian (§12.3). */
export class CipherState {
 #k: Uint8Array | null;
 #n = 0;
 constructor(k: Uint8Array | null = null) { this.#k = k; }

 #nonce(): Uint8Array {
  // 2^64-1 is reserved (§5.1); a session ends long before a float loses integers.
  if (this.#n >= Number.MAX_SAFE_INTEGER) throw new Error("noise: nonce exhausted");
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  view.setUint32(4, this.#n >>> 0, true);
  view.setUint32(8, Math.floor(this.#n / 2 ** 32), true);
  return nonce;
 }

 encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (this.#k === null) return plaintext.slice();
  const out = chacha20poly1305(this.#k, this.#nonce(), ad).encrypt(plaintext);
  this.#n++;
  return out;
 }

 /** Throws on a failed tag, leaving n unchanged (§5.1). */
 decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (this.#k === null) return ciphertext.slice();
  const out = chacha20poly1305(this.#k, this.#nonce(), ad).decrypt(ciphertext);
  this.#n++;
  return out;
 }
}

/** Spec §5.2. Exported for the test responder; a guest only initiates. */
export class SymmetricState {
 ck: Uint8Array;
 h: Uint8Array;
 cs = new CipherState();

 constructor(protocolName: string) {
  const name = new TextEncoder().encode(protocolName);
  this.h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name);
  this.ck = this.h.slice();
 }

 mixKey(ikm: Uint8Array): void {
  const [ck, k] = hkdf2(this.ck, ikm);
  this.ck = ck;
  this.cs = new CipherState(k);
 }

 mixHash(data: Uint8Array): void { this.h = sha256(concat(this.h, data)); }

 encryptAndHash(plaintext: Uint8Array): Uint8Array {
  const ciphertext = this.cs.encryptWithAd(this.h, plaintext);
  this.mixHash(ciphertext);
  return ciphertext;
 }

 decryptAndHash(ciphertext: Uint8Array): Uint8Array {
  const plaintext = this.cs.decryptWithAd(this.h, ciphertext);
  this.mixHash(ciphertext);
  return plaintext;
 }

 /** The initiator's send and receive ciphers, in that order. */
 split(): [CipherState, CipherState] {
  const [send, receive] = hkdf2(this.ck, EMPTY);
  this.ck.fill(0);
  return [new CipherState(send), new CipherState(receive)];
 }
}

/** An established session's ciphers, with the transport limits of session.go:16-17. */
export class NoiseSession {
 constructor(readonly handshakeHash: Uint8Array, private readonly send: CipherState, private readonly receive: CipherState) {}

 encrypt(plaintext: Uint8Array): Uint8Array {
  if (plaintext.length > MAX_NOISE_PLAINTEXT) throw new Error("noise: plaintext exceeds the Noise message limit");
  return this.send.encryptWithAd(EMPTY, plaintext);
 }

 decrypt(ciphertext: Uint8Array): Uint8Array {
  if (ciphertext.length > MAX_NOISE_MESSAGE) throw new Error("noise: message exceeds the Noise message limit");
  return this.receive.decryptWithAd(EMPTY, ciphertext);
 }
}

export interface InitiatorConfig {
 hostID: string;
 /** The host's static key, known in advance (IK's `<- s`). */
 hostPublicKey: Uint8Array;
 staticKey: StaticKey;
 /** The ephemeral secret; tests only. Otherwise a fresh random one per handshake. */
 ephemeralSecret?: Uint8Array;
}

/** The IK handshake from the guest's side:
 *    <- s
 *    ...
 *    -> e, es, s, ss
 *    <- e, ee, se */
export class Initiator {
 #ss = new SymmetricState(PROTOCOL_NAME);
 #config: InitiatorConfig;
 #e: Uint8Array | null = null;
 #done = false;

 constructor(config: InitiatorConfig) {
  if (config.hostPublicKey.length !== KEY) throw new Error("noise: the host key is not 32 bytes");
  this.#config = config;
  this.#ss.mixHash(guestPrologue(config.hostID));
  this.#ss.mixHash(config.hostPublicKey);
 }

 /** Message 1 carrying payload (the guest's hello). */
 async writeHello(payload: Uint8Array): Promise<Uint8Array> {
  if (this.#e !== null || this.#done) throw new Error("noise: hello already written");
  const { hostPublicKey, staticKey } = this.#config;
  const e = this.#config.ephemeralSecret?.slice() ?? x25519.utils.randomSecretKey();
  this.#e = e;
  const ePublic = x25519.getPublicKey(e);
  this.#ss.mixHash(ePublic);
  this.#ss.mixKey(x25519.getSharedSecret(e, hostPublicKey));
  const s = this.#ss.encryptAndHash(staticKey.publicKey);
  this.#ss.mixKey(await staticKey.dh(hostPublicKey));
  const message = concat(ePublic, s, this.#ss.encryptAndHash(payload));
  if (message.length > MAX_NOISE_MESSAGE) throw new Error("noise: hello exceeds the Noise message limit");
  return message;
 }

 /** Message 2: the host's reply payload and the session it establishes. Throws when the reply is
  *  not from the host the guest expects. */
 async readReply(message: Uint8Array): Promise<{ payload: Uint8Array; session: NoiseSession }> {
  const e = this.#e;
  if (e === null || this.#done) throw new Error("noise: no hello to answer");
  this.#done = true;
  if (message.length < KEY + TAG || message.length > MAX_NOISE_MESSAGE) throw new Error("noise: reply has the wrong length");
  const re = message.subarray(0, KEY);
  this.#ss.mixHash(re);
  this.#ss.mixKey(x25519.getSharedSecret(e, re));
  this.#ss.mixKey(await this.#config.staticKey.dh(re));
  e.fill(0);
  const payload = this.#ss.decryptAndHash(message.subarray(KEY));
  const [send, receive] = this.#ss.split();
  return { payload, session: new NoiseSession(this.#ss.h, send, receive) };
 }
}
