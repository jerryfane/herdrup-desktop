// The browser's `events`: every event src/mygo.ts declares, by the same name and payload, as the Go
// side's mygo.NewEvent broadcasts them, but for the agent sheets' events (BrowserPayloads). The
// browser Desk (and gram.ts) send them with emit.

import type { GoEvent } from "mygo-runtime";
import type { AgentAction, events as GoEvents, PaneAction } from "../mygo";
import type { SheetRequest, SheetSelection } from "../sheetOpening";

type Events = typeof GoEvents;
export type EventName = keyof Events;

/** The browser's payloads where they say more than Go's: the agent sheets its menus open carry the
 *  selection the menu made (sheetOpening.ts), which the page opens the sheet with. It is required,
 *  so a forwarder that rebuilds a payload from Go's fields alone doesn't type-check. Go's wire
 *  types stay as they are. */
export interface BrowserPayloads {
 /** Every row action the browser sends opens a sheet (Stop and Archive run in its Desk). */
 agentActionRequested: AgentAction & { readonly sheet: SheetSelection };
 /** A ••• item: Avatar… opens a sheet and carries its selection; only the others carry null. */
 paneActionChosen: (PaneAction & { readonly action: PaneSheetAction; readonly sheet: SheetSelection })
  | (PaneAction & { readonly action: PanePlainAction; readonly sheet: null });
}
/** The ••• menu's items (desk.ts webPaneMenu): the one that opens an agent sheet, and the rest. */
export type PaneSheetAction = "avatar";
export type PanePlainAction = "copy-screen" | "copy-recent" | "copy-selection" | "text-increase" | "text-decrease" | "text-reset"
 | "share" | "mute" | "unmute" | "close";
type GoPayload<K extends EventName> = Events[K] extends GoEvent<infer T> ? T : never;
export type Payload<K extends EventName> = K extends keyof BrowserPayloads ? BrowserPayloads[K] : GoPayload<K>;

/** Checked by tsc: Go's payloads are not the browser's (the selection can't be left out, nor an
 *  Avatar… or Go's untyped action rebuilt with none), and the browser's are what a sheet opens with. */
type Holds<T extends true> = T;
export type SelectionRequired = [
 Holds<AgentAction extends Payload<"agentActionRequested"> ? false : true>,
 Holds<PaneAction extends Payload<"paneActionChosen"> ? false : true>,
 Holds<{ paneID: string; action: "avatar"; sheet: null } extends Payload<"paneActionChosen"> ? false : true>,
 Holds<PaneAction & { sheet: null } extends Payload<"paneActionChosen"> ? false : true>,
 Holds<Payload<"agentActionRequested"> extends SheetRequest ? true : false>,
 Holds<Payload<"paneActionChosen"> extends SheetRequest ? true : false>,
];

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
 pairingLinkOpened: event("pairingLinkOpened"),
 terminalChanged: event("terminalChanged"),
 chatMenu: event("chatMenu"),
 paneAttachments: event("paneAttachments"),
 sessionsChanged: event("sessionsChanged"),
 accountsChanged: event("accountsChanged"),
 settingsAccountMenu: event("settingsAccountMenu"),
 appUpdateChanged: event("appUpdateChanged"),
 topicsChanged: event("topicsChanged"),
 accountChanged: event("accountChanged"),
 accountDeleted: event("accountDeleted"),
 // The approving side of web owner access and of pair requests is desktop only (webAccess.ts,
 // pairApproval.ts); the page never emits them.
 webAccessUpdate: event("webAccessUpdate"),
 pairApproveUpdate: event("pairApproveUpdate"),
 pairApproveProgress: event("pairApproveProgress"),
 syncedMachinesChanged: event("syncedMachinesChanged"),
 savedPromptsChanged: event("savedPromptsChanged"),
 appUpdateOpen: event("appUpdateOpen"),
 dictationChanged: event("dictationChanged"),
 agentOpen: event("agentOpen"),
 guestGramChanged: event("guestGramChanged"),
};

/** Sends payload to every listener of name, in subscription order, as Broadcast does. A listener
 *  that throws does not keep the others from hearing it. */
export function emit<K extends EventName>(name: K, payload: Payload<K>): void {
 for (const listener of [...(listeners.get(name) ?? [])]) {
  try { (listener as (payload: Payload<K>) => void)(payload); } catch (error) { console.error(error); }
 }
}
