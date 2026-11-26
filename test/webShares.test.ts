// The web guest's shares on the account (src/web/shares.ts through the guest Desk, desk.ts;
// herdrup#700 step 6): a bound accept writes the account's shares item, another browser of the
// account opens it with no invite, leaving it deletes it on every browser, and a plain accept
// writes nothing. Over a local relay whose host admits as herdr's guest/store.rs does (a
// redemption bound with a statement, a returning hello from any device of the account), and the
// fake account service (webAccountService.ts).
import { afterEach, expect, test } from "bun:test";
import { WebAccount } from "../src/web/account";
import { createGuestDesk } from "../src/web/desk";
import { events } from "../src/web/events";
import { createShareSync, SHARES_KEY_PREFIX } from "../src/web/shares";
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

/** The account's statement for any machine: its text names the account (the host binds to it). */
const statements = (): StatementSource => ({ get: async () => ({ jws: "statement-of-acct", expMs: Date.now() + 600_000, account: "acct", live: () => true }), drop() {} });

let sessions = 0;
/** One browser of the account: its own session, storage, guest key, grant and Web Locks. Signed
 *  out, the service refuses its cookie. Another tab of a browser holds its grants, storage, guest
 *  key and Web Locks (null: a browser without them). */
async function browser(w: Worker, signedIn = true, grants = new MemoryGrantStore(), storage = memory(), identities = new MemoryIdentityStore(), locks: AbortableLocks | null = tabLocks()) {
 const fetcher = w.fetcher(`s${++sessions}`);
 const signedOut = ((input: string | URL | Request, init?: RequestInit) => String(input).includes("/v1/auth/refresh")
  ? Promise.resolve(Response.json({ error: "session_revoked" }, { status: 401 })) : fetcher(input, init)) as typeof fetch;
 const account = new WebAccount(signedIn ? fetcher : signedOut, undefined, undefined, null);
 if (signedIn) await account.check();
 const shares = createShareSync(account, { storage: () => storage, locks, name: "Chrome on macOS", background: false });
 const desk = createGuestDesk({ identities, grants, owner: new MemoryOwnerHint(), webSocket: (url) => new WebSocket(url), statements: statements(), shares });
 return { desk, grants, shares, account, storage, identities };
}

const sharesOn = (w: Worker) => w.pushed.flat().filter(c => c.collection === "shares");

/** A browser's Web Locks: one holder per name, the others waiting their turn in order. */
function tabLocks(): AbortableLocks {
 const tails = new Map<string, Promise<unknown>>();
 const request = <T>(name: string, ...args: [() => Promise<T>] | [{ signal?: AbortSignal }, () => Promise<T>]): Promise<T> => {
  const callback = args.length === 1 ? args[0] : args[1];
  const turn = (tails.get(name) ?? Promise.resolve()).then(() => callback());
  tails.set(name, turn.catch(() => {}));
  return turn;
 };
 return { request } as AbortableLocks;
}

/** Two tabs of one browser (sharing locks) with 100 share puts kept while the service was out,
 *  then a bound share accepted, its put the 101st: the second push's. Tab a's sync has sent its
 *  first push, applied and its answer held until release. */
async function leaveDuringBatch() {
 const w = worker(), h = host(), locks = tabLocks();
 const storage = memory(), grants = new MemoryGrantStore(), identities = new MemoryIdentityStore();
 const a = await browser(w, true, grants, storage, identities, locks), b = await browser(w, true, grants, storage, identities, locks);
 const guest = (n: number) => toB64url(new Uint8Array(16).fill(100 + n));
 const queued = Array.from({ length: 100 }, (_, n) => ({ id: `host/${guest(n)}`, body: { relay: "wss://relay.example", host_id: "host", node_pub: toB64url(new Uint8Array(32).fill(1)), guest_id: guest(n) } }));
 storage.setItem(SHARES_KEY_PREFIX + "acct", JSON.stringify({ rev: 0, shares: [], gone: {}, pending: queued }));
 w.failPush = true;
 const access = await b.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 w.failPush = false;
 const answer = Promise.withResolvers<void>();
 w.holdAnswer = answer.promise;
 const before = w.pushed.length;
 const synced = a.shares.sync();
 while (w.pushed.length === before) await Bun.sleep(1);
 const id = `${h.relay.hostID}/${access.guestID}`;
 /** What was sent for the share since a's first push. */
 const sentSince = () => w.pushed.slice(before).flat().filter(c => c.id === id).map(c => c.deleted ? "delete" : "put");
 return { w, a, b, id, grants, synced, release: () => answer.resolve(), firstPush: before + 1, sentSince };
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
 const left = t.b.desk.forgetGuestConnection(t.id);
 while ((await t.grants.list()).length > 0) await Bun.sleep(1);
 await Bun.sleep(20);
 // The leaving tab sends nothing while the other's round is still answering.
 expect(t.w.pushed.length).toBe(t.firstPush);
 t.release();
 await Promise.all([t.synced, left]);
 await t.a.shares.sync();
 await t.b.shares.sync();
 expect([await t.grants.list(), t.w.sharesIn("acct").includes(t.id), t.w.sharesIn("acct").length, t.sentSince()]).toEqual([[], false, 100, ["delete"]]);
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
 grants.failNext = true;
 await expect(mac.desk.forgetGuestConnection(id)).rejects.toThrow("aborted");
 expect([w.sharesIn("acct"), sharesOn(w).at(-1), await grants.list(), (await mac.desk.state()).phase]).toEqual([[], { collection: "shares", id, base_rev: 1, deleted: true }, [], "idle"]);
}, CONNECTS_LIMIT_MS);

test("a browser whose put was taken but whose readback failed still drops its bound grant when the share's tombstone comes", async () => {
 const w = worker(), h = host();
 const mac = await browser(w), linux = await browser(w);
 // The put is applied; the pull after it is answered 503: this browser never sees the share live.
 w.failPull = true;
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

/** A browser's grant store (IndexedDB) whose next removal fails, as a transaction may once. */
class FlakyGrants extends MemoryGrantStore {
 failNext = false;
 override async remove(id: string) {
  if (this.failNext) { this.failNext = false; throw new DOMException("The transaction was aborted.", "AbortError"); }
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
 grants.failNext = true;
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
 // Another device of the account rewrites the share (revision 2) before this browser pulls it.
 w.seedShare(id, { relay: h.relay.url, host_id: h.relay.hostID, node_pub: toB64url(h.relay.hostPublic), guest_id: access.guestID, agent_name: "docs (renamed)" });
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
 // Left under B: deleted from A alone, at A's next sync here.
 await switchTo("acct-b");
 await mac.desk.forgetGuestConnection(id);
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
 // leave not yet sent: the leave still goes, and the refused put alone is dropped.
 w.failPush = true;
 await mac.desk.forgetGuestConnection(id);
 w.failPush = false;
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
 // The first push is applied and its answer lost: it stays for the next round, and the second still goes and settles.
 w.losePush = true;
 await expect(mac.shares.sync()).rejects.toThrow();
 expect([w.tooLarge, w.pushed.map(p => p.length), w.sharesIn("acct").length]).toEqual([0, [100, 1], 101]);
 const kept: { pending: { id: string }[] } = JSON.parse(mac.storage.getItem(key)!);
 expect(kept.pending.map(p => p.id)).toEqual(pending.slice(0, 100).map(p => p.id));
 await mac.shares.sync();
 const after: { pending: object[] } = JSON.parse(mac.storage.getItem(key)!);
 expect([w.tooLarge, w.pushed.slice(2).map(p => p.length), after.pending, mac.shares.list().length]).toEqual([0, [100], [], 101]);
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
