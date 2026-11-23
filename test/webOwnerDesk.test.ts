// The browser Desk's owner link and the machine probe (web owner access D2c) against a local relay
// whose host admits owner hellos as herdr's guest/owner.rs does and serves agent.list.
import { expect, test } from "bun:test";
import { isGuestPaused } from "../src/guestPaused";
import { generateIdentity, MemoryIdentityStore, staticKey, type IdentityStore } from "../src/webguest/identity";
import { toB64url } from "../src/webguest/b64url";
import type { EnvelopeMachine } from "../src/webguest/approve";
import type { StatementSource } from "../src/webguest/owner";
import { createGuestDesk } from "../src/web/desk";
import { buildBoard } from "../src/web/board";
import { events } from "../src/web/events";
import { probeList, probeMachine, type MachineStatus } from "../src/web/ownerProbe";
import { MemoryGrantStore, MemoryOwnerHint } from "../src/web/storage";
import { ownerHomeRows } from "../src/guestHome";
import type { BoardUpdate, ConnState } from "../src/mygo";
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
 *  owner_forbidden. */
function host(script: {
 hellos?: Record<string, unknown>[]; refuse?: string; scope?: () => string; agents?: () => unknown[];
 list?: (session: HostSession, req: Request) => void | Promise<void>; stream?: (session: HostSession, req: Request) => void;
 /** Any other method (default: refused with owner_forbidden). */
 other?: (session: HostSession, req: Request) => void;
} = {}): TestRelay {
 return startRelay({
  async serve(_conn, handshake) {
   const h = await handshake();
   script.hellos?.push(h.hello);
   if (script.refuse) { h.reply({ ok: false, error: script.refuse }); return; }
   const session = h.reply({ ok: true, mode: "owner", grant_id: "g1", scope: script.scope?.() ?? "chat", expires_unix: 1_800_000_000, account: { deadline_unix: Math.floor(Date.now() / 1000) + 660 }, features: { owner: 2, multi_request: true } });
   for (;;) {
    const line = await session.readLine();
    if (line === null) return;
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

async function deskWithKey(identities: IdentityStore = new MemoryIdentityStore()) {
 await identities.add(await generateIdentity());
 return createGuestDesk({ identities, grants: new MemoryGrantStore(), owner: new MemoryOwnerHint(), webSocket: url => new WebSocket(url) });
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

// ---- P2-4: the owner home and the machine list count the same agents ----

test("the owner home lists every agent the machine probe counts: archived with its note, unnamed by its terminal title", async () => {
 const three = [
  { pane_id: "p1", terminal_id: "t1", name: "herdr-app", agent: "claude", agent_status: "working" },
  { pane_id: "p2", terminal_id: "t2", name: null, terminal_title_stripped: "release notes", agent: "codex", agent_status: "idle" },
  { pane_id: "p3", terminal_id: "t3", name: "old", agent: "claude", archived: { at: "2026-11-20T10:00:00Z", by: "jerry" } },
 ];
 const relay = host({ agents: () => three });
 try {
  const rows = ownerHomeRows(buildBoard(three));
  expect(rows.map(r => [r.name, r.state])).toEqual([["herdr-app", "working"], ["release notes", "idle"], ["old", "archived by jerry"]]);
  expect(await probeMachine(machineOn(relay), staticKey(await generateIdentity()), statements, "x")).toEqual({ kind: "online", agents: rows.length });
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
