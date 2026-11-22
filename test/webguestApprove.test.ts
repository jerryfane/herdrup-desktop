import { expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { approveCode, approveCommit, openEnvelope } from "../src/webguest/approve";
import { seal } from "./approveSeal";
import { fromB64url, toB64url } from "../src/webguest/b64url";
import { BadChallengeError, enrolProof } from "../src/webguest/enrol";
import { staticKey } from "../src/webguest/identity";
import type { StaticKey } from "../src/webguest/noise";
import vector from "../internal/account/testdata/approve-v1.json";
import listVector from "../internal/account/testdata/approve-v1-list.json";
import enrolVectors from "../internal/account/testdata/enrol-v1.json";

const b = (s: string) => { const v = fromB64url(s); if (v === null) throw new Error(`not b64url: ${s}`); return v; };

/** Both forms the browser keeps its key in: raw bytes, and a non-extractable WebCrypto key. */
async function keys(secret: Uint8Array): Promise<Record<string, StaticKey>> {
 const pkcs8 = new Uint8Array([...Buffer.from("302e020100300506032b656e04220420", "hex"), ...secret]);
 const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, ["deriveBits"]);
 const publicKey = x25519.getPublicKey(secret);
 return { raw: staticKey({ v: 1, kind: "raw", secret, publicKey }), webcrypto: staticKey({ v: 1, kind: "webcrypto", privateKey, publicKey }) };
}

test("approve-v1 matches AccountService's vector: commit and code", () => {
 const B = b(vector.browser_pub), T = b(vector.approver_pub), nB = b(vector.nonce_b), nT = b(vector.nonce_t);
 expect(toB64url(approveCommit(B, nB))).toBe(vector.commit);
 expect(approveCode(B, T, nB, nT)).toBe(vector.code);
});

test("a machine list sealed by another implementation opens to its list, with either key form", async () => {
 const T = b(listVector.approver_pub);
 const sent = JSON.parse(listVector.envelope_json);
 for (const [kind, key] of Object.entries(await keys(b(listVector.browser_priv)))) {
  expect(toB64url(key.publicKey), kind).toBe(listVector.browser_pub);
  const list = await openEnvelope(key, T, listVector.seq, listVector.sealed);
  expect(list.machines.map(m => [m.label, m.hostID, m.nodePub, m.grantID, m.scope, m.expiresUnix]), kind)
   .toEqual(sent.machines.map((m: Record<string, unknown>) => [m.label, m.host_id, m.node_pub, m.grant_id, m.scope, m.expires_unix]));
  expect(list.skipped, kind).toEqual([{ hostItemID: sent.skipped[0].host_item_id, label: "old-vps", reason: "needs_update", version: "0.8.3" }]);
  expect([list.seq, list.approver], kind).toEqual([listVector.seq, "Jerry's MacBook"]);
 }
});

test("an envelope opens only for the seq, approver and bytes it was sealed with", async () => {
 const { raw: key } = await keys(b(listVector.browser_priv));
 const T = b(listVector.approver_pub);
 await expect(openEnvelope(key, T, listVector.seq + 1, listVector.sealed)).rejects.toThrow();
 const flipped = b(listVector.sealed); flipped[20] ^= 1;
 await expect(openEnvelope(key, T, listVector.seq, toB64url(flipped))).rejects.toThrow();
 const other = x25519.getPublicKey(new Uint8Array(32).fill(7));
 await expect(openEnvelope(key, other, listVector.seq, listVector.sealed)).rejects.toThrow();
 await expect(openEnvelope(key, T, listVector.seq, listVector.sealed + "=")).rejects.toThrow("malformed");
});

const machine = { host_item_id: "H1", label: "dev2306", relay: "https://guest.herdrup.app", host_id: toB64url(new Uint8Array(16).fill(1)),
 node_pub: toB64url(new Uint8Array(32).fill(2)), grant_id: "g1", scope: "chat", expires_unix: 1_800_000_000 };
const list = (over: object = {}) => ({ v: 1, seq: 9, issued_unix: 1_799_000_000, approver: "Jerry's Mac", machines: [machine],
 skipped: [{ host_item_id: "H2", label: "old-vps", reason: "needs_update", version: "0.8.3" }], ...over });

test("the machine list is taken only in the shape the approver seals, for the seq it was sealed with", async () => {
 const t = new Uint8Array(32).fill(8), T = x25519.getPublicKey(t);
 const { raw: key } = await keys(new Uint8Array(32).fill(6));
 const open = (json: object, sealedAt = 9, openAt = sealedAt) => openEnvelope(key, T, openAt, seal(t, key.publicKey, sealedAt, json));
 expect(await open(list())).toEqual({ seq: 9, issuedUnix: 1_799_000_000, approver: "Jerry's Mac",
  machines: [{ hostItemID: "H1", label: "dev2306", relay: "https://guest.herdrup.app", hostID: machine.host_id, nodePub: machine.node_pub, grantID: "g1", scope: "chat", expiresUnix: 1_800_000_000 }],
  skipped: [{ hostItemID: "H2", label: "old-vps", reason: "needs_update", version: "0.8.3" }] });
 // Sealed at 8 with seq 9 inside: it opens at 8, and the list says another seq.
 await expect(open(list(), 8)).rejects.toThrow("seq");
 await expect(open(list({ v: 2 }))).rejects.toThrow("version");
 await expect(open(list({ machines: [{ ...machine, node_pub: machine.node_pub + "A" }] }))).rejects.toThrow("machine");
 await expect(open(list({ machines: [{ ...machine, scope: "admin" }] }))).rejects.toThrow("machine");
 await expect(open(list({ skipped: [{ host_item_id: "H2", label: "x", reason: "because" }] }))).rejects.toThrow("skipped");
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
