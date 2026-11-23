// The browser build's entry (web/index.html): chooses this load's page (bootChoice.ts) and runs it.
// A guest gets the guest page (main.ts); a signed-in owner the desktop shell itself (../main.ts),
// whose host home is the approved-machines screen (hosts.ts, swapped in by vite.web.config.ts).
// Both pages start themselves when imported and take the same elements, so exactly one may be
// loaded: they are imported dynamically, once the choice is made.

import "core-js/actual/promise/with-resolvers";
import "../style.css";
import "./web.css";
import { Desk, ownerAccess } from "./mygo";
import { afterLoadFailure, boot, choosePage, GUEST_INSTEAD_KEY, LOAD_RELOAD_KEY } from "./bootChoice";

function takeGuestInstead(): boolean {
 try {
  const asked = sessionStorage.getItem(GUEST_INSTEAD_KEY) !== null;
  sessionStorage.removeItem(GUEST_INSTEAD_KEY);
  return asked;
 } catch { return false; }
}

async function run() {
 boot.guestInstead = takeGuestInstead();
 const page = await choosePage({
  fragment: location.hash !== "",
  guestInstead: boot.guestInstead,
  grant: async () => (await Desk.sharedConnections()).length > 0,
  signedIn: async () => await ownerAccess.account.check() !== null,
 });
 if (page === "guest") await import("./main");
 else {
  // index.html's html.desk: the desktop shell's own layout rules (style.css's phone layout).
  document.documentElement.classList.add("desk");
  await import("../main");
 }
 try { sessionStorage.removeItem(LOAD_RELOAD_KEY); } catch { /* nothing kept, then */ }
}

/** The page's code didn't load: the import rejects, also for Vite's preload errors (a stylesheet
 *  of the chunk, "Unable to preload CSS"), which Vite throws on after its vite:preloadError event
 *  unless a listener cancels it. Reload once (afterLoadFailure), else say so on the plain screen
 *  with a way to reload. The browser build has no error log of its own (Desk.reportPageError is
 *  the desktop's): the console has it. */
function loadFailed(error: unknown) {
 console.error("herdrup: the page didn't load", error);
 let reloadedAt: number | null = null;
 try { const kept = Number(sessionStorage.getItem(LOAD_RELOAD_KEY)); if (kept > 0) reloadedAt = kept; } catch { /* storage unavailable */ }
 if (afterLoadFailure(reloadedAt, Date.now()) === "reload") {
  try { sessionStorage.setItem(LOAD_RELOAD_KEY, String(Date.now())); location.reload(); return; } catch { /* can't keep the guard: explain instead */ }
 }
 const card = document.createElement("div"); card.className = "web-welcome-card"; card.setAttribute("role", "alert");
 const title = document.createElement("h1"); title.textContent = "HerdrUp didn't load";
 const text = document.createElement("p"); text.textContent = "Part of this page couldn't be downloaded. Check the connection, then reload.";
 const reload = document.createElement("button"); reload.type = "button"; reload.className = "web-owner-action web-owner-primary"; reload.textContent = "Reload";
 reload.onclick = () => location.reload();
 card.append(title, text, reload);
 const screen = document.getElementById("welcome")!;
 screen.replaceChildren(card); screen.hidden = false;
 document.body.classList.add("web-welcome-visible");
}

run().catch(loadFailed);
