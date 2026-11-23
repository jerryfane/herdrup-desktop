// The browser build's entry (web/index.html): chooses this load's page (bootChoice.ts) and runs it.
// A guest gets the guest page (main.ts); a signed-in owner the desktop shell itself (../main.ts),
// whose host home is the approved-machines screen (hosts.ts, swapped in by vite.web.config.ts).
// Both pages start themselves when imported and take the same elements, so exactly one may be
// loaded: they are imported dynamically, once the choice is made.

import "core-js/actual/promise/with-resolvers";
import "../style.css";
import "./web.css";
import { Desk, ownerAccess } from "./mygo";
import { boot, choosePage, GUEST_INSTEAD_KEY } from "./bootChoice";

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
 if (page === "guest") { await import("./main"); return; }
 // index.html's html.desk: the desktop shell's own layout rules (style.css's phone layout).
 document.documentElement.classList.add("desk");
 await import("../main");
}

void run();
