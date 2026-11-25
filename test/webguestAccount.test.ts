// A guest share bound to a HerdrUp account (herdrup#700 PR 5; AccountService DESIGN §4), against a
// local relay whose host admits as herdr's guest/store.rs admit_in and admit_returning do: the
// invite's "acct", the redemption and returning hellos with "account", the admitted reply's
// statement deadline, the in-band account.refresh before it, and the account refusal codes. A
// plain share and an invite without "acct" go exactly as before.
import { afterEach, expect, jest, test } from "bun:test";
import { GuestError } from "../src/webguest/errors";
import { generateIdentity, MemoryIdentityStore, staticKey } from "../src/webguest/identity";
import { decodeInviteJSON, Invite } from "../src/webguest/invite";
import type { StatementSource } from "../src/webguest/owner";
import { acceptInvite, closeError, guestLink, GuestTransport, REFRESH_AHEAD_MS, type Access } from "../src/webguest/transport";
import { createGuestDesk } from "../src/web/desk";
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

/** Statements jws-1, jws-2, …, each fresh for 600 s, the hosts asked for, and what was dropped. */
function statements(): StatementSource & { issued: number; hosts: string[]; dropped: string[][] } {
 const s = {
  issued: 0, hosts: [] as string[], dropped: [] as string[][],
  async get(host: string) { s.issued++; s.hosts.push(host); return { jws: `jws-${s.issued}`, expMs: Date.now() + 600_000, live: () => true }; },
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
