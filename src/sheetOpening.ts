// One opening of an agent sheet (Rename, Restart, Swap, Avatar…, the Topics switch, Switch harness):
// the page opens one with the menu's request (the event's payload, with the browser menu's
// SheetSelection in its `sheet`), and makes every Desk call of that dialog through the opening's
// own methods, already bound to its agent. It shows its dialog only if show() still says yes,
// starts it when its action begins (confirmed), and releases it when the dialog closes or is
// cancelled.
//
// Two ways one opening replaces another of the same sheet (kind and agent), kept apart:
// - a newer menu SELECTION replaces an older opening that hasn't shown its dialog yet (its lookups
//   before the dialog, Switch harness's): those lookups end, and show() says no, checked once more
//   right before the dialog shows;
// - the RESULT of an action belongs to the opening that started it (confirmed): a later one started
//   takes it over, and the older's result no longer counts; a selection alone, or one cancelled,
//   takes nothing (the Topics switch's banner stays with the restart under way).
// An opening that has lost its result publishes nothing, whatever else is true: its calls end as
// superseded (which the page keeps quiet about) even once its machine changed too. Only one that
// still owns its result reports its machine changing (the stale error, which the sheet shows).
//
// The desktop's Desk needs none of this (its sheets act on the one machine Go has open): its opening
// calls the Desk it is given. The browser Desk (web/agentActionsDesk.ts) puts its own in place,
// bound to the machine its selection was made on.

import type { AvatarChoice, Desk, TopicsSwitched } from "./mygo";

/** A menu's choice of a sheet of kind for the agent paneID, made by the browser's menu
 *  (web/agentActionsDesk.ts, its own subclass) and carried in the event it sends. A plain object of
 *  the same shape is not one. The desktop's events carry none. */
export abstract class SheetSelection {
  private declare readonly selection: never;
  protected constructor(readonly kind: string, readonly paneID: string) {}
}

/** A sheet's request as the page receives it: the event's payload, and in the browser the
 *  selection its menu made (web/events.ts BrowserPayloads; a copy of the payload carries it too).
 *  The desktop's carry none. */
export interface SheetRequest {
  readonly paneID: string;
  readonly sheet?: SheetSelection | null;
}

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
  /** The opening of a sheet of kind for request (the menu event's payload). */
  open(desk: SheetDesk, kind: string, request: SheetRequest): SheetOpening;
}

const desktop: SheetOpenings = {
  open: (desk, _kind, { paneID }) => ({
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

/** The opening of a sheet of kind for the menu request that asked for it. */
export function openSheet(desk: SheetDesk, kind: string, request: SheetRequest): SheetOpening {
  return openings.open(desk, kind, request);
}
