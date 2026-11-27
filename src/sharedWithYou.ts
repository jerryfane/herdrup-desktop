// SHARED WITH YOU (account-linked shares, #700; owner pick A, frames com-g4/com-g5): the host
// home's section of the agents others share with you (the desktop's hosts.ts). One row per
// machine: the grants this device holds and the account's synced shares it doesn't, "<machine>"
// over "<agents> · shared by <owner>". A machine this device holds a grant for opens as today
// (connectGuest); one known only from the account opens with openSyncedShare, with nothing to
// accept.
import { grantKey } from "./grantKey";
import { Desk } from "./mygo";
import type { Access, SyncedShare } from "./mygo";
import { accountShareWords } from "./notices";
import { element, hostGlyph, hostRowChevron, hostRowIcon, hostRowLines, hostSection, type SymbolRenderer } from "./hostHome";
import usersIcon from "../third_party/phosphor/web/users.svg?url";

/** How a row opens its share: a grant this device holds, or a synced share it doesn't yet. */
export type ShareOpen = { kind: "grant"; id: string } | { kind: "synced"; id: string };

/** One share on a machine: its agent, how its row opens it, and, for a grant whose account write
 *  is still owed or was turned down, how it stands (accountShareWords), shown muted on its row. */
export interface SharedGrant { agent: string; open: ShareOpen; pending?: string }

/** One machine of SHARED WITH YOU: its name, whose it is, the agents shared on it, and each share
 *  on it, held here first, each opening on its own. */
export interface SharedMachine { hostID: string; machine: string; owner: string; agents: string[]; grants: SharedGrant[] }

/** Whether a row of m opens a share only the account has: opening it adds this device (the owner
 *  sees each device), whatever grants the machine's other rows hold. */
export const addsDevice = (m: Pick<SharedMachine, "grants">) => m.grants.some(g => g.open.kind === "synced");

/** The grants this device holds and the account's synced shares, one entry per machine (host id),
 *  in the order they first come: the grants, then the shares only the account has. A synced share
 *  this device holds (local) is its grant's. A grant's queued or refused account write is its
 *  pending words; a confirmed one needs none. */
export function sharedMachines(grants: readonly Access[], synced: readonly SyncedShare[]): SharedMachine[] {
 const byHost = new Map<string, SharedMachine>();
 const add = (hostID: string, machine: string, owner: string, agent: string, open: ShareOpen, pending: string | null = null) => {
  const share: SharedGrant = pending === null ? { agent, open } : { agent, open, pending };
  const had = byHost.get(hostID);
  if (had === undefined) { byHost.set(hostID, { hostID, machine, owner, agents: agent ? [agent] : [], grants: [share] }); return; }
  if (agent && !had.agents.includes(agent)) had.agents.push(agent);
  had.grants.push(share);
 };
 const held = new Set<string>();
 for (const g of grants) {
  held.add(grantKey(g));
  add(g.endpoint.hostID, g.machineLabel || g.agentName, g.ownerName, g.agentName, { kind: "grant", id: grantKey(g) }, g.accountShare === "confirmed" ? null : accountShareWords(g));
 }
 for (const s of synced) {
  if (held.has(s.id)) continue;
  // A synced share this device holds but didn't list: its grant opens it.
  if (s.local) { add(s.hostID, s.machineLabel || s.agentName, s.ownerName, s.agentName, { kind: "grant", id: s.id }); continue; }
  add(s.hostID, s.machineLabel || s.agentName, s.ownerName, s.agentName, { kind: "synced", id: s.id });
 }
 // Held here first: a machine's one row, or its first agent row, is the grant before any synced share.
 for (const m of byHost.values()) m.grants.sort((a, b) => Number(a.open.kind === "synced") - Number(b.open.kind === "synced"));
 return [...byHost.values()];
}

/** The row's second line: the agents, then "shared by <owner>", leaving out what is empty. */
export function sharedLine(m: Pick<SharedMachine, "agents" | "owner">): string {
 return [m.agents.join(", "), m.owner ? `shared by ${m.owner}` : ""].filter(Boolean).join(" · ");
}

/** The note under rows the account brought: nothing to accept, and the owner sees this device.
 *  Shown while any row opens a share only the account has (addsDevice), on any machine. */
export function accountNote(machines: readonly SharedMachine[]): string | null {
 const adding = machines.filter(addsDevice);
 if (adding.length === 0) return null;
 const owners = [...new Set(adding.map(m => m.owner).filter(Boolean))];
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
 *  sharedLine, the chevron) and the account's note. A machine with one share is one row that opens
 *  it; one with more is its row (the machine over who shared it), then a row per share, the agent's
 *  name, each opening its own. Picking a row opens it (openShared), then opened(); a failure goes
 *  to report. busy keeps the rows disabled while another connect runs. */
export function sharedSection(symbol: SymbolRenderer, opened: () => void, report: (error: unknown) => void, busy: () => boolean = () => false) {
 const { root, rows } = hostSection("SHARED WITH YOU"); root.hidden = true;
 const note = element("p", "host-home-note host-shared-note"); note.hidden = true;
 root.append(note);
 let version = 0;
 const openRow = (open: ShareOpen, icon: HTMLElement, lines: HTMLElement, chevron: HTMLElement) => {
  const row = element("button", "host-home-row"); row.type = "button"; row.disabled = busy();
  row.onclick = () => { row.disabled = true; void openShared(open).then(opened).catch(report).finally(() => { row.disabled = busy(); }); };
  row.append(icon, lines, chevron);
  return row;
 };
 /** A row's lines, with a grant's pending account words under them, muted (no colour, no dot). */
 const rowLines = (name: string, second: string | null, pending: string | undefined) => {
  const drawn = hostRowLines(name, second);
  if (pending !== undefined) drawn.append(element("span", "host-home-address host-shared-state", pending));
  return drawn;
 };
 return {
  root,
  /** Draws machines (sharedMachines); resolves true once they're drawn, false when a newer draw
   *  took over meanwhile (this one drew nothing). */
  async draw(machines: readonly SharedMachine[]): Promise<boolean> {
   const at = ++version;
   const nodes: HTMLElement[] = [];
   for (const m of machines) {
    const icon = hostRowIcon(await hostGlyph(symbol, "person.2", usersIcon));
    const only = m.grants.length === 1 ? m.grants[0] : undefined;
    if (only) { nodes.push(openRow(only.open, icon, rowLines(m.machine, sharedLine(m), only.pending), hostRowChevron(await symbol("chevron.right", 13, "semibold")))); continue; }
    const head = element("div", "host-home-row host-shared-machine");
    head.append(icon, hostRowLines(m.machine, m.owner ? `shared by ${m.owner}` : null));
    nodes.push(head);
    for (const g of m.grants) {
     const row = openRow(g.open, hostRowIcon(""), rowLines(g.agent || m.machine, null, g.pending), hostRowChevron(await symbol("chevron.right", 13, "semibold")));
     row.setAttribute("aria-label", `${g.agent || m.machine} on ${m.machine}${g.pending === undefined ? "" : `. ${g.pending}`}`);
     nodes.push(row);
    }
   }
   if (at !== version) return false;
   rows.replaceChildren(...nodes);
   const words = accountNote(machines);
   note.textContent = words ?? ""; note.hidden = words === null;
   root.hidden = machines.length === 0;
   return true;
  },
 };
}
