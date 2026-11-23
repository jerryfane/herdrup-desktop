// The web owner's agent menus and actions (src/web/agentActionsDesk.ts), the folder edits queued
// in groups.ts OwnerGroups, and the ••• menu's owner items (desk.ts webPaneMenu): the menus as Go
// builds them, the edits as Go's groupsStore saves them, and the Desk methods against a local relay
// whose host answers as herdr does.
import { expect, test } from "bun:test";
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
import { OWNER_REFUSED, OwnerRefusedError } from "../src/web/ownerLink";
import {
 agentActionsDesk, agentRowMenu, avatarParams, avatarProblem, folderItems, folderRowMenu, sessionTransfer, topicsSwitchProblem,
 type ActionAgent, type MenuItem,
} from "../src/web/agentActionsDesk";
import type { Groups } from "../src/web/board";
import type { BoardUpdate } from "../src/mygo";
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

test("a chat-scope row menu keeps only a local agent's Topics switch", () => {
 const input = { info: agent({ topics_enabled: true }), caps: allCaps, groups: groups(), accounts };
 expect(shape(agentRowMenu(input, false))).toEqual(["Turn off topics"]);
 expect(agentRowMenu({ ...input, info: agent({ topics_enabled: true, machine_id: "m2" }) }, false)).toEqual([]);
 expect(agentRowMenu({ ...input, info: agent({ agent: "claude" }) }, false)).toEqual([]);
});

test("an unfinished transfer offers only its own target, even once the host stopped advertising transfers", () => {
 const moving = agent({ agent: "claude", session_transfer: { phase: "ready", source: "codex", target: "omp" } });
 expect(sessionTransfer(moving, null)).toEqual({ source: "codex", targets: ["omp"], active: true });
 expect(shape(agentRowMenu({ info: moving, caps: null, groups: null, accounts: [] }, true))).toContainEqual({ "Switch to Oh My Pi": ["Oh My Pi"] });
 const done = agent({ agent: "claude", session_transfer: { phase: "completed", source: "codex", target: "omp" } });
 // A host predating the harness list transfers between Claude Code and Codex.
 expect(sessionTransfer(done, { agent_session_transfer: true }).targets).toEqual(["codex"]);
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

const signal = new AbortController().signal;
const tagged = (g: Groups) => ({ type: "agent_groups", ...g });
function store(answers: ((params: Record<string, unknown>) => unknown)[]) {
 const sets: Record<string, unknown>[] = [], alerts: string[] = [];
 let changes = 0, get = true;
 const waits: { at: number; resolve: () => void }[] = [];
 const client = { async call(method: string, params: Record<string, unknown>) {
  if (method === "agent.groups.get" && get) { get = false; return tagged(groups()); }
  sets.push(params);
  const a = answers.shift()!(params);
  if (a instanceof Error) throw a;
  return a;
 } };
 const storage = new Map<string, string>();
 const open = localRecord<Record<string, string[]>>("open", () => ({ getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); } }));
 const g = new OwnerGroups(client as never, "h", () => { changes++; for (const w of waits) if (changes >= w.at) w.resolve(); }, Date.now, open, (m) => alerts.push(m));
 /** Resolves once the list changed k more times (each saved edit is one, after its alert). */
 const more = (k: number) => { const { promise, resolve } = Promise.withResolvers<void>(); waits.push({ at: changes + k, resolve }); return promise; };
 return { g, sets, alerts, open, more, changes: () => changes };
}
const conflict = (current: Groups) => new HerdrAPIError("groups_conflict", "stale", { code: "groups_conflict", message: "stale", current: tagged(current) });

test("an edit shows at once and is saved on the document it was made on", async () => {
 const s = store([(p) => tagged({ ...p, revision: 4 } as Groups)]);
 await s.g.refresh(signal);
 s.g.apply({ kind: "setStar", name: "relay", star: true }, signal);
 expect(s.g.view().groups?.stars).toEqual(["herdr-app", "relay"]);
 await s.more(1);
 expect(s.sets).toEqual([{ revision: 3, stars: ["herdr-app", "relay"], folders: [{ id: "f2", name: "Later", order: 1, members: [] }, { id: "f1", name: "Build", order: 0, members: ["herdr-app"] }] }]);
 expect(s.g.document()?.revision).toBe(4);
 expect(s.alerts).toEqual([]);
});

test("a conflict replays the edit on the stored document; a second one drops it and says so", async () => {
 const stored = { ...groups(), revision: 9, stars: ["other"] };
 const s = store([() => conflict(stored), (p) => tagged({ ...(p as Groups), revision: 10 })]);
 await s.g.refresh(signal);
 s.g.apply({ kind: "setStar", name: "relay", star: true }, signal);
 await s.more(1);
 expect(s.sets.map((p) => [p.revision, p.stars])).toEqual([[3, ["herdr-app", "relay"]], [9, ["other", "relay"]]]);
 expect(s.g.document()?.stars).toEqual(["other", "relay"]);

 const t = store([() => conflict(stored), () => conflict({ ...stored, revision: 11 })]);
 await t.g.refresh(signal);
 t.g.apply({ kind: "setStar", name: "relay", star: true }, signal);
 await t.more(1);
 expect(t.alerts).toEqual([GROUPS_CONFLICT_MESSAGE]);
 expect(t.g.document()).toEqual({ ...stored, revision: 11 });
});

test("a refused write keeps the folders and says why; a host without folders turns them off", async () => {
 const s = store([() => new HerdrAPIError("owner_forbidden", "no", {}), () => new HerdrAPIError("invalid_groups", "too many", {})]);
 await s.g.refresh(signal);
 s.g.apply({ kind: "deleteFolder", folder: "f1" }, signal);
 s.g.apply({ kind: "renameFolder", folder: "f2", text: "Soon" }, signal);
 await s.more(2);
 expect(s.alerts).toEqual(["Couldn't save folders: " + OWNER_REFUSED, "The server refused the change: too many"]);
 expect(s.g.document()).toEqual(groups());

 const off = store([() => new ErrUnsupported("agent.groups.set", "agent_groups", "")]);
 await off.g.refresh(signal);
 off.g.apply({ kind: "deleteFolder", folder: "f1" }, signal);
 await off.more(1);
 expect([off.g.document(), off.alerts]).toEqual([null, []]);
});

test("an edit that changes nothing is not sent, and nothing is queued before the document loaded", async () => {
 const s = store([]);
 s.g.apply({ kind: "setStar", name: "relay", star: true }, signal);
 expect(s.changes()).toBe(0);
 await s.g.refresh(signal);
 s.g.apply({ kind: "setStar", name: "herdr-app", star: true }, signal);
 await s.more(1);
 expect(s.sets).toEqual([]);
});

test("a forced read waits while an edit is unsent, so it can't undo it on screen", async () => {
 const saved = Promise.withResolvers<unknown>();
 const s = store([() => saved.promise]);
 await s.g.refresh(signal);
 s.g.apply({ kind: "setStar", name: "relay", star: true }, signal);
 await s.g.refresh(signal, true);
 expect(s.sets.length).toBe(1);
 expect(s.g.document()?.stars).toEqual(["herdr-app", "relay"]);
 saved.resolve(tagged({ ...groups(), revision: 4, stars: ["herdr-app", "relay"] }));
 await s.more(1);
});

test("a new folder opens on this browser and takes its agent", async () => {
 const s = store([(p) => tagged({ ...(p as Groups), revision: 4 })]);
 await s.g.refresh(signal);
 s.g.createFolder("  Ship it ", "relay", signal);
 const added = s.g.document()!.folders!.at(-1)!;
 expect([added.name, added.members]).toEqual(["Ship it", ["relay"]]);
 expect(s.g.view().open).toEqual({ [added.id]: true });
 s.g.createFolder("   ", "relay", signal);
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

// ---- The Desk methods on an owner link ----

type Request = { id: string; method: string; params: Record<string, unknown> };
const statements: StatementSource = { get: async () => ({ jws: "jws", expMs: Date.now() + 600_000 }), drop() {} };
const listed = [{ pane_id: "p1", terminal_id: "t1", name: "herdr-app", agent: "omp" }, { pane_id: "p2", terminal_id: "t2", name: "relay", agent: "claude" }, { pane_id: "p3", terminal_id: "", name: "old" }];

/** A host admitting the owner under scope, listing agents, answering ping and agent.groups.get,
 *  and anything else as other says (owner_forbidden by default). */
function host(scope: string, other: (req: Request) => object | undefined = () => undefined, seen: Request[] = []): TestRelay {
 return startRelay({
  async serve(_conn, handshake) {
   const h = await handshake();
   const session: HostSession = h.reply({ ok: true, mode: "owner", grant_id: "g1", scope, expires_unix: 1_800_000_000, account: { deadline_unix: Math.floor(Date.now() / 1000) + 660 }, features: { owner: 2, multi_request: true } });
   const answer = (req: Request, body: object) => session.write(JSON.stringify({ id: req.id, ...body }) + "\n");
   for (;;) {
    const line = await session.readLine();
    if (line === null) return;
    const req = JSON.parse(line) as Request;
    seen.push(req);
    if (req.method === "agent.list") answer(req, { result: { type: "agent_list", agents: listed } });
    else if (req.method === "ping") answer(req, { result: { type: "pong", version: "0.9.9", capabilities: { agent_groups: true, agent_topics_switch: true, agent_session_transfer: true } } });
    else if (req.method === "agent.groups.get") answer(req, { result: tagged(groups()) });
    else answer(req, other(req) ?? { error: { code: "owner_forbidden", message: "no" } });
   }
  },
 });
}

async function linked(relay: TestRelay) {
 const identities = new MemoryIdentityStore();
 await identities.add(await generateIdentity());
 const desk = createGuestDesk({ identities, grants: new MemoryGrantStore(), owner: new MemoryOwnerHint(), webSocket: (url) => new WebSocket(url) });
 const board = Promise.withResolvers<BoardUpdate>();
 // The first board with the folders loaded (Later, with no agent listed, is an empty folder).
 const off = events.boardChanged.on((b) => { if (b?.machineID === `owner:${relay.hostID}` && b.board.emptyFolders.length > 0) { off(); board.resolve(b); } });
 const m: EnvelopeMachine = { hostItemID: "H1", label: "dev2306", relay: relay.url, hostID: relay.hostID, nodePub: toB64url(relay.hostPublic), grantID: "g1", scope: "chat", expiresUnix: 1_800_000_000 };
 await desk.connectOwner(m, statements, "x", new AbortController().signal);
 await board.promise;
 return desk;
}
const methods = (seen: Request[], name: string) => seen.filter((r) => r.method === name).map((r) => r.params);

test("rename sends herdr's grammar and reads the folders again, which the server moved to the new name", async () => {
 const seen: Request[] = [];
 const relay = host("terminal", (req) => req.method === "agent.rename" ? { result: { type: "agent_info", agent: { ...listed[0], name: "ship-it" } } } : undefined, seen);
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
 const relay = host("terminal", (req) => req.method === "agent.restart" ? { result: { type: "agent_info", agent: listed[0] } } : undefined, seen);
 const desk = await linked(relay);
 try {
  await expect(agentActionsDesk.archiveAgent("p1")).rejects.toBeInstanceOf(OwnerRefusedError);
  expect(methods(seen, "agent.archive")).toEqual([{ target: "p1", reason: "user action", by: "herdrup" }]);
  await agentActionsDesk.restartAgent("p1", "a2");
  await agentActionsDesk.restartAgent("p1", "");
  expect(methods(seen, "agent.restart")).toEqual([{ target: "p1", account: "a2" }, { target: "p1" }]);
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("the Topics switch works on a chat-scope link; folder menus there have nothing to show", async () => {
 const seen: Request[] = [];
 const relay = host("chat", (req) => req.method === "agent.topics.set_enabled" ? { result: { type: "agent_topics_switched", agent: listed[0], changed: true, topics_enabled: true } } : undefined, seen);
 const desk = await linked(relay);
 try {
  expect(await agentActionsDesk.topicsSetEnabled("p1", true)).toEqual({ changed: true, topicsEnabled: true });
  expect(methods(seen, "agent.topics.set_enabled")).toEqual([{ target: "p1", enabled: true }]);
  expect(await agentActionsDesk.folderMenu("f1")).toBe(false);
  // herdr-app is omp but its list says nothing of topics: no item, no menu.
  expect(await agentActionsDesk.agentMenu("p1")).toBe(false);
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("a session transfer is prepared, then confirmed with its id, and the agent is found again by its terminal", async () => {
 const seen: Request[] = [];
 const relay = host("terminal", (req) => req.method === "agent.transfer_session" ? { result: { type: "agent_info", agent: { ...listed[1], pane_id: "p9" } } } : undefined, seen);
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
