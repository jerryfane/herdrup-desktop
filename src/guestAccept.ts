import { Desk, events } from "./mygo";
import type { GuestInvitation } from "./mygo";
import { errorText } from "./errors";
import { grantKey } from "./grantKey";
import { providerButtons } from "./herdrupAccount";
import { showAccountShareNotice } from "./notices";
import "./guest.css";
import { scanQR } from "./qrScanner";
import "./pairing.css";

export function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") { const el = document.createElement(tag); el.className = cls; el.textContent = text; return el; }
export function action(text: string, run: () => void) { const el = node("button", "", text); el.type = "button"; el.onclick = run; return el; }
export function details(entries: [string, string][]) {
 const card = node("dl", "guest-card");
 for (const [key, value] of entries) { const row = node("div", "guest-key-value"); row.append(node("dt", "", key), node("dd", "", value)); card.append(row); }
 return card;
}
let active: HTMLDialogElement | null = null;

/** Where an accepted share is kept (acceptGuestInvitation's keep): the HerdrUp account, so every
 *  device signed in to it has it, or this device only. */
export type Keep = "account" | "device";

/** The choices under a reviewed invitation (#700, owner pick A, frames opt-a-g1d/g2d). A plain
 *  invite: Accept, as before. One that offers the account, signed in: "Signed in as …", then "Only
 *  this device" or "Add to my account". Signed out: "Keep it on all your devices" with the
 *  service's sign-in (Apple, Google), which accepts into the account once signed in, or "Only this
 *  device". With no sign-in offered, the plain Accept. redeem accepts, given the pressed button;
 *  report shows a failure; dispose stops waiting for a sign-in. hooks: the browser's sign-in
 *  leaves the page, so it keeps the invite first (before: false keeps the page, as a failure the
 *  caller reports) and lets it go again if the sign-in fails to start (failed). */
export async function acceptChoices(invite: Pick<GuestInvitation, "account">, redeem: (keep: Keep, pressed: HTMLButtonElement) => void, report: (failure: unknown) => void,
 hooks: { before?(): boolean; failed?(): void } = {}) {
 const root = node("div", "guest-choices");
 const buttons: HTMLButtonElement[] = [];
 let stop = () => {};
 const choice = (text: string, cls: string, keep: Keep) => { const button = action(text, () => redeem(keep, button)); button.className = cls; buttons.push(button); return button; };
 const done = { root, buttons, dispose: () => stop() };
 const plain = () => { root.append(choice("Accept", "", "device")); return done; };
 if (!invite.account) return plain();
 const state = await Desk.accountState().catch(() => null);
 if (state?.signedIn) {
  const pair = node("div", "guest-choice-pair");
  pair.append(choice("Only this device", "button-secondary button-large", "device"), choice("Add to my account", "button-filled button-large", "account"));
  if (state.displayHint) root.append(node("p", "guest-note guest-choice-account", `Signed in as ${state.displayHint}`));
  root.append(pair);
  return done;
 }
 const providers = await Desk.accountProviders().catch(() => [] as string[]);
 if (providers.length === 0) return plain();
 const waiting = node("p", "guest-note"); waiting.setAttribute("role", "status"); waiting.hidden = true;
 const pair = node("div", "guest-choice-pair");
 const signIn = providerButtons(providers, (provider, pressed) => {
  if (hooks.before && !hooks.before()) return;
  for (const button of buttons) button.disabled = true;
  waiting.textContent = "Finish signing in in your browser."; waiting.hidden = false;
  stop();
  const off = events.accountChanged.on(next => {
   if (!next.signedIn) return;
   stop(); waiting.hidden = true;
   redeem("account", pressed);
  });
  stop = () => { off(); stop = () => {}; };
  Desk.accountSignIn(provider).catch((failure: unknown) => {
   stop(); waiting.hidden = true;
   for (const button of buttons) button.disabled = false;
   hooks.failed?.();
   report(failure);
  });
 });
 buttons.push(...signIn);
 pair.append(...signIn);
 root.append(node("p", "guest-choice-label", "Keep it on all your devices"), pair, choice("Only this device", "button-secondary button-large guest-choice-wide", "device"), waiting);
 return done;
}

export function showGuestScan(saved: () => Promise<void>, opened: () => void) {
 active?.close();
 const sheet = node("dialog", "settings-sheet pairing-sheet");
 active = sheet;
 let disposed = false, stopCamera: (() => void) | undefined;
 const stop = () => { stopCamera?.(); stopCamera = undefined; };
 const header = node("header", "settings-sheet-header");
 const title = node("h2", "", "Scan invite"); title.id = "guest-scan-title";
 sheet.setAttribute("aria-labelledby", title.id);
 header.append(title, action("Cancel", () => { stop(); sheet.close(); }));
 const content = node("div", "pairing-content"); content.setAttribute("aria-live", "polite");
 function start() {
  if (disposed || !sheet.open) return;
  stop();
  const camera = node("div", "pairing-camera"), video = node("video");
  video.muted = true; video.playsInline = true; video.autoplay = true;
  video.setAttribute("aria-label", "Invitation code camera");
  const frame = node("div", "pairing-guide"); frame.setAttribute("aria-hidden", "true");
  camera.append(video, frame);
  content.replaceChildren(camera, node("p", "", "Point the camera at the invitation code shared by the owner."));
  stopCamera = scanQR(video, text => {
   if (disposed || !sheet.open) return;
   stop(); sheet.close();
   showGuestAccept(saved, opened, text);
  }, message => {
   if (disposed || !sheet.open) return;
   stop();
   content.replaceChildren(node("h3", "", "Can't use the camera"), node("p", "", message), action("Try again", start));
  });
 }
 sheet.append(header, content);
 sheet.addEventListener("cancel", stop);
 sheet.addEventListener("close", () => { disposed = true; stop(); if (active === sheet) active = null; sheet.remove(); }, { once: true });
 document.body.append(sheet); sheet.showModal(); start();
}

/** A reviewed invitation's words (the sheet's, and the browser's bind choice, web/bindChoice.ts):
 *  who shared which agent, what the guest gets, and how they appear. */
export function inviteReview(invite: Omit<GuestInvitation, "account" | "expires">): HTMLElement[] {
 const summary = details([["Machine", invite.machineLabel], ["Agent", invite.agentName], ["You appear as", invite.guestName]]);
 return [node("h3", "guest-hero", `${invite.ownerName} shared ${invite.agentName} with you`), node("p", "", "You can use this agent, not the owner's other agents or machines."), summary,
  node("p", "guest-note", `Every message you send reaches ${invite.agentName} starting with “${invite.guestName} (via HerdrUp):”. ${invite.ownerName} can see what you send and can remove access at any time.`),
  node("p", "guest-note", `This device's key: ${invite.fingerprint}`)];
}
export function showGuestAccept(saved: () => Promise<void>, opened: () => void, initialText = "") {
 active?.close();
 const sheet = node("dialog", "settings-sheet guest-accept"); active = sheet;
 const header = node("header", "settings-sheet-header"); const title = node("h2", "", "Shared invitation"); title.id = "guest-accept-title"; sheet.setAttribute("aria-labelledby", title.id);
 const cancel = action("Not now", () => sheet.close()); header.append(title, cancel);
 const content = node("div", "guest-content"); const error = node("p", "guest-error"); error.setAttribute("role", "alert");
 const input = node("textarea"); input.placeholder = "Paste the invitation link sent by the owner"; input.setAttribute("aria-label", "Invitation link"); input.value = initialText; input.autocomplete = "off"; input.spellcheck = false;
 let busy = false, disposed = false;
 const report = (failure: unknown) => { if (!disposed) error.textContent = errorText(failure); };
 let stopChoices = () => {};
 const inspect = async () => {
  if (busy || disposed) return; busy = true; error.textContent = ""; review.disabled = true;
  try {
   // Accept redeems exactly the reviewed text; an edit while it was being read makes this review stale.
   const reviewed = input.value;
   const invite = await Desk.inspectGuestInvitation(reviewed);
   if (disposed || input.value !== reviewed) return;
   const choices = await acceptChoices(invite, (keep, pressed) => { void redeem(keep, pressed); }, report);
   if (disposed || input.value !== reviewed) { choices.dispose(); return; }
   stopChoices(); stopChoices = choices.dispose;
   content.replaceChildren(...inviteReview(invite), choices.root);
   async function redeem(keep: Keep, pressed: HTMLButtonElement) {
    if (busy || disposed) return; busy = true; cancel.disabled = true; error.textContent = "";
    const label = [...pressed.childNodes];
    for (const button of choices.buttons) button.disabled = true;
    pressed.textContent = "Accepting…";
    try {
     const access = await Desk.acceptGuestInvitation(reviewed, keep);
     input.value = ""; await saved();
     if (disposed) return;
     const inAccount = keep === "account" && access.accountBound === true;
     content.replaceChildren(node("h3", "guest-hero", "Access accepted"), node("p", "", inAccount ? `${access.agentName} is in your HerdrUp account.` : `${access.agentName} is saved on this device.`), action("Open shared agent", () => {
      void Desk.connectGuest(grantKey(access)).then(() => { sheet.close(); opened(); }).catch(report);
     }));
     if (inAccount) showAccountShareNotice(access.agentName);
    } catch (failure) {
     report(failure); pressed.replaceChildren(...label);
     for (const button of choices.buttons) button.disabled = false;
    }
    finally { busy = false; cancel.disabled = false; }
   }
  } catch (failure) { report(failure); }
  finally { busy = false; review.disabled = false; }
 };
 const review = action("Review invitation", () => { void inspect(); });
 content.append(input, review); sheet.append(header, content, error);
 sheet.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
 sheet.addEventListener("close", () => { disposed = true; stopChoices(); input.value = ""; if (active === sheet) active = null; sheet.remove(); }, { once: true });
 document.body.append(sheet); sheet.showModal(); input.focus();
 if (initialText) void inspect();
}
