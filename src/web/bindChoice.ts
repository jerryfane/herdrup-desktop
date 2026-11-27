// The invite landing's "Add to my account" in a signed-out browser (#700, start.ts "signIn" and
// "bind"). The web sign-in leaves the page and comes back to a fixed /web/?account=1, so the
// invite waits in this tab (start.ts PENDING_BIND_KEY) while it is away; the next load takes it.
// The choice is the shared invitation's (guestAccept.ts: its words, then acceptChoices' Apple,
// Google and "Only this device"), on the page's welcome card.

import { Desk } from "../mygo";
import { acceptChoices, inviteReview, node, type Keep } from "../guestAccept";
import { errorText } from "../errors";
import { acceptInvite, clearPendingBind, inviteText, savePendingBind, type BindProvider, type Started, type TabStorage } from "./start";

/** What the choice needs from the page. opening: the page's "Opening the invitation…" while an
 *  accept runs; done: how it ended, the share opened, or its invite failed (the plain screen, with
 *  why). */
export interface BindPage {
 origin: string;
 storage(): TabStorage;
 owner(): string | null;
 show(card: HTMLElement): void;
 opening(): void;
 done(started: Started): void;
}

const CANT_KEEP = "This browser can't hold the invitation while you sign in. Choose Only this device to keep it here.";

/** The landing named provider: the invite is kept, and that sign-in leaves the page, with no screen
 *  first. One this page doesn't offer, a tab that can't keep the invite, or a sign-in that can't
 *  start asks instead (showBindChoice). */
export async function signInToBind(payload: string, provider: BindProvider, page: BindPage): Promise<void> {
 const offered = await Desk.accountProviders().catch(() => [] as string[]);
 if (!offered.includes(provider)) return showBindChoice(payload, "", page);
 if (!savePendingBind(page.storage, payload)) return showBindChoice(payload, CANT_KEEP, page);
 try {
  await Desk.accountSignIn(provider);
 } catch (failure) {
  clearPendingBind(page.storage);
  return showBindChoice(payload, errorText(failure), page);
 }
}

/** The invitation's words and its choices: a sign-in keeps the invite and leaves (it comes back as
 *  an account accept, start.ts), "Only this device" accepts it on this browser. problem: how the
 *  last sign-in for it ended ("" for nothing to say). An invite that can't be read is the plain
 *  screen's failure. */
export async function showBindChoice(payload: string, problem: string, page: BindPage): Promise<void> {
 let invite;
 try {
  invite = await Desk.inspectGuestInvitation(inviteText(payload, page.origin));
 } catch (failure) {
  clearPendingBind(page.storage);
  page.done({ kind: "welcome", welcome: { owner: page.owner(), error: errorText(failure) } });
  return;
 }
 const error = node("p", "web-welcome-error", problem); error.setAttribute("role", "alert"); error.hidden = problem === "";
 const report = (failure: unknown) => { error.textContent = errorText(failure); error.hidden = false; };
 const card = node("div", "web-welcome-card web-bind-choice");
 let busy = false;
 const choices = await acceptChoices({ account: true }, keep => { void redeem(keep); }, report, {
  before: () => {
   if (savePendingBind(page.storage, payload)) { error.hidden = true; return true; }
   report(new Error(CANT_KEEP));
   return false;
  },
  failed: () => clearPendingBind(page.storage),
 });
 async function redeem(keep: Keep) {
  if (busy) return; busy = true; error.hidden = true;
  clearPendingBind(page.storage);
  page.opening();
  try {
   const started = await acceptInvite(Desk, payload, page.origin, keep);
   choices.dispose();
   page.done(started);
  } catch (failure) {
   report(failure);
   page.show(card);
  } finally { busy = false; }
 }
 card.append(...inviteReview(invite), error, choices.root);
 page.show(card);
}
