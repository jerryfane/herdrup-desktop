// The browser's "Add to my account" (web/shares.ts, herdrup#858; herdr-app's condition, msg
// 561930): a share herdr bound to the account is written there in ONE request whose outcome is
// told as the service answered it. Added only when the service said it holds the share; refused
// when it said it didn't write it, or nothing went; unknown otherwise (a timeout, the network, a
// 5xx), worded "Added on this device; we'll finish adding it to your account". The grant stays on
// this browser whatever the outcome. The account's shares are not synced here (#543's second
// part): nothing reads them, retries the write or leaves a share on every device.
import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AccountServiceError, SignedOutError, WebAccount, type SyncChange } from "../src/web/account";
import { createGuestDesk } from "../src/web/desk";
import * as shares from "../src/web/shares";
import { ADD_UNKNOWN, addRefused, boundNotice, createShareAdder, type ShareAdd } from "../src/web/shares";
import { acceptInvite } from "../src/web/start";
import { MemoryGrantStore, MemoryOwnerHint } from "../src/web/storage";
import { accountShareNotice } from "../src/notices";
import { toB64url } from "../src/webguest/b64url";
import { MemoryIdentityStore } from "../src/webguest/identity";
import { APP_LINK_PREFIX } from "../src/webguest/invite";
import type { StatementSource } from "../src/webguest/accountStatement";
import type { Access } from "../src/webguest/transport";
import type { Access as PageAccess } from "../src/mygo";
import { CONNECTS_LIMIT_MS, startRelay, type HostSession, type TestRelay } from "./webguestResponder";

let relays: TestRelay[] = [];
afterEach(() => { for (const relay of relays) relay.stop(); relays = []; });

const TOKEN = `a1.${"s".repeat(22)}.${"1".padStart(43, "0")}`;
type Push = { changes: SyncChange[]; not_after?: number };
type SyncAnswer = (push: Push, signal: AbortSignal | undefined) => Response | Promise<Response>;

/** The account service as signed in to acct-1 (signedIn false: the cookie holds no session): a
 *  session bound to a device already (enrol is session_has_device), and POST /v1/sync answered by
 *  sync, each push it was sent recorded. */
function service(sync: SyncAnswer, signedIn = true) {
 const pushes: Push[] = [];
 const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/v1/auth/refresh")) return signedIn ? Response.json({ account_id: "acct-1", access_token: TOKEN, access_expires_in: 3600 }) : Response.json({ error: "session_revoked" }, { status: 401 });
  if (url.endsWith("/v1/devices/challenge")) return Response.json({ error: "session_has_device" }, { status: 409 });
  if (url.endsWith("/v1/sync") && init?.method === "POST") {
   const push = JSON.parse(String(init.body)) as Push;
   pushes.push(push);
   return await sync(push, init.signal ?? undefined);
  }
  return Response.json({ error: "not_found" }, { status: 404 });
 };
 return { pushes, account: new WebAccount(fetcher as unknown as typeof fetch, undefined, undefined, null) };
}

const item = (c: SyncChange, deleted: boolean) => ({ collection: c.collection, id: c.id, rev: 3, updated_ms: 0, deleted, body: deleted ? null : c.body });
/** The service's answers, by what it says of the one change sent. */
const answers = {
 applied: ((p: Push) => Response.json({ rev: 1, applied: p.changes.map(c => ({ collection: c.collection, id: c.id, rev: 1 })), conflicts: [] })) as SyncAnswer,
 heldLive: ((p: Push) => Response.json({ rev: 3, applied: [], conflicts: p.changes.map(c => ({ collection: c.collection, id: c.id, server: item(c, false) })) })) as SyncAnswer,
 tombstone: ((p: Push) => Response.json({ rev: 3, applied: [], conflicts: p.changes.map(c => ({ collection: c.collection, id: c.id, server: item(c, true) })) })) as SyncAnswer,
 silent: (() => Response.json({ rev: 1, applied: [], conflicts: [] })) as SyncAnswer,
 status: (status: number, error: string): SyncAnswer => () => Response.json({ error }, { status }),
 network: (() => { throw new TypeError("Failed to fetch"); }) as SyncAnswer,
 stalls: ((_p: Push, signal: AbortSignal | undefined) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))) as SyncAnswer,
};

const HOST_KEY = new Uint8Array(32).fill(7);
const bound = (account = "acct-1"): Access => ({
 guestID: "G1", guestName: "visitor", machineLabel: "Mac Studio", ownerName: "Ana", agentName: "docs", agentTarget: "%7",
 endpoint: { relay: "https://relay.example/", hostID: "HOST", hostPublicKey: HOST_KEY }, acceptedAt: new Date(0), accountBound: true, account,
});
/** The one push an add sends: one change, the grant's key, based on no item, its public fields. */
const ONE_WRITE: Push = { changes: [{ collection: "shares", id: "HOST/G1", base_rev: 0, body: { relay: "https://relay.example", host_id: "HOST", node_pub: toB64url(HOST_KEY), guest_id: "G1", agent_name: "docs", owner_name: "Ana", machine_label: "Mac Studio" } }] };

test("added only when the service says it holds the share: it applied the one write, or the account has it live", async () => {
 for (const answer of [answers.applied, answers.heldLive]) {
  const s = service(answer);
  expect(await createShareAdder(s.account, "Chrome on macOS").add(bound())).toEqual({ outcome: "added" });
  expect(s.pushes).toEqual([ONE_WRITE]);
 }
 expect(boundNotice("docs", { outcome: "added" })).toBe(accountShareNotice("docs"));
});

test("a refusal shows as one: a 4xx, the share deleted from the account, signed out or another sign-in (nothing sent)", async () => {
 const cases: [SyncAnswer, boolean, string, number][] = [
  [answers.status(400, "invalid_body"), true, "acct-1", 1],
  [answers.status(413, "too_large"), true, "acct-1", 1],
  [answers.tombstone, true, "acct-1", 1],
  [answers.applied, false, "acct-1", 0],
  [answers.applied, true, "acct-2", 0],
 ];
 for (const [answer, signedIn, account, sent] of cases) {
  const s = service(answer, signedIn);
  const added = await createShareAdder(s.account, "Chrome on macOS").add(bound(account));
  expect([added.outcome, s.pushes.length]).toEqual(["refused", sent]);
  const words = boundNotice("docs", added);
  expect(words.startsWith("Added on this device only. Your HerdrUp account didn't take it: ")).toBe(true);
 }
 expect(addRefused(new SignedOutError())).toBe("Added on this device only. Your HerdrUp account didn't take it: you're signed out of HerdrUp.");
 expect(addRefused(new AccountServiceError(409, "account_changed"))).toBe("Added on this device only. Your HerdrUp account didn't take it: this browser is now signed in to another HerdrUp account.");
});

test("an outcome no answer told is unknown, never added: a 5xx, the network, a timeout, an answer that doesn't name it; each sent once", async () => {
 for (const answer of [answers.status(500, "internal"), answers.status(503, ""), answers.network, answers.stalls, answers.silent]) {
  const s = service(answer);
  const added = await createShareAdder(s.account, "Chrome on macOS", { addMs: 50 }).add(bound());
  expect([added.outcome, s.pushes]).toEqual(["unknown", [ONE_WRITE]]);
  expect(boundNotice("docs", added)).toBe(ADD_UNKNOWN);
 }
 expect(ADD_UNKNOWN).toBe("Added on this device; we'll finish adding it to your account.");
});

test("the start says how the add went as the desk told it; an accept that told nothing is unknown, never added", async () => {
 const access: PageAccess = { guestID: "G1", guestName: "visitor", machineLabel: "Mac Studio", ownerName: "Ana", agentName: "docs", agentTarget: "%7", endpoint: { relay: "https://relay.example", hostID: "HOST", hostPublicKey: "" }, acceptedAt: "", accountBound: true };
 const desk = (added?: ShareAdd) => ({
  sharedConnections: async () => [], connectGuest: async () => {},
  acceptGuestInvitation: async () => added === undefined ? access : { ...access, added },
 });
 const refused: ShareAdd = { outcome: "refused", error: new AccountServiceError(400, "invalid_body") };
 for (const added of [{ outcome: "added" } as const, refused, { outcome: "unknown", error: new TypeError("Failed to fetch") } as const]) {
  expect(await acceptInvite(desk(added), "PAYLOAD", "https://guest.herdrup.app", "account")).toEqual({ kind: "connected", id: "HOST/G1", bound: { agentName: "docs", added } });
 }
 const untold = await acceptInvite(desk(), "PAYLOAD", "https://guest.herdrup.app", "account");
 expect(untold.kind === "connected" && untold.bound?.added.outcome).toBe("unknown");
 // Only this device: nothing about the account.
 expect(await acceptInvite(desk(), "PAYLOAD", "https://guest.herdrup.app", "device")).toEqual({ kind: "connected", id: "HOST/G1" });
});

/** herdr sharing one agent: a redemption with a statement is bound to it (a statement deadline). */
function host() {
 let next = 0;
 const relay = startRelay({
  async serve(_conn, handshake) {
   const h = await handshake();
   const statement = typeof h.hello.account === "string";
   const session: HostSession = h.reply({
    ok: true, guest_id: toB64url(new Uint8Array(16).fill(++next)), name: "visitor", machine_label: "Mac Studio", owner_name: "Ana", agent: { name: "docs", target: "%7" },
    features: { multi_request: true }, ...(statement ? { account: { deadline_unix: Math.floor(Date.now() / 1000) + 660 } } : {}),
   });
   await session.readLine();
  },
 });
 relays.push(relay);
 return relay;
}
function inviteText(relay: TestRelay): string {
 const bytes = (n: number, fill: number) => toB64url(new Uint8Array(n).fill(fill));
 const payload = { v: 1, relay: relay.url, host_id: relay.hostID, host_pub: toB64url(relay.hostPublic), invite_id: bytes(16, 3), secret: bytes(32, 4), machine_label: "Mac Studio", owner_name: "Ana", agent_name: "docs", guest_name: "visitor", expires_unix: Math.floor(Date.now() / 1000) + 3600, acct: 1 };
 return APP_LINK_PREFIX + toB64url(new TextEncoder().encode(JSON.stringify(payload)));
}
const statements: StatementSource = { get: async () => ({ jws: "statement-of-acct-1", expMs: Date.now() + 600_000, account: "acct-1", live: () => true }), drop() {} };

test("Add to my account keeps the grant on this browser, bound to the account, whatever the write's outcome; Only this device writes nothing", async () => {
 const cases: [SyncAnswer, ShareAdd["outcome"]][] = [[answers.applied, "added"], [answers.status(400, "invalid_body"), "refused"], [answers.status(503, ""), "unknown"], [answers.network, "unknown"]];
 for (const [answer, outcome] of cases) {
  const relay = host(), s = service(answer), grants = new MemoryGrantStore();
  const desk = createGuestDesk({ identities: new MemoryIdentityStore(), grants, owner: new MemoryOwnerHint(), webSocket: url => new WebSocket(url), statements, shares: createShareAdder(s.account, "Chrome on macOS") });
  const access = await desk.acceptGuestInvitation(inviteText(relay), "account");
  expect([access.added?.outcome, s.pushes.length]).toEqual([outcome, 1]);
  expect([grants.access?.guestID, grants.access?.accountBound, grants.access?.account]).toEqual([access.guestID, true, "acct-1"]);
 }
 const relay = host(), s = service(answers.applied), grants = new MemoryGrantStore();
 const desk = createGuestDesk({ identities: new MemoryIdentityStore(), grants, owner: new MemoryOwnerHint(), webSocket: url => new WebSocket(url), statements, shares: createShareAdder(s.account, "Chrome on macOS") });
 const plain = await desk.acceptGuestInvitation(inviteText(relay), "device");
 expect([plain.added, plain.accountBound, s.pushes.length, grants.access?.guestID]).toEqual([undefined, false, 0, plain.guestID]);
}, CONNECTS_LIMIT_MS);

test("the account's shares aren't synced in the browser: its Desk offers no synced list or open, shares.ts only the one write, and nothing calls a shares sync", async () => {
 const desk = createGuestDesk({ identities: new MemoryIdentityStore(), grants: new MemoryGrantStore(), owner: new MemoryOwnerHint() });
 expect(["syncedShares", "openSyncedShare"].filter(m => m in desk)).toEqual([]);
 expect(Object.keys(shares).sort()).toEqual(["ADD_MS", "ADD_UNKNOWN", "addRefused", "boundNotice", "createShareAdder", "shareBody"]);
 const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
 const mentions = sources(join(import.meta.dir, "../src/web")).filter(f => /createShareSync|ShareSync\b|syncedSharesChanged\.on|\b(syncedShares|openSyncedShare)\b/.test(readFileSync(f, "utf8")));
 expect(mentions).toEqual([]);
});
