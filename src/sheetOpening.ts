// One opening of an agent sheet (Rename, Restart, Swap, Avatar…, the Topics switch, Switch harness):
// the page opens one with the menu's request (the event's payload, as received), and makes every
// Desk call of that dialog through the opening's own methods, already bound to its agent. It shows
// its dialog only if show() still says yes, starts it when its action begins (confirmed), and
// releases it when the dialog closes or is cancelled.
//
// Two ways one opening replaces another of the same sheet (kind and agent), kept apart:
// - a newer menu SELECTION replaces an older opening that hasn't shown its dialog yet (its lookups
//   before the dialog, Switch harness's): those lookups end, and show() says no, checked once more
//   right before the dialog shows;
// - the RESULT of an action belongs to the opening that started it (confirmed): a later one started
//   takes it over, and the older's result no longer counts; a selection alone, or one cancelled,
//   takes nothing (the Topics switch's banner stays with the restart under way).
//
// The desktop's Desk needs none of this (its sheets act on the one machine Go has open): its opening
// calls the Desk it is given. The browser Desk (web/agentActionsDesk.ts) puts its own in place,
// bound to the machine the item was chosen on.

import type { AvatarChoice, Desk, TopicsSwitched } from "./mygo";

type DeskFns = typeof Desk;
/** The Desk calls a sheet makes. */
export type SheetDesk = Pick<DeskFns, "renameAgent" | "restartAgent" | "setAgentAvatar" | "topicsSetEnabled" | "transferAccounts"
  | "transferAgentInfo" | "prepareSessionTransfer" | "confirmSessionTransfer">;

export interface SheetOpening {
  /** Whether the dialog may show now: no once a newer selection of this sheet replaced it. */
  show(): boolean;
  /** The sheet's action begins (confirmed): this opening now owns its sheet's result. */
  start(): void;
  /** The sheet closed or was cancelled: nothing more comes from it. */
  release(): void;
  renameAgent(name: string): Promise<string>;
  restartAgent(accountID: string): Promise<void>;
  setAgentAvatar(c: AvatarChoice): Promise<void>;
  topicsSetEnabled(enabled: boolean): Promise<TopicsSwitched>;
  transferAccounts(): Promise<string>;
  transferAgentInfo(terminalID: string): Promise<string>;
  prepareSessionTransfer(to: string, accountID: string): Promise<string>;
  confirmSessionTransfer(to: string, accountID: string, transferID: string): Promise<string>;
}

export interface SheetOpenings {
  /** The opening of a sheet of kind for paneID, for request: the menu event's payload as received. */
  open(desk: SheetDesk, kind: string, paneID: string, request: object): SheetOpening;
}

const desktop: SheetOpenings = {
  open: (desk, _kind, paneID) => ({
    show: () => true, start() {}, release() {},
    renameAgent: (name) => desk.renameAgent(paneID, name),
    restartAgent: (accountID) => desk.restartAgent(paneID, accountID),
    setAgentAvatar: (c) => desk.setAgentAvatar(paneID, c),
    topicsSetEnabled: (enabled) => desk.topicsSetEnabled(paneID, enabled),
    transferAccounts: () => desk.transferAccounts(),
    transferAgentInfo: (terminalID) => desk.transferAgentInfo(paneID, terminalID),
    prepareSessionTransfer: (to, accountID) => desk.prepareSessionTransfer(paneID, to, accountID),
    confirmSessionTransfer: (to, accountID, transferID) => desk.confirmSessionTransfer(paneID, to, accountID, transferID),
  }),
};
let openings = desktop;

/** For the browser Desk only: its openings, in place of the desktop's. */
export function setSheetOpenings(o: SheetOpenings): void { openings = o; }

/** The opening of a sheet of kind for paneID, for the menu request that asked for it. */
export function openSheet(desk: SheetDesk, kind: string, paneID: string, request: object): SheetOpening {
  return openings.open(desk, kind, paneID, request);
}
