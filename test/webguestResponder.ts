// Test-only: herdr's half of the guest handshake (the IK responder) on the web guest's own Noise
// state, and relays that run it per WebSocket: a real one on Bun.serve and an in-memory one.
// webguestNoise.test.ts pins this responder to herdr's vector before any transport test trusts it.

import { x25519 } from "@noble/curves/ed25519.js";
import { CipherState, concat, guestPrologue, PROTOCOL_NAME, SymmetricState } from "../src/webguest/noise";
import type { RelayWebSocket, WebSocketFactory } from "../src/webguest/transport";

export class Responder {
 #ss = new SymmetricState(PROTOCOL_NAME);
 #s: Uint8Array;
 #e: Uint8Array | undefined;
 #re = new Uint8Array(0);
 guestPublic = new Uint8Array(0);

 constructor(hostID: string, staticSecret: Uint8Array, ephemeralSecret?: Uint8Array) {
  this.#s = staticSecret;
  this.#e = ephemeralSecret;
  this.#ss.mixHash(guestPrologue(hostID));
  this.#ss.mixHash(x25519.getPublicKey(staticSecret));
 }

 /** -> e, es, s, ss */
 readHello(message: Uint8Array): Uint8Array {
  this.#re = message.slice(0, 32);
  this.#ss.mixHash(this.#re);
  this.#ss.mixKey(x25519.getSharedSecret(this.#s, this.#re));
  this.guestPublic = this.#ss.decryptAndHash(message.subarray(32, 80));
  this.#ss.mixKey(x25519.getSharedSecret(this.#s, this.guestPublic));
  return this.#ss.decryptAndHash(message.subarray(80));
 }

 /** <- e, ee, se; then the host's send and receive ciphers. */
 writeReply(payload: Uint8Array): { message: Uint8Array; send: CipherState; receive: CipherState; hash: Uint8Array } {
  const e = this.#e ?? x25519.utils.randomSecretKey();
  const ePublic = x25519.getPublicKey(e);
  this.#ss.mixHash(ePublic);
  this.#ss.mixKey(x25519.getSharedSecret(e, this.#re));
  this.#ss.mixKey(x25519.getSharedSecret(e, this.guestPublic));
  const message = concat(ePublic, this.#ss.encryptAndHash(payload));
  const [initiatorSend, initiatorReceive] = this.#ss.split();
  return { message, send: initiatorReceive, receive: initiatorSend, hash: this.#ss.h };
 }
}

/** Where a host's frames go: a Bun server socket, or the in-memory socket of memoryRelay. */
interface HostSink {
 send(data: Uint8Array | string): void;
 close(code: number, reason: string): void;
}

/** One guest WebSocket as the host sees it, as a pull stream. */
export class HostConn {
 inbox: (Uint8Array | string)[] = [];
 ended = false;
 #wake: (() => void) | null = null;
 #closed = Promise.withResolvers<void>();
 constructor(private readonly sink: HostSink) {}

 /** Resolves once the connection is over: the close handshake finished, so the guest heard it. */
 get closed(): Promise<void> { return this.#closed.promise; }

 push(data: Uint8Array | string) { this.inbox.push(data); this.#wake?.(); }
 end() { this.ended = true; this.#closed.resolve(); this.#wake?.(); }

 async read(): Promise<Uint8Array | string | null> {
  for (;;) {
   const next = this.inbox.shift();
   if (next !== undefined) return next;
   if (this.ended) return null;
   const { promise, resolve } = Promise.withResolvers<void>();
   this.#wake = resolve;
   await promise;
  }
 }

 send(data: Uint8Array | string) { if (!this.ended) this.sink.send(data); }
 close(code = 1000, reason = "") { this.sink.close(code, reason); }
}

/** A Noise session from the host's side: the guest's hello, then encrypted lines. */
export class HostSession {
 #pending = "";
 constructor(readonly conn: HostConn, readonly hello: Record<string, unknown>, readonly guestPublic: Uint8Array, readonly send: CipherState, readonly receive: CipherState) {}

 /** The guest's next "\n"-terminated line, reassembled across frames. */
 async readLine(): Promise<string | null> {
  for (;;) {
   const at = this.#pending.indexOf("\n");
   if (at >= 0) {
    const line = this.#pending.slice(0, at);
    this.#pending = this.#pending.slice(at + 1);
    return line;
   }
   const frame = await this.conn.read();
   if (frame === null || typeof frame === "string") return null;
   this.#pending += new TextDecoder().decode(this.receive.decryptWithAd(new Uint8Array(0), frame));
  }
 }

 write(text: string) { this.conn.send(this.send.encryptWithAd(new Uint8Array(0), new TextEncoder().encode(text))); }
}

export interface TestRelay {
 url: string;
 hostID: string;
 hostPublic: Uint8Array;
 connects: number;
 stop(): void;
}

type Serve = (conn: HostConn, handshake: () => Promise<{ hello: Record<string, unknown>; guestPublic: Uint8Array; reply: (payload: unknown) => HostSession }>) => Promise<void>;

/** Runs serve on one guest connection: herdr's handshake on demand, then the host's script. */
function host(conn: HostConn, hostID: string, hostSecret: Uint8Array, serve: Serve) {
 const handshake = async () => {
  const first = await conn.read();
  if (first === null || typeof first === "string") throw new Error("no hello");
  const responder = new Responder(hostID, hostSecret);
  const hello = JSON.parse(new TextDecoder().decode(responder.readHello(first))) as Record<string, unknown>;
  return {
   hello,
   guestPublic: responder.guestPublic,
   reply(payload: unknown) {
    const { message, send, receive } = responder.writeReply(new TextEncoder().encode(JSON.stringify(payload)));
    conn.send(message);
    return new HostSession(conn, hello, responder.guestPublic, send, receive);
   },
  };
 };
 void serve(conn, handshake).catch(() => conn.close(1011, "test host failed"));
}

/** A relay and host on 127.0.0.1. admit refuses an upgrade by returning a Response (the relay's
 *  429 or 503); serve runs each admitted connection. */
export function startRelay(options: { hostID?: string; admit?: (connect: number) => Response | undefined; serve: Serve }): TestRelay {
 const hostID = options.hostID ?? "AgICAgICAgICAgICAgICAg";
 const hostSecret = x25519.utils.randomSecretKey();
 const relay: TestRelay = { url: "", hostID, hostPublic: x25519.getPublicKey(hostSecret), connects: 0, stop: () => server.stop(true) };
 const server = Bun.serve<{ conn: HostConn }>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, srv) {
   if (new URL(request.url).pathname !== "/v1/guest/" + hostID) return new Response("not found", { status: 404 });
   const refused = options.admit?.(++relay.connects);
   if (refused !== undefined) return refused;
   if (srv.upgrade(request, { data: { conn: undefined as unknown as HostConn } })) return undefined;
   return new Response("upgrade required", { status: 426 });
  },
  websocket: {
   maxPayloadLength: 65535,
   open(ws) {
    ws.data.conn = new HostConn({ send: (data) => { ws.send(data); }, close: (code, reason) => ws.close(code, reason) });
    host(ws.data.conn, hostID, hostSecret, options.serve);
   },
   message(ws, message) { ws.data.conn.push(typeof message === "string" ? message : new Uint8Array(message)); },
   close(ws) { ws.data.conn.end(); },
  },
 });
 relay.url = `http://127.0.0.1:${server.port}`;
 return relay;
}

/** The same host behind an in-memory WebSocket, for traffic a loopback Bun server cannot carry
 *  in order (a 64 MiB reply) or codes it cannot send (it sends 1001 as 1000). */
export function memoryRelay(serve: Serve): { relay: TestRelay; webSocket: WebSocketFactory } {
 const hostID = "AwMDAwMDAwMDAwMDAwMDAw";
 const hostSecret = x25519.utils.randomSecretKey();
 const relay: TestRelay = { url: "https://relay.example", hostID, hostPublic: x25519.getPublicKey(hostSecret), connects: 0, stop() {} };
 const webSocket: WebSocketFactory = () => {
  relay.connects++;
  const ws: RelayWebSocket & { readyState: number } = {
   binaryType: "blob", readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null,
   send(data) { if (ws.readyState === 1) conn.push(data.slice()); },
   close() { ws.readyState = 3; conn.end(); },
  };
  // The host's close reaches the page's socket at once and its close event a microtask later, as a
  // browser's does: a frame sent in between is dropped.
  const conn = new HostConn({
   send: (data) => { const copy = typeof data === "string" ? data : data.slice().buffer; queueMicrotask(() => ws.onmessage?.(new MessageEvent("message", { data: copy }))); },
   close: (code, reason) => { ws.readyState = 3; conn.end(); queueMicrotask(() => ws.onclose?.(new CloseEvent("close", { code, reason, wasClean: true }))); },
  });
  queueMicrotask(() => { ws.readyState = 1; ws.onopen?.(new Event("open")); host(conn, hostID, hostSecret, serve); });
  return ws;
 };
 return { relay, webSocket };
}

/** One session's life at guestGate: the request lines it served, and why it ended ("" while open):
 *  "guest" (the guest closed it), "reply" (one request answered, no multiRequest), "idle",
 *  "guest_paused", "guest_revoked", "invalid_request", "dropped" (a reply lost) or "ended" (endAll).
 *  ended resolves with that once the connection is over. */
export interface GateSession { requests: number; end: string; overlapped: boolean; ended: Promise<string> }

/** A request's answer: its result or error reply, or "drop" for a reply lost after herdr served it. */
export type GateAnswer = { result: unknown } | { error: { code: string; message?: string } } | "drop";

/** herdr's guest gate, as Go's fakeherdr.GuestRelay: one request per session, or with multiRequest
 *  (jerryfane/herdr#356, guest_gate.rs serve_session) requests in turn until it ends the session after
 *  idleLimitMs without one, after guest_paused, guest_revoked or invalid_request, or on endAll.
 *  answer may be async: overlapped records a session whose guest sent while a request was out. */
export function guestGate(options: { multiRequest: boolean; idleLimitMs?: number; guestID?: string; gram?: () => boolean; answer: (method: string, params: Record<string, unknown>) => GateAnswer | Promise<GateAnswer> }): { serve: Serve; sessions: GateSession[]; endAll(): void } {
 const sessions: GateSession[] = [];
 const live = new Set<() => void>();
 const serve: Serve = async (conn, handshake) => {
  const { reply } = await handshake();
  const host = reply({ ok: true, guest_id: options.guestID ?? "grant-1", features: { ...(options.multiRequest ? { multi_request: true } : {}), ...(options.gram?.() ? { gram: true } : {}) } });
  const session: GateSession = { requests: 0, end: "", overlapped: false, ended: conn.closed.then(() => session.end ||= "guest") };
  sessions.push(session);
  const ended = Promise.withResolvers<"ended">();
  // endAll closes the connection at once, as herdr's stop or a revoke does.
  const finish = (why: string) => { live.delete(end); session.end ||= why; conn.close(1000); };
  const end = () => { finish("ended"); ended.resolve("ended"); };
  live.add(end);
  for (;;) {
   let timer: ReturnType<typeof setTimeout> | undefined;
   const idle = new Promise<"idle">((resolve) => { timer = setTimeout(() => resolve("idle"), options.idleLimitMs ?? 60_000); });
   const next = await Promise.race([host.readLine(), idle, ended.promise]);
   clearTimeout(timer);
   if (next === "idle" || next === "ended") return finish(next);
   if (next === null) { live.delete(end); session.end ||= "guest"; return; }
   session.requests++;
   let request: { id: string; method: string; params?: Record<string, unknown> };
   try {
    request = JSON.parse(next) as typeof request;
   } catch {
    host.write(JSON.stringify({ id: "", error: { code: "invalid_request", message: "invalid request" } }) + "\n");
    return finish("invalid_request");
   }
   const answer = await options.answer(request.method, request.params ?? {});
   if (conn.inbox.length > 0) session.overlapped = true;
   if (answer === "drop") return finish("dropped");
   host.write(JSON.stringify({ id: request.id, ...answer }) + "\n");
   if ("error" in answer && ["guest_paused", "guest_revoked"].includes(answer.error.code)) return finish(answer.error.code);
   if (!options.multiRequest) return finish("reply");
  }
 };
 return { serve, sessions, endAll() { for (const end of [...live]) end(); } };
}
