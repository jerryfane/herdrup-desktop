// The owner's Gram decisions, ported from desk_gram.go (agentsLocked) under herdr's owner gate and
// internal/gramstore (sender.go, saved.go): who the owner's browser can write to, how a sender
// reads, and the saved copies this browser keeps (gramstore.Saved, the desktop's saved-grams.json).

import type { GramAgent, SavedGram } from "../mygo";
import { isArchived, type AgentInfo } from "./board";
import { AGENT_TO_OWNER, type GramInfo, type WireFile } from "./gramInbox";

/** gramstore.SenderName: a federated sender's machine label in place of its alias, else from. */
export function senderName(m: GramInfo): string {
 const i = m.from.indexOf("/");
 return i < 0 || !m.machineLabel ? m.from : m.machineLabel + "/" + m.from.slice(i + 1);
}

/** gramstore.SenderMachine: the daemon's machine_label, else a federated from's alias, else "". */
export function senderMachine(m: GramInfo): string {
 if (m.machineLabel) return m.machineLabel;
 const i = m.from.indexOf("/");
 return i > 0 ? m.from.slice(0, i) : "";
}

/** Whether an owner browser may address `to`: herdr's owner gate refuses any `to` naming a
 *  federation peer's agent ("alias/…", owner_gate.rs names_remote), in both scopes. */
export function ownerAddressable(to: string): boolean { return to !== "" && !to.includes("/"); }

/** The agents the owner's browser can write to: the named, unarchived local agents of the live
 *  roster (herdr delivers only to a live name, and the owner gate refuses a federated one), those
 *  that wrote first in feed order, then the rest. Senders no longer in the roster (removed, archived,
 *  federated) keep their messages in the feed but are not offered. */
export function ownerAgents(feed: readonly GramInfo[], roster: readonly AgentInfo[], machine: string): GramAgent[] {
 // Roster order; a sender leaves the set as it is placed, so the rest follow in roster order.
 const rest = new Set(roster.filter(a => a.name && !isArchived(a) && ownerAddressable(a.name)).map(a => a.name!));
 const order: string[] = [];
 for (const m of feed) if (m.direction === AGENT_TO_OWNER && rest.delete(m.from)) order.push(m.from);
 order.push(...rest);
 // An addressable name has no "alias/": its display name is itself.
 return order.map(name => ({ from: name, name, machine }));
}

/** A saved copy as the owner's browser keeps it: always with the machine its message is on (hostID,
 *  and label to name it), since the list outlives the link and its files can only come from there.
 *  A guest's saved list is SavedGram's own format, kept apart. */
export interface OwnerSavedGram extends SavedGram { hostID: string; machine: string }
export interface SavedSource { hostID: string; machine: string }

/** The owner's stored list as copies with their source: an entry without one (or not an object)
 *  is not an owner copy and is dropped. */
export function ownerSavedCopies(stored: unknown): OwnerSavedGram[] {
 if (!Array.isArray(stored)) return [];
 return stored.filter((s: unknown): s is OwnerSavedGram => typeof s === "object" && s !== null
  && "id" in s && typeof s.id === "string" && "hostID" in s && typeof s.hostID === "string" && s.hostID !== ""
  && "machine" in s && typeof s.machine === "string");
}

const savedFile = (f: WireFile) => ({ name: f.name, size: f.size, mime: f.mime });

/** Saved.Save: a copy of m from source kept newest first; saving a saved message changes nothing
 *  (null). */
export function withSaved(list: readonly OwnerSavedGram[], m: GramInfo, source: SavedSource): OwnerSavedGram[] | null {
 if (list.some(s => s.id === m.id && s.hostID === source.hostID)) return null;
 const kept: OwnerSavedGram = { id: m.id, text: m.text, from: senderName(m), fromAgent: m.direction === AGENT_TO_OWNER, createdUnixMs: m.createdUnixMs, hostID: source.hostID, machine: source.machine };
 if (m.file) kept.file = savedFile(m.file);
 else if (m.expiredFile) kept.expiredFile = savedFile(m.expiredFile);
 return [...list, kept].sort((a, b) => b.createdUnixMs - a.createdUnixMs);
}

/** Saved.ExpireFiles: a saved copy of machine hostID whose message the store expired keeps its file
 *  as expiredFile; null when nothing moved. */
export function expireSaved(list: readonly OwnerSavedGram[], messages: readonly GramInfo[], hostID: string): OwnerSavedGram[] | null {
 const expired = new Set(messages.filter(m => m.expiredFile).map(m => m.id));
 let moved = false;
 const next = list.map(s => {
  if (!expired.has(s.id) || !s.file || s.hostID !== hostID) return s;
  moved = true;
  const { file, ...rest } = s;
  return { ...rest, expiredFile: file };
 });
 return moved ? next : null;
}
