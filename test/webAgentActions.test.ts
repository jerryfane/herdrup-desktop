// The web owner's agent menus and actions (src/web/agentActionsDesk.ts), the folder edits queued
// in groups.ts OwnerGroups, and the ••• menu's owner items (desk.ts webPaneMenu): the menus as Go
// builds them, the edits as Go's groupsStore saves them, and the Desk methods against a local relay
// whose host answers as herdr does. The menus themselves run in a small stand-in document.
import { afterEach, expect, test } from "bun:test";
import { generateIdentity, MemoryIdentityStore } from "../src/webguest/identity";
import { toB64url } from "../src/webguest/b64url";
import { HerdrAPIError } from "../src/webguest/errors";
import type { EnvelopeMachine } from "../src/webguest/approve";
import type { StatementSource } from "../src/webguest/owner";
import { createGuestDesk, webPaneMenu } from "../src/web/desk";
import { events } from "../src/web/events";
import { ErrUnsupported } from "../src/web/engine";
import { MemoryGrantStore, MemoryOwnerHint, localRecord } from "../src/web/storage";
import { applyEdit, folderName, GROUPS_CONFLICT_MESSAGE, OwnerGroups } from "../src/web/groups";
import { currentOwnerLink, OWNER_REFUSED, OwnerRefusedError } from "../src/web/ownerLink";
import { showMenu } from "../src/web/menu";
import { ompHarness } from "../src/topicsModel";
import {
 agentActionsDesk, agentRowMenu, avatarParams, avatarProblem, closeAgent, folderItems, folderRowMenu, sessionTransfer, topicsSwitchProblem,
 type ActionAgent, type MenuItem,
} from "../src/web/agentActionsDesk";
import { orderedFolders, type Groups } from "../src/web/board";
import type { BoardUpdate, FolderNaming } from "../src/mygo";
import { startRelay, type HostSession, type TestRelay } from "./webguestResponder";

// ---- The menus ----

const groups = (): Groups => ({ revision: 3, stars: ["herdr-app"], folders: [
 { id: "f2", name: "Later", order: 1, members: [] },
 { id: "f1", name: "Build", order: 0, members: ["herdr-app"] },
] });
const shape = (items: MenuItem[]): unknown[] => items.map((e) => e.sub ? { [e.label]: shape(e.sub) } : e.label);
const agent = (over: Partial<ActionAgent> = {}): ActionAgent => ({ pane_id: "p1", terminal_id: "t1", name: "herdr-app", agent: "omp", account: "a1", ...over });
const accounts = [
 { id: "a1", kind: "omp", label: "Work", active: true },
 { id: "a2", kind: "omp", label: "Home", active: false },
 { id: "a3", kind: "claude", label: "Other", active: true },
];
const allCaps = { agent_avatar: true, agent_topics_switch: true, agent_session_transfer: true, agent_session_transfer_harnesses: ["claude", "codex", "omp", "cursor"] };

test("a terminal-scope row menu is Go's, in herdrup's order: the folder items, the Topics switch, transfer and swap", () => {
 const menu = agentRowMenu({ info: agent({ topics_enabled: false }), caps: allCaps, groups: groups(), accounts }, true);
 expect(shape(menu)).toEqual([
  "Stop agent", "Rename", "Avatar…", "Unstar", { "Move to folder": ["Later", "New folder…", "Remove from Build"] }, "Restart agent", "Turn on topics",
  { "Switch harness": ["Claude Code", "Codex"] }, { "Swap subscription": ["Work (current)", "Home (exhausted)"] }, "Archive",
 ]);
 const topics = menu.find((e) => e.action?.kind === "topics")!.action!;
 expect([topics.enable, topics.title, topics.terminalID]).toEqual([true, "herdr-app", "t1"]);
 const swap = menu.find((e) => e.label === "Swap subscription")!.sub![1]!.action!;
 expect([swap.kind, swap.account]).toEqual(["swap", { id: "a2", label: "Home" }]);
 const transfer = menu.find((e) => e.label === "Switch harness")!.sub![0]!.action!;
 expect([transfer.source, transfer.target]).toEqual(["omp", { id: "claude", displayName: "Claude Code" }]);
});

test("without the host's capabilities, folders or a name the row menu has only what needs none", () => {
 expect(shape(agentRowMenu({ info: agent({ name: null, topics_enabled: true }), caps: null, groups: groups(), accounts: [] }, true)))
  .toEqual(["Stop agent", "Rename", "Restart agent", "Archive"]);
 // Topics on, a remote agent: no transfer; one other harness reads "Switch to".
 const remote = agentRowMenu({ info: agent({ topics_enabled: true, machine_id: "m2" }), caps: allCaps, groups: null, accounts: [] }, true);
 expect(shape(remote)).toEqual(["Stop agent", "Rename", "Avatar…", "Restart agent", "Turn off topics", "Archive"]);
 const one = agentRowMenu({ info: agent({ agent: "claude" }), caps: { agent_session_transfer: true }, groups: null, accounts: [] }, true);
 expect(shape(one)).toContainEqual({ "Switch to Codex": ["Codex"] });
});

test("an owner pong without the Topics switch or transfers (herdr#510's gate) hides both, even for a transfer under way", () => {
 const moving = agent({ topics_enabled: true, session_transfer: { phase: "ready", source: "omp", target: "claude" } });
 const pong = { agent_avatar: true, agent_groups: true };
 expect(shape(agentRowMenu({ info: moving, caps: pong, groups: null, accounts: [] }, true))).toEqual(["Stop agent", "Rename", "Avatar…", "Restart agent", "Archive"]);
 expect(agentRowMenu({ info: moving, caps: pong, groups: null, accounts: [] }, false)).toEqual([]);
 expect(shape(agentRowMenu({ info: moving, caps: { agent_session_transfer: true }, groups: null, accounts: [] }, true))).toContainEqual({ "Switch to Claude Code": ["Claude Code"] });
});

test("a chat-scope row menu keeps only a local agent's Topics switch", () => {
 const input = { info: agent({ topics_enabled: true }), caps: allCaps, groups: groups(), accounts };
 expect(shape(agentRowMenu(input, false))).toEqual(["Turn off topics"]);
 expect(agentRowMenu({ ...input, info: agent({ topics_enabled: true, machine_id: "m2" }) }, false)).toEqual([]);
 expect(agentRowMenu({ ...input, info: agent({ agent: "claude" }) }, false)).toEqual([]);
});

test("an unfinished transfer offers only its own target; a finished one, the other harnesses", () => {
 const moving = agent({ agent: "claude", session_transfer: { phase: "ready", source: "codex", target: "omp" } });
 expect(sessionTransfer(moving, null)).toEqual({ source: "codex", targets: ["omp"], active: true });
 const done = agent({ agent: "claude", session_transfer: { phase: "completed", source: "codex", target: "omp" } });
 // A host predating the harness list transfers between Claude Code and Codex.
 expect(sessionTransfer(done, { agent_session_transfer: true }).targets).toEqual(["codex"]);
});

test("omp is omp plain or a named build, as Go's ompHarness says", () => {
 expect(["omp", "OMP", "omp-dev", "omp 18.2", "ompx", "claude", ""].map(ompHarness)).toEqual([true, true, true, true, false, false, false]);
});

test("folders are in display order: by order, then by their place in the document", () => {
 const g: Groups = { revision: 1, stars: [], folders: [{ id: "b", name: "B", order: 1 }, { id: "a", name: "A", order: 0 }, { id: "c", name: "C", order: 1 }] };
 expect(orderedFolders(g).map((f) => f.id)).toEqual(["a", "b", "c"]);
});

test("an agent's folder items: Star for an unstarred agent, every folder to move into", () => {
 const items = folderItems(groups(), "relay");
 expect(shape(items)).toEqual(["Star", { "Move to folder": ["Build", "Later", "New folder…"] }]);
 expect(items[0]!.edit).toEqual({ kind: "setStar", name: "relay", star: true });
 expect(items[1]!.sub![2]!.naming).toEqual({ kind: "new", folder: "", member: "relay", name: "" });
 expect(folderItems(null, "relay")).toEqual([]);
});

test("a folder row's menu moves it only where it can go", () => {
 expect(shape(folderRowMenu(groups(), "f1"))).toEqual(["Rename", "Move down", "Delete folder"]);
 expect(shape(folderRowMenu(groups(), "f2"))).toEqual(["Rename", "Move up", "Delete folder"]);
 expect(folderRowMenu(groups(), "f1")[0]!.naming).toEqual({ kind: "rename", folder: "f1", member: "", name: "Build" });
 expect(folderRowMenu(groups(), "gone")).toEqual([]);
});

test("the ••• menu: Share when the page offers it, Avatar… and Close agent when the link writes, around Mute", () => {
 const o = { paneID: "p1", plain: false, hasSelection: false, canShare: true };
 const tail = (m: { label: string }[]) => m.slice(9).map((e) => e.label);
 expect(tail(webPaneMenu(o, false, { avatar: true, close: true }))).toEqual(["Share with someone", "Avatar…", "Mute notifications", "Close agent"]);
 expect(tail(webPaneMenu({ ...o, canShare: false }, true))).toEqual(["Unmute notifications"]);
 expect(webPaneMenu(o, null, { avatar: true, close: true }).length).toBe(8);
});

// ---- The document's edits (folders.go) ----

test("edits apply as Go's: idempotent stars, a move out of the old folder, a new folder last, folders swapped", () => {
 const g = groups();
 expect(applyEdit({ kind: "setStar", name: "herdr-app", star: true }, g).stars).toEqual(["herdr-app"]);
 const moved = applyEdit({ kind: "move", name: "herdr-app", folder: "f2" }, g);
 expect(moved.folders!.map((f) => f.members)).toEqual([["herdr-app"], []]);
 expect(applyEdit({ kind: "move", name: "herdr-app", folder: "gone" }, g)).toEqual(g);
 const added = applyEdit({ kind: "addFolder", folder: "f3", text: "New", name: "herdr-app" }, g);
 expect(added.folders!.at(-1)).toEqual({ id: "f3", name: "New", order: 2, members: ["herdr-app"] });
 expect(applyEdit({ kind: "moveFolder", folder: "f2", by: -1 }, g).folders!.map((f) => [f.id, f.order])).toEqual([["f2", 0], ["f1", 1]]);
 expect(applyEdit({ kind: "moveFolder", folder: "f1", by: -1 }, g).folders).toEqual(g.folders);
 expect(g).toEqual(groups());
});

test("a folder name is trimmed as Go trims it and cut at 64 characters", () => {
 expect(folderName("\u0085 Build\u00a0")).toBe("Build");
 expect(folderName(" " + "🐑".repeat(70))).toBe("🐑".repeat(64));
});

// ---- The edit queue (desk_groups.go groupsStore) ----

const tagged = (g: Groups) => ({ type: "agent_groups", ...g });
function store(answers: ((params: Record<string, unknown>) => unknown)[], signal = new AbortController().signal) {
 const sets: Record<string, unknown>[] = [], alerts: string[] = [], signals: (AbortSignal | undefined)[] = [];
 let changes = 0, get = true;
 const waits: { at: number; resolve: () => void }[] = [];
 const client = { async call(method: string, params: Record<string, unknown>, _tag: string, _capability: string, s?: AbortSignal) {
  signals.push(s);
  if (method === "agent.groups.get" && get) { get = false; return tagged(groups()); }
  sets.push(params);
  const a = answers.shift()!(params);
  if (a instanceof Error) throw a;
  return a;
 } };
 const storage = new Map<string, string>();
 const open = localRecord<Record<string, string[]>>("open", () => ({ getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); } }));
 const g = new OwnerGroups(client as never, "h", signal, () => { changes++; for (const w of waits) if (changes >= w.at) w.resolve(); }, Date.now, open, (m) => alerts.push(m));
 /** Resolves once the list changed k more times (each saved edit is one, after its alert). */
 const more = (k: number) => { const { promise, resolve } = Promise.withResolvers<void>(); waits.push({ at: changes + k, resolve }); return promise; };
 return { g, sets, alerts, signals, open, more, changes: () => changes };
}
const conflict = (current: Groups) => new HerdrAPIError("groups_conflict", "stale", { code: "groups_conflict", message: "stale", current: tagged(current) });

test("an edit shows at once and is saved on the document it was made on", async () => {
 const s = store([(p) => tagged({ ...p, revision: 4 } as Groups)]);
 await s.g.refresh();
 s.g.apply({ kind: "setStar", name: "relay", star: true });
 expect(s.g.view().groups?.stars).toEqual(["herdr-app", "relay"]);
 await s.more(1);
 expect(s.sets).toEqual([{ revision: 3, stars: ["herdr-app", "relay"], folders: [{ id: "f2", name: "Later", order: 1, members: [] }, { id: "f1", name: "Build", order: 0, members: ["herdr-app"] }] }]);
 expect(s.g.document()?.revision).toBe(4);
 expect(s.alerts).toEqual([]);
});

test("the queue reads and saves with its link's lifetime, and says nothing once that link ended", async () => {
 const life = new AbortController();
 const s = store([() => { life.abort(); return new Error("aborted"); }], life.signal);
 await s.g.refresh();
 s.g.apply({ kind: "setStar", name: "relay", star: true });
 await s.more(1);
 expect(s.signals).toEqual([life.signal, life.signal]);
 expect(s.alerts).toEqual([]);
});

test("a conflict replays the edit on the stored document; a second one drops it and says so", async () => {
 const stored = { ...groups(), revision: 9, stars: ["other"] };
 const s = store([() => conflict(stored), (p) => tagged({ ...(p as Groups), revision: 10 })]);
 await s.g.refresh();
 s.g.apply({ kind: "setStar", name: "relay", star: true });
 await s.more(1);
 expect(s.sets.map((p) => [p.revision, p.stars])).toEqual([[3, ["herdr-app", "relay"]], [9, ["other", "relay"]]]);
 expect(s.g.document()?.stars).toEqual(["other", "relay"]);

 const t = store([() => conflict(stored), () => conflict({ ...stored, revision: 11 })]);
 await t.g.refresh();
 t.g.apply({ kind: "setStar", name: "relay", star: true });
 await t.more(1);
 expect(t.alerts).toEqual([GROUPS_CONFLICT_MESSAGE]);
 expect(t.g.document()).toEqual({ ...stored, revision: 11 });
});

test("a refused write keeps the folders and says why; a host without folders turns them off", async () => {
 const s = store([() => new HerdrAPIError("owner_forbidden", "no", {}), () => new HerdrAPIError("invalid_groups", "too many", {})]);
 await s.g.refresh();
 s.g.apply({ kind: "deleteFolder", folder: "f1" });
 s.g.apply({ kind: "renameFolder", folder: "f2", text: "Soon" });
 await s.more(2);
 expect(s.alerts).toEqual(["Couldn't save folders: " + OWNER_REFUSED, "The server refused the change: too many"]);
 expect(s.g.document()).toEqual(groups());

 const off = store([() => new ErrUnsupported("agent.groups.set", "agent_groups", "")]);
 await off.g.refresh();
 off.g.apply({ kind: "deleteFolder", folder: "f1" });
 await off.more(1);
 expect([off.g.document(), off.alerts]).toEqual([null, []]);
});

test("an edit that changes nothing is not sent, and nothing is queued before the document loaded", async () => {
 const s = store([]);
 s.g.apply({ kind: "setStar", name: "relay", star: true });
 expect(s.changes()).toBe(0);
 await s.g.refresh();
 s.g.apply({ kind: "setStar", name: "herdr-app", star: true });
 await s.more(1);
 expect(s.sets).toEqual([]);
});

test("a forced read waits while an edit is unsent, so it can't undo it on screen", async () => {
 const saved = Promise.withResolvers<unknown>();
 const s = store([() => saved.promise]);
 await s.g.refresh();
 s.g.apply({ kind: "setStar", name: "relay", star: true });
 await s.g.refresh(true);
 expect(s.sets.length).toBe(1);
 expect(s.g.document()?.stars).toEqual(["herdr-app", "relay"]);
 saved.resolve(tagged({ ...groups(), revision: 4, stars: ["herdr-app", "relay"] }));
 await s.more(1);
});

test("a new folder opens on this browser and takes its agent", async () => {
 const s = store([(p) => tagged({ ...(p as Groups), revision: 4 })]);
 await s.g.refresh();
 s.g.createFolder("  Ship it ", "relay");
 const added = s.g.document()!.folders!.at(-1)!;
 expect([added.name, added.members]).toEqual(["Ship it", ["relay"]]);
 expect(s.g.view().open).toEqual({ [added.id]: true });
 s.g.createFolder("   ", "relay");
 await s.more(1);
 expect(s.sets.length).toBe(1);
});

// ---- Errors as the desktop words them ----

test("pictures and the Topics switch fail in the desktop's words; a refused browser says so", () => {
 expect(avatarParams({ kind: "default" })).toEqual({ avatar: null });
 expect(avatarParams({ kind: "image", imageBase64: "AA", mime: "image/png" })).toEqual({ avatar: { style: "image" }, image_base64: "AA", mime: "image/png" });
 expect(() => avatarParams({ kind: "mascot" })).toThrow("no mascot chosen");
 expect(String(avatarProblem(new HerdrAPIError("avatar_too_large", "x", {})))).toBe("Error: the photo is too large.");
 expect(avatarProblem(new OwnerRefusedError("agent.avatar.set"))).toBeInstanceOf(OwnerRefusedError);
 expect(topicsSwitchProblem(new HerdrAPIError("not_omp", "x", {}))).toBe("only omp agents have topics.");
 expect(topicsSwitchProblem(new OwnerRefusedError("agent.topics.set_enabled"))).toBe(OWNER_REFUSED);
 expect(topicsSwitchProblem(new Error("socket closed"))).toBe("couldn't reach the server.");
});

// ---- The menus in a page: a stand-in document ----

class FakeElement {
 children: FakeElement[] = [];
 parent: FakeElement | null = null;
 className = ""; textContent = ""; type = ""; disabled = false;
 onclick: (() => void) | null = null;
 style: Record<string, string> = {};
 constructor(readonly tag: string) {}
 setAttribute() {}
 append(...nodes: FakeElement[]) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
 remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
 contains(n: unknown): boolean { return n === this || this.children.some((c) => c.contains(n)); }
 getBoundingClientRect() { return { left: 0, top: 0, bottom: 0, width: 100, height: 100 }; }
 focus() {}
}
const saved: Record<string, unknown> = {};
function page() {
 const body = new FakeElement("body");
 for (const [k, v] of Object.entries({ document: { createElement: (t: string) => new FakeElement(t), body, activeElement: null }, HTMLElement: FakeElement, innerWidth: 1000, innerHeight: 800 })) {
  if (!(k in saved)) saved[k] = (globalThis as Record<string, unknown>)[k];
  (globalThis as Record<string, unknown>)[k] = v;
 }
 const menu = () => body.children.find((c) => c.className === "web-menu");
 const items = () => (menu()?.children ?? []).filter((c) => c.tag === "button");
 return {
  menu,
  labels: () => items().map((b) => b.textContent),
  /** Clicks the nth (0-based) item labelled label. */
  click(label: string, nth = 0) { const b = items().filter((x) => x.textContent === label)[nth]; if (!b) throw new Error("no item " + label); b.onclick!(); },
  /** The next menu, once the one clicked has opened it. */
  async next(before: FakeElement | undefined) { for (let i = 0; i < 100 && (menu() === undefined || menu() === before); i++) await Promise.resolve(); return menu(); },
 };
}
afterEach(() => { for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v; for (const k of Object.keys(saved)) delete saved[k]; });

test("a menu returns the entry chosen, not the first one with its label", async () => {
 const p = page();
 const a = { label: "Build" }, b = { label: "Build" };
 const chosen = showMenu([a, b]);
 p.click("Build", 1);
 expect(await chosen).toBe(b);
});

// ---- The Desk methods on an owner link ----

type Request = { id: string; method: string; params: Record<string, unknown> };
const statements: StatementSource = { get: async () => ({ jws: "jws", expMs: Date.now() + 600_000 }), drop() {} };
const listed = [{ pane_id: "p1", terminal_id: "t1", name: "herdr-app", agent: "omp" }, { pane_id: "p2", terminal_id: "t2", name: "relay", agent: "claude" }, { pane_id: "p3", terminal_id: "", name: "old" }];
const servedCaps = { agent_groups: true, agent_topics_switch: true, agent_session_transfer: true };

interface HostOptions {
 /** Any other method (default: refused with owner_forbidden). */
 other?: (req: Request) => object | undefined;
 seen?: Request[];
 /** The pong's capabilities. */
 caps?: Record<string, unknown>;
 hostID?: string;
 doc?: () => Groups;
 /** While set, a ping waits for it. */
 hold?: { ping: Promise<void> | null };
 onRequest?: (req: Request) => void;
}
/** A host admitting the owner under scope, listing agents, answering ping and agent.groups.get. */
function host(scope: string, o: HostOptions = {}): TestRelay {
 return startRelay({
  hostID: o.hostID,
  async serve(_conn, handshake) {
   const h = await handshake();
   const session: HostSession = h.reply({ ok: true, mode: "owner", grant_id: "g1", scope, expires_unix: 1_800_000_000, account: { deadline_unix: Math.floor(Date.now() / 1000) + 660 }, features: { owner: 2, multi_request: true } });
   const answer = (req: Request, body: object) => session.write(JSON.stringify({ id: req.id, ...body }) + "\n");
   for (;;) {
    const line = await session.readLine();
    if (line === null) return;
    const req = JSON.parse(line) as Request;
    o.seen?.push(req);
    o.onRequest?.(req);
    if (req.method === "agent.list") answer(req, { result: { type: "agent_list", agents: listed } });
    else if (req.method === "ping") {
     const wait = o.hold?.ping;
     const pong = () => answer(req, { result: { type: "pong", version: "0.9.9", capabilities: o.caps ?? servedCaps } });
     if (wait) void wait.then(pong); else pong();
    } else if (req.method === "agent.groups.get") answer(req, { result: tagged(o.doc?.() ?? groups()) });
    else answer(req, o.other?.(req) ?? { error: { code: "owner_forbidden", message: "no" } });
   }
  },
 });
}

type Desk = ReturnType<typeof createGuestDesk>;
async function newDesk(): Promise<Desk> {
 const identities = new MemoryIdentityStore();
 await identities.add(await generateIdentity());
 return createGuestDesk({ identities, grants: new MemoryGrantStore(), owner: new MemoryOwnerHint(), webSocket: (url) => new WebSocket(url) });
}
/** Opens desk's owner link to relay's machine and waits for its first board with the folders. */
async function open(desk: Desk, relay: TestRelay, scope = "chat") {
 const board = Promise.withResolvers<BoardUpdate>();
 const off = events.boardChanged.on((b) => { if (b?.machineID === `owner:${relay.hostID}` && b.board.emptyFolders.length > 0) { off(); board.resolve(b); } });
 const m: EnvelopeMachine = { hostItemID: "H-" + relay.hostID, label: "dev2306", relay: relay.url, hostID: relay.hostID, nodePub: toB64url(relay.hostPublic), grantID: "g1", scope, expiresUnix: 1_800_000_000 };
 await desk.connectOwner(m, statements, "x", new AbortController().signal);
 await board.promise;
}
async function linked(relay: TestRelay) {
 const desk = await newDesk();
 await open(desk, relay);
 return desk;
}
const methods = (seen: Request[], name: string) => seen.filter((r) => r.method === name).map((r) => r.params);
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

test("rename sends herdr's grammar and reads the folders again, which the server moved to the new name", async () => {
 const seen: Request[] = [];
 const relay = host("terminal", { seen, other: (req) => req.method === "agent.rename" ? { result: { type: "agent_info", agent: { ...listed[0], name: "ship-it" } } } : undefined });
 const desk = await linked(relay);
 try {
  const before = methods(seen, "agent.groups.get").length;
  expect(await agentActionsDesk.renameAgent("p1", "  Ship It ")).toBe("ship-it");
  expect(methods(seen, "agent.rename")).toEqual([{ target: "p1", name: "ship-it" }]);
  expect(methods(seen, "agent.groups.get").length).toBe(before + 1);
  await expect(agentActionsDesk.renameAgent("p1", " ")).rejects.toThrow("enter a name");
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("an older host refusing a write rejects with the browser's refusal; archive and restart send Go's params", async () => {
 const seen: Request[] = [];
 const relay = host("terminal", { seen, other: (req) => req.method === "agent.restart" ? { result: { type: "agent_info", agent: listed[0] } } : undefined });
 const desk = await linked(relay);
 try {
  await expect(agentActionsDesk.archiveAgent("p1")).rejects.toBeInstanceOf(OwnerRefusedError);
  expect(methods(seen, "agent.archive")).toEqual([{ target: "p1", reason: "user action", by: "herdrup" }]);
  await agentActionsDesk.restartAgent("p1", "a2");
  await agentActionsDesk.restartAgent("p1", "");
  expect(methods(seen, "agent.restart")).toEqual([{ target: "p1", account: "a2" }, { target: "p1" }]);
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("the Topics switch works on a chat-scope link whose pong offers it; folder menus there have nothing to show", async () => {
 const seen: Request[] = [];
 const relay = host("chat", { seen, other: (req) => req.method === "agent.topics.set_enabled" ? { result: { type: "agent_topics_switched", agent: listed[0], changed: true, topics_enabled: true } } : undefined });
 const desk = await linked(relay);
 try {
  expect(await agentActionsDesk.topicsSetEnabled("p1", true)).toEqual({ changed: true, topicsEnabled: true });
  expect(methods(seen, "agent.topics.set_enabled")).toEqual([{ target: "p1", enabled: true }]);
  expect(await agentActionsDesk.folderMenu("f1")).toBe(false);
  // herdr-app is omp but its list says nothing of topics: no item, no menu.
  expect(await agentActionsDesk.agentMenu("p1")).toBe(false);
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("a pong without the Topics switch or transfers sends neither request", async () => {
 const seen: Request[] = [];
 const relay = host("terminal", { seen, caps: { agent_groups: true }, other: () => ({ result: { type: "agent_info", agent: listed[0] } }) });
 const desk = await linked(relay);
 try {
  await expect(agentActionsDesk.topicsSetEnabled("p1", true)).rejects.toThrow("this server has no Topics switch.");
  await expect(agentActionsDesk.prepareSessionTransfer("p1", "claude", "")).rejects.toBeInstanceOf(ErrUnsupported);
  expect(seen.map((r) => r.method).filter((m) => m === "agent.topics.set_enabled" || m === "agent.transfer_session")).toEqual([]);
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("a session transfer is prepared, then confirmed with its id, and the agent is found again by its terminal", async () => {
 const seen: Request[] = [];
 const relay = host("terminal", { seen, other: (req) => req.method === "agent.transfer_session" ? { result: { type: "agent_info", agent: { ...listed[1], pane_id: "p9" } } } : undefined });
 const desk = await linked(relay);
 try {
  expect(JSON.parse(await agentActionsDesk.prepareSessionTransfer("p2", "codex", ""))).toEqual({ agent: { ...listed[1], pane_id: "p9" } });
  await agentActionsDesk.confirmSessionTransfer("p2", "codex", "a1", "x1");
  expect(methods(seen, "agent.transfer_session")).toEqual([{ target: "p2", to: "codex" }, { target: "p2", to: "codex", account: "a1", transfer_id: "x1", confirm: true }]);
  await expect(agentActionsDesk.confirmSessionTransfer("p2", "codex", "", "")).rejects.toThrow("no prepared transfer");
  expect(JSON.parse(await agentActionsDesk.transferAgentInfo("gone", "t2")).pane_id).toBe("p2");
  expect(await agentActionsDesk.transferAgentInfo("gone", "")).toBe("");
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("folders that share a name, or are called New folder…, are each their own item", async () => {
 const seen: Request[] = [];
 let doc: Groups = { revision: 1, stars: [], folders: [
  { id: "b1", name: "Build", order: 0, members: [] }, { id: "b2", name: "Build", order: 1, members: [] }, { id: "nf", name: "New folder…", order: 2, members: [] },
 ] };
 const saved = Promise.withResolvers<void>();
 const relay = host("terminal", { seen, doc: () => doc, other: (req) => {
  if (req.method !== "agent.groups.set") return undefined;
  doc = { ...(req.params as unknown as Groups), revision: doc.revision + 1 };
  saved.resolve();
  return { result: tagged(doc) };
 } });
 const desk = await newDesk();
 await open(desk, relay, "terminal");
 const p = page();
 const named: FolderNaming[] = [];
 const off = events.folderNamingRequested.on((n) => named.push(n));
 try {
  expect(await agentActionsDesk.agentMenu("p1")).toBe(true);
  let shown = p.menu();
  p.click("Move to folder");
  shown = await p.next(shown);
  expect(p.labels()).toEqual(["Build", "Build", "New folder…", "New folder…"]);
  p.click("Build", 1);
  await saved.promise;
  expect((methods(seen, "agent.groups.set")[0]!.folders as Groups["folders"])!.map((f) => [f.id, f.members])).toEqual([["b1", []], ["b2", ["herdr-app"]], ["nf", []]]);

  expect(await agentActionsDesk.agentMenu("p1")).toBe(true);
  shown = p.menu();
  p.click("Move to folder");
  await p.next(shown);
  expect(p.labels()).toEqual(["Build", "New folder…", "New folder…", "Remove from Build"]);
  p.click("New folder…", 1);
  await settle();
  expect(named).toEqual([{ kind: "new", folder: "", member: "herdr-app", name: "" }]);
  expect(methods(seen, "agent.groups.set").length).toBe(1);
 } finally { off(); desk.disconnectOwner(); relay.stop(); }
});

test("a menu asked on one machine is not shown, nor carried out, once another machine is open", async () => {
 const seenA: Request[] = [], seenB: Request[] = [];
 const hold: { ping: Promise<void> | null } = { ping: null };
 const pinged = { wait: Promise.withResolvers<void>() };
 const a = host("terminal", { seen: seenA, hostID: "AQEBAQEBAQEBAQEBAQEBAQ", hold, onRequest: (r) => { if (r.method === "ping" && hold.ping) pinged.wait.resolve(); } });
 const b = host("terminal", { seen: seenB, hostID: "AgICAgICAgICAgICAgICAg" });
 const desk = await newDesk();
 const p = page();
 const o = { paneID: "p1", plain: false, hasSelection: false, canShare: false };
 try {
  await open(desk, a, "terminal");
  // The row menu and the ••• menu, each waiting for A's pong while B opens.
  for (const ask of [() => agentActionsDesk.agentMenu("p1"), () => desk.paneMenu(o)]) {
   const release = Promise.withResolvers<void>();
   hold.ping = release.promise;
   pinged.wait = Promise.withResolvers<void>();
   const shown = ask();
   await pinged.wait.promise;
   await open(desk, b, "terminal");
   hold.ping = null;
   release.resolve();
   expect(await shown).toBe(false);
   expect(p.menu()).toBeUndefined();
   await open(desk, a, "terminal");
  }
  // Shown on A, chosen once B is open: Rename asks for no sheet, Mute changes nothing (B has a p1 too).
  const asked: unknown[] = [];
  const offs = [events.agentActionRequested.on((x) => asked.push(x)), events.paneActionChosen.on((x) => asked.push(x))];
  for (const [ask, label] of [[() => agentActionsDesk.agentMenu("p1"), "Rename"], [() => desk.paneMenu(o), "Mute notifications"]] as const) {
   expect(await ask()).toBe(true);
   await open(desk, b, "terminal");
   p.click(label);
   await settle();
   await open(desk, a, "terminal");
  }
  for (const off of offs) off();
  expect(asked).toEqual([]);
  // A Close agent bound to A once B is open.
  const onA = currentOwnerLink();
  await open(desk, b, "terminal");
  expect(await closeAgent(onA, "p1")).toBe(false);
  expect([...methods(seenA, "pane.close"), ...methods(seenB, "pane.close")]).toEqual([]);
 } finally { desk.disconnectOwner(); a.stop(); b.stop(); }
}, 30_000); // seven link openings over a loopback relay
