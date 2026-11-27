// Pre-shell bootstrap for browser guest visits (invite fragments, OAuth bind return, saved grants,
// and signed-out welcome): as soon as a share connects, this hands off to the unified desktop shell
// (../main.ts, html.desk) so guests get the exact same resizable sidebar, top bar, combined shared
// agent list, Gram, and Settings as owners.

import { Desk, events } from "../mygo";
import { symbol } from "../symbol";
import { spinnerSVG } from "../faces";
import { COMPOSER_TEXT_OFFSET, COMPOSER_TEXT_PITCH } from "../composerMetrics";
import { applyMotions } from "../motion";
import { errorText } from "../errors";
import { localOwnerHint } from "./storage";
import { plainWelcome, start, startAccount, takeFragment, takePendingBind, welcome, type Started, type WelcomeState } from "./start";
import { showBindChoice, signInToBind, type BindPage } from "./bindChoice";
import { showAccountNotice } from "../notices";
import { boundNotice } from "./shares";
import { ACCOUNT_TITLE, AccountWelcome, HerdrUpAccountPanel } from "../herdrupAccount";
import { ownerAccess, pageExit, signInEnded } from "./mygo";
import { ACCOUNT_LOOKUP_MS, boot, bootMarks, signInFirst } from "./bootChoice";
import { sharedMachines, sharedSection, syncedSharesNow } from "../sharedWithYou";

// The invitation leaves the address bar before anything else runs (contract Flow 3).
const payload = takeFragment(location, history);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const welcomeView = $("welcome");

let shownWelcome: WelcomeState | null = null;
let launched = false;
let shellLoading: Promise<void> | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
 const e = document.createElement(tag);
 if (cls) e.className = cls;
 if (text !== undefined) e.textContent = text;
 return e;
}

/** Hands the document off to the unified desktop shell (src/main.ts, html.desk). */
async function launchShell(bound?: { agentName: string; added: Parameters<typeof boundNotice>[1] }) {
 if (shellLoading) return shellLoading;
 launched = true;
 shownWelcome = null;
 welcomeView.hidden = true;
 welcomeView.replaceChildren();
 document.body.classList.remove("web-welcome-visible");
 document.documentElement.classList.add("desk");
 shellLoading = import("../main").then(() => {
  if (bound !== undefined) showAccountNotice(boundNotice(bound.agentName, bound.added));
 });
 return shellLoading;
}

// The HerdrUp account panel on the signed-out / post-Leave welcome screen.
const account = new HerdrUpAccountPanel(() => {
 if (launched) return;
 void refreshShared();
 if (shownWelcome) showWelcome(shownWelcome);
});
const accountRoot = () => account.available ? account.root : null;

const sharedProblem = el("p", "host-home-message"); sharedProblem.setAttribute("role", "alert"); sharedProblem.hidden = true;
const sharedList = sharedSection(symbol, () => { void launchShell(); }, error => { sharedProblem.textContent = errorText(error); sharedProblem.hidden = false; }, () => false, "YOUR SHARED AGENTS");
sharedList.root.append(sharedProblem);
const sharedRoot = el("div", "host-home guest-shared-list"); sharedRoot.append(sharedList.root);
let sharedVersion = 0;
let sharedCount = 0;
async function refreshShared() {
 if (launched) return;
 const at = ++sharedVersion, signedIn = account.signedIn;
 const [grants, synced] = await Promise.all([Desk.sharedConnections().catch(() => []), syncedSharesNow(signedIn)]);
 if (launched || at !== sharedVersion) return;
 const machines = sharedMachines(grants, synced);
 sharedCount = machines.length;
 sharedProblem.hidden = true;
 await sharedList.draw(machines);
 if (!launched && shownWelcome) showWelcome(shownWelcome);
}
events.syncedSharesChanged.on(() => { if (!launched) void refreshShared(); });

// ---- The plain screen without a grant ----

const ownerWanted = (shown: WelcomeState) => account.signedIn && shown.owner === null && !shown.error && !boot.guestInstead;
let ownerExit: "leaving" | "stays" | null = null;

let guestChosen = false;
const signInScreen = new AccountWelcome(() => {}, {
 label: "Use a guest invitation instead",
 foot: "Sign in with the account your HerdrUp app uses. Got an invite link from someone? Open it instead: it needs no account.",
 take: () => { guestChosen = true; showWelcome(shownWelcome); },
});
const showsSignIn = (shown: WelcomeState) => signInFirst({
 bootGuest: boot.guestInstead, guestChosen, plain: plainWelcome(shown),
 signedIn: account.signedIn, providers: account.signInProviders.length,
});

function showWelcome(shown: WelcomeState | null) {
 if (launched) return;
 shownWelcome = shown;
 if (shown === null) {
  welcomeView.hidden = true;
  document.body.classList.remove("web-welcome-visible");
  return;
 }
 if (ownerExit === "leaving") return;
 if (ownerExit === null && ownerWanted(shown)) {
  ownerExit = "leaving";
  pageExit.leave(() => {
   if (bootMarks().keepSignedInFound()) { location.reload(); return; }
   ownerExit = "stays";
   showWelcome(shownWelcome);
   return "stayed";
  });
  return;
 }
 welcomeView.hidden = false;
 document.body.classList.add("web-welcome-visible");
 if (showsSignIn(shown)) {
  signInScreen.commit({ show: true, providers: account.signInProviders }, account.problem);
  welcomeView.replaceChildren(signInScreen.root);
  return;
 }
 const w = welcome(shown);
 const card = el("div", "web-welcome-card");
 if (sharedCount > 0) {
  card.append(el("h1", "", "Shared with you"));
  if (w.error) { const error = el("p", "web-welcome-error", w.error); error.setAttribute("role", "alert"); card.append(error); }
  card.append(sharedRoot);
 } else {
  card.append(el("h1", "", w.title), el("p", "", w.body));
  if (w.error) { const error = el("p", "web-welcome-error", w.error); error.setAttribute("role", "alert"); card.append(error); }
 }
 const signIn = accountRoot();
 if (signIn) { const part = el("div", "web-welcome-account"); part.append(el("h2", "", ACCOUNT_TITLE), signIn); card.append(part); }
 welcomeView.replaceChildren(card);
}

function showOpening() {
 if (launched) return;
 const card = el("div", "web-welcome-card");
 const spin = el("div", "guest-home-loading"); spin.innerHTML = spinnerSVG;
 spin.setAttribute("role", "status"); spin.setAttribute("aria-label", "Opening the invitation");
 card.append(spin, el("p", "", "Opening the invitation…"));
 welcomeView.replaceChildren(card);
 welcomeView.hidden = false;
 document.body.classList.add("web-welcome-visible");
}

function showStarted(started: Started) {
 if (started.kind === "connected") { void launchShell(started.bound); return; }
 if (started.kind === "welcome") showWelcome(started.welcome);
}

const bindPage: BindPage = {
 origin: location.origin,
 storage: () => sessionStorage,
 owner: () => localOwnerHint.get(),
 opening: showOpening,
 done: showStarted,
 show(card) {
  if (launched) return;
  shownWelcome = null;
  welcomeView.replaceChildren(card);
  welcomeView.hidden = false;
  document.body.classList.add("web-welcome-visible");
 },
};

async function init() {
 document.documentElement.style.setProperty("--pixel", `${1 / devicePixelRatio}px`);
 document.documentElement.style.setProperty("--composer-text-pitch", `${COMPOSER_TEXT_PITCH}px`);
 document.documentElement.style.setProperty("--composer-text-offset", `${COMPOSER_TEXT_OFFSET}px`);
 const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
 applyMotions(document.documentElement, reduceMotion.matches);
 reduceMotion.addEventListener("change", () => applyMotions(document.documentElement, reduceMotion.matches));

 const pending = takePendingBind(() => sessionStorage);
 if (payload !== "" || pending !== null) showOpening();
 let started: Started;
 try {
  started = await start(Desk, payload, location.origin, () => localOwnerHint.get(),
   startAccount(ownerAccess.account, pending, pending === null ? null : signInEnded()));
 } catch (error) {
  started = { kind: "welcome" as const, welcome: { owner: localOwnerHint.get(), error: errorText(error) } };
 }
 if (started.kind === "connected") {
  await launchShell(started.bound);
  return;
 }
 await document.fonts.ready;
 const waits = started.kind === "welcome" && plainWelcome(started.welcome) && !boot.guestInstead;
 if (waits) await Promise.race([account.refresh(true), new Promise(done => setTimeout(done, ACCOUNT_LOOKUP_MS))]);
 if (started.kind === "signIn") { void signInToBind(started.payload, started.provider, bindPage); return; }
 if (started.kind === "bind") { void showBindChoice(started.payload, started.problem, bindPage); return; }
 showStarted(started);
 if (!waits) void account.refresh(true);
}

void init();
