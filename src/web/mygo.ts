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
import { browserAccountPage, createAccountDesk } from "./accountDesk";
import { createPromptsDesk } from "./prompts";
import { agentActionsDesk } from "./agentActionsDesk";
import { createSettingsAccountsDesk, startAccountLabels } from "./settingsAccountsDesk";
import { guestsDesk } from "./guestsDesk";
import { createServerUpdateDesk } from "./serverUpdateDesk";

export type * from "../mygo";
export { events } from "./events";
export { Symbols } from "./symbols";

type DeskFns = typeof GoDesk;

const notAvailable = () => Promise.reject(new Error("Not available in the browser"));
const account = createAccountDesk(browserAccountPage());
const env = browserEnv();
const guest = createGuestDesk(env);
const implemented: Partial<Record<keyof DeskFns, unknown>> = { ...gramDesk, ...guestGramDesk, ...guest, ...account.desk, ...createPromptsDesk(), ...agentActionsDesk, ...createSettingsAccountsDesk(), ...guestsDesk, ...createServerUpdateDesk() };
// The agent rows' account labels (the `accounts` method, accountsChanged) follow the open owner link.
startAccountLabels();
/** This load ended a sign-in (accountDesk.ts): main.ts opens the guest's Settings, where it shows. */
export const signInReturned = account.signInReturned;
/** What owner access (ownerApproval.ts) works with: this page's account session and the browser's key. */
export const ownerAccess = { account: account.account, identities: env.identities };
/** The owner's link to one approved machine at a time (desk.ts connectOwner). */
export const ownerDesk = { connectOwner: guest.connectOwner, disconnectOwner: guest.disconnectOwner };

/** Every Desk method: the guest's, else one that rejects. Its shape is the generated client's. */
export const Desk = new Proxy(implemented, {
 get: (target, key) => (typeof key === "string" && key in target ? target[key as keyof DeskFns] : notAvailable),
}) as DeskFns;

/** No dictation in the browser (dictation.ts hides the microphone in this build). */
export const Dictation: typeof GoDictation = {
 start: () => Promise.reject(new Error("Dictation isn't available in the browser.")),
 stop: async () => {},
};
