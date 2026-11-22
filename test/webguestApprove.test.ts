import { expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { approveCode, approveCommit, openEnvelope, parseEnvelope } from "../src/webguest/approve";
import { fromB64url, toB64url } from "../src/webguest/b64url";
import { BadChallengeError, enrolProof } from "../src/webguest/enrol";
import { staticKey } from "../src/webguest/identity";
import type { StaticKey } from "../src/webguest/noise";
import vector from "../internal/account/testdata/approve-v1.json";
import enrolVectors from "../internal/account/testdata/enrol-v1.json";

const b = (s: string) => { const v = fromB64url(s); if (v === null) throw new Error(`not b64url: ${s}`); return v; };

/** Both forms the browser keeps its key in: raw bytes, and a non-extractable WebCrypto key. */
async function keys(secret: Uint8Array): Promise<Record<string, StaticKey>> {
 const pkcs8 = new Uint8Array([...Buffer.from("302e020100300506032b656e04220420", "hex"), ...secret]);
 const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, ["deriveBits"]);
 const publicKey = x25519.getPublicKey(secret);
 return { raw: staticKey({ v: 1, kind: "raw", secret, publicKey }), webcrypto: staticKey({ v: 1, kind: "webcrypto", privateKey, publicKey }) };
}

test("approve-v1 matches AccountService's vector: commit, code and the sealed list, with either key form", async () => {
 const B = b(vector.browser_pub), T = b(vector.approver_pub), nB = b(vector.nonce_b), nT = b(vector.nonce_t);
 expect(toB64url(approveCommit(B, nB))).toBe(vector.commit);
 expect(approveCode(B, T, nB, nT)).toBe(vector.code);
 for (const [kind, key] of Object.entries(await keys(b(vector.browser_priv)))) {
  expect(toB64url(key.publicKey), kind).toBe(vector.browser_pub);
  expect(new TextDecoder().decode(await openEnvelope(key, T, vector.seq, vector.sealed)), kind).toBe(vector.envelope_json);
 }
});

test("an envelope opens only for the seq, approver and bytes it was sealed with", async () => {
 const { raw: key } = await keys(b(vector.browser_priv));
 const T = b(vector.approver_pub);
 await expect(openEnvelope(key, T, vector.seq + 1, vector.sealed)).rejects.toThrow();
 const flipped = b(vector.sealed); flipped[20] ^= 1;
 await expect(openEnvelope(key, T, vector.seq, toB64url(flipped))).rejects.toThrow();
 const other = x25519.getPublicKey(new Uint8Array(32).fill(7));
 await expect(openEnvelope(key, other, vector.seq, vector.sealed)).rejects.toThrow();
 await expect(openEnvelope(key, T, vector.seq, vector.sealed + "=")).rejects.toThrow("malformed");
});

const machine = { host_item_id: "H1", label: "dev2306", relay: "https://guest.herdrup.app", host_id: toB64url(new Uint8Array(16).fill(1)),
 node_pub: toB64url(new Uint8Array(32).fill(2)), grant_id: "g1", scope: "chat", expires_unix: 1_800_000_000 };
const plain = (e: object) => new TextEncoder().encode(JSON.stringify(e));
const list = (over: object = {}) => plain({ v: 1, seq: 9, issued_unix: 1_799_000_000, approver: "Jerry's Mac", machines: [machine],
 skipped: [{ host_item_id: "H2", label: "old-vps", reason: "needs_update", version: "0.8.3" }], ...over });

test("the machine list is taken only in the shape the approver seals, for the seq it was sealed with", () => {
 expect(parseEnvelope(list(), 9)).toEqual({ seq: 9, issuedUnix: 1_799_000_000, approver: "Jerry's Mac",
  machines: [{ hostItemID: "H1", label: "dev2306", relay: "https://guest.herdrup.app", hostID: machine.host_id, nodePub: machine.node_pub, grantID: "g1", scope: "chat", expiresUnix: 1_800_000_000 }],
  skipped: [{ hostItemID: "H2", label: "old-vps", reason: "needs_update", version: "0.8.3" }] });
 expect(() => parseEnvelope(list(), 8)).toThrow("seq");
 expect(() => parseEnvelope(list({ v: 2 }), 9)).toThrow("version");
 expect(() => parseEnvelope(list({ machines: [{ ...machine, node_pub: machine.node_pub + "A" }] }), 9)).toThrow("machine");
 expect(() => parseEnvelope(list({ machines: [{ ...machine, scope: "admin" }] }), 9)).toThrow("machine");
 expect(() => parseEnvelope(list({ skipped: [{ host_item_id: "H2", label: "x", reason: "because" }] }), 9)).toThrow("skipped");
 expect(() => parseEnvelope(new TextEncoder().encode("{"), 9)).toThrow("JSON");
});

test("the enrolment proof matches the Worker's vectors, with either key form; a low-order server key is refused", async () => {
 for (const c of enrolVectors.cases) {
  for (const [kind, key] of Object.entries(await keys(b(c.device_private)))) {
   expect(await enrolProof(key, { challenge_id: c.challenge_id, server_pub: c.server_pub, salt: c.salt, account_id: c.account_id }), `${c.name} ${kind}`)
    .toEqual({ devicePub: c.device_pub, mac: c.mac });
  }
 }
 const { raw: key } = await keys(b(enrolVectors.cases[0].device_private));
 const ch = enrolVectors.cases[0];
 await expect(enrolProof(key, { challenge_id: ch.challenge_id, server_pub: toB64url(new Uint8Array(32)), salt: ch.salt, account_id: ch.account_id })).rejects.toBeInstanceOf(BadChallengeError);
 await expect(enrolProof(key, { challenge_id: ch.challenge_id, server_pub: ch.server_pub + "=", salt: ch.salt, account_id: ch.account_id })).rejects.toBeInstanceOf(BadChallengeError);
});

test("base64url is strict: no padding, no + or /, no spare bits, and the length asked for", () => {
 expect(fromB64url("AQID")).toEqual(new Uint8Array([1, 2, 3]));
 expect(fromB64url("AQI")).toEqual(new Uint8Array([1, 2]));
 expect(fromB64url("AQI=")).toBeNull();
 expect(fromB64url("AQ+/")).toBeNull();
 expect(fromB64url("AQJ")).toBeNull();
 expect(fromB64url("AQID", 4)).toBeNull();
 expect(fromB64url(3)).toBeNull();
});
