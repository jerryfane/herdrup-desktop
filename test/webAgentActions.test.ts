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
import { MemoryGrantStore, MemoryOwnerHint, localRecord, type LocalRecord } from "../src/web/storage";
import { applyEdit, folderName, GROUPS_CONFLICT_MESSAGE, OwnerGroups } from "../src/web/groups";
import { currentOwnerLink, OWNER_REFUSED, OwnerRefusedError } from "../src/web/ownerLink";
import { showMenu } from "../src/web/menu";
import { ompHarness } from "../src/topicsModel";
import { SHEET_STALE, sheetFailure, SheetStaleError, SheetSupersededError, topicsSwitch, transferSheetOpening } from "../src/agentActionsModel";
import { openSheet, type SheetOpening } from "../src/sheetOpening";
import {
 agentActionsDesk, agentRowMenu, avatarParams, avatarProblem, closeAgent, folderItems, folderRowMenu, openSheets, sessionTransfer, sheetChosen, topicsSwitchProblem,
 type ActionAgent, type MenuItem, type SheetKind,
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

test("a transfer needs the host's flag; then an unfinished one offers its own target, a finished one the other harnesses", () => {
 const transfers = { agent_session_transfer: true };
 const moving = agent({ agent: "claude", session_transfer: { phase: "ready", source: "codex", target: "omp" } });
 expect(sessionTransfer(moving, null)).toBeNull();
 expect(sessionTransfer(moving, transfers)).toEqual({ source: "codex", targets: ["omp"] });
 const done = agent({ agent: "claude", session_transfer: { phase: "completed", source: "codex", target: "omp" } });
 // A host predating the harness list transfers between Claude Code and Codex.
 expect(sessionTransfer(done, transfers)).toEqual({ source: "claude", targets: ["codex"] });
 expect(sessionTransfer(agent({ agent: "omp" }), transfers)).toBeNull();
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

test("a new folder opens on this browser at once, and is kept open once the host saved it", async () => {
 const saved = Promise.withResolvers<unknown>();
 const s = store([() => saved.promise]);
 await s.g.refresh();
 s.g.createFolder("  Ship it ", "relay");
 const added = s.g.document()!.folders!.at(-1)!;
 expect([added.name, added.members]).toEqual(["Ship it", ["relay"]]);
 expect(s.g.view().open).toEqual({ [added.id]: true });
 // Not stored before the host answers.
 expect(s.open.get()).toBeUndefined();
 s.g.createFolder("   ", "relay");
 saved.resolve(tagged({ ...applyEdit({ kind: "addFolder", folder: added.id, text: "Ship it", name: "relay" }, groups()), revision: 4 }));
 await s.more(1);
 expect(s.sets.length).toBe(1);
 expect(s.open.get()).toEqual({ h: [added.id] });
});

test("a new folder the host refuses (the browser still thinks it writes) leaves this browser's open folders as they were", async () => {
 const s = store([() => new HerdrAPIError("scope_denied", "this link no longer writes", {})]);
 await s.g.refresh();
 s.g.createFolder("Ship it", "relay");
 await s.more(1);
 expect(s.open.get()).toBeUndefined();
 expect(s.g.view().open).toEqual({});
 expect(s.g.document()).toEqual(groups());
 expect(s.alerts).toEqual(["Couldn't save folders: herdr: scope_denied: this link no longer writes"]);
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
 showModal() {}
 addEventListener() {}
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
  /** The warnings shown (warning.ts): title and detail. */
  warnings: () => body.children.filter((c) => c.tag === "dialog").map((d) => d.children.filter((c) => c.tag !== "div").map((c) => c.textContent)),
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
 /** The listed agents (default: listed). */
 agents?: () => unknown[];
 /** While set, a ping (or a pane.close, an accounts.list, an agent.topics.set_enabled) waits for it. */
 hold?: { ping: Promise<void> | null; close?: Promise<void> | null; accounts?: Promise<void> | null; topics?: Promise<void> | null };
 onRequest?: (req: Request) => void;
}
/** A host admitting the owner under scope (read at each admission, as a renewal's grant is),
 *  listing agents, answering ping and agent.groups.get. */
function host(scope: string | (() => string), o: HostOptions = {}): TestRelay {
 return startRelay({
  hostID: o.hostID,
  async serve(_conn, handshake) {
   const h = await handshake();
   const session: HostSession = h.reply({ ok: true, mode: "owner", grant_id: "g1", scope: typeof scope === "string" ? scope : scope(), expires_unix: 1_800_000_000, account: { deadline_unix: Math.floor(Date.now() / 1000) + 660 }, features: { owner: 2, multi_request: true } });
   const answer = (req: Request, body: object) => session.write(JSON.stringify({ id: req.id, ...body }) + "\n");
   for (;;) {
    const line = await session.readLine();
    if (line === null) return;
    const req = JSON.parse(line) as Request;
    o.seen?.push(req);
    o.onRequest?.(req);
    const other = () => answer(req, o.other?.(req) ?? { error: { code: "owner_forbidden", message: "no" } });
    if (req.method === "agent.list") answer(req, { result: { type: "agent_list", agents: o.agents?.() ?? listed } });
    else if (req.method === "ping") {
     const wait = o.hold?.ping;
     const pong = () => answer(req, { result: { type: "pong", version: "0.9.9", capabilities: o.caps ?? servedCaps } });
     if (wait) void wait.then(pong); else pong();
    } else if (req.method === "agent.groups.get") answer(req, { result: tagged(o.doc?.() ?? groups()) });
    else if (req.method === "pane.close" && o.hold?.close) void o.hold.close.then(other);
    else if (req.method === "accounts.list" && o.hold?.accounts) void o.hold.accounts.then(other);
    else if (req.method === "agent.topics.set_enabled" && o.hold?.topics) void o.hold.topics.then(other);
    else other();
   }
  },
 });
}

type Desk = ReturnType<typeof createGuestDesk>;
async function newDesk(openFolders?: LocalRecord<Record<string, string[]>>): Promise<Desk> {
 const identities = new MemoryIdentityStore();
 await identities.add(await generateIdentity());
 return createGuestDesk({ identities, grants: new MemoryGrantStore(), owner: new MemoryOwnerHint(), webSocket: (url) => new WebSocket(url), openFolders });
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
/** A sheet of kind for paneID chosen from a menu on the open link, opened as the page opens it. */
const chosen = (kind: SheetKind, paneID: string): SheetOpening => {
 let opening: SheetOpening | null = null;
 sheetChosen(currentOwnerLink()!, kind, paneID, () => { opening = openSheet(kind, paneID); });
 return opening!;
};
/** That sheet, its action begun (confirmed). */
const opened = (kind: SheetKind, paneID: string): SheetOpening => {
 const opening = chosen(kind, paneID);
 opening.start();
 return opening;
};

test("rename sends herdr's grammar and reads the folders again, which the server moved to the new name", async () => {
 const seen: Request[] = [];
 const relay = host("terminal", { seen, other: (req) => req.method === "agent.rename" ? { result: { type: "agent_info", agent: { ...listed[0], name: "ship-it" } } } : undefined });
 const desk = await linked(relay);
 try {
  const before = methods(seen, "agent.groups.get").length;
  const rename = opened("rename", "p1");
  expect(await rename.run(() => agentActionsDesk.renameAgent("p1", "  Ship It "))).toBe("ship-it");
  expect(methods(seen, "agent.rename")).toEqual([{ target: "p1", name: "ship-it" }]);
  expect(methods(seen, "agent.groups.get").length).toBe(before + 1);
  await expect(rename.run(() => agentActionsDesk.renameAgent("p1", " "))).rejects.toThrow("enter a name");
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("an older host refusing a write rejects with the browser's refusal; archive and restart send Go's params", async () => {
 const seen: Request[] = [];
 const relay = host("terminal", { seen, other: (req) => req.method === "agent.restart" ? { result: { type: "agent_info", agent: listed[0] } } : undefined });
 const desk = await linked(relay);
 try {
  await expect(agentActionsDesk.archiveAgent("p1")).rejects.toBeInstanceOf(OwnerRefusedError);
  expect(methods(seen, "agent.archive")).toEqual([{ target: "p1", reason: "user action", by: "herdrup" }]);
  const swap = opened("swap", "p1");
  await swap.run(() => agentActionsDesk.restartAgent("p1", "a2"));
  const restart = opened("restart", "p1");
  await restart.run(() => agentActionsDesk.restartAgent("p1", ""));
  // A call belongs to its own sheet: of another agent, of another kind, or outside any, it sends nothing.
  await expect(restart.run(() => agentActionsDesk.restartAgent("p2", ""))).rejects.toThrow(SHEET_STALE);
  await expect(restart.run(() => agentActionsDesk.restartAgent("p1", "a2"))).rejects.toThrow(SHEET_STALE);
  await expect(agentActionsDesk.restartAgent("p1", "")).rejects.toThrow(SHEET_STALE);
  expect(methods(seen, "agent.restart")).toEqual([{ target: "p1", account: "a2" }, { target: "p1" }]);
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("the Topics switch works on a chat-scope link whose pong offers it; folder menus there have nothing to show", async () => {
 const seen: Request[] = [];
 const relay = host("chat", { seen, other: (req) => req.method === "agent.topics.set_enabled" ? { result: { type: "agent_topics_switched", agent: listed[0], changed: true, topics_enabled: true } } : undefined });
 const desk = await linked(relay);
 try {
  const topics = opened("topics", "p1");
  expect(await topics.run(() => agentActionsDesk.topicsSetEnabled("p1", true))).toEqual({ changed: true, topicsEnabled: true });
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
  const topics = opened("topics", "p1"), transfer = opened("transfer", "p1");
  await expect(topics.run(() => agentActionsDesk.topicsSetEnabled("p1", true))).rejects.toThrow("this server has no Topics switch.");
  await expect(transfer.run(() => agentActionsDesk.prepareSessionTransfer("p1", "claude", ""))).rejects.toBeInstanceOf(ErrUnsupported);
  expect(seen.map((r) => r.method).filter((m) => m === "agent.topics.set_enabled" || m === "agent.transfer_session")).toEqual([]);
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("a session transfer is prepared, then confirmed with its id, and the agent is found again by its terminal", async () => {
 const seen: Request[] = [];
 const relay = host("terminal", { seen, other: (req) => req.method === "agent.transfer_session" ? { result: { type: "agent_info", agent: { ...listed[1], pane_id: "p9" } } } : undefined });
 const desk = await linked(relay);
 try {
  const transfer = opened("transfer", "p2");
  expect(JSON.parse(await transfer.run(() => agentActionsDesk.prepareSessionTransfer("p2", "codex", "")))).toEqual({ agent: { ...listed[1], pane_id: "p9" } });
  await transfer.run(() => agentActionsDesk.confirmSessionTransfer("p2", "codex", "a1", "x1"));
  expect(methods(seen, "agent.transfer_session")).toEqual([{ target: "p2", to: "codex" }, { target: "p2", to: "codex", account: "a1", transfer_id: "x1", confirm: true }]);
  await expect(transfer.run(() => agentActionsDesk.confirmSessionTransfer("p2", "codex", "", ""))).rejects.toThrow("no prepared transfer");
  const gone = opened("transfer", "gone");
  expect(JSON.parse(await gone.run(() => agentActionsDesk.transferAgentInfo("gone", "t2"))).pane_id).toBe("p2");
  expect(await gone.run(() => agentActionsDesk.transferAgentInfo("gone", ""))).toBe("");
  // The account picker asks its own sheet's machine (this one refuses it).
  await expect(gone.run(() => agentActionsDesk.transferAccounts())).rejects.toBeInstanceOf(OwnerRefusedError);
  expect(methods(seen, "accounts.list").length).toBe(1);
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

test("a sheet opened on one machine sends nothing once another is open; on its own machine it works", async () => {
 // Both hosts serve every sheet's request, so one that reached either would show.
 const served = (req: Request): object | undefined => {
  switch (req.method) {
   case "agent.rename": case "agent.restart": case "agent.transfer_session": return { result: { type: "agent_info", agent: listed[0] } };
   case "agent.avatar.set": return { result: { type: "agent_avatar_set" } };
   case "agent.topics.set_enabled": return { result: { type: "agent_topics_switched", agent: listed[0], changed: true, topics_enabled: true } };
   case "accounts.list": return { result: { type: "accounts_list", accounts: [] } };
   case "agent.groups.set": return { result: tagged({ ...(req.params as unknown as Groups), revision: 9 }) };
  }
  return undefined;
 };
 const caps = { ...servedCaps, agent_avatar: true };
 const seenA: Request[] = [], seenB: Request[] = [];
 const a = host("terminal", { seen: seenA, caps, other: served, hostID: "AQEBAQEBAQEBAQEBAQEBAQ" });
 const b = host("terminal", { seen: seenB, caps, other: served, hostID: "AgICAgICAgICAgICAgICAg" });
 const desk = await newDesk();
 const p = page();
 const sheets: unknown[] = [], openings: SheetOpening[] = [];
 // The page opens each sheet as its request arrives.
 const offs = [
  events.agentActionRequested.on((x) => { sheets.push(x); openings.push(openSheet(x.kind, x.paneID)); }),
  events.paneActionChosen.on((x) => { sheets.push(x); if (x.action === "avatar") openings.push(openSheet("avatar", x.paneID)); }),
  events.folderNamingRequested.on((x) => sheets.push(x)),
 ];
 const writes = (seen: Request[]) => seen.map((r) => r.method).filter((m) => ["agent.rename", "agent.restart", "agent.avatar.set", "agent.topics.set_enabled", "agent.transfer_session", "agent.groups.set"].includes(m));
 const stale = (call: Promise<unknown>) => expect(call).rejects.toThrow(SHEET_STALE);
 try {
  // A row menu's sheet (Rename here; Restart, Swap, Avatar…, Topics and Switch harness are the same).
  await open(desk, a, "terminal");
  expect(await agentActionsDesk.agentMenu("p1")).toBe(true);
  p.click("Rename");
  await settle();
  expect(sheets.length).toBe(1);
  const rename = openings[0]!;
  // The other sheets of p1, chosen on A.
  const [restart, swap, avatar, topics, transfer] = (["restart", "swap", "avatar", "topics", "transfer"] as const).map((kind) => opened(kind, "p1"));
  await open(desk, b, "terminal");
  await stale(rename.run(() => agentActionsDesk.renameAgent("p1", "x")));
  await stale(restart!.run(() => agentActionsDesk.restartAgent("p1", "")));
  await stale(swap!.run(() => agentActionsDesk.restartAgent("p1", "a1")));
  await stale(avatar!.run(() => agentActionsDesk.setAgentAvatar("p1", { kind: "default" })));
  await stale(topics!.run(() => agentActionsDesk.topicsSetEnabled("p1", true)));
  await stale(transfer!.run(() => agentActionsDesk.prepareSessionTransfer("p1", "claude", "")));
  await stale(transfer!.run(() => agentActionsDesk.confirmSessionTransfer("p1", "claude", "", "x1")));
  await stale(transfer!.run(() => agentActionsDesk.transferAgentInfo("p1", "t1")));
  await stale(transfer!.run(() => agentActionsDesk.transferAccounts()));

  // The ••• menu's Avatar… sheet, after another pane's sheet on the same machine.
  await open(desk, a, "terminal");
  expect(await agentActionsDesk.agentMenu("p2")).toBe(true);
  p.click("Rename");
  await settle();
  expect(await desk.paneMenu({ paneID: "p1", plain: false, hasSelection: false, canShare: false })).toBe(true);
  p.click("Avatar…");
  await settle();
  expect(sheets.length).toBe(3);
  const paneAvatar = openings[2]!;
  // On its own machine the ••• Avatar… sheet's picture goes there.
  paneAvatar.start();
  await paneAvatar.run(() => agentActionsDesk.setAgentAvatar("p1", { kind: "default" }));
  await open(desk, b, "terminal");
  await stale(paneAvatar.run(() => agentActionsDesk.setAgentAvatar("p1", { kind: "default" })));

  // A folder menu's name prompt.
  await open(desk, a, "terminal");
  expect(await agentActionsDesk.folderMenu("f1")).toBe(true);
  p.click("Rename");
  await settle();
  const naming = sheets[3] as FolderNaming;
  await open(desk, b, "terminal");
  await agentActionsDesk.nameFolder(naming, "Renamed");
  await settle();
  expect([writes(seenA), writes(seenB)]).toEqual([["agent.avatar.set"], []]);
  // A's accounts.list is its row menu's own (Swap); B has had no menu, so none is the sheet's.
  expect(methods(seenB, "accounts.list")).toEqual([]);

  // On its own machine the sheet's request goes there.
  expect(await agentActionsDesk.agentMenu("p1")).toBe(true);
  p.click("Rename");
  await settle();
  expect(await openings[3]!.run(() => agentActionsDesk.renameAgent("p1", "ok"))).toBe("herdr-app");
  expect([writes(seenA), writes(seenB)]).toEqual([["agent.avatar.set"], ["agent.rename"]]);
 } finally { for (const off of offs) off(); desk.disconnectOwner(); a.stop(); b.stop(); }
}, 30_000); // six link openings over a loopback relay

const p1 = (relay: TestRelay) => ({ machineID: `owner:${relay.hostID}`, session: "", paneID: "p1" });
const pane = { paneID: "p1", plain: false, hasSelection: false, canShare: true };

test("a menu offers writes as its link is once its answers are in, and drops a write chosen after the link went to chat", async () => {
 let scope = "terminal";
 const seen: Request[] = [];
 const hold: { ping: Promise<void> | null } = { ping: null };
 const pinged = { wait: Promise.withResolvers<void>() };
 const relay = host(() => scope, { seen, hold, caps: { ...servedCaps, agent_avatar: true }, agents: () => [{ ...listed[0], topics_enabled: true }, listed[1]],
  onRequest: (r) => { if (r.method === "ping" && hold.ping) pinged.wait.resolve(); } });
 const desk = await newDesk();
 const p = page();
 let streams = 0;
 /** A renewal: the next connection (a terminal stream's) is admitted under to. */
 const renew = async (to: string) => {
  scope = to;
  await desk.startTerminal("view-1", "stream-" + ++streams).catch(() => {});
  expect(currentOwnerLink()!.scope()).toBe(to);
 };
 try {
  await open(desk, relay, "terminal");
  await desk.openAgentView(p1(relay), "view-1");
  // Admitted under chat while each menu's ping is out: neither offers a write.
  for (const ask of [() => agentActionsDesk.agentMenu("p1"), () => desk.paneMenu(pane)]) {
   const release = Promise.withResolvers<void>();
   hold.ping = release.promise;
   pinged.wait = Promise.withResolvers<void>();
   const shown = ask();
   await pinged.wait.promise;
   await renew("chat");
   hold.ping = null;
   release.resolve();
   expect(await shown).toBe(true);
   expect(p.labels().filter((l) => ["Stop agent", "Rename", "Archive", "Avatar…", "Close agent", "Share with someone"].includes(l))).toEqual([]);
   await renew("terminal");
  }
  // Shown under terminal, chosen once the link went to chat: Stop agent and Close agent send nothing.
  for (const [ask, label] of [[() => agentActionsDesk.agentMenu("p1"), "Stop agent"], [() => desk.paneMenu(pane), "Close agent"]] as const) {
   expect(await ask()).toBe(true);
   await renew("chat");
   p.click(label);
   await settle();
   await renew("terminal");
  }
  expect(methods(seen, "pane.close")).toEqual([]);
 } finally { desk.disconnectOwner(); relay.stop(); }
}, 30_000); // a renewal per step over a loopback relay

test("a Close acknowledged after its agent page was mounted again is not that page's", async () => {
 const hold: { ping: Promise<void> | null; close: Promise<void> | null } = { ping: null, close: null };
 const closing = { wait: Promise.withResolvers<void>() }, relisted = { wait: Promise.withResolvers<void>() };
 let released = false;
 const relay = host("terminal", { hold, other: (r) => r.method === "pane.close" ? { result: { type: "ok" } } : undefined, onRequest: (r) => {
  if (r.method === "pane.close") closing.wait.resolve();
  if (r.method === "agent.list" && released) relisted.wait.resolve();
 } });
 const desk = await newDesk();
 const p = page();
 const chosen: unknown[] = [];
 const heard = { wait: Promise.withResolvers<void>() };
 const off = events.paneActionChosen.on((x) => { chosen.push(x); heard.wait.resolve(); });
 try {
  await open(desk, relay, "terminal");
  await desk.openAgentView(p1(relay), "view-1");
  const release = Promise.withResolvers<void>();
  hold.close = release.promise;
  expect(await desk.paneMenu(pane)).toBe(true);
  p.click("Close agent");
  await closing.wait.promise;
  await desk.openAgentView(p1(relay), "view-2");
  released = true;
  release.resolve();
  // Close relists once acknowledged; by the time that list arrives the choice was settled.
  await relisted.wait.promise;
  await settle();
  expect(chosen).toEqual([]);
  // The page it was chosen on hears it.
  hold.close = null;
  expect(await desk.paneMenu(pane)).toBe(true);
  p.click("Close agent");
  await heard.wait.promise;
  expect(chosen).toEqual([{ paneID: "p1", action: "close" }]);
 } finally { off(); desk.disconnectOwner(); relay.stop(); }
}, 30_000);

test("a Close that fails says so under the pane's row title, or its pane id once it is off the list", async () => {
 const relay = host("terminal");
 const desk = await linked(relay);
 const p = page();
 try {
  const link = currentOwnerLink();
  expect(await closeAgent(link, "p1")).toBe(false);
  expect(await closeAgent(link, "p9")).toBe(false);
  expect(p.warnings()).toEqual([["Couldn't close herdr-app", OWNER_REFUSED], ["Couldn't close p9", OWNER_REFUSED]]);
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("#377: a Switch harness sheet waiting on its lookup, then another pane's sheet and another machine, sends nothing there", async () => {
 const served = (req: Request): object | undefined => {
  if (req.method === "agent.transfer_session") return { result: { type: "agent_info", agent: listed[0] } };
  if (req.method === "accounts.list") return { result: { type: "accounts_list", accounts: [] } };
  return undefined;
 };
 const caps = { ...servedCaps, agent_session_transfer_harnesses: ["claude", "codex", "omp"] };
 const hold: { ping: Promise<void> | null; accounts: Promise<void> | null } = { ping: null, accounts: null };
 const lookup = { wait: Promise.withResolvers<void>() };
 const seenA: Request[] = [], seenB: Request[] = [];
 const a = host("terminal", { seen: seenA, caps, hold, other: served, hostID: "AQEBAQEBAQEBAQEBAQEBAQ", onRequest: (r) => { if (r.method === "accounts.list" && hold.accounts) lookup.wait.resolve(); } });
 const b = host("terminal", { seen: seenB, caps, other: served, hostID: "AgICAgICAgICAgICAgICAg" });
 const desk = await newDesk();
 const p = page();
 // The page's Switch harness sheet opens and asks for the accounts at once (agentActions.ts switchHarness).
 const asked: Promise<unknown>[] = [], transfers: SheetOpening[] = [];
 const off = events.agentActionRequested.on((x) => {
  if (x.kind !== "transfer") return;
  const own = openSheet(x.kind, x.paneID);
  transfers.push(own);
  asked.push(own.run(() => agentActionsDesk.transferAccounts()).catch((e: unknown) => e));
 });
 try {
  await open(desk, a, "terminal");
  expect(await agentActionsDesk.agentMenu("p1")).toBe(true);
  const release = Promise.withResolvers<void>();
  hold.accounts = release.promise;
  const shown = p.menu();
  p.click("Switch harness");
  await p.next(shown);
  p.click("Claude Code");
  await lookup.wait.promise;
  hold.accounts = null;
  // Rename opened for p2 and cancelled, then machine B.
  expect(await agentActionsDesk.agentMenu("p2")).toBe(true);
  p.click("Rename");
  await settle();
  await open(desk, b, "terminal");
  // A Rename on B's own p1 is another kind's sheet: it can't stand in for A's transfer.
  expect(await agentActionsDesk.agentMenu("p1")).toBe(true);
  p.click("Rename");
  await settle();
  release.resolve();
  await Promise.all(asked);
  // The sheet goes on: its agent, then prepare and confirm. All refused; B hears none of it.
  const own = transfers[0]!;
  expect(await asked[0]).toBeInstanceOf(SheetStaleError);
  await expect(own.run(() => agentActionsDesk.transferAgentInfo("p1", "t1"))).rejects.toThrow(SHEET_STALE);
  await expect(own.run(() => agentActionsDesk.prepareSessionTransfer("p1", "claude", ""))).rejects.toThrow(SHEET_STALE);
  await expect(own.run(() => agentActionsDesk.confirmSessionTransfer("p1", "claude", "", "x1"))).rejects.toThrow(SHEET_STALE);
  await expect(own.run(() => agentActionsDesk.transferAccounts())).rejects.toThrow(SHEET_STALE);
  // B's one accounts.list is its own row menu's (Swap), none the sheet's.
  expect([methods(seenB, "agent.transfer_session").length, methods(seenB, "accounts.list").length]).toEqual([0, 1]);
  expect(methods(seenA, "agent.transfer_session")).toEqual([]);
 } finally { off(); desk.disconnectOwner(); a.stop(); b.stop(); }
}, 30_000);

test("a New folder prompt submitted after another machine opened changes nothing, here or there", async () => {
 const storage = new Map<string, string>();
 const openFolders = localRecord<Record<string, string[]>>("open", () => ({ getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); } }));
 const seenA: Request[] = [], seenB: Request[] = [];
 const a = host("terminal", { seen: seenA, hostID: "AQEBAQEBAQEBAQEBAQEBAQ" });
 const savedOnB = Promise.withResolvers<void>();
 const b = host("terminal", { seen: seenB, hostID: "AgICAgICAgICAgICAgICAg", onRequest: (r) => { if (r.method === "agent.groups.set") savedOnB.resolve(); } });
 const desk = await newDesk(openFolders);
 const p = page();
 const asked: FolderNaming[] = [];
 const off = events.folderNamingRequested.on((n) => asked.push(n));
 try {
  await open(desk, a, "terminal");
  expect(await agentActionsDesk.agentMenu("p1")).toBe(true);
  const shown = p.menu();
  p.click("Move to folder");
  await p.next(shown);
  p.click("New folder…");
  await settle();
  const before = openFolders.get();
  await open(desk, b, "terminal");
  await agentActionsDesk.nameFolder(asked[0]!, "Ship it");
  await settle();
  expect(openFolders.get()).toEqual(before);
  expect([methods(seenA, "agent.groups.set"), methods(seenB, "agent.groups.set")]).toEqual([[], []]);
  // On its own machine the prompt's folder is made there.
  expect(await agentActionsDesk.agentMenu("p1")).toBe(true);
  const again = p.menu();
  p.click("Move to folder");
  await p.next(again);
  p.click("New folder…");
  await settle();
  await agentActionsDesk.nameFolder(asked[1]!, "Ship it");
  await savedOnB.promise;
  expect(methods(seenB, "agent.groups.set").length).toBe(1);
 } finally { off(); desk.disconnectOwner(); a.stop(); b.stop(); }
}, 30_000);

test("a Switch harness sheet whose lookup was held while the same sheet was chosen on another machine stops; that one goes on there", async () => {
 const served = (req: Request): object | undefined => {
  if (req.method === "agent.transfer_session") return { result: { type: "agent_info", agent: listed[0] } };
  if (req.method === "accounts.list") return { result: { type: "accounts_list", accounts: [{ id: "c1", kind: "claude", label: "Max", active: true }] } };
  return undefined;
 };
 const caps = { ...servedCaps, agent_session_transfer_harnesses: ["claude", "codex", "omp"] };
 const hold: { ping: Promise<void> | null; accounts: Promise<void> | null } = { ping: null, accounts: null };
 const lookup = { wait: Promise.withResolvers<void>() };
 const seenA: Request[] = [], seenB: Request[] = [];
 const a = host("terminal", { seen: seenA, caps, hold, other: served, hostID: "AQEBAQEBAQEBAQEBAQEBAQ", onRequest: (r) => { if (r.method === "accounts.list" && hold.accounts) lookup.wait.resolve(); } });
 const b = host("terminal", { seen: seenB, caps, other: served, hostID: "AgICAgICAgICAgICAgICAg" });
 const desk = await newDesk();
 const p = page();
 // Each Switch harness sheet opens as the page's does (agentActions.ts switchHarness), its own
 // calls counted.
 const calls: string[][] = [], sheets: SheetOpening[] = [], openings: Promise<{ accountsJSON: string; agentJSON: string } | null>[] = [];
 const off = events.agentActionRequested.on((x) => {
  if (x.kind !== "transfer") return;
  const mine: string[] = [], own = openSheet(x.kind, x.paneID);
  calls.push(mine);
  sheets.push(own);
  openings.push(transferSheetOpening(own, {
   transferAccounts: () => { mine.push("accounts"); return agentActionsDesk.transferAccounts(); },
   transferAgentInfo: (paneID, terminalID) => { mine.push("agent"); return agentActionsDesk.transferAgentInfo(paneID, terminalID); },
  }, x.paneID, x.terminalID));
 });
 const chooseClaude = async () => {
  expect(await agentActionsDesk.agentMenu("p1")).toBe(true);
  const shown = p.menu();
  p.click("Switch harness");
  await p.next(shown);
  p.click("Claude Code");
  await settle();
 };
 try {
  await open(desk, a, "terminal");
  const release = Promise.withResolvers<void>();
  // A's sheet: its account lookup held.
  expect(await agentActionsDesk.agentMenu("p1")).toBe(true);
  hold.accounts = release.promise;
  const shown = p.menu();
  p.click("Switch harness");
  await p.next(shown);
  p.click("Claude Code");
  await lookup.wait.promise;
  hold.accounts = null;
  // Machine B, the same sheet chosen there, then A's lookup answers.
  await open(desk, b, "terminal");
  await chooseClaude();
  release.resolve();
  expect(await openings[0]).toBeNull();
  expect(calls[0]).toEqual(["accounts"]);
  const onB = await openings[1];
  expect(JSON.parse(onB!.accountsJSON).accounts[0].id).toBe("c1");
  expect(JSON.parse(onB!.agentJSON).pane_id).toBe("p1");
  // B's sheet shows and goes on, there only.
  const onBSheet = sheets[1]!;
  onBSheet.start();
  await onBSheet.run(() => agentActionsDesk.prepareSessionTransfer("p1", "claude", "c1"));
  await onBSheet.run(() => agentActionsDesk.confirmSessionTransfer("p1", "claude", "c1", "x1"));
  expect(methods(seenB, "agent.transfer_session").length).toBe(2);
  expect(methods(seenA, "agent.transfer_session")).toEqual([]);
 } finally { off(); desk.disconnectOwner(); a.stop(); b.stop(); }
}, 30_000);

test("the opening lookups read any other failure as none, as the desktop does; only a stale refusal stops the sheet", async () => {
 const fails = (error: Error) => async () => { throw error; };
 const own = openSheet("transfer", "p1");
 expect(await transferSheetOpening(own, { transferAccounts: fails(new Error("refused")), transferAgentInfo: async () => "{}" }, "p1", "")).toEqual({ accountsJSON: "", agentJSON: "{}" });
 expect(await transferSheetOpening(own, { transferAccounts: async () => "{}", transferAgentInfo: fails(new SheetStaleError()) }, "p1", "")).toBeNull();
});

test("a sheet started again on the same machine supersedes the older: its answer, come late, doesn't count", async () => {
 const hold: { ping: Promise<void> | null; accounts: Promise<void> | null } = { ping: null, accounts: null };
 const lookup = { wait: Promise.withResolvers<void>() };
 const relay = host("terminal", { hold, caps: { ...servedCaps, agent_session_transfer_harnesses: ["claude", "codex", "omp"] },
  other: (r) => r.method === "accounts.list" ? { result: { type: "accounts_list", accounts: [] } } : undefined,
  onRequest: (r) => { if (r.method === "accounts.list" && hold.accounts) lookup.wait.resolve(); } });
 const desk = await linked(relay);
 try {
  const release = Promise.withResolvers<void>();
  const first = opened("transfer", "p1");
  hold.accounts = release.promise;
  const older = first.run(() => agentActionsDesk.transferAccounts());
  await lookup.wait.promise;
  hold.accounts = null;
  const second = opened("transfer", "p1");
  const newer = second.run(() => agentActionsDesk.transferAccounts());
  expect(await newer).toBe(JSON.stringify({ accounts: [] }));
  release.resolve();
  await expect(older).rejects.toBeInstanceOf(SheetSupersededError);
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("a New folder prompt submitted once the link went to chat scope changes nothing, here or there", async () => {
 let scope = "terminal";
 const storage = new Map<string, string>();
 const openFolders = localRecord<Record<string, string[]>>("open", () => ({ getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); } }));
 const seen: Request[] = [];
 const relay = host(() => scope, { seen });
 const desk = await newDesk(openFolders);
 const p = page();
 const asked: FolderNaming[] = [];
 const off = events.folderNamingRequested.on((n) => asked.push(n));
 try {
  await open(desk, relay, "terminal");
  await desk.openAgentView(p1(relay), "view-1");
  expect(await agentActionsDesk.agentMenu("p1")).toBe(true);
  const shown = p.menu();
  p.click("Move to folder");
  await p.next(shown);
  p.click("New folder…");
  await settle();
  const before = openFolders.get();
  // A renewal admits the link under chat (the next connection, a terminal stream's).
  scope = "chat";
  await desk.startTerminal("view-1", "stream-1").catch(() => {});
  expect(currentOwnerLink()!.scope()).toBe("chat");
  await agentActionsDesk.nameFolder(asked[0]!, "Ship it");
  await settle();
  expect(openFolders.get()).toEqual(before);
  expect(methods(seen, "agent.groups.set")).toEqual([]);
 } finally { off(); desk.disconnectOwner(); relay.stop(); }
}, 30_000);

test("#397: a second Topics confirmation cancelled leaves the first restart's banner to settle; one confirmed takes it over", async () => {
 const hold: { ping: Promise<void> | null; topics: Promise<void> | null } = { ping: null, topics: null };
 const asked = { wait: Promise.withResolvers<void>() };
 const switched = { result: { type: "agent_topics_switched", agent: listed[0], changed: true, topics_enabled: true } };
 const relay = host("terminal", { hold, other: (r) => r.method === "agent.topics.set_enabled" ? switched : undefined,
  onRequest: (r) => { if (r.method === "agent.topics.set_enabled" && hold.topics) asked.wait.resolve(); } });
 const other = host("terminal", { hostID: "AwMDAwMDAwMDAwMDAwMDAw" });
 const desk = await linked(relay);
 const request = { paneID: "p1", title: "herdr-app", enable: true };
 const setEnabled = (paneID: string, enable: boolean) => agentActionsDesk.topicsSetEnabled(paneID, enable);
 /** The Topics sheet as the page runs it (agentActions.ts switchTopics), its banner's statuses kept. */
 const shown: string[] = [];
 const sheet = (confirmed: boolean) => topicsSwitch(chosen("topics", "p1"), request, async () => confirmed, setEnabled,
  (s) => shown.push(s.kind === "failed" ? "failed: " + s.why : s.kind));
 const held = async () => {
  const release = Promise.withResolvers<void>();
  hold.topics = release.promise;
  asked.wait = Promise.withResolvers<void>();
  const first = sheet(true);
  await asked.wait.promise;
  hold.topics = null;
  return { first, release };
 };
 try {
  // The reviewer's sequence: the first restart held, the same confirmation reopened and cancelled.
  const one = await held();
  await sheet(false);
  one.release.resolve();
  await one.first;
  expect(shown).toEqual(["working", "done"]);
  // A second one confirmed takes the banner over; the first, answering late, says nothing.
  shown.length = 0;
  const two = await held();
  await sheet(true);
  two.release.resolve();
  await two.first;
  expect(shown).toEqual(["working", "working", "done"]);
  // Its machine gone meanwhile: the sheet's refusal.
  shown.length = 0;
  const stale = chosen("topics", "p1");
  await open(desk, other, "terminal");
  await topicsSwitch(stale, request, async () => true, setEnabled, (s) => shown.push(s.kind === "failed" ? "failed: " + s.why : s.kind));
  expect(shown).toEqual(["working", "failed: " + SHEET_STALE]);
  expect(sheetFailure(new SheetSupersededError())).toBeNull();
  expect(sheetFailure(new Error("x"))).toBe("x");
 } finally { desk.disconnectOwner(); relay.stop(); other.stop(); }
}, 30_000);

test("a sheet's record is held only while it speaks: released when it closes or is cancelled, retired when its link ends", async () => {
 const relay = host("terminal", { other: (r) => r.method === "agent.restart" ? { result: { type: "agent_info", agent: listed[0] } } : undefined });
 const other = host("terminal", { hostID: "AwMDAwMDAwMDAwMDAwMDAw" });
 const desk = await linked(relay);
 try {
  const before = openSheets();
  // Cancelled before it started: never held.
  const cancelled = chosen("rename", "p2");
  expect(openSheets()).toBe(before);
  cancelled.release();
  // A one-step sheet: held while it speaks, gone once it is released (after its step settled).
  const restart = opened("restart", "p1");
  const avatar = opened("avatar", "p1");
  expect(openSheets()).toBe(before + 2);
  const step = restart.run(() => agentActionsDesk.restartAgent("p1", ""));
  restart.release();
  expect(openSheets()).toBe(before + 2);
  await step;
  expect(openSheets()).toBe(before + 1);
  // A sheet that asks more than once (Avatar…), closed.
  avatar.release();
  expect(openSheets()).toBe(before);
  // One still open when its link ends.
  opened("avatar", "p2");
  expect(openSheets()).toBe(before + 1);
  await open(desk, other, "terminal");
  expect(openSheets()).toBe(before);
 } finally { desk.disconnectOwner(); relay.stop(); other.stop(); }
}, 30_000);

test("#396: a new folder collapsed while its save is on its way stays closed once the host has it; refused, nothing is stored", async () => {
 const saved = Promise.withResolvers<unknown>();
 const s = store([() => saved.promise, () => new HerdrAPIError("scope_denied", "this link no longer writes", {})]);
 await s.g.refresh();
 s.g.createFolder("Ship it", "relay");
 const id = s.g.document()!.folders!.at(-1)!.id;
 expect(s.g.view().open).toEqual({ [id]: true });
 s.g.setOpen(id, false);
 expect(s.g.view().open).toEqual({});
 s.g.setOpen(id, true);
 s.g.setOpen(id, false);
 saved.resolve(tagged({ ...applyEdit({ kind: "addFolder", folder: id, text: "Ship it", name: "relay" }, groups()), revision: 4 }));
 await s.more(1);
 expect(s.g.view().open).toEqual({});
 expect(s.open.get()).toBeUndefined();
 // Opened again while pending, then refused: nothing stored either.
 s.g.createFolder("Later on", "relay");
 const refused = s.g.document()!.folders!.at(-1)!.id;
 s.g.setOpen(refused, false);
 s.g.setOpen(refused, true);
 await s.more(1);
 expect([s.open.get(), s.g.view().open]).toEqual([undefined, {}]);
});
