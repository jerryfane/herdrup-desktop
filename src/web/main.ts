// The browser guest's page: the screens the desktop shows a guest (src/main.ts's guest branch:
// the guest home, the agent page, the shared agent's Gram, the guest's Settings, the top and tab
// bars), with the browser Desk behind them (vite.web.config.ts aliases ../mygo to ./mygo.ts).
// boot.ts runs it for a guest; a signed-in owner gets the desktop shell itself (src/main.ts), whose
// host home is the approved machines (hosts.ts).

import { trackPhotoConnections } from "../avatars";
import { enableLongPress } from "../longPress";
import { Desk, events, type AgentTarget, type BoardUpdate, type ConnState } from "../mygo";
import { symbol } from "../symbol";
import { placeInitials, rowAvatar, spinnerSVG } from "../faces";
import { barActions, barCount, guestGramOffer, initGram, selectGuestGram, setGuestGram, showGram } from "../gram";
import { commitTabBar, commitTopBar, placeTitle, tabNode } from "../bars";
import { initGuestHome } from "../guestHome";
import { closeInteraction, initInteraction, interactionBoard, interactionVisible, selectInteraction, showInteraction } from "../interaction";
import { closeWriter } from "../composer";
import { COMPOSER_TEXT_OFFSET, COMPOSER_TEXT_PITCH } from "../composerMetrics";
import { animateDisclosures, applyMotions } from "../motion";
import { onTextSizeChanged } from "../textSize";
import { errorText } from "../errors";
import { localOwnerHint } from "./storage";
import { plainWelcome, start, startAccount, takeFragment, takePendingBind, welcome, type Started, type WelcomeState } from "./start";
import { showBindChoice, signInToBind, type BindPage } from "./bindChoice";
import { showAccountNotice } from "../notices";
import { boundNotice } from "./shares";
import { ACCOUNT_TITLE, AccountWelcome, HerdrUpAccountPanel } from "../herdrupAccount";
import { ownerAccess, pageExit, signInEnded, signInReturned } from "./mygo";
import { ACCOUNT_LOOKUP_MS, boot, bootMarks, signInFirst } from "./bootChoice";
import { boardAfter, connectionChanged } from "../shellModel";
import { sharedListStale, sharedMachines, sharedSection, syncedSharesNow } from "../sharedWithYou";

type GuestTab = "agents" | "gram" | "settings";

// The invitation leaves the address bar before anything else runs (contract Flow 3).
const payload = takeFragment(location, history);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const select = $("select");
const welcomeView = $("welcome");

let state: ConnState = { phase: "idle", message: "", machine: "", herdr: "", live: false };
let board: BoardUpdate | null = null;
let guestTab: GuestTab = "agents";
let selectedAgent: AgentTarget | null = null;
let shownWelcome: WelcomeState | null = null;
let guestBar: { tab: GuestTab; gram: boolean } | null = null;
let guestHome: ReturnType<typeof initGuestHome> | null = null;
let ready = false;

// The HerdrUp account (design #698 §2.3): on the guest's Settings and on the plain screen without
// a grant, once the account service offers web sign-in on this origin (guest.herdrup.app only).
const account = new HerdrUpAccountPanel(() => { void refreshShared(); if (shownWelcome) showWelcome(shownWelcome); else render(); });
const accountRoot = () => account.available ? account.root : null;

// The shares in the guest's Settings (#543): the owner host home's list (sharedWithYou.ts) of
// every grant this browser holds and, while signed in, the account's shares. Any of them opens in
// place of the share open now, which stays saved (Leave alone forgets it); the agents' tab then
// shows it.
const sharedProblem = el("p", "host-home-message"); sharedProblem.setAttribute("role", "alert"); sharedProblem.hidden = true;
const sharedList = sharedSection(symbol, () => guestActions.agents(), error => { sharedProblem.textContent = errorText(error); sharedProblem.hidden = false; }, () => false, "YOUR SHARED AGENTS");
sharedList.root.append(sharedProblem);
const sharedRoot = el("div", "host-home guest-shared-list"); sharedRoot.append(sharedList.root);
let sharedVersion = 0;
async function refreshShared() {
 const at = ++sharedVersion, signedIn = account.signedIn;
 const [grants, synced] = await Promise.all([Desk.sharedConnections().catch(() => []), syncedSharesNow(signedIn)]);
 if (at === sharedVersion) { sharedProblem.hidden = true; await sharedList.draw(sharedMachines(grants, synced)); }
}
events.syncedSharesChanged.on(() => { void refreshShared(); });

// main.ts guestActions; "hosts" is Leave share or Remove share.
const guestActions = {
 agents: () => { guestTab = "agents"; render(); },
 settings: () => { closeWriter(); guestTab = "settings"; void account.refresh(true); render(); },
 // The guest's one Gram (#697): this browser's shared agents (one until accounts, #698).
 gram: (grant: string | null = null) => { closeWriter(); selectGuestGram(grant); guestTab = "gram"; render(); },
 hosts: () => { closeWriter(); closeInteraction(); showWelcome({ owner: localOwnerHint.get() }); },
 open: (target: AgentTarget) => { guestTab = "agents"; void selectInteraction(target).then(render); },
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
 const e = document.createElement(tag);
 if (cls) e.className = cls;
 if (text !== undefined) e.textContent = text;
 return e;
}

// ---- The plain screen without a grant ----

/** A signed-in browser on its first visit is an owner's: boot.ts gives it the owner's shell, so a
 *  session that shows up here (the account lookup answered after boot's wait, or another tab signed
 *  in) loads the page again, as the owner's (bootMarks keepSignedInFound: loads go there with no
 *  lookup that could time out the same way again), unless this load was asked to be the guest's or
 *  has an invite's failure to say. It leaves once (ownerExit "leaving"); without storage for that
 *  mark, this page stays ("stays"). A share left or wiped still asks for a new invite. */
const ownerWanted = (shown: WelcomeState) => account.signedIn && shown.owner === null && !shown.error && !boot.guestInstead;
let ownerExit: "leaving" | "stays" | null = null;

/** Signed out on a first visit (no invite's failure, no share left): the desktop's sign-in
 *  (AccountWelcome) while the service offers it, with the guest's way as its third button, which
 *  shows the invite's words (the plain screen) in its place for this load. */
let guestChosen = false;
const signInScreen = new AccountWelcome(() => {}, {
 label: "Use a guest invitation instead",
 foot: "Sign in with the account your HerdrUp app uses. Got an invite link from someone? Open it instead: it needs no account.",
 take: () => { guestChosen = true; showWelcome(shownWelcome); },
});
const showsSignIn = (shown: WelcomeState) => signInFirst({ bootGuest: boot.guestInstead, guestChosen, plain: plainWelcome(shown),
 signedIn: account.signedIn, providers: account.signInProviders.length });

/** Shows the screen for shown (null hides it): the words asking for an invite. */
function showWelcome(shown: WelcomeState | null) {
 shownWelcome = shown;
 if (shown === null) { welcomeView.hidden = true; render(); return; }
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
 if (showsSignIn(shown)) {
  signInScreen.commit({ show: true, providers: account.signInProviders }, account.problem);
  welcomeView.replaceChildren(signInScreen.root);
  render();
  return;
 }
 const w = welcome(shown);
 const card = el("div", "web-welcome-card");
 card.append(el("h1", "", w.title), el("p", "", w.body));
 if (w.error) { const error = el("p", "web-welcome-error", w.error); error.setAttribute("role", "alert"); card.append(error); }
 const signIn = accountRoot();
 if (signIn) { const part = el("div", "web-welcome-account"); part.append(el("h2", "", ACCOUNT_TITLE), signIn); card.append(part); }
 welcomeView.replaceChildren(card);
 render();
}

function showOpening() {
 const card = el("div", "web-welcome-card");
 const spin = el("div", "guest-home-loading"); spin.innerHTML = spinnerSVG;
 spin.setAttribute("role", "status"); spin.setAttribute("aria-label", "Opening the invitation");
 card.append(spin, el("p", "", "Opening the invitation…"));
 welcomeView.replaceChildren(card);
 welcomeView.hidden = false;
}

// ---- Bars (main.ts buildTopBar/buildTabBar, guest branch) ----

let barGeneration = 0;
async function buildBars(view: { tab: GuestTab; gram: boolean }) {
 const generation = ++barGeneration;
 const items: Array<[GuestTab, string]> = [
  ["agents", "Agents"],
  ...(view.gram ? [["gram", "Gram"] as [GuestTab, string]] : []),
  ["settings", "Settings"],
 ];
 const actions = view.tab === "gram" ? await barActions(null) : [];
 const tabs = items.map(([key, label]) =>
  tabNode(key, label, key === view.tab, key === "gram", key === "settings" ? guestActions.settings : key === "gram" ? () => guestActions.gram() : guestActions.agents));
 if (generation !== barGeneration) return;
 const count = view.tab === "gram" ? barCount() : null;
 const title = view.tab === "settings" ? "Settings" : view.tab === "gram" ? "Gram" : "Agents";
 // No Back for a guest: the browser holds this one share and no machine list to go back to.
 commitTopBar(false, null, [document.createTextNode(title), ...(count ? [count] : [])], actions);
 commitTabBar(tabs, items.findIndex(([key]) => key === view.tab));
 setTabBadge();
}

/** main.ts setTabBadge: the guest's Gram count on its tab. */
function setTabBadge() {
 const badge = document.querySelector<HTMLElement>('#tabbar .tab-badge[data-tab="gram"]');
 if (!badge) return;
 const unread = guestGramOffer().badge;
 badge.hidden = unread === 0;
 badge.textContent = unread > 99 ? "99+" : String(unread);
 badge.closest(".tab")?.setAttribute("aria-label", unread ? `Gram, ${unread} unread` : "Gram");
}

// ---- main.ts render, guest branch ----

function render() {
 if (!ready) return;
 const guestVisible = !!state.guest && shownWelcome === null;
 welcomeView.hidden = guestVisible;
 document.body.classList.toggle("web-welcome-visible", !guestVisible);
 setGuestGram(guestVisible);
 const gramOffered = guestVisible && guestGramOffer().offered;
 if (guestTab === "gram" && !gramOffered) guestTab = "agents";
 document.body.classList.toggle("guest-mode", guestVisible);
 const nextBar = guestVisible ? { tab: guestTab, gram: gramOffered } : null;
 if (nextBar && (nextBar.tab !== guestBar?.tab || nextBar.gram !== guestBar?.gram)) void buildBars(nextBar);
 guestBar = nextBar;
 guestHome?.update(state, board, guestTab === "gram" ? "agents" : guestTab, guestVisible && guestTab !== "gram", interactionVisible() ? selectedAgent?.paneID ?? null : null);
 select.hidden = !guestVisible || guestTab !== "agents" || interactionVisible();
 showGram(guestVisible && guestTab === "gram");
 showInteraction(guestVisible && guestTab === "agents");
 // What the detail column holds, for the phone layout (web.css): the agent page full-screen,
 // Settings or Gram between the bars, or nothing (the list alone), as the iPhone app's stack.
 document.body.dataset.webDetail = !guestVisible ? "" : guestTab !== "agents" ? "bars" : interactionVisible() ? "page" : "";
}

// The shared agent page's Gram button: the guest's Gram with that agent selected (#697).
window.addEventListener("guest-gram", event => {
 guestActions.gram((event as CustomEvent<string | null>).detail ?? null);
});

// Photos that failed are asked for again once the connection is back up (avatars.ts).
trackPhotoConnections(events);
events.stateChanged.on((s) => {
 // Another share (shellModel.ts, the shell's rule too): its own tab, and not the last one's board.
 if (connectionChanged(state, s)) guestTab = "agents";
 // The shares list names the share open now, and its machine as its owner names it now.
 if (sharedListStale(state, s)) void refreshShared();
 board = boardAfter(state, s, board);
 state = s;
 if (s.phase !== "connected") { closeWriter(); closeInteraction(); }
 if (s.phase === "idle") board = null;
 render();
});
events.boardChanged.on((b) => {
 board = b;
 interactionBoard(b);
 render();
});

window.addEventListener("resize", () => placeTitle());
onTextSizeChanged(() => { placeTitle(); void placeInitials(document); });

async function init() {
 document.documentElement.style.setProperty("--pixel", `${1 / devicePixelRatio}px`);
 document.documentElement.style.setProperty("--composer-text-pitch", `${COMPOSER_TEXT_PITCH}px`);
 document.documentElement.style.setProperty("--composer-text-offset", `${COMPOSER_TEXT_OFFSET}px`);
 const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
 applyMotions(document.documentElement, reduceMotion.matches);
 reduceMotion.addEventListener("change", () => applyMotions(document.documentElement, reduceMotion.matches));
 animateDisclosures(document.body);
 enableLongPress();
 guestHome = initGuestHome($("sidebar"), $("detail"), { symbol, rowAvatar, placeInitials, spinner: spinnerSVG }, guestActions, { settings: true, account: accountRoot, shared: () => sharedRoot });
 initInteraction($("detail"), symbol, target => { selectedAgent = target; render(); });
 await initGram({
  el, symbol, placeInitials, spinner: spinnerSVG,
  barChanged: () => { if (guestBar?.tab === "gram") void buildBars(guestBar); },
  guestGramChanged: () => { setTabBadge(); if (guestBar && guestBar.gram !== guestGramOffer().offered) render(); },
 }, $("detail"), $("sidebar"), $("sidebar-foot"));
 // An invite back from the sign-in its "Add to my account" left for (start.ts PENDING_BIND_KEY),
 // taken now: from here on it lives only in this page.
 const pending = takePendingBind(() => sessionStorage);
 if (payload !== "" || pending !== null) showOpening();
 let started: Started;
 try {
  started = await start(Desk, payload, location.origin, () => localOwnerHint.get(),
   startAccount(ownerAccess.account, pending, pending === null ? null : signInEnded()));
 } catch (error) {
  started = { kind: "welcome" as const, welcome: { owner: localOwnerHint.get(), error: errorText(error) } };
 }
 state = await Desk.state();
 board = await Desk.board();
 await document.fonts.ready;
 ready = true;
 // The plain first screen is the sign-in while the service offers it (signInFirst): the panel is
 // asked before it shows, so the invite's words don't show first; a service slower than boot's
 // own wait gets the invite's words, and the sign-in in their place once it answers. The guest's
 // way chosen at boot shows no sign-in, so it waits for nothing.
 const waits = started.kind === "welcome" && plainWelcome(started.welcome) && !boot.guestInstead;
 if (waits) await Promise.race([account.refresh(true), new Promise(done => setTimeout(done, ACCOUNT_LOOKUP_MS))]);
 // The landing's "Add to my account", signed out: the named sign-in leaves at once (the opening
 // card stays up meanwhile), or the invitation's choices show.
 if (started.kind === "signIn") { void signInToBind(started.payload, started.provider, bindPage); return; }
 if (started.kind === "bind") { void showBindChoice(started.payload, started.problem, bindPage); return; }
 showStarted(started);
 // Back from the account service (?account=1 or ?account_error=) with a share: its Settings,
 // where the result shows. Either way the panel is asked once, so the result shows once. An
 // invite that waited for the sign-in shows its own result (the account notice).
 if (started.kind === "connected" && signInReturned && pending === null) guestActions.settings();
 else if (!waits) void account.refresh(true);
}

/** The screen a start ends on: the plain screen (with why an invite failed), or the share, with
 *  the notice of how adding it to the HerdrUp account went when this start bound it. */
function showStarted(started: Started) {
 showWelcome(started.kind === "welcome" ? started.welcome : null);
 if (started.kind === "connected" && started.bound !== undefined) showAccountNotice(boundNotice(started.bound.agentName, started.bound.added));
}

/** The bind choice on this page's welcome screen (bindChoice.ts). */
const bindPage: BindPage = {
 origin: location.origin,
 storage: () => sessionStorage,
 owner: () => localOwnerHint.get(),
 show: card => { shownWelcome = null; welcomeView.replaceChildren(card); welcomeView.hidden = false; render(); },
 opening: showOpening,
 done: started => { showStarted(started); void account.refresh(true); },
};

void init();
