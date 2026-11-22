// The browser's half of approve-v1 (src/web/ownerApproval.ts) against a fake account service
// that plays the approving device too: it claims with its own key, checks the reveal against the
// commit, types the code it computes, and seals the machine list as internal/account/approve.go
// does (the sealing here mirrors SealEnvelope; test/webguestApprove.test.ts pins the opening).
import { expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { approveCode, approveCommit } from "../src/webguest/approve";
import { seal } from "./approveSeal";
import { fromB64url, toB64url } from "../src/webguest/b64url";
import { MemoryIdentityStore } from "../src/webguest/identity";
import { AccountServiceError, type ApprovalStatus, type BrowserSelf } from "../src/web/account";
import { refreshLists, runApproval, type OwnerPhase } from "../src/web/ownerApproval";
import { MemoryOwnerStore } from "../src/web/ownerStore";



const hostID = toB64url(new Uint8Array(16).fill(1));
const list = (seq: number, label = "dev2306") => ({ v: 1, seq, issued_unix: 1_799_000_000, approver: "Jerry's Mac", skipped: [],
 machines: [{ host_item_id: "H1", label, relay: "https://guest.herdrup.app", host_id: hostID, node_pub: toB64url(new Uint8Array(32).fill(2)), grant_id: "g1", scope: "chat", expires_unix: 1_800_000_000 }] });

/** A webcrypto identity, as owner access requires. */
async function webcryptoIdentities() {
 const pair = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]) as CryptoKeyPair;
 const store = new MemoryIdentityStore();
 store.record = { v: 1, kind: "webcrypto", privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
 return store;
}

interface World {
 t: Uint8Array; T: Uint8Array;
 /** Polls of the state before the approver claims, and after the code until it approves. */
 claimAfter: number; approveAfter: number;
 outcome: "approved" | "denied" | "expired";
 /** What the service hands back as the sealed list (an attacker could swap it). */
 envelope?: (B: Uint8Array) => { approver_pub: string; seq: number; sealed: string };
 enrolError?: AccountServiceError;
 calls: string[];
 /** The account each call was bound to. */
 accounts: (string | undefined)[];
 typed?: string;
}

function service(w: World) {
 let commit = "", B = new Uint8Array(), nonceT = new Uint8Array(32).fill(4), nonceB: Uint8Array | null = null, polls = 0, approvedAt = -1;
 const account = {
  async currentAccount() { return "acct-1"; },
  async enrol(key: { publicKey: Uint8Array }, _name: string, acct?: string) { w.accounts.push(acct); w.calls.push("enrol"); B = key.publicKey; if (w.enrolError) throw w.enrolError; return { id: "dev-b", name: "", platform: "web", device_pub: toB64url(B), created_ms: 1 }; },
  async requestApproval(c: Uint8Array, acct?: string) { w.accounts.push(acct); w.calls.push("request"); commit = toB64url(c); return { id: "req-1", expires_in: 600 }; },
  async approvalState(_id: string, acct?: string): Promise<ApprovalStatus> {
   w.accounts.push(acct);
   polls++;
   if (polls <= w.claimAfter) return { state: "waiting", expires_in: 600 };
   if (nonceB === null) return { state: "claimed", expires_in: 600, approver: { device_pub: toB64url(w.T), name: "Jerry's Mac" }, nonce_t: toB64url(nonceT) };
   if (approvedAt < 0) {
    // The approving device: the reveal must open the commit it saw, then the person types the code.
    if (toB64url(approveCommit(B, nonceB)) !== commit) throw new Error("tampered reveal");
    w.typed = approveCode(B, w.T, nonceB, nonceT);
    approvedAt = polls;
   }
   if (polls - approvedAt < w.approveAfter) return { state: "revealed", expires_in: 600 };
   return { state: w.outcome, expires_in: 0 };
  },
  async reveal(_id: string, n: Uint8Array, acct?: string) { w.accounts.push(acct); w.calls.push("reveal"); nonceB = n; },
  async browserSelf(acct?: string): Promise<BrowserSelf> {
   w.accounts.push(acct);
   w.calls.push("self");
   const e = w.envelope ? w.envelope(B) : { approver_pub: toB64url(w.T), seq: 7, sealed: seal(w.t, B, 7, list(7)) };
   return { access: { state: "approved" }, envelopes: [e] };
  },
 };
 return account;
}

function world(over: Partial<World> = {}): World {
 const t = new Uint8Array(32).fill(8);
 return { t, T: x25519.getPublicKey(t), claimAfter: 2, approveAfter: 1, outcome: "approved", calls: [], accounts: [], ...over };
}

async function run(w: World, identities?: MemoryIdentityStore) {
 const phases: OwnerPhase[] = [];
 const store = new MemoryOwnerStore();
 await runApproval({ account: service(w), identities: identities ?? await webcryptoIdentities(), store, deviceName: "Chrome on macOS",
  sleep: async () => {}, now: () => 0, locks: null }, p => phases.push(p), new AbortController().signal);
 return { phases, store };
}

test("the browser shows no code until a device claims, reveals only then, and keeps the list sealed by the device the code covered", async () => {
 const w = world();
 const { phases, store } = await run(w);
 expect(phases.map(p => p.kind)).toEqual(["starting", "waiting", "code", "approved"]);
 const code = phases.find(p => p.kind === "code") as Extract<OwnerPhase, { kind: "code" }>;
 expect(code.code).toBe(w.typed!);
 expect(w.calls).toEqual(["enrol", "request", "reveal", "self"]);
 expect(new Set(w.accounts)).toEqual(new Set(["acct-1"]));
 expect(store.record?.approvers).toEqual([{ pub: toB64url(w.T), name: "Jerry's Mac", envelope: expect.objectContaining({ seq: 7, machines: [expect.objectContaining({ label: "dev2306", hostID })] }) }]);
});

test("a list sealed by another key than the device the code covered is never kept", async () => {
 const other = new Uint8Array(32).fill(9);
 const w = world({ envelope: B => ({ approver_pub: toB64url(world().T), seq: 7, sealed: seal(other, B, 7, list(7, "evil")) }) });
 const { phases, store } = await run(w);
 expect(phases.at(-1)?.kind).toBe("failed");
 expect(store.record).toBeUndefined();
});

test("a denial and an expiry end the wait; a request the service no longer has is expired", async () => {
 expect((await run(world({ outcome: "denied" }))).phases.at(-1)).toEqual({ kind: "denied" });
 expect((await run(world({ outcome: "expired" }))).phases.at(-1)).toEqual({ kind: "expired" });
 const gone = world();
 const account = service(gone);
 account.approvalState = async () => { throw new AccountServiceError(404, "not_found"); };
 const phases: OwnerPhase[] = [];
 await runApproval({ account, identities: await webcryptoIdentities(), store: new MemoryOwnerStore(), deviceName: "x", sleep: async () => {}, now: () => 0, locks: null },
  p => phases.push(p), new AbortController().signal);
 expect(phases.at(-1)).toEqual({ kind: "expired" });
});

test("a key page scripts could read is never offered for approval; an existing device binding is fine", async () => {
 const raw = new MemoryIdentityStore();
 const secret = new Uint8Array(32).fill(3);
 raw.record = { v: 1, kind: "raw", secret, publicKey: x25519.getPublicKey(secret) };
 const w = world();
 expect((await run(w, raw)).phases).toEqual([{ kind: "unsupported" }]);
 expect(w.calls).toEqual([]);
 const bound = world({ enrolError: new AccountServiceError(409, "session_has_device") });
 expect((await run(bound)).phases.at(-1)?.kind).toBe("approved");
 expect((await run(world({ enrolError: new AccountServiceError(409, "device_in_other_account") }))).phases.at(-1)?.kind).toBe("failed");
});

test("later loads take a newer list only from a verified approver; older, foreign or unopenable ones are left out", async () => {
 const w = world();
 const identities = await webcryptoIdentities();
 const { store } = await run(w, identities);
 const { staticKey } = await import("../src/webguest/identity");
 const key = staticKey(identities.record!);
 const B = key.publicKey;
 const stranger = new Uint8Array(32).fill(11);
 const offer = (envelopes: BrowserSelf["envelopes"]) => ({ browserSelf: async () => ({ envelopes }) });
 await refreshLists(offer([{ approver_pub: toB64url(w.T), seq: 6, sealed: seal(w.t, B, 6, list(6, "older")) }]), key, store);
 await refreshLists(offer([{ approver_pub: toB64url(x25519.getPublicKey(stranger)), seq: 50, sealed: seal(stranger, B, 50, list(50, "stranger")) }]), key, store);
 await refreshLists(offer([{ approver_pub: toB64url(w.T), seq: 9, sealed: seal(stranger, B, 9, list(9, "forged")) }]), key, store);
 expect(store.record!.approvers.map(a => [a.envelope.seq, a.envelope.machines[0]!.label])).toEqual([[7, "dev2306"]]);
 await refreshLists(offer([{ approver_pub: toB64url(w.T), seq: 8, sealed: seal(w.t, B, 8, list(8, "renamed")) }]), key, store);
 expect(store.record!.approvers.map(a => [a.envelope.seq, a.envelope.machines[0]!.label])).toEqual([[8, "renamed"]]);
 expect(fromB64url(store.record!.approvers[0]!.pub)).toEqual(w.T);
});

test("the browser's device name says which browser on which system, and falls back plainly", async () => {
 const { browserDeviceName } = await import("../src/web/ownerScreen");
 expect(browserDeviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")).toBe("Chrome on macOS");
 expect(browserDeviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0")).toBe("Edge on Windows");
 expect(browserDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
 expect(browserDeviceName("Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0")).toBe("Firefox on Linux");
 expect(browserDeviceName("")).toBe("Web browser");
});

test("the approved machines: each machine once, with its latest grant; a machine skipped by one approver but granted by another is listed as granted", async () => {
 const { approvedMachines } = await import("../src/web/ownerScreen");
 const m = (label: string, expiresUnix: number, hostItemID = "H1") => ({ hostItemID, label, relay: "https://guest.herdrup.app", hostID: hostID, nodePub: "n", grantID: "g", scope: "chat" as const, expiresUnix });
 const env = (seq: number, machines: ReturnType<typeof m>[], skipped: { hostItemID: string; label: string; reason: "needs_update" }[] = []) => ({ seq, issuedUnix: 1, approver: "x", machines, skipped });
 const out = approvedMachines({ v: 1, approvers: [
  { pub: "A", name: "Mac", envelope: env(1, [m("dev2306", 100)], [{ hostItemID: "H9", label: "nas", reason: "needs_update" }]) },
  { pub: "B", name: "iPhone", envelope: env(2, [m("dev2306", 200)], [{ hostItemID: "H1", label: "dev2306", reason: "needs_update" }]) },
 ] });
 expect(out.machines.map(x => [x.label, x.expiresUnix])).toEqual([["dev2306", 200]]);
 expect(out.skipped.map(x => x.label)).toEqual(["nas"]);
});
