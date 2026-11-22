// How each approved machine is doing, for the owner's machine list (web owner access mockup 4):
// one owner connection per machine that reads agent.list and ends. The open machine's own link
// (desk.ts connectOwner) keeps its full board; the others are asked again only while the list
// shows, once a minute, well under the relay's 30 connects a minute.

import type { EnvelopeMachine } from "../webguest/approve";
import { fromB64url } from "../webguest/b64url";
import { GuestError } from "../webguest/errors";
import type { StaticKey } from "../webguest/noise";
import { ownerLink, type StatementSource } from "../webguest/owner";
import { GuestTransport, type WebSocketFactory } from "../webguest/transport";
import { guestList } from "./desk";

export const PROBE_EVERY_MS = 60_000;

export type MachineStatus =
 | { kind: "checking" }
 | { kind: "online"; agents: number }
 | { kind: "offline" }
 /** The machine refused this browser for good: no grant, or it ended. */
 | { kind: "ended"; message: string }
 | { kind: "problem"; message: string };

export async function probeMachine(m: EnvelopeMachine, key: StaticKey, statements: StatementSource, device: string,
 options: { webSocket?: WebSocketFactory; signal?: AbortSignal } = {}): Promise<MachineStatus> {
 const hostPublicKey = fromB64url(m.nodePub, 32);
 if (hostPublicKey === null) return { kind: "problem", message: "The approved machine's key is damaged." };
 const transport = new GuestTransport(ownerLink({ relay: m.relay, hostID: m.hostID, hostPublicKey }, device, statements), key, { webSocket: options.webSocket });
 try {
  const list = guestList(await transport.call("agent.list", {}, { signal: options.signal }));
  return { kind: "online", agents: list.agents.length };
 } catch (error) {
  if (error instanceof GuestError && error.kind === "host_offline") return { kind: "offline" };
  if (error instanceof GuestError && error.kind === "revoked") return { kind: "ended", message: error.message };
  return { kind: "problem", message: error instanceof Error ? error.message : String(error) };
 } finally {
  transport.close();
 }
}

/** The line under a machine's name. */
export function statusText(s: MachineStatus | undefined): string {
 switch (s?.kind) {
  case undefined: case "checking": return "Checking…";
  case "online": return `Online · ${s.agents} ${s.agents === 1 ? "agent" : "agents"}`;
  case "offline": return "Offline";
  case "ended": return "Not approved on this machine any more";
  case "problem": return "Can't reach it now";
 }
}
