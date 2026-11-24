// desk_terminals.go and terminal_store.go for the browser's owner link: the saved terminals list,
// its rename, close and forget. Plain shells don't appear in agent.list, so their pane handles live
// on this device as Go's terminals.json does: here in localStorage, by the machine's hostID (the
// owner link has one session). As Go, the list is what this device saved, never read back from the
// machine: a close whose answer was lost keeps the record, so its pane can still be opened and
// closed again. Opening one is desk.ts openTerminalView; creating one is createDesk.ts.

import type { AgentTarget, Desk as GoDesk, SavedTerminal } from "../mygo";
import { withStorageLock } from "./locks";
import { boardLink, ownerCall } from "./ownerLink";

type DeskFns = typeof GoDesk;

export const SAVED_TERMINALS_KEY = "herdrup.web.terminals";

const NOT_SAVED = "terminal is no longer saved on this host and session";

/** The saved terminals by machine as storage holds them ({} when there are none); a value that
 *  isn't one throws (another version's value: never written over). */
function readSaved(): Record<string, SavedTerminal[]> {
 const raw = localStorage.getItem(SAVED_TERMINALS_KEY);
 if (raw === null) return {};
 const all = JSON.parse(raw) as unknown;
 if (typeof all !== "object" || all === null || Array.isArray(all)) throw new Error(`this device's ${SAVED_TERMINALS_KEY} can't be read`);
 return all as Record<string, SavedTerminal[]>;
}

/** run under the saved terminals' lock across this origin's tabs (withStorageLock), all in one
 *  synchronous grant (terminalStore's lock): its result. The lock refused, nothing runs and this
 *  throws. */
async function underLock<T>(run: () => T): Promise<T> {
 let result = undefined as T | undefined;
 const ran = await withStorageLock(SAVED_TERMINALS_KEY, () => { result = run(); });
 if (!ran) throw new Error(`this device's ${SAVED_TERMINALS_KEY} can't be changed: the browser refused its lock`);
 return result as T;
}

/** host's list in all (read under the lock just now) replaced by list and written: a write storage
 *  refuses throws, as Go's file write fails. */
function writeSaved(all: Record<string, SavedTerminal[]>, host: string, list: SavedTerminal[]) {
 localStorage.setItem(SAVED_TERMINALS_KEY, JSON.stringify({ ...all, [host]: list }));
}

const listOf = (all: Record<string, SavedTerminal[]>, host: string): SavedTerminal[] => Array.isArray(all[host]) ? all[host] : [];

/** terminalStore's load-change-save under its lock: host's list as stored now goes to change, and
 *  the new list is written (a value storage can't read is never written over). */
async function transact(host: string, change: (saved: readonly SavedTerminal[]) => SavedTerminal[]): Promise<void> {
 await underLock(() => {
  const all = readSaved();
  writeSaved(all, host, change(listOf(all, host)));
 });
}

/** terminalStore.list. */
export function listTerminals(host: string): SavedTerminal[] {
 let saved: unknown;
 try { saved = readSaved()[host]; } catch { /* unreadable: none */ }
 return Array.isArray(saved) ? [...saved] : [];
}

/** terminalStore.find. */
export function findTerminal(host: string, pane: string): SavedTerminal {
 const entry = listTerminals(host).find(e => e.paneID === pane);
 if (!entry) throw new Error(NOT_SAVED);
 return entry;
}

/** terminalStore.add's label: "Terminal n", n the lowest a saved label doesn't use. */
export function nextTerminalLabel(saved: readonly SavedTerminal[]): string {
 const used = new Set<number>();
 for (const entry of saved) {
  if (!entry.label.startsWith("Terminal ")) continue;
  const digits = entry.label.slice("Terminal ".length);
  // strconv.Atoi: optional sign and decimal digits, nothing else.
  if (/^[+-]?\d+$/.test(digits) && Number(digits) > 0) used.add(Number(digits));
 }
 let n = 1;
 while (used.has(n)) n++;
 return `Terminal ${n}`;
}

/** The new terminal's pane was taken back by its creation's or link's end before the save:
 *  nothing was saved. What became of the pane, createDesk.ts createTerminal says. */
export class TerminalNotKeptError extends Error {
 constructor() {
  super("the creation or its connection ended first");
  this.name = "TerminalNotKeptError";
 }
}

/** The pane a new terminal's record keeps (createDesk.ts EmptyPane): taken once its creation or
 *  link ended (it closes, and nothing keeps it); keep keeps it from that end. */
export interface KeptPane { readonly taken: boolean; keep(): void }

/** terminalStore.add, persisting the new terminal and keeping its pane: under the saved
 *  terminals' lock, in one synchronous grant, owner's ownership and a duplicate are checked, the
 *  record is written, and only then owner.keep() runs. A pane its creation's or link's end took
 *  writes nothing (TerminalNotKeptError); a write storage refuses throws before the keep, leaving
 *  the pane to that end. The terminal saved (its label the lowest free "Terminal n"). */
export async function persistAndKeep(owner: KeptPane, host: string, entry: Omit<SavedTerminal, "label">): Promise<SavedTerminal> {
 return underLock(() => {
  const all = readSaved();
  const old = listOf(all, host);
  if (owner.taken) throw new TerminalNotKeptError();
  if (old.some(e => e.paneID === entry.paneID)) throw new Error("terminal pane is already saved");
  const saved: SavedTerminal = { ...entry, label: nextTerminalLabel(old) };
  writeSaved(all, host, [...old, saved]);
  owner.keep();
  return saved;
 });
}

/** terminalStore.modify: rename (label) or remove (null) pane's record. */
async function modifyTerminal(host: string, pane: string, label: string | null): Promise<void> {
 await transact(host, (old) => {
  const index = old.findIndex(e => e.paneID === pane);
  if (index < 0) throw new Error(NOT_SAVED);
  return label === null ? old.filter((_, i) => i !== index) : old.map((e, i) => i === index ? { ...e, label } : e);
 });
}

export const terminalsDesk = {
 async savedTerminals(machineID: string, session: string): Promise<SavedTerminal[]> {
  return listTerminals(boardLink(machineID, session).machine.hostID);
 },
 async renameTerminal(target: AgentTarget, label: string): Promise<void> {
  label = label.trim();
  if (label === "") throw new Error("terminal label is empty");
  const link = boardLink(target.machineID, target.session), host = link.machine.hostID;
  findTerminal(host, target.paneID);
  await ownerCall("pane.rename", { pane_id: target.paneID, label }, "pane_info", { link });
  await modifyTerminal(host, target.paneID, label);
 },
 async closeTerminal(target: AgentTarget): Promise<void> {
  const link = boardLink(target.machineID, target.session), host = link.machine.hostID;
  findTerminal(host, target.paneID);
  await ownerCall("pane.close", { pane_id: target.paneID }, "ok", { link });
  // Forget only after acknowledged closure. A lost response retains the record
  // so the reader can inspect the pane instead of silently losing its handle.
  await modifyTerminal(host, target.paneID, null);
 },
 /** Forgets the record only; the page closes the terminal's view (interaction.ts savedTerminalChanged). */
 async forgetTerminal(target: AgentTarget): Promise<void> {
  await modifyTerminal(boardLink(target.machineID, target.session).machine.hostID, target.paneID, null);
 },
} satisfies Partial<DeskFns>;
