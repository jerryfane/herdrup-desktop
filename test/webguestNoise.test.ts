import { expect, test } from "bun:test";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { CipherState, Initiator, MAX_NOISE_MESSAGE, MAX_NOISE_PLAINTEXT, PROTOCOL_NAME, guestPrologue, type StaticKey } from "../src/webguest/noise";
import { staticKey } from "../src/webguest/identity";
import { Responder } from "./webguestResponder";
import vector from "../internal/guest/testdata/noise_ik_vector.json";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const unhex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));
const empty = new Uint8Array(0);

function rawKey(secret: Uint8Array): StaticKey {
 return { publicKey: x25519.getPublicKey(secret), dh: async (peer) => x25519.getSharedSecret(secret, peer) };
}

// The X25519 private key as PKCS#8 (RFC 8410), the one form WebCrypto imports a private key in.
async function webCryptoKey(secret: Uint8Array): Promise<StaticKey> {
 const pkcs8 = new Uint8Array([...unhex("302e020100300506032b656e04220420"), ...secret]);
 const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, ["deriveBits"]);
 return staticKey({ v: 1, kind: "webcrypto", privateKey, publicKey: x25519.getPublicKey(secret) });
}

// herdr's transcript (internal/guest/testdata/README.md): the guest must write every initiator message byte for
// byte and read every responder message, with the raw-key and the non-extractable WebCrypto DH.
for (const [name, key] of [["raw key", async () => rawKey(unhex(vector.init_static))], ["WebCrypto key", () => webCryptoKey(unhex(vector.init_static))]] as const) {
 test(`the guest reproduces herdr's Noise IK vector (${name})`, async () => {
  expect(vector.protocol_name).toBe(PROTOCOL_NAME);
  expect(hex(guestPrologue(vector.host_id))).toBe(vector.init_prologue);
  const identity = await key();
  expect(hex(identity.publicKey)).toBe(vector.init_static_public);
  const guest = new Initiator({ hostID: vector.host_id, hostPublicKey: unhex(vector.init_remote_static), staticKey: identity, ephemeralSecret: unhex(vector.init_ephemeral) });
  const [hello, reply, request, answer] = vector.messages;
  expect(hex(await guest.writeHello(unhex(hello!.payload)))).toBe(hello!.ciphertext);
  const { payload, session } = await guest.readReply(unhex(reply!.ciphertext));
  expect(hex(payload)).toBe(reply!.payload);
  expect(hex(session.handshakeHash)).toBe(vector.handshake_hash);
  expect(hex(session.encrypt(unhex(request!.payload)))).toBe(request!.ciphertext);
  expect(hex(session.decrypt(unhex(answer!.ciphertext)))).toBe(answer!.payload);
 });
}

// The transport tests' host runs this responder, so it must speak herdr's half of the vector too.
test("the test responder reproduces herdr's half of the vector", () => {
 const host = new Responder(vector.host_id, unhex(vector.resp_static), unhex(vector.resp_ephemeral));
 const [hello, reply, request, answer] = vector.messages;
 expect(hex(host.readHello(unhex(hello!.ciphertext)))).toBe(hello!.payload);
 expect(hex(host.guestPublic)).toBe(vector.init_static_public);
 const { message, send, receive, hash } = host.writeReply(unhex(reply!.payload));
 expect(hex(message)).toBe(reply!.ciphertext);
 expect(hex(hash)).toBe(vector.handshake_hash);
 expect(hex(receive.decryptWithAd(empty, unhex(request!.ciphertext)))).toBe(request!.payload);
 expect(hex(send.encryptWithAd(empty, unhex(answer!.payload)))).toBe(answer!.ciphertext);
});

// Spec §5.1/§12.3: n counts every message, little-endian after four zero bytes, so the second
// message of a session is sealed under nonce 00000000 01000000 00000000.
test("transport nonces count up as 64-bit little-endian", async () => {
 const hostSecret = x25519.utils.randomSecretKey();
 const guest = new Initiator({ hostID: "h", hostPublicKey: x25519.getPublicKey(hostSecret), staticKey: rawKey(x25519.utils.randomSecretKey()) });
 const host = new Responder("h", hostSecret);
 host.readHello(await guest.writeHello(empty));
 const { message, receive } = host.writeReply(empty);
 const { session } = await guest.readReply(message);
 const sent = [1, 2, 3].map((n) => session.encrypt(Uint8Array.of(n)));
 for (const [n, frame] of sent.entries()) expect([...receive.decryptWithAd(empty, frame)]).toEqual([n + 1]);
 // Out of order fails: the receiver is at n = 3 now, so frame 0 does not open.
 expect(() => receive.decryptWithAd(empty, sent[0]!)).toThrow();
 const direct = new CipherState(new Uint8Array(32));
 direct.encryptWithAd(empty, empty);
 const second = direct.encryptWithAd(empty, Uint8Array.of(7));
 expect(hex(second)).toBe(hex(chacha20poly1305(new Uint8Array(32), unhex("000000000100000000000000"), empty).encrypt(Uint8Array.of(7))));
});

test("a session refuses plaintexts and messages over the Noise limits", async () => {
 const hostSecret = x25519.utils.randomSecretKey();
 const guest = new Initiator({ hostID: "h", hostPublicKey: x25519.getPublicKey(hostSecret), staticKey: rawKey(x25519.utils.randomSecretKey()) });
 const host = new Responder("h", hostSecret);
 host.readHello(await guest.writeHello(empty));
 const { session } = await guest.readReply(host.writeReply(empty).message);
 expect(MAX_NOISE_PLAINTEXT).toBe(65519);
 expect(session.encrypt(new Uint8Array(MAX_NOISE_PLAINTEXT)).length).toBe(MAX_NOISE_MESSAGE);
 expect(() => session.encrypt(new Uint8Array(MAX_NOISE_PLAINTEXT + 1))).toThrow("Noise message limit");
 expect(() => session.decrypt(new Uint8Array(MAX_NOISE_MESSAGE + 1))).toThrow("Noise message limit");
});

test("a reply from any other host key, or with another prologue, fails to authenticate", async () => {
 const hostSecret = x25519.utils.randomSecretKey();
 const guestKey = rawKey(x25519.utils.randomSecretKey());
 for (const [hostID, secret] of [["other-host", hostSecret], ["h", x25519.utils.randomSecretKey()]] as const) {
  const guest = new Initiator({ hostID: "h", hostPublicKey: x25519.getPublicKey(hostSecret), staticKey: guestKey });
  const hello = await guest.writeHello(empty);
  const host = new Responder(hostID, secret);
  expect(() => host.readHello(hello)).toThrow();
 }
 // A host that read the hello but answers under another ephemeral-static binding is refused too.
 const guest = new Initiator({ hostID: "h", hostPublicKey: x25519.getPublicKey(hostSecret), staticKey: guestKey });
 const host = new Responder("h", hostSecret);
 host.readHello(await guest.writeHello(empty));
 const { message } = host.writeReply(empty);
 message[message.length - 1]! ^= 1;
 await expect(guest.readReply(message)).rejects.toThrow();
});
