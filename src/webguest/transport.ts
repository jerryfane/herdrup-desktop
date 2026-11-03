// The guest relay protocol over a browser WebSocket, ported from internal/guest/session.go and
// transport.go. A guest connection is a WebSocket and a Noise IK handshake:
//   wss://<relay>/v1/guest/<host id>, binary frames, no subprotocol
//   -> message 1: e, es, s, ss + hello {"v":1,"guest_id"} or redeem {"v":1,"invite_id","secret","device"}
//   <- message 2: e, ee, se + the host's admission reply
//   -> one JSON-RPC request line, "\n"-terminated, split across frames at the plaintext limit
//   <- reply lines, "\n"-delimited, frame boundaries unrelated to line boundaries.
// herdr used to answer one request per connection (src/api/server.rs:1516-1562 at f0b7ae61). A host
// whose reply says features.multi_request (jerryfane/herdr#356, guest_gate.rs serve_session) reads
// the next request line after each reply, one request at a time, until it ends the session: after
// 60 s without a request, after a guest_paused, guest_revoked or invalid_request reply, on a revoke
// or its stop, or when pane.stream takes the session over. guest_forbidden leaves it open.
//
// The relay's refusals (GuestRelay src/relay.ts:61-64, src/host.ts:86-95 at herdrup 9845ecf) are
// HTTP answers to the upgrade: 429 rate_limited, 503 host_offline or host_busy, each naming its code
// in X-Herdr-Guest-Error. Go reads both (session.go:83-103). A page cannot: the WebSocket API never
// exposes a failed upgrade's status or headers. What it sees is an `error` event and then a `close`
// event with code 1006, an empty reason and wasClean false, without `open` ever firing (Bun reports
// 1002 "Expected 101 status code"); an unreachable relay looks the same. So every connect closed
// before it opened is read as the relay's 429 (relayRefused) and starts Go's backoff: at worst a
// shared machine that is offline, or a dropped network, is retried 15 s later instead of at once.

import { closed, expired, GuestError, HerdrAPIError, hostOffline, other, rateLimited, relayRefused, revoked, timedOut } from "./errors";
import { socketURL, type Endpoint, type Invite } from "./invite";
import { Initiator, MAX_NOISE_MESSAGE, MAX_NOISE_PLAINTEXT, NoiseSession, type StaticKey } from "./noise";

/** A call's whole round trip, handshake included (session.go:18). */
export const ROUND_TRIP_LIMIT_MS = 60_000;
/** The longest reply line (internal/bridge/client.go:29). */
export const MAX_REPLY_LINE_BYTES = 64 << 20;
// transport.go:32-39: after the relay's 429 a transport waits 15 s, doubling to a minute while the
// relay keeps refusing; a connect that goes through starts over.
export const RELAY_BACKOFF_FIRST_MS = 15_000;
export const RELAY_BACKOFF_MAX_MS = 60_000;

/** The wait after the relay's next 429, given the last (transport.go:41-47). */
export function relayBackoff(lastMs: number): number {
 return lastMs === 0 ? RELAY_BACKOFF_FIRST_MS : Math.min(2 * lastMs, RELAY_BACKOFF_MAX_MS);
}

/** reuseIdleLimit (transport.go): how long a transport keeps a session idle for its next call,
 *  10 s short of herdr's 60 s SESSION_IDLE_TIMEOUT so a call never races herdr's close. */
export const REUSE_IDLE_LIMIT_MS = 50_000;
/** The most a session is reused after its handshake, the only place herdr tells the guest its
 *  features (transport.go reuseAgeLimit): an owner turning Gram sharing on or off reaches the page
 *  within this. A call in flight is never cut. */
export const REUSE_AGE_LIMIT_MS = 120_000;

/** multiRequest: the host answers further requests on a session after a reply (features.multi_request). */
export interface Features { gram: boolean; push: boolean; multiRequest: boolean }

/** A grant this browser holds (session.go:34-45). No bearer secret: the invite's stays in memory. */
export interface Access {
 guestID: string;
 guestName: string;
 machineLabel: string;
 ownerName: string;
 agentName: string;
 agentTarget: string;
 endpoint: Endpoint;
 acceptedAt: Date;
}

/** The part of the WebSocket API the transport uses, so tests can inject one. */
export interface RelayWebSocket {
 binaryType: BinaryType;
 /** WebSocket.OPEN (1) while frames sent go out; a closing or closed socket drops them. */
 readonly readyState: number;
 send(data: Uint8Array<ArrayBuffer>): void;
 close(): void;
 onopen: ((event: Event) => void) | null;
 onmessage: ((event: MessageEvent) => void) | null;
 onerror: ((event: Event) => void) | null;
 onclose: ((event: CloseEvent) => void) | null;
}
export type WebSocketFactory = (url: string) => RelayWebSocket;
const browserWebSocket: WebSocketFactory = (url) => new WebSocket(url);

/** One signal aborted by any parent, or after timeoutMs. dispose detaches it. */
function linkSignals(parents: (AbortSignal | undefined)[], timeoutMs?: number) {
 const controller = new AbortController();
 const cleanups: (() => void)[] = [];
 for (const parent of parents) {
  if (parent === undefined) continue;
  if (parent.aborted) { controller.abort(parent.reason); break; }
  const forward = () => controller.abort(parent.reason);
  parent.addEventListener("abort", forward, { once: true });
  cleanups.push(() => parent.removeEventListener("abort", forward));
 }
 if (timeoutMs !== undefined && !controller.signal.aborted) {
  const timer = setTimeout(() => controller.abort(timedOut()), timeoutMs);
  cleanups.push(() => clearTimeout(timer));
 }
 return { signal: controller.signal, dispose: () => { for (const cleanup of cleanups) cleanup(); } };
}

/** session.go:105-123: how a close after the upgrade reads. null is a clean end (io.EOF). */
// The relay's close codes for a guest upgrade it accepted only to refuse (herdrup GuestRelay,
// themartianapp/herdrup#610; Go session.go socketError): a page can read these, unlike the HTTP
// status of a refused upgrade, which still reaches it as relayRefused from older relays.
const CLOSE_RATE_LIMITED = 4429, CLOSE_HOST_OFFLINE = 4503, CLOSE_HOST_BUSY = 4504;

export function closeError(code: number, reason: string): GuestError | null {
 if (code === CLOSE_RATE_LIMITED) return rateLimited();
 if (code === CLOSE_HOST_OFFLINE) return hostOffline();
 if (code === CLOSE_HOST_BUSY || reason === "host_busy") return other("The shared machine is busy. Try again shortly.");
 if (code === 1000 && reason === "") return null;
 if (code === 1001) return hostOffline();
 if (code === 1009) return other("The shared machine rejected an oversized message.");
 return other(`The shared connection closed (code ${code}).`);
}

type Received = Uint8Array | "text";

/** The most a socket holds unread. Go reads with a 65535-byte limit and TCP holds the rest back
 *  (session.go:16, 136); a page cannot push back, so a backlog past these ends the connection
 *  instead. Any reply this large already exceeds the line limit. */
export const MAX_QUEUED_BYTES = MAX_REPLY_LINE_BYTES + MAX_NOISE_MESSAGE;
/** Frames count apart from their bytes, so empty or text frames cannot queue without end: room
 *  for a whole 64 MiB reply in 1 KiB pieces. */
export const MAX_QUEUED_FRAMES = 65536;

/** A relay WebSocket as a pull stream of frames. Aborting its signal closes it (transport.go:435). */
class RelaySocket {
 #ws: RelayWebSocket;
 #inbox: Received[] = [];
 #queued = 0;
 #end: { error: unknown } | "eof" | null = null;
 #wake: (() => void) | null = null;
 #signal: AbortSignal;
 #onAbort = () => this.abort(this.#signal.reason);
 #onEnd: (() => void) | null = null;

 private constructor(ws: RelayWebSocket, signal: AbortSignal) {
  this.#ws = ws;
  this.#signal = signal;
 }

 /** Resolves once the upgrade succeeds. A close before then is a refused upgrade (see the top). */
 static async connect(url: string, factory: WebSocketFactory, signal: AbortSignal): Promise<RelaySocket> {
  if (signal.aborted) throw signal.reason;
  const ws = factory(url);
  ws.binaryType = "arraybuffer";
  const socket = new RelaySocket(ws, signal);
  const opened = Promise.withResolvers<void>();
  ws.onopen = () => opened.resolve();
  ws.onmessage = (event) => {
   const frame = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : "text";
   const size = frame === "text" ? 0 : frame.length;
   // Checked on arrival, as Go's read limit is (session.go:136): an oversized frame or a backlog
   // past MAX_QUEUED_BYTES or MAX_QUEUED_FRAMES ends the connection and frees what it holds.
   if (size > MAX_NOISE_MESSAGE || socket.#queued + size > MAX_QUEUED_BYTES || socket.#inbox.length >= MAX_QUEUED_FRAMES) {
    socket.#overflow(size > MAX_NOISE_MESSAGE);
    return;
   }
   socket.#queued += size;
   socket.#inbox.push(frame);
   socket.#notify();
  };
  // A failed connection's error event is always followed by its close event.
  ws.onerror = () => {};
  ws.onclose = (event) => {
   const error = closeError(event.code, event.reason);
   socket.#finish(error === null ? "eof" : { error });
   opened.reject(relayRefused());
  };
  const abort = () => opened.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
   await opened.promise;
  } catch (error) {
   socket.close();
   throw error;
  } finally {
   signal.removeEventListener("abort", abort);
  }
  // An abort between open and here found opened already settled.
  if (signal.aborted) { socket.close(); throw signal.reason; }
  signal.addEventListener("abort", socket.#onAbort, { once: true });
  return socket;
 }

 #notify() {
  const wake = this.#wake;
  this.#wake = null;
  wake?.();
 }

 #overflow(oversized: boolean) {
  this.#inbox = []; this.#queued = 0;
  this.#finish({ error: other(oversized ? "The shared machine sent an oversized message." : "The shared machine sent more than this page can hold.") });
  this.#ws.onmessage = null;
  // A page may close only with 1000 or 3000-4999, so no 1009 here; the relay sees a normal close.
  try { this.#ws.close(); } catch { /* already closed */ }
 }

 #finish(end: { error: unknown } | "eof") {
  this.#end ??= end;
  this.#notify();
  const onEnd = this.#onEnd;
  this.#onEnd = null;
  onEnd?.();
 }

 /** Whether the socket is open with nothing unread: an idle session herdr has not ended or sent on. */
 get quiet(): boolean { return this.#end === null && this.#inbox.length === 0; }

 /** Calls onEnd once the socket ends, however it does; at once if it has. */
 whenEnded(onEnd: () => void) {
  if (this.#end !== null) { onEnd(); return; }
  this.#onEnd = onEnd;
 }

 /** Sends a frame, or throws when it cannot go out: the socket ended, or is closing, which a
  *  browser tells only by dropping the frame. handing runs just before the frame is handed to the
  *  socket: from then on herdr may have it, even if the socket throws (herdrup#612 review). */
 send(data: Uint8Array, handing?: () => void) {
  const end = this.#end;
  if (end !== null) throw end === "eof" ? closed() : end.error;
  if (this.#ws.readyState !== 1) throw closed();
  handing?.();
  // Every frame is a fresh ciphertext from @noble/ciphers, backed by an ArrayBuffer of its own;
  // its type only says ArrayBufferLike.
  const frame = data as Uint8Array<ArrayBuffer>;
  this.#ws.send(frame);
 }

 /** The next frame, or null after a clean close. Frames that arrived before a close are read first. */
 async read(): Promise<Received | null> {
  for (;;) {
   const next = this.#inbox.shift();
   if (next !== undefined) { if (next !== "text") this.#queued -= next.length; return next; }
   const end = this.#end;
   if (end === "eof") return null;
   if (end !== null) throw end.error;
   const { promise, resolve } = Promise.withResolvers<void>();
   this.#wake = resolve;
   await promise;
  }
 }

 close() { this.abort(closed()); }

 /** Closes the socket; a read waiting on it fails with reason. */
 abort(reason: unknown) {
  this.#signal.removeEventListener("abort", this.#onAbort);
  this.#finish({ error: reason });
  this.#ws.onopen = this.#ws.onmessage = this.#ws.onerror = this.#ws.onclose = null;
  try { this.#ws.close(); } catch { /* already closed */ }
 }
}

/** The admission reply, message 2's payload (session.go:47-59). */
interface HelloReply {
 ok: boolean;
 error: string;
 guestID: string;
 name: string;
 machineLabel: string;
 ownerName: string;
 agent: { name: string; target: string } | null;
 features: Features;
}

/** Decodes the reply as Go's json.Unmarshal into helloReply would: null is absent, a wrong type fails,
 *  and ok must be present. */
function parseHelloReply(plaintext: Uint8Array): HelloReply {
 const invalid = () => other("The shared machine's secure reply is invalid.");
 let value: unknown;
 try { value = JSON.parse(new TextDecoder().decode(plaintext)); } catch { throw invalid(); }
 if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid();
 const object = value as Record<string, unknown>;
 const text = (key: string): string => {
  const field = object[key];
  if (field === undefined || field === null) return "";
  if (typeof field !== "string") throw invalid();
  return field;
 };
 const flag = (from: Record<string, unknown>, key: string): boolean => {
  const field = from[key];
  if (field === undefined || field === null) return false;
  if (typeof field !== "boolean") throw invalid();
  return field;
 };
 const record = (field: unknown): Record<string, unknown> | null => {
  if (field === undefined || field === null) return null;
  if (typeof field !== "object" || Array.isArray(field)) throw invalid();
  return field as Record<string, unknown>;
 };
 if (typeof object.ok !== "boolean") throw invalid();
 const agent = record(object.agent);
 const features = record(object.features) ?? {};
 const reply: HelloReply = {
  ok: object.ok, error: text("error"), guestID: text("guest_id"), name: text("name"), machineLabel: text("machine_label"), ownerName: text("owner_name"),
  agent: null, features: { gram: flag(features, "gram"), push: flag(features, "push"), multiRequest: flag(features, "multi_request") },
 };
 if (agent !== null) {
  const name = agent.name ?? "", target = agent.target ?? "";
  if (typeof name !== "string" || typeof target !== "string") throw invalid();
  reply.agent = { name, target };
 }
 return reply;
}

/** session.go:68-81. */
function refusal(code: string): GuestError {
 switch (code) {
  case "unknown": case "revoked": return revoked();
  case "invite_used": return other("This invitation was already used. Ask the owner for a new one.");
  case "invite_expired": return expired();
  case "invite_invalid": return other("The owner did not accept this invitation. Ask for a new link.");
  default: return other("The shared machine refused this guest connection.");
 }
}

/** An authenticated relay connection (session.go:61-66). */
class Session {
 /** When the handshake that read reply's features finished (ms since the epoch), set by #connect. */
 handshook = 0;
 constructor(private readonly socket: RelaySocket, private readonly noise: NoiseSession, readonly reply: HelloReply) {}

 close() { this.socket.close(); }
 /** Closes the session; a read waiting on it fails with reason. */
 abort(reason: unknown) { this.socket.abort(reason); }
 /** Open, and herdr sent nothing on it since the last reply: fit to carry the next request. */
 get quiet(): boolean { return this.socket.quiet; }
 whenEnded(onEnd: () => void) { this.socket.whenEnded(onEnd); }

 /** session.go sendLine: the line and its "\n", split at the plaintext limit. onFrame hears each
  *  frame about to be handed to the socket: until one is, herdr cannot have the request. */
 sendLine(line: Uint8Array, onFrame?: () => void) {
  const framed = new Uint8Array(line.length + 1);
  framed.set(line);
  framed[line.length] = 0x0a;
  for (let at = 0; at < framed.length; at += MAX_NOISE_PLAINTEXT) {
   this.socket.send(this.noise.encrypt(framed.subarray(at, at + MAX_NOISE_PLAINTEXT)), onFrame);
  }
 }

 /** session.go:199-212: the next decrypted frame, or null after a clean close. */
 async readChunk(): Promise<Uint8Array | null> {
  const frame = await this.socket.read();
  if (frame === null) return null;
  if (frame === "text") throw other("The relay sent an unencrypted message; the connection was refused.");
  try {
   return this.noise.decrypt(frame);
  } catch {
   throw other("A shared-machine message failed authentication; the connection was refused.");
  }
 }
}

/** session.go:125-178: dial, handshake, and the host's admission. */
async function openSession(endpoint: Endpoint, identity: StaticKey, hello: Uint8Array, signal: AbortSignal, factory: WebSocketFactory): Promise<Session> {
 const address = socketURL(endpoint);
 if (endpoint.hostPublicKey.length !== 32) throw other("The shared machine's saved identity is damaged.");
 const handshake = new Initiator({ hostID: endpoint.hostID, hostPublicKey: endpoint.hostPublicKey, staticKey: identity });
 let message: Uint8Array;
 try {
  message = await handshake.writeHello(hello);
 } catch (error) {
  throw other(`prepare secure guest hello: ${error instanceof Error ? error.message : String(error)}`);
 }
 const socket = await RelaySocket.connect(address, factory, signal);
 try {
  socket.send(message);
  const reply = await socket.read();
  if (reply === null) throw other("The shared machine closed the connection during the secure handshake.");
  if (reply === "text") throw other("The relay did not return a secure binary handshake.");
  let established: { payload: Uint8Array; session: NoiseSession };
  try {
   established = await handshake.readReply(reply);
  } catch {
   throw other("Could not verify the shared machine's identity. The secure connection was refused.");
  }
  const admission = parseHelloReply(established.payload);
  if (!admission.ok) throw refusal(admission.error);
  return new Session(socket, established.session, admission);
 } catch (error) {
  socket.close();
  throw error;
 }
}

export interface AcceptOptions {
 /** Milliseconds since the epoch; default Date.now(). */
 now?: number;
 signal?: AbortSignal;
 webSocket?: WebSocketFactory;
}

/** Redeems an invitation for this browser's identity (session.go:214-246). */
export async function acceptInvite(invite: Invite, identity: StaticKey, device: string, options: AcceptOptions = {}): Promise<Access> {
 const now = options.now ?? Date.now();
 if (now >= invite.expires.getTime()) throw expired();
 const { signal, dispose } = linkSignals([options.signal], ROUND_TRIP_LIMIT_MS);
 try {
  const hello = invite.helloPayload(device);
  let connected: Session;
  try {
   connected = await openSession(invite.endpoint, identity, hello, signal, options.webSocket ?? browserWebSocket);
  } finally {
   hello.fill(0);
  }
  connected.close();
  const reply = connected.reply;
  if (reply.guestID === "" || reply.agent === null || reply.agent.target === "") {
   throw other("The owner accepted the invitation but returned incomplete access. Ask the owner to inspect the guest grant before trying again.");
  }
  return {
   guestID: reply.guestID, guestName: reply.name || invite.guestName, machineLabel: reply.machineLabel || invite.machineLabel,
   ownerName: reply.ownerName || invite.ownerName, agentName: reply.agent.name || invite.agentName, agentTarget: reply.agent.target,
   endpoint: invite.endpoint, acceptedAt: new Date(now),
  };
 } finally {
  dispose();
 }
}

/** A session's reply lines (transport.go lineReader); frame boundaries are unrelated to them. next
 *  resolves to null after the host's clean close. */
class LineReader {
 #session: Session;
 #pending: Uint8Array = new Uint8Array(0);

 constructor(session: Session) { this.#session = session; }

 /** Whether bytes past the last line arrived: herdr sent more than a reply. */
 get leftover(): boolean { return this.#pending.length > 0; }

 async next(): Promise<string | null> {
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
   const at = this.#pending.indexOf(0x0a);
   if (at >= 0) {
    if (length + at > MAX_REPLY_LINE_BYTES) throw other("Shared-machine reply exceeds the maximum line size.");
    parts.push(this.#pending.subarray(0, at));
    this.#pending = this.#pending.subarray(at + 1);
    return new TextDecoder().decode(parts.length === 1 ? parts[0] : joinParts(parts, length + at));
   }
   if (length + this.#pending.length > MAX_REPLY_LINE_BYTES) throw other("Shared-machine reply exceeds the maximum line size.");
   if (this.#pending.length > 0) { parts.push(this.#pending); length += this.#pending.length; }
   this.#pending = new Uint8Array(0);
   const chunk = await this.#session.readChunk();
   if (chunk === null) {
    if (length > 0) throw other("The shared machine closed the connection in the middle of a reply.");
    return null;
   }
   this.#pending = chunk;
  }
 }
}

/** A request's reply lines on a session of its own (transport.go relayStream). next resolves to
 *  null after the host's clean close. */
export class GuestStream implements AsyncIterable<string> {
 #session: Session;
 #lines: LineReader;
 #dispose: () => void;
 #closed = false;

 constructor(session: Session, dispose: () => void) {
  this.#session = session;
  this.#lines = new LineReader(session);
  this.#dispose = dispose;
 }

 next(): Promise<string | null> { return this.#lines.next(); }

 close() {
  if (this.#closed) return;
  this.#closed = true;
  this.#session.close();
  this.#dispose();
 }

 async *[Symbol.asyncIterator](): AsyncIterator<string> {
  try {
   for (let line = await this.next(); line !== null; line = await this.next()) yield line;
  } finally {
   this.close();
  }
 }
}

function joinParts(parts: Uint8Array[], length: number): Uint8Array {
 const out = new Uint8Array(length);
 let at = 0;
 for (const part of parts) { out.set(part, at); at += part.length; }
 return out;
}

/** internal/bridge/client.go:265-281: a reply's result, or its API error. */
export function decodeReply(line: string): unknown {
 let reply: unknown;
 try { reply = JSON.parse(line); } catch (error) { throw other(`decode herdr reply: ${error instanceof Error ? error.message : String(error)}`); }
 if (typeof reply !== "object" || reply === null || Array.isArray(reply)) throw other("decode herdr reply: not an object");
 const error = "error" in reply ? reply.error : null;
 if (error !== undefined && error !== null) {
  if (typeof error !== "object" || Array.isArray(error)) throw other("decode herdr reply: malformed error");
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  throw new HerdrAPIError(code, message, error);
 }
 return "result" in reply ? reply.result ?? null : null;
}

export interface TransportOptions {
 /** The clock, in milliseconds; default Date.now. */
 now?: () => number;
 webSocket?: WebSocketFactory;
 /** A call's round-trip limit; ROUND_TRIP_LIMIT_MS outside tests. */
 callLimitMs?: number;
}

export interface RequestOptions { signal?: AbortSignal }

/** The idle session a call left for the next one, since `since`, with its expiry timer. */
interface IdleSession { session: Session; since: number; timer: ReturnType<typeof setTimeout> }

/** What a request on a session came to (transport.go roundTrip): its reply line and whether the
 *  session is still open, or its failure and whether a frame of it went out (so herdr may have it). */
type RoundTrip = { line: string; open: boolean } | { error: unknown; sent: boolean };

/** guest_gate.rs serve_session (herdr #356) ends the session after these replies. */
const SESSION_ENDING_CODES = new Set(["guest_paused", "guest_revoked", "invalid_request"]);

/** Whether herdr serves further requests after a reply that decoded to error (transport.go
 *  keepsSession): not after the codes that end the session, nor after a reply that did not decode. */
function keepsSession(error: unknown): boolean {
 if (error === null) return true;
 return error instanceof HerdrAPIError && !SESSION_ENDING_CODES.has(error.code);
}

/** Opens authenticated Noise sessions for API requests (transport.go Transport). A host that answers
 *  further requests on a session (features.multi_request) keeps the one a call ends with for the
 *  next call, so polling stays under the relay's connect limit; otherwise every request has a fresh
 *  session. A call takes the idle session, so a session never carries two requests at once; calls
 *  that overlap it connect. Streams always have a session of their own. Closing the transport ends
 *  established streams, the idle session and pending handshakes. After a refused upgrade every
 *  request that needs a connect fails with a rate_limited GuestError, without connecting, until the
 *  backoff ends. */
export class GuestTransport {
 #access: Access;
 #identity: StaticKey;
 #now: () => number;
 #factory: WebSocketFactory;
 #callLimitMs: number;
 #life = new AbortController();
 #seq = 0;
 #features: Features = { gram: false, push: false, multiRequest: false };
 // backoffMs is the wait after the last refusal and retryAt its end; both 0 once a connect goes
 // through. refusals counts the refusals that started a backoff, so a connect that began before one
 // cannot end it.
 #backoffMs = 0;
 #retryAt = 0;
 #refusals = 0;
 #idle: IdleSession | null = null;

 constructor(access: Access, identity: StaticKey, options: TransportOptions = {}) {
  this.#access = access;
  this.#identity = identity;
  this.#now = options.now ?? Date.now;
  this.#factory = options.webSocket ?? browserWebSocket;
  this.#callLimitMs = options.callLimitMs ?? ROUND_TRIP_LIMIT_MS;
 }

 get features(): Features { return { ...this.#features }; }
 get closed(): boolean { return this.#life.signal.aborted; }
 close() {
  if (!this.closed) this.#life.abort(closed());
  const idle = this.#idle;
  this.#idle = null;
  if (idle !== null) { clearTimeout(idle.timer); idle.session.close(); }
 }

 /** When the transport connects again after a refusal; null when it is not waiting (transport.go:78-87). */
 rateLimitedUntil(): number | null {
  return this.#now() < this.#retryAt ? this.#retryAt : null;
 }

 /** transport.go:89-102: the next backoff after a refusal, unless one started while this connect
  *  was in flight, since the requests out at once all hear the same refusal. */
 #limited() {
  const now = this.#now();
  if (now < this.#retryAt) return;
  this.#backoffMs = relayBackoff(this.#backoffMs);
  this.#retryAt = now + this.#backoffMs;
  this.#refusals++;
 }

 /** transport.go:112-124: a connect the relay let through, begun after `refusals` refusals, ends the
  *  backoff only when none came while it was in flight (post-merge review of #103, F1). */
 #admitted(refusals: number, features: Features) {
  this.#features = features;
  if (this.#refusals === refusals) { this.#backoffMs = 0; this.#retryAt = 0; }
 }

 /** One request and its decoded result, within ROUND_TRIP_LIMIT_MS (transport.go Call). It goes on
  *  the idle session if there is one; when that session was known to have ended before any frame of
  *  the request was handed to the socket, so herdr cannot have it, the request goes once more on a
  *  fresh session. Once a frame was handed over the request is never sent again, whatever the socket
  *  did: it could be an agent.prompt (herdrup#612 review). */
 async call(method: string, params?: unknown, options: RequestOptions = {}): Promise<unknown> {
  const { signal, dispose } = linkSignals([this.#life.signal, options.signal], this.#callLimitMs);
  try {
   if (signal.aborted) throw signal.reason;
   const request = this.#request(method, params);
   const reused = this.#takeIdle();
   if (reused !== null) {
    const outcome = await roundTrip(reused, request, signal);
    if ("line" in outcome) return this.#decode(reused, outcome);
    if (outcome.sent || signal.aborted) throw outcome.error;
   }
   const session = await this.#connect(signal);
   const outcome = await roundTrip(session, request, signal);
   if (!("line" in outcome)) throw outcome.error;
   return this.#decode(session, outcome);
  } finally {
   dispose();
  }
 }

 /** One request whose reply lines are read until the host closes, e.g. pane.stream, on a session of
  *  its own: pane.stream takes a session over (transport.go OpenStream). The caller closes the stream. */
 async openStream(method: string, params?: unknown, options: RequestOptions = {}): Promise<GuestStream> {
  if (this.closed) throw this.#life.signal.reason;
  const { signal, dispose } = linkSignals([this.#life.signal, options.signal]);
  let session: Session | null = null;
  try {
   session = await this.#connect(signal);
   session.sendLine(this.#request(method, params));
   return new GuestStream(session, dispose);
  } catch (error) {
   session?.close();
   dispose();
   throw error;
  }
 }

 #request(method: string, params: unknown): Uint8Array {
  const id = "herdrup:guest:" + ++this.#seq;
  return new TextEncoder().encode(JSON.stringify({ id, method, params: params ?? {} }));
 }

 /** A session for the access (transport.go connect), unless the relay's backoff holds connects back. */
 async #connect(signal: AbortSignal): Promise<Session> {
  const refusals = this.#refusals;
  if (this.#now() < this.#retryAt) throw rateLimited();
  const hello = new TextEncoder().encode(JSON.stringify({ v: 1, guest_id: this.#access.guestID }));
  let session: Session;
  try {
   session = await openSession(this.#access.endpoint, this.#identity, hello, signal, this.#factory);
  } catch (error) {
   if (error instanceof GuestError && error.kind === "rate_limited") this.#limited();
   throw error;
  }
  if (session.reply.guestID !== this.#access.guestID) { session.close(); throw revoked(); }
  this.#admitted(refusals, session.reply.features);
  session.handshook = this.#now();
  return session;
 }

 /** Decodes the reply line session carried, then leaves session idle for the next call when it is
  *  open and herdr keeps serving it, or closes it (transport.go decode). */
 #decode(session: Session, outcome: { line: string; open: boolean }): unknown {
  let result: unknown, failure: unknown = null;
  try { result = decodeReply(outcome.line); } catch (error) { failure = error; }
  if (outcome.open && session.reply.features.multiRequest && keepsSession(failure)) this.#park(session);
  else session.close();
  if (failure !== null) throw failure;
  return result;
 }

 /** Takes the idle session for a call, or null when there is none fit to carry one: herdr ended it
  *  or sent on it, or it waited REUSE_IDLE_LIMIT_MS (transport.go takeIdle). */
 #takeIdle(): Session | null {
  const idle = this.#idle;
  this.#idle = null;
  if (idle === null) return null;
  clearTimeout(idle.timer);
  const now = this.#now();
  if (!idle.session.quiet || now - idle.since >= REUSE_IDLE_LIMIT_MS || now - idle.session.handshook >= REUSE_AGE_LIMIT_MS) { idle.session.close(); return null; }
  return idle.session;
 }

 /** Leaves session idle for the next call, in place of any session idle already, until
  *  REUSE_IDLE_LIMIT_MS passes or herdr ends it (transport.go park). */
 #park(session: Session) {
  if (this.#now() - session.handshook >= REUSE_AGE_LIMIT_MS) { session.close(); return; }
  if (this.closed) { session.close(); return; }
  const previous = this.#idle;
  if (previous !== null) { clearTimeout(previous.timer); previous.session.close(); }
  const drop = () => {
   if (this.#idle !== idle) return;
   this.#idle = null;
   clearTimeout(idle.timer);
   session.close();
  };
  const idle: IdleSession = { session, since: this.#now(), timer: setTimeout(drop, REUSE_IDLE_LIMIT_MS) };
  this.#idle = idle;
  session.whenEnded(drop);
 }
}

/** Sends request on session and reads its reply line (transport.go roundTrip). On a failure the
 *  session is closed; aborting signal closes it with the signal's reason. */
async function roundTrip(session: Session, request: Uint8Array, signal: AbortSignal): Promise<RoundTrip> {
 const abort = () => session.abort(signal.reason);
 signal.addEventListener("abort", abort, { once: true });
 try {
  let sent = false;
  try {
   session.sendLine(request, () => { sent = true; });
  } catch (error) {
   session.close();
   return { error, sent };
  }
  const lines = new LineReader(session);
  let line: string | null;
  try {
   line = await lines.next();
  } catch (error) {
   session.close();
   return { error, sent: true };
  }
  if (line === null) {
   session.close();
   return { error: other("The shared machine closed the connection before replying."), sent: true };
  }
  // Anything after the reply line, or an abort that closed the session meanwhile, spends it.
  return { line, open: !lines.leftover && !signal.aborted && session.quiet };
 } finally {
  signal.removeEventListener("abort", abort);
 }
}
