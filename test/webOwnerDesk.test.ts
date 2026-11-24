// The browser Desk's owner link and the machine probe (web owner access D2c) against a local relay
// whose host admits owner hellos as herdr's guest/owner.rs does and serves agent.list.
import { expect, test } from "bun:test";
import { isGuestPaused } from "../src/guestPaused";
import { generateIdentity, MemoryIdentityStore, staticKey, type IdentityStore } from "../src/webguest/identity";
import { toB64url } from "../src/webguest/b64url";
import type { EnvelopeMachine } from "../src/webguest/approve";
import type { StatementSource } from "../src/webguest/owner";
import { createGuestDesk, avatarDataURL, AvatarBytesError } from "../src/web/desk";
import { knownPhoto, loadPhoto, trackPhotoConnections } from "../src/avatars";
import { Desk } from "../src/mygo";
import { events } from "../src/web/events";
import { probeList, probeMachine, type MachineStatus } from "../src/web/ownerProbe";
import { MemoryGrantStore, MemoryOwnerHint } from "../src/web/storage";
import { currentOwnerLink } from "../src/web/ownerLink";
import { closingLink } from "../src/web/ownerSession";
import type { Avatar, BoardUpdate, ConnState } from "../src/mygo";
import { startRelay, type HostSession, type TestRelay } from "./webguestResponder";

const statements: StatementSource = { get: async () => ({ jws: "jws", expMs: Date.now() + 600_000 }), drop() {} };
const agents = [{ pane_id: "p1", terminal_id: "t1", name: "herdr-app", agent: "claude" }, { pane_id: "p2", terminal_id: "t2", name: "web-owner", agent: "codex" }, { pane_id: "p3", terminal_id: "t3", name: "relay", agent: "claude" }];

type Request = { id: string; method: string };
const answer = (session: HostSession, req: Request, body: object) => session.write(JSON.stringify({ id: req.id, ...body }) + "\n");
const streamStarted = (session: HostSession, req: Request) => answer(session, req, { result: { type: "stream_started" } });
/** A renewal changed the scope: herdr ends the stream with owner_scope_changed. */
const scopeChanged = (session: HostSession, req: Request) => {
 streamStarted(session, req);
 session.write(JSON.stringify({ error: { code: "owner_scope_changed", message: "the grant's scope changed" } }) + "\n");
};

/** A host that admits owner hellos under scope (or refuses with refuse), lists agents (or answers
 *  agent.list as list does), runs pane.stream as stream does, and refuses anything else with
 *  owner_forbidden. While ends returns a close code, the relay ends every connection with it, an
 *  open one at its next request: 4503 host_offline, 4429 rate_limited. */
function host(script: {
 hellos?: Record<string, unknown>[]; refuse?: string; scope?: () => string; agents?: () => unknown[];
 list?: (session: HostSession, req: Request) => void | Promise<void>; stream?: (session: HostSession, req: Request) => void;
 /** Any other method (default: refused with owner_forbidden). */
 other?: (session: HostSession, req: Request) => void;
 ends?: () => [code: number, reason: string] | null;
} = {}): TestRelay {
 return startRelay({
  async serve(conn, handshake) {
   const end = () => { const close = script.ends?.(); if (close) conn.close(...close); return close; };
   if (end()) return;
   const h = await handshake();
   script.hellos?.push(h.hello);
   if (script.refuse) { h.reply({ ok: false, error: script.refuse }); return; }
   const session = h.reply({ ok: true, mode: "owner", grant_id: "g1", scope: script.scope?.() ?? "chat", expires_unix: 1_800_000_000, account: { deadline_unix: Math.floor(Date.now() / 1000) + 660 }, features: { owner: 2, multi_request: true } });
   for (;;) {
    const line = await session.readLine();
    if (line === null || end()) return;
    const req = JSON.parse(line) as Request;
    if (req.method === "pane.stream") (script.stream ?? scopeChanged)(session, req);
    else if (req.method === "agent.list" && script.list) await script.list(session, req);
    else if (req.method === "agent.list") answer(session, req, { result: { type: "agent_list", agents: script.agents?.() ?? agents } });
    else if (script.other) script.other(session, req);
    else answer(session, req, { error: { code: "owner_forbidden", message: "no" } });
   }
  },
 });
}

const machineOn = (relay: TestRelay): EnvelopeMachine => ({ hostItemID: "H1", label: "dev2306", relay: relay.url, hostID: relay.hostID, nodePub: toB64url(relay.hostPublic), grantID: "g1", scope: "chat", expiresUnix: 1_800_000_000 });

async function deskWithKey(identities: IdentityStore = new MemoryIdentityStore(), now?: () => number) {
 await identities.add(await generateIdentity());
 return createGuestDesk({ identities, grants: new MemoryGrantStore(), owner: new MemoryOwnerHint(), webSocket: url => new WebSocket(url), ...(now ? { now } : {}) });
}
const boardOf = (relay: TestRelay) => {
 const got = Promise.withResolvers<BoardUpdate>();
 const off = events.boardChanged.on(b => { if (b?.machineID === `owner:${relay.hostID}`) { off(); got.resolve(b); } });
 return got.promise;
};
const stateWhere = (wanted: (s: ConnState) => boolean) => {
 const got = Promise.withResolvers<ConnState>();
 const off = events.stateChanged.on(s => { if (wanted(s)) { off(); got.resolve(s); } });
 return got.promise;
};
/** Opens the owner link to relay's machine, waits for its first board, and opens p1 as view-1. */
async function openP1(desk: Awaited<ReturnType<typeof deskWithKey>>, relay: TestRelay, session = new AbortController()) {
 const listed = boardOf(relay);
 await desk.connectOwner(machineOn(relay), statements, "x", session.signal);
 await listed;
 await desk.openAgentView({ machineID: `owner:${relay.hostID}`, session: "", paneID: "p1" }, "view-1");
}
/** A refused answer: its finally asks the owner link to list again now (link.guestPoll's kick). */
const listAgain = (desk: Awaited<ReturnType<typeof deskWithKey>>, token = "view-1") => desk.chatAnswer(token, "a", "1");

test("an owner link sends the owner hello and lists every agent on the machine, on its own board", async () => {
 const hellos: Record<string, unknown>[] = [];
 const relay = host({ hellos });
 const desk = await deskWithKey();
 const listed = boardOf(relay);
 try {
  await desk.connectOwner(machineOn(relay), statements, "Chrome on macOS", new AbortController().signal);
  const board = await listed;
  expect(board.board.sections.flatMap(s => s.rows.map(r => r.name)).sort()).toEqual(["herdr-app", "relay", "web-owner"]);
  expect(hellos[0]).toEqual({ v: 1, mode: "owner", account: "jws", device: "Chrome on macOS" });
  expect((await desk.state()).guest?.access.machineLabel).toBe("dev2306");
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("the machine probe counts the agents of a machine that admits this browser, and says when one no longer does", async () => {
 const key = staticKey(await generateIdentity());
 const online = host();
 const ended = host({ refuse: "owner_not_granted" });
 try {
  expect(await probeMachine(machineOn(online), key, statements, "x")).toEqual({ kind: "online", agents: 3 });
  expect((await probeMachine(machineOn(ended), key, statements, "x")).kind).toBe("ended");
 } finally { online.stop(); ended.stop(); }
});

test("a pane stream the host ends for a changed scope asks the page to open it again", async () => {
 const relay = host();
 const desk = await deskWithKey();
 const ended = Promise.withResolvers<{ error?: string; reconnect?: boolean }>();
 const offTerm = events.terminalChanged.on(e => { if (e.error) ended.resolve(e); });
 try {
  await openP1(desk, relay);
  await desk.startTerminal("view-1", "stream-1");
  const e = await ended.promise;
  expect(e.error).toContain("owner_scope_changed");
  expect(e.reconnect).toBe(true);
 } finally { offTerm(); desk.disconnectOwner(); relay.stop(); }
});

// ---- P2-1: owner links belong to the account session they were opened in ----

test("a link whose list failed once and came back is still the link a session's end closes (the owner page reopens it when restored)", async () => {
 let fail = false;
 const relay = host({ list: (session, req) => fail
  ? answer(session, req, { error: { code: "unavailable", message: "restarting" } })
  : answer(session, req, { result: { type: "agent_list", agents } }) });
 const desk = await deskWithKey();
 try {
  await openP1(desk, relay);
  const machine = currentOwnerLink()!.machine;
  expect([desk.ownerLinkUsable(machine.hostID), desk.ownerLinkUsable("other")]).toEqual([true, false]);
  fail = true;
  const failed = stateWhere(s => s.phase === "error");
  await listAgain(desk).catch(() => {});
  await failed;
  expect(closingLink(null, currentOwnerLink())).toBe(machine);
  // The link failed its last list: Open opens it again rather than going straight back.
  expect(desk.ownerLinkUsable(machine.hostID)).toBe(false);
  fail = false;
  const back = stateWhere(s => s.phase === "connected");
  await listAgain(desk).catch(() => {});
  await back;
  expect([closingLink(null, currentOwnerLink()), desk.ownerLinkUsable(machine.hostID)]).toEqual([machine, true]);
  // A link still being opened is the one the end closes, whatever was open before.
  const other = { ...machine, hostID: "other" };
  expect(closingLink(other, currentOwnerLink())).toBe(other);
  desk.disconnectOwner();
  expect(desk.ownerLinkUsable(machine.hostID)).toBe(false);
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("an owner link ends with its account session: no link, board or agent view is left", async () => {
 const relay = host();
 const desk = await deskWithKey();
 const session = new AbortController();
 try {
  await openP1(desk, relay, session);
  session.abort();
  expect((await desk.state()).phase).toBe("idle");
  expect(await desk.board()).toBeNull();
  await expect(desk.guestShareDetails("view-1")).rejects.toThrow("agent view changed");
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("an owner connect still reading the key never links once its session ends or the page leaves the machine", async () => {
 const leaves: Array<(session: AbortController, desk: Awaited<ReturnType<typeof deskWithKey>>) => void> = [session => session.abort(), (_, desk) => desk.disconnectOwner()];
 for (const leave of leaves) {
  const relay = host();
  // The key lookup waits until the test lets it go on.
  const inner = new MemoryIdentityStore();
  const lookup = Promise.withResolvers<void>();
  const identities: IdentityStore = { get: async () => { await lookup.promise; return inner.get(); }, add: record => inner.add(record) };
  const desk = await deskWithKey(identities);
  const session = new AbortController();
  const boards: BoardUpdate[] = [];
  const off = events.boardChanged.on(b => { if (b?.machineID === `owner:${relay.hostID}`) boards.push(b); });
  try {
   const connecting = desk.connectOwner(machineOn(relay), statements, "x", session.signal);
   leave(session, desk);
   lookup.resolve();
   await expect(connecting).rejects.toThrow();
   // A connect that went on would be "connecting" by now, its list on the way.
   expect((await desk.state()).phase).toBe("idle");
   expect(boards).toEqual([]);
  } finally { off(); desk.disconnectOwner(); relay.stop(); }
 }
});

// ---- P2-2: the admitted scope reaches the page ----

test("an owner link says the scope it was admitted under, and a stream opened after a renewal says the new one at once", async () => {
 let scope = "chat";
 const relay = host({ scope: () => scope, stream: streamStarted });
 const desk = await deskWithKey();
 try {
  await openP1(desk, relay);
  expect((await desk.state()).guest?.ownerScope).toBe("chat");
  scope = "terminal";
  await desk.startTerminal("view-1", "stream-1");
  expect((await desk.state()).guest?.ownerScope).toBe("terminal");
 } finally { desk.disconnectOwner(); relay.stop(); }
});

// ---- P2-3: owner_paused at both ends of a stream, and the list that ends it ----

test("an owner stream refused at its start with owner_paused pauses the open agent until a list has it running", async () => {
 const relay = host({ stream: (session, req) => answer(session, req, { error: { code: "owner_paused", message: "the agent this stream watches is no longer running" } }) });
 const desk = await deskWithKey();
 try {
  await openP1(desk, relay);
  expect((await desk.state()).guest?.availability).toBeUndefined();
  expect(isGuestPaused(String(await desk.startTerminal("view-1", "stream-1").catch(e => e)))).toBe(true);
  expect((await desk.state()).guest?.availability).toBe("paused");
  const running = stateWhere(s => s.phase === "connected" && s.guest?.availability === undefined);
  await listAgain(desk);
  await running;
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("an owner's stream refused before it opens (owner_forbidden: the agent isn't running) pauses until a list has it running, whatever scope the hello had; a remote agent's pane is an error", async () => {
 // Admitted under terminal scope: a renewal may have narrowed it to chat since, and herdr checks
 // pane.stream against the current scope.
 const relay = host({
  scope: () => "terminal",
  agents: () => [...agents, { pane_id: "p4", terminal_id: "t4", name: "far", agent: "claude", machine_id: "m2" }],
  stream: (session, req) => answer(session, req, { error: { code: "owner_forbidden", message: "not allowed for this owner" } }),
 });
 const desk = await deskWithKey();
 try {
  await openP1(desk, relay);
  expect(isGuestPaused(String(await desk.startTerminal("view-1", "stream-1").catch(e => e)))).toBe(true);
  expect((await desk.state()).guest?.availability).toBe("paused");
  const running = stateWhere(s => s.phase === "connected" && s.guest?.availability === undefined);
  await listAgain(desk);
  await running;
  await desk.openAgentView({ machineID: `owner:${relay.hostID}`, session: "", paneID: "p4" }, "view-4");
  const error = await desk.startTerminal("view-4", "stream-4").catch(e => e);
  expect(String(error)).toContain("owner_forbidden");
  expect(String(error)).not.toContain("owner_paused");
  expect((await desk.state()).guest?.availability).toBeUndefined();
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("an opening refusal is told by its code: another error that only mentions owner_forbidden stays that error", async () => {
 const relay = host({ stream: (session, req) => answer(session, req, { error: { code: "internal_error", message: "gate failed after owner_forbidden" } }) });
 const desk = await deskWithKey();
 try {
  await openP1(desk, relay);
  const error = await desk.startTerminal("view-1", "stream-1").catch(e => e);
  expect(String(error)).toContain("internal_error");
  expect(String(error)).not.toContain("owner_paused");
  expect((await desk.state()).guest?.availability).toBeUndefined();
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("an owner stream the host ends with owner_paused pauses the open agent", async () => {
 const relay = host({ stream: (session, req) => {
  streamStarted(session, req);
  session.write(JSON.stringify({ error: { code: "owner_paused", message: "the agent this stream watches is no longer running" } }) + "\n");
 } });
 const desk = await deskWithKey();
 const ended = Promise.withResolvers<string>();
 const offTerm = events.terminalChanged.on(e => { if (e.error) ended.resolve(e.error); });
 try {
  await openP1(desk, relay);
  await desk.startTerminal("view-1", "stream-1");
  // The page reads the host's own refusal as paused (isGuestPaused, by its code).
  expect(isGuestPaused(await ended.promise)).toBe(true);
  expect((await desk.state()).guest?.availability).toBe("paused");
 } finally { offTerm(); desk.disconnectOwner(); relay.stop(); }
});

test("an owner link's open agent is paused while the list has its pane archived or gone, runs when it is back, and another agent opened says its own", async () => {
 let listed: unknown[] = agents;
 const relay = host({ agents: () => listed });
 const desk = await deskWithKey();
 try {
  await openP1(desk, relay);
  const archived = stateWhere(s => s.guest?.availability === "paused");
  listed = [{ ...agents[0], archived: { at: "2026-11-20T10:00:00Z", by: "jerry" } }, ...agents.slice(1)];
  await listAgain(desk);
  await archived;
  const back = stateWhere(s => s.phase === "connected" && s.guest?.availability === undefined);
  listed = agents;
  await listAgain(desk);
  await back;
  const gone = stateWhere(s => s.guest?.availability === "paused");
  listed = agents.slice(1);
  await listAgain(desk);
  await gone;
  await desk.openAgentView({ machineID: `owner:${relay.hostID}`, session: "", paneID: "p2" }, "view-2");
  expect((await desk.state()).guest?.availability).toBeUndefined();
 } finally { desk.disconnectOwner(); relay.stop(); }
});

// ---- P2-4: the machine list counts every agent the machine lists ----

test("the machine probe counts every agent the machine lists, archived and unnamed ones too", async () => {
 const three = [
  { pane_id: "p1", terminal_id: "t1", name: "herdr-app", agent: "claude", agent_status: "working" },
  { pane_id: "p2", terminal_id: "t2", name: null, terminal_title_stripped: "release notes", agent: "codex", agent_status: "idle" },
  { pane_id: "p3", terminal_id: "t3", name: "old", agent: "claude", archived: { at: "2026-11-20T10:00:00Z", by: "jerry" } },
 ];
 const relay = host({ agents: () => three });
 try {
  expect(await probeMachine(machineOn(relay), staticKey(await generateIdentity()), statements, "x")).toEqual({ kind: "online", agents: 3 });
 } finally { relay.stop(); }
});

// ---- P3-1: a machine list's probes end with it ----

test("leaving the machine list, or its account session ending, cancels its probes and publishes nothing of them", async () => {
 const key = staticKey(await generateIdentity());
 for (const leave of ["list", "session"] as const) {
  const asked = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
  // The host holds the list's answer: only the browser can end the probe's connection.
  const relay = host({ list: async session => { asked.resolve(); await session.readLine(); closed.resolve(); } });
  const session = new AbortController();
  const published: MachineStatus[] = [];
  const stop = probeList(async () => ({ machines: [machineOn(relay)], key }), statements, "x", (_, status) => published.push(status), { signal: session.signal });
  try {
   await asked.promise;
   const stopped = leave === "list" ? stop() : (session.abort(), null);
   await closed.promise;
   await (stopped ?? stop());
   expect(published).toEqual([]);
  } finally { void stop(); relay.stop(); }
 }
});

// ---- P3-2: the probe reads the list as the Desk does ----

test("a machine that answers agent.list with something else is a problem for the probe, not an empty machine", async () => {
 const relay = host({ list: (session, req) => answer(session, req, { result: { type: "pong", version: "0.7.0", capabilities: {} } }) });
 try {
  const status = await probeMachine(machineOn(relay), staticKey(await generateIdentity()), statements, "x");
  expect(status.kind).toBe("problem");
 } finally { relay.stop(); }
});

// ---- P3-3: refusals of an owner's scope go the way a guest's do ----

test("a key the host took in one pane doesn't hide a refusal in another: the blocked pane still says the owner answers", async () => {
 const relay = host({
  agents: () => [agents[0], { ...agents[1], agent_status: "blocked" }, agents[2]],
  other: (session, req) => {
   const pane = (req as Request & { params?: { pane_id?: string } }).params?.pane_id;
   if (req.method === "pane.send_keys" && pane === "p1") answer(session, req, { result: { type: "ok" } });
   else answer(session, req, { error: { code: "owner_forbidden", message: "no" } });
  },
 });
 const desk = await deskWithKey();
 try {
  await openP1(desk, relay);
  expect(await desk.guestMenuKey("view-1", "Enter")).toEqual({});
  await desk.openAgentView({ machineID: `owner:${relay.hostID}`, session: "", paneID: "p2" }, "view-2");
  expect(await desk.guestMenuKey("view-2", "Enter")).toEqual({ ownerAnswers: true });
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("a menu key an owner's scope refuses while the open agent asks says the owner answers", async () => {
 const relay = host({ agents: () => [{ ...agents[0], agent_status: "blocked" }, ...agents.slice(1)] });
 const desk = await deskWithKey();
 try {
  await openP1(desk, relay);
  expect(await desk.guestMenuKey("view-1", "Enter")).toEqual({ ownerAnswers: true });
 } finally { desk.disconnectOwner(); relay.stop(); }
});

// A 1x1 PNG, as herdr sends a picture: its bytes in base64 and their sha256.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
async function sha256Hex(b64: string) {
 const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
 return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}

test("an avatar is the picture asked for, as an image: its sha256 must match and its bytes must be PNG or JPEG", async () => {
 const sha = await sha256Hex(PNG_B64);
 expect(await avatarDataURL(PNG_B64, sha)).toBe(`data:image/png;base64,${PNG_B64}`);
 await expect(avatarDataURL(PNG_B64, "0".repeat(64))).rejects.toThrow("sha256");
 const text = btoa("not a picture");
 await expect(avatarDataURL(text, await sha256Hex(text))).rejects.toThrow("not an image");
 // Half a PNG signature (89 50 4E 47, then not 0D 0A 1A 0A) is not a PNG.
 const halfPng = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 1, 2, 3));
 await expect(avatarDataURL(halfPng, await sha256Hex(halfPng))).rejects.toThrow("not an image");
 // Each is the reply's fault (AvatarBytesError), malformed base64 too.
 for (const [b64, want] of [[PNG_B64, "0".repeat(64)], [text, await sha256Hex(text)], ["%%", sha]]) {
  await expect(avatarDataURL(b64!, want!)).rejects.toBeInstanceOf(AvatarBytesError);
 }
});

// #388 review: only atob's refusal of malformed base64 is the reply's fault. The page failing to
// decode or build the bytes itself is thrown as it is, and asked again.
test("a local failure decoding an avatar is not taken as bytes that are not the photo", async () => {
 const sha = await sha256Hex(PNG_B64);
 const atob0 = globalThis.atob, from0 = Uint8Array.from;
 try {
  globalThis.atob = () => { throw new RangeError("out of memory"); };
  await expect(avatarDataURL(PNG_B64, sha)).rejects.toBeInstanceOf(RangeError);
  globalThis.atob = atob0;
  Uint8Array.from = (() => { throw new RangeError("out of memory"); }) as typeof Uint8Array.from;
  await expect(avatarDataURL(PNG_B64, sha)).rejects.toBeInstanceOf(RangeError);
 } finally { globalThis.atob = atob0; Uint8Array.from = from0; }
 expect(await avatarDataURL(PNG_B64, sha)).toBe(`data:image/png;base64,${PNG_B64}`);
});

test("an owner link shows the agents' pictures and copies recent text with a source herdr's gate takes", async () => {
 const sha = await sha256Hex(PNG_B64);
 const sources: string[] = [];
 const relay = host({ other: (session, req) => {
  const params = (req as Request & { params?: { sha256?: string; source?: string; target?: string } }).params ?? {};
  // The host says it serves pictures; the picture goes only for the agent and sha256 asked for.
  if (req.method === "ping") answer(session, req, { result: { type: "pong", version: "0.9.5", capabilities: { agent_avatar: true } } });
  else if (req.method === "agent.avatar.get" && params.target === "p1" && params.sha256 === sha) answer(session, req, { result: { type: "agent_avatar_image", data_base64: PNG_B64 } });
  else if (req.method === "agent.read") {
   sources.push(params.source ?? "");
   // owner_gate.rs: recent and visible only.
   if (params.source === "recent" || params.source === "visible") answer(session, req, { result: { type: "pane_read", read: { text: "last lines" } } });
   else answer(session, req, { error: { code: "owner_forbidden", message: "no" } });
  } else answer(session, req, { error: { code: "owner_forbidden", message: "no" } });
 } });
 const desk = await deskWithKey();
 try {
  await openP1(desk, relay);
  expect(await desk.avatarImage("p1", sha)).toEqual({ url: `data:image/png;base64,${PNG_B64}` });
  expect(await desk.readAgentText("view-1", true)).toBe("last lines");
  expect(sources).toEqual(["recent"]);
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("a host that doesn't say it serves pictures isn't asked for one: its answer is that there is none", async () => {
 let asked = 0;
 const relay = host({ other: (session, req) => {
  if (req.method === "ping") answer(session, req, { result: { type: "pong", version: "0.9.0", capabilities: {} } });
  else { if (req.method === "agent.avatar.get") asked++; answer(session, req, { error: { code: "owner_forbidden", message: "no" } }); }
 } });
 const desk = await deskWithKey();
 try {
  await openP1(desk, relay);
  expect(await desk.avatarImage("p1", await sha256Hex(PNG_B64))).toEqual({ unavailable: true });
  expect(asked).toBe(0);
 } finally { desk.disconnectOwner(); relay.stop(); }
});

// #369 review, on the web: the desk decides at agent.avatar.get, by type, and says it as its
// result. herdr's answers (an error reply, a result of another type, a data_base64 that is not
// the photo's bytes, a number among them) are { unavailable }; a socket closed under the ask is
// an error.
test("the web desk answers herdr's refusals as unavailable and throws for a failure on the way", async () => {
 const sha = await sha256Hex(PNG_B64);
 const relay = host({ other: (session, req) => {
  const target = (req as Request & { params?: { target?: string } }).params?.target;
  if (req.method === "ping") answer(session, req, { result: { type: "pong", version: "0.9.5", capabilities: { agent_avatar: true } } });
  else if (req.method !== "agent.avatar.get") answer(session, req, { error: { code: "owner_forbidden", message: "no" } });
  else if (target === "refused") answer(session, req, { error: { code: "not_found", message: "avatar not found" } });
  else if (target === "wrong-type") answer(session, req, { result: { type: "pong", version: "0.9.5" } });
  else if (target === "numeric") answer(session, req, { result: { type: "agent_avatar_image", data_base64: 12345 } });
  else if (target === "not-the-photo") answer(session, req, { result: { type: "agent_avatar_image", data_base64: btoa("not a picture") } });
  else if (target === "photo") answer(session, req, { result: { type: "agent_avatar_image", data_base64: PNG_B64 } });
  else session.conn.close(4503, "host_offline");
 } });
 const desk = await deskWithKey();
 try {
  await openP1(desk, relay);
  for (const target of ["refused", "wrong-type", "numeric", "not-the-photo"]) expect([target, await desk.avatarImage(target, sha)]).toEqual([target, { unavailable: true }]);
  await expect(desk.avatarImage("closed", sha)).rejects.toThrow();
  // #381 review: the page's own Web Crypto failing once while it checks the photo is no answer of
  // herdr's: thrown, and the next ask loads it.
  const png = Uint8Array.from(atob(PNG_B64), c => c.charCodeAt(0));
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let failOnce = true;
  crypto.subtle.digest = ((algorithm: AlgorithmIdentifier, data: BufferSource) => {
   const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
   if (failOnce && bytes.length === png.length && bytes.every((b, i) => b === png[i])) {
    failOnce = false;
    return Promise.reject(new DOMException("The operation failed for an operation-specific reason", "OperationError"));
   }
   return digest(algorithm, data);
  }) as typeof crypto.subtle.digest;
  try {
   await expect(desk.avatarImage("photo", sha)).rejects.toThrow("operation-specific");
   expect(await desk.avatarImage("photo", sha)).toEqual({ url: `data:image/png;base64,${PNG_B64}` });
  } finally { crypto.subtle.digest = digest; }
 } finally { desk.disconnectOwner(); relay.stop(); }
}, 20_000);

// More pictures, so failed and loaded ones can be told apart.
const PNG_B64_B = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQSDjwHwAEJAJA6qdhxgAAAABJRU5ErkJggg==";
const PNG_B64_C = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGM44KDwHwAFBAIgRs3qLwAAAABJRU5ErkJggg==";

// #335 review: a list can move a picture to another pane, and herdr answers not_found for the old
// one. After an outage or the relay's backoff the page may still draw the board from before (an
// obsolete render) while the new list's board asks for the picture where it is now: the old
// agent's ask, in flight or failed, must not stand for the new one's. A picture that failed where
// it still is gets asked again once the link is back up; one that loaded is never fetched again.
test("an owner link back up asks for a moved picture where the new list has it, whatever the board before asks; failures are asked again, loaded pictures shared", async () => {
 const pictures: Record<string, string> = { A: PNG_B64, B: PNG_B64_B, C: PNG_B64_C };
 const sha: Record<string, string> = {};
 for (const [name, b64] of Object.entries(pictures)) sha[name] = await sha256Hex(b64);
 /** Agent n (pane pn, terminal tn, which the page asks for its picture by) with picture name. */
 const agent = (n: number, picture?: string) => ({ pane_id: `p${n}`, terminal_id: `t${n}`, name: `agent-${n}`, agent: "claude", ...(picture ? { avatar: { style: "image", sha256: sha[picture] } } : {}) });
 // The host has each picture for its agent only, as "terminal picture": herdr answers not_found
 // for any other pair.
 let listed = [agent(1, "B"), agent(2, "A"), agent(3), agent(4, "C")], has = new Set(["t2 A"]);
 let ends: [number, string] | null = null, clock = Date.now();
 const fetched: Record<string, number> = {};
 const relay = host({
  agents: () => listed,
  ends: () => ends,
  other: (session, req) => {
   const params = (req as Request & { params?: { target?: string; sha256?: string } }).params ?? {};
   if (req.method === "ping") answer(session, req, { result: { type: "pong", version: "0.9.5", capabilities: { agent_avatar: true } } });
   else if (req.method !== "agent.avatar.get") answer(session, req, { error: { code: "owner_forbidden", message: "no" } });
   else {
    const picture = Object.keys(sha).find(name => sha[name] === params.sha256) ?? "?", asked = `${params.target} ${picture}`;
    fetched[asked] = (fetched[asked] ?? 0) + 1;
    if (has.has(asked)) answer(session, req, { result: { type: "agent_avatar_image", data_base64: pictures[picture] } });
    else answer(session, req, { error: { code: "not_found", message: "avatar not found" } });
   }
  },
 });
 const desk = await deskWithKey(undefined, () => clock);
 const avatarImage = Desk.avatarImage;
 Desk.avatarImage = (target, sha256) => desk.avatarImage(target, sha256);
 /** A render's ask for agent n's picture, as avatarFace makes it: what is known, else a fetch. */
 const ask = (n: number, picture: string) => {
  const a: Avatar = { kind: "image", target: `t${n}`, sha256: sha[picture] };
  const known = knownPhoto(a);
  return known === undefined ? loadPhoto(a) : Promise.resolve(known);
 };
 const untrack = trackPhotoConnections(events);
 /** The relay ends the open session and every new one with close, until a list hears it. */
 const relayEnds = async (close: [number, string], heard: (s: ConnState) => boolean) => {
  const state = stateWhere(heard);
  ends = close;
  await listAgain(desk).catch(() => {});
  return state;
 };
 /** The backoff ends and the relay lets connects through: a fresh session lists now. */
 const recover = async () => {
  const back = boardOf(relay);
  ends = null;
  clock += 15_000;
  await listAgain(desk).catch(() => {});
  await back;
 };
 const url = (picture: string) => `data:image/png;base64,${pictures[picture]}`;
 try {
  await openP1(desk, relay);
  expect(await Promise.all([ask(1, "B"), ask(2, "A"), ask(4, "C")])).toEqual([null, url("A"), null]);
  expect(fetched).toEqual({ "t1 B": 1, "t2 A": 1, "t4 C": 1 });

  // The machine goes offline, then the relay holds this network's connects back: having listed,
  // the link stays "connected" while it waits, and the failures stand.
  await relayEnds([4503, "host_offline"], s => s.phase === "error");
  expect((await relayEnds([4429, "rate_limited"], s => s.guest?.availability === "reconnecting")).phase).toBe("connected");
  expect(await Promise.all([ask(1, "B"), ask(4, "C")])).toEqual([null, null]);

  // Back, B is on agent 3. The board from before asks t1 and t4 first; the new board asks t3 for B
  // while t1's ask is still out, and gets it. C, still where the host has none, fails again.
  listed = [agent(1), agent(2, "A"), agent(3, "B"), agent(4, "C")];
  has = new Set(["t2 A", "t3 B"]);
  await recover();
  const [, stale, moved, loaded] = await Promise.all([ask(1, "B"), ask(4, "C"), ask(3, "B"), ask(2, "A")]);
  expect([stale, moved, loaded]).toEqual([null, url("B"), url("A")]);
  expect(fetched).toEqual({ "t1 B": 2, "t2 A": 1, "t4 C": 2, "t3 B": 1 });

  // The relay's backoff alone, from a link that was up, is as much an interruption. Back, C is on
  // agent 1 as well as 4, and agent 5 shows A. The board from before asks t4 first and fails; the
  // new one asks t1 for C all the same. A, loaded already, is not fetched for agent 5.
  expect((await relayEnds([4429, "rate_limited"], s => s.guest?.availability === "reconnecting")).phase).toBe("connected");
  listed = [agent(1, "C"), agent(2, "A"), agent(3, "B"), agent(4, "C"), agent(5, "A")];
  has = new Set(["t2 A", "t3 B", "t1 C", "t5 A"]);
  await recover();
  expect(await ask(4, "C")).toBeNull();
  expect(await ask(1, "C")).toBe(url("C"));
  // The next render: agent 4's C is the one agent 1's ask loaded.
  expect(await Promise.all([ask(4, "C"), ask(5, "A"), ask(3, "B")])).toEqual([url("C"), url("A"), url("B")]);
  expect(fetched).toEqual({ "t1 B": 2, "t2 A": 1, "t4 C": 3, "t3 B": 1, "t1 C": 1 });
 } finally {
  untrack();
  Desk.avatarImage = avatarImage;
  desk.disconnectOwner(); relay.stop();
 }
}, 20_000);

// One more picture, asked for nowhere else in this file.
const PNG_B64_D = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQWBDwHwADxAIAsKf0fQAAAABJRU5ErkJggg==";

// #335 review: the relay closing the socket under an ask (4503 host_offline) says nothing of the
// picture. The next render asks again, with no state between to mark the link down and up.
test("an ask whose socket the relay closed is asked again on the next render, the link up throughout", async () => {
 const sha = await sha256Hex(PNG_B64_D);
 let asks = 0;
 const relay = host({
  agents: () => [{ ...agents[0], avatar: { style: "image", sha256: sha } }],
  other: (session, req) => {
   if (req.method === "ping") answer(session, req, { result: { type: "pong", version: "0.9.5", capabilities: { agent_avatar: true } } });
   else if (req.method !== "agent.avatar.get") answer(session, req, { error: { code: "owner_forbidden", message: "no" } });
   else if (++asks === 1) session.conn.close(4503, "host_offline");
   else answer(session, req, { result: { type: "agent_avatar_image", data_base64: PNG_B64_D } });
  },
 });
 const desk = await deskWithKey();
 const avatarImage = Desk.avatarImage;
 Desk.avatarImage = (target, sha256) => desk.avatarImage(target, sha256);
 const a: Avatar = { kind: "image", target: "t1", sha256: sha };
 const states: string[] = [];
 try {
  await openP1(desk, relay);
  const off = events.stateChanged.on(s => { states.push(s.phase); });
  try {
   expect(await loadPhoto(a)).toBeNull();
   expect(knownPhoto(a)).toBeUndefined();
   expect(await loadPhoto(a)).toBe(`data:image/png;base64,${PNG_B64_D}`);
  } finally { off(); }
  expect({ asks, states }).toEqual({ asks: 2, states: [] });
 } finally {
  Desk.avatarImage = avatarImage;
  desk.disconnectOwner(); relay.stop();
 }
}, 20_000);
