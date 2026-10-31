import { Desk } from "./mygo";
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
export function showGuestAccept(saved: () => Promise<void>, opened: () => void, initialText = "") {
 active?.close();
 const sheet = node("dialog", "settings-sheet guest-accept"); active = sheet;
 const header = node("header", "settings-sheet-header"); const title = node("h2", "", "Shared invitation"); title.id = "guest-accept-title"; sheet.setAttribute("aria-labelledby", title.id);
 const cancel = action("Not now", () => sheet.close()); header.append(title, cancel);
 const content = node("div", "guest-content"); const error = node("p", "guest-error"); error.setAttribute("role", "alert");
 const input = node("textarea"); input.placeholder = "Paste the invitation link sent by the owner"; input.setAttribute("aria-label", "Invitation link"); input.value = initialText; input.autocomplete = "off"; input.spellcheck = false;
 let busy = false, disposed = false;
 const report = (failure: unknown) => { if (!disposed) error.textContent = String(failure); };
 const inspect = async () => {
  if (busy || disposed) return; busy = true; error.textContent = ""; review.disabled = true;
  try {
   const invite = await Desk.inspectGuestInvitation(input.value);
   if (disposed) return;
   const accept = action("Accept", () => { void redeem(); });
   const summary = details([["Machine", invite.machineLabel], ["Agent", invite.agentName], ["You appear as", invite.guestName]]);
   content.replaceChildren(node("h3", "guest-hero", `${invite.ownerName} shared ${invite.agentName} with you`), node("p", "", "You can use this agent, not the owner's other agents or machines."), summary,
    node("p", "guest-note", `Every message you send reaches ${invite.agentName} starting with “${invite.guestName} (via HerdrUp):”. ${invite.ownerName} can see what you send and can remove access at any time.`),
    node("p", "guest-note", `This device's key: ${invite.fingerprint}`), accept);
   async function redeem() {
    if (busy || disposed) return; busy = true; cancel.disabled = true; accept.disabled = true; accept.textContent = "Accepting…"; error.textContent = "";
    try {
     const access = await Desk.acceptGuestInvitation(input.value);
     input.value = ""; await saved();
     if (disposed) return;
     content.replaceChildren(node("h3", "guest-hero", "Access accepted"), node("p", "", `${access.agentName} is saved on this device.`), action("Open shared agent", () => {
      void Desk.connectGuest(`${access.endpoint.hostID}/${access.guestID}`).then(() => { sheet.close(); opened(); }).catch(report);
     }));
    } catch (failure) { report(failure); accept.disabled = false; accept.textContent = "Accept"; }
    finally { busy = false; cancel.disabled = false; }
   }
  } catch (failure) { report(failure); }
  finally { busy = false; review.disabled = false; }
 };
 const review = action("Review invitation", () => { void inspect(); });
 content.append(input, review); sheet.append(header, content, error);
 sheet.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
 sheet.addEventListener("close", () => { disposed = true; input.value = ""; if (active === sheet) active = null; sheet.remove(); }, { once: true });
 document.body.append(sheet); sheet.showModal(); input.focus();
 if (initialText) void inspect();
}
