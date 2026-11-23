// An owner link's folders and stars, read side (desk_groups.go groupsStore): the machine's folder
// document from agent.groups.get, loaded when the link opens and again at most once a minute, and
// the folders open on this browser (Go's open-folders.json, here localStorage, per machine).
// Nothing shows until the first answer; a host without agent_groups, or one refusing the owner's
// browser the read, shows the plain list. Edits (agent.groups.set) are the agent-menu slice's.

import { HerdrAPIError } from "../webguest/errors";
import type { BoardView, Groups } from "./board";
import { ErrUnsupported, untagged, type GuestClient } from "./engine";
import { localRecord, type LocalRecord } from "./storage";

/** desk_groups.go groupsRefreshInterval. */
export const GROUPS_REFRESH_MS = 60_000;
/** The open folders of every machine, by host id. */
export const OPEN_FOLDERS_KEY = "herdrup.web.openFolders";

/** desk_groups.go groupsOff: a host that predates agent.groups, or one whose gate refuses it. */
const groupsOff = (error: unknown) => error instanceof ErrUnsupported ||
 (error instanceof HerdrAPIError && (error.code === "guest_forbidden" || error.code === "owner_forbidden"));

export class OwnerGroups {
 #confirmed: Groups | null = null;
 #supported = true;
 #fetching = false;
 #lastFetch: number | null = null;

 /** changed runs when what the list shows changed (the document, a folder opened or closed). */
 constructor(private readonly client: Pick<GuestClient, "call">, private readonly hostID: string, private readonly changed: () => void,
  private readonly now: () => number = Date.now, private readonly open: LocalRecord<Record<string, string[]>> = localRecord(OPEN_FOLDERS_KEY)) {}

 /** groupsStore.view: the document (none until loaded, or when off) and this machine's open folders. */
 view(): BoardView {
  const open: Record<string, boolean> = {};
  for (const id of this.open.get()?.[this.hostID] ?? []) open[id] = true;
  return { groups: this.#supported ? this.#confirmed : null, open };
 }

 /** groupsStore.refresh: the first time, then at most once a minute unless force. A transport
  *  hiccup keeps what shows (a later list retries); a host without folders turns them off. */
 async refresh(signal: AbortSignal, force = false): Promise<void> {
  const at = this.now();
  if (!this.#supported || this.#fetching || (!force && this.#lastFetch !== null && at - this.#lastFetch < GROUPS_REFRESH_MS)) return;
  this.#fetching = true;
  let fetched: Groups;
  try {
   fetched = untagged<Groups>(await this.client.call("agent.groups.get", {}, "agent_groups", "agent_groups", signal));
  } catch (error) {
   if (groupsOff(error)) { this.#supported = false; this.#confirmed = null; this.changed(); }
   return;
  } finally { this.#fetching = false; }
  this.#lastFetch = at;
  if (this.#confirmed !== null && fetched.revision < this.#confirmed.revision) return;
  const before = JSON.stringify(this.#confirmed);
  this.#confirmed = fetched;
  if (JSON.stringify(fetched) !== before) this.changed();
 }

 /** Desk.SetFolderOpen: opens or closes folder id on this browser. */
 setOpen(id: string, open: boolean): void {
  const all = this.open.get() ?? {};
  const ids = (all[this.hostID] ?? []).filter((x) => x !== id);
  if (open) ids.push(id);
  this.open.set({ ...all, [this.hostID]: ids });
  this.changed();
 }
}
