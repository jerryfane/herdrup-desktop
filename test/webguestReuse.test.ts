// Session reuse (jerryfane/herdr#356, features.multi_request): ports of internal/guest/reuse_test.go
// against guestGate (webguestResponder.ts), over real WebSockets unless a test needs the page's
// view of a closing socket (memoryRelay).
import { afterEach, expect, jest, test } from "bun:test";
import { GuestError, HerdrAPIError } from "../src/webguest/errors";
import { generateIdentity, staticKey } from "../src/webguest/identity";
import { GuestTransport, REUSE_IDLE_LIMIT_MS, type Access, type TransportOptions, type WebSocketFactory } from "../src/webguest/transport";
import { guestGate, memoryRelay, startRelay, type GateAnswer, type TestRelay } from "./webguestResponder";

let relays: TestRelay[] = [];
let transports: GuestTransport[] = [];
afterEach(() => {
 jest.useRealTimers();
 for (const transport of transports) transport.close();
 for (const relay of relays) relay.stop();
 relays = []; transports = [];
});

const accessOn = (relay: TestRelay): Access => ({
 guestID: "grant-1", guestName: "visitor", machineLabel: "Machine", ownerName: "Owner", agentName: "worker", agentTarget: "t1",
 endpoint: { relay: relay.url, hostID: relay.hostID, hostPublicKey: relay.hostPublic }, acceptedAt: new Date(),
});

/** herdr sharing "worker": what it answers, and the agent.prompt texts it acted on. */
function herdr() {
 const prompts: string[] = [];
 let paused = false;
 let gate: Promise<void> | null = null;
 let dropPrompts = false;
 let holding: (() => void) | null = null;
 const answer = async (method: string, params: Record<string, unknown>): Promise<GateAnswer> => {
  switch (method) {
   case "agent.list": return { result: { type: "agent_list", agents: [{ terminal_id: "t1", name: "worker" }] } };
   case "agent.get":
    if (params.target !== "worker") return { error: { code: "guest_forbidden" } };
    if (paused) return { error: { code: "guest_paused" } };
    return { result: { type: "agent_info" } };
   case "agent.prompt":
    prompts.push(String(params.text));
    if (dropPrompts) return "drop";
    return { result: { type: "agent_prompted", text: "visitor (via HerdrUp): " + String(params.text) } };
   case "agent.transcript":
    if (gate !== null) { holding?.(); await gate; }
    return { result: { type: "agent_transcript", entries: [] } };
  }
  return { error: { code: "unknown_method" } };
 };
 return {
  prompts, answer,
  pause(on: boolean) { paused = on; },
  dropPrompts() { dropPrompts = true; },
  /** Holds agent.transcript until release; arrived resolves once one waits. */
  hold() {
   const held = Promise.withResolvers<void>(), arrived = Promise.withResolvers<void>();
   gate = held.promise;
   holding = arrived.resolve;
   return { arrived: arrived.promise, release() { gate = null; held.resolve(); } };
  },
 };
}

async function setup(multiRequest: boolean, options: TransportOptions & { memory?: boolean } = {}) {
 const host = herdr();
 const gate = guestGate({ multiRequest, answer: host.answer });
 let relay: TestRelay;
 let transportOptions: TransportOptions = options;
 if (options.memory) {
  const memory = memoryRelay(gate.serve);
  relay = memory.relay;
  transportOptions = { ...options, webSocket: memory.webSocket };
 } else {
  // admit counts the connects (TestRelay.connects).
  relay = startRelay({ admit: () => undefined, serve: gate.serve });
 }
 relays.push(relay);
 const transport = new GuestTransport(accessOn(relay), staticKey(await generateIdentity()), transportOptions);
 transports.push(transport);
 return { host, gate, relay, transport };
}

const list = async (transport: GuestTransport) => expect(await transport.call("agent.list")).toEqual({ type: "agent_list", agents: [{ terminal_id: "t1", name: "worker" }] });
const prompt = (transport: GuestTransport, text: string) => transport.call("agent.prompt", { target: "worker", text }) as Promise<{ text: string }>;
const failure = async (promise: Promise<unknown>) => {
 try { await promise; return "accepted"; } catch (error) { return error instanceof HerdrAPIError ? error.code : error instanceof GuestError ? error.kind : String(error); }
};

test("calls share one session only when the host advertises multi_request", async () => {
 for (const multi of [true, false]) {
  const { gate, relay, transport } = await setup(multi);
  for (let i = 0; i < 6; i++) await list(transport);
  expect(transport.features.multiRequest).toBe(multi);
  if (multi) {
   expect(relay.connects).toBe(1);
   expect(gate.sessions.map(s => s.requests)).toEqual([6]);
  } else {
   expect(relay.connects).toBe(6);
   expect(gate.sessions.map(s => s.requests)).toEqual([1, 1, 1, 1, 1, 1]);
  }
 }
});

// The page hears herdr's close before the next call (memoryRelay delivers it ahead of the test's
// await): the call connects afresh. A close still on its way when a frame goes out is a lost reply,
// never resent (below).
test("a server-closed idle session is replaced", async () => {
 const { gate, relay, transport } = await setup(true, { memory: true });
 await list(transport);
 await list(transport);
 expect(relay.connects).toBe(1);
 gate.endAll();
 expect(await gate.sessions[0]!.ended).toBe("ended");
 await list(transport);
 expect(relay.connects).toBe(2);
 expect(gate.sessions.map(s => [s.requests, s.end])).toEqual([[2, "ended"], [1, ""]]);
});

// herdr's close crossed the call: the page's socket is closed but its close event not yet delivered,
// so the transport takes the session as idle and the socket refuses the prompt's frame, which so
// cannot have reached herdr.
test("a request a closing socket refused goes once more on a fresh session", async () => {
 const { host, gate, relay, transport } = await setup(true, { memory: true });
 await list(transport);
 await list(transport);
 expect(relay.connects).toBe(1);
 gate.endAll();
 const reply = prompt(transport, "crossed");
 expect(await reply).toEqual({ type: "agent_prompted", text: "visitor (via HerdrUp): crossed" });
 expect(host.prompts).toEqual(["crossed"]);
 expect(relay.connects).toBe(2);
});

test("a prompt whose reply was lost after sending is not resent", async () => {
 const { host, gate, relay, transport } = await setup(true);
 host.dropPrompts();
 await list(transport);
 expect(await failure(prompt(transport, "only once"))).not.toBe("accepted");
 expect(host.prompts).toEqual(["only once"]);
 await gate.sessions[0]!.ended;
 expect(relay.connects).toBe(1);
 expect(gate.sessions.map(s => [s.requests, s.end])).toEqual([[2, "dropped"]]);
});

// herdrup#612 review (P1): a socket can throw after the frame left, and herdr then has the prompt.
// Here the socket delivers the prompt's frame and throws; the call fails and never sends again.
test("a prompt whose send threw after the frame left is not resent", async () => {
 let armed = false;
 const webSocket: WebSocketFactory = (url) => {
  const ws = new WebSocket(url);
  const deliver = ws.send.bind(ws);
  ws.send = (data: Parameters<WebSocket["send"]>[0]) => {
   deliver(data);
   if (armed) { armed = false; throw new Error("connection lost after the frame left"); }
  };
  return ws;
 };
 const { host, relay, transport } = await setup(true, { webSocket });
 await list(transport);
 armed = true;
 expect(await failure(prompt(transport, "only once"))).not.toBe("accepted");
 for (let i = 0; i < 100 && host.prompts.length === 0; i++) await Bun.sleep(10);
 await Bun.sleep(100);
 expect(host.prompts).toEqual(["only once"]);
 expect(relay.connects).toBe(1);
});

test("guest_paused ends reuse and guest_forbidden keeps it", async () => {
 const { host, gate, relay, transport } = await setup(true);
 await list(transport);
 expect(await failure(transport.call("agent.get", { target: "someone-else" }))).toBe("guest_forbidden");
 host.pause(true);
 expect(await failure(transport.call("agent.get", { target: "worker" }))).toBe("guest_paused");
 host.pause(false);
 await list(transport);
 await gate.sessions[0]!.ended;
 expect(relay.connects).toBe(2);
 expect(gate.sessions.map(s => [s.requests, s.end])).toEqual([[3, "guest_paused"], [1, ""]]);
});

test("streams open their own session", async () => {
 const host = herdr();
 const gate = guestGate({ multiRequest: true, answer: host.answer });
 let streams = 0;
 const relay = startRelay({
  admit: () => undefined,
  // The second connect is the stream's; the others go to the gate.
  async serve(conn, handshake) {
   if (relay.connects !== 2) return gate.serve(conn, handshake);
   streams++;
   const { reply } = await handshake();
   const session = reply({ ok: true, guest_id: "grant-1", features: { multi_request: true } });
   const line = JSON.parse((await session.readLine())!) as { id: string; method: string };
   expect(line.method).toBe("pane.stream");
   session.write(`{"id":"${line.id}","result":{"type":"pane_stream_started"}}\n`);
  },
 });
 relays.push(relay);
 const transport = new GuestTransport(accessOn(relay), staticKey(await generateIdentity()));
 transports.push(transport);
 await list(transport);
 const stream = await transport.openStream("pane.stream", { pane_id: "p1" });
 expect(await stream.next()).toContain("pane_stream_started");
 stream.close();
 await list(transport);
 expect(relay.connects).toBe(2);
 expect(streams).toBe(1);
 expect(gate.sessions.map(s => s.requests)).toEqual([2]);
});

test("concurrent calls never share a session at once", async () => {
 const { host, gate, relay, transport } = await setup(true);
 await list(transport);
 const held = host.hold();
 const slow = transport.call("agent.transcript", { target: "worker" });
 await held.arrived;
 const workers = await Promise.all([0, 1, 2, 3].map(async (w) => {
  for (let i = 0; i < 5; i++) {
   const want = `w${w}-${i}`;
   expect(await prompt(transport, want)).toEqual({ type: "agent_prompted", text: "visitor (via HerdrUp): " + want });
  }
 }));
 expect(workers).toHaveLength(4);
 held.release();
 expect(await slow).toEqual({ type: "agent_transcript", entries: [] });
 expect(gate.sessions.some(s => s.overlapped)).toBe(false);
 expect(gate.sessions.reduce((n, s) => n + s.requests, 0)).toBe(22);
 expect(relay.connects).toBeLessThan(21);
});

test("an idle session closes before herdr's limit", async () => {
 expect(REUSE_IDLE_LIMIT_MS).toBeLessThan(60_000);
 let now = 1_000_000;
 jest.useFakeTimers();
 const { gate, relay, transport } = await setup(true, { now: () => now });
 await list(transport);
 await list(transport);
 expect(relay.connects).toBe(1);
 now += REUSE_IDLE_LIMIT_MS - 1_000;
 jest.advanceTimersByTime(REUSE_IDLE_LIMIT_MS - 1_000);
 expect(gate.sessions[0]!.end).toBe("");
 now += 1_000;
 jest.advanceTimersByTime(1_000);
 expect(await gate.sessions[0]!.ended).toBe("guest");
 await list(transport);
 expect(relay.connects).toBe(2);
 expect(gate.sessions.map(s => s.requests)).toEqual([2, 1]);
});

test("an idle session past the limit by the clock is not reused", async () => {
 let now = 1_000_000;
 const { gate, relay, transport } = await setup(true, { now: () => now });
 await list(transport);
 now += REUSE_IDLE_LIMIT_MS - 1;
 await list(transport);
 expect(relay.connects).toBe(1);
 now += REUSE_IDLE_LIMIT_MS;
 await list(transport);
 expect(relay.connects).toBe(2);
 expect(await gate.sessions[0]!.ended).toBe("guest");
});

test("a reused session neither connects nor ends the backoff", async () => {
 const host = herdr();
 const gate = guestGate({ multiRequest: true, answer: host.answer });
 let refuse = false;
 const relay = startRelay({
  admit: () => refuse ? new Response('{"error":"rate_limited"}', { status: 429, headers: { "X-Herdr-Guest-Error": "rate_limited" } }) : undefined,
  serve: gate.serve,
 });
 relays.push(relay);
 const transport = new GuestTransport(accessOn(relay), staticKey(await generateIdentity()));
 transports.push(transport);
 await list(transport);
 const held = host.hold();
 const slow = transport.call("agent.transcript", { target: "worker" });
 await held.arrived;
 refuse = true;
 expect(await failure(transport.call("agent.list"))).toBe("rate_limited");
 const cooldown = transport.rateLimitedUntil();
 expect(cooldown).not.toBeNull();
 held.release();
 await slow;
 await list(transport);
 expect(transport.rateLimitedUntil()).toBe(cooldown);
 expect(relay.connects).toBe(2);
 expect(gate.sessions.map(s => s.requests)).toEqual([3]);
});

test("closing the transport closes its idle session", async () => {
 const { gate, relay, transport } = await setup(true);
 await list(transport);
 await list(transport);
 expect(relay.connects).toBe(1);
 transport.close();
 expect(await gate.sessions[0]!.ended).toBe("guest");
});
