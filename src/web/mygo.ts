// src/mygo.ts for the browser build (vite.web.config.ts aliases ./mygo and ../mygo here): the same
// exports, the types re-exported from the generated client so they never drift. Desk is the method
// groups registered in `implemented` below: the guest's and the owner link's core (desk.ts), Gram
// (gram.ts), the account (accountDesk.ts) and saved prompts (prompts.ts). Any other method rejects,
// as there is no Go behind the page, and `name in Desk` is false for it (shellModel.ts deskOffers),
// so the shell hides what needs it. A new group: a module whose object `satisfies Partial<DeskFns>`,
// calling herdr through ownerLink.ts, spread into `implemented`.

import type { Desk as GoDesk, Dictation as GoDictation } from "../mygo";
import { browserEnv, createGuestDesk } from "./desk";
import { gramDesk, guestGramDesk } from "./gram";
import { browserAccountHere, browserAccountPage, createAccountDesk } from "./accountDesk";
import { agentActionsDesk } from "./agentActionsDesk";
import { createSettingsAccountsDesk, startAccountLabels } from "./settingsAccountsDesk";
import { guestsDesk } from "./guestsDesk";
import { createServerUpdateDesk } from "./serverUpdateDesk";
import { terminalsDesk } from "./terminalsDesk";
import { createDesk } from "./createDesk";
import { statementCache } from "./statements";
import { createShareSync } from "./shares";

export type * from "../mygo";
export { events } from "./events";
export { Symbols } from "./symbols";

type DeskFns = typeof GoDesk;

const notAvailable = () => Promise.reject(new Error("Not available in the browser"));
const env = browserEnv();
const here = browserAccountHere(env.identities);
const account = createAccountDesk(browserAccountPage(), here);
// This page's one statement cache: the owner's links and an account-bound share's both draw on it.
const statements = statementCache(account.account);
// The account's shares (a share bound to the account, on every device of it).
const shares = createShareSync(account.account, { storage: here.storage, locks: here.locks, name: here.name, background: true });
const guest = createGuestDesk({ ...env, statements, shares });
const implemented: Partial<Record<keyof DeskFns, unknown>> = { ...gramDesk, ...guestGramDesk, ...guest, ...account.desk, ...account.sync.prompts, ...agentActionsDesk, ...createSettingsAccountsDesk(), ...guestsDesk, ...createServerUpdateDesk(), ...terminalsDesk, ...createDesk };
// The agent rows' account labels (the `accounts` method, accountsChanged) follow the open owner link.
startAccountLabels();
/** This load ended a sign-in (accountDesk.ts): main.ts opens the guest's Settings, where it shows. */
export const signInReturned = account.signInReturned;
/** How this load's sign-in ended, for the page that shows it itself (accountDesk.ts): the invite
 *  that waited for it (start.ts takePendingBind). */
export const signInEnded = account.signInEnded;
/** What owner access (ownerApproval.ts) works with: this page's account session, its statements and
 *  the browser's key. */
export const ownerAccess = { account: account.account, statements, identities: env.identities };
/** This document's one way out (ownerSession.ts PageExit): the owner page, the guest page and the
 *  account's sign-in all leave through it. */
export const pageExit = account.exit;
/** The owner's link to one approved machine at a time (desk.ts connectOwner). */
export const ownerDesk = { connectOwner: guest.connectOwner, disconnectOwner: guest.disconnectOwner, ownerLinkUsable: guest.ownerLinkUsable };

/** Every Desk method: the guest's, else one that rejects. Its shape is the generated client's. */
export const Desk = new Proxy(implemented, {
 get: (target, key) => (typeof key === "string" && key in target ? target[key as keyof DeskFns] : notAvailable),
}) as DeskFns;

/** No dictation in the browser (dictation.ts hides the microphone in this build). */
export const Dictation: typeof GoDictation = {
 start: () => Promise.reject(new Error("Dictation isn't available in the browser.")),
 stop: async () => {},
};
