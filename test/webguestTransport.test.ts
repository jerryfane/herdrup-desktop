// Ports of internal/guest/guest_test.go against a Noise host on Bun.serve (webguestResponder.ts),
// over real WebSockets.
import { afterEach, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { GuestError, HerdrAPIError } from "../src/webguest/errors";
import { generateIdentity, staticKey } from "../src/webguest/identity";
import { Invite } from "../src/webguest/invite";
import { MAX_NOISE_MESSAGE, MAX_NOISE_PLAINTEXT } from "../src/webguest/noise";
import { acceptInvite, GuestTransport, MAX_QUEUED_BYTES, MAX_QUEUED_FRAMES, MAX_REPLY_LINE_BYTES, relayBackoff, ROUND_TRIP_LIMIT_MS, type Access, type WebSocketFactory } from "../src/webguest/transport";
import { memoryRelay, startRelay, type HostSession, type TestRelay } from "./webguestResponder";

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

test("guest acceptance and returning traffic authenticate both peers (guest_test.go:73-264)", async () => {
 const guest = await identity();
 let mode = 0;
 let sessions = 0;
 const requests: string[] = [];
 const relay = track(startRelay({
  async serve(conn, handshake) {
   const { hello, guestPublic, reply } = await handshake();
   expect(guestPublic).toEqual(guest.publicKey);
   sessions++;
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
   requests.push(request.params.text ?? request.method);
   // Split one API line between frames, then put two lines in a frame.
   host.write(`{"result":{"text":"hel`);
   host.write(`lo"}}\n{"result":{"text":"second"}}\n`);
   conn.close(1000);
  },
 }));
 const invite = new Invite({ relay: relay.url, hostID: relay.hostID, hostPublicKey: relay.hostPublic }, "Machine", "Owner", "Worker", "visitor", new Date(Date.now() + 60_000), "invitation", "one-use-bearer");
 const access = await acceptInvite(invite, guest, "Desktop");
 expect([access.agentTarget, access.guestID, access.ownerName, access.agentName]).toEqual(["%42", "grant-1", "Owner", "Worker"]);

 const transport = new GuestTransport(access, guest);
 const longText = "x".repeat(MAX_NOISE_PLAINTEXT * 2);
 expect(await transport.call("pane.send_text", { text: longText })).toEqual({ text: "hello" });
 expect(requests.pop()).toBe(longText);
 expect(transport.features.gram).toBe(true);

 const stream = await transport.openStream("events.subscribe");
 expect(await stream.next()).toBe(`{"result":{"text":"hello"}}`);
 expect(await stream.next()).toBe(`{"result":{"text":"second"}}`);
 expect(await stream.next()).toBeNull();
 stream.close();
 expect(sessions).toBe(3);

 mode = 3;
 await transport.call("ping");
 expect(transport.features.gram).toBe(false);
 for (mode of [1, 2]) expect([mode, await kindOf(transport.call("ping"))]).toEqual([mode, "revoked"]);

 const wrongKey = { ...access, endpoint: { ...access.endpoint, hostPublicKey: new Uint8Array(32).fill(9) } };
 expect(await kindOf(new GuestTransport(wrongKey, guest).call("ping"))).not.toBe("accepted");

 mode = 4;
 const cancelled = await transport.openStream("events.subscribe", undefined, { signal: AbortSignal.timeout(30) }).then(() => null, (error) => error);
 expect(cancelled).not.toBeNull();
 transport.close();
 expect(await kindOf(transport.openStream("ping"))).toBe("closed");
});

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
 const transport = new GuestTransport(accessOn(relay), await identity());
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
 const transport = new GuestTransport(accessOn(relay), await identity());
 const stream = await transport.openStream("pane.stream");
 await opened.promise;
 const next = stream.next();
 transport.close();
 expect(await kindOf(next)).toBe("closed");
});

test("API errors, closes and refusals read as the Go client words them", async () => {
 let script: (host: HostSession) => void = () => {};
 let admission: unknown = { ok: true, guest_id: "grant-1" };
 const relay = track(startRelay({
  async serve(_conn, handshake) {
   const host = (await handshake()).reply(admission);
   await host.readLine();
   script(host);
  },
 }));
 const transport = new GuestTransport(accessOn(relay), await identity());
 script = (host) => host.write(`{"id":"x","error":{"code":"not_found","message":"no such pane","current":7}}\n`);
 const apiError = await transport.call("pane.get").catch((error) => error);
 expect(apiError).toBeInstanceOf(HerdrAPIError);
 expect([apiError.code, apiError.message, apiError.raw.current]).toEqual(["not_found", "herdr: not_found: no such pane", 7]);
 // Bun's server sends 1001 as 1000, so the relay's 1001 host_offline is checked with a scripted
 // socket below.
 const closes: [number, string, string][] = [
  [1008, "host_busy", "The shared machine is busy. Try again shortly."],
  [1009, "", "The shared machine rejected an oversized message."],
  [4000, "replaced", "The shared connection closed (code 4000)."],
 ];
 for (const [code, reason, message] of closes) {
  script = (host) => host.conn.close(code, reason);
  expect(await transport.call("ping").catch((error: Error) => error.message)).toBe(message);
 }
 script = (host) => host.conn.send("plain text");
 expect(await transport.call("ping").catch((error: Error) => error.message)).toBe("The relay sent an unencrypted message; the connection was refused.");
 script = (host) => { host.write(`{"result":"partial`); host.conn.close(1000); };
 expect(await kindOf(transport.call("ping"))).toBe("other");
 for (const [code, message] of [["unknown", "This shared access is no longer available. Ask the owner for a new invitation."], ["invite_used", "This invitation was already used. Ask the owner for a new one."], ["invite_expired", "This invitation has expired. Ask the owner for a new invitation."], ["invite_invalid", "The owner did not accept this invitation. Ask for a new link."], ["other", "The shared machine refused this guest connection."]]) {
  admission = { ok: false, error: code };
  expect(await transport.call("ping").catch((error: Error) => error.message)).toBe(message!);
 }
 for (admission of [{ guest_id: "grant-1" }, { ok: "yes" }, [], { ok: true, guest_id: 7 }]) {
  expect(await transport.call("ping").catch((error: Error) => error.message)).toBe("The shared machine's secure reply is invalid.");
 }
});

// GuestRelay src/host.ts:178 closes a guest with 1001 host_offline when the host goes away.
test("the relay's going-away close reads as the host offline", async () => {
 const { relay, webSocket } = memoryRelay(async (conn, handshake) => {
  (await handshake()).reply({ ok: true, guest_id: "grant-1" });
  conn.close(1001, "host_offline");
 });
 const transport = new GuestTransport(accessOn(relay), await identity(), { webSocket });
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
 const transport = new GuestTransport(accessOn(relay), await identity(), { webSocket });
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
 const transport = new GuestTransport(accessOn(relay), await identity(), { webSocket });
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
 const transport = new GuestTransport(accessOn(relay), await identity(), { webSocket });
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
 const transport = new GuestTransport(accessOn(relay), await identity(), { webSocket });
 const stream = await transport.openStream("events.subscribe");
 for (let i = 0; i < 5000 && !closedByGuest; i++) await Bun.sleep(0);
 expect(closedByGuest).toBe(true);
 expect(sent).toBeLessThanOrEqual(MAX_QUEUED_FRAMES + 256);
 expect(await stream.next().catch((error: Error) => error.message)).toBe("The shared machine sent more than this page can hold.");
}, 60_000);

test("a call ends at its round-trip limit, handshake included (session.go:18)", async () => {
 expect(ROUND_TRIP_LIMIT_MS).toBe(60_000);
 const relay = track(startRelay({ async serve(_conn, handshake) { await handshake(); } }));
 const transport = new GuestTransport(accessOn(relay), await identity(), { callLimitMs: 200 });
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
 const transport = new GuestTransport(accessOn(relay), await identity(), { now: () => clock, webSocket: observe });
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
 const transport = new GuestTransport(accessOn(relay), await identity(), { now: () => clock });
 expect(await kindOf(transport.call("ping"))).toBe("rate_limited");
 clock += 15_000;
 refuse = false;
 expect(await transport.call("ping")).toEqual({ type: "pong" });
 expect(transport.rateLimitedUntil()).toBeNull();
 refuse = true;
 expect(await kindOf(transport.call("ping"))).toBe("rate_limited");
 expect(transport.rateLimitedUntil()).toBe(clock + 15_000);
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
 const transport = new GuestTransport(accessOn(relay), await identity());
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
