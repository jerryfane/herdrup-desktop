// How each approved machine is doing, for the owner's machine list (web owner access mockup 4):
// one owner connection per machine that reads agent.list and ends. The open machine's own link
// (desk.ts connectOwner) keeps its full board; the others are asked again only while the list
// shows, once a minute, well under the relay's 30 connects a minute.

import type { EnvelopeMachine } from "../webguest/approve";
import { GuestError } from "../webguest/errors";
import type { StaticKey } from "../webguest/noise";
import type { StatementSource } from "../webguest/accountStatement";
import type { WebSocketFactory } from "../webguest/transport";
import { listAgents, ownerConnection, type OwnerConnection } from "./desk";

export const PROBE_EVERY_MS = 60_000;

export type MachineStatus =
 | { kind: "checking" }
 | { kind: "online"; agents: number }
 | { kind: "offline" }
 /** The machine refused this browser for good: no grant, or it ended. */
 | { kind: "ended"; message: string }
 | { kind: "problem"; message: string };

/** One machine's status, over the owner link the Desk opens (ownerConnection) and its agent list
 *  read as the Desk reads it (listAgents): a reply that isn't an agent list is a problem. */
export async function probeMachine(m: EnvelopeMachine, key: StaticKey, statements: StatementSource, device: string,
 options: { webSocket?: WebSocketFactory; signal?: AbortSignal } = {}): Promise<MachineStatus> {
 let owner: OwnerConnection;
 try { owner = ownerConnection(m, key, statements, device, { webSocket: options.webSocket }); }
 catch (error) { return { kind: "problem", message: error instanceof Error ? error.message : String(error) }; }
 try {
  const list = await listAgents(owner.client, options.signal);
  return { kind: "online", agents: list.agents.length };
 } catch (error) {
  if (error instanceof GuestError && error.kind === "host_offline") return { kind: "offline" };
  if (error instanceof GuestError && error.kind === "revoked") return { kind: "ended", message: error.message };
  return { kind: "problem", message: error instanceof Error ? error.message : String(error) };
 } finally {
  owner.transport.close();
 }
}

/** The probes of one displayed machine list: every machine now and every PROBE_EVERY_MS, each
 *  status handed to publish. machines says, per round, what to ask with (null: nothing now).
 *  The returned stop (the list left, or the account session ended: options.signal) cancels the
 *  probes still out, and nothing of this list is published after it; its promise settles once
 *  they have ended. */
export function probeList(machines: () => Promise<{ machines: readonly EnvelopeMachine[]; key: StaticKey } | null>, statements: StatementSource, device: string,
 publish: (hostID: string, status: MachineStatus) => void, options: { webSocket?: WebSocketFactory; signal?: AbortSignal; everyMs?: number } = {}): () => Promise<void> {
 const life = new AbortController();
 const rounds = new Set<Promise<void>>();
 const round = () => {
  const run = (async () => {
   const ask = await machines();
   if (ask === null || life.signal.aborted) return;
   await Promise.all(ask.machines.map(async m => {
    const status = await probeMachine(m, ask.key, statements, device, { webSocket: options.webSocket, signal: life.signal });
    if (!life.signal.aborted) publish(m.hostID, status);
   }));
  })().finally(() => rounds.delete(run));
  rounds.add(run);
 };
 const timer = setInterval(round, options.everyMs ?? PROBE_EVERY_MS);
 const stop = () => { clearInterval(timer); life.abort(); return Promise.all(rounds).then(() => undefined); };
 options.signal?.addEventListener("abort", () => void stop(), { once: true, signal: life.signal });
 if (options.signal?.aborted) void stop(); else round();
 return stop;
}

/** A machine's status at the end of its host home row: short, in words alone (no dot, no agent
 *  count). */
export function statusText(s: MachineStatus | undefined): string {
 switch (s?.kind) {
  case undefined: case "checking": return "Checking…";
  case "online": return "Online";
  case "offline": return "Offline";
  case "ended": return "Access ended";
  case "problem": return "Can't reach it";
 }
}
