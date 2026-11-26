// A guest share bound to a HerdrUp account (herdrup#700 PR 5; AccountService DESIGN §4), against a
// local relay whose host admits as herdr's guest/store.rs admit_in and admit_returning do: the
// invite's "acct", the redemption and returning hellos with "account", the admitted reply's
// statement deadline, the in-band account.refresh before it, and the account refusal codes. A
// plain share and an invite without "acct" go exactly as before.
import { afterEach, expect, jest, test } from "bun:test";
import { GuestError } from "../src/webguest/errors";
import { generateIdentity, MemoryIdentityStore, staticKey } from "../src/webguest/identity";
import { decodeInviteJSON, Invite } from "../src/webguest/invite";
import { REFRESH_AHEAD_MS, type StatementSource } from "../src/webguest/accountStatement";
import { acceptInvite, closeError, guestLink, GuestTransport, openShare, type Access } from "../src/webguest/transport";
import { AccountServiceError, SignedOutError } from "../src/web/account";
import { createGuestDesk } from "../src/web/desk";
import { events } from "../src/web/events";
import { boundShareStatements, statementCache } from "../src/web/statements";
import { MemoryGrantStore, MemoryOwnerHint } from "../src/web/storage";
import { CONNECTS_LIMIT_MS, startRelay, type HostSession, type TestRelay } from "./webguestResponder";

let relays: TestRelay[] = [];
afterEach(() => {
 jest.useRealTimers();
 for (const relay of relays) relay.stop();
 relays = [];
});
const relayWith = (serve: Parameters<typeof startRelay>[0]["serve"]) => { const relay = startRelay({ admit: () => undefined, serve }); relays.push(relay); return relay; };
const endpointOf = (relay: TestRelay) => ({ relay: relay.url, hostID: relay.hostID, hostPublicKey: relay.hostPublic });
const identity = async () => staticKey(await generateIdentity());

/** Statements jws-1, jws-2, …, each fresh for 600 s and live while the sign-in it was issued in
 *  lasts (switchAccount starts another), the hosts asked for, and what was dropped. afterGet runs
 *  once a statement is issued, before it is handed over. */
function statements(): StatementSource & { issued: number; hosts: string[]; dropped: string[][]; session: number; switchAccount(): void; afterGet: ((n: number) => void) | null } {
 const s = {
  issued: 0, hosts: [] as string[], dropped: [] as string[][], session: 1, afterGet: null as ((n: number) => void) | null,
  switchAccount() { s.session++; },
  async get(host: string) {
   s.issued++; s.hosts.push(host);
   const mine = s.session;
   const got = { jws: `jws-${s.issued}`, expMs: Date.now() + 600_000, live: () => s.session === mine };
   s.afterGet?.(s.issued);
   return got;
  },
  drop(host: string, jws: string) { s.dropped.push([host, jws]); },
 };
 return s;
}

/** herdr's admitted reply; with deadlineUnix, an account-bound session's (guest/mod.rs admit_with). */
const admitted = (deadlineUnix?: number) => ({
 ok: true, guest_id: "grant-1", name: "visitor", machine_label: "Machine", owner_name: "Owner", agent: { name: "Worker", target: "%42" },
 features: { gram: false, push: true, multi_request: true }, ...(deadlineUnix === undefined ? {} : { account: { deadline_unix: deadlineUnix } }),
});

async function ping(session: HostSession) {
 const req = JSON.parse((await session.readLine())!) as { id: string };
 session.write(JSON.stringify({ id: req.id, result: { type: "pong" } }) + "\n");
}

const inviteFor = (relay: TestRelay, accounts: boolean) =>
 new Invite(endpointOf(relay), "Machine", "Owner", "Worker", "visitor", new Date(Date.now() + 60_000), "invitation", "one-use-bearer", accounts);
const accessOn = (relay: TestRelay, accountBound?: boolean): Access => ({
 guestID: "grant-1", guestName: "visitor", machineLabel: "Machine", ownerName: "Owner", agentName: "Worker", agentTarget: "%42",
 endpoint: endpointOf(relay), acceptedAt: new Date(1_000), ...(accountBound === undefined ? {} : { accountBound }),
});

// ---- The invite's capability ----

test("an invite's acct: 1 offers account binding; without it, or with another number, it doesn't; a non-number isn't an invite", () => {
 const encoded = (size: number) => Buffer.from(new Uint8Array(size).fill(7)).toString("base64url");
 const fields: Record<string, unknown> = { v: 1, relay: "https://relay.example", host_id: encoded(16), host_pub: encoded(32), invite_id: encoded(16), secret: encoded(32), machine_label: "Mac", owner_name: "Owner", agent_name: "Agent", guest_name: "guest-1", expires_unix: 1_900_000_000 };
 const decode = () => decodeInviteJSON(new TextEncoder().encode(JSON.stringify(fields)));
 expect(decode().accounts).toBe(false);
 fields.acct = 1;
 expect(decode().accounts).toBe(true);
 fields.ACCT = 1; delete fields.acct; // matched case-insensitively, as Go's encoding/json does
 expect(decode().accounts).toBe(true);
 delete fields.ACCT;
 for (const [value, accounts] of [[2, false], [0, false], [null, false]] as const) {
  fields.acct = value;
  expect([value, decode().accounts]).toEqual([value, accounts]);
 }
 for (const value of ["1", true, 1.5]) {
  fields.acct = value;
  expect(() => decode()).toThrow(GuestError);
 }
});

// ---- Redemption ----

test("Add to my account: the redemption hello carries the account's statement for the host, and the grant is saved bound", async () => {
 const hellos: Record<string, unknown>[] = [];
 const relay = relayWith(async (_conn, handshake) => {
  const h = await handshake();
  hellos.push(h.hello);
  h.reply(admitted(Math.floor(Date.now() / 1000) + 660));
 });
 const s = statements();
 const access = await acceptInvite(inviteFor(relay, true), await identity(), "Browser", { account: s });
 expect(hellos).toEqual([{ v: 1, invite_id: "invitation", secret: "one-use-bearer", device: "Browser", account: "jws-1" }]);
 expect(s.hosts).toEqual([relay.hostID]);
 expect(access.accountBound).toBe(true);
}, CONNECTS_LIMIT_MS);

test("Only this device, an invite without acct, or a host that didn't bind: the redemption is plain, as before", async () => {
 const hellos: Record<string, unknown>[] = [];
 let bind = false;
 const relay = relayWith(async (_conn, handshake) => {
  const h = await handshake();
  hellos.push(h.hello);
  h.reply(admitted(bind ? Math.floor(Date.now() / 1000) + 660 : undefined));
 });
 const plain = { guestID: "grant-1", guestName: "visitor", machineLabel: "Machine", ownerName: "Owner", agentName: "Worker", agentTarget: "%42", endpoint: endpointOf(relay), acceptedAt: new Date(5_000) };
 const s = statements();
 // Only this device: no statements given.
 expect(await acceptInvite(inviteFor(relay, true), await identity(), "Browser", { now: 5_000 })).toEqual(plain);
 // An older invite (no acct): statements given are not used.
 bind = true;
 expect(await acceptInvite(inviteFor(relay, false), await identity(), "Browser", { now: 5_000, account: s })).toEqual(plain);
 // An older herdr that ignores the statement admits without a deadline: not bound.
 bind = false;
 expect(await acceptInvite(inviteFor(relay, true), await identity(), "Browser", { now: 5_000, account: s })).toEqual(plain);
 expect(hellos.map(h => h.account ?? null)).toEqual([null, null, "jws-1"]);
 expect(s.issued).toBe(1);
}, CONNECTS_LIMIT_MS);

test("a redemption whose statement was refused as expired goes once more with a fresh one; the invite is still unused", async () => {
 const accounts: unknown[] = [];
 let refuse = 1;
 const relay = relayWith(async (_conn, handshake) => {
  const h = await handshake();
  accounts.push(h.hello.account);
  if (refuse-- > 0) { h.reply({ ok: false, error: "statement_expired" }); return; }
  h.reply(admitted(Math.floor(Date.now() / 1000) + 660));
 });
 const s = statements();
 expect((await acceptInvite(inviteFor(relay, true), await identity(), "Browser", { account: s })).accountBound).toBe(true);
 expect([accounts, s.dropped]).toEqual([["jws-1", "jws-2"], [[relay.hostID, "jws-1"]]]);
 refuse = 2;
 const error = await acceptInvite(inviteFor(relay, true), await identity(), "Browser", { account: s }).catch(e => e);
 expect((error as GuestError).kind).toBe("statement_expired");
 expect(accounts.length).toBe(4);
}, CONNECTS_LIMIT_MS);

test("every statement a host refuses as stale is dropped, a retry's too: the next connect asks for a fresh one", async () => {
 const accounts: unknown[] = [];
 const relay = relayWith(async (_conn, handshake) => {
  const h = await handshake();
  accounts.push(h.hello.account);
  h.reply({ ok: false, error: "statement_expired" });
 });
 /** As the page's cache (statements.ts): the statement held is given again until dropped. */
 const cache = (): StatementSource => {
  let held: string | null = null, issued = 0;
  return {
   get: async () => ({ jws: held ??= `jws-${++issued}`, expMs: Date.now() + 600_000, account: "acct", live: () => true }),
   drop(_host, jws) { if (held === jws) held = null; },
  };
 };
 const key = await identity();
 const opens: ((s: StatementSource) => Promise<unknown>)[] = [
  s => acceptInvite(inviteFor(relay, true), key, "Browser", { account: s }),
  s => openShare(accessOn(relay), key, s),
  s => { const t = new GuestTransport(guestLink(accessOn(relay, true), s), key); return t.call("ping").finally(() => t.close()); },
 ];
 for (const open of opens) {
  accounts.length = 0;
  const s = cache();
  for (let i = 0; i < 2; i++) expect(((await open(s).catch(e => e)) as GuestError).kind).toBe("statement_expired");
  // Each open tries once more with a fresh statement; neither reuses one the host refused.
  expect(accounts).toEqual(["jws-1", "jws-2", "jws-3", "jws-4"]);
 }
}, CONNECTS_LIMIT_MS);

// ---- Returning ----

test("a bound share's returning hello carries the statement; a plain one's is {v, guest_id} even with statements at hand", async () => {
 const hellos: Record<string, unknown>[] = [];
 const relay = relayWith(async (_conn, handshake) => {
  const h = await handshake();
  hellos.push(h.hello);
  await ping(h.reply(admitted(h.hello.account === undefined ? undefined : Math.floor(Date.now() / 1000) + 660)));
 });
 const s = statements();
 for (const bound of [true, false, undefined]) {
  const transport = new GuestTransport(guestLink(accessOn(relay, bound), s), await identity());
  expect(await transport.call("ping")).toEqual({ type: "pong" });
  transport.close();
 }
 expect(hellos).toEqual([{ v: 1, guest_id: "grant-1", account: "jws-1" }, { v: 1, guest_id: "grant-1" }, { v: 1, guest_id: "grant-1" }]);
 expect(s.issued).toBe(1);
}, CONNECTS_LIMIT_MS);

test("the guest Desk connects a saved bound share with the page's statements", async () => {
 const hello = Promise.withResolvers<Record<string, unknown>>();
 const relay = relayWith(async (_conn, handshake) => {
  const h = await handshake();
  hello.resolve(h.hello);
  await ping(h.reply(admitted(Math.floor(Date.now() / 1000) + 660)));
 });
 const identities = new MemoryIdentityStore();
 await identities.add(await generateIdentity());
 const grants = new MemoryGrantStore();
 await grants.put(accessOn(relay, true));
 const desk = createGuestDesk({ identities, grants, owner: new MemoryOwnerHint(), webSocket: (url) => new WebSocket(url), statements: statements() });
 const id = `${relay.hostID}/grant-1`;
 await desk.connectGuest(id);
 expect(await hello.promise).toEqual({ v: 1, guest_id: "grant-1", account: "jws-1" });
 await desk.forgetGuestConnection(id);
}, CONNECTS_LIMIT_MS);

test("a bound share with no account statements to give is account_required, and nothing is dialed", async () => {
 const relay = relayWith(async () => {});
 const transport = new GuestTransport(guestLink(accessOn(relay, true)), await identity());
 const error = await transport.call("ping").catch(e => e);
 expect([(error as GuestError).kind, relay.connects]).toEqual(["account_required", 0]);
 transport.close();
});

// ---- In-session refresh ----

// Fake timers and the transport's clock: the refresh is due REFRESH_AHEAD_MS before the deadline,
// 30 s after the connect here (short of the idle session's 50 s), and goes as one whole message.
test("before the statement's deadline a bound session sends a fresh statement in-band, not earlier", async () => {
 let clock = 1_800_000_000_000;
 jest.useFakeTimers();
 const host = Promise.withResolvers<HostSession>();
 const relay = relayWith(async (_conn, handshake) => {
  const session = (await handshake()).reply(admitted(clock / 1000 + 150));
  await ping(session);
  host.resolve(session);
 });
 const s = statements();
 const transport = new GuestTransport(guestLink(accessOn(relay, true), s), await identity(), { now: () => clock });
 expect(await transport.call("ping")).toEqual({ type: "pong" });
 const session = await host.promise;
 const due = 150_000 - REFRESH_AHEAD_MS;
 clock += due - 1;
 jest.advanceTimersByTime(due - 1);
 expect(s.issued).toBe(1);
 clock += 1;
 jest.advanceTimersByTime(1);
 expect(s.issued).toBe(2);
 expect(JSON.parse((await session.readMessage())!)).toEqual({ t: "account.refresh", account: "jws-2" });
 transport.close();
}, CONNECTS_LIMIT_MS);

test("a plain session never sends account.refresh, whatever the reply says", async () => {
 let clock = 1_800_000_000_000;
 jest.useFakeTimers();
 const host = Promise.withResolvers<HostSession>();
 const relay = relayWith(async (_conn, handshake) => {
  const session = (await handshake()).reply(admitted(clock / 1000 + 150));
  await ping(session);
  host.resolve(session);
 });
 const s = statements();
 const transport = new GuestTransport(guestLink(accessOn(relay), s), await identity(), { now: () => clock });
 expect(await transport.call("ping")).toEqual({ type: "pong" });
 const session = await host.promise;
 clock += 40_000;
 jest.advanceTimersByTime(40_000);
 expect(s.issued).toBe(0);
 // The idle session carries the next call: its next message is the request, not a refresh.
 const next = transport.call("ping");
 expect(await session.readLine()).toContain("ping");
 transport.close();
 await next.catch(() => {});
}, CONNECTS_LIMIT_MS);

// ---- Refusals ----

const CODES = ["account_required", "account_mismatch", "statement_invalid", "statement_expired", "account_keys_stale", "device_removed", "accounts_disabled"] as const;

test.each(CODES)("a bound share's hello refused with %s reads as its own error, worded plainly", async (code) => {
 const relay = relayWith(async (_conn, handshake) => { (await handshake()).reply({ ok: false, error: code }); });
 const transport = new GuestTransport(guestLink(accessOn(relay, true), statements()), await identity());
 const error = await transport.call("ping").catch(e => e);
 expect(error).toBeInstanceOf(GuestError);
 expect((error as GuestError).kind).toBe(code);
 expect((error as GuestError).message).not.toContain("_");
 transport.close();
}, CONNECTS_LIMIT_MS);

test("each account code as a session's close reason reads as that code's error; the messages are all different", () => {
 const errors = CODES.map(code => closeError(1000, code)!);
 expect(errors.map(e => e.kind)).toEqual([...CODES]);
 expect(new Set(errors.map(e => e.message)).size).toBe(CODES.length);
 expect(closeError(1000, "")).toBeNull();
});

test("a bound session the host closes with statement_expired fails its call with that error", async () => {
 const relay = relayWith(async (conn, handshake) => {
  const session = (await handshake()).reply(admitted(Math.floor(Date.now() / 1000) + 660));
  await session.readLine();
  conn.close(1000, "statement_expired");
 });
 const transport = new GuestTransport(guestLink(accessOn(relay, true), statements()), await identity());
 const error = await transport.call("ping").catch(e => e);
 expect((error as GuestError).kind).toBe("statement_expired");
 transport.close();
}, CONNECTS_LIMIT_MS);

test("a statement_expired close says neither a statement nor a grant (an owner's grant ends with it too)", () => {
 expect(closeError(1000, "statement_expired")!.message).toBe("The shared machine ended the connection when its authorization expired. Try again.");
});

// ---- One sign-in per redemption and per link (#518 review) ----

const CHANGED = "Your HerdrUp account changed; open the invite again";
const kindAndMessage = (error: unknown) => error instanceof GuestError ? [error.kind, error.message] : [String(error)];

test("a redemption whose sign-in changed before its retry sends nothing more: herdr would bind the invite to the other account", async () => {
 const s = statements();
 const hellos: unknown[] = [];
 const relay = relayWith(async (_conn, handshake) => {
  const h = await handshake();
  hellos.push(h.hello.account);
  // The page signs in to another account while the first reply is on its way.
  s.switchAccount();
  h.reply({ ok: false, error: "statement_expired" });
 });
 const error = await acceptInvite(inviteFor(relay, true), await identity(), "Browser", { account: s }).catch(e => e);
 expect(kindAndMessage(error)).toEqual(["account_changed", CHANGED]);
 expect([hellos, s.issued, relay.connects]).toEqual([["jws-1"], 1, 1]);
}, CONNECTS_LIMIT_MS);

test("a redemption whose sign-in changed while its retry's statement was fetched sends nothing more", async () => {
 const s = statements();
 s.afterGet = n => { if (n === 2) s.switchAccount(); };
 const relay = relayWith(async (_conn, handshake) => { (await handshake()).reply({ ok: false, error: "statement_expired" }); });
 const error = await acceptInvite(inviteFor(relay, true), await identity(), "Browser", { account: s }).catch(e => e);
 expect(kindAndMessage(error)).toEqual(["account_changed", CHANGED]);
 expect(relay.connects).toBe(1);
}, CONNECTS_LIMIT_MS);

// A failed sign-out that restores the same account while a returning hello waits on a refusal:
// the share may well be this account's, so the retry stops on the changed sign-in, not on whose
// share it is (herdr alone says that: account_mismatch).
const SIGN_IN_CHANGED = ["sign_in_changed", "Your HerdrUp sign-in changed. Try again."];

test("a bound share's returning hello whose sign-in changed before its retry, within one connect, sends nothing more", async () => {
 const s = statements();
 const hellos: unknown[] = [];
 const relay = relayWith(async (_conn, handshake) => {
  const h = await handshake();
  hellos.push(h.hello.account);
  s.switchAccount();
  h.reply({ ok: false, error: "statement_invalid" });
 });
 const transport = new GuestTransport(guestLink(accessOn(relay, true), s), await identity());
 const error = await transport.call("ping").catch(e => e);
 expect(kindAndMessage(error)).toEqual(SIGN_IN_CHANGED);
 // Not even a statement is asked for under the other sign-in.
 expect([hellos, relay.connects, s.issued]).toEqual([["jws-1"], 1, 1]);
 transport.close();
}, CONNECTS_LIMIT_MS);

test("a bound share's retry whose sign-in changed while its statement was fetched isn't sent", async () => {
 const s = statements();
 s.afterGet = n => { if (n === 2) s.switchAccount(); };
 const relay = relayWith(async (_conn, handshake) => { (await handshake()).reply({ ok: false, error: "statement_expired" }); });
 const transport = new GuestTransport(guestLink(accessOn(relay, true), s), await identity());
 expect(kindAndMessage(await transport.call("ping").catch(e => e))).toEqual(SIGN_IN_CHANGED);
 expect(relay.connects).toBe(1);
 transport.close();
}, CONNECTS_LIMIT_MS);

/** s whose retry lookup (its second) rejects as the page's statement cache does once the sign-in
 *  changed under it (409 account_changed); switch says whether the sign-in did change. */
const rejectingRetry = (s: ReturnType<typeof statements>, switchFirst: boolean): StatementSource => ({
 get: async (host, minLeft, signal) => {
  if (s.issued === 1) { s.issued++; if (switchFirst) s.switchAccount(); throw new AccountServiceError(409, "account_changed"); }
  return s.get(host, minLeft, signal);
 },
 drop: (host, jws) => s.drop(host, jws),
});

test("a bound share's retry whose lookup fails as the sign-in changes under it reads as the changed sign-in; the same failure under the same sign-in stays its own", async () => {
 const relay = relayWith(async (_conn, handshake) => { (await handshake()).reply({ ok: false, error: "statement_expired" }); });
 for (const [switched, want] of [[true, SIGN_IN_CHANGED], [false, ["other", "account service: 409 account_changed"]]] as const) {
  const transport = new GuestTransport(guestLink(accessOn(relay, true), rejectingRetry(statements(), switched)), await identity());
  expect(kindAndMessage(await transport.call("ping").catch(e => e))).toEqual([...want]);
  transport.close();
 }
 expect(relay.connects).toBe(2);
}, CONNECTS_LIMIT_MS);

test("a redemption's retry whose lookup fails as the sign-in changes under it sends nothing more", async () => {
 const relay = relayWith(async (_conn, handshake) => { (await handshake()).reply({ ok: false, error: "statement_expired" }); });
 const error = await acceptInvite(inviteFor(relay, true), await identity(), "Browser", { account: rejectingRetry(statements(), true) }).catch(e => e);
 expect(kindAndMessage(error)).toEqual(["account_changed", CHANGED]);
 expect(relay.connects).toBe(1);
}, CONNECTS_LIMIT_MS);

test("a bound share's retry lookup cancelled by its call stays a cancellation, though the sign-in changed too", async () => {
 const relay = relayWith(async (_conn, handshake) => { (await handshake()).reply({ ok: false, error: "statement_expired" }); });
 const s = statements(), call = new AbortController();
 const cancelled: StatementSource = {
  get: async (host, minLeft, signal) => {
   if (s.issued === 1) { s.issued++; s.switchAccount(); call.abort(new Error("sheet dismissed")); throw signal.reason; }
   return s.get(host, minLeft, signal);
  },
  drop: (host, jws) => s.drop(host, jws),
 };
 const transport = new GuestTransport(guestLink(accessOn(relay, true), cancelled), await identity());
 expect(kindAndMessage(await transport.call("ping", {}, { signal: call.signal }).catch(e => e))).toEqual(["other", "sheet dismissed"]);
 transport.close();
}, CONNECTS_LIMIT_MS);

test("herdr's account_mismatch says whose share it is", async () => {
 const relay = relayWith(async (_conn, handshake) => { (await handshake()).reply({ ok: false, error: "account_mismatch" }); });
 const transport = new GuestTransport(guestLink(accessOn(relay, true), statements()), await identity());
 expect(kindAndMessage(await transport.call("ping").catch(e => e))).toEqual(["account_mismatch", "This share belongs to another HerdrUp account. Sign in to that account to open it."]);
 transport.close();
}, CONNECTS_LIMIT_MS);

// A sign-out the service refused (a 503), then the same account restored: the page's sign-in is a
// new one. The saved share's next connect takes its statement, and herdr checks the account.
test("a saved share's next connect after its sign-in ended and came back goes with the current statement", async () => {
 const s = statements();
 const hellos: unknown[] = [];
 const relay = relayWith(async (_conn, handshake) => {
  const h = await handshake();
  hellos.push(h.hello.account);
  const session = h.reply({ ...admitted(Math.floor(Date.now() / 1000) + 660), features: { gram: false, push: true, multi_request: false } });
  await ping(session);
 });
 const transport = new GuestTransport(guestLink(accessOn(relay, true), s), await identity());
 expect(await transport.call("ping")).toEqual({ type: "pong" });
 s.switchAccount();
 expect(await transport.call("ping")).toEqual({ type: "pong" });
 expect([hellos, relay.connects]).toEqual([["jws-1", "jws-2"], 2]);
 transport.close();
}, CONNECTS_LIMIT_MS);

test("a bound session whose sign-in changed sends no refresh: its next message is the request", async () => {
 let clock = 1_800_000_000_000;
 jest.useFakeTimers();
 const host = Promise.withResolvers<HostSession>();
 const relay = relayWith(async (_conn, handshake) => {
  const session = (await handshake()).reply(admitted(clock / 1000 + 150));
  await ping(session);
  host.resolve(session);
 });
 const s = statements();
 const transport = new GuestTransport(guestLink(accessOn(relay, true), s), await identity(), { now: () => clock });
 expect(await transport.call("ping")).toEqual({ type: "pong" });
 const session = await host.promise;
 s.switchAccount();
 clock += 150_000 - REFRESH_AHEAD_MS;
 jest.advanceTimersByTime(150_000 - REFRESH_AHEAD_MS);
 expect(s.issued).toBe(1);
 const next = transport.call("ping");
 expect(await session.readLine()).toContain("ping");
 transport.close();
 await next.catch(() => {});
}, CONNECTS_LIMIT_MS);

// ---- Signed out at a bound share (#518 review) ----

/** The page's statement cache over an account whose session lookup fails with error. */
const cacheFailing = (error: Error) => statementCache({
 currentAccount: async () => { throw error; }, current: null, generation: 0, onSessionChange: () => () => {},
 statements: async () => { throw new Error("never asked"); },
});

test("signed out, a bound share's hello is account_required, and nothing is dialed; another failure of the service stays its own", async () => {
 const relay = relayWith(async () => {});
 const signedOut = new GuestTransport(guestLink(accessOn(relay, true), boundShareStatements(cacheFailing(new SignedOutError()))), await identity());
 expect(kindAndMessage(await signedOut.call("ping").catch(e => e))).toEqual(["account_required", "Sign in to the HerdrUp account that holds this share."]);
 signedOut.close();
 const down = new AccountServiceError(503, "unavailable");
 const unavailable = new GuestTransport(guestLink(accessOn(relay, true), boundShareStatements(cacheFailing(down))), await identity());
 expect(((await unavailable.call("ping").catch(e => e)) as { error: unknown }).error).toBe(down);
 unavailable.close();
 expect(relay.connects).toBe(0);
});

test("the guest Desk tells a signed-out browser to sign in to the account that holds the share", async () => {
 const relay = relayWith(async () => {});
 const identities = new MemoryIdentityStore();
 await identities.add(await generateIdentity());
 const grants = new MemoryGrantStore();
 await grants.put(accessOn(relay, true));
 const desk = createGuestDesk({ identities, grants, owner: new MemoryOwnerHint(), webSocket: (url) => new WebSocket(url), statements: cacheFailing(new SignedOutError()) });
 const told = Promise.withResolvers<string>();
 const off = events.stateChanged.on(s => { if (s.message) told.resolve(s.message); });
 const id = `${relay.hostID}/grant-1`;
 await desk.connectGuest(id);
 expect(await told.promise).toContain("Sign in to the HerdrUp account that holds this share.");
 off();
 await desk.forgetGuestConnection(id);
 expect(relay.connects).toBe(0);
});
