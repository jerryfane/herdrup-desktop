// The browser's "Add to my account" (web/shares.ts, herdrup#858; herdr-app's condition, msg
// 561930): a share herdr bound to the account is written there in ONE request whose outcome is
// told as the service answered it. Added only when the service said it holds the share; refused
// when it said it didn't write it, or nothing went; unknown otherwise (a timeout, the network, a
// 5xx), worded "Added on this device; we'll finish adding it to your account". The grant stays on
// this browser whatever the outcome. The account's shares are not synced here (#543's second
// part): nothing reads them, retries the write or leaves a share on every device.
import { afterEach, expect, test } from "bun:test";
import { AccountServiceError, SignedOutError, WebAccount, type SyncChange } from "../src/web/account";
import { createGuestDesk } from "../src/web/desk";
import { ADD_UNKNOWN, addRefused, boundNotice, createShareAdder, type ShareAdd } from "../src/web/shares";
import { grantKey } from "../src/grantKey";
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
 *  sync, each push it was sent recorded, every request's path in order (requests). The page's
 *  clock is now(). */
function service(sync: SyncAnswer, signedIn = true, now = Date.now) {
 const pushes: Push[] = [], requests: string[] = [];
 const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  requests.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
  if (url.endsWith("/v1/auth/refresh")) return signedIn ? Response.json({ account_id: "acct-1", access_token: TOKEN, access_expires_in: 3600 }) : Response.json({ error: "session_revoked" }, { status: 401 });
  if (url.endsWith("/v1/devices/challenge")) return Response.json({ error: "session_has_device" }, { status: 409 });
  if (url.endsWith("/v1/sync") && init?.method === "POST") {
   const push = JSON.parse(String(init.body)) as Push;
   pushes.push(push);
   return await sync(push, init.signal ?? undefined);
  }
  return Response.json({ error: "not_found" }, { status: 404 });
 };
 return { pushes, requests, account: new WebAccount(fetcher as unknown as typeof fetch, undefined, now, null) };
}

const item = (c: SyncChange, deleted: boolean) => ({ collection: c.collection, id: c.id, rev: 3, updated_ms: 0, deleted, body: deleted ? null : c.body });
/** The service's answers, by what it says of the one change sent, shaped as AccountService
 *  src/sync.ts handlePush writes them ({rev, applied, conflicts, now_ms}). */
const answers = {
 applied: ((p: Push) => Response.json({ rev: 1, applied: p.changes.map(c => ({ collection: c.collection, id: c.id, rev: 1 })), conflicts: [], now_ms: 1_000 })) as SyncAnswer,
 heldLive: ((p: Push) => Response.json({ rev: 3, applied: [], conflicts: p.changes.map(c => ({ collection: c.collection, id: c.id, server: item(c, false) })), now_ms: 1_000 })) as SyncAnswer,
 tombstone: ((p: Push) => Response.json({ rev: 3, applied: [], conflicts: p.changes.map(c => ({ collection: c.collection, id: c.id, server: item(c, true) })), now_ms: 1_000 })) as SyncAnswer,
 silent: (() => Response.json({ rev: 1, applied: [], conflicts: [], now_ms: 1_000 })) as SyncAnswer,
 status: (status: number, error: string): SyncAnswer => () => Response.json({ error }, { status }),
 network: (() => { throw new TypeError("Failed to fetch"); }) as SyncAnswer,
 stalls: ((_p: Push, signal: AbortSignal | undefined) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))) as SyncAnswer,
 /** The status line, then a body that never ends. */
 stalledBody: (status: number): SyncAnswer => () => new Response(new ReadableStream({ start() {} }), { status, headers: { "Content-Type": "application/json" } }),
 /** A 200 whose body is JSON but not the success envelope. */
 malformed: (body: unknown): SyncAnswer => () => Response.json(body),
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

test("one POST, a 401 included: the 401 is a refusal (the sign-in expired), never a second POST; a token near expiry is refreshed before it", async () => {
 const s = service(answers.status(401, "invalid_token"));
 const added = await createShareAdder(s.account, "Chrome on macOS").add(bound());
 expect([added.outcome, s.requests]).toEqual(["refused", ["POST /v1/auth/refresh", "POST /v1/sync"]]);
 expect(boundNotice("docs", added)).toBe("Added on this device only. Your HerdrUp account didn't take it: your sign-in expired.");
 // The token (an hour) held until a minute before its end: past that, a refresh goes first.
 let clock = 1_000_000;
 const later = service(answers.applied, true, () => clock);
 await later.account.check();
 clock += 3_600_000 - 30_000;
 expect(await createShareAdder(later.account, "Chrome on macOS").add(bound())).toEqual({ outcome: "added" });
 expect(later.requests).toEqual(["POST /v1/auth/refresh", "POST /v1/auth/refresh", "POST /v1/sync"]);
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

test("an error status is the refusal once its status line is in: a body that stalls until the deadline doesn't make it unknown", async () => {
 for (const status of [403, 409, 401]) {
  const s = service(answers.stalledBody(status));
  const added = await createShareAdder(s.account, "Chrome on macOS", { addMs: 50 }).add(bound());
  expect([added.outcome, (added as { error?: AccountServiceError }).error?.status, s.pushes.length]).toEqual(["refused", status, 1]);
 }
 // A 2xx whose body stalls told nothing yet: unknown.
 const s = service(answers.stalledBody(200));
 expect((await createShareAdder(s.account, "Chrome on macOS", { addMs: 50 }).add(bound())).outcome).toBe("unknown");
});

test("a 2xx that isn't the success envelope tells no outcome: unknown, never an error or added", async () => {
 const named = { collection: "shares", id: "HOST/G1" };
 for (const body of [null, [], { rev: 1, now_ms: 1 }, { rev: 1, applied: "HOST/G1", conflicts: [], now_ms: 1 }, { rev: 1, applied: [named], conflicts: null, now_ms: 1 }, { rev: 1, applied: [null], conflicts: [], now_ms: 1 },
  { rev: 1, applied: [{ id: "HOST/G1", rev: 1 }], conflicts: [], now_ms: 1 }, { rev: 1, applied: [], conflicts: [{ ...named, server: {} }], now_ms: 1 }, { rev: 1, applied: [], conflicts: [{ ...named }], now_ms: 1 }]) {
  const s = service(answers.malformed(body));
  const added = await createShareAdder(s.account, "Chrome on macOS").add(bound());
  expect([JSON.stringify(body), added.outcome, s.pushes.length]).toEqual([JSON.stringify(body), "unknown", 1]);
 }
});

test("a 2xx confirms the add only as the service writes it: a matching entry in a reply with any required field missing or mistyped is unknown", async () => {
 type Reply = Record<string, unknown> & { applied: Record<string, unknown>[]; conflicts: Record<string, unknown>[] };
 const applied = (p: Push): Reply => ({ rev: 4, applied: p.changes.map(c => ({ collection: c.collection, id: c.id, rev: 4 })), conflicts: [], now_ms: 1_000 });
 const held = (p: Push): Reply => ({ rev: 4, applied: [], conflicts: p.changes.map(c => ({ collection: c.collection, id: c.id, server: item(c, false) })), now_ms: 1_000 });
 const without = (o: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
 const outcome = async (reply: (p: Push) => unknown) => {
  const s = service(p => Response.json(reply(p)));
  const added = await createShareAdder(s.account, "Chrome on macOS").add(bound());
  return [added.outcome, s.pushes.length];
 };
 // As the service writes them: added.
 expect([await outcome(applied), await outcome(held)]).toEqual([["added", 1], ["added", 1]]);
 const broken: [string, (p: Push) => unknown][] = [
  // The review's probe: a matching applied entry, no revision on the envelope or the entry.
  ["no revision anywhere", p => without({ ...applied(p), applied: applied(p).applied.map(a => without(a, "rev")) }, "rev")],
  ...["rev", "applied", "conflicts", "now_ms"].map((k): [string, (p: Push) => unknown] => [`no envelope ${k}`, p => without(applied(p), k)]),
  ...["collection", "id", "rev"].map((k): [string, (p: Push) => unknown] => [`applied entry without ${k}`, p => ({ ...applied(p), applied: applied(p).applied.map(a => without(a, k)) })]),
  ...([["rev", "4"], ["rev", -1], ["rev", 1.5], ["rev", null], ["now_ms", "1000"], ["now_ms", null]] as const)
   .map(([k, v]): [string, (p: Push) => unknown] => [`envelope ${k} ${JSON.stringify(v)}`, p => ({ ...applied(p), [k]: v })]),
  ...([["rev", "4"], ["rev", -1], ["rev", Number.MAX_VALUE], ["id", 7], ["collection", null]] as const)
   .map(([k, v]): [string, (p: Push) => unknown] => [`applied entry ${k} ${JSON.stringify(v)}`, p => ({ ...applied(p), applied: applied(p).applied.map(a => ({ ...a, [k]: v })) })]),
  ...["collection", "id", "rev", "updated_ms", "deleted", "body"].map((k): [string, (p: Push) => unknown] =>
   [`conflict's server without ${k}`, p => ({ ...held(p), conflicts: held(p).conflicts.map(c => ({ ...c, server: without(c.server as Record<string, unknown>, k) })) })]),
  ...([["rev", "3"], ["updated_ms", "0"], ["deleted", 0]] as const).map(([k, v]): [string, (p: Push) => unknown] =>
   [`conflict's server ${k} ${JSON.stringify(v)}`, p => ({ ...held(p), conflicts: held(p).conflicts.map(c => ({ ...c, server: { ...(c.server as object), [k]: v } })) })]),
  ["conflict without server", p => ({ ...held(p), conflicts: held(p).conflicts.map(c => without(c, "server")) })],
 ];
 for (const [what, reply] of broken) expect([what, ...await outcome(reply)]).toEqual([what, "unknown", 1]);
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
 const cases: [SyncAnswer, ShareAdd["outcome"]][] = [[answers.applied, "added"], [answers.status(400, "invalid_body"), "refused"], [answers.status(503, ""), "unknown"], [answers.network, "unknown"],
  [answers.malformed({ rev: 1 }), "unknown"]];
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

test("the account's shares aren't synced in the browser: an add asks the service once and reads nothing back; the grant stays here, and Leave forgets it here only", async () => {
 const relay = host(), s = service(answers.applied), grants = new MemoryGrantStore();
 const desk = createGuestDesk({ identities: new MemoryIdentityStore(), grants, owner: new MemoryOwnerHint(), webSocket: url => new WebSocket(url), statements, shares: createShareAdder(s.account, "Chrome on macOS") });
 const accountCalls = () => s.requests.filter(r => r !== "POST /v1/auth/refresh");
 const access = await desk.acceptGuestInvitation(inviteText(relay), "account");
 // This browser joins the account's devices (bound already here), then the one write; no pull.
 expect([access.added?.outcome, accountCalls()]).toEqual(["added", ["POST /v1/devices/challenge", "POST /v1/sync"]]);
 expect((await desk.sharedConnections()).map(grantKey)).toEqual([grantKey(access)]);
 expect(["syncedShares", "openSyncedShare"].filter(m => m in desk)).toEqual([]);
 // Leave: the grant goes from this browser; the account hears nothing (no delete pushed).
 await desk.forgetGuestConnection(grantKey(access));
 expect([grants.access, await desk.sharedConnections(), accountCalls().length]).toEqual([undefined, [], 2]);
}, CONNECTS_LIMIT_MS);
