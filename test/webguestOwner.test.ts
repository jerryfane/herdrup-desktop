// An owner browser's transport (src/webguest/owner.ts over transport.ts) against a local relay
// whose host admits as herdr's guest/owner.rs does: an owner hello with a statement, the reply
// with the statement's deadline, the refusal codes, and the in-band account.refresh.
import { expect, test } from "bun:test";
import { generateIdentity, staticKey } from "../src/webguest/identity";
import { ownerLink, type StatementSource } from "../src/webguest/owner";
import { GuestTransport } from "../src/webguest/transport";
import { GuestError } from "../src/webguest/errors";
import { statementCache } from "../src/web/statements";
import { startRelay, type HostSession, type TestRelay } from "./webguestResponder";

/** Statements jws-1, jws-2, …, each fresh for 600 s, and what was dropped. */
function statements(): StatementSource & { issued: number; dropped: string[] } {
 const s = {
  issued: 0, dropped: [] as string[],
  async get() { s.issued++; return { jws: `jws-${s.issued}`, expMs: Date.now() + 600_000 }; },
  drop(host: string) { s.dropped.push(host); },
 };
 return s;
}

const ownerReply = (deadlineUnix: number) => ({ ok: true, mode: "owner", grant_id: "g1", scope: "chat", expires_unix: 1_800_000_000, machine_label: "dev2306",
 account: { deadline_unix: deadlineUnix }, features: { owner: 2, multi_request: true } });

async function ping(session: HostSession) {
 const line = await session.readLine();
 const req = JSON.parse(line!) as { id: string };
 session.write(JSON.stringify({ id: req.id, result: { type: "pong" } }) + "\n");
}

function relayWith(serve: Parameters<typeof startRelay>[0]["serve"]): TestRelay {
 return startRelay({ serve });
}

const endpointOf = (relay: TestRelay) => ({ relay: relay.url, hostID: relay.hostID, hostPublicKey: relay.hostPublic });

test("an owner hello carries the browser's statement and name; only an owner reply is taken", async () => {
 const hellos: Record<string, unknown>[] = [];
 let mode = "owner";
 const relay = relayWith(async (_conn, handshake) => {
  const h = await handshake();
  hellos.push(h.hello);
  await ping(h.reply({ ...ownerReply(Math.floor(Date.now() / 1000) + 660), mode }));
 });
 try {
  const s = statements();
  const transport = new GuestTransport(ownerLink(endpointOf(relay), "Chrome on macOS", s), staticKey(await generateIdentity()));
  expect(await transport.call("ping")).toEqual({ type: "pong" });
  expect(hellos).toEqual([{ v: 1, mode: "owner", account: "jws-1", device: "Chrome on macOS" }]);
  transport.close();
  mode = "";
  const guestish = new GuestTransport(ownerLink(endpointOf(relay), "Chrome on macOS", s), staticKey(await generateIdentity()));
  await expect(guestish.call("ping")).rejects.toThrow("owner");
  guestish.close();
 } finally { relay.stop(); }
});

test("refusals: no grant or an ended one is a revocation, the cap is its own message", async () => {
 let code = "owner_not_granted";
 const relay = relayWith(async (_conn, handshake) => { (await handshake()).reply({ ok: false, error: code }); });
 try {
  const kind = async () => {
   const t = new GuestTransport(ownerLink(endpointOf(relay), "x", statements()), staticKey(await generateIdentity()));
   try { await t.call("ping"); return "accepted"; } catch (e) { return e instanceof GuestError ? `${e.kind}: ${e.message}` : String(e); } finally { t.close(); }
  };
  expect(await kind()).toMatch(/^revoked: .*isn't approved/);
  code = "owner_expired";
  expect(await kind()).toMatch(/^revoked: .*ended/);
  code = "owner_busy";
  expect(await kind()).toMatch(/^other: .*too many connections/);
 } finally { relay.stop(); }
});

test("a refused statement is dropped and the hello tried once more with a fresh one, not again after that", async () => {
 let refuse = 1;
 const hellos: unknown[] = [];
 const relay = relayWith(async (_conn, handshake) => {
  const h = await handshake();
  hellos.push(h.hello.account);
  if (refuse-- > 0) { h.reply({ ok: false, error: "statement_expired" }); return; }
  await ping(h.reply(ownerReply(Math.floor(Date.now() / 1000) + 660)));
 });
 try {
  const s = statements();
  const t = new GuestTransport(ownerLink(endpointOf(relay), "x", s), staticKey(await generateIdentity()));
  expect(await t.call("ping")).toEqual({ type: "pong" });
  expect(hellos).toEqual(["jws-1", "jws-2"]);
  expect(s.dropped).toEqual([relay.hostID]);
  t.close();
  refuse = 5;
  const t2 = new GuestTransport(ownerLink(endpointOf(relay), "x", s), staticKey(await generateIdentity()));
  const error = await t2.call("ping").catch(e => e);
  expect(error).toBeInstanceOf(GuestError);
  expect((error as GuestError).kind).toBe("statement");
  expect(hellos.length).toBe(4);
  t2.close();
 } finally { relay.stop(); }
});

// Real time on purpose: the refresh timer runs on a session over the local relay's socket, and
// waits its 1 s floor; the test awaits the host receiving the message, not a guessed delay.
test("before the deadline the session sends a newer statement in-band, as one whole message", async () => {
 const refreshed = Promise.withResolvers<string | null>();
 const relay = relayWith(async (_conn, handshake) => {
  // The deadline 121 s out: the refresh is due 2 minutes before it, so about now.
  const session = (await handshake()).reply(ownerReply(Math.floor(Date.now() / 1000) + 121));
  await ping(session);
  refreshed.resolve(await session.readMessage());
 });
 try {
  const s = statements();
  const t = new GuestTransport(ownerLink(endpointOf(relay), "x", s), staticKey(await generateIdentity()));
  expect(await t.call("ping")).toEqual({ type: "pong" });
  expect(JSON.parse((await refreshed.promise)!)).toEqual({ t: "account.refresh", account: "jws-2" });
  t.close();
 } finally { relay.stop(); }
});

test("the statement cache shares one request per machine, asks again when too little is left, and forgets a refused one", async () => {
 let clock = 1_000_000_000_000, asked = 0;
 const cache = statementCache({ async statements(hosts: string[]) { asked++; return { statements: hosts.map(host => ({ host, jws: `${host}-${asked}` })), exp: clock / 1000 + 600 }; } }, () => clock);
 const signal = new AbortController().signal;
 const [a, b] = await Promise.all([cache.get("H", 120_000, signal), cache.get("H", 120_000, signal)]);
 expect([a.jws, b.jws, asked]).toEqual(["H-1", "H-1", 1]);
 clock += 400_000; // 200 s left
 expect((await cache.get("H", 120_000, signal)).jws).toBe("H-1");
 expect((await cache.get("H", 300_000, signal)).jws).toBe("H-2");
 cache.drop("H");
 expect((await cache.get("H", 120_000, signal)).jws).toBe("H-3");
});
