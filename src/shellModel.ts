// What the desktop shell (main.ts and its screens) decides differently in the browser, where it is
// the web owner's shell over an approved machine's owner link (web/boot.ts, web/hosts.ts). Each
// takes `browser` (platform.ts webGuest, the build's mode) so the desktop's answer stays what it
// was, which the tests hold.

import { Desk, type BoardUpdate, type ConnState } from "./mygo";
import { webGuest } from "./platform";
import { ACCESS_CHOICES, choiceLabel } from "./webAccessModel";

/** Whether this build's Desk has every one of methods. The desktop's has them all; the browser's
 *  only the method groups web/mygo.ts registers, so a screen gated on its group's methods shows
 *  once that group is registered (web/mygo.ts). A Desk given first is asked instead (a screen
 *  handed its Desk: herdrupAccount.ts). */
export function deskOffers(...methods: (keyof typeof Desk)[]): boolean;
export function deskOffers(desk: object, ...methods: (keyof typeof Desk)[]): boolean;
export function deskOffers(...args: (object | keyof typeof Desk)[]): boolean {
  const desk = typeof args[0] === "object" ? args.shift() as object : Desk;
  return args.every(method => (method as string) in desk);
}

/** The desktop-only parts of the shell; the browser has none of them. */
export interface ShellParts {
  /** The session pills under the search (herdr sessions listed over SSH). */
  sessionPills: boolean;
  /** Herdrup Desktop updating itself: the watch, the ask over the list, Settings' row and badge. */
  appUpdates: boolean;
  /** The ask to star the repository over the agents list. */
  starAsk: boolean;
  /** "Share anonymous usage count" (Go keeps the install ID). */
  usageCount: boolean;
  /** Settings' federation of saved SSH machines. */
  federation: boolean;
}

export function shellParts(browser: boolean): ShellParts {
  const desktop = !browser;
  return { sessionPills: desktop, appUpdates: desktop, starAsk: desktop, usageCount: desktop, federation: desktop };
}

/** This build's parts. */
export const parts = shellParts(webGuest);

/** Whether the window shows a share (the guest home) rather than the owner's machine. On the desktop
 *  a guest connection is a share. In the browser the shell is the owner's only (a guest gets the
 *  guest page, web/main.ts): its owner links carry a GuestConnection for the agent page (the scope,
 *  paused, reconnecting) but are never a share. */
export function shareShown(state: Pick<ConnState, "guest">, browser = webGuest): boolean {
  return !browser && !!state.guest;
}

/** Whether next is another connection than previous: another share, or another of a web owner's
 *  machines (each link publishes its own GuestConnection). The board on screen goes when it is the
 *  previous connection's (boardOf): the new one shows its loading or its failure until its first
 *  list. One that is already the new connection's stays: the desktop publishes a saved machine's
 *  cached board before it says it is connecting. */
export function connectionChanged(previous: Pick<ConnState, "guest">, next: Pick<ConnState, "guest">): boolean {
  return next.guest?.access.guestID !== previous.guest?.access.guestID || next.guest?.access.endpoint.hostID !== previous.guest?.access.endpoint.hostID;
}

/** Whether board is the connection's state describes, by the link id every board carries
 *  (BoardUpdate.machineID, Go's and the browser's link.id alike): a share's
 *  "guest:<hostID>/<guestID>" (guest.Access.ID), a web owner's machine "owner:<hostID>", a saved
 *  SSH machine's its own id (a connection with no guest). */
export function boardOf(state: Pick<ConnState, "guest">, board: Pick<BoardUpdate, "machineID">): boolean {
  const g = state.guest;
  if (!g) return !board.machineID.startsWith("guest:") && !board.machineID.startsWith("owner:");
  const host = g.access.endpoint.hostID;
  return board.machineID === `guest:${host}/${g.access.guestID}` || board.machineID === `owner:${host}`;
}

/** The board the shell keeps as the connection goes from previous to next: none when it is the
 *  previous connection's (connectionChanged), else the one it has. */
export function boardAfter<B extends Pick<BoardUpdate, "machineID">>(previous: Pick<ConnState, "guest">, next: Pick<ConnState, "guest">, board: B | null): B | null {
  return board !== null && connectionChanged(previous, next) && boardOf(previous, board) ? null : board;
}

/** Whether this connection may create, rename, close or administer (herdr#510): on the desktop the
 *  owner always may; a web owner's link only under a terminal-scope grant. */
export function ownerWrites(state: Pick<ConnState, "guest">, browser = webGuest): boolean {
  return !browser || state.guest?.ownerScope === "terminal";
}

/** Settings → Machines' Access in a browser: the scope the live link was admitted under, not the
 *  saved approval's (a renewal may admit the same link under another scope); "Checking…" while
 *  it connects or before its scope is known; null with no link (nothing to say). */
export function admittedAccess(state: Pick<ConnState, "phase" | "guest"> | null): string | null {
  if (state?.phase !== "connected" && state?.phase !== "connecting") return null;
  const scope = state.guest?.ownerScope;
  return scope ? choiceLabel(ACCESS_CHOICES, scope) : "Checking…";
}

/** Whether the agent page offers "Share with someone" (guest.invite.create): on the desktop for the
 *  owner's agents, never in a share; in the browser (where every agent page is an owner link's,
 *  `guest` true) under a terminal-scope grant once the guests group is registered (herdr#510). */
export function sharesAgent(guest: boolean, ownerScope: string | undefined, browser = webGuest): boolean {
  return browser ? ownerScope === "terminal" && deskOffers("createGuestInvite") : !guest;
}
