// An owner link's folders and stars (desk_groups.go groupsStore): the machine's folder document
// from agent.groups.get, loaded when the link opens and again at most once a minute, the folders
// open on this browser (Go's open-folders.json, here localStorage, per machine), and the owner's
// edits (agent.groups.set), each shown at once and saved one at a time. Nothing shows until the
// first answer; a host without agent_groups, or one refusing the owner's browser the read, shows
// the plain list.

import { HerdrAPIError } from "../webguest/errors";
import { trimSpace, type AgentGroupFolder, type BoardView, type Groups } from "./board";
import { ErrUnsupported, untagged, type GuestClient } from "./engine";
import { OwnerRefusedError } from "./ownerLink";
import { localRecord, type LocalRecord } from "./storage";
import { showWarning } from "./warning";

/** desk_groups.go groupsRefreshInterval. */
export const GROUPS_REFRESH_MS = 60_000;
/** The open folders of every machine, by host id. */
export const OPEN_FOLDERS_KEY = "herdrup.web.openFolders";
/** desk_groups.go: save failures, as herdrup words them (AgentGroupsStore.send). */
export const GROUPS_CONFLICT_MESSAGE = "Your folders changed on another device at the same time. Try again.";
export const GROUPS_ALERT_TITLE = "Couldn't save folders";

// ---- The document and its edits (internal/herdr folders.go) ----

/** folders.go MaxNameLength: the server's limit on folder names, in characters. */
export const MAX_FOLDER_NAME = 64;

/** folders.go FolderName: trimmed and at most 64 characters; "" when nothing is left. */
export function folderName(raw: string): string {
 return Array.from(trimSpace(raw)).slice(0, MAX_FOLDER_NAME).join("");
}

/** folders.go NewFolderID: 12 lowercase hex characters. */
export function newFolderID(): string {
 return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** folders.go OrderedFolders: by order, then by their place in the document. */
export function orderedFolders(g: Groups): AgentGroupFolder[] {
 return [...g.folders ?? []].sort((a, b) => a.order - b.order);
}

/** folders.go FolderOf: the folder name is in, or null. An agent is in at most one. */
export function folderOf(g: Groups, name: string): AgentGroupFolder | null {
 return (g.folders ?? []).find((f) => (f.members ?? []).includes(name)) ?? null;
}

export function isStarred(g: Groups, name: string): boolean { return (g.stars ?? []).includes(name); }

/** folders.go Edit: one change, pure so a conflict can replay it onto the server's current
 *  document. name is the agent, folder the folder id, text a folder name, star the star state and
 *  by the step of a folder move. */
export type Edit =
 | { kind: "setStar"; name: string; star: boolean }
 | { kind: "move"; name: string; folder: string }
 | { kind: "removeFromFolder"; name: string }
 | { kind: "addFolder"; folder: string; text: string; name: string }
 | { kind: "renameFolder"; folder: string; text: string }
 | { kind: "deleteFolder"; folder: string }
 | { kind: "moveFolder"; folder: string; by: number };

function clone(g: Groups): Groups {
 return { revision: g.revision, stars: g.stars ? [...g.stars] : g.stars, folders: (g.folders ?? []).map((f) => ({ ...f, members: f.members ? [...f.members] : f.members })) };
}

function removeFromFolders(g: Groups, name: string) {
 for (const f of g.folders!) if (f.members) f.members = f.members.filter((m) => m !== name);
}

/** folders.go move: name into folder id, out of any other; a missing folder (deleted on another
 *  device meanwhile) leaves the agent where it was. */
function move(g: Groups, name: string, id: string) {
 const f = g.folders!.find((x) => x.id === id);
 if (!f) return;
 removeFromFolders(g, name);
 f.members = [...f.members ?? [], name];
}

/** folders.go Edit.Apply: g with e applied; g is left as it was. */
export function applyEdit(e: Edit, from: Groups): Groups {
 const g = clone(from);
 switch (e.kind) {
  case "setStar":
   // Idempotent, not a toggle, so a replay keeps what was asked for.
   g.stars = (g.stars ?? []).filter((s) => s !== e.name);
   if (e.star) g.stars.push(e.name);
   break;
  case "move": move(g, e.name, e.folder); break;
  case "removeFromFolder": removeFromFolders(g, e.name); break;
  case "addFolder": {
   const order = g.folders!.reduce((max, f) => Math.max(max, f.order), -1);
   g.folders!.push({ id: e.folder, name: e.text, order: order + 1, members: [] });
   if (e.name !== "") move(g, e.name, e.folder);
   break;
  }
  case "renameFolder": {
   const f = g.folders!.find((x) => x.id === e.folder);
   if (f) f.name = e.text;
   break;
  }
  // Its agents go back to the list.
  case "deleteFolder": g.folders = g.folders!.filter((f) => f.id !== e.folder); break;
  case "moveFolder": {
   const ordered = orderedFolders(g);
   const i = ordered.findIndex((f) => f.id === e.folder), j = i + e.by;
   if (i < 0 || j < 0 || j >= ordered.length) break;
   [ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!];
   ordered.forEach((f, k) => { f.order = k; });
   g.folders = ordered;
   break;
  }
 }
 return g;
}

const sameList = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined) =>
 (a ?? []).length === (b ?? []).length && (a ?? []).every((x, i) => x === b![i]);

/** folders.go GroupsEqual: an empty list and a missing one alike. */
export function groupsEqual(a: Groups, b: Groups): boolean {
 const fa = a.folders ?? [], fb = b.folders ?? [];
 return a.revision === b.revision && sameList(a.stars, b.stars) && fa.length === fb.length &&
  fa.every((x, i) => { const y = fb[i]!; return x.id === y.id && x.name === y.name && x.order === y.order && sameList(x.members, y.members); });
}

// ---- The store ----

/** desk_groups.go groupsOff for a read: a host that predates agent.groups, or one whose gate
 *  refuses it. */
const groupsOff = (error: unknown) => error instanceof ErrUnsupported ||
 (error instanceof HerdrAPIError && (error.code === "guest_forbidden" || error.code === "owner_forbidden"));

/** engine.go AgentGroupsSet's GroupsConflictError: the stored document a groups_conflict carries,
 *  null for any other error (or a conflict without one). */
function conflictCurrent(error: unknown): Groups | null {
 if (!(error instanceof HerdrAPIError) || error.code !== "groups_conflict") return null;
 const current = (error.raw as { current?: unknown } | null)?.current;
 return current && typeof current === "object" ? untagged<Groups>(current) : null;
}

/** desk_groups.go commit's answer: the newest document the server confirmed (null while that is
 *  still the base), why the edit was dropped, or off for a host without folders. */
export interface Commit { saved: Groups | null; failure: string; off: boolean }

export class OwnerGroups {
 #confirmed: Groups | null = null;
 #supported = true;
 #fetching = false;
 #lastFetch: number | null = null;
 #pending: Edit[] = [];
 #sending = false;

 /** changed runs when what the list shows changed (the document, a folder opened or closed);
  *  alert shows a save that failed. */
 constructor(private readonly client: Pick<GuestClient, "call">, private readonly hostID: string, private readonly changed: () => void,
  private readonly now: () => number = Date.now, private readonly open: LocalRecord<Record<string, string[]>> = localRecord(OPEN_FOLDERS_KEY),
  private readonly alert: (message: string) => void = (message) => showWarning(GROUPS_ALERT_TITLE, message)) {}

 /** groupsStore.document: what the list draws, the server's last document with this browser's
  *  unsent edits applied; null while folders are unavailable. */
 document(): Groups | null {
  if (!this.#supported || this.#confirmed === null) return null;
  return this.#pending.reduce((g, e) => applyEdit(e, g), this.#confirmed);
 }

 /** groupsStore.view: the document (none until loaded, or when off) and this machine's open folders. */
 view(): BoardView {
  const open: Record<string, boolean> = {};
  for (const id of this.open.get()?.[this.hostID] ?? []) open[id] = true;
  return { groups: this.document(), open };
 }

 /** groupsStore.off: folders hidden, for a host that turned out not to have them. */
 #off() {
  this.#supported = false; this.#confirmed = null; this.#pending = [];
  this.changed();
 }

 /** groupsStore.refresh: the first time, then at most once a minute unless force, never while an
  *  edit is unsent (a read can't undo it on screen). A transport hiccup keeps what shows (a later
  *  list retries); a host without folders turns them off. */
 async refresh(signal: AbortSignal, force = false): Promise<void> {
  const at = this.now();
  if (!this.#supported || this.#fetching || this.#pending.length > 0 || (!force && this.#lastFetch !== null && at - this.#lastFetch < GROUPS_REFRESH_MS)) return;
  this.#fetching = true;
  let fetched: Groups;
  try {
   fetched = untagged<Groups>(await this.client.call("agent.groups.get", {}, "agent_groups", "agent_groups", signal));
  } catch (error) {
   if (groupsOff(error)) this.#off();
   return;
  } finally { this.#fetching = false; }
  this.#lastFetch = at;
  // A save that answered meanwhile may hold a newer revision.
  if (!this.#supported || this.#pending.length > 0 || (this.#confirmed !== null && fetched.revision < this.#confirmed.revision)) return;
  const before = this.#confirmed;
  this.#confirmed = fetched;
  if (before === null || !groupsEqual(before, fetched)) this.changed();
 }

 /** Desk.SetFolderOpen: opens or closes folder id on this browser. */
 setOpen(id: string, open: boolean): void {
  this.#keepOpen(id, open);
  this.changed();
 }

 #keepOpen(id: string, open: boolean) {
  const all = this.open.get() ?? {};
  const ids = (all[this.hostID] ?? []).filter((x) => x !== id);
  if (open) ids.push(id);
  this.open.set({ ...all, [this.hostID]: ids });
 }

 /** groupsStore.apply: shows e at once and queues it for the server; signal is the link's. */
 apply(e: Edit, signal: AbortSignal): void {
  if (this.document() === null) return;
  this.#pending.push(e);
  const start = !this.#sending;
  this.#sending = true;
  this.changed();
  if (start) void this.#send(signal);
 }

 /** groupsStore.createFolder: a folder named raw holding member, opened on this browser so the
  *  agent just moved stays in sight. */
 createFolder(raw: string, member: string, signal: AbortSignal): void {
  const name = folderName(raw);
  if (name === "") return;
  const id = newFolderID();
  this.#keepOpen(id, true);
  this.apply({ kind: "addFolder", folder: id, text: name, name: member }, signal);
 }

 /** groupsStore.send: the pending edits, one at a time. */
 async #send(signal: AbortSignal): Promise<void> {
  for (;;) {
   if (this.#pending.length === 0 || this.#confirmed === null) { this.#sending = false; return; }
   const { saved, failure, off } = await this.commit(this.#pending[0]!, this.#confirmed, signal);
   if (off) { this.#sending = false; this.#off(); return; }
   if (saved !== null) this.#confirmed = saved;
   this.#pending.shift();
   this.changed();
   // A link that ended took its folders with it: nothing to say.
   if (failure !== "" && !signal.aborted) this.alert(failure);
  }
 }

 /** desk_groups.go commit: sends e made on base. On groups_conflict it applies e once more to the
  *  server's current document and sends that; a second conflict gives up with the newest document.
  *  A replay that fails otherwise still returns the document the conflict reported. An edit that
  *  changes nothing is not sent. */
 async commit(e: Edit, base: Groups, signal: AbortSignal): Promise<Commit> {
  const set = async (g: Groups) => untagged<Groups>(await this.client.call("agent.groups.set", {
   revision: g.revision, stars: g.stars ?? [],
   folders: (g.folders ?? []).map(({ id, name, order, members }) => (members ? { id, name, order, members } : { id, name, order })),
  }, "agent_groups", "agent_groups", signal));
  const next = applyEdit(e, base);
  if (groupsEqual(next, base)) return { saved: base, failure: "", off: false };
  // known is the newest document the server has confirmed, null while that is still base.
  let known: Groups | null = null;
  let error: unknown;
  try { return { saved: await set(next), failure: "", off: false }; } catch (err) { error = err; }
  const current = conflictCurrent(error);
  if (current !== null) {
   known = current;
   const replayed = applyEdit(e, current);
   if (groupsEqual(replayed, current)) return { saved: known, failure: "", off: false };
   try { return { saved: await set(replayed), failure: "", off: false }; } catch (err) { error = err; }
   const again = conflictCurrent(error);
   if (again !== null) return { saved: again, failure: GROUPS_CONFLICT_MESSAGE, off: false };
  }
  // Go's groupsOff: herdr without agent.groups, or a guest. The owner's browser refused the write
  // (an older host, herdr#510) keeps the folders it may read and says why.
  if (error instanceof ErrUnsupported || (error instanceof HerdrAPIError && error.code === "guest_forbidden")) return { saved: null, failure: "", off: true };
  if (error instanceof HerdrAPIError && error.code === "invalid_groups") return { saved: known, failure: "The server refused the change: " + error.apiMessage, off: false };
  if (error instanceof HerdrAPIError && error.code === "owner_forbidden") error = new OwnerRefusedError("agent.groups.set");
  return { saved: known, failure: "Couldn't save folders: " + (error instanceof Error ? error.message : String(error)), off: false };
 }
}
