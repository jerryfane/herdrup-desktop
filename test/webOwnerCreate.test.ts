// The browser's New agent, New terminal and saved terminals (src/web/createDesk.ts,
// src/web/terminalsDesk.ts, desk.ts openTerminalView) on an owner link, against a local relay whose
// host admits owner hellos and answers herdr's creation methods as the test scripts them.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { generateIdentity, MemoryIdentityStore } from "../src/webguest/identity";
import { toB64url } from "../src/webguest/b64url";
import { HerdrAPIError, NotSentError, notSent, relayRefused } from "../src/webguest/errors";
import type { EnvelopeMachine } from "../src/webguest/approve";
import type { StatementSource } from "../src/webguest/owner";
import { createGuestDesk, promptReceipt, terminalWriteReceipt } from "../src/web/desk";
import { events } from "../src/web/events";
import { MemoryGrantStore, MemoryOwnerHint } from "../src/web/storage";
import { currentOwnerLink, linkClosing, onBoard, OWNER_REFUSED, OwnerRefusedError, type OwnerLink } from "../src/web/ownerLink";
import { createDesk, shellInitializing, ShellStartingError, startAgentWhenShellReady, type Clock, type PaneProcessInfo, type ShellReadyOps } from "../src/web/createDesk";
import { renameField } from "../src/agentActionsModel";
import { StartedAgents } from "../src/web/startedAgents";
import { nextTerminalLabel, persistAndKeep, SAVED_TERMINALS_KEY, terminalsDesk } from "../src/web/terminalsDesk";
import { ErrUnsupported, GuestClient, ResultTagError } from "../src/web/engine";
import { setLink, type WebLink } from "../src/web/link";
import type { AgentInfo } from "../src/web/board";
import type { BoardUpdate, SavedTerminal } from "../src/mygo";
import { startRelay, type HostConn, type HostSession, type TestRelay } from "./webguestResponder";
import { GuestTransport } from "../src/webguest/transport";

// Each test drives a real relay over WebSockets through several round trips (connect, list,
// split, start, stream, close); on a loaded machine one can outlast bun's 5 s default though it
// waits on events only, and a timed-out test leaves its link to the next.
setDefaultTimeout(15_000);

const statements: StatementSource = { get: async () => ({ jws: "jws", expMs: Date.now() + 600_000 }), drop() {} };
type Request = { id: string; method: string; params: Record<string, unknown> };
type Answer = { result: unknown } | { error: { code: string; message: string } };
const ok = (result: object): Answer => ({ result });
const fail = (code: string): Answer => ({ error: { code, message: code.replaceAll("_", " ") } });

/** A host admitting owner hellos under scope: agent.list answers agents(), anything else as
 *  answers says (default: owner_forbidden), at once or once its promise settles. Every request
 *  lands in calls; nextList() settles with the next agent.list asked. The relay refuses a connect
 *  admit answers with a Response. Before endAfter's reply every other connection ends (the browser
 *  has heard it), and the reply spends its own (bytes after the line): the next call connects anew.
 *  A connect whose hello hold() takes is never answered. */
function host(script: {
 scope?: string | (() => string); agents?: () => unknown[]; answers?: (req: Request) => Answer | Promise<Answer> | undefined;
 admit?: () => Response | undefined; endAfter?: string; hold?: () => boolean;
}) {
 const calls: Request[] = [];
 const conns = new Set<HostConn>();
 let listing: (() => void) | null = null, ending: (() => void) | null = null;
 const relay = startRelay({
  ...(script.admit ? { admit: script.admit } : {}),
  async serve(conn, handshake) {
   const scope = typeof script.scope === "function" ? script.scope() : script.scope ?? "terminal";
   const hello = await handshake();
   if (script.hold?.()) return;
   conns.add(conn);
   const session: HostSession = hello.reply({ ok: true, mode: "owner", grant_id: "g1", scope, expires_unix: 1_800_000_000, account: { deadline_unix: Math.floor(Date.now() / 1000) + 660 }, features: { owner: 2, multi_request: true } });
   for (;;) {
    const line = await session.readLine();
    if (line === null) { conns.delete(conn); ending?.(); ending = null; return; }
    const req = JSON.parse(line) as Request;
    calls.push(req);
    if (req.method === "agent.list") { listing?.(); listing = null; }
    const reply = req.method === "agent.list" ? ok({ type: "agent_list", agents: script.agents?.() ?? [{ pane_id: "p1", name: "herdr-app", agent: "claude" }] })
     : req.method === "ping" ? ok({ type: "pong", version: "0.9.0", capabilities: {} })
     : script.answers?.(req) ?? fail("owner_forbidden");
    void Promise.resolve(reply).then(async r => {
     let tail = "";
     if (req.method === script.endAfter) {
      const others = [...conns].filter(c => c !== conn);
      for (const c of others) c.close();
      await Promise.all(others.map(c => c.closed));
      tail = "spent";
     }
     session.write(JSON.stringify({ id: req.id, ...r }) + "\n" + tail);
    });
   }
  },
 });
 const next = (set: (f: () => void) => void) => { const p = Promise.withResolvers<void>(); set(p.resolve); return p.promise; };
 return { relay, calls, called: (method: string) => calls.filter(c => c.method === method), nextList: () => next(f => { listing = f; }),
  /** Settles when the browser's session with this host ends (its connection closed). */
  sessionEnded: () => next(f => { ending = f; }) };
}

const machineOn = (relay: TestRelay): EnvelopeMachine => ({ hostItemID: "H1", label: "dev2306", relay: relay.url, hostID: relay.hostID, nodePub: toB64url(relay.hostPublic), grantID: "g1", scope: "terminal", expiresUnix: 1_800_000_000 });

/** The owner link to relay's machine, after its first board. */
async function connected(relay: TestRelay, now?: () => number) {
 const identities = new MemoryIdentityStore();
 await identities.add(await generateIdentity());
 const desk = createGuestDesk({ identities, grants: new MemoryGrantStore(), owner: new MemoryOwnerHint(), webSocket: url => new WebSocket(url), ...(now ? { now } : {}) });
 const listed = Promise.withResolvers<BoardUpdate>();
 const off = events.boardChanged.on(b => { if (b?.machineID === `owner:${relay.hostID}`) { off(); listed.resolve(b); } });
 await desk.connectOwner(machineOn(relay), statements, "x", new AbortController().signal);
 await listed.promise;
 return desk;
}

// localStorage for the saved terminals (Bun has none): a Map, removed after each test.
let kept: Map<string, string>;
beforeEach(() => {
 kept = new Map();
 Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } } });
});
afterEach(() => { Reflect.deleteProperty(globalThis, "localStorage"); });
const savedOn = (hostID: string) => (JSON.parse(kept.get(SAVED_TERMINALS_KEY) ?? "{}") as Record<string, SavedTerminal[]>)[hostID] ?? [];

const split = (pane: string) => ok({ type: "pane_info", pane: { pane_id: pane } });
const started = (pane: string, name: string) => ok({ type: "agent_started", agent: { pane_id: pane, name, agent: "omp" }, argv: [] });

// ---- Decisions ----

test("an agent's name from its folder is the name Rename would save: İstanbul starts as i-stanbul", async () => {
 const h = host({ answers: req => req.method === "pane.split" ? split("p8") : req.method === "agent.start" ? started("p8", "i-stanbul") : undefined });
 const desk = await connected(h.relay);
 try {
  await createDesk.openCreation(`owner:${h.relay.hostID}`, "", "c1");
  expect((await createDesk.createAgent("c1", "/home/jerry/İstanbul", "omp")).phase).toBe("started");
  expect(h.called("agent.start")[0]!.params.name).toBe(renameField("İstanbul").effective);
  expect(renameField("İstanbul").effective).toBe("i-stanbul");
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a pane's shell is initializing only while that shell leads the foreground", () => {
 const leading = (name: string) => shellInitializing({ shell_pid: 7, foreground_process_group_id: 7, foreground_processes: [{ pid: 7, name }] });
 expect([leading("/usr/bin/-zsh.exe.exe"), leading("C:\\Windows\\PWSH"), leading("bäsh"), leading("python")]).toEqual([true, true, false, false]);
 expect(shellInitializing({ shell_pid: 7, foreground_process_group_id: 7, foreground_processes: [{ pid: 7, name: "node", argv: ["/bin/bash"] }] })).toBe(true);
 expect(shellInitializing({ shell_pid: 7, foreground_process_group_id: 9, foreground_processes: [{ pid: 7, name: "bash" }] })).toBe(false);
 expect(shellInitializing({ shell_pid: 7, foreground_process_group_id: 7, foreground_processes: [{ pid: 8, name: "bash" }] })).toBe(false);
 expect(shellInitializing(undefined)).toBe(false);
});

test("a new terminal takes the lowest Terminal number no saved label uses", () => {
 const t = (label: string): SavedTerminal => ({ id: label, paneID: label, label, createdUnixMs: 0 });
 expect(nextTerminalLabel([])).toBe("Terminal 1");
 expect(nextTerminalLabel([t("Terminal 1"), t("Terminal 3"), t("Terminal 0"), t("Terminal x")])).toBe("Terminal 2");
 expect(nextTerminalLabel([t("Terminal 1"), t("Terminal +2")])).toBe("Terminal 3");
});

// ---- agent.start's shell-rc retry ----

/** A clock whose sleeps pass at once, and whose timeouts abort once its sleeps pass them;
 *  elapsed() is the time its sleeps passed. */
const fakeClock = (): Clock & { slept: number[]; elapsed(): number } => {
 let at = 0;
 const slept: number[] = [], timers: { at: number; deadline: AbortController }[] = [];
 return {
  slept, elapsed: () => at,
  timeout: ms => { const deadline = new AbortController(); timers.push({ at: at + ms, deadline }); return deadline.signal; },
  sleep: async (ms, signal) => {
   slept.push(ms); at += ms;
   for (const t of timers) if (t.at <= at) t.deadline.abort(new Error("deadline"));
   if (signal.aborted) throw signal.reason;
  },
 };
};
const busy = new HerdrAPIError("agent_pane_busy", "foreground is busy", null);
/** A fake herdr's answers to a pane's start and probe, by method. */
type CreationCall = <T>(method: string, params: unknown, tag: string, signal?: AbortSignal) => Promise<T>;
/** A pane's readiness operations over call, as createAgent binds them. */
const opsOver = (call: CreationCall): ShellReadyOps => ({
 start: async () => (await call<{ agent: AgentInfo }>("agent.start", {}, "agent_started")).agent,
 probe: async (signal) => (await call<{ process_info?: PaneProcessInfo }>("pane.process_info", {}, "pane_process_info", signal)).process_info,
});
const shellInfo = { type: "pane_process_info", process_info: { shell_pid: 5, foreground_process_group_id: 5, foreground_processes: [{ pid: 5, name: "zsh" }] } };

test("a start refused as busy is retried while the pane's shell still runs its rc files, then starts", async () => {
 let starts = 0;
 const call: CreationCall = async <T,>(method: string) => {
  if (method === "pane.process_info") return shellInfo as T;
  if (++starts < 3) throw busy;
  return { agent: { pane_id: "p9" } } as T;
 };
 const clock = fakeClock();
 expect((await startAgentWhenShellReady(opsOver(call), new AbortController().signal, clock)).pane_id).toBe("p9");
 expect(starts).toBe(3);
 expect(clock.slept).toEqual([100, 100]);
});

test("a busy start is not retried once another program leads the pane, nor past 2 s", async () => {
 let starts = 0;
 const program = async <T,>(method: string): Promise<T> => {
  if (method === "pane.process_info") return { process_info: { shell_pid: 5, foreground_process_group_id: 6, foreground_processes: [] } } as T;
  starts++;
  throw busy;
 };
 const waited = fakeClock();
 expect(await startAgentWhenShellReady(opsOver(program), new AbortController().signal, waited).catch(e => e)).toBe(busy);
 expect(starts).toBe(1);
 expect(waited.slept).toEqual([]);
 starts = 0;
 const always: CreationCall = async <T,>(method: string) => { if (method === "pane.process_info") return shellInfo as T; starts++; throw busy; };
 const clock = fakeClock();
 expect(await startAgentWhenShellReady(opsOver(always), new AbortController().signal, clock).catch(e => e)).toBe(busy);
 expect(starts).toBe(20);
 expect(clock.elapsed()).toBe(2000);
});

test("a host without pane.process_info retries a busy start; a refused or mistyped probe doesn't", async () => {
 for (const [probe, retried] of [[new ErrUnsupported("pane.process_info", "", ""), true], [new OwnerRefusedError("pane.process_info"), false], [new HerdrAPIError("pane_not_found", "no", null), false], [new ResultTagError("pane.process_info", "ok", "pane_process_info"), false]] as const) {
  let starts = 0;
  const call: CreationCall = async <T,>(method: string) => {
   if (method === "pane.process_info") throw probe;
   if (++starts < 2) throw busy;
   return { agent: { pane_id: "p9" } } as T;
  };
  const result = await startAgentWhenShellReady(opsOver(call), new AbortController().signal, fakeClock()).catch(e => e);
  expect(result.pane_id === "p9").toBe(retried);
 }
});

test("a busy start whose shell this link can't see (probe refused by the owner gate, or unknown) says the shell is still starting", async () => {
 for (const probe of [new OwnerRefusedError("pane.process_info"), new ErrUnsupported("pane.process_info", "", "")]) {
  const call: CreationCall = async <T,>(method: string): Promise<T> => { if (method === "pane.process_info") throw probe; throw busy; };
  const result = await startAgentWhenShellReady(opsOver(call), new AbortController().signal, fakeClock()).catch(e => e);
  expect(result).toBeInstanceOf(ShellStartingError);
 }
 // A probe that answers keeps Go's outcome: herdr's busy refusal.
 const program: CreationCall = async <T,>(method: string): Promise<T> => {
  if (method === "pane.process_info") return { process_info: { shell_pid: 5, foreground_process_group_id: 6 } } as T;
  throw busy;
 };
 expect(await startAgentWhenShellReady(opsOver(program), new AbortController().signal, fakeClock()).catch(e => e)).toBe(busy);
});

test("a probe or pause that fails after a busy answer keeps the pane known empty: the start didn't run", async () => {
 const lost = new Error("link lost");
 const call: CreationCall = async <T,>(method: string): Promise<T> => { if (method === "pane.process_info") throw lost; throw busy; };
 const probe = await startAgentWhenShellReady(opsOver(call), new AbortController().signal, fakeClock()).catch(e => e);
 expect(probe).toBeInstanceOf(ShellStartingError);
 const ended = new AbortController();
 ended.abort(new Error("link ended"));
 const shellCall: CreationCall = async <T,>(method: string): Promise<T> => { if (method === "pane.process_info") return shellInfo as T; throw busy; };
 const pause = await startAgentWhenShellReady(opsOver(shellCall), ended.signal, { timeout: () => new AbortController().signal, sleep: async (_ms, signal) => { throw signal.reason; } }).catch(e => e);
 expect(pause).toBeInstanceOf(ShellStartingError);
 // A start that went out and didn't come back is no busy answer: its outcome stays unknown.
 const out: CreationCall = async <T,>(): Promise<T> => { throw lost; };
 expect(await startAgentWhenShellReady(opsOver(out), new AbortController().signal, fakeClock()).catch(e => e)).toBe(lost);
});

// ---- New terminal and the saved terminals ----

test("a link that ends while the new terminal's save waits for its lock closes the pane, and the save writes nothing", async () => {
 const closeAsked = Promise.withResolvers<void>();
 const h = host({ answers: req => req.method === "pane.split" ? split("p7") : req.method === "pane.close" ? (closeAsked.resolve(), ok({ type: "ok" })) : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 // Another tab holds the saved terminals' lock (Web Locks) until the link has ended.
 const lockAsked = Promise.withResolvers<void>(), lockFree = Promise.withResolvers<void>();
 Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: { request: async <T,>(_name: string, granted: () => Promise<T>) => { lockAsked.resolve(); await lockFree.promise; return granted(); } } });
 try {
  await createDesk.openCreation(machineID, "", "t1");
  const creating = createDesk.createTerminal("t1");
  await lockAsked.promise; // the split answered: the save waits for the lock
  desk.disconnectOwner();
  await closeAsked.promise; // the link's end closed the pane
  lockFree.resolve();
  const result = await creating;
  expect(result).toEqual({ phase: "failed", message: "The new terminal wasn't saved on this device: the creation or its connection ended first. Its pane was closed." });
  expect(savedOn(h.relay.hostID)).toEqual([]);
  expect(h.called("pane.close").map(c => c.params)).toEqual([{ pane_id: "p7" }]);
 } finally { Reflect.deleteProperty(globalThis.navigator, "locks"); lockFree.resolve(); desk.disconnectOwner(); h.relay.stop(); }
});

test("a new terminal whose save storage refuses, the link ending before the save's failure is handled, is closed by the link's end", async () => {
 const h = host({ answers: req => req.method === "pane.split" ? split("p7") : req.method === "pane.close" ? ok({ type: "ok" }) : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 // A full quota: every write throws.
 Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => { throw new DOMException("quota", "QuotaExceededError"); } } });
 // The lock runs the save and, as its refused write comes back, the owner leaves: the link ends
 // before createTerminal hears the failure.
 let leftOnce = false;
 Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: { request: async <T,>(_name: string, granted: () => Promise<T>) => {
  try { return await granted(); } finally { if (!leftOnce) { leftOnce = true; desk.disconnectOwner(); } }
 } } });
 try {
  await createDesk.openCreation(machineID, "", "t1");
  const result = await createDesk.createTerminal("t1");
  expect(result).toEqual({ phase: "failed", message: "The new terminal wasn't saved on this device: quota. Its pane was closed." });
  expect(h.called("pane.close").map(c => c.params)).toEqual([{ pane_id: "p7" }]);
 } finally { Reflect.deleteProperty(globalThis.navigator, "locks"); desk.disconnectOwner(); h.relay.stop(); }
});

test("a new terminal whose record was written before the link ends keeps its pane: the link's end leaves it", async () => {
 const h = host({ answers: req => req.method === "pane.split" ? split("p7") : req.method === "pane.close" ? ok({ type: "ok" }) : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 // The record is written (and the pane kept) under the lock, which is let go only after the owner
 // left: the link's end runs before addTerminal returns.
 const written = Promise.withResolvers<void>(), letGo = Promise.withResolvers<void>();
 Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: { request: async <T,>(_name: string, granted: () => Promise<T>) => {
  const value = await granted();
  written.resolve();
  await letGo.promise;
  return value;
 } } });
 try {
  await createDesk.openCreation(machineID, "", "t1");
  // What the link is asked to do, sent or not (its connection goes as the link ends).
  const client = currentOwnerLink()!.client, call = client.call.bind(client), asked: string[] = [];
  client.call = ((method: string, ...rest: unknown[]) => { asked.push(method); return (call as (...a: unknown[]) => unknown)(method, ...rest); }) as typeof client.call;
  const creating = createDesk.createTerminal("t1");
  await written.promise;
  desk.disconnectOwner();
  // The link's end has its turn before createTerminal hears the record was written.
  await new Promise<void>((done) => setImmediate(done));
  letGo.resolve();
  expect((await creating).phase).toBe("started");
  // The link's end decided at once (kept): it asks for no close.
  await new Promise<void>((done) => setImmediate(done));
  expect(savedOn(h.relay.hostID).map(e => e.paneID)).toEqual(["p7"]);
  expect(asked.filter(m => m === "pane.close")).toEqual([]);
 } finally { Reflect.deleteProperty(globalThis.navigator, "locks"); desk.disconnectOwner(); h.relay.stop(); }
});

test("a new terminal splits a pane, is saved for its machine, opens as a plain terminal, renames and closes on the machine", async () => {
 const h = host({ answers: req => req.method === "pane.split" ? split("p7") : req.method === "pane.rename" ? split("p7") : req.method === "pane.close" ? ok({ type: "ok" }) : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`, target = { machineID, session: "", paneID: "p7" };
 try {
  await createDesk.openCreation(machineID, "", "t1");
  const result = await createDesk.createTerminal("t1");
  expect(result.phase).toBe("started");
  expect(result.terminal?.label).toBe("Terminal 1");
  expect(h.called("pane.split")[0]!.params).toEqual({ direction: "down", focus: true });
  expect(await terminalsDesk.savedTerminals(machineID, "")).toEqual([result.terminal!]);
  expect(savedOn(h.relay.hostID)).toEqual([result.terminal!]);
  const view = await desk.openTerminalView(target, "term-1");
  expect(view).toMatchObject({ paneID: "p7", heading: "Terminal 1", plainTerminal: true, group: "terminal" });
  await terminalsDesk.renameTerminal(target, "  build  ");
  expect(h.called("pane.rename")[0]!.params).toEqual({ pane_id: "p7", label: "build" });
  expect((await terminalsDesk.savedTerminals(machineID, ""))[0]!.label).toBe("build");
  await terminalsDesk.closeTerminal(target);
  expect(h.called("pane.close")[0]!.params).toEqual({ pane_id: "p7" });
  expect(await terminalsDesk.savedTerminals(machineID, "")).toEqual([]);
  // Another machine's board never reads this one's.
  expect(String(await terminalsDesk.savedTerminals("owner:other", "").catch(e => e))).toContain("session changed");
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a close the machine refuses keeps the terminal saved; forgetting drops it without closing", async () => {
 const h = host({ answers: req => req.method === "pane.split" ? split("p7") : req.method === "pane.close" ? fail("pane_not_found") : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`, target = { machineID, session: "", paneID: "p7" };
 try {
  await createDesk.openCreation(machineID, "", "t1");
  await createDesk.createTerminal("t1");
  expect(String(await terminalsDesk.closeTerminal(target).catch(e => e))).toContain("pane_not_found");
  expect((await terminalsDesk.savedTerminals(machineID, "")).map(t => t.paneID)).toEqual(["p7"]);
  await terminalsDesk.forgetTerminal(target);
  expect(await terminalsDesk.savedTerminals(machineID, "")).toEqual([]);
  expect(h.called("pane.close")).toHaveLength(1);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a new terminal this browser can't keep closes its new pane again; a pane that won't close says so, not as an agent", async () => {
 let closes: Answer = ok({ type: "ok" }), pane = 7;
 const h = host({ answers: req => req.method === "pane.split" ? split(`p${pane++}`) : req.method === "pane.close" ? closes : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => { throw new Error("quota"); } } });
  await createDesk.openCreation(machineID, "", "t1");
  expect(await createDesk.createTerminal("t1")).toEqual({ phase: "failed", message: "The new terminal wasn't saved on this device: quota. Its pane was closed." });
  expect(h.called("pane.close")[0]!.params).toEqual({ pane_id: "p7" });
  closes = fail("pane_busy");
  const uncertain = await createDesk.createTerminal("t1");
  expect(uncertain).toEqual({ phase: "uncertain", message: "The new terminal wasn't saved on this device: quota. Could not close its pane p8: herdr: pane_busy: pane busy" });
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("an open plain terminal isn't paused by a list that has no agent on its pane", async () => {
 // Lists asked once the answer below is under way have a second agent (p2): the board that shows
 // it is such a list's, not one already on its way nor the folders' own republish.
 let relisted = false;
 const h = host({
  agents: () => [{ pane_id: "p1", name: "herdr-app", agent: "claude" }, ...(relisted ? [{ pane_id: "p2", name: "relay", agent: "claude" }] : [])],
  answers: req => req.method === "pane.split" ? split("p7") : req.method === "agent.read" ? fail("owner_forbidden") : undefined,
 });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "t1");
  await createDesk.createTerminal("t1");
  await desk.openTerminalView({ machineID, session: "", paneID: "p7" }, "term-1");
  const lists = h.called("agent.list").length;
  const listed = Promise.withResolvers<void>();
  const off = events.boardChanged.on(b => { if (b.board.sections.some(s => s.rows.some(r => r.id === "p2"))) { off(); listed.resolve(); } });
  relisted = true;
  // A refused answer asks the link to list again now (link.guestPoll's kick), long before the next
  // poll (GUEST_STATUS_POLL_MS is past this test's time limit).
  await desk.chatAnswer("term-1", "a", "1").catch(() => undefined);
  await listed.promise;
  expect(h.called("agent.list").length).toBeGreaterThan(lists);
  expect((await desk.state()).guest?.availability).toBeUndefined();
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a plain terminal's stream refused at its start stays that error: no agent is paused", async () => {
 const h = host({ answers: req => req.method === "pane.split" ? split("p7") : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "t1");
  await createDesk.createTerminal("t1");
  await desk.openTerminalView({ machineID, session: "", paneID: "p7" }, "term-1");
  expect(String(await desk.startTerminal("term-1", "s1").catch(e => e))).toContain("owner_forbidden");
  expect((await desk.state()).guest?.availability).toBeUndefined();
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a page's target is on the owner link's board only with its id and the one session", () => {
 expect(onBoard("owner:a", "owner:a", "")).toBe(true);
 expect(onBoard("owner:a", "owner:a", "default")).toBe(true);
 expect(onBoard("owner:a", "owner:a", "s2")).toBe(false);
 expect(onBoard("owner:a", "owner:b", "")).toBe(false);
});

/** The next board after a refused answer on view token asks the link to list again now. */
async function listOnce(desk: { chatAnswer(token: string, askID: string, option: string): Promise<unknown> }, token: string) {
 const listed = Promise.withResolvers<void>();
 const off = events.boardChanged.on(() => { off(); listed.resolve(); });
 await desk.chatAnswer(token, "a", "1");
 await listed.promise;
}

test.each([["server_unavailable", true], ["timeout", true], ["pane_not_found", false], ["agent_not_found", false]] as const)("a started agent's stream refused with %s: running %p", async (code, runs) => {
 const h = host({ answers: req => req.method === "pane.split" ? split("p8") : req.method === "agent.start" ? started("p8", "omp") : req.method === "pane.stream" ? fail(code) : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`, p8 = { machineID, session: "", paneID: "p8" };
 try {
  await createDesk.openCreation(machineID, "", "c1");
  await createDesk.createAgent("c1", "", "omp");
  await desk.openAgentView(p8, "v1");
  await desk.startTerminal("v1", "s1").catch(() => undefined);
  // A gone pane says so to the open view at once; a passing failure changes nothing.
  expect((await desk.state()).guest?.availability).toBe(runs ? undefined : "paused");
  // A list that hasn't caught up with the start.
  await listOnce(desk, "v1");
  expect((await desk.state()).guest?.availability).toBe(runs ? undefined : "paused");
  expect(await desk.openAgentView(p8, "v2").then(() => true, () => false)).toBe(runs);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a start acknowledged after the roster already listed and then dropped its pane doesn't bring it back", async () => {
 let roster = [{ pane_id: "p1", name: "herdr-app" }];
 const ack = Promise.withResolvers<Answer>(), asked = Promise.withResolvers<void>();
 const h = host({ agents: () => roster, answers: req => req.method === "pane.split" ? split("p8") : req.method === "agent.start" ? (asked.resolve(), ack.promise) : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await desk.openAgentView({ machineID, session: "", paneID: "p1" }, "k");
  await createDesk.openCreation(machineID, "", "c1");
  const pending = createDesk.createAgent("c1", "", "omp");
  await asked.promise;
  roster = [...roster, { pane_id: "p8", name: "omp" }];
  await listOnce(desk, "k");
  roster = [{ pane_id: "p1", name: "herdr-app" }];
  await listOnce(desk, "k");
  const relisted = Promise.withResolvers<void>();
  const off = events.boardChanged.on(() => { off(); relisted.resolve(); });
  ack.resolve(started("p8", "omp"));
  expect((await pending).phase).toBe("started");
  await relisted.promise;
  expect(String(await desk.openAgentView({ machineID, session: "", paneID: "p8" }, "v1").catch(e => e))).toContain("no longer on this board");
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("the readiness wait's one deadline covers a probe that doesn't answer: the busy answer stands", async () => {
 const deadline = new AbortController();
 const clock: Clock = { timeout: () => deadline.signal, sleep: async () => {} };
 const probing = Promise.withResolvers<void>();
 const call: CreationCall = async <T,>(method: string, _params: unknown, _tag: string, signal?: AbortSignal): Promise<T> => {
  if (method !== "pane.process_info") throw busy;
  probing.resolve();
  // A probe that only its signal ends.
  const { promise, reject } = Promise.withResolvers<T>();
  signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
  return promise;
 };
 const result = startAgentWhenShellReady(opsOver(call), new AbortController().signal, clock).catch(e => e);
 await probing.promise;
 deadline.abort(new Error("deadline"));
 expect(await result).toBe(busy);
});

test("the creation ending ends a probe that doesn't answer: the pane is kept for another Start", async () => {
 const sheet = new AbortController();
 const probing = Promise.withResolvers<void>();
 const ops: ShellReadyOps = {
  start: async () => { throw busy; },
  // A probe that only the signal it is given ends.
  probe: (signal) => { probing.resolve(); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); },
 };
 const result = startAgentWhenShellReady(ops, sheet.signal, { timeout: () => new AbortController().signal, sleep: async () => {} }).catch(e => e);
 await probing.promise;
 sheet.abort(new Error("sheet dismissed"));
 expect(await result).toBeInstanceOf(ShellStartingError);
});

test("started agents: only provisional ones open; a pane the roster had during the attempt is the roster's", () => {
 const s = new StartedAgents();
 const p8 = { pane_id: "p8", name: "omp" };
 // Listed before the attempt began: another pane's history, not this attempt's roster.
 s.listed([p8]);
 const watch = s.watch();
 s.listed([]);
 watch.started(p8);
 s.listed([]);
 expect(s.get("p8")).toBe(p8);
 s.listed([p8]);
 expect(s.get("p8")).toBeUndefined();
 // The roster had it during the attempt, then dropped it: the acknowledgement doesn't revive it.
 const late = s.watch();
 s.listed([p8]);
 s.listed([]);
 late.started(p8);
 expect(s.get("p8")).toBeUndefined();
 const fresh = new StartedAgents();
 fresh.watch().started(p8);
 for (const code of ["timeout", "server_unavailable", "owner_forbidden", "owner_paused"]) expect(fresh.refused("p8", code)).toBe(false);
 expect(fresh.get("p8")).toBe(p8);
 expect(fresh.refused("p8", "pane_not_found")).toBe(true);
 expect(fresh.get("p8")).toBeUndefined();
 const p9 = { pane_id: "p9", name: "claude" };
 fresh.watch().started(p9);
 expect(fresh.refused("p9", "agent_not_found")).toBe(true);
 expect(fresh.get("p9")).toBeUndefined();
});

test("a saved terminal's change fails, keeping nothing (the pane neither), when storage refuses the write, can't read the value, or the lock is refused", async () => {
 let keeps = 0;
 const owner = { taken: false, keep: () => { keeps++; } };
 const add = (pane: string) => persistAndKeep(owner, "h1", { id: "t-" + pane, paneID: pane, createdUnixMs: 1 });
 expect((await add("p1")).label).toBe("Terminal 1");
 expect([savedOn("h1").map(e => e.paneID), keeps]).toEqual([["p1"], 1]);
 // A full quota: the write throws, before the pane is kept.
 Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => kept.get(k) ?? null, setItem: () => { throw new DOMException("quota", "QuotaExceededError"); } } });
 expect(String(await add("p2").catch(e => e))).toContain("quota");
 expect([savedOn("h1").map(e => e.paneID), keeps]).toEqual([["p1"], 1]);
 Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } } });
 // A pane its creation or link took back: nothing written, nothing kept.
 const taken = { taken: true, keep: () => { keeps++; } };
 expect(String(await persistAndKeep(taken, "h1", { id: "t-p5", paneID: "p5", createdUnixMs: 1 }).catch(e => e))).toContain("ended first");
 expect([savedOn("h1").map(e => e.paneID), keeps]).toEqual([["p1"], 1]);
 // Another version's value, not records by machine: never written over.
 kept.set(SAVED_TERMINALS_KEY, "[1,2]");
 expect(String(await add("p3").catch(e => e))).toContain("can't be read");
 expect([kept.get(SAVED_TERMINALS_KEY), keeps]).toEqual(["[1,2]", 1]);
 kept.delete(SAVED_TERMINALS_KEY);
 // The lock refused: nothing runs.
 Object.defineProperty(globalThis.navigator, "locks", { configurable: true, value: { request: () => Promise.reject(new DOMException("denied", "SecurityError")) } });
 try {
  expect(String(await add("p4").catch(e => e))).toContain("refused its lock");
  expect([kept.has(SAVED_TERMINALS_KEY), keeps]).toEqual([false, 1]);
 } finally { Reflect.deleteProperty(globalThis.navigator, "locks"); }
});

test("a closed creation sends nothing", async () => {
 const h = host({ answers: req => req.method === "pane.split" ? split("p7") : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "t1");
  await createDesk.closeCreation("t1");
  expect(await createDesk.createTerminal("t1").catch(e => e)).toBeInstanceOf(Error);
  expect(await createDesk.createAgent("t1", "", "omp").catch(e => e)).toBeInstanceOf(Error);
  expect(h.called("pane.split")).toHaveLength(0);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

// ---- New agent ----

test("a new agent splits a pane in its folder, starts there, opens before the list has it, and the roster lists it", async () => {
 let listed = false;
 const h = host({
  agents: () => listed ? [{ pane_id: "p1", name: "herdr-app" }, { pane_id: "p8", name: "my-project", agent: "omp" }] : [{ pane_id: "p1", name: "herdr-app" }],
  answers: req => req.method === "pane.split" ? split("p8") : req.method === "agent.start" ? started("p8", "my-project") : req.method === "agent.kinds" ? ok({ type: "agent_kinds", kinds: [{ kind: "omp", installed: true }] }) : undefined,
 });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  expect(JSON.parse(await createDesk.creationKinds("c1"))).toEqual([{ installed: true, kind: "omp" }]);
  // The link lists again as soon as the agent started, not at the next poll (15 s).
  const result = await createDesk.createAgent("c1", " /home/ci/My Project ", "omp");
  const relisted = h.nextList();
  expect(result).toEqual({ phase: "started", paneID: "p8", name: "my-project", message: "" });
  expect(h.called("pane.split")[0]!.params).toEqual({ direction: "down", cwd: "/home/ci/My Project", focus: true });
  expect(h.called("agent.start")[0]!.params).toEqual({ name: "my-project", kind: "omp", pane_id: "p8" });
  await relisted;
  // That list doesn't have it yet: the start's reply opens it, and no other pane.
  expect(String(await desk.openAgentView({ machineID, session: "", paneID: "p9" }, "v0").catch(e => e))).toContain("no longer on this board");
  const view = await desk.openAgentView({ machineID, session: "", paneID: "p8" }, "v1");
  expect(view.name).toBe("my-project");
  expect((await desk.state()).guest?.availability).toBeUndefined();
  listed = true;
  const roster = Promise.withResolvers<void>();
  const off = events.boardChanged.on(b => { if (b.board.sections.some(s => s.rows.some(r => r.id === "p8"))) { off(); roster.resolve(); } });
  await desk.chatAnswer("v1", "a", "1").catch(() => undefined);
  await roster.promise;
 } finally { desk.disconnectOwner(); h.relay.stop(); }
}, 10_000); // under the link's 15 s poll: only the start's own relist lists in time

test("a started agent the roster hasn't caught up with opens and runs, after its sheet closed too, until a list first has it", async () => {
 let listed = false;
 const h = host({
  agents: () => listed ? [{ pane_id: "p1", name: "herdr-app" }, { pane_id: "p8", name: "omp", agent: "omp" }] : [{ pane_id: "p1", name: "herdr-app" }],
  answers: req => req.method === "pane.split" ? split("p8") : req.method === "agent.start" ? started("p8", "omp") : req.method === "agent.answer" ? fail("owner_forbidden") : undefined,
 });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`, p8 = { machineID, session: "", paneID: "p8" };
 const listOnce = async () => {
  const got = Promise.withResolvers<void>();
  const off = events.boardChanged.on(() => { off(); got.resolve(); });
  // A refused answer asks the link to list again now (link.guestPoll's kick).
  await desk.chatAnswer("v1", "a", "1");
  await got.promise;
 };
 try {
  await createDesk.openCreation(machineID, "", "c1");
  expect((await createDesk.createAgent("c1", "", "omp")).phase).toBe("started");
  await createDesk.closeCreation("c1");
  await desk.openAgentView(p8, "v1");
  await listOnce();
  await listOnce();
  expect((await desk.state()).guest?.availability).toBeUndefined();
  listed = true;
  await listOnce();
  expect((await desk.state()).guest?.availability).toBeUndefined();
  // Once listed, the roster decides: gone from a list is paused, and it no longer opens.
  listed = false;
  await listOnce();
  expect((await desk.state()).guest?.availability).toBe("paused");
  expect(String(await desk.openAgentView(p8, "v2").catch(e => e))).toContain("no longer on this board");
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a refused start closes the new pane and lets the sheet try again; a pane that won't close is uncertain", async () => {
 let closes: Answer = ok({ type: "ok" });
 const h = host({ answers: req => req.method === "pane.split" ? split("p8") : req.method === "agent.start" ? fail("agent_start_failed") : req.method === "pane.close" ? closes : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  const failed = await createDesk.createAgent("c1", "", "omp");
  expect(failed).toEqual({ phase: "failed", paneID: "", name: "", message: "herdr: agent_start_failed: agent start failed" });
  expect(h.called("pane.close").map(c => c.params)).toEqual([{ pane_id: "p8" }]);
  closes = fail("pane_busy");
  const uncertain = await createDesk.createAgent("c1", "", "omp");
  expect(uncertain.phase).toBe("uncertain");
  expect(uncertain.paneID).toBe("p8");
  expect(uncertain.message).toContain("Could not close empty pane p8");
  expect(String(await createDesk.createAgent("c1", "", "omp").catch(e => e))).toContain("uncertain result");
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a sheet closed while its agent starts ends the start's request: uncertain, the pane neither closed nor started again", async () => {
 const startAsked = Promise.withResolvers<void>(), release = Promise.withResolvers<Answer>();
 const h = host({ answers: req => req.method === "pane.split" ? split("p8") : req.method === "agent.start" ? (startAsked.resolve(), release.promise) : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  const pending = createDesk.createAgent("c1", "", "omp");
  await startAsked.promise;
  await createDesk.closeCreation("c1");
  const result = await pending;
  release.resolve(started("p8", "omp"));
  expect(result.phase).toBe("uncertain");
  expect(result.paneID).toBe("p8");
  expect(h.called("pane.close")).toHaveLength(0);
  expect(h.called("agent.start")).toHaveLength(1);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a host without pane.split fails a new terminal and a new agent alike: no pane was split", async () => {
 const h = host({ answers: req => req.method === "pane.split" ? fail("unknown_method") : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  expect((await createDesk.createTerminal("c1")).phase).toBe("failed");
  expect((await createDesk.createAgent("c1", "", "omp")).phase).toBe("failed");
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a split whose answer isn't a pane's leaves the machine unknown: uncertain, not failed", async () => {
 const h = host({ answers: req => req.method === "pane.split" ? ok({ type: "ok" }) : undefined });
 const desk = await connected(h.relay);
 try {
  await createDesk.openCreation(`owner:${h.relay.hostID}`, "", "c1");
  expect((await createDesk.createTerminal("c1")).phase).toBe("uncertain");
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a start whose outcome is unknown neither closes nor repeats", async () => {
 const h = host({ answers: req => req.method === "pane.split" ? split("p8") : req.method === "agent.start" ? ok({ type: "ok" }) : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  const result = await createDesk.createAgent("c1", "", "omp");
  expect(result.phase).toBe("uncertain");
  expect(result.message).toContain("Start outcome is unknown for pane p8");
  expect(h.called("pane.close")).toHaveLength(0);
  expect(h.called("agent.start")).toHaveLength(1);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a chat-scope link's split is refused in the owner's words, and the sheet may try again", async () => {
 const h = host({ scope: "chat" });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  expect(await createDesk.createAgent("c1", "", "omp")).toEqual({ phase: "failed", paneID: "", name: "", message: OWNER_REFUSED });
  expect(await createDesk.createTerminal("c1")).toEqual({ phase: "failed", message: OWNER_REFUSED });
  expect(h.called("pane.split")).toHaveLength(2);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a host without agent.kinds offers none (the sheet's own list applies); the folder browser lists a remote folder", async () => {
 const h = host({ answers: req => req.method === "agent.kinds" ? fail("unknown_method") : req.method === "fs.list_dir" ? ok({ type: "dir_list", path: "/srv", entries: [{ name: "app", is_dir: true }] }) : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  expect(JSON.parse(await createDesk.creationKinds("c1"))).toEqual([]);
  expect(JSON.parse(await createDesk.creationDirectory("c1", "/srv"))).toEqual({ entries: [{ is_dir: true, name: "app" }], path: "/srv" });
  expect(h.called("fs.list_dir")[0]!.params).toEqual({ path: "/srv" });
  await createDesk.creationDirectory("c1", "");
  expect(h.called("fs.list_dir")[1]!.params).toEqual({});
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

// ---- A plain terminal's composer and copy actions (pane RPCs, as desk_interaction.go) ----

test("a plain terminal's text is written to the pane without Enter, and its screen is read from the pane", async () => {
 const h = host({ answers: req => req.method === "pane.split" ? split("p7") : req.method === "pane.send_text" ? ok({ type: "ok" }) : req.method === "pane.read" ? ok({ type: "pane_read", read: { text: "$ ls" } }) : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "t1");
  await createDesk.createTerminal("t1");
  await desk.openTerminalView({ machineID, session: "", paneID: "p7" }, "term-1");
  expect(JSON.parse(await desk.chatPrompt("term-1", "make test"))).toEqual({ delivery: "written", note: "Written to terminal; press Enter to run it." });
  expect(h.called("pane.send_text").map(c => c.params)).toEqual([{ pane_id: "p7", text: "make test" }]);
  expect(await desk.readAgentText("term-1", false)).toBe("$ ls");
  await desk.readAgentText("term-1", true);
  expect(h.called("pane.read").map(c => c.params)).toEqual([{ pane_id: "p7", source: "visible", format: "text" }, { pane_id: "p7", source: "recent", format: "text" }]);
  expect(h.called("agent.prompt")).toHaveLength(0);
  expect(h.called("agent.read")).toHaveLength(0);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a write or prompt that never left the page, or herdr refused, fails; one that may have arrived is unconfirmed", () => {
 expect(() => terminalWriteReceipt(new HerdrAPIError("pane_not_found", "gone", null))).toThrow("pane_not_found");
 expect(() => terminalWriteReceipt(new ErrUnsupported("pane.send_text", "", ""))).toThrow("pane.send_text");
 const notOut = notSent(relayRefused());
 expect(() => terminalWriteReceipt(notOut)).toThrow(notOut.message);
 expect(() => promptReceipt(null, notOut)).toThrow(notOut.message);
 // A host without the method refused it: definite, for an agent prompt as for terminal text.
 expect(() => promptReceipt(null, new ErrUnsupported("agent.prompt", "", ""))).toThrow("agent.prompt");
 expect(() => promptReceipt(null, new HerdrAPIError("pane_not_found", "gone", null))).toThrow("pane_not_found");
 // A write that may have arrived reads the same, agent prompt or terminal text (Go's one receipt).
 const unconfirmed = { delivery: "unconfirmed", note: "Couldn't confirm delivery — check the terminal before sending again." };
 expect(JSON.parse(terminalWriteReceipt(new HerdrAPIError("timeout", "slow", null)))).toEqual(unconfirmed);
 expect(JSON.parse(terminalWriteReceipt(new Error("link lost")))).toEqual(unconfirmed);
 expect(JSON.parse(promptReceipt(null, new Error("link lost")))).toEqual(unconfirmed);
 expect(JSON.parse(promptReceipt({ delivery: "written_to_pty" }, new HerdrAPIError("timeout", "slow", null)))).toEqual(unconfirmed);
 expect(JSON.parse(promptReceipt({ delivery: "written_to_pty" }, null))).toEqual({ delivery: "written_to_pty", note: "Sent to terminal; agent submission not verified" });
 expect(JSON.parse(promptReceipt(null, null))).toEqual({ delivery: "submitted" });
});

test("a plain terminal takes plain text on one line: every C0 control, DEL and C1 is refused as not sent, before any write; printable text is written", async () => {
 const h = host({ answers: req => req.method === "pane.split" ? split("p7") : req.method === "pane.send_text" ? ok({ type: "ok" }) : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "t1");
  await createDesk.createTerminal("t1");
  await desk.openTerminalView({ machineID, session: "", paneID: "p7" }, "term-1");
  const controls = [...Array(0x20).keys(), ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i)].map((c) => `a${String.fromCharCode(c)}b`);
  for (const draft of ["echo one\necho two", "ls\r", "make\r\ntest", "\u001b[A", ...controls]) {
   // The composer refuses nothing itself: this page's refusal is a definite not-sent, so the
   // composer's catch puts the draft back (interaction.ts sendPrompt, rule 3).
   const refused = await desk.chatPrompt("term-1", draft).catch(e => e);
   expect(refused).toBeInstanceOf(NotSentError);
   expect(String(refused)).toContain("Write plain text on one line: line breaks and control characters would act on the terminal before Enter.");
  }
  expect(h.called("pane.send_text")).toHaveLength(0);
  for (const printable of [" ", "~", "\u00a0", "é", "日本", "😀", "· café"]) {
   expect(JSON.parse(await desk.chatPrompt("term-1", `make test ${printable}`)).delivery).toBe("written");
  }
  expect(h.called("pane.send_text").map((c) => (c.params as { text: string }).text)).toEqual([" ", "~", "\u00a0", "é", "日本", "😀", "· café"].map((p) => `make test ${p}`));
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a chat-scope link doesn't open a saved shell: herdr neither streams nor writes it there", async () => {
 const h = host({ scope: "chat" });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  kept.set(SAVED_TERMINALS_KEY, JSON.stringify({ [h.relay.hostID]: [{ id: "t", paneID: "p7", label: "Terminal 1", createdUnixMs: 0 }] }));
  expect(String(await desk.openTerminalView({ machineID, session: "", paneID: "p7" }, "term-1").catch(e => e))).toContain(OWNER_REFUSED);
  // This device's record can still go.
  await terminalsDesk.forgetTerminal({ machineID, session: "", paneID: "p7" });
  expect(await terminalsDesk.savedTerminals(machineID, "")).toEqual([]);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

// ---- agent_pane_busy behind herdr#510's owner gate, which serves no pane.process_info ----

/** A host whose owner gate refuses pane.process_info (probe "refused"), that has none (probe
 *  "unknown") or serves it (a shell still starting); agent.start answers busy busyStarts times
 *  (or until startsNow), then starts. closed() settles with the next pane.close. */
function busyHost(probe: "refused" | "unknown" | "starting", busyStarts: number) {
 let starts = 0, limit = busyStarts, pane = 8, closing: (() => void) | null = null;
 const h = host({ answers: req => {
  switch (req.method) {
   case "pane.split": return split(`p${pane++}`);
   case "pane.close": closing?.(); return ok({ type: "ok" });
   case "pane.process_info": return probe === "refused" ? fail("owner_forbidden") : probe === "unknown" ? fail("unknown_method") : ok(shellInfo);
   case "agent.start": return ++starts <= limit ? fail("agent_pane_busy") : started(String(req.params.pane_id), "omp");
  }
  return undefined;
 } });
 return { ...h, startsNow: () => { limit = starts; }, closed: () => { const next = Promise.withResolvers<void>(); closing = next.resolve; return next.promise; } };
}

test("a busy start whose shell the link can't see (a gate refusing the probe, a host without it) keeps its pane and says the shell is starting; Start again starts there", async () => {
 for (const probe of ["refused", "unknown"] as const) {
  const h = busyHost(probe, probe === "refused" ? 1 : 1_000);
  const desk = await connected(h.relay);
  const machineID = `owner:${h.relay.hostID}`;
  try {
   await createDesk.openCreation(machineID, "", "c1");
   expect(await createDesk.createAgent("c1", "/srv", "omp")).toEqual({ phase: "failed", paneID: "", name: "", message: "The new pane's shell is still starting; try again in a moment." });
   expect(h.called("pane.close")).toHaveLength(0);
   const starts = h.called("agent.start").length;
   h.startsNow();
   expect(await createDesk.createAgent("c1", "/srv", "omp")).toEqual({ phase: "started", paneID: "p8", name: "srv", message: "" });
   expect(h.called("pane.split")).toHaveLength(1);
   expect(h.called("agent.start").map(c => c.params.pane_id)).toEqual(Array(starts + 1).fill("p8"));
   expect(h.called("pane.close")).toHaveLength(0);
  } finally { desk.disconnectOwner(); h.relay.stop(); }
 }
});

test("a pane kept for a busy start is closed when the sheet takes another folder, or closes", async () => {
 const h = busyHost("refused", 2);
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  await createDesk.createAgent("c1", "/srv", "omp");
  await createDesk.createAgent("c1", "/home", "omp");
  expect(h.called("pane.close").map(c => c.params)).toEqual([{ pane_id: "p8" }]);
  expect(h.called("pane.split").map(c => c.params.cwd)).toEqual(["/srv", "/home"]);
  const closed = h.closed();
  await createDesk.closeCreation("c1");
  await closed;
  expect(h.called("pane.close")[1]!.params).toEqual({ pane_id: "p9" });
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a pane kept for a busy start is closed while the owner link ends, before its connection goes", async () => {
 const h = busyHost("refused", 1);
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  await createDesk.createAgent("c1", "/srv", "omp");
  const closed = h.closed();
  desk.disconnectOwner();
  await createDesk.closeCreation("c1");
  await closed;
  expect(h.called("pane.close").map(c => c.params)).toEqual([{ pane_id: "p8" }]);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a close the closed sheet sent keeps the owner link's connection until it settles", async () => {
 const reply = Promise.withResolvers<Answer>(), asked = Promise.withResolvers<void>();
 let starts = 0;
 const h = host({ answers: req => {
  if (req.method === "pane.split") return split("p8");
  if (req.method === "pane.process_info") return fail("owner_forbidden");
  if (req.method === "agent.start") return ++starts === 1 ? fail("agent_pane_busy") : undefined;
  if (req.method === "pane.close") { asked.resolve(); return reply.promise; }
  return undefined;
 } });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  await createDesk.createAgent("c1", "/srv", "omp");
  await createDesk.closeCreation("c1");
  await asked.promise;
  const ended = h.sessionEnded();
  // The connection's end is the behaviour: the transport closes only once the cleanup's close is
  // answered (the link's closing wait), never while it is held.
  const events: string[] = [];
  const close = GuestTransport.prototype.close;
  GuestTransport.prototype.close = function (this: GuestTransport) { events.push("transport closed"); return close.call(this); };
  try {
   desk.disconnectOwner();
   await new Promise((r) => setImmediate(r)); // whatever the disconnect queued has run
   events.push("close answered");
   reply.resolve(ok({ type: "ok" }));
   await ended;
  } finally { GuestTransport.prototype.close = close; }
  expect(events).toEqual(["close answered", "transport closed"]);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("an owner link that ends in the turn its split answered closes the new pane before its connection goes; no start is sent", async () => {
 const sent: string[] = [], closedPanes: unknown[] = [];
 const asked = Promise.withResolvers<void>(), splitAnswer = Promise.withResolvers<unknown>();
 const web = {
  access: {}, features: () => ({}),
  async call(method: string, params?: Record<string, unknown>) {
   sent.push(method);
   if (method === "pane.split") { asked.resolve(); return splitAnswer.promise; }
   if (method === "pane.close") { closedPanes.push(params?.pane_id); return { type: "ok" }; }
   throw new HerdrAPIError("owner_forbidden", "not in the owner gate", null);
  },
  stream() { throw new Error("no streams"); },
 } as unknown as WebLink;
 const life = new AbortController();
 const machine: EnvelopeMachine = { hostItemID: "H1", label: "dev2306", relay: "", hostID: "host-s", nodePub: "", grantID: "g1", scope: "terminal", expiresUnix: 1_800_000_000 };
 const link: OwnerLink = { machine, board: "owner:host-s", client: new GuestClient(web), signal: life.signal, scope: () => "terminal", agents: () => [], relist() {}, watchStart: () => ({ started() {}, end() {} }) };
 setLink(web, link);
 try {
  await createDesk.openCreation("owner:host-s", "", "c1");
  const creating = createDesk.createAgent("c1", "", "omp");
  await asked.promise;
  // The split's answer is decoded, and in that same turn the link ends as desk.ts disconnect ends
  // it: its groups' cleanup first (the connection carries requests until it settles), then its end.
  splitAnswer.resolve({ type: "pane_info", pane: { pane_id: "p8" } });
  const closing = linkClosing(link);
  life.abort(new Error("link ended"));
  setLink(null);
  await closing;
  expect(closedPanes).toEqual(["p8"]);
  expect((await creating).phase).toBe("failed");
  expect(sent).not.toContain("agent.start");
 } finally { setLink(null); await createDesk.closeCreation("c1"); }
});

/** A host whose split answer waits until answer is called; the browser's split has reached it
 *  once asked settles, and its close once closed settles. */
function heldSplitHost() {
 const asked = Promise.withResolvers<void>(), reply = Promise.withResolvers<Answer>(), closed = Promise.withResolvers<void>();
 const h = host({ answers: req => req.method === "pane.split" ? (asked.resolve(), reply.promise) : req.method === "pane.close" ? (closed.resolve(), ok({ type: "ok" })) : undefined });
 return { h, asked: asked.promise, closed: closed.promise, answer: () => reply.resolve(split("p7")) };
}

test("a link that ends after New terminal's split went out still hears its answer and closes the pane it made", async () => {
 const { h, asked, answer } = heldSplitHost();
 const desk = await connected(h.relay);
 try {
  await createDesk.openCreation(`owner:${h.relay.hostID}`, "", "t1");
  const creating = createDesk.createTerminal("t1");
  await asked;
  desk.disconnectOwner();
  answer();
  expect(await creating).toEqual({ phase: "failed", message: "The new terminal wasn't saved on this device: the creation or its connection ended first. Its pane was closed." });
  expect(h.called("pane.close").map(c => c.params)).toEqual([{ pane_id: "p7" }]);
  expect(savedOn(h.relay.hostID)).toEqual([]);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

for (const [how, end] of [
 ["the sheet closes", () => createDesk.closeCreation("t1")],
 ["another sheet opens", (machineID: string) => createDesk.openCreation(machineID, "", "t2")],
] as const) {
 test(`a New terminal whose sheet ends (${how}) while its split is out saves nothing: the split's answer is heard and its pane closed`, async () => {
  const { h, asked, answer } = heldSplitHost();
  const desk = await connected(h.relay);
  const machineID = `owner:${h.relay.hostID}`;
  try {
   await createDesk.openCreation(machineID, "", "t1");
   const creating = createDesk.createTerminal("t1");
   await asked;
   await end(machineID);
   answer();
   expect(await creating).toEqual({ phase: "failed", message: "The new terminal wasn't saved on this device: the creation or its connection ended first. Its pane was closed." });
   expect(h.called("pane.close").map(c => c.params)).toEqual([{ pane_id: "p7" }]);
   expect(savedOn(h.relay.hostID)).toEqual([]);
  } finally { await createDesk.closeCreation("t2"); desk.disconnectOwner(); h.relay.stop(); }
 });
}

test("a link that ends after New agent's split went out still hears its answer and closes the pane it made; no start is sent", async () => {
 const { h, asked, closed, answer } = heldSplitHost();
 const desk = await connected(h.relay);
 try {
  await createDesk.openCreation(`owner:${h.relay.hostID}`, "", "c1");
  const creating = createDesk.createAgent("c1", "", "omp");
  await asked;
  desk.disconnectOwner();
  answer();
  expect((await creating).phase).toBe("failed");
  // The pane's close goes out (on a session of its own, the split's having ended).
  await closed;
  expect(h.called("pane.close").map(c => c.params)).toEqual([{ pane_id: "p7" }]);
  expect(h.called("agent.start")).toEqual([]);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a link that ends before New terminal's split went out sends no split", async () => {
 const { h } = heldSplitHost();
 const desk = await connected(h.relay);
 try {
  await createDesk.openCreation(`owner:${h.relay.hostID}`, "", "t1");
  const creating = createDesk.createTerminal("t1");
  desk.disconnectOwner();
  // Never handed to the transport: not sent (NotSentError, a failure the sheet may try again).
  expect((await creating).phase).toBe("failed");
  await new Promise<void>((done) => setImmediate(done));
  expect(h.called("pane.split")).toEqual([]);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("an owner link that ends while a busy start's probe is out closes the known-empty pane", async () => {
 const probing = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
 const h = host({ answers: req => {
  if (req.method === "pane.split") return split("p8");
  if (req.method === "agent.start") return fail("agent_pane_busy");
  // The probe is held: the link ends while it is out.
  if (req.method === "pane.process_info") { probing.resolve(); return new Promise<Answer>(() => {}); }
  if (req.method === "pane.close") { closed.resolve(); return ok({ type: "ok" }); }
  return undefined;
 } });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  const pending = createDesk.createAgent("c1", "/srv", "omp");
  await probing.promise;
  desk.disconnectOwner();
  await closed.promise;
  expect(h.called("pane.close").map(c => c.params)).toEqual([{ pane_id: "p8" }]);
  expect((await pending).phase).toBe("failed");
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test.each([[true, "while its start is out"], [false, "once an agent started in it"]] as const)("an owner link's end leaves a pane alone (start held %p): %s", async (held) => {
 const asked = Promise.withResolvers<void>();
 const h = host({ answers: req => {
  if (req.method === "pane.split") return split("p8");
  if (req.method === "agent.start") { asked.resolve(); return held ? new Promise<Answer>(() => {}) : started("p8", "omp"); }
  if (req.method === "pane.close") return ok({ type: "ok" });
  return undefined;
 } });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  const pending = createDesk.createAgent("c1", "/srv", "omp");
  await asked.promise;
  if (!held) await pending;
  // Every request the link's own client sends from here: a close would go out as the link ends.
  const client = currentOwnerLink()!.client, sent: string[] = [];
  const send = client.call.bind(client);
  client.call = (method, ...rest) => { sent.push(method); return send(method, ...rest); };
  const ended = h.sessionEnded();
  desk.disconnectOwner();
  await ended;
  expect(sent).not.toContain("pane.close");
  expect((await pending).phase).toBe(held ? "uncertain" : "started");
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a busy start on a gate that serves the probe waits for the shell as the desktop does", async () => {
 const h = busyHost("starting", 1);
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  expect((await createDesk.createAgent("c1", "", "omp")).phase).toBe("started");
  expect(h.called("agent.start")).toHaveLength(2);
  expect(h.called("pane.process_info")).toHaveLength(2);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

// ---- A refused relay upgrade, a dismissed sheet, a narrowed scope, a held probe ----

test.each([[true, "Start again uses it"], [false, "the link's end closes it"]] as const)("a start the relay refused before it went out keeps its pane (retry %p): %s", async (retry) => {
 let at = Date.now(), refuse = false;
 const closed = Promise.withResolvers<void>();
 const h = host({
  admit: () => refuse ? new Response(null, { status: 429 }) : undefined,
  // Every connection ends after the split; the relay refuses the next connect: agent.start's.
  endAfter: "pane.split",
  answers: req => {
   if (req.method === "pane.split") { refuse = true; return split("p8"); }
   if (req.method === "agent.start") return started(String(req.params.pane_id), "omp");
   if (req.method === "pane.close") { closed.resolve(); return ok({ type: "ok" }); }
   return undefined;
  },
 });
 const desk = await connected(h.relay, () => at);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  expect((await createDesk.createAgent("c1", "/srv", "omp")).phase).toBe("failed");
  expect(h.called("agent.start")).toHaveLength(0);
  // The relay admits again, and its backoff has passed.
  refuse = false;
  at += 60_000;
  if (retry) {
   expect(await createDesk.createAgent("c1", "/srv", "omp")).toEqual({ phase: "started", paneID: "p8", name: "srv", message: "" });
   expect(h.called("pane.split")).toHaveLength(1);
   expect(h.called("pane.close")).toHaveLength(0);
  } else {
   desk.disconnectOwner();
   await closed.promise;
   expect(h.called("pane.close").map(c => c.params)).toEqual([{ pane_id: "p8" }]);
  }
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a sheet dismissed while a busy start's probe is out closes the empty pane at once, the link up", async () => {
 const probing = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
 const h = host({ answers: req => {
  if (req.method === "pane.split") return split("p8");
  if (req.method === "agent.start") return fail("agent_pane_busy");
  if (req.method === "pane.process_info") { probing.resolve(); return new Promise<Answer>(() => {}); }
  if (req.method === "pane.close") { closed.resolve(); return ok({ type: "ok" }); }
  return undefined;
 } });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  const pending = createDesk.createAgent("c1", "/srv", "omp");
  await probing.promise;
  await createDesk.closeCreation("c1");
  expect((await pending).phase).toBe("failed");
  await closed.promise;
  expect(h.called("pane.close").map(c => c.params)).toEqual([{ pane_id: "p8" }]);
  expect((await desk.state()).phase).toBe("connected");
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test.each(["dismiss", "disconnect"] as const)("a start whose connect is still in its hello never went out: on %s the split pane closes", async (end) => {
 let holdNext = false;
 const closed = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
 const h = host({
  // Every connection ends after the split; the next connect's hello is held: agent.start waits in it.
  endAfter: "pane.split",
  hold: () => { if (!holdNext) return false; holdNext = false; held.resolve(); return true; },
  answers: req => {
   if (req.method === "pane.split") { holdNext = true; return split("p8"); }
   if (req.method === "pane.close") { closed.resolve(); return ok({ type: "ok" }); }
   return undefined;
  },
 });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  const pending = createDesk.createAgent("c1", "/srv", "omp");
  await held.promise;
  if (end === "dismiss") await createDesk.closeCreation("c1");
  else desk.disconnectOwner();
  expect((await pending).phase).toBe("failed");
  await closed.promise;
  expect(h.called("agent.start")).toHaveLength(0);
  expect(h.called("pane.close").map(c => c.params)).toEqual([{ pane_id: "p8" }]);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a shell write the relay refused before it went out fails (the page keeps the draft), not unconfirmed", async () => {
 let refuse = false;
 const h = host({
  admit: () => refuse ? new Response(null, { status: 429 }) : undefined,
  // Every connection ends after the split; the relay refuses the next connect: the write's.
  endAfter: "pane.split",
  answers: req => {
   if (req.method === "pane.split") { refuse = true; return split("p7"); }
   return req.method === "pane.send_text" ? ok({ type: "ok" }) : undefined;
  },
 });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "t1");
  expect((await createDesk.createTerminal("t1")).phase).toBe("started");
  await desk.openTerminalView({ machineID, session: "", paneID: "p7" }, "term-1");
  expect(await desk.chatPrompt("term-1", "make test").catch(e => e)).toBeInstanceOf(NotSentError);
  expect(h.called("pane.send_text")).toHaveLength(0);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("an open shell writes nothing once a renewal narrowed the link to chat scope", async () => {
 let scope = "terminal";
 const h = host({ scope: () => scope, answers: req => req.method === "pane.split" ? split("p7") : req.method === "pane.send_text" ? ok({ type: "ok" }) : undefined });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "t1");
  await createDesk.createTerminal("t1");
  await desk.openTerminalView({ machineID, session: "", paneID: "p7" }, "term-1");
  scope = "chat";
  // The stream opens a session admitted under the new scope (herdr refuses the shell there): the
  // page hears the scope from that refusal, before any list.
  await desk.startTerminal("term-1", "s1").catch(() => undefined);
  expect((await desk.state()).guest?.ownerScope).toBe("chat");
  expect(String(await desk.chatPrompt("term-1", "ls").catch(e => e))).toContain(OWNER_REFUSED);
  expect(h.called("pane.send_text")).toHaveLength(0);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});

test("a busy start whose first probe the host holds settles within the readiness deadline", async () => {
 const h = host({ answers: req => {
  if (req.method === "pane.split") return split("p8");
  if (req.method === "agent.start") return fail("agent_pane_busy");
  if (req.method === "pane.process_info") return new Promise<Answer>(() => {});
  if (req.method === "pane.close") return ok({ type: "ok" });
  return undefined;
 } });
 const desk = await connected(h.relay);
 const machineID = `owner:${h.relay.hostID}`;
 try {
  await createDesk.openCreation(machineID, "", "c1");
  // The readiness wait is the behaviour: it settles SHELL_READY_MS after the busy answer, the held
  // probe included (a probe the deadline didn't end would hold it past this test's time limit).
  const result = await createDesk.createAgent("c1", "", "omp");
  expect(result.phase).toBe("failed");
  expect(h.called("pane.close").map(c => c.params)).toEqual([{ pane_id: "p8" }]);
 } finally { desk.disconnectOwner(); h.relay.stop(); }
});
