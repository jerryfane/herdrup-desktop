// The browser build's entry (web/index.html): chooses this load's page (bootChoice.ts) and runs it.
// A guest gets the guest page (main.ts); a signed-in owner the desktop shell itself (../main.ts),
// whose host home is the approved-machines screen (hosts.ts, swapped in by vite.web.config.ts).
// Both pages start themselves when imported and take the same elements, so exactly one may be
// loaded: they are imported dynamically, once the choice is made.

import "core-js/actual/promise/with-resolvers";
import "../style.css";
import "./web.css";
import { Desk, ownerAccess } from "./mygo";
import { ACCOUNT_LOOKUP_MS, boot, bootMarks, loadPage, signedInBefore } from "./bootChoice";
import { pendingBindWaits } from "./start";

const marks = bootMarks();

/** The plain screen's card (#welcome, the guest page's welcome), shown over everything. */
function showCard(...parts: HTMLElement[]): HTMLElement {
 const card = document.createElement("div"); card.className = "web-welcome-card";
 card.append(...parts);
 const screen = document.getElementById("welcome")!;
 screen.replaceChildren(card); screen.hidden = false;
 document.body.classList.add("web-welcome-visible");
 return card;
}
function line<K extends "h1" | "p">(tag: K, text: string) { const e = document.createElement(tag); e.textContent = text; return e; }
function action(text: string, cls: string, run: () => void) {
 const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = text; b.onclick = run; return b;
}

/** While the account service is asked whether this browser is signed in (the one wait that is the
 *  network's): the page says so at once, with the guest's way, and waits ACCOUNT_LOOKUP_MS at most. */
async function signedIn(): Promise<boolean> {
 const guest = Promise.withResolvers<void>();
 showCard(line("h1", "Opening HerdrUp"), line("p", "Checking your HerdrUp account…"),
  action("Use a guest invitation instead", "web-owner-action", () => { boot.guestInstead = true; marks.chooseGuest(); guest.resolve(); }));
 const waited = Promise.withResolvers<void>();
 setTimeout(waited.resolve, ACCOUNT_LOOKUP_MS);
 return signedInBefore(ownerAccess.account.check().then(s => s !== null), waited.promise, guest.promise);
}

/** This load's page (loadPage: the choice, then its code). The page draws its own screens: the
 *  boot card goes before it is imported. */
async function run() {
 boot.guestInstead = marks.guestInstead();
 const outcome = await loadPage(marks, {
  fragment: location.hash !== "" || pendingBindWaits(() => sessionStorage),
  guestInstead: boot.guestInstead,
  grant: async () => (await Desk.sharedConnections()).length > 0,
  signedIn,
 }, async page => {
  const screen = document.getElementById("welcome")!;
  screen.hidden = true; screen.replaceChildren(); document.body.classList.remove("web-welcome-visible");
  if (page === "guest") await import("./main");
  else {
   // index.html's html.desk: the desktop shell's own layout rules (style.css's phone layout).
   document.documentElement.classList.add("desk");
   await import("../main");
  }
 }, error => console.error("herdrup: the page didn't load", error));
 if (outcome === "reload") location.reload();
 else if (outcome === "explain") loadFailed();
}

/** The page's code didn't load, and its one automatic reload was spent: the import rejects, also
 *  for Vite's preload errors (a stylesheet of the chunk, "Unable to preload CSS"), which Vite
 *  throws on after its vite:preloadError event unless a listener cancels it. Say so on the plain
 *  screen, whose Reload starts a new attempt (to the same page: the way to it holds). The browser
 *  build has no error log of its own (Desk.reportPageError is the desktop's): the console has it. */
function loadFailed() {
 document.documentElement.classList.remove("desk");
 showCard(line("h1", "HerdrUp didn't load"), line("p", "Part of this page couldn't be downloaded. Check the connection, then reload."),
  action("Reload", "web-owner-action web-owner-primary", () => { marks.newAttempt(); location.reload(); })).setAttribute("role", "alert");
}

void run();
