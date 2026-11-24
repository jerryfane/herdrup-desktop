// The agent menus and actions on an owner link: desk_agent_actions.go (the row menu, Stop, Archive,
// Rename, Restart and Swap, the picture, the harness transfer, the failure alert), desk_groups.go's
// menus (Star, Move to folder, the folder row's) and desk_topics.go TopicsSetEnabled. The menus are
// built as Go builds them and shown with showMenu; what an item asks of the page comes back as
// Go's events (agentActionRequested, folderNamingRequested).
//
// Everything but the Topics switch writes (herdr#510), which herdr allows only on a terminal-scope
// link: a chat-scope link's row menu has the Topics switch alone (a local agent's) and folder rows
// have none. An older host refuses a write with owner_forbidden (OwnerRefusedError), shown where the
// desktop shows that action's failure. The Topics switch and Switch harness show only when the
// owner link's pong advertises agent_topics_switch / agent_session_transfer, the flags the desktop
// checks: herdr#510's owner gate serves neither yet and strips both from an owner's pong.
//
// A menu belongs to the link it was asked on: once another machine is open it is not shown, and a
// choice made in it is dropped. So does the sheet or prompt an item opens: the page opens each
// sheet with the request the menu sent (sheetOpening.ts) and makes that sheet's calls through the
// opening's own methods, which this Desk binds to the link the request was chosen on; they never
// fall back to the open link. (The sheet calls are no Desk methods of the browser's.)

import type { AgentAction, AvatarChoice, Desk as GoDesk, FolderNaming, TopicsSwitched } from "../mygo";
import { harnessDisplayName, normalizeAgentName, SheetStaleError, SheetSupersededError, transferPhaseIsConclusive } from "../agentActionsModel";
import { setSheetOpenings, SheetSelection, type SheetOpening, type SheetRequest } from "../sheetOpening";
import { ompHarness } from "../topicsModel";
import { errorText } from "../errors";
import { HerdrAPIError } from "../webguest/errors";
import { avatarTarget, displayName, isArchived, orderedFolders, trimSpace, type AgentInfo, type Groups } from "./board";
import { ErrUnsupported } from "./engine";
import { emit } from "./events";
import { folderName, folderOf, isStarred, type Edit } from "./groups";
import { showMenu } from "./menu";
import { currentOwnerLink, ownerCall, OwnerRefusedError, type OwnerLink } from "./ownerLink";
import { showWarning } from "./warning";

type DeskFns = typeof GoDesk;

/** An agent.list entry with the fields the row menu reads beyond the board's. */
export type ActionAgent = AgentInfo & {
 topics_enabled?: boolean | null;
 session_transfer?: { phase: string; source: string; target: string } | null;
};

/** herdrapi.AccountInfo, as accounts.list lists it. */
export interface AccountInfo { id: string; kind: string; label: string; active: boolean }

/** desk_groups.go menuEntry: an edit to apply, a folder name to ask for, an agent action, a
 *  submenu, or a separator. (Go draws its icons on macOS only; the page's menu has none.) */
export interface MenuItem {
 label: string;
 edit?: Edit;
 naming?: FolderNaming;
 action?: AgentAction;
 sub?: MenuItem[];
 disabled?: boolean;
 separator?: boolean;
}

/** herdrup's archive attribution (desk_agent_actions.go appArchiveActor/Reason). */
const ARCHIVE_BY = "herdrup", ARCHIVE_REASON = "user action";
const HARNESSES = ["claude", "codex", "omp"];

// ---- The menus (pure) ----

/** desk_groups.go agentMenu: an agent row's folder items, Star or Unstar, then "Move to folder"
 *  with every other folder, "New folder…", and "Remove from <folder>" when it is in one. None
 *  without folders or for an agent with no name. */
export function folderItems(g: Groups | null, name: string): MenuItem[] {
 if (g === null || name === "") return [];
 const star: MenuItem = isStarred(g, name)
  ? { label: "Unstar", edit: { kind: "setStar", name, star: false } }
  : { label: "Star", edit: { kind: "setStar", name, star: true } };
 const current = folderOf(g, name);
 const sub: MenuItem[] = orderedFolders(g).filter((f) => f.id !== current?.id)
  .map((f) => ({ label: f.name, edit: { kind: "move", name, folder: f.id } }));
 sub.push({ label: "New folder…", naming: { kind: "new", folder: "", member: name, name: "" } });
 if (current) sub.push({ label: "Remove from " + current.name, edit: { kind: "removeFromFolder", name } });
 return [star, { label: "Move to folder", sub }];
}

/** desk_groups.go folderMenu: Rename, Move up unless first, Move down unless last, Delete folder. */
export function folderRowMenu(g: Groups | null, id: string): MenuItem[] {
 if (g === null) return [];
 const ordered = orderedFolders(g);
 const i = ordered.findIndex((f) => f.id === id);
 if (i < 0) return [];
 const out: MenuItem[] = [{ label: "Rename", naming: { kind: "rename", folder: id, member: "", name: ordered[i]!.name } }];
 if (i > 0) out.push({ label: "Move up", edit: { kind: "moveFolder", folder: id, by: -1 } });
 if (i < ordered.length - 1) out.push({ label: "Move down", edit: { kind: "moveFolder", folder: id, by: 1 } });
 out.push({ label: "Delete folder", edit: { kind: "deleteFolder", folder: id } });
 return out;
}

const supported = (caps: Record<string, unknown> | null, capability: string) => caps?.[capability] === true;

/** desk_agent_actions.go transferHarnesses: none without agent_session_transfer, the known ones the
 *  host lists, or Claude Code and Codex for a host that predates the list. */
export function transferHarnesses(caps: Record<string, unknown> | null): string[] {
 if (!supported(caps, "agent_session_transfer")) return [];
 const listed = caps!.agent_session_transfer_harnesses;
 if (!Array.isArray(listed) || listed.length === 0) return ["claude", "codex"];
 return listed.filter((h): h is string => typeof h === "string" && HARNESSES.includes(h));
}

/** desk_agent_actions.go sessionTransferSource and Targets, as the browser may offer them: none
 *  unless the host's pong says agent_session_transfer (an owner link's pong reports only what its
 *  gate serves the browser, so unlike Go an unfinished transfer needs it too); then an unfinished
 *  transfer's own source and target, else the agent's native harness and every other one the host
 *  transfers between. */
export function sessionTransfer(a: ActionAgent, caps: Record<string, unknown> | null): { source: string; targets: string[] } | null {
 if (!supported(caps, "agent_session_transfer")) return null;
 const t = a.session_transfer;
 if (t && !transferPhaseIsConclusive(t.phase)) return { source: t.source, targets: [t.target] };
 const source = (a.agent ?? "").toLowerCase();
 const harnesses = transferHarnesses(caps);
 if (!harnesses.includes(source)) return null;
 return { source, targets: HARNESSES.filter((h) => h !== source && harnesses.includes(h)) };
}

export interface RowMenuInput {
 info: ActionAgent;
 /** The host's capabilities (its pong); null before one answered. */
 caps: Record<string, unknown> | null;
 /** The folders, null without them. */
 groups: Groups | null;
 /** The last accounts.list. */
 accounts: readonly AccountInfo[];
}

/** desk_agent_actions.go agentRowMenu, in herdrup's order: Stop agent, Rename, Avatar…, Star and
 *  Move to folder, Restart agent, the Topics switch, Switch harness, Swap subscription, Archive.
 *  Without writes (a chat-scope link) only the Topics switch of a local agent stays. */
export function agentRowMenu(input: RowMenuInput, writes: boolean): MenuItem[] {
 const { info: a, caps } = input;
 const action = (kind: string): AgentAction => ({ kind, paneID: a.pane_id ?? "", title: displayName(a), name: a.name ?? "", agent: a.agent ?? "", terminalID: a.terminal_id ?? "" });
 const out: MenuItem[] = [{ label: "Stop agent", action: action("stop") }, { label: "Rename", action: action("rename") }];
 if (supported(caps, "agent_avatar")) out.push({ label: "Avatar…", action: action("avatar") });
 out.push(...folderItems(input.groups, a.name ?? ""));
 out.push({ label: "Restart agent", action: action("restart") });
 const enabled = a.topics_enabled;
 if (typeof enabled === "boolean" && supported(caps, "agent_topics_switch") && ompHarness(a.agent ?? "")) {
  out.push({ label: enabled ? "Turn off topics" : "Turn on topics", action: { ...action("topics"), enable: !enabled } });
 }
 const transfer = sessionTransfer(a, caps);
 if (transfer !== null && a.machine_id == null && transfer.targets.length > 0) {
  const sub = transfer.targets.map((t): MenuItem => ({
   label: harnessDisplayName(t),
   action: { ...action("transfer"), source: transfer.source, target: { id: t, displayName: harnessDisplayName(t) } },
  }));
  out.push({ label: transfer.targets.length === 1 ? "Switch to " + harnessDisplayName(transfer.targets[0]!) : "Switch harness", sub });
 }
 // The agent's kind's accounts, the current one included and marked.
 const swap: MenuItem[] = [];
 for (const acct of input.accounts) {
  if (a.agent == null || acct.kind !== a.agent) continue;
  let label = acct.label;
  if (a.account != null && acct.id === a.account) label += " (current)";
  if (!acct.active) label += " (exhausted)";
  swap.push({ label, action: { ...action("swap"), account: { id: acct.id, label: acct.label } } });
 }
 if (swap.length > 0) out.push({ label: "Swap subscription", sub: swap });
 out.push({ label: "Archive", action: action("archive") });
 return writes ? out : out.filter((e) => e.action?.kind === "topics" && a.machine_id == null);
}

// ---- Carrying them out ----

/** The sheet an agent item opens: its kind, as its Desk calls are told apart with its agent. */
export type SheetKind = "rename" | "restart" | "swap" | "avatar" | "topics" | "transfer";

/** A menu item's choice of a sheet (sheetOpening.ts SheetSelection): the link it was chosen on,
 *  and its place among the selections (seq), the newest of a sheet winning. */
class WebSelection extends SheetSelection {
 constructor(kind: SheetKind, paneID: string, readonly link: OwnerLink, readonly seq: number) { super(kind, paneID); }
}
let selections = 0;
/** The newest selection of each agent's sheet of each kind, by kind and pane. */
const selected = new Map<string, WebSelection>();
/** The started opening that owns each agent's sheet's result, by kind and pane. */
const speaking = new Map<string, WebOpening>();
/** Links whose end retires their records. */
const watched = new WeakSet<OwnerLink>();
/** A folder name prompt's link, by its request (the prompt hands the same object back). */
const prompts = new WeakMap<FolderNaming, OwnerLink>();

function watch(link: OwnerLink) {
 if (watched.has(link)) return;
 watched.add(link);
 link.signal.addEventListener("abort", () => {
  for (const [key, opening] of speaking) if (opening.link === link) speaking.delete(key);
  for (const [key, choice] of selected) if (choice.link === link) selected.delete(key);
 }, { once: true });
}

/** One opening of a sheet (sheetOpening.ts), for the menu request it was opened with: on the link
 *  its selection was made on (none for a request without one this Desk made, or one for another
 *  sheet: every call is refused). Its calls go to that link, refused once it is no longer the open
 *  one; it never falls back to the open link. Before its dialog shows, a newer selection of the
 *  same sheet replaces it; once started (confirmed) it owns the sheet's result until a later one
 *  starts. A call whose opening lost its result ends as SheetSupersededError (whatever else is
 *  true), which the page keeps quiet about; one whose machine changed as SheetStaleError, the
 *  sheet's refusal; one replaced by a newer selection before it showed as SheetSupersededError. */
class WebOpening implements SheetOpening {
 readonly selection: WebSelection | null;
 readonly link: OwnerLink | null;
 readonly paneID: string;
 readonly key: string;
 superseded = false;
 shown = false;
 released = false;
 steps = 0;
 constructor(readonly kind: string, request: SheetRequest) {
  const s = request.sheet;
  this.selection = s instanceof WebSelection && s.kind === kind && s.paneID === request.paneID ? s : null;
  this.link = this.selection?.link ?? null;
  this.paneID = request.paneID;
  this.key = kind + "\u0000" + request.paneID;
 }
 /** A newer selection of this sheet replaced it before its dialog showed. */
 #reselected(): boolean { return !this.shown && selected.get(this.key)?.seq !== this.selection?.seq; }
 show(): boolean {
  if (this.released || this.selection === null || this.#reselected()) return false;
  this.shown = true;
  return true;
 }
 start(): void {
  if (this.link === null || this.released) return;
  const older = speaking.get(this.key);
  if (older !== undefined && older !== this) older.superseded = true;
  speaking.set(this.key, this);
  watch(this.link);
 }
 release(): void {
  this.released = true;
  if (this.selection !== null && selected.get(this.key) === this.selection) selected.delete(this.key);
  this.#settle();
 }
 /** Its record goes once it is released and nothing of it is on its way. */
 #settle(): void {
  if (this.released && this.steps === 0 && speaking.get(this.key) === this) speaking.delete(this.key);
 }
 /** One call of this sheet of kind (Switch harness's for "transfer", Restart's or Swap's for theirs). */
 async #step<T>(kind: SheetKind, call: (link: OwnerLink) => Promise<T>): Promise<T> {
  if (this.paneID === "") throw new Error("no agent");
  const link = this.link;
  if (link === null || this.kind !== kind) throw new SheetStaleError();
  const ended = () => this.superseded ? new SheetSupersededError() : link !== currentOwnerLink() ? new SheetStaleError()
   : this.#reselected() ? new SheetSupersededError() : null;
  const before = this.released ? new SheetSupersededError() : ended();
  if (before) throw before;
  this.steps++;
  try {
   let result: T;
   try { result = await call(link); } catch (error) { throw ended() ?? error; }
   const after = ended();
   if (after) throw after;
   return result;
  } finally {
   this.steps--;
   this.#settle();
  }
 }

 /** desk_agent_actions.go RenameAgent: the name coerced to herdr's grammar, then the folders read
  *  again (the server moved them to the new name). It returns the name saved. */
 renameAgent(name: string): Promise<string> {
  const trimmed = trimSpace(name);
  if (trimmed === "") return Promise.reject(new Error("enter a name"));
  const saved = normalizeAgentName(trimmed);
  return this.#step("rename", async (link) => {
   let result: { agent: AgentInfo };
   try {
    result = await ownerCall<{ agent: AgentInfo }>("agent.rename", { target: this.paneID, name: saved }, "agent_info", { link });
   } finally {
    if (currentOwnerLink() === link) await link.groups?.refresh(true);
   }
   link.relist();
   return result.agent.name ?? saved;
  });
 }

 /** desk_agent_actions.go RestartAgent: --resume in place for accountID "", else on that account. */
 restartAgent(accountID: string): Promise<void> {
  return this.#step(accountID === "" ? "restart" : "swap", async (link) => {
   await ownerCall("agent.restart", { target: this.paneID, ...accountID !== "" ? { account: accountID } : {} }, "agent_info", { link });
   link.relist();
  });
 }

 /** desk_agent_actions.go SetAgentAvatar: the picture on the agent's avatar target. */
 setAgentAvatar(c: AvatarChoice): Promise<void> {
  let params: Record<string, unknown>;
  try { params = avatarParams(c); } catch (error) { return Promise.reject(error); }
  return this.#step("avatar", async (link) => {
   // avatarTarget: the agent as last listed there, only its pane id when it isn't.
   const info: AgentInfo = link.agents().find((a) => a.pane_id === this.paneID) ?? { pane_id: this.paneID };
   try {
    await ownerCall("agent.avatar.set", { ...params, target: avatarTarget(info) }, "agent_avatar_set", { capability: "agent_avatar", link });
   } catch (error) { throw avatarProblem(error); }
   link.relist();
  });
 }

 /** desk_topics.go TopicsSetEnabled: herdr restarts the omp agent with topics on or off. */
 topicsSetEnabled(enabled: boolean): Promise<TopicsSwitched> {
  return this.#step("topics", async (link) => {
   let switched: { changed: boolean; topics_enabled: boolean };
   try {
    switched = await ownerCall("agent.topics.set_enabled", { target: this.paneID, enabled }, "agent_topics_switched", { capability: "agent_topics_switch", link });
   } catch (error) { throw new Error(topicsSwitchProblem(error)); }
   link.relist();
   return { changed: switched.changed, topicsEnabled: switched.topics_enabled };
  });
 }

 /** desk_agent_actions.go TransferAccounts: accounts.list, {"accounts": […]}, as JSON. */
 transferAccounts(): Promise<string> {
  return this.#step("transfer", async (link) => JSON.stringify(await ownerCall("accounts.list", {}, "accounts_list", { link })));
 }

 /** desk_agent_actions.go TransferAgentInfo: the agent or, as a transfer may move it, the one with
  *  terminalID, listed again, as JSON; "" when neither is listed. */
 transferAgentInfo(terminalID: string): Promise<string> {
  return this.#step("transfer", async (link) => {
   const { agents } = await ownerCall<{ agents: AgentInfo[] }>("agent.list", {}, "agent_list", { link });
   const found = agents.find((a) => a.pane_id === this.paneID || (terminalID !== "" && a.terminal_id === terminalID));
   return found ? JSON.stringify(found) : "";
  });
 }

 /** desk_agent_actions.go PrepareSessionTransfer: the reply, {"agent": AgentInfo}, as JSON. */
 prepareSessionTransfer(to: string, accountID: string): Promise<string> {
  return this.#transfer(to, accountID, "");
 }

 /** desk_agent_actions.go ConfirmSessionTransfer. */
 confirmSessionTransfer(to: string, accountID: string, transferID: string): Promise<string> {
  if (transferID === "") return Promise.reject(new Error("no prepared transfer"));
  return this.#transfer(to, accountID, transferID);
 }

 #transfer(to: string, accountID: string, transferID: string): Promise<string> {
  if (to === "") return Promise.reject(new Error("no target harness"));
  return this.#step("transfer", async (link) => {
   const result = await ownerCall<{ agent: AgentInfo }>("agent.transfer_session", {
    target: this.paneID, to, ...accountID !== "" ? { account: accountID } : {}, ...transferID !== "" ? { transfer_id: transferID, confirm: true } : {},
   }, "agent_info", { capability: "agent_session_transfer", link });
   link.relist();
   return JSON.stringify(result);
  });
 }
}

setSheetOpenings({ open: (_desk, kind, request) => new WebOpening(kind, request) });

/** A sheet of kind for paneID selected on link (a row menu item, or the ••• menu's Avatar…): the
 *  selection the event about to be sent carries (its `sheet`), which the page opens the sheet with.
 *  It is now the newest of that sheet. */
export function selectSheet(link: OwnerLink, kind: SheetKind, paneID: string): SheetSelection {
 const selection = new WebSelection(kind, paneID, link, ++selections);
 selected.set(kind + "\u0000" + paneID, selection);
 watch(link);
 return selection;
}

/** Sheet records still held (a test seam for their lifetime): results owned, selections pending. */
export function openSheets(): number { return speaking.size + selected.size; }

/** desk_agent_actions.go agentLink, without the roster: the link a menu brought, or the open one,
 *  for an action on paneID. */
function paneLink(paneID: string, link: OwnerLink | null): OwnerLink {
 if (link === null) throw new Error("not connected");
 if (paneID === "") throw new Error("no agent");
 return link;
}

/** desk_agent_actions.go StopAgent: closes the agent's pane (Stop agent, Close agent), on the
 *  link a menu was shown for, or the open one. */
async function stopAgent(paneID: string, on = currentOwnerLink()): Promise<void> {
 const link = paneLink(paneID, on);
 await ownerCall("pane.close", { pane_id: paneID }, "ok", { link });
 link.relist();
}

/** desk_agent_actions.go ArchiveAgent: archived, attributed to herdrup. */
async function archiveAgent(paneID: string, on = currentOwnerLink()): Promise<void> {
 const link = paneLink(paneID, on);
 await ownerCall("agent.archive", { target: paneID, reason: ARCHIVE_REASON, by: ARCHIVE_BY }, "agent_info", { link });
 link.relist();
}

/** desk_agent_actions.go choosePaneAction's close: the pane closed on link (the ••• menu's own,
 *  desk.ts paneMenu), or why not said as Go's alert (unless the link ended), titled as the pane's
 *  row (agentTitle: its pane id once it is off the list). */
export async function closeAgent(link: OwnerLink | null, paneID: string): Promise<boolean> {
 try {
  await stopAgent(paneID, link);
  return true;
 } catch (error) {
  if (link !== null && !link.signal.aborted) {
   const listed = link.agents().find((a) => a.pane_id === paneID);
   showWarning("Couldn't close " + (listed ? displayName(listed) : paneID), errorText(error));
  }
  return false;
 }
}

/** desk_agent_actions.go chooseAgentAction: stop and archive here, the rest in the page's sheets. */
function chooseAgentAction(link: OwnerLink, a: AgentAction) {
 const run = a.kind === "stop" ? stopAgent : a.kind === "archive" ? archiveAgent : null;
 if (run === null) {
  const request: AgentAction & SheetRequest = { ...a, sheet: selectSheet(link, a.kind as SheetKind, a.paneID) };
  emit("agentActionRequested", request);
  return;
 }
 run(a.paneID, link).catch((error) => { if (!link.signal.aborted) showWarning(`Couldn't ${a.kind} ${a.title}`, errorText(error)); });
}

/** desk_groups.go choose. */
function choose(link: OwnerLink, e: MenuItem) {
 if (e.edit) link.groups?.apply(e.edit);
 else if (e.naming) { prompts.set(e.naming, link); emit("folderNamingRequested", e.naming); }
 else if (e.action) chooseAgentAction(link, e.action);
}

/** desk_groups.go popup: entries as a menu, false when there is nothing to show. The page's menu
 *  has no cascades: a submenu opens as its own menu where its item was. A choice is the entry
 *  itself (two folders may share a name), and it belongs to link: once another machine is open it
 *  is dropped, and so is a write (anything but the Topics switch) once the link's scope is no
 *  longer terminal (a renewal admitted it under chat). */
function popup(link: OwnerLink, entries: MenuItem[]): boolean {
 if (entries.length === 0) return false;
 const show = async (items: MenuItem[]): Promise<void> => {
  const chosen = await showMenu(items);
  if (!chosen || currentOwnerLink() !== link) return;
  if (chosen.action?.kind !== "topics" && link.scope() !== "terminal") return;
  if (chosen.sub) await show(chosen.sub);
  else choose(link, chosen);
 };
 void show(entries);
 return true;
}

/** desk_agent_actions.go avatarParams: herdrup's AgentAvatarSetParams; default is an explicit null. */
export function avatarParams(c: AvatarChoice): Record<string, unknown> {
 switch (c.kind) {
  case "default": return { avatar: null };
  case "mascot":
   if (!c.mascot) throw new Error("no mascot chosen");
   return { avatar: { style: "mascot", mascot: c.mascot } };
  case "image":
   if (!c.imageBase64 || !c.mime) throw new Error("no photo chosen");
   return { avatar: { style: "image" }, image_base64: c.imageBase64, mime: c.mime };
 }
 throw new Error("unknown picture kind " + c.kind);
}

/** desk_agent_actions.go describeAvatarError (AgentAvatarSheet.describe). */
export function avatarProblem(error: unknown): unknown {
 if (error instanceof ErrUnsupported) return new Error("this server doesn't support agent pictures.");
 if (!(error instanceof HerdrAPIError)) return error;
 if (error.code === "avatar_too_large") return new Error("the photo is too large.");
 if (error.code === "invalid_avatar") return new Error("the server refused it.");
 return new Error(error.apiMessage);
}

/** desk_topics.go topicsSwitchProblem: completes "Couldn't turn on topics: …". A browser the host
 *  doesn't allow it says so. */
export function topicsSwitchProblem(error: unknown): string {
 if (error instanceof ErrUnsupported) return "this server has no Topics switch.";
 if (error instanceof OwnerRefusedError) return error.message;
 if (!(error instanceof HerdrAPIError)) return "couldn't reach the server.";
 switch (error.code) {
  case "topics_build_missing": return "this server has no omp build with topics.";
  case "not_omp": return "only omp agents have topics.";
  case "guest_forbidden": return "only the owner can switch topics.";
  case "agent_directory_unavailable": return "the agent's folder is not available.";
 }
 return error.apiMessage;
}

export const agentActionsDesk = {
 /** desk_agent_actions.go AgentMenu: a live agent's row menu (right-click); false without one. */
 async agentMenu(paneID: string): Promise<boolean> {
  const link = currentOwnerLink();
  const info = link?.agents().find((a) => a.pane_id === paneID);
  if (!link || !info || isArchived(info)) return false;
  // Swap's accounts are a write's (terminal scope); what the menu offers is the scope the link
  // has once the pong is back (a renewal may have admitted it under chat meanwhile).
  const [pong, accounts] = await Promise.all([
   link.client.ping(link.signal).catch(() => null),
   link.scope() === "terminal" ? ownerCall<{ accounts: AccountInfo[] }>("accounts.list", {}, "accounts_list", { link }).then((r) => r.accounts, () => []) : [],
  ]);
  // Another machine opened while its pong was on its way: this menu would name its panes.
  if (currentOwnerLink() !== link) return false;
  return popup(link, agentRowMenu({ info, caps: pong?.capabilities ?? null, groups: link.groups?.document() ?? null, accounts }, link.scope() === "terminal"));
 },

 /** desk_groups.go FolderMenu: a folder row's menu; every item writes. */
 async folderMenu(id: string): Promise<boolean> {
  const link = currentOwnerLink();
  if (!link?.groups || link.scope() !== "terminal") return false;
  return popup(link, folderRowMenu(link.groups.document(), id));
 },

 /** desk_groups.go NameFolder: creates the folder or renames it; a name with nothing left once
  *  trimmed does nothing. */
 async nameFolder(n: FolderNaming, text: string): Promise<void> {
  // The prompt's own link, and only while it is the open one and still writes (terminal scope): a
  // refused name changes nothing, here (the open folders) or there.
  const link = prompts.get(n);
  prompts.delete(n);
  if (!link?.groups || link !== currentOwnerLink() || link.scope() !== "terminal") return;
  if (n.kind === "new") link.groups.createFolder(text, n.member);
  else if (n.kind === "rename") {
   const name = folderName(text);
   if (name !== "") link.groups.apply({ kind: "renameFolder", folder: n.folder, text: name });
  }
 },

 stopAgent,
 archiveAgent,

 /** desk_agent_actions.go AlertAgentFailure: Go's warning, title and detail apart. */
 async alertAgentFailure(title: string, detail: string): Promise<void> { showWarning(title, detail); },
} satisfies Partial<DeskFns>;
