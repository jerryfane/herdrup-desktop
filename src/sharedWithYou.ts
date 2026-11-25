// SHARED WITH YOU (account-linked shares, #700; owner pick A, frames com-g4/com-g5): the host
// home's section of the agents others share with you, the same on the desktop (hosts.ts) and in the
// browser (web/hosts.ts). One row per machine: the grants this device holds and the account's
// synced shares it doesn't, "<machine>" over "<agents> · shared by <owner>". A machine this device
// holds a grant for opens as today (connectGuest); one known only from the account opens with
// openSyncedShare, with nothing to accept.
import { Desk } from "./mygo";
import type { Access, SyncedShare } from "./mygo";
import { element, hostGlyph, hostRowChevron, hostRowIcon, hostRowLines, hostSection, type SymbolRenderer } from "./hostHome";
import usersIcon from "../third_party/phosphor/web/users.svg?url";

/** How a machine's row opens it: a grant this device holds, or a synced share it doesn't yet. */
export type ShareOpen = { kind: "grant"; id: string } | { kind: "synced"; id: string };

/** One machine of SHARED WITH YOU: its name, whose it is, the agents shared on it, and how its row
 *  opens it (the first grant held here, else the first synced share). fromAccount: only the
 *  account has it, so opening it adds this device (the owner sees each device). */
export interface SharedMachine { hostID: string; machine: string; owner: string; agents: string[]; open: ShareOpen; fromAccount: boolean }

const grantID = (a: Pick<Access, "endpoint" | "guestID">) => `${a.endpoint.hostID}/${a.guestID}`;

/** The grants this device holds and the account's synced shares, one entry per machine (host id),
 *  in the order they first come: the grants, then the shares only the account has. A synced share
 *  this device holds (local) is its grant's. */
export function sharedMachines(grants: readonly Access[], synced: readonly SyncedShare[]): SharedMachine[] {
 const byHost = new Map<string, SharedMachine>();
 const add = (hostID: string, machine: string, owner: string, agent: string, open: ShareOpen) => {
  const had = byHost.get(hostID);
  if (had === undefined) { byHost.set(hostID, { hostID, machine, owner, agents: agent ? [agent] : [], open, fromAccount: open.kind === "synced" }); return; }
  if (agent && !had.agents.includes(agent)) had.agents.push(agent);
  if (open.kind === "grant" && had.open.kind === "synced") { had.open = open; had.fromAccount = false; }
 };
 const held = new Set<string>();
 for (const g of grants) { held.add(grantID(g)); add(g.endpoint.hostID, g.machineLabel || g.agentName, g.ownerName, g.agentName, { kind: "grant", id: grantID(g) }); }
 for (const s of synced) {
  if (held.has(s.id)) continue;
  // A synced share this device holds but didn't list: its grant opens it.
  if (s.local) { add(s.hostID, s.machineLabel || s.agentName, s.ownerName, s.agentName, { kind: "grant", id: s.id }); continue; }
  add(s.hostID, s.machineLabel || s.agentName, s.ownerName, s.agentName, { kind: "synced", id: s.id });
 }
 return [...byHost.values()];
}

/** The row's second line: the agents, then "shared by <owner>", leaving out what is empty. */
export function sharedLine(m: Pick<SharedMachine, "agents" | "owner">): string {
 return [m.agents.join(", "), m.owner ? `shared by ${m.owner}` : ""].filter(Boolean).join(" · ");
}

/** The note under rows the account brought: nothing to accept, and the owner sees this device. */
export function accountNote(machines: readonly SharedMachine[]): string | null {
 const owners = [...new Set(machines.filter(m => m.fromAccount).map(m => m.owner).filter(Boolean))];
 if (!machines.some(m => m.fromAccount)) return null;
 return `From your HerdrUp account: nothing to accept here. ${owners.length === 1 ? `${owners[0]} sees` : "The owner sees"} each device you open it on.`;
}

/** Opens a machine's row: its grant, or the synced share (this device joins it). */
export function openShared(open: ShareOpen): Promise<void> {
 return open.kind === "grant" ? Desk.connectGuest(open.id) : Desk.openSyncedShare(open.id);
}

/** The account's synced shares while someone is signed in; [] otherwise, or when they can't be read. */
export function syncedSharesNow(signedIn: boolean): Promise<SyncedShare[]> {
 return signedIn ? Desk.syncedShares().catch(() => []) : Promise.resolve([]);
}

/** The section, drawn again with draw(): the native sharedSection rows (person.2, the machine over
 *  sharedLine, the chevron) and the account's note. Picking a row opens it (openShared), then
 *  opened(); a failure goes to report. busy keeps the rows disabled while another connect runs. */
export function sharedSection(symbol: SymbolRenderer, opened: () => void, report: (error: unknown) => void, busy: () => boolean = () => false) {
 const { root, rows } = hostSection("SHARED WITH YOU"); root.hidden = true;
 const note = element("p", "host-home-note host-shared-note"); note.hidden = true;
 root.append(note);
 let version = 0;
 return {
  root,
  /** Draws machines (sharedMachines); resolves with how many rows it drew, or null when a newer
   *  draw took over meanwhile. */
  async draw(machines: readonly SharedMachine[]): Promise<number | null> {
   const at = ++version;
   const nodes: HTMLElement[] = [];
   for (const m of machines) {
    const row = element("button", "host-home-row"); row.type = "button"; row.disabled = busy();
    row.onclick = () => { row.disabled = true; void openShared(m.open).then(opened).catch(report).finally(() => { row.disabled = busy(); }); };
    row.append(hostRowIcon(await hostGlyph(symbol, "person.2", usersIcon)), hostRowLines(m.machine, sharedLine(m)), hostRowChevron(await symbol("chevron.right", 13, "semibold")));
    nodes.push(row);
   }
   if (at !== version) return null;
   rows.replaceChildren(...nodes);
   const words = accountNote(machines);
   note.textContent = words ?? ""; note.hidden = words === null;
   root.hidden = machines.length === 0;
   return machines.length;
  },
 };
}
