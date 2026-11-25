// Ports of internal/guest/guest_test.go against a Noise host on Bun.serve (webguestResponder.ts),
// over real WebSockets.
import { afterEach, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { GuestError, HerdrAPIError, NotSentError } from "../src/webguest/errors";
import { generateIdentity, staticKey } from "../src/webguest/identity";
import { Invite } from "../src/webguest/invite";
import { MAX_NOISE_MESSAGE, MAX_NOISE_PLAINTEXT } from "../src/webguest/noise";
import { acceptInvite, guestLink, GuestTransport, MAX_QUEUED_BYTES, MAX_QUEUED_FRAMES, MAX_REPLY_LINE_BYTES, relayBackoff, ROUND_TRIP_LIMIT_MS, type Access, type HeldSession, type RelayWebSocket, type WebSocketFactory } from "../src/webguest/transport";
import { memoryRelay, startRelay, type HostSession, type TestRelay } from "./webguestResponder";
import { GuestClient } from "../src/web/engine";
import { transportLink } from "../src/web/link";
import type { GuestAccess } from "../src/mygo";

let relays: TestRelay[] = [];
afterEach(() => { for (const relay of relays) relay.stop(); relays = []; });
const track = (relay: TestRelay) => { relays.push(relay); return relay; };
const kindOf = async (promise: Promise<unknown>) => {
 try { await promise; return "accepted"; } catch (error) { return error instanceof GuestError ? error.kind : String(error); }
};
const identity = async () => staticKey(await generateIdentity());
const accessOn = (relay: TestRelay, guestID = "grant-1"): Access => ({
 guestID, guestName: "visitor", machineLabel: "Machine", ownerName: "Owner", agentName: "Worker", agentTarget: "%42",
 endpoint: { relay: relay.url, hostID: relay.hostID, hostPublicKey: relay.hostPublic }, acceptedAt: new Date(),
});

/** A test of up to five fresh connects: 3 s each, on a machine so loaded a handshake takes 1 s. */
const CONNECTS_LIMIT_MS = 15_000;

/** guest_test.go:73-264's host, for guest: it checks the guest's key and hello on every connect
 *  and admits by fixture.mode (0 the grant with an agent and gram, 1 another grant, 2 revoked, 3
 *  the grant without features, 4 never answers); a request with mode 0 or 3 is answered as one
 *  API line split between frames, then a second line in the same frame. */
async function guestHost() {
 const guest = await identity();
 const fixture = { mode: 0, sessions: 0, requests: [] as string[] };
 const relay = track(startRelay({
  async serve(conn, handshake) {
   const { hello, guestPublic, reply } = await handshake();
   expect(guestPublic).toEqual(guest.publicKey);
   fixture.sessions++;
   const mode = fixture.mode;
   if (mode === 4) return; // never answers: the guest's cancellation must end it
   const host = reply(
    mode === 1 ? { ok: true, guest_id: "wrong-grant" } :
    mode === 2 ? { ok: false, error: "revoked" } :
    mode === 3 ? { ok: true, guest_id: "grant-1" } :
    { ok: true, guest_id: "grant-1", agent: { name: "Worker", target: "%42" }, features: { gram: true } });
   if (hello.invite_id !== undefined) {
    expect([hello.v, hello.invite_id, hello.secret, hello.device]).toEqual([1, "invitation", "one-use-bearer", "Desktop"]);
    return;
   }
   expect(hello).toEqual({ v: 1, guest_id: "grant-1" });
   if (mode !== 0 && mode !== 3) return;
   const line = await host.readLine();
   const request = JSON.parse(line!) as { id: string; method: string; params: { text?: string } };
   expect(request.id).toMatch(/^herdrup:guest:\d+$/);
   fixture.requests.push(request.params.text ?? request.method);
   // Split one API line between frames, then put two lines in a frame.
   host.write(`{"result":{"text":"hel`);
   host.write(`lo"}}\n{"result":{"text":"second"}}\n`);
   conn.close(1000);
  },
 }));
 const invite = new Invite({ relay: relay.url, hostID: relay.hostID, hostPublicKey: relay.hostPublic }, "Machine", "Owner", "Worker", "visitor", new Date(Date.now() + 60_000), "invitation", "one-use-bearer");
 return { guest, fixture, relay, invite };
}

// guest_test.go:73-264, split by what each part checks (#428: each connect is a handshake).
test("guest acceptance and returning traffic authenticate both peers (guest_test.go:73-264)", async () => {
 const { guest, fixture, invite } = await guestHost();
 const access = await acceptInvite(invite, guest, "Desktop");
 expect([access.agentTarget, access.guestID, access.ownerName, access.agentName]).toEqual(["%42", "grant-1", "Owner", "Worker"]);
 const transport = new GuestTransport(guestLink(access), guest);
 const longText = "x".repeat(MAX_NOISE_PLAINTEXT * 2);
 expect(await transport.call("pane.send_text", { text: longText })).toEqual({ text: "hello" });
 expect(fixture.requests.pop()).toBe(longText);
 expect(transport.features.gram).toBe(true);
 const stream = await transport.openStream("events.subscribe");
 expect(await stream.next()).toBe(`{"result":{"text":"hello"}}`);
 expect(await stream.next()).toBe(`{"result":{"text":"second"}}`);
 expect(await stream.next()).toBeNull();
 stream.close();
 expect(fixture.sessions).toBe(3);
 transport.close();
}, CONNECTS_LIMIT_MS);

test("a returning guest's admission sets its features; another grant's or a revoked one reads as revoked (guest_test.go:73-264)", async () => {
 const { guest, fixture, relay } = await guestHost();
 const transport = new GuestTransport(guestLink(accessOn(relay)), guest);
 await transport.call("ping");
 expect(transport.features.gram).toBe(true);
 fixture.mode = 3;
 await transport.call("ping");
 expect(transport.features.gram).toBe(false);
 for (fixture.mode of [1, 2]) expect([fixture.mode, await kindOf(transport.call("ping"))]).toEqual([fixture.mode, "revoked"]);
 transport.close();
}, CONNECTS_LIMIT_MS);

test("a host without the saved key isn't accepted; a stream whose hello goes unanswered ends with its signal; a closed transport opens nothing (guest_test.go:73-264)", async () => {
 const { guest, fixture, relay } = await guestHost();
 const access = accessOn(relay);
 const wrongKey = { ...access, endpoint: { ...access.endpoint, hostPublicKey: new Uint8Array(32).fill(9) } };
 expect(await kindOf(new GuestTransport(guestLink(wrongKey), guest).call("ping"))).not.toBe("accepted");
 const transport = new GuestTransport(guestLink(access), guest);
 fixture.mode = 4;
 const cancelled = await transport.openStream("events.subscribe", undefined, { signal: AbortSignal.timeout(30) }).then(() => null, (error) => error);
 expect(cancelled).not.toBeNull();
 transport.close();
 expect(await kindOf(transport.openStream("ping"))).toBe("closed");
}, CONNECTS_LIMIT_MS);

test("a stream keeps its socket and yields lines until the host closes", async () => {
 let host: HostSession | undefined;
 const opened = Promise.withResolvers<void>();
 const relay = track(startRelay({
  async serve(_conn, handshake) {
   host = (await handshake()).reply({ ok: true, guest_id: "grant-1" });
   expect(JSON.parse((await host.readLine())!).method).toBe("pane.stream");
   opened.resolve();
  },
 }));
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity());
 const stream = await transport.openStream("pane.stream", { pane_id: "p" });
 await opened.promise;
 const lines: string[] = [];
 const reading = (async () => { for await (const line of stream) lines.push(line); })();
 for (let n = 0; n < 3; n++) host!.write(`{"result":{"n":${n}}}\n`);
 host!.conn.close(1000);
 await reading;
 expect(lines).toEqual(['{"result":{"n":0}}', '{"result":{"n":1}}', '{"result":{"n":2}}']);
});

test("closing the transport ends its open streams", async () => {
 const opened = Promise.withResolvers<void>();
 const relay = track(startRelay({
  async serve(_conn, handshake) {
   const host = (await handshake()).reply({ ok: true, guest_id: "grant-1" });
   await host.readLine();
   opened.resolve();
  },
 }));
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity());
 const stream = await transport.openStream("pane.stream");
 await opened.promise;
 const next = stream.next();
 transport.close();
 expect(await kindOf(next)).toBe("closed");
});

/** A host that admits each connect with fixture.admission and answers its one request with
 *  fixture.script(host). Each case of the error tests below is a fresh connect, a Noise handshake
 *  each (about 1 s on a loaded machine, #428): they are split by kind, and one with several
 *  connects has a time limit of its own, CONNECTS_LIMIT_MS. */
function scriptedHost() {
 const fixture = { script: (_host: HostSession) => {}, admission: { ok: true, guest_id: "grant-1" } as unknown };
 const relay = track(startRelay({
  async serve(_conn, handshake) {
   const host = (await handshake()).reply(fixture.admission);
   await host.readLine();
   fixture.script(host);
  },
 }));
 return { fixture, relay };
}

test("an API error reads as the Go client words it", async () => {
 const { fixture, relay } = scriptedHost();
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity());
 fixture.script = (host) => host.write(`{"id":"x","error":{"code":"not_found","message":"no such pane","current":7}}\n`);
 const apiError = await transport.call("pane.get").catch((error) => error);
 expect(apiError).toBeInstanceOf(HerdrAPIError);
 expect([apiError.code, apiError.message, apiError.raw.current]).toEqual(["not_found", "herdr: not_found: no such pane", 7]);
});

test("closes and malformed replies read as the Go client words them", async () => {
 const { fixture, relay } = scriptedHost();
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity());
 // Bun's server sends 1001 as 1000, so the relay's 1001 host_offline is checked with a scripted
 // socket below.
 const closes: [number, string, string][] = [
  [1008, "host_busy", "The shared machine is busy. Try again shortly."],
  [1009, "", "The shared machine rejected an oversized message."],
  [4000, "replaced", "The shared connection closed (code 4000)."],
 ];
 for (const [code, reason, message] of closes) {
  fixture.script = (host) => host.conn.close(code, reason);
  expect(await transport.call("ping").catch((error: Error) => error.message)).toBe(message);
 }
 fixture.script = (host) => host.conn.send("plain text");
 expect(await transport.call("ping").catch((error: Error) => error.message)).toBe("The relay sent an unencrypted message; the connection was refused.");
 fixture.script = (host) => { host.write(`{"result":"partial`); host.conn.close(1000); };
 expect(await kindOf(transport.call("ping"))).toBe("other");
}, CONNECTS_LIMIT_MS);

test("the host's refusals of a guest read as the Go client words them", async () => {
 const { fixture, relay } = scriptedHost();
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity());
 for (const [code, message] of [["unknown", "This shared access is no longer available. Ask the owner for a new invitation."], ["invite_used", "This invitation was already used. Ask the owner for a new one."], ["invite_expired", "This invitation has expired. Ask the owner for a new invitation."], ["invite_invalid", "The owner did not accept this invitation. Ask for a new link."], ["other", "The shared machine refused this guest connection."]]) {
  fixture.admission = { ok: false, error: code };
  expect(await transport.call("ping").catch((error: Error) => error.message)).toBe(message!);
 }
}, CONNECTS_LIMIT_MS);

test("an admission that isn't one reads as an invalid secure reply", async () => {
 const { fixture, relay } = scriptedHost();
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity());
 for (fixture.admission of [{ guest_id: "grant-1" }, { ok: "yes" }, [], { ok: true, guest_id: 7 }]) {
  expect(await transport.call("ping").catch((error: Error) => error.message)).toBe("The shared machine's secure reply is invalid.");
 }
}, CONNECTS_LIMIT_MS);

// GuestRelay src/host.ts:178 closes a guest with 1001 host_offline when the host goes away.
test("the relay's going-away close reads as the host offline", async () => {
 const { relay, webSocket } = memoryRelay(async (conn, handshake) => {
  (await handshake()).reply({ ok: true, guest_id: "grant-1" });
  conn.close(1001, "host_offline");
 });
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity(), { webSocket });
 expect(await kindOf(transport.call("ping"))).toBe("host_offline");
});

test("a reply line over 64 MiB is refused", async () => {
 let sent = 0;
 const { relay, webSocket } = memoryRelay(async (conn, handshake) => {
  const host = (await handshake()).reply({ ok: true, guest_id: "grant-1" });
  await host.readLine();
  const chunk = "x".repeat(MAX_NOISE_PLAINTEXT);
  // Yields between frames so the guest reads as the host writes, as over a socket.
  for (; sent <= MAX_REPLY_LINE_BYTES + chunk.length && !conn.ended; sent += chunk.length) { host.write(chunk); await Promise.resolve(); }
 });
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity(), { webSocket });
 expect(await transport.call("agent.read").catch((error: Error) => error.message)).toBe("Shared-machine reply exceeds the maximum line size.");
 expect(sent).toBeGreaterThan(MAX_REPLY_LINE_BYTES);
}, 60_000);

// PR #109 review: frames were queued before any size check, so a relay could fill the page's
// memory while a stream sat unread. Go's read limit (session.go:136) refuses them on arrival.
test("a frame over the Noise message limit ends the connection on arrival", async () => {
 let closedByGuest = false;
 const { relay, webSocket } = memoryRelay(async (conn, handshake) => {
  const host = (await handshake()).reply({ ok: true, guest_id: "grant-1" });
  await host.readLine();
  conn.send(new Uint8Array(MAX_NOISE_MESSAGE + 1));
  closedByGuest = (await conn.read()) === null;
 });
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity(), { webSocket });
 const stream = await transport.openStream("events.subscribe");
 expect(await stream.next().catch((error: Error) => error.message)).toBe("The shared machine sent an oversized message.");
 await Bun.sleep(0);
 expect(closedByGuest).toBe(true);
});

test("an unread backlog past the queue limit ends the connection and frees it", async () => {
 let sent = 0, closedByGuest = false;
 const { relay, webSocket } = memoryRelay(async (conn, handshake) => {
  const host = (await handshake()).reply({ ok: true, guest_id: "grant-1" });
  await host.readLine();
  const frame = new Uint8Array(MAX_NOISE_MESSAGE);
  // Raw frames the guest never decrypts: nothing reads the stream while they arrive.
  for (; sent <= MAX_QUEUED_BYTES && !conn.ended; sent += frame.length) { conn.send(frame); await Promise.resolve(); }
  closedByGuest = conn.ended;
 });
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity(), { webSocket });
 const stream = await transport.openStream("events.subscribe");
 for (let i = 0; i < 5000 && !closedByGuest; i++) await Bun.sleep(0);
 expect(closedByGuest).toBe(true);
 expect(sent).toBeLessThanOrEqual(MAX_QUEUED_BYTES + MAX_NOISE_MESSAGE);
 expect(await stream.next().catch((error: Error) => error.message)).toBe("The shared machine sent more than this page can hold.");
}, 60_000);

// PR #109 re-review: empty frames carry no bytes, so the byte bound alone let them queue
// without end.
test("unread empty frames past the frame limit end the connection", async () => {
 let sent = 0, closedByGuest = false;
 const { relay, webSocket } = memoryRelay(async (conn, handshake) => {
  const host = (await handshake()).reply({ ok: true, guest_id: "grant-1" });
  await host.readLine();
  const empty = new Uint8Array(0);
  for (; sent <= MAX_QUEUED_FRAMES && !conn.ended; sent++) { conn.send(empty); if (sent % 256 === 0) await Promise.resolve(); }
  closedByGuest = conn.ended;
 });
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity(), { webSocket });
 const stream = await transport.openStream("events.subscribe");
 for (let i = 0; i < 5000 && !closedByGuest; i++) await Bun.sleep(0);
 expect(closedByGuest).toBe(true);
 expect(sent).toBeLessThanOrEqual(MAX_QUEUED_FRAMES + 256);
 expect(await stream.next().catch((error: Error) => error.message)).toBe("The shared machine sent more than this page can hold.");
}, 60_000);

test("a call ends at its round-trip limit, handshake included (session.go:18)", async () => {
 expect(ROUND_TRIP_LIMIT_MS).toBe(60_000);
 const relay = track(startRelay({ async serve(_conn, handshake) { await handshake(); } }));
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity(), { callLimitMs: 200 });
 expect(await kindOf(transport.call("ping"))).toBe("timeout");
});

// transport.go:32-47 and guest_test.go:268-279.
test("after the relay's 429 a transport waits 15 s, doubling to a minute", () => {
 const got: number[] = [];
 for (let last = 0; got.length < 5;) got.push(last = relayBackoff(last));
 expect(got).toEqual([15_000, 30_000, 60_000, 60_000, 60_000]);
});

// What a page sees of the relay's 429 (transport.ts, top): `error`, then `close` before `open`.
test("a refused upgrade is read as rate limited and starts the backoff without reconnecting", async () => {
 let clock = 1_000_000;
 const seen: string[] = [];
 const relay = track(startRelay({
  admit: () => new Response('{"error":"rate_limited"}', { status: 429, headers: { "X-Herdr-Guest-Error": "rate_limited" } }),
  async serve() {},
 }));
 const observe: WebSocketFactory = (url) => {
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => seen.push("open"));
  ws.addEventListener("error", () => seen.push("error"));
  ws.addEventListener("close", (event) => seen.push(`close ${event.code} clean=${event.wasClean}`));
  return ws;
 };
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity(), { now: () => clock, webSocket: observe });
 expect(await kindOf(transport.call("ping"))).toBe("rate_limited");
 expect(seen[0]).toBe("error");
 expect(seen[1]).toMatch(/^close 10\d\d clean=false$/);
 expect(transport.rateLimitedUntil()).toBe(clock + 15_000);
 expect(await kindOf(transport.call("ping"))).toBe("rate_limited");
 expect(relay.connects).toBe(1);
 clock += 15_000;
 expect(await kindOf(transport.call("ping"))).toBe("rate_limited");
 expect([relay.connects, transport.rateLimitedUntil()]).toEqual([2, clock + 30_000]);
 clock += 30_000;
 await kindOf(transport.call("ping"));
 expect(transport.rateLimitedUntil()).toBe(clock + 60_000);
});

// themartianapp/herdrup#610: the relay accepts a guest upgrade it refuses and closes with a code a
// page can read: 4429 rate_limited, 4503 host_offline, 4504 host_busy (Go session.go socketError).
test("the relay's refusal close codes read as rate limited, offline and busy", async () => {
 let clock = 1_000_000, code = 4429, reason = "rate_limited";
 const relay = track(startRelay({ admit: () => undefined, async serve(conn) { conn.close(code, reason); } }));
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity(), { now: () => clock });
 expect(await kindOf(transport.call("ping"))).toBe("rate_limited");
 expect(transport.rateLimitedUntil()).toBe(clock + 15_000);
 expect(await kindOf(transport.call("ping"))).toBe("rate_limited");
 expect(relay.connects).toBe(1);
 clock += 15_000;
 [code, reason] = [4503, "host_offline"];
 expect(await kindOf(transport.call("ping"))).toBe("host_offline");
 [code, reason] = [4504, "host_busy"];
 expect(await transport.call("ping").catch((error: Error) => error.message)).toBe("The shared machine is busy. Try again shortly.");
});

test("a connect the relay admits ends the backoff", async () => {
 let clock = 1_000_000;
 let refuse = true;
 const relay = track(startRelay({
  admit: () => refuse ? new Response(null, { status: 429 }) : undefined,
  async serve(_conn, handshake) {
   const host = (await handshake()).reply({ ok: true, guest_id: "grant-1" });
   await host.readLine();
   host.write(`{"result":{"type":"pong"}}\n`);
  },
 }));
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity(), { now: () => clock });
 expect(await kindOf(transport.call("ping"))).toBe("rate_limited");
 clock += 15_000;
 refuse = false;
 expect(await transport.call("ping")).toEqual({ type: "pong" });
 expect(transport.rateLimitedUntil()).toBeNull();
 refuse = true;
 expect(await kindOf(transport.call("ping"))).toBe("rate_limited");
 expect(transport.rateLimitedUntil()).toBe(clock + 15_000);
});

/** A host for one case of the not-sent test below, by mode: the relay refuses the connect
 *  ("refuse"), the host holds the hello ("hold"), refuses it ("refuseHello"), closes once it has
 *  the request ("close"), or else takes the request and waits. helloed and received settle as it
 *  gets there. */
function notSentHost(mode: string) {
 const helloed = Promise.withResolvers<void>(), received = Promise.withResolvers<void>();
 const relay = track(startRelay({
  admit: () => mode === "refuse" ? new Response(null, { status: 429 }) : undefined,
  async serve(conn, handshake) {
   const h = await handshake();
   helloed.resolve();
   if (mode === "hold") return;
   if (mode === "refuseHello") { h.reply({ ok: false, error: "revoked" }); return; }
   const host = h.reply({ ok: true, guest_id: "grant-1" });
   await host.readLine();
   received.resolve();
   if (mode === "close") conn.close();
  },
 }));
 const transportOn = async (r: TestRelay, callLimitMs?: number) => new GuestTransport(guestLink(accessOn(r)), await identity(), callLimitMs ? { callLimitMs } : {});
 /** A call aborted (with reason) through its signal, or its sendSignal, once the host has reached at. */
 const cancelled = async (at: () => Promise<void>, through: "signal" | "sendSignal" = "signal") => {
  const transport = await transportOn(relay), call = new AbortController();
  const pending = transport.call("agent.start", {}, { [through]: call.signal });
  await at();
  call.abort(new Error("sheet dismissed"));
  return pending;
 };
 return { relay, helloed: helloed.promise, received: received.promise, transportOn, cancelled };
}

// One test per case, each its own host (#428: each connect is a handshake).
test.each([
 ["the relay refuses the connect (429)", "refuse", "not sent", async (h) => (await h.transportOn(h.relay)).call("agent.start")],
 ["the relay can't be reached", "", "not sent", async (h) => {
  const gone = startRelay({ async serve() {} });
  gone.stop();
  return (await h.transportOn(gone)).call("agent.start");
 }],
 ["the host refuses the hello", "refuseHello", "not sent", async (h) => (await h.transportOn(h.relay)).call("agent.start")],
 ["the call was aborted before it began", "", "not sent", async (h) => {
  const transport = await h.transportOn(h.relay), call = new AbortController();
  call.abort(new Error("sheet dismissed"));
  return transport.call("agent.start", {}, { signal: call.signal });
 }],
 ["the call is cancelled while its hello waits", "hold", "not sent", (h) => h.cancelled(() => h.helloed)],
 ["the call's sendSignal ends while its hello waits", "hold", "not sent", (h) => h.cancelled(() => h.helloed, "sendSignal")],
 ["the transport closed before the call", "", "not sent", async (h) => { const transport = await h.transportOn(h.relay); transport.close(); return transport.call("agent.start"); }],
 ["the host closes once it has the request", "close", "maybe sent", async (h) => (await h.transportOn(h.relay)).call("agent.start")],
 ["the call is cancelled once the host has the request", "wait", "maybe sent", (h) => h.cancelled(() => h.received)],
 ["the round-trip limit passes while its hello waits", "hold", "not sent", async (h) => (await h.transportOn(h.relay, 200)).call("agent.start")],
] as [string, string, "not sent" | "maybe sent", (h: ReturnType<typeof notSentHost>) => Promise<unknown>][])(
 "a call fails as NotSentError for every failure before its request reaches the socket, and never after: %s", async (_name, mode, want, run) => {
  const error = await run(notSentHost(mode)).then(() => "answered", (e: unknown) => e);
  expect(error instanceof NotSentError ? "not sent" : error instanceof Error ? "maybe sent" : String(error)).toBe(want);
 }, CONNECTS_LIMIT_MS);

// The hand-off (transport.ts handOff): a request's signal or sendSignal ending at any point before
// its first frame reaches the socket sends nothing, on a reused session and a fresh one; once the
// host has it, signal ends the call (maybe sent) and sendSignal no longer does. The points: the
// caller's own turn (call() returned, nothing awaited yet), the host holding the hello, the host's
// admission on its way, and the admission arrived at the page's socket (its message handled).
type HandOffPoint = "the caller's turn" | "the held hello" | "the admission on its way" | "the admission arrived" | "the host has it";
const handOffCases = (["signal", "sendSignal"] as const).flatMap(through => ([
 ["reused", "the caller's turn"], ["fresh", "the caller's turn"], ["fresh", "the held hello"], ["fresh", "the admission on its way"],
 ["fresh", "the admission arrived"], ["reused", "the host has it"], ["fresh", "the host has it"],
] as const).map(([session, at]) => [session, through, at] as [string, "signal" | "sendSignal", HandOffPoint]));

/** A page socket over a real WebSocket that runs after(), once, right after the page handled the
 *  first message (on a fresh socket, the host's admission). */
class AfterFirstMessage implements RelayWebSocket {
 #handled = false;
 #onmessage: ((event: MessageEvent) => void) | null = null;
 constructor(private readonly ws: WebSocket, private readonly after: () => void) {}
 get binaryType() { return this.ws.binaryType; }
 set binaryType(type: BinaryType) { this.ws.binaryType = type; }
 get readyState() { return this.ws.readyState; }
 send(data: Uint8Array<ArrayBuffer>) { this.ws.send(data); }
 close() { this.ws.close(); }
 get onopen() { return this.ws.onopen; }
 set onopen(f) { this.ws.onopen = f; }
 get onerror() { return this.ws.onerror; }
 set onerror(f) { this.ws.onerror = f; }
 get onclose() { return this.ws.onclose; }
 set onclose(f) { this.ws.onclose = f; }
 get onmessage() { return this.#onmessage; }
 set onmessage(f: ((event: MessageEvent) => void) | null) {
  this.#onmessage = f;
  this.ws.onmessage = f === null ? null : (event) => { f(event); if (!this.#handled) { this.#handled = true; this.after(); } };
 }
}

test.each(handOffCases)("a request on a %s session, its %s ended at %s", async (sessionKind, through, at) => {
 const prompts: string[] = [], serving: Promise<void>[] = [];
 const got = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
 const end = new AbortController();
 let armed = false;
 const ending = (point: HandOffPoint) => { if (armed && at === point) end.abort(new Error("sheet dismissed")); };
 const relay = track(startRelay({
  admit: () => undefined, // counts the connects
  serve(_conn, handshake) {
   const run = (async () => {
    const hello = await handshake();
    ending("the held hello");
    const host = hello.reply({ ok: true, guest_id: "grant-1", features: { multi_request: true } });
    ending("the admission on its way");
    for (;;) {
     const line = await host.readLine();
     if (line === null) return;
     const request = JSON.parse(line) as { id: string; method: string };
     if (request.method === "agent.prompt") { prompts.push(request.id); got.resolve(); await release.promise; }
     host.write(JSON.stringify({ id: request.id, result: { type: request.method === "ping" ? "pong" : "ok" } }) + "\n");
    }
   })();
   serving.push(run.catch(() => {}));
   return run;
  },
 }));
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity(), {
  webSocket: url => new AfterFirstMessage(new WebSocket(url), () => ending("the admission arrived")),
 });
 try {
  if (sessionKind === "reused") expect(await transport.call("ping")).toEqual({ type: "pong" });
  armed = true;
  const calling = transport.call("agent.prompt", { text: "deploy" }, { [through]: end.signal })
   .then(() => "answered", (error: unknown) => error instanceof NotSentError ? "not sent" : "maybe sent");
  ending("the caller's turn");
  if (at === "the host has it") {
   await got.promise;
   end.abort(new Error("sheet dismissed"));
   release.resolve();
   expect(await calling).toBe(through === "signal" ? "maybe sent" : "answered");
   expect(prompts.length).toBe(1);
  } else {
   expect(await calling).toBe("not sent");
   transport.close();
   await Promise.all(serving);
   expect(prompts).toEqual([]);
  }
  // A reused session's request connects no more; a fresh one ended in the caller's turn never dials.
  expect(relay.connects).toBe(sessionKind === "fresh" && at === "the caller's turn" ? 0 : 1);
 } finally { release.resolve(); transport.close(); }
});

// One pre-send signal (signal and sendSignal) decides the hand-off: its reason is the one that
// ended it first, whichever of the two that was.
test.each(["sendSignal", "signal"] as const)("a reused session's request whose %s ends first, the other next, before its hand-off: NotSentError with the first reason", async (first) => {
 const relay = track(startRelay({
  async serve(_conn, handshake) {
   const host = (await handshake()).reply({ ok: true, guest_id: "grant-1", features: { multi_request: true } });
   for (;;) {
    const line = await host.readLine();
    if (line === null) return;
    const request = JSON.parse(line) as { id: string; method: string };
    host.write(JSON.stringify({ id: request.id, result: { type: request.method === "ping" ? "pong" : "ok" } }) + "\n");
   }
  },
 }));
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity());
 try {
  expect(await transport.call("ping")).toEqual({ type: "pong" });
  const sendEnd = new AbortController(), lifeEnd = new AbortController();
  const reasons = { sendSignal: new Error("Settings changed"), signal: new Error("link ended") };
  const calling = transport.call("agent.prompt", { text: "deploy" }, { signal: lifeEnd.signal, sendSignal: sendEnd.signal }).catch((error: unknown) => error);
  const ends = { sendSignal: () => sendEnd.abort(reasons.sendSignal), signal: () => lifeEnd.abort(reasons.signal) };
  ends[first]();
  ends[first === "signal" ? "sendSignal" : "signal"]();
  const error = await calling;
  expect(error).toBeInstanceOf(NotSentError);
  expect((error as NotSentError).error).toBe(reasons[first]);
 } finally { transport.close(); }
});

/** A multi-request host that answers ping (a pong with every capability) and ok to anything else,
 *  and keeps every method it received. */
function answeringHost() {
 const received: string[] = [];
 const relay = track(startRelay({
  admit: () => undefined, // counts the connects
  async serve(_conn, handshake) {
   const host = (await handshake()).reply({ ok: true, guest_id: "grant-1", features: { multi_request: true } });
   for (;;) {
    const line = await host.readLine();
    if (line === null) return;
    const request = JSON.parse(line) as { id: string; method: string };
    received.push(request.method);
    host.write(JSON.stringify({ id: request.id, result: request.method === "ping" ? { type: "pong", capabilities: { pane_send_text: true } } : { type: "ok" } }) + "\n");
   }
  },
 }));
 return { relay, received };
}

test("a call cancelled before it is sent leaves the idle session to the next call", async () => {
 const { relay, received } = answeringHost();
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity());
 try {
  await transport.call("ping");
  const end = new AbortController();
  const writing = transport.call("pane.send_text", { text: "make lint" }, { signal: end.signal }).catch((error: unknown) => error);
  end.abort(new Error("sheet dismissed"));
  expect(await writing).toBeInstanceOf(NotSentError);
  await transport.call("ping");
  expect(received).toEqual(["ping", "ping"]);
  expect(relay.connects).toBe(1);
 } finally { transport.close(); }
});

test("a held session's handle kept past its callback sends nothing: its request is NotSentError, and the session it left idle carries the next call alone", async () => {
 const { relay, received } = answeringHost();
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity());
 try {
  let kept: HeldSession | null = null;
  await transport.callOn(async (session) => { kept = session; await session.call("ping"); });
  const late = await kept!.call("ping").catch((error: unknown) => error);
  expect(late).toBeInstanceOf(NotSentError);
  await transport.call("pane.send_text", { text: "ls" });
  expect([received, relay.connects]).toEqual([["ping", "pane.send_text"], 1]);
 } finally { transport.close(); }
});

test("a held session carries one request at a time: a second while the first is out is NotSentError, nothing of it sent, and the first's reply is its own", async () => {
 const { relay, received } = answeringHost();
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity());
 try {
  const [first, second] = await transport.callOn(async (session) => {
   const a = session.call("ping"), b = session.call("pane.send_text", { text: "ls" }).catch((error: unknown) => error);
   return [await a, await b] as const;
  });
  expect((first as { type: string }).type).toBe("pong");
  expect(second).toBeInstanceOf(NotSentError);
  expect(received).toEqual(["ping"]);
  // Once the first is answered, the session carries the next request.
  await transport.callOn(async (session) => { await session.call("ping"); await session.call("pane.send_text", { text: "ls" }); });
  expect([received, relay.connects]).toEqual([["ping", "ping", "pane.send_text"], 1]);
 } finally { transport.close(); }
});

// GuestClient's gate and the transport's hand-off read one pre-send signal: with the capability's
// pong cached, a call whose two signals both end before it crosses its gate has the first reason.
test.each(["sendSignal", "signal"] as const)("through GuestClient with a cached pong, a call whose %s ends first and the other next before the gate is crossed: NotSentError with the first reason", async (first) => {
 const { relay, received } = answeringHost();
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity());
 const client = new GuestClient(transportLink({} as GuestAccess, transport));
 try {
  await client.ping();
  const sendEnd = new AbortController(), lifeEnd = new AbortController();
  const reasons = { sendSignal: new Error("Settings changed"), signal: new Error("link ended") };
  const calling = client.call("pane.send_text", { text: "make lint" }, "ok", "pane_send_text", lifeEnd.signal, sendEnd.signal).catch((error: unknown) => error);
  const ends = { sendSignal: () => sendEnd.abort(reasons.sendSignal), signal: () => lifeEnd.abort(reasons.signal) };
  ends[first]();
  ends[first === "signal" ? "sendSignal" : "signal"]();
  const error = await calling;
  expect(error).toBeInstanceOf(NotSentError);
  expect((error as NotSentError).error).toBe(reasons[first]);
  expect(received).toEqual(["ping"]);
 } finally { transport.close(); }
});

// guest_test.go:292-395, the F1 fix: request A passes the relay and waits for the host's reply;
// B is refused meanwhile. A's late success must not end the cooldown B started.
test("an admitted handshake begun before a refusal keeps its cooldown", async () => {
 const helloA = Promise.withResolvers<void>();
 const releaseA = Promise.withResolvers<void>();
 const relay = track(startRelay({
  admit: (connect) => connect === 1 ? undefined : new Response('{"error":"rate_limited"}', { status: 429, headers: { "X-Herdr-Guest-Error": "rate_limited" } }),
  async serve(_conn, handshake) {
   const { reply } = await handshake();
   helloA.resolve();
   await releaseA.promise;
   const host = reply({ ok: true, guest_id: "grant-1" });
   await host.readLine();
   host.write(`{"result":{"type":"pong"}}\n`);
  },
 }));
 const transport = new GuestTransport(guestLink(accessOn(relay)), await identity());
 const a = transport.call("ping");
 await helloA.promise;
 expect(await kindOf(transport.call("ping"))).toBe("rate_limited");
 const cooldown = transport.rateLimitedUntil();
 expect(cooldown).not.toBeNull();
 releaseA.resolve();
 expect(await a).toEqual({ type: "pong" });
 expect(transport.rateLimitedUntil()).toBe(cooldown);
 expect(await kindOf(transport.call("ping"))).toBe("rate_limited");
 expect(relay.connects).toBe(2);
});

test("an expired invitation is refused before connecting", async () => {
 const invite = new Invite({ relay: "https://relay.example", hostID: "h", hostPublicKey: x25519.getPublicKey(x25519.utils.randomSecretKey()) }, "M", "O", "A", "g", new Date(1_000), "i", "s");
 let dialed = false;
 expect(await kindOf(acceptInvite(invite, await identity(), "Browser", { now: 1_000, webSocket: () => { dialed = true; throw new Error("dialed"); } }))).toBe("expired");
 expect(dialed).toBe(false);
});
