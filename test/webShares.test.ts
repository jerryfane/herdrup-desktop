// The web guest's shares on the account (src/web/shares.ts through the guest Desk, desk.ts;
// herdrup#700 step 6): a bound accept writes the account's shares item, another browser of the
// account opens it with no invite, leaving it deletes it on every browser, and a plain accept
// writes nothing. Over a local relay whose host admits as herdr's guest/store.rs does (a
// redemption bound with a statement, a returning hello from any device of the account), and the
// fake account service (webAccountService.ts).
import { afterEach, expect, test } from "bun:test";
import { AccountServiceError, WebAccount } from "../src/web/account";
import { createGuestDesk } from "../src/web/desk";
import { events } from "../src/web/events";
import { createShareSync, LeaveUnsent, SHARES_KEY_PREFIX, SYNC_LOCK_PREFIX } from "../src/web/shares";
import { MemoryGrantStore, MemoryOwnerHint } from "../src/web/storage";
import { toB64url } from "../src/webguest/b64url";
import { MemoryIdentityStore } from "../src/webguest/identity";
import { APP_LINK_PREFIX } from "../src/webguest/invite";
import type { StatementSource } from "../src/webguest/owner";
import type { Access } from "../src/webguest/transport";
import type { AbortableLocks } from "../src/web/locks";
import { memory, worker, type Worker } from "./webAccountService";
import { CONNECTS_LIMIT_MS, startRelay, type HostSession, type TestRelay } from "./webguestResponder";

let relays: TestRelay[] = [];
afterEach(() => { for (const relay of relays) relay.stop(); relays = []; });

/** herdr sharing one agent (named agent): the grants it made, bound ones by the statement's
 *  account (here the statement text itself), and every hello it was sent. holdReturning keeps
 *  the reply to the next returning hello until released (arrived: that hello came). */
function host(agent = "docs") {
 const grants = new Map<string, { account: string | null }>();
 const hellos: Record<string, unknown>[] = [];
 let next = 0;
 let hold: { arrived: PromiseWithResolvers<void>; released: PromiseWithResolvers<void> } | null = null;
 const reply = (guestID: string, bound: boolean) => ({
  ok: true, guest_id: guestID, name: "visitor", machine_label: "Mac Studio", owner_name: "Ana", agent: { name: agent, target: "%7" },
  features: { gram: false, push: true, multi_request: true }, ...(bound ? { account: { deadline_unix: Math.floor(Date.now() / 1000) + 660 } } : {}),
 });
 const relay = startRelay({
  admit: () => undefined,
  async serve(_conn, handshake) {
   const h = await handshake();
   hellos.push(h.hello);
   const account = typeof h.hello.account === "string" ? h.hello.account : null;
   let session: HostSession;
   if (h.hello.invite_id !== undefined) {
    const guestID = toB64url(new Uint8Array(16).fill(++next));
    grants.set(guestID, { account });
    session = h.reply(reply(guestID, account !== null));
   } else {
    const grant = grants.get(String(h.hello.guest_id));
    const held = hold; hold = null;
    if (held) { held.arrived.resolve(); await held.released.promise; }
    if (grant === undefined) { h.reply({ ok: false, error: "unknown" }); return; }
    if (grant.account !== null && account !== grant.account) { h.reply({ ok: false, error: account === null ? "account_required" : "account_mismatch" }); return; }
    session = h.reply(reply(String(h.hello.guest_id), grant.account !== null));
   }
   for (;;) {
    const line = await session.readLine();
    if (line === null) return;
    const req = JSON.parse(line) as { id: string; method: string };
    session.write(JSON.stringify({ id: req.id, result: req.method === "agent.list" ? { type: "agent_list", agents: [{ terminal_id: "%7", name: "docs" }] } : { type: "ok" } }) + "\n");
   }
  },
 });
 relays.push(relay);
 return {
  relay, grants, hellos,
  holdReturning() {
   const held = hold = { arrived: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() };
   return { arrived: held.arrived.promise, release: () => held.released.resolve() };
  },
 };
}

/** The invitation's app link for agent; acct: 1 unless plain. */
function inviteText(relay: TestRelay, acct = true, agent = "docs"): string {
 const bytes = (n: number, fill: number) => toB64url(new Uint8Array(n).fill(fill));
 const payload = { v: 1, relay: relay.url, host_id: relay.hostID, host_pub: toB64url(relay.hostPublic), invite_id: bytes(16, 3), secret: bytes(32, 4), machine_label: "Mac Studio", owner_name: "Ana", agent_name: agent, guest_name: "visitor", expires_unix: Math.floor(Date.now() / 1000) + 3600, ...(acct ? { acct: 1 } : {}) };
 return APP_LINK_PREFIX + toB64url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** The statement of the account signed in ("acct" signed out) for any machine: its text names the
 *  account (the host binds to it). */
const statements = (account: WebAccount): StatementSource => ({
 get: async () => {
  const acct = account.current?.accountID ?? "acct";
  return { jws: `statement-of-${acct}`, expMs: Date.now() + 600_000, account: acct, live: () => true };
 },
 drop() {},
});

let sessions = 0;
/** One browser of the account: its own session, storage, guest key, grant and Web Locks. Signed
 *  out, the service refuses its cookie. Another tab of a browser holds its grants, storage, guest
 *  key and Web Locks (null: a browser without them). roundMs: how long its rounds may hold the
 *  sync turn (shares.ts ROUND_MS unless given). background: its shares sync on their own. */
async function browser(w: Worker, signedIn = true, grants = new MemoryGrantStore(), storage = memory(), identities = new MemoryIdentityStore(), locks: AbortableLocks | null = tabLocks(), roundMs?: number, background = false) {
 const fetcher = w.fetcher(`s${++sessions}`);
 const signedOut = ((input: string | URL | Request, init?: RequestInit) => String(input).includes("/v1/auth/refresh")
  ? Promise.resolve(Response.json({ error: "session_revoked" }, { status: 401 })) : fetcher(input, init)) as typeof fetch;
 const account = new WebAccount(signedIn ? fetcher : signedOut, undefined, undefined, null);
 if (signedIn) await account.check();
 const shares = createShareSync(account, { storage: () => storage, locks, name: "Chrome on macOS", background, ...(roundMs === undefined ? {} : { roundMs }) });
 const desk = createGuestDesk({ identities, grants, owner: new MemoryOwnerHint(), webSocket: (url) => new WebSocket(url), statements: statements(account), shares });
 return { desk, grants, shares, account, storage, identities };
}

const sharesOn = (w: Worker) => w.pushed.flat().filter(c => c.collection === "shares");

/** A browser's Web Locks: one holder per name, the others waiting their turn in order.
 *  waiting(name) resolves once a request for name comes while another holds it or waits for it;
 *  granted(name) counts the requests for name granted so far. */
function tabLocks() {
 const tails = new Map<string, Promise<unknown>>(), open = new Map<string, number>(), grants = new Map<string, number>();
 const waiters = new Map<string, (() => void)[]>();
 const request = <T>(name: string, ...args: [() => Promise<T>] | [{ signal?: AbortSignal }, () => Promise<T>]): Promise<T> => {
  const callback = args.length === 1 ? args[0] : args[1];
  const ahead = open.get(name) ?? 0;
  open.set(name, ahead + 1);
  if (ahead > 0) for (const told of waiters.get(name)?.splice(0) ?? []) told();
  const turn = (tails.get(name) ?? Promise.resolve()).then(() => { grants.set(name, (grants.get(name) ?? 0) + 1); return callback(); });
  tails.set(name, turn.finally(() => open.set(name, open.get(name)! - 1)).catch(() => {}));
  return turn;
 };
 return Object.assign({ request } as AbortableLocks, {
  waiting: (name: string) => { const told = Promise.withResolvers<void>(); waiters.set(name, [...waiters.get(name) ?? [], told.resolve]); return told.promise; },
  granted: (name: string) => grants.get(name) ?? 0,
 });
}

/** Two tabs of one browser (sharing locks) with 100 share puts kept while the service was out,
 *  then a bound share accepted while the service refused pushes (429: nothing of it written), its
 *  put the 101st: the second push's. Tab a's sync has sent its first push, applied and its answer
 *  held until release. */
async function leaveDuringBatch() {
 const w = worker(), h = host(), locks = tabLocks();
 const storage = memory(), grants = new MemoryGrantStore(), identities = new MemoryIdentityStore();
 const a = await browser(w, true, grants, storage, identities, locks), b = await browser(w, true, grants, storage, identities, locks);
 const guest = (n: number) => toB64url(new Uint8Array(16).fill(100 + n));
 const queued = Array.from({ length: 100 }, (_, n) => ({ id: `host/${guest(n)}`, body: { relay: "wss://relay.example", host_id: "host", node_pub: toB64url(new Uint8Array(32).fill(1)), guest_id: guest(n) } }));
 storage.setItem(SHARES_KEY_PREFIX + "acct", JSON.stringify({ rev: 0, shares: [], gone: {}, pending: queued }));
 w.rateLimit = 1; w.windowPosts = 1;
 const access = await b.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 w.rateLimit = 0;
 const answer = Promise.withResolvers<void>();
 w.holdAnswer = answer.promise;
 const before = w.pushed.length;
 const synced = a.shares.sync();
 while (w.pushed.length === before) await Bun.sleep(1);
 const id = `${h.relay.hostID}/${access.guestID}`;
 /** What was sent for the share since a's first push. */
 const sentSince = () => w.pushed.slice(before).flat().filter(c => c.id === id).map(c => c.deleted ? "delete" : "put");
 return { w, a, b, id, grants, locks, synced, release: () => answer.resolve(), firstPush: before + 1, sentSince };
}

// A browser without Web Locks can't take turns with its other tabs: a push of one could land after
// a Leave another sent. It sends nothing, and says why.
test("without Web Locks, a browser sends no share write: Add to my account says to update it, and a Leave goes here alone, its delete kept", async () => {
 const w = worker(), h = host();
 const storage = memory(), grants = new MemoryGrantStore(), identities = new MemoryIdentityStore();
 const able = await browser(w, true, grants, storage, identities);
 const access = await able.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 const old = await browser(w, true, grants, storage, identities, null);
 const pushes = w.pushed.length, hellos = h.hellos.length;
 const update = "This browser can't sync shared access. Update it.";
 await expect(old.desk.acceptGuestInvitation(inviteText(h.relay, true, "notes"), "account")).rejects.toThrow(update);
 await expect(old.desk.forgetGuestConnection(id)).rejects.toThrow(update);
 await expect(old.shares.sync()).rejects.toThrow(update);
 expect([w.pushed.length, h.hellos.length, await grants.list(), w.sharesIn("acct")]).toEqual([pushes, hellos, [], [id]]);
 // A browser that can sync sends the delete kept.
 await able.shares.sync();
 expect([w.sharesIn("acct"), sharesOn(w).at(-1)]).toEqual([[], { collection: "shares", id, base_rev: 1, deleted: true }]);
}, CONNECTS_LIMIT_MS);

test("with Web Locks, a tab's Leave syncs once another tab's round is done: the share left stays deleted", async () => {
 const t = await leaveDuringBatch();
 const lock = SYNC_LOCK_PREFIX + "acct", granted = t.locks.granted(lock);
 const queued = t.locks.waiting(lock);
 const left = t.b.desk.forgetGuestConnection(t.id);
 // The leaving tab's sync asks for the turn tab a holds, and isn't given it while a's round is
 // still answering: it sends nothing (a Leave done first would have sent its delete).
 expect(await Promise.race([queued.then(() => "waiting"), left.then(() => "left", () => "left")])).toBe("waiting");
 expect([t.locks.granted(lock), t.w.pushed.length]).toEqual([granted, t.firstPush]);
 t.release();
 await Promise.all([t.synced, left]);
 await t.a.shares.sync();
 await t.b.shares.sync();
 expect([await t.grants.list(), t.w.sharesIn("acct").includes(t.id), t.w.sharesIn("acct").length, t.sentSince()]).toEqual([[], false, 100, ["delete"]]);
}, CONNECTS_LIMIT_MS);

/** Two tabs of one browser, tab a's rounds given up 300 ms after they get the turn. */
async function twoTabs(w: Worker) {
 const storage = memory(), grants = new MemoryGrantStore(), identities = new MemoryIdentityStore(), locks = tabLocks();
 const a = await browser(w, true, grants, storage, identities, locks, 300), b = await browser(w, true, grants, storage, identities, locks);
 return { a, b, grants, storage };
}

// A request that stalls can't hold the account's sync turn: tab a's round gives its pull up at its
// deadline, and the Leave in tab b, waiting for the turn, sends its delete meanwhile.
test("a tab whose pull stalls gives the sync turn up at its deadline: a Leave in another tab sends its delete meanwhile", async () => {
 const w = worker(), h = host();
 const { a, b, grants } = await twoTabs(w);
 const access = await b.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 const stalled = Promise.withResolvers<void>(), pulling = Promise.withResolvers<void>();
 w.onPull = () => pulling.resolve();
 w.holdPull = stalled.promise;
 const synced = a.shares.sync();
 await pulling.promise;
 try {
  const left = b.desk.forgetGuestConnection(id).then(() => "left");
  const outcome = await Promise.race([left, Bun.sleep(3_000).then(() => "still waiting")]);
  expect([outcome, await grants.list(), w.sharesIn("acct"), sharesOn(w).at(-1)]).toEqual(["left", [], [], { collection: "shares", id, base_rev: 1, deleted: true }]);
  await expect(synced).rejects.toThrow();
 } finally { stalled.resolve(); }
}, CONNECTS_LIMIT_MS);

// A Leave in a tab whose own round is running (its pull stalled) gets a turn of its own once that
// round has settled, failed or not: its delete goes, and only then does the Leave resolve.
test("a Leave while its own tab's pull stalls gets a turn of its own once that round gives up: its delete goes", async () => {
 const w = worker(), h = host();
 const mac = await browser(w, true, new MemoryGrantStore(), memory(), new MemoryIdentityStore(), tabLocks(), 300);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 const stalled = Promise.withResolvers<void>(), pulling = Promise.withResolvers<void>();
 w.onPull = () => pulling.resolve();
 w.holdPull = stalled.promise;
 const synced = mac.shares.sync();
 await pulling.promise;
 try {
  await mac.desk.forgetGuestConnection(id);
  await expect(synced).rejects.toThrow();
  expect([w.sharesIn("acct"), sharesOn(w).at(-1), recordOf(mac.storage).pending]).toEqual([[], { collection: "shares", id, base_rev: 1, deleted: true }, []]);
 } finally { stalled.resolve(); }
}, CONNECTS_LIMIT_MS);

// A push given up at its deadline may still land until its not_after: its write stays journaled,
// never sent again, and the share's next write waits until a pull shows the service past that
// not_after. The Leave's tombstone then can't be under the late request: the service may prune it
// by count (it keeps the newest 2,000), and a put based on 0 would write the share back.
test("a Leave of a share whose put went unanswered waits out the put's not_after: the late put, landing past the Leave's pruned tombstone, is refused as expired", async () => {
 const w = worker(), h = host();
 const { a, b, grants, storage } = await twoTabs(w);
 w.holdNextPush = true;
 const access = await a.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 // a's put went unanswered, given up. Another device of the account writes the same share.
 w.seedShare(id, { relay: h.relay.url, host_id: h.relay.hostID, node_pub: toB64url(h.relay.hostPublic), guest_id: access.guestID, agent_name: "docs", owner_name: "Ana", machine_label: "Mac Studio" });
 // b's Leave sends nothing: the late put could still land.
 const left = await b.desk.forgetGuestConnection(id).then(() => "sent", (error: unknown) => error instanceof LeaveUnsent ? "unsent" : error);
 const before = [w.sharesIn("acct"), sharesOn(w).length];
 // Past the put's not_after, the delete goes; its tombstone is pruned; then the put lands.
 w.serverNow += 121_000;
 await b.shares.sync();
 w.keepTombstones(0);
 w.landHeld();
 await a.shares.sync();
 const record = JSON.parse(storage.getItem(SHARES_KEY_PREFIX + "acct")!) as { pending: unknown[]; sent: unknown[] };
 const writes = sharesOn(w).map(c => `${c.deleted ? "delete" : "put"} ${c.base_rev}`);
 expect([left, before, w.expired, w.sharesIn("acct"), await grants.list(), b.shares.list(), record.pending, record.sent, writes]).toEqual(["unsent", [[id], 1], 1, [], [], [], [], [], ["put 0", "delete 1"]]);
}, CONNECTS_LIMIT_MS);

// The put of an accept was taken, its answer lost; another browser of the account left the share.
// The first browser pulls the tombstone while the put may still land (its grant kept, its put
// waiting); past the put's not_after, its pull finds the share moved past the put's base: the put
// is settled, never sent again over the Leave, and the grant goes with it.
test("a put of unknown outcome is settled by the first pull past its not_after: a share another browser left meanwhile isn't put back", async () => {
 const w = worker(), h = host();
 const mac = await browser(w), linux = await browser(w);
 w.losePush = true;
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 await linux.shares.sync();
 await linux.desk.openSyncedShare(id);
 await linux.desk.forgetGuestConnection(id);
 await mac.shares.sync();
 const waiting = [(await mac.grants.get(id))?.guestID, w.pushed.length];
 w.serverNow += 121_000;
 await mac.shares.sync();
 await linux.shares.sync();
 const record = JSON.parse(mac.storage.getItem(SHARES_KEY_PREFIX + "acct")!) as { pending: unknown[]; sent: unknown[] };
 const writes = sharesOn(w).map(c => `${c.deleted ? "delete" : "put"} ${c.base_rev}`);
 expect([waiting, writes, w.sharesIn("acct"), mac.shares.list(), linux.shares.list(), await mac.grants.list(), record.pending, record.sent]).toEqual([[access.guestID, 2], ["put 0", "delete 1"], [], [], [], [], [], []]);
}, CONNECTS_LIMIT_MS);

test("a Leave whose push storage can't journal sends nothing, and says its delete is still owed", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 const posts = w.posts;
 // Storage takes the delete, and refuses the journal a push of it writes before it goes.
 const setItem = mac.storage.setItem;
 mac.storage.setItem = (key: string, value: string) => {
  if ((JSON.parse(value) as { sent?: unknown[] }).sent?.length) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  setItem(key, value);
 };
 const left = await mac.desk.forgetGuestConnection(id).then(() => "sent", (error: unknown) => error instanceof LeaveUnsent ? "unsent" : error);
 expect([left, w.posts - posts, w.sharesIn("acct"), recordOf(mac.storage).pending]).toEqual(["unsent", 0, [id], [{ id, deleted: true }]]);
 mac.storage.setItem = setItem;
 await mac.shares.sync();
 expect([w.sharesIn("acct"), recordOf(mac.storage).pending]).toEqual([[], []]);
}, CONNECTS_LIMIT_MS);

// The follow-up round is set for the first journal entry a queued write waits on, not the last:
// a later put of unknown outcome doesn't postpone a Leave's delete.
test("a Leave held behind a put of unknown outcome gets its round once that put can be settled, whatever was sent after", async () => {
 const w = worker(), h = host();
 const realTimeout = globalThis.setTimeout, realInterval = globalThis.setInterval;
 const delays: number[] = [];
 globalThis.setInterval = (() => 0) as unknown as typeof setInterval;
 globalThis.setTimeout = ((f: () => void, ms?: number) => {
  if ((ms ?? 0) <= 30_000) return realTimeout(f, ms);
  delays.push(ms!);
  return 0;
 }) as unknown as typeof setTimeout;
 try {
  const mac = await browser(w, true, undefined, undefined, undefined, undefined, undefined, true);
  w.losePush = true;
  const first = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
  await expect(mac.desk.forgetGuestConnection(`${h.relay.hostID}/${first.guestID}`)).rejects.toThrow(LeaveUnsent);
  // A minute on, another put goes and its answer is lost too.
  w.serverNow += 60_000;
  w.losePush = true;
  await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
  delays.length = 0;
  await mac.shares.sync();
  // The first put's not_after is a minute off: the round comes then (and a second).
  expect(delays).toEqual([61_000]);
 } finally {
  globalThis.setTimeout = realTimeout;
  globalThis.setInterval = realInterval;
 }
}, CONNECTS_LIMIT_MS);

test("a late push lands in the account it was sent as, not another", async () => {
 const w = worker(), h = host();
 w.accountsApart = true;
 w.accountId = "acct-b";
 const mac = await browser(w, true, undefined, undefined, undefined, undefined, 300);
 w.holdNextPush = true;
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 expect([mac.account.current?.accountID, w.sharesIn("acct"), w.sharesIn("acct-b")]).toEqual(["acct-b", [], []]);
 w.landHeld();
 expect([w.sharesIn("acct"), w.sharesIn("acct-b")]).toEqual([[], [id]]);
}, CONNECTS_LIMIT_MS);

test("a bound accept writes the share to the account; another browser of the account opens it with no invite", async () => {
 const w = worker(), h = host();
 const mac = await browser(w), linux = await browser(w);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 expect(h.hellos[0]!.account).toBe("statement-of-acct");
 expect((await mac.grants.get(id))?.accountBound).toBe(true);
 expect(sharesOn(w)).toEqual([{ collection: "shares", id, base_rev: 0, body: { relay: h.relay.url, host_id: h.relay.hostID, node_pub: toB64url(h.relay.hostPublic), guest_id: access.guestID, agent_name: "docs", owner_name: "Ana", machine_label: "Mac Studio" } }]);
 expect((await mac.desk.syncedShares()).map(s => [s.id, s.local])).toEqual([[id, true]]);

 await linux.shares.sync();
 const listed = await linux.desk.syncedShares();
 expect(listed).toEqual([{ id, relay: h.relay.url, hostID: h.relay.hostID, nodePub: toB64url(h.relay.hostPublic), guestID: access.guestID, agentName: "docs", ownerName: "Ana", machineLabel: "Mac Studio", shareGram: false, local: false }]);
 const heard: { id: string; local: boolean }[][] = [];
 const off = events.syncedSharesChanged.on(list => heard.push(list.map(s => ({ id: s.id, local: s.local }))));
 await linux.desk.openSyncedShare(id);
 off();
 expect(heard.at(-1)).toEqual([{ id, local: true }]);
 expect(h.hellos.at(-1)).toEqual({ v: 1, guest_id: access.guestID, account: "statement-of-acct" });
 expect(await linux.grants.get(id)).toMatchObject({ guestID: access.guestID, agentTarget: "%7", machineLabel: "Mac Studio", accountBound: true });
 expect((await linux.desk.syncedShares()).map(s => s.local)).toEqual([true]);
 // One write: opening a share on another browser writes nothing to the account.
 expect(sharesOn(w).length).toBe(1);
 await linux.desk.forgetGuestConnection(id);
}, CONNECTS_LIMIT_MS);

test("leaving a bound share deletes it from the account, and every browser holding it drops it at its next sync", async () => {
 const w = worker(), h = host();
 const mac = await browser(w), linux = await browser(w);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 await linux.shares.sync();
 await linux.desk.openSyncedShare(id);
 await mac.desk.forgetGuestConnection(id);
 expect(await mac.grants.list()).toEqual([]);
 expect(sharesOn(w).at(-1)).toEqual({ collection: "shares", id, base_rev: 1, deleted: true });
 expect(await mac.desk.syncedShares()).toEqual([]);
 await linux.shares.sync();
 expect(await linux.grants.list()).toEqual([]);
 expect(await linux.desk.syncedShares()).toEqual([]);
}, CONNECTS_LIMIT_MS);

test("a Leave whose delete storage refuses keeps the grant, and the Leave tried again deletes the share from the account", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 const key = SHARES_KEY_PREFIX + "acct";
 mac.storage.refuses = k => k === key;
 await expect(mac.desk.forgetGuestConnection(id)).rejects.toThrow("quota");
 expect([(await mac.grants.get(id))?.guestID, w.sharesIn("acct")]).toEqual([access.guestID, [id]]);
 mac.storage.refuses = null;
 await mac.desk.forgetGuestConnection(id);
 await mac.shares.sync();
 expect([await mac.grants.list(), w.sharesIn("acct"), sharesOn(w).at(-1)]).toEqual([[], [], { collection: "shares", id, base_rev: 1, deleted: true }]);
}, CONNECTS_LIMIT_MS);

test("a Leave whose grant removal fails still closes the link and sends its delete at once; the grant goes with the share's tombstone", async () => {
 const w = worker(), h = host();
 const grants = new FlakyGrants();
 const mac = await browser(w, true, grants);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 await mac.desk.connectGuest(id);
 grants.failing = 1;
 await expect(mac.desk.forgetGuestConnection(id)).rejects.toThrow("aborted");
 expect([w.sharesIn("acct"), sharesOn(w).at(-1), await grants.list(), (await mac.desk.state()).phase]).toEqual([[], { collection: "shares", id, base_rev: 1, deleted: true }, [], "idle"]);
}, CONNECTS_LIMIT_MS);

/** A browser's record of the account's shares, as stored. */
const recordOf = (storage: Pick<Storage, "getItem">) => JSON.parse(storage.getItem(SHARES_KEY_PREFIX + "acct")!) as { pending: unknown[]; drop?: string[] };

// A share the service never held (its put refused: 429, nothing written) leaves no tombstone when
// left. The removal of its grant is owed here with the delete, and tried at every change heard
// (each round's) until done, whatever the service holds.
test("a Leave of a share the service never held removes its grant once a removal that failed can be done, with no tombstone to come", async () => {
 const w = worker(), h = host();
 const grants = new FlakyGrants();
 const mac = await browser(w, true, grants);
 w.rateLimit = 1; w.windowPosts = 1;
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 w.rateLimit = 0;
 const id = `${h.relay.hostID}/${access.guestID}`;
 expect(w.sharesIn("acct")).toEqual([]);
 // The Leave's removal fails, and so do the two its sync's changes try.
 grants.failing = 3;
 await expect(mac.desk.forgetGuestConnection(id)).rejects.toThrow("aborted");
 expect([sharesOn(w).at(-1), (await grants.get(id))?.guestID, recordOf(mac.storage).drop]).toEqual([{ collection: "shares", id, base_rev: 0, deleted: true }, access.guestID, [id]]);
 // No tombstone comes (the service held nothing): the next round's removal is done.
 await mac.shares.sync();
 await expect(mac.desk.connectGuest(id)).rejects.toThrow();
 expect([await grants.list(), w.sharesIn("acct"), recordOf(mac.storage).pending, recordOf(mac.storage).drop]).toEqual([[], [], [], []]);
}, CONNECTS_LIMIT_MS);

// A Leave whose delete the service hasn't taken (another device moved the share on) still owes its
// grant's removal while a pull shows the share live.
test("a Leave whose delete isn't taken yet still owes its grant's removal while the share is live on the account", async () => {
 const w = worker(), h = host();
 const grants = new FlakyGrants();
 const mac = await browser(w, true, grants);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 // Another device of the account rewrites the share (revision 2) as the Leave's delete goes.
 w.onPush = () => w.seedShare(id, { relay: h.relay.url, host_id: h.relay.hostID, node_pub: toB64url(h.relay.hostPublic), guest_id: access.guestID, agent_name: "docs (renamed)" });
 grants.failing = 3;
 await expect(mac.desk.forgetGuestConnection(id)).rejects.toThrow("aborted");
 expect([w.sharesIn("acct"), (await grants.get(id))?.guestID, recordOf(mac.storage).drop]).toEqual([[id], access.guestID, [id]]);
 await mac.shares.sync();
 expect([await grants.list(), w.sharesIn("acct"), recordOf(mac.storage).pending, recordOf(mac.storage).drop]).toEqual([[], [], [], []]);
}, CONNECTS_LIMIT_MS);

test("a browser whose put was taken but whose readback failed still drops its bound grant when the share's tombstone comes", async () => {
 const w = worker(), h = host();
 const mac = await browser(w), linux = await browser(w);
 // The put is applied; the pull after it is answered 503: this browser never sees the share live.
 w.afterPush = () => { w.failPull = true; };
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 expect([sharesOn(w).length, w.failPull, (await mac.grants.get(id))?.accountBound]).toEqual([1, false, true]);
 // Another browser of the account opens the synced list and leaves the share.
 await linux.shares.sync();
 await linux.desk.openSyncedShare(id);
 await linux.desk.forgetGuestConnection(id);
 expect(sharesOn(w).at(-1)).toEqual({ collection: "shares", id, base_rev: 1, deleted: true });
 await mac.shares.sync();
 expect(await mac.grants.list()).toEqual([]);
 expect(await mac.desk.syncedShares()).toEqual([]);
}, CONNECTS_LIMIT_MS);

test("an Open overtaken by its share's tombstone while it starts connects nothing", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 /** Runs onActivate (once) as the grant is about to be made the one opened. */
 class Overtaken extends MemoryGrantStore {
  onActivate: (() => Promise<void>) | null = null;
  override async activate(id: string) { const run = this.onActivate; this.onActivate = null; await run?.(); return super.activate(id); }
 }
 const linux = await browser(w, true, new Overtaken());
 await linux.shares.sync();
 await linux.desk.openSyncedShare(id);
 // Opened again: meanwhile the share is left on another device, and this tab's sync pulls its tombstone.
 (linux.grants as Overtaken).onActivate = async () => { await mac.desk.forgetGuestConnection(id); await linux.shares.sync(); };
 await expect(linux.desk.connectGuest(id)).rejects.toThrow("no longer saved");
 expect([await linux.grants.list(), (await linux.desk.state()).phase]).toEqual([[], "idle"]);
}, CONNECTS_LIMIT_MS);

test("a tab with the share open closes it once another tab of the browser took the share's tombstone and dropped its grant", async () => {
 const w = worker(), h = host();
 const mac = await browser(w), linux = await browser(w);
 const idleTab = await browser(w, true, linux.grants, linux.storage, linux.identities);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 await linux.shares.sync();
 await linux.desk.openSyncedShare(id);
 expect((await linux.desk.state()).phase).not.toBe("idle");
 await mac.desk.forgetGuestConnection(id);
 // The idle tab pulls first: it drops the grant both tabs hold, and the pull leaves the open tab nothing new.
 await idleTab.shares.sync();
 expect(await linux.grants.list()).toEqual([]);
 await linux.shares.sync();
 expect((await linux.desk.state()).phase).toBe("idle");
}, CONNECTS_LIMIT_MS);

/** A browser's grant store (IndexedDB) whose next removals (failing) fail, as a transaction may. */
class FlakyGrants extends MemoryGrantStore {
 failing = 0;
 override async remove(id: string) {
  if (this.failing > 0) { this.failing--; throw new DOMException("The transaction was aborted.", "AbortError"); }
  return super.remove(id);
 }
}

/** A bound share open in one tab of a browser and left on another device; then (pruned: its
 *  tombstone pruned, so the next pull is a full one after a 410) the browser's idle tab pulls, and
 *  its removal of the grant fails once. Storage recovered, both tabs sync. */
async function leftWhileOpen(pruned: boolean) {
 const w = worker(), h = host();
 const mac = await browser(w);
 const grants = new FlakyGrants(), storage = memory(), identities = new MemoryIdentityStore();
 const open = await browser(w, true, grants, storage, identities), idle = await browser(w, true, grants, storage, identities);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 await open.shares.sync();
 await open.desk.openSyncedShare(id);
 await mac.desk.forgetGuestConnection(id);
 if (pruned) w.prune(w.rev);
 grants.failing = 1;
 await idle.shares.sync();
 const record: { gone: Record<string, number> } = JSON.parse(storage.getItem(SHARES_KEY_PREFIX + "acct")!);
 expect([(await grants.list()).length, idle.shares.list(), id in record.gone]).toEqual([1, [], !pruned]);
 await open.shares.sync();
 await idle.shares.sync();
 expect([await grants.list(), (await open.desk.state()).phase]).toEqual([[], "idle"]);
}

test("a share left while open in one tab, its tombstone pruned, closes and goes once the idle tab's failed grant removal can be done", async () => {
 await leftWhileOpen(true);
}, CONNECTS_LIMIT_MS);

test("a share left while open in one tab closes and goes once the idle tab that took its tombstone can remove its grant", async () => {
 await leftWhileOpen(false);
}, CONNECTS_LIMIT_MS);

test("an open whose share is deleted while the host answers keeps nothing and says the share was removed", async () => {
 const w = worker(), h = host();
 const mac = await browser(w), linux = await browser(w);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 await linux.shares.sync();
 // The host's answer to the open waits while mac leaves the share and linux pulls the tombstone.
 const held = h.holdReturning();
 const opening = linux.desk.openSyncedShare(id);
 await held.arrived;
 await mac.desk.forgetGuestConnection(id);
 await linux.shares.sync();
 held.release();
 await expect(opening).rejects.toThrow("This share was removed.");
 await linux.shares.sync();
 expect([await linux.grants.list(), await linux.desk.syncedShares(), (await linux.desk.state()).phase]).toEqual([[], [], "idle"]);
}, CONNECTS_LIMIT_MS);

test("a leave based on a revision the share has moved past stays pending, and the next sync deletes it", async () => {
 const w = worker(), h = host();
 const mac = await browser(w), linux = await browser(w);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 // Another device of the account rewrites the share (revision 2) as this browser's delete goes.
 w.onPush = () => w.seedShare(id, { relay: h.relay.url, host_id: h.relay.hostID, node_pub: toB64url(h.relay.hostPublic), guest_id: access.guestID, agent_name: "docs (renamed)" });
 await mac.desk.forgetGuestConnection(id);
 expect(sharesOn(w).at(-1)).toEqual({ collection: "shares", id, base_rev: 1, deleted: true });
 expect(await mac.desk.syncedShares()).toEqual([]);
 await mac.shares.sync();
 expect(sharesOn(w).at(-1)).toEqual({ collection: "shares", id, base_rev: 2, deleted: true });
 expect(await mac.desk.syncedShares()).toEqual([]);
 await linux.shares.sync();
 expect(linux.shares.list()).toEqual([]);
 // Settled: the round after it sends nothing.
 const pushes = w.pushed.length;
 await mac.shares.sync();
 expect(w.pushed.length).toBe(pushes);
}, CONNECTS_LIMIT_MS);

test("a share is written to and deleted from the account that bound it, never another signed in meanwhile", async () => {
 const w = worker(), h = host();
 w.accountsApart = true;
 // Account B signs in here while the grant bound to A ("acct") is being saved.
 const grants = new class extends MemoryGrantStore {
  onPut: (() => Promise<void>) | null = null;
  override async put(access: Access) { await super.put(access); const run = this.onPut; this.onPut = null; await run?.(); }
 }();
 const mac = await browser(w, true, grants);
 const switchTo = async (acct: string) => { w.accountId = acct; await mac.account.signOut().catch(() => {}); await mac.account.check(); };
 grants.onPut = () => switchTo("acct-b");
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 expect([mac.account.current?.accountID, access.accountBound, (await mac.grants.get(id))?.account]).toEqual(["acct-b", true, "acct"]);
 await mac.shares.sync();
 expect([w.sharesIn("acct"), w.sharesIn("acct-b"), sharesOn(w), await mac.desk.syncedShares()]).toEqual([[], [], [], []]);
 // Back on A: its next sync here writes the share there, and only there.
 await switchTo("acct");
 await mac.shares.sync();
 expect([w.sharesIn("acct"), w.sharesIn("acct-b")]).toEqual([[id], []]);
 // Left under B: deleted from A alone, at A's next sync here. The Leave says the account still
 // lists it.
 await switchTo("acct-b");
 await expect(mac.desk.forgetGuestConnection(id)).rejects.toThrow(LeaveUnsent);
 expect(await mac.grants.list()).toEqual([]);
 await mac.shares.sync();
 expect([w.sharesIn("acct"), sharesOn(w).length]).toEqual([[id], 1]);
 await switchTo("acct");
 await mac.shares.sync();
 expect([w.sharesIn("acct"), sharesOn(w).at(-1)]).toEqual([[], { collection: "shares", id, base_rev: 1, deleted: true }]);
}, CONNECTS_LIMIT_MS);

test("a label the service can't store is left out of the share, and a refused push loses no other write", async () => {
 // 70 graphemes, 140 code points: an invite may name its agent so; the service keeps 128 code points.
 const long = "👍🏽".repeat(70);
 const w = worker(), h = host(long);
 const mac = await browser(w), linux = await browser(w);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay, true, long), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 const body = { relay: h.relay.url, host_id: h.relay.hostID, node_pub: toB64url(h.relay.hostPublic), guest_id: access.guestID, owner_name: "Ana", machine_label: "Mac Studio" };
 expect([[...long].length, (await mac.grants.get(id))?.agentName]).toEqual([140, long]);
 expect(sharesOn(w)).toEqual([{ collection: "shares", id, base_rev: 0, body }]);
 await linux.shares.sync();
 expect(linux.shares.list()).toEqual([{ id, rev: 1, body }]);

 // This browser's record holds a put the service refuses (an earlier version wrote it) ahead of a
 // leave not yet taken (refused, 429: nothing of it written): the leave still goes, and the
 // refused put alone is dropped.
 w.rateLimit = 1; w.windowPosts = 1;
 await mac.desk.forgetGuestConnection(id);
 w.rateLimit = 0;
 const key = SHARES_KEY_PREFIX + "acct";
 const record: { pending: object[] } = JSON.parse(mac.storage.getItem(key)!);
 const other = toB64url(new Uint8Array(16).fill(9));
 record.pending.unshift({ id: `${h.relay.hostID}/${other}`, body: { ...body, guest_id: other, agent_name: long } });
 mac.storage.setItem(key, JSON.stringify(record));
 await mac.shares.sync();
 // Refused whole, then each change alone: the leave is taken.
 expect(w.pushed.slice(-3).map(p => p.map(c => c.id === id ? "leave" : "refused"))).toEqual([["refused", "leave"], ["refused"], ["leave"]]);
 expect(sharesOn(w).at(-1)).toEqual({ collection: "shares", id, base_rev: 1, deleted: true });
 const after: { pending: object[] } = JSON.parse(mac.storage.getItem(key)!);
 expect([w.sharesIn("acct"), after.pending]).toEqual([[], []]);
}, CONNECTS_LIMIT_MS);

test("a backlog of more share writes than one push takes goes in pushes the service takes, each settled as it is answered", async () => {
 const w = worker();
 const mac = await browser(w);
 const key = SHARES_KEY_PREFIX + "acct";
 const guest = (n: number) => toB64url(new Uint8Array(16).fill(n));
 // 101 bound shares kept while the service was out: one past the most a push may hold (sync.ts MAX_CHANGES).
 const pending = Array.from({ length: 101 }, (_, n) => ({ id: `host/${guest(n)}`, body: { relay: "wss://relay.example", host_id: "host", node_pub: toB64url(new Uint8Array(32).fill(1)), guest_id: guest(n), agent_name: "docs", owner_name: "Ana", machine_label: "Mac Studio" } }));
 mac.storage.setItem(key, JSON.stringify({ rev: 0, shares: [], gone: {}, pending }));
 // The first push is applied and its answer lost: its writes stay, journaled, and the second still goes and settles.
 w.losePush = true;
 await expect(mac.shares.sync()).rejects.toThrow();
 expect([w.tooLarge, w.pushed.map(p => p.length), w.sharesIn("acct").length]).toEqual([0, [100, 1], 101]);
 const kept: { pending: { id: string }[] } = JSON.parse(mac.storage.getItem(key)!);
 expect(kept.pending.map(p => p.id)).toEqual(pending.slice(0, 100).map(p => p.id));
 // Never sent again: before their not_after nothing goes, and the first pull past it finds each
 // share moved past the base it was sent on (by the lost push itself): settled, none put again.
 await mac.shares.sync();
 expect(w.pushed.length).toBe(2);
 w.serverNow += 121_000;
 await mac.shares.sync();
 const after: { pending: object[]; sent: object[] } = JSON.parse(mac.storage.getItem(key)!);
 expect([w.tooLarge, w.pushed.length, after.pending, after.sent, mac.shares.list().length]).toEqual([0, 2, [], [], 101]);
});

test("a plain accept (Only this device, or an invite without acct) writes nothing to the account", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 // The invitation says whether it may be added to the account (the choice is offered only then).
 expect([(await mac.desk.inspectGuestInvitation(inviteText(h.relay))).account, (await mac.desk.inspectGuestInvitation(inviteText(h.relay, false))).account]).toEqual([true, false]);
 const device = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "device");
 expect(h.hellos[0]!.account).toBeUndefined();
 expect((await mac.grants.get(`${h.relay.hostID}/${device.guestID}`))?.accountBound).toBeUndefined();
 const plain = await mac.desk.acceptGuestInvitation(inviteText(h.relay, false), "account");
 expect(h.hellos[1]!.account).toBeUndefined();
 await mac.shares.sync();
 expect([w.pushed.length, await mac.desk.syncedShares()]).toEqual([0, []]);
 // Leaving it deletes nothing; and a plain grant stays even when the account shows a share of
 // its id deleted.
 const id = `${h.relay.hostID}/${plain.guestID}`;
 w.seedShare(id, { relay: h.relay.url, host_id: h.relay.hostID, node_pub: toB64url(h.relay.hostPublic), guest_id: plain.guestID });
 await mac.shares.sync();
 w.seedTombstone(id, "shares");
 await mac.shares.sync();
 expect((await mac.grants.get(id))?.guestID).toBe(plain.guestID);
 await mac.desk.forgetGuestConnection(id);
 expect(w.pushed.length).toBe(0);
}, CONNECTS_LIMIT_MS);

test("opening a synced share keeps the grant held on this device alone: either opens again, and only Leave forgets one", async () => {
 const w = worker(), h = host();
 const mac = await browser(w), linux = await browser(w);
 const synced = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const syncedID = `${h.relay.hostID}/${synced.guestID}`;
 const device = await linux.desk.acceptGuestInvitation(inviteText(h.relay), "device");
 const deviceID = `${h.relay.hostID}/${device.guestID}`;
 const held = async () => (await linux.desk.sharedConnections()).map(a => a.guestID);
 await linux.desk.connectGuest(deviceID);
 await linux.shares.sync();
 await linux.desk.openSyncedShare(syncedID);
 // Both kept, the one opened last first (the page resumes it).
 expect(await held()).toEqual([synced.guestID, device.guestID]);
 await linux.desk.connectGuest(deviceID);
 expect(await held()).toEqual([device.guestID, synced.guestID]);
 // Leaving the device's own share forgets it alone, and deletes nothing on the account.
 await linux.desk.forgetGuestConnection(deviceID);
 expect([await held(), sharesOn(w).length]).toEqual([[synced.guestID], 1]);
}, CONNECTS_LIMIT_MS);

test("an unknown choice, or Add to my account signed out, redeems nothing", async () => {
 const w = worker(), h = host();
 const mac = await browser(w, false);
 await expect(mac.desk.acceptGuestInvitation(inviteText(h.relay), "both")).rejects.toThrow("Unknown choice");
 await expect(mac.desk.acceptGuestInvitation(inviteText(h.relay), "account")).rejects.toThrow("Signed out");
 expect([h.hellos.length, await mac.grants.list()]).toEqual([0, []]);
}, CONNECTS_LIMIT_MS);

// A sent create's proof (#596's rule, Go needsProof / account.Retains): a put of a new share whose
// answer was lost is journaled with sent_at, the revision this browser had pulled to when it went.
// Past its not_after, a pull that doesn't list it settles it: an incremental one, or a full one
// read at or below sent_at, could have missed no landing, so it goes again, once. A full pull past
// sent_at could have (a landing deleted since, its tombstone pruned): the service's history from
// sent_at (at least 1) is asked. Held, it goes again once; gone (410), it is dropped with its grant;
// unanswered, it is unproven: kept, never sent, never dropped, and asked again at every later
// sync, while everything else that pull settled stands.
type Journal = { pending: { id: string }[]; sent?: { id: string; sent_at: number; unproven?: true }[] };
const journalOf = (storage: Pick<Storage, "getItem">) => JSON.parse(storage.getItem(SHARES_KEY_PREFIX + "acct")!) as Journal;
const writesOn = (w: Worker) => sharesOn(w).map(c => `${c.deleted ? "delete" : "put"} ${c.base_rev}`);

test("a sent create a full pull can't rule out isn't written afresh: the history from where it went gone (410), it goes with its grant", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 w.seedPrompt("p1", {});
 // The put lands (revision 2); its answer is lost.
 w.losePush = true;
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 expect([access.added?.outcome, journalOf(mac.storage).sent?.map(e => [e.id, e.sent_at])]).toEqual(["unknown", [[id, 1]]]);
 // Another device leaves it, and the tombstone is pruned: no pull can show the landing now.
 w.seedTombstone(id, "shares");
 w.keepTombstones(0);
 w.serverNow += 121_000;
 const pulls = w.pulls.length;
 await mac.shares.sync();
 const j = journalOf(mac.storage);
 // The pull from 1 is refused (410) and starts over from 0; the history from 1 is gone too.
 expect([w.pulls.slice(pulls), writesOn(w), w.sharesIn("acct"), await mac.grants.list(), j.pending, j.sent]).toEqual([["?since=1", "?since=0", "?since=1", "?since=3"], ["put 0"], [], [], [], []]);
}, CONNECTS_LIMIT_MS);

test("a sent create that never landed goes again once when the history from where it went is held: nothing was missed", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 // Sent on an empty account (sent_at 0), never written.
 w.failPush = true;
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 w.failPush = false;
 const id = `${h.relay.hostID}/${access.guestID}`;
 // Another device writes another share: the pull from 0 reads past where the put went.
 w.seedShare("OTHER/G9", { relay: h.relay.url, host_id: "OTHER", node_pub: toB64url(h.relay.hostPublic), guest_id: "G9" });
 w.serverNow += 121_000;
 const pulls = w.pulls.length;
 await mac.shares.sync();
 await mac.shares.sync();
 expect([access.added?.outcome, w.pulls.slice(pulls, pulls + 2), writesOn(w), w.sharesIn("acct").sort(), journalOf(mac.storage).sent]).toEqual(["unknown", ["?since=0", "?since=1"], ["put 0", "put 0"], [id, "OTHER/G9"].sort(), []]);
}, CONNECTS_LIMIT_MS);

test("a sent create past its not_after that an incremental pull doesn't list goes again at once, no proof asked", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 w.seedPrompt("p1", {});
 w.failPush = true;
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 w.failPush = false;
 w.serverNow += 121_000;
 const pulls = w.pulls.length;
 await mac.shares.sync();
 expect([w.pulls.slice(pulls), writesOn(w), w.sharesIn("acct")]).toEqual([["?since=1", "?since=1"], ["put 0", "put 0"], [`${h.relay.hostID}/${access.guestID}`]]);
}, CONNECTS_LIMIT_MS);

test("a sent create a restarted history's full pull reads at or below where it went goes again: no landing past sent_at could be missed", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 for (const p of ["p1", "p2", "p3"]) w.seedPrompt(p, {});
 w.failPush = true;
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 w.failPush = false;
 // The account's history starts over: two revisions, the floor at the second.
 w.reset();
 w.seedPrompt("q1", {});
 w.seedTombstone("Q/2", "shares");
 w.prune(2);
 w.serverNow += 121_000;
 const pulls = w.pulls.length;
 await mac.shares.sync();
 expect([w.pulls.slice(pulls), writesOn(w), w.sharesIn("acct")]).toEqual([["?since=3", "?since=0", "?since=2"], ["put 0", "put 0"], [`${h.relay.hostID}/${access.guestID}`]]);
}, CONNECTS_LIMIT_MS);

// The review's round-6 sequence: the proof fails after a full readback. What the readback settled
// stands (a remote delete drops its grant); only the create owed a proof waits, unproven.
test("a sent create whose proof fails is kept, unsent and undropped, while the rest of the full readback applies; the next sync asks again", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 const first = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const kept = `${h.relay.hostID}/${first.guestID}`;
 // The second put lands (revision 2); its answer is lost.
 w.losePush = true;
 const second = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const late = `${h.relay.hostID}/${second.guestID}`;
 // Another device leaves both: the late one's tombstone pruned, the first's kept.
 w.seedTombstone(late, "shares");
 w.prune(3);
 w.seedTombstone(kept, "shares");
 w.serverNow += 121_000;
 // The pull from 1 is refused (410), the one from 0 reads the account, and every proof of the
 // round fails (the readback's own too).
 w.onPull = () => { w.onPull = () => { w.failPullSince = 1; }; };
 const synced = await mac.shares.sync().then(() => "ok", (error: unknown) => error instanceof AccountServiceError ? error.status : error);
 const j = journalOf(mac.storage);
 expect([synced, (await mac.grants.list()).map(g => g.guestID), j.pending.map(p => p.id), j.sent?.map(e => [e.id, e.unproven]), writesOn(w), w.sharesIn("acct")])
  .toEqual([503, [second.guestID], [late], [[late, true]], ["put 0", "put 0"], []]);
 // Asked again at the next sync, an incremental one: the history from 1 is gone.
 w.failPullSince = null;
 await mac.shares.sync();
 const k = journalOf(mac.storage);
 expect([await mac.grants.list(), k.pending, k.sent, writesOn(w), w.sharesIn("acct")]).toEqual([[], [], [], ["put 0", "put 0"], []]);
}, CONNECTS_LIMIT_MS);

// Go's TestAnAcceptsReadbackIsCommittedBeforeItsHistoryAsk: the full readback is saved before the
// history is asked, the create it can't settle marked unproven in that same save; a probe that
// hangs to the round's deadline then changes nothing else.
test("an accept's readback is committed before its history ask: a probe hanging to the round's deadline leaves the create unproven and nothing else changed", async () => {
 const w = worker(), h = host();
 const mac = await browser(w, true, undefined, undefined, undefined, undefined, 1_500);
 const first = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const kept = `${h.relay.hostID}/${first.guestID}`;
 w.losePush = true;
 const second = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const late = `${h.relay.hostID}/${second.guestID}`;
 w.seedTombstone(late, "shares");
 w.prune(3);
 w.seedTombstone(kept, "shares");
 w.serverNow += 121_000;
 // The pull from 1 is refused (410), the one from 0 reads the account, and the history ask from
 // 1 hangs: as it starts, the record already holds the readback.
 let during: unknown = null;
 w.onPull = () => {
  w.onPull = () => {
   w.stallPullSince = 1;
   w.onPull = () => { const r = journalOf(mac.storage) as Journal & { rev: number; drop?: string[] }; during = [r.rev, r.sent?.map(e => [e.id, e.unproven]), r.drop]; };
  };
 };
 const synced = await mac.shares.sync().then(() => "ok", (error: unknown) => error instanceof DOMException ? error.name : error);
 w.stallPullSince = null;
 const j = journalOf(mac.storage);
 expect([during, synced]).toEqual([[4, [[late, true]], [kept]], "TimeoutError"]);
 expect([(await mac.grants.list()).map(g => g.guestID), j.pending.map(p => p.id), j.sent?.map(e => [e.id, e.unproven]), writesOn(w), w.sharesIn("acct")])
  .toEqual([[second.guestID], [late], [[late, true]], ["put 0", "put 0"], []]);
}, CONNECTS_LIMIT_MS);

test("history answers that come once the sign-in changed aren't applied: the create stays unproven, its grant kept", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 w.seedPrompt("p1", {});
 w.losePush = true;
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 w.seedTombstone(id, "shares");
 w.keepTombstones(0);
 w.serverNow += 121_000;
 // The pull from 1 is refused (410), the one from 0 reads the account; this browser signs out
 // while the history ask (gone: 410) is answered.
 w.onPull = () => { w.onPull = () => { w.onPull = () => { void mac.account.signOut().catch(() => {}); }; }; };
 await mac.shares.sync().catch(() => {});
 const j = journalOf(mac.storage);
 expect([j.pending.map(p => p.id), j.sent?.map(e => [e.id, e.unproven]), (await mac.grants.list()).map(g => g.guestID), writesOn(w)]).toEqual([[id], [[id, true]], [access.guestID], ["put 0"]]);
}, CONNECTS_LIMIT_MS);

test("a push the service refuses (a 4xx) wrote nothing: its journal entries come out, and its write goes at the next round", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 w.refuseNextPush = [403, "quota"];
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 const j = journalOf(mac.storage);
 expect([access.added?.outcome, j.pending.map(p => p.id), j.sent]).toEqual(["unknown", [id], []]);
 await mac.shares.sync();
 expect([writesOn(w), w.sharesIn("acct"), journalOf(mac.storage).sent]).toEqual([["put 0", "put 0"], [id], []]);
}, CONNECTS_LIMIT_MS);

// Round 2 regression tests for #622 (all 7 P2 findings):

test("deleted share detaches and stays hidden/unopenable even when localStorage or IndexedDB fails", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 await mac.desk.connectGuest(id);
 expect((await mac.desk.state()).phase).not.toBe("idle");

 // Case A: localStorage rejects the tombstone commit -> still detaches & hides & blocks connectGuest.
 w.seedTombstone(id, "shares");
 const origSet = mac.storage.setItem.bind(mac.storage);
 mac.storage.setItem = () => { throw new DOMException("quota", "QuotaExceededError"); };
 await expect(mac.shares.sync()).rejects.toThrow();
 mac.storage.setItem = origSet;
 expect((await mac.desk.state()).phase).toBe("idle");
 expect(await mac.desk.sharedConnections()).toEqual([]);
 expect(await mac.desk.syncedShares()).toEqual([]);
 await expect(mac.desk.connectGuest(id)).rejects.toThrow();

 // Case B: durable drop marker committed in localStorage, IndexedDB remove fails -> still hidden & unopenable.
 const w2 = worker(), h2 = host();
 const mac2 = await browser(w2);
 const a2 = await mac2.desk.acceptGuestInvitation(inviteText(h2.relay), "account");
 const id2 = `${h2.relay.hostID}/${a2.guestID}`;
 await mac2.desk.connectGuest(id2);
 w2.seedTombstone(id2, "shares");
 const origRemove = mac2.grants.remove.bind(mac2.grants);
 mac2.grants.remove = async () => { throw new Error("idb remove failed"); };
 await mac2.shares.sync();
 expect((await mac2.desk.state()).phase).toBe("idle");
 expect(await mac2.desk.sharedConnections()).toEqual([]);
 expect(await mac2.desk.syncedShares()).toEqual([]);
 await expect(mac2.desk.connectGuest(id2)).rejects.toThrow();
 // Even a fresh Desk reading the durable localStorage drop marker hides & refuses it.
 mac2.grants.remove = origRemove;
}, CONNECTS_LIMIT_MS);

test("a conflict tombstone preserves the grant-removal obligation across a 410 full pull", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 w.failPush = true;
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 // Inject tombstone at POST dispatch so the put hits a genuine server conflict (deleted=true).
 w.failPush = false;
 w.serverNow += 121_000;
 let conflictPushed = false;
 w.onPush = () => {
  if (!conflictPushed) { conflictPushed = true; w.seedTombstone(id, "shares"); }
 };
 // Hold post-push readback so we observe pendingDrop persisted separately from actionable r.drop.
 const origRemove = mac.grants.remove.bind(mac.grants);
 mac.grants.remove = async () => { throw new Error("transient idb error"); };
 w.onPull = () => { w.onPull = () => { w.failPullSince = 0; }; };
 await mac.shares.sync().catch(() => {});
 expect(conflictPushed).toBe(true);
 const afterConflict = JSON.parse(mac.storage.getItem(SHARES_KEY_PREFIX + "acct") ?? "{}") as { drop?: string[]; pendingDrop?: string[] };
 expect(afterConflict.drop ?? []).toEqual([]);
 expect(afterConflict.pendingDrop ?? []).toContain(id);
 expect((await mac.grants.list()).map(g => `${g.endpoint.hostID}/${g.guestID}`)).toEqual([id]);
 // Now prune tombstone (floor <= rev so ?since=0 succeeds), trigger 410/full pull, and let IndexedDB succeed -> grant is dropped, never stranded.
 w.onPush = null;
 mac.grants.remove = origRemove;
 w.failPullSince = null;
 w.seedPrompt("p-after-conflict", {});
 w.keepTombstones(0);
 w.prune(w.rev);
 await mac.shares.sync();
 expect(await mac.grants.list()).toEqual([]);
}, CONNECTS_LIMIT_MS);

test("Leave stays queued when a 410 full readback restores the share live, and the next sync deletes it again", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 expect(w.sharesIn("acct")).toEqual([id]);
 // Capture the live share body that was stored on the service so our simulated restore puts back a valid body.
 const pulledBefore = JSON.parse(mac.storage.getItem(SHARES_KEY_PREFIX + "acct") ?? "{}") as { shares: { id: string; body: object }[] };
 const liveBody = pulledBefore.shares.find(s => s.id === id)!.body;
 // On the second pull (the post-push readback after DELETE succeeds), simulate a DB restore that
 // brings id back live and raises the floor so the client's incremental ?since=1 hits 410 -> full pull.
 w.onPull = () => {
  w.onPull = () => {
   w.reset();
   w.seedShare(id, liveBody);
   w.seedPrompt("restored-marker", {});
   w.prune(w.rev);
  };
 };
 await mac.desk.forgetGuestConnection(id).catch(() => {});
 // Because the restore revived the share, the delete must STILL be pending.
 const j = journalOf(mac.storage);
 expect(j.pending.some(p => p.id === id && p.deleted === true)).toBe(true);
 expect(w.sharesIn("acct")).toEqual([id]);
 // Next sync sends a second DELETE against the restored revision and removes it from the account.
 w.onPull = null;
 await mac.shares.sync();
 expect(w.sharesIn("acct")).toEqual([]);
 expect(journalOf(mac.storage).pending).toEqual([]);
}, CONNECTS_LIMIT_MS);

test("reconciliation revalidates under the shares lock across 410 lower-revision restores and failed 410 commits", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 const liveBody = (JSON.parse(mac.storage.getItem(SHARES_KEY_PREFIX + "acct") ?? "{}") as { shares: { id: string; body: object }[] }).shares.find(s => s.id === id)!.body;
 // Bump service history so the local live row sits at rev 3.
 w.seedPrompt("bump-1", {});
 w.seedShare(id, liveBody);
 await mac.shares.sync();
 // Part 1: 410/full pull removes the share at rev 1 while localStorage throws QuotaExceededError.
 // The old committed live row is at rev 3 (> 1), yet the mask must STILL hold (hide + refuse).
 w.reset();
 w.seedPrompt("reset-only", {});
 w.prune(w.rev);
 const origSet = mac.storage.setItem.bind(mac.storage);
 const origRemove = mac.grants.remove.bind(mac.grants);
 let failOnce = true;
 mac.storage.setItem = (k, v) => {
  if (failOnce && k === SHARES_KEY_PREFIX + "acct") { failOnce = false; throw new DOMException("quota", "QuotaExceededError"); }
  origSet(k, v);
 };
 // Hold IndexedDB removal so the grant remains present for both the failed-410 refusal checks
 // and Part 2's two-tab lower-revision restore check.
 mac.grants.remove = async () => { throw new Error("transient idb error"); };
 await mac.shares.sync().catch(() => {});
 mac.storage.setItem = origSet;
 mac.grants.remove = origRemove;
 expect(mac.shares.isMasked("acct", id)).toBe(true);
 expect(mac.shares.list()).toEqual([]);
 expect(await mac.desk.sharedConnections()).toEqual([]);
 await expect(mac.desk.connectGuest(id)).rejects.toThrow("no longer saved");
 // Part 2: Tab B completes a 410/full pull restoring the share live at rev 1 (lower than old rev 3!),
 // advancing the monotonic commit seq and liveSeq[id]. Tab A's stale dropLocked must see the newer
 // committed live observation, clear its stale mask, keep the grant, and list the share again.
 const rec = JSON.parse(mac.storage.getItem(SHARES_KEY_PREFIX + "acct") ?? "{}") as { rev: number; seq?: number; liveSeq?: Record<string, number>; shares: { id: string; rev: number; body: object }[]; gone: Record<string, number>; pending: unknown[]; drop?: string[] };
 const nextSeq = (rec.seq ?? 0) + 1;
 rec.rev = 1;
 rec.seq = nextSeq;
 rec.liveSeq = { [id]: nextSeq };
 rec.shares = [{ id, rev: 1, body: liveBody }];
 rec.gone = {};
 rec.drop = [];
 origSet(SHARES_KEY_PREFIX + "acct", JSON.stringify(rec));
 let removed = false;
 await mac.shares.dropLocked("acct", id, async () => { removed = true; await origRemove(id); });
 expect(removed).toBe(false);
 expect(await mac.grants.get(id)).toBeDefined();
 expect(mac.shares.isMasked("acct", id)).toBe(false);
 expect(mac.shares.list().map(s => s.id)).toEqual([id]);
}, CONNECTS_LIMIT_MS);

test("a conflict tombstone does not disconnect a live guest when post-push readback returns a newer live row", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 w.failPush = true;
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 const liveBody = {
  relay: access.endpoint.relay,
  host_id: access.endpoint.hostID,
  node_pub: Buffer.from(access.endpoint.hostPublicKey).toString("base64url"),
  guest_id: access.guestID,
 };
 // Actually connect the guest and wait until the handshake reaches phase === "connected".
 await mac.desk.connectGuest(id);
 for (let i = 0; i < 100 && (await mac.desk.state()).phase !== "connected"; i++) await new Promise(r => setTimeout(r, 10));
 expect((await mac.desk.state()).phase).toBe("connected");
 // Inject tombstone at POST dispatch so the put hits a genuine server conflict (deleted=true),
 // and have the post-push readback return a newer live row. Also check mid-round that r.drop is
 // still empty so another tab cannot prematurely remove the grant before readback.
 w.failPush = false;
 w.serverNow += 121_000;
 let posts = 0;
 let dropDuringReadback: string[] | undefined;
 w.onPush = () => {
  posts++;
  if (posts === 1) w.seedTombstone(id, "shares");
 };
 w.onPull = () => {
  w.onPull = () => {
   dropDuringReadback = mac.shares.dropping("acct");
   w.seedShare(id, liveBody);
  };
 };
 await mac.shares.sync();
 expect(posts).toBe(1);
 expect(dropDuringReadback).toEqual([]);
 // Guest stayed connected throughout and still holds both grant and account listing.
 expect((await mac.desk.state()).phase).toBe("connected");
 expect(await mac.grants.get(id)).toBeDefined();
 expect(mac.shares.list().map(s => s.id)).toEqual([id]);
}, CONNECTS_LIMIT_MS);

test("firstBatch lazily stops before examining entry 101 of a 101-item pending queue", async () => {
 const { firstBatch } = await import("../src/web/account");
 let examined = 0;
 function* gen() {
  for (let i = 0; i < 105; i++) {
   examined++;
   yield { collection: "shares" as const, id: `h/g${i}`, base_rev: 0, deleted: true as const };
  }
 }
 const batch = firstBatch(gen(), c => c);
 expect(batch.length).toBe(100);
 expect(examined).toBe(100);
});

test("retrying an unsent Leave after local grant removal still retries the account deletion", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 // First Leave removes the local grant but fails before pushing DELETE -> throws LeaveUnsent.
 w.failPullSince = 1;
 await expect(mac.desk.forgetGuestConnection(id)).rejects.toThrow(LeaveUnsent);
 expect(await mac.grants.get(id)).toBeUndefined();
 expect(w.sharesIn("acct")).toEqual([id]);
 // Retry while still failing -> MUST still throw LeaveUnsent (not silently succeed as local-only no-op!).
 await expect(mac.desk.forgetGuestConnection(id)).rejects.toThrow(LeaveUnsent);
 // Once the account service recovers, retrying forgetGuestConnection sends the DELETE and removes it.
 w.failPullSince = null;
 await mac.desk.forgetGuestConnection(id);
 expect(w.sharesIn("acct")).toEqual([]);
}, CONNECTS_LIMIT_MS);
