// The browser's "Add to my account" (web/shares.ts ShareSync.add, herdrup#858; herdr-app's
// condition, msg 561930): a share herdr bound to the account is kept for it and written in a round
// of the share sync, and how that went is told as the service answered it. Added only when the
// account holds the share; refused only when nothing of it is left to send (the service refused it
// alone, or holds it deleted; or this browser couldn't keep it); unknown otherwise (a timeout, the
// network, a 5xx, an answer that names no outcome, signed out or another sign-in here), worded
// "Added on this device; we'll finish adding it to your account": the write stays queued or
// journaled for the sync. The grant stays on this browser whatever the outcome. Against the fake
// account service (webAccountService.ts).
import { afterEach, expect, test } from "bun:test";
import { AccountServiceError, SignedOutError, WebAccount } from "../src/web/account";
import { createGuestDesk } from "../src/web/desk";
import { ADD_UNKNOWN, addRefused, boundNotice, createShareSync, SHARES_KEY_PREFIX, type ShareAdd } from "../src/web/shares";
import { acceptInvite } from "../src/web/start";
import { MemoryGrantStore, MemoryOwnerHint } from "../src/web/storage";
import { accountShareNotice } from "../src/notices";
import { toB64url } from "../src/webguest/b64url";
import { MemoryIdentityStore } from "../src/webguest/identity";
import { APP_LINK_PREFIX } from "../src/webguest/invite";
import type { StatementSource } from "../src/webguest/accountStatement";
import type { Access } from "../src/webguest/transport";
import type { Access as PageAccess } from "../src/mygo";
import type { AbortableLocks } from "../src/web/locks";
import { memory, worker, type Worker } from "./webAccountService";
import { CONNECTS_LIMIT_MS, startRelay, type HostSession, type TestRelay } from "./webguestResponder";

let relays: TestRelay[] = [];
afterEach(() => { for (const relay of relays) relay.stop(); relays = []; });

/** Web Locks for one tab: one holder per name, the others in order. */
function serial(): AbortableLocks {
 const tails = new Map<string, Promise<unknown>>();
 const request = <T>(name: string, ...args: [() => Promise<T>] | [{ signal?: AbortSignal }, () => Promise<T>]): Promise<T> => {
  const callback = args.length === 1 ? args[0] : args[1];
  const turn = (tails.get(name) ?? Promise.resolve()).then(callback);
  tails.set(name, turn.catch(() => {}));
  return turn;
 };
 return { request } as AbortableLocks;
}

const statements: StatementSource = { get: async () => ({ jws: "statement-of-acct", expMs: Date.now() + 600_000, account: "acct", live: () => true }), drop() {} };

type Answer = Record<string, unknown> & { applied: Record<string, unknown>[]; conflicts: Record<string, unknown>[] };
let sessions = 0;
/** One browser signed in to the fake service's account "acct" (signedIn false: its cookie holds no
 *  session), its share sync and guest Desk. cut.network makes the next POST /v1/sync fail as the
 *  network does (nothing sent); cut.answer rewrites the next one's 2xx answer, as the service
 *  applied it. addMs, roundMs: the share sync's own (shares.ts ADD_MS, ROUND_MS). */
async function browser(w: Worker, options: { signedIn?: boolean; addMs?: number; roundMs?: number } = {}) {
 const cut = { network: false, answer: null as ((answer: Answer) => unknown) | null };
 const base = w.fetcher(`add${++sessions}`);
 const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (options.signedIn === false && url.includes("/v1/auth/refresh")) return Response.json({ error: "session_revoked" }, { status: 401 });
  if (url.includes("/v1/sync") && init?.method === "POST") {
   if (cut.network) { cut.network = false; throw new TypeError("Failed to fetch"); }
   const rewrite = cut.answer; cut.answer = null;
   const response = await base(input, init);
   return rewrite !== null && response.ok ? Response.json(rewrite(await response.json() as Answer)) : response;
  }
  return base(input, init);
 }) as typeof fetch;
 const account = new WebAccount(fetcher, undefined, undefined, null);
 if (options.signedIn !== false) await account.check();
 const storage = memory(), grants = new MemoryGrantStore();
 const shares = createShareSync(account, {
  storage: () => storage, locks: serial(), name: "Chrome on macOS", background: false,
  ...(options.addMs === undefined ? {} : { addMs: options.addMs }), ...(options.roundMs === undefined ? {} : { roundMs: options.roundMs }),
 });
 const desk = createGuestDesk({ identities: new MemoryIdentityStore(), grants, owner: new MemoryOwnerHint(), webSocket: url => new WebSocket(url), statements, shares });
 return { account, shares, storage, grants, desk, cut };
}

const HOST_KEY = new Uint8Array(32).fill(7);
const bound = (account = "acct"): Access => ({
 guestID: "G1", guestName: "visitor", machineLabel: "Mac Studio", ownerName: "Ana", agentName: "docs", agentTarget: "%7",
 endpoint: { relay: "https://relay.example/", hostID: "HOST", hostPublicKey: HOST_KEY }, acceptedAt: new Date(0), accountBound: true, account,
});
const BODY = { relay: "https://relay.example", host_id: "HOST", node_pub: toB64url(HOST_KEY), guest_id: "G1", agent_name: "docs", owner_name: "Ana", machine_label: "Mac Studio" };
/** The same share as another device wrote it (its machine named otherwise): a put of BODY conflicts. */
const THEIRS = { ...BODY, machine_label: "Studio" };
/** The write an add sends: the grant's key, based on no item, its public fields. */
const ONE_WRITE = { collection: "shares", id: "HOST/G1", base_rev: 0, body: BODY };
/** Whether the add's write is still queued or journaled in the browser's record. */
const owed = (storage: Pick<Storage, "getItem">) => {
 const r = JSON.parse(storage.getItem(SHARES_KEY_PREFIX + "acct") ?? "{}") as { pending?: { id: string }[]; sent?: { id: string }[] };
 return [...r.pending ?? [], ...r.sent ?? []].some(p => p.id === "HOST/G1");
};

test("added only when the service says it holds the share: it applied the write, or the account has it live", async () => {
 for (const live of [false, true]) {
  const w = worker(), b = await browser(w);
  // Another device's put of the same share lands first: the service answers with its item.
  if (live) w.onPush = () => w.seedShare("HOST/G1", THEIRS);
  expect(await b.shares.add(bound())).toEqual({ outcome: "added" });
  expect([w.pushed, owed(b.storage)]).toEqual([[[ONE_WRITE]], false]);
 }
 expect(boundNotice("docs", { outcome: "added" })).toBe(accountShareNotice("docs"));
});

test("a 401 is sent again with a fresh token: the add then tells the service's answer", async () => {
 const w = worker(), b = await browser(w);
 w.pushUnauthorized = true;
 expect(await b.shares.add(bound())).toEqual({ outcome: "added" });
 expect([w.pushed, w.sharesIn("acct")]).toEqual([[[ONE_WRITE], [ONE_WRITE]], ["HOST/G1"]]);
});

test("a refusal shows as one, the write gone: refused alone (a 400), the share deleted from the account, or storage that can't keep it", async () => {
 const cases: [(w: Worker, b: Awaited<ReturnType<typeof browser>>) => void, number, (error: unknown) => boolean][] = [
  [w => { w.refuseNextPush = [400, "invalid_body"]; }, 1, e => e instanceof AccountServiceError && e.status === 400],
  [w => { w.onPush = () => w.seedTombstone("HOST/G1", "shares"); }, 1, e => e instanceof Error && e.message === "this shared access was removed from your account"],
  [(_w, b) => { b.storage.refuses = () => true; }, 0, e => e instanceof DOMException && e.name === "QuotaExceededError"],
 ];
 for (const [arrange, sent, why] of cases) {
  const w = worker(), b = await browser(w);
  arrange(w, b);
  const added = await b.shares.add(bound());
  b.storage.refuses = null;
  expect([added.outcome, w.pushed.length, owed(b.storage), added.outcome === "refused" && why(added.error)]).toEqual(["refused", sent, false, true]);
  expect(boundNotice("docs", added).startsWith("Added on this device only. Your HerdrUp account didn't take it: ")).toBe(true);
 }
 expect(addRefused(new Error("this shared access was removed from your account"))).toBe("Added on this device only. Your HerdrUp account didn't take it: this shared access was removed from your account.");
});

test("an outcome no answer told is unknown, never added, the write kept for the sync: a 5xx, the network, a timeout, a 4xx of the whole push, an answer that doesn't name it, signed out or another sign-in", async () => {
 const cases: [string, (w: Worker, b: Awaited<ReturnType<typeof browser>>) => void, { signedIn?: boolean; account?: string }, number][] = [
  ["5xx", w => { w.failPush = true; }, {}, 1],
  // The request never reaches the service.
  ["network", (_w, b) => { b.cut.network = true; }, {}, 0],
  ["timeout", w => { w.holdNextPush = true; }, {}, 1],
  ["429", w => { w.rateLimit = 1; w.windowPosts = 1; }, {}, 1],
  ["silent", (_w, b) => { b.cut.answer = a => ({ ...a, applied: [], conflicts: [] }); }, {}, 1],
  ["signed out", () => {}, { signedIn: false }, 0],
  ["another sign-in", () => {}, { account: "acct-2" }, 0],
 ];
 for (const [what, arrange, where, sent] of cases) {
  const w = worker(), b = await browser(w, { addMs: 2_000, roundMs: 500, ...(where.signedIn === undefined ? {} : { signedIn: where.signedIn }) });
  arrange(w, b);
  const added = await b.shares.add(bound(where.account));
  w.failPush = false;
  const kept = where.account === undefined ? owed(b.storage) : JSON.parse(b.storage.getItem(SHARES_KEY_PREFIX + where.account) ?? "{}").pending?.length === 1;
  expect([what, added.outcome, w.pushed.length, kept]).toEqual([what, "unknown", sent, true]);
  if (what === "silent") {
   const rec = JSON.parse(b.storage.getItem(SHARES_KEY_PREFIX + "acct") ?? "{}") as { sent?: unknown[] };
   expect(rec.sent?.length).toBe(1);
  }
  expect(boundNotice("docs", added)).toBe(ADD_UNKNOWN);
 }
 expect(ADD_UNKNOWN).toBe("Added on this device; we'll finish adding it to your account.");
}, CONNECTS_LIMIT_MS);

test("an add that outlasts addMs is unknown, its round going on", async () => {
 const w = worker(), b = await browser(w, { addMs: 50, roundMs: 500 });
 w.holdNextPush = true;
 const added = await b.shares.add(bound());
 expect([added.outcome, (added as { error: unknown }).error instanceof DOMException && (added as { error: DOMException }).error.name]).toEqual(["unknown", "TimeoutError"]);
 await b.shares.sync().catch(() => {});
 expect(owed(b.storage)).toBe(true);
});

test("a signed-out add says so: the write waits for the account's next sync on this browser", async () => {
 const w = worker(), b = await browser(w, { signedIn: false });
 const added = await b.shares.add(bound());
 expect([added.outcome, added.outcome === "unknown" && added.error instanceof SignedOutError, owed(b.storage)]).toEqual(["unknown", true, true]);
});

test("a 2xx that isn't the success envelope tells no outcome: unknown, never an error or added", async () => {
 const named = { collection: "shares", id: "HOST/G1" };
 for (const body of [null, [], { rev: 1, now_ms: 1 }, { rev: 1, applied: "HOST/G1", conflicts: [], now_ms: 1 }, { rev: 1, applied: [named], conflicts: null, now_ms: 1 }, { rev: 1, applied: [null], conflicts: [], now_ms: 1 },
  { rev: 1, applied: [{ id: "HOST/G1", rev: 1 }], conflicts: [], now_ms: 1 }, { rev: 1, applied: [], conflicts: [{ ...named, server: {} }], now_ms: 1 }, { rev: 1, applied: [], conflicts: [{ ...named }], now_ms: 1 }]) {
  const w = worker(), b = await browser(w);
  b.cut.answer = () => body;
  const added = await b.shares.add(bound());
  expect([JSON.stringify(body), added.outcome, w.pushed.length, owed(b.storage)]).toEqual([JSON.stringify(body), "unknown", 1, true]);
 }
});

test("now_ms is optional (a service without the clock extension, #826, sends none): a reply without it tells its outcome; one with it bad tells none", async () => {
 const outcome = async (rewrite: (a: Answer) => unknown, conflict: "live" | "tombstone" | null = null) => {
  const w = worker(), b = await browser(w);
  if (conflict === "live") w.onPush = () => w.seedShare("HOST/G1", THEIRS);
  if (conflict === "tombstone") w.onPush = () => w.seedTombstone("HOST/G1", "shares");
  b.cut.answer = rewrite;
  return [(await b.shares.add(bound())).outcome, w.pushed.length];
 };
 const bare = (a: Answer) => Object.fromEntries(Object.entries(a).filter(([k]) => k !== "now_ms"));
 expect([await outcome(bare), await outcome(bare, "live"), await outcome(bare, "tombstone")]).toEqual([["added", 1], ["added", 1], ["refused", 1]]);
 for (const now of [0, 1_000, Number.MAX_SAFE_INTEGER]) expect([now, ...await outcome(a => ({ ...a, now_ms: now }))]).toEqual([now, "added", 1]);
 for (const now of [-1, 1.5, "1000", null, true, {}, Number.MAX_SAFE_INTEGER + 2]) expect([now, ...await outcome(a => ({ ...a, now_ms: now }))]).toEqual([now, "unknown", 1]);
});

test("a 2xx confirms the add only as the service writes it: a matching entry in a reply with any required field missing or mistyped is unknown", async () => {
 const without = (o: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
 /** The add's outcome with the service's answer rewritten; held: it answers with the account's
  *  live item (another device's put landed first). */
 const outcome = async (rewrite: (a: Answer) => unknown, held = false) => {
  const w = worker(), b = await browser(w);
  if (held) w.onPush = () => w.seedShare("HOST/G1", THEIRS);
  b.cut.answer = rewrite;
  return [(await b.shares.add(bound())).outcome, w.pushed.length];
 };
 // As the service writes them: added.
 expect([await outcome(a => a), await outcome(a => a, true)]).toEqual([["added", 1], ["added", 1]]);
 const broken: [string, (a: Answer) => unknown, boolean][] = [
  // The review's probe: a matching applied entry, no revision on the envelope or the entry.
  ["no revision anywhere", a => without({ ...a, applied: a.applied.map(x => without(x, "rev")) }, "rev"), false],
  ...["rev", "applied", "conflicts"].map((k): [string, (a: Answer) => unknown, boolean] => [`no envelope ${k}`, a => without(a, k), false]),
  ...["collection", "id", "rev"].map((k): [string, (a: Answer) => unknown, boolean] => [`applied entry without ${k}`, a => ({ ...a, applied: a.applied.map(x => without(x, k)) }), false]),
  ...([["rev", "4"], ["rev", -1], ["rev", 1.5], ["rev", null], ["now_ms", "1000"], ["now_ms", null], ["now_ms", -1], ["now_ms", 1.5]] as const)
   .map(([k, v]): [string, (a: Answer) => unknown, boolean] => [`envelope ${k} ${JSON.stringify(v)}`, a => ({ ...a, [k]: v }), false]),
  ...([["rev", "4"], ["rev", -1], ["rev", Number.MAX_VALUE], ["id", 7], ["collection", null]] as const)
   .map(([k, v]): [string, (a: Answer) => unknown, boolean] => [`applied entry ${k} ${JSON.stringify(v)}`, a => ({ ...a, applied: a.applied.map(x => ({ ...x, [k]: v })) }), false]),
  ...["collection", "id", "rev", "updated_ms", "deleted", "body"].map((k): [string, (a: Answer) => unknown, boolean] =>
   [`conflict's server without ${k}`, a => ({ ...a, conflicts: a.conflicts.map(c => ({ ...c, server: without(c.server as Record<string, unknown>, k) })) }), true]),
  // An item's updated_ms is D1's integer clock; a tombstone has no body and a live item has one
  // (migrations/0003_sync.sql: updated_ms INTEGER NOT NULL, CHECK ((deleted = 1) = (body IS NULL))).
  ...([["rev", "3"], ["updated_ms", "0"], ["updated_ms", -1], ["updated_ms", 0.5], ["deleted", 0], ["body", null]] as const).map(([k, v]): [string, (a: Answer) => unknown, boolean] =>
   [`conflict's server ${k} ${JSON.stringify(v)}`, a => ({ ...a, conflicts: a.conflicts.map(c => ({ ...c, server: { ...(c.server as object), [k]: v } })) }), true]),
  ["a tombstone with a body", a => ({ ...a, conflicts: a.conflicts.map(c => ({ ...c, server: { ...(c.server as object), deleted: true } })) }), true],
  ["conflict without server", a => ({ ...a, conflicts: a.conflicts.map(c => without(c, "server")) }), true],
 ];
 for (const [what, rewrite, held] of broken) expect([what, ...await outcome(rewrite, held)]).toEqual([what, "unknown", 1]);
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

test("Add to my account keeps the grant on this browser, bound to the account, whatever the write's outcome; Only this device writes nothing", async () => {
 const cases: [(w: Worker) => void, ShareAdd["outcome"]][] = [[() => {}, "added"], [w => { w.refuseNextPush = [400, "invalid_body"]; }, "refused"], [w => { w.failPush = true; }, "unknown"]];
 for (const [arrange, outcome] of cases) {
  const w = worker(), relay = host(), b = await browser(w);
  arrange(w);
  const access = await b.desk.acceptGuestInvitation(inviteText(relay), "account");
  w.failPush = false;
  const grants = await b.grants.list();
  expect([access.added?.outcome, w.pushed.length]).toEqual([outcome, 1]);
  expect(grants.map(g => [g.guestID, g.accountBound, g.account])).toEqual([[access.guestID, true, "acct"]]);
 }
 const w = worker(), relay = host(), b = await browser(w);
 const plain = await b.desk.acceptGuestInvitation(inviteText(relay), "device");
 expect([plain.added, plain.accountBound, w.pushed.length, (await b.grants.list()).map(g => g.guestID)]).toEqual([undefined, false, 0, [plain.guestID]]);
}, CONNECTS_LIMIT_MS);
