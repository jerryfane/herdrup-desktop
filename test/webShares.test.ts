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
import { createShareSync } from "../src/web/shares";
import { MemoryGrantStore, MemoryOwnerHint } from "../src/web/storage";
import { toB64url } from "../src/webguest/b64url";
import { MemoryIdentityStore } from "../src/webguest/identity";
import { APP_LINK_PREFIX } from "../src/webguest/invite";
import type { StatementSource } from "../src/webguest/owner";
import { memory, worker, type Worker } from "./webAccountService";
import { CONNECTS_LIMIT_MS, startRelay, type HostSession, type TestRelay } from "./webguestResponder";

let relays: TestRelay[] = [];
afterEach(() => { for (const relay of relays) relay.stop(); relays = []; });

/** herdr sharing one agent: the grants it made, bound ones by the statement's account (here the
 *  statement text itself), and every hello it was sent. */
function host() {
 const grants = new Map<string, { account: string | null }>();
 const hellos: Record<string, unknown>[] = [];
 let next = 0;
 const reply = (guestID: string, bound: boolean) => ({
  ok: true, guest_id: guestID, name: "visitor", machine_label: "Mac Studio", owner_name: "Ana", agent: { name: "docs", target: "%7" },
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
 return { relay, grants, hellos };
}

/** The invitation's app link; acct: 1 unless plain. */
function inviteText(relay: TestRelay, acct = true): string {
 const bytes = (n: number, fill: number) => toB64url(new Uint8Array(n).fill(fill));
 const payload = { v: 1, relay: relay.url, host_id: relay.hostID, host_pub: toB64url(relay.hostPublic), invite_id: bytes(16, 3), secret: bytes(32, 4), machine_label: "Mac Studio", owner_name: "Ana", agent_name: "docs", guest_name: "visitor", expires_unix: Math.floor(Date.now() / 1000) + 3600, ...(acct ? { acct: 1 } : {}) };
 return APP_LINK_PREFIX + toB64url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** The account's statement for any machine: its text names the account (the host binds to it). */
const statements = (): StatementSource => ({ get: async () => ({ jws: "statement-of-acct", expMs: Date.now() + 600_000, live: () => true }), drop() {} });

let sessions = 0;
/** One browser of the account: its own session, storage, guest key and grant. Signed out, the
 *  service refuses its cookie. */
async function browser(w: Worker, signedIn = true) {
 const fetcher = w.fetcher(`s${++sessions}`);
 const signedOut = ((input: string | URL | Request, init?: RequestInit) => String(input).includes("/v1/auth/refresh")
  ? Promise.resolve(Response.json({ error: "session_revoked" }, { status: 401 })) : fetcher(input, init)) as typeof fetch;
 const account = new WebAccount(signedIn ? fetcher : signedOut, undefined, undefined, null);
 if (signedIn) await account.check();
 const storage = memory();
 const shares = createShareSync(account, { storage: () => storage, locks: null, name: "Chrome on macOS", background: false });
 const grants = new MemoryGrantStore();
 const desk = createGuestDesk({ identities: new MemoryIdentityStore(), grants, owner: new MemoryOwnerHint(), webSocket: (url) => new WebSocket(url), statements: statements(), shares });
 return { desk, grants, shares, account };
}

const sharesOn = (w: Worker) => w.pushed.flat().filter(c => c.collection === "shares");

test("a bound accept writes the share to the account; another browser of the account opens it with no invite", async () => {
 const w = worker(), h = host();
 const mac = await browser(w), linux = await browser(w);
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 expect(h.hellos[0]!.account).toBe("statement-of-acct");
 expect(mac.grants.access?.accountBound).toBe(true);
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
 expect(linux.grants.access).toMatchObject({ guestID: access.guestID, agentTarget: "%7", machineLabel: "Mac Studio", accountBound: true });
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
 expect(mac.grants.access).toBeUndefined();
 expect(sharesOn(w).at(-1)).toEqual({ collection: "shares", id, base_rev: 1, deleted: true });
 expect(await mac.desk.syncedShares()).toEqual([]);
 await linux.shares.sync();
 expect(linux.grants.access).toBeUndefined();
 expect(await linux.desk.syncedShares()).toEqual([]);
}, CONNECTS_LIMIT_MS);

test("a browser whose put was taken but whose readback failed still drops its bound grant when the share's tombstone comes", async () => {
 const w = worker(), h = host();
 const mac = await browser(w), linux = await browser(w);
 // The put is applied; the pull after it is answered 503: this browser never sees the share live.
 w.failPull = true;
 const access = await mac.desk.acceptGuestInvitation(inviteText(h.relay), "account");
 const id = `${h.relay.hostID}/${access.guestID}`;
 expect([sharesOn(w).length, w.failPull, mac.grants.access?.accountBound]).toEqual([1, false, true]);
 // Another browser of the account opens the synced list and leaves the share.
 await linux.shares.sync();
 await linux.desk.openSyncedShare(id);
 await linux.desk.forgetGuestConnection(id);
 expect(sharesOn(w).at(-1)).toEqual({ collection: "shares", id, base_rev: 1, deleted: true });
 await mac.shares.sync();
 expect(mac.grants.access).toBeUndefined();
 expect(await mac.desk.syncedShares()).toEqual([]);
}, CONNECTS_LIMIT_MS);

test("a plain accept (Only this device, or an invite without acct) writes nothing to the account", async () => {
 const w = worker(), h = host();
 const mac = await browser(w);
 // The invitation says whether it may be added to the account (the choice is offered only then).
 expect([(await mac.desk.inspectGuestInvitation(inviteText(h.relay))).account, (await mac.desk.inspectGuestInvitation(inviteText(h.relay, false))).account]).toEqual([true, false]);
 await mac.desk.acceptGuestInvitation(inviteText(h.relay), "device");
 expect(h.hellos[0]!.account).toBeUndefined();
 expect(mac.grants.access?.accountBound).toBeUndefined();
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
 expect(mac.grants.access?.guestID).toBe(plain.guestID);
 await mac.desk.forgetGuestConnection(id);
 expect(w.pushed.length).toBe(0);
}, CONNECTS_LIMIT_MS);

test("an unknown choice, or Add to my account signed out, redeems nothing", async () => {
 const w = worker(), h = host();
 const mac = await browser(w, false);
 await expect(mac.desk.acceptGuestInvitation(inviteText(h.relay), "both")).rejects.toThrow("Unknown choice");
 await expect(mac.desk.acceptGuestInvitation(inviteText(h.relay), "account")).rejects.toThrow("Signed out");
 expect([h.hellos.length, mac.grants.access]).toEqual([0, undefined]);
}, CONNECTS_LIMIT_MS);
