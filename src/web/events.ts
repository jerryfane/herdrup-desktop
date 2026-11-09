// The browser's `events`: every event src/mygo.ts declares, by the same name and payload, as the Go
// side's mygo.NewEvent broadcasts them. The browser Desk (and gram.ts) send them with emit.

import type { GoEvent } from "mygo-runtime";
import type { events as GoEvents } from "../mygo";

type Events = typeof GoEvents;
export type EventName = keyof Events;
export type Payload<K extends EventName> = Events[K] extends GoEvent<infer T> ? T : never;

const listeners = new Map<string, Set<(payload: never) => void>>();

function event<K extends EventName>(name: K): GoEvent<Payload<K>> {
 const set = new Set<(payload: Payload<K>) => void>();
 listeners.set(name, set as Set<(payload: never) => void>);
 const on = (listener: (payload: Payload<K>) => void) => {
  set.add(listener);
  return () => { set.delete(listener); };
 };
 return {
  name,
  on,
  once(listener) {
   const off = on((payload) => { off(); listener(payload); });
   return off;
  },
 };
}

/** The same keys as src/mygo.ts's events; the type check fails when one is missing. */
export const events: { [K in EventName]: GoEvent<Payload<K>> } = {
 boardChanged: event("boardChanged"),
 stateChanged: event("stateChanged"),
 machineStatusChanged: event("machineStatusChanged"),
 agentActionRequested: event("agentActionRequested"),
 paneActionChosen: event("paneActionChosen"),
 gramChanged: event("gramChanged"),
 gramUpload: event("gramUpload"),
 gramDownload: event("gramDownload"),
 gramMenu: event("gramMenu"),
 folderNamingRequested: event("folderNamingRequested"),
 guestInvitationOpened: event("guestInvitationOpened"),
 terminalChanged: event("terminalChanged"),
 chatMenu: event("chatMenu"),
 paneAttachments: event("paneAttachments"),
 sessionsChanged: event("sessionsChanged"),
 accountsChanged: event("accountsChanged"),
 settingsAccountMenu: event("settingsAccountMenu"),
 appUpdateChanged: event("appUpdateChanged"),
 appUpdateOpen: event("appUpdateOpen"),
 dictationChanged: event("dictationChanged"),
 agentOpen: event("agentOpen"),
};

/** Sends payload to every listener of name, in subscription order, as Broadcast does. A listener
 *  that throws does not keep the others from hearing it. */
export function emit<K extends EventName>(name: K, payload: Payload<K>): void {
 for (const listener of [...(listeners.get(name) ?? [])]) {
  try { (listener as (payload: Payload<K>) => void)(payload); } catch (error) { console.error(error); }
 }
}
