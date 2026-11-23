// What the desktop shell (main.ts and its screens) decides differently in the browser, where it is
// the web owner's shell over an approved machine's owner link (web/boot.ts, web/hosts.ts). Each
// takes `browser` (platform.ts webGuest, the build's mode) so the desktop's answer stays what it
// was, which the tests hold.

import { Desk, type ConnState } from "./mygo";
import { webGuest } from "./platform";

/** Whether this build's Desk has every one of methods. The desktop's has them all; the browser's
 *  only the method groups web/mygo.ts registers, so a screen gated on its group's methods shows
 *  once that group is registered (web/mygo.ts). */
export function deskOffers(...methods: (keyof typeof Desk)[]): boolean {
  return methods.every(method => method in Desk);
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

/** Whether this connection may create, rename, close or administer (herdr#510): on the desktop the
 *  owner always may; a web owner's link only under a terminal-scope grant. */
export function ownerWrites(state: Pick<ConnState, "guest">, browser = webGuest): boolean {
  return !browser || state.guest?.ownerScope === "terminal";
}

/** Whether the agent page offers "Share with someone" (guest.invite.create): on the desktop for the
 *  owner's agents, never in a share; in the browser (where every agent page is an owner link's,
 *  `guest` true) under a terminal-scope grant once the guests group is registered (herdr#510). */
export function sharesAgent(guest: boolean, ownerScope: string | undefined, browser = webGuest): boolean {
  return browser ? ownerScope === "terminal" && deskOffers("createGuestInvite") : !guest;
}
