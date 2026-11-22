// The browser Desk's owner link and the machine probe (web owner access D2c) against a local relay
// whose host admits owner hellos as herdr's guest/owner.rs does and serves agent.list.
import { expect, test } from "bun:test";
import { generateIdentity, MemoryIdentityStore, staticKey } from "../src/webguest/identity";
import { toB64url } from "../src/webguest/b64url";
import type { EnvelopeMachine } from "../src/webguest/approve";
import type { StatementSource } from "../src/webguest/owner";
import { createGuestDesk } from "../src/web/desk";
import { events } from "../src/web/events";
import { probeMachine } from "../src/web/ownerProbe";
import { MemoryGrantStore, MemoryOwnerHint } from "../src/web/storage";
import type { BoardUpdate } from "../src/mygo";
import { startRelay, type TestRelay } from "./webguestResponder";

const statements: StatementSource = { get: async () => ({ jws: "jws", expMs: Date.now() + 600_000 }), drop() {} };
const agents = [{ pane_id: "p1", terminal_id: "t1", name: "herdr-app", agent: "claude" }, { pane_id: "p2", terminal_id: "t2", name: "web-owner", agent: "codex" }, { pane_id: "p3", terminal_id: "t3", name: "relay", agent: "claude" }];

/** A host that admits owner hellos (or refuses with refuse) and lists agents. */
function host(hellos: Record<string, unknown>[], refuse = ""): TestRelay {
 return startRelay({
  async serve(_conn, handshake) {
   const h = await handshake();
   hellos.push(h.hello);
   if (refuse) { h.reply({ ok: false, error: refuse }); return; }
   const session = h.reply({ ok: true, mode: "owner", grant_id: "g1", scope: "chat", expires_unix: 1_800_000_000, account: { deadline_unix: Math.floor(Date.now() / 1000) + 660 }, features: { owner: 2, multi_request: true } });
   for (;;) {
    const line = await session.readLine();
    if (line === null) return;
    const req = JSON.parse(line) as { id: string; method: string };
    if (req.method === "pane.stream") {
     // A renewal changed the scope: herdr ends the stream with owner_scope_changed.
     session.write(JSON.stringify({ id: req.id, result: { type: "stream_started" } }) + "\n");
     session.write(JSON.stringify({ error: { code: "owner_scope_changed", message: "the grant's scope changed" } }) + "\n");
     continue;
    }
    session.write(JSON.stringify(req.method === "agent.list" ? { id: req.id, result: { type: "agent_list", agents } } : { id: req.id, error: { code: "owner_forbidden", message: "no" } }) + "\n");
   }
  },
 });
}

const machineOn = (relay: TestRelay): EnvelopeMachine => ({ hostItemID: "H1", label: "dev2306", relay: relay.url, hostID: relay.hostID, nodePub: toB64url(relay.hostPublic), grantID: "g1", scope: "chat", expiresUnix: 1_800_000_000 });

test("an owner link sends the owner hello and lists every agent on the machine, on its own board", async () => {
 const hellos: Record<string, unknown>[] = [];
 const relay = host(hellos);
 const identities = new MemoryIdentityStore();
 await identities.add(await generateIdentity());
 const desk = createGuestDesk({ identities, grants: new MemoryGrantStore(), owner: new MemoryOwnerHint(), webSocket: url => new WebSocket(url) });
 const listed = Promise.withResolvers<BoardUpdate>();
 const off = events.boardChanged.on(b => { if (b?.machineID === `owner:${relay.hostID}`) listed.resolve(b); });
 try {
  await desk.connectOwner(machineOn(relay), statements, "Chrome on macOS");
  const board = await listed.promise;
  expect(board.board.sections.flatMap(s => s.rows.map(r => r.name)).sort()).toEqual(["herdr-app", "relay", "web-owner"]);
  expect(hellos[0]).toEqual({ v: 1, mode: "owner", account: "jws", device: "Chrome on macOS" });
  expect((await desk.state()).guest?.access.machineLabel).toBe("dev2306");
 } finally { off(); desk.disconnectOwner(); relay.stop(); }
});

test("the machine probe counts the agents of a machine that admits this browser, and says when one no longer does", async () => {
 const key = staticKey(await generateIdentity());
 const online = host([]);
 const ended = host([], "owner_not_granted");
 try {
  expect(await probeMachine(machineOn(online), key, statements, "x")).toEqual({ kind: "online", agents: 3 });
  expect((await probeMachine(machineOn(ended), key, statements, "x")).kind).toBe("ended");
 } finally { online.stop(); ended.stop(); }
});

test("a pane stream the host ends for a changed scope asks the page to open it again", async () => {
 const relay = host([]);
 const identities = new MemoryIdentityStore();
 await identities.add(await generateIdentity());
 const desk = createGuestDesk({ identities, grants: new MemoryGrantStore(), owner: new MemoryOwnerHint(), webSocket: url => new WebSocket(url) });
 const listed = Promise.withResolvers<BoardUpdate>();
 const ended = Promise.withResolvers<{ error?: string; reconnect?: boolean }>();
 const offBoard = events.boardChanged.on(b => { if (b?.machineID === `owner:${relay.hostID}`) listed.resolve(b); });
 const offTerm = events.terminalChanged.on(e => { if (e.error) ended.resolve(e); });
 try {
  await desk.connectOwner(machineOn(relay), statements, "x");
  await listed.promise;
  await desk.openAgentView({ machineID: `owner:${relay.hostID}`, session: "", paneID: "p1" }, "view-1");
  await desk.startTerminal("view-1", "stream-1");
  const e = await ended.promise;
  expect(e.error).toContain("owner_scope_changed");
  expect(e.reconnect).toBe(true);
 } finally { offBoard(); offTerm(); desk.disconnectOwner(); relay.stop(); }
});
