// The browser guest's page: the screens the desktop shows a guest (src/main.ts's guest branch:
// the guest home, the agent page, the shared agent's Gram, the guest's Settings, the top and tab
// bars), with the browser Desk behind them (vite.web.config.ts aliases ../mygo to ./mygo.ts).
// There is no owner window here: no hosts, roster, glyph field, sessions or owner Settings.

import "core-js/actual/promise/with-resolvers";
import "../style.css";
import "./web.css";
import { enableLongPress } from "../longPress";
import { Desk, events, type AgentTarget, type BoardUpdate, type ConnState } from "../mygo";
import { symbol } from "../symbol";
import { avatar, placeInitials, spinnerSVG } from "../faces";
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
import { start, takeFragment, welcome, type WelcomeState } from "./start";
import { ACCOUNT_TITLE, HerdrUpAccountPanel } from "../herdrupAccount";
import { ownerAccess, signInReturned } from "./mygo";
import { ownerKey, refreshLists, runApproval, type OwnerPhase } from "./ownerApproval";
import { IndexedDBOwnerStore, type OwnerRecord } from "./ownerStore";
import { browserDeviceName, ownerCard } from "./ownerScreen";

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
const account = new HerdrUpAccountPanel(() => { if (shownWelcome) showWelcome(shownWelcome); else render(); });
const accountRoot = () => account.available ? account.root : null;

// main.ts guestActions; "hosts" is Leave share or Remove share: this browser holds no other.
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

// ---- Owner access: approving this browser (ownerApproval.ts, mockup 1) ----

const ownerStore = new IndexedDBOwnerStore();
const deviceName = browserDeviceName(navigator.userAgent);
let ownerPhase: OwnerPhase | null = null;
let ownerRecord: OwnerRecord | undefined;
let ownerRun: AbortController | null = null;
/** The person chose "Use a guest invitation instead" on this load. */
let guestInstead = false;

const redrawWelcome = () => { if (shownWelcome) showWelcome(shownWelcome); };

/** A signed-in browser on its first visit is an owner's: it asks to be approved, or shows what it
 *  was approved for. A share left or wiped, signed in or not, still asks for a new invite. */
const ownerWanted = (shown: WelcomeState) => account.signedIn && shown.owner === null && !guestInstead;

/** The kept approvals, refreshed from the service; else a new approval request. */
async function beginOwner() {
 ownerPhase = { kind: "starting" };
 const record = await ownerStore.get().catch(() => undefined);
 if (record === undefined || record.approvers.length === 0) { startApproval(); return; }
 ownerRecord = record;
 ownerPhase = { kind: "approved", approver: record.approvers[0]! };
 redrawWelcome();
 const key = await ownerKey(ownerAccess.identities).catch(() => null);
 if (key === null) return;
 const fresh = await refreshLists(ownerAccess.account, key, ownerStore).catch(() => undefined);
 if (fresh !== undefined && ownerPhase?.kind === "approved") { ownerRecord = fresh; redrawWelcome(); }
}

function startApproval() {
 ownerRun?.abort();
 const run = new AbortController();
 ownerRun = run;
 ownerPhase = { kind: "starting" };
 redrawWelcome();
 const onPhase = async (p: OwnerPhase) => {
  if (ownerRun !== run) return;
  if (p.kind === "approved") ownerRecord = await ownerStore.get().catch(() => undefined);
  ownerPhase = p;
  redrawWelcome();
 };
 runApproval({ account: ownerAccess.account, identities: ownerAccess.identities, store: ownerStore, deviceName }, p => void onPhase(p), run.signal)
  .catch(error => { if (ownerRun === run) { ownerPhase = { kind: "failed", problem: errorText(error) }; redrawWelcome(); } });
}

function stopOwner() { ownerRun?.abort(); ownerRun = null; ownerPhase = null; }

// ---- The plain screen without a grant ----

/** Shows the screen for shown (null hides it): the owner's approval when this browser is signed
 *  in on its first visit, else the words asking for an invite. */
function showWelcome(shown: WelcomeState | null) {
 shownWelcome = shown;
 if (shown === null) { stopOwner(); welcomeView.hidden = true; render(); return; }
 let card: HTMLElement;
 if (ownerWanted(shown)) {
  if (ownerPhase === null) void beginOwner();
  card = ownerCard(ownerPhase ?? { kind: "starting" }, deviceName, ownerRecord, {
   again: startApproval,
   guestInstead: () => { guestInstead = true; stopOwner(); redrawWelcome(); },
  }, spinnerSVG);
  if (shown.error) { const error = el("p", "web-welcome-error", shown.error); error.setAttribute("role", "alert"); card.prepend(error); }
 } else {
  if (!account.signedIn) stopOwner();
  const w = welcome(shown);
  card = el("div", "web-welcome-card");
  card.append(el("h1", "", w.title), el("p", "", w.body));
  if (w.error) { const error = el("p", "web-welcome-error", w.error); error.setAttribute("role", "alert"); card.append(error); }
 }
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
 const items: Array<[GuestTab, string, string]> = [
  ["agents", "square.grid.2x2.fill", "Agents"],
  ...(view.gram ? [["gram", "bubble.left.and.bubble.right.fill", "Gram"] as [GuestTab, string, string]] : []),
  ["settings", "gearshape.fill", "Settings"],
 ];
 const actions = view.tab === "gram" ? await barActions(null) : [];
 const tabs = await Promise.all(items.map(([key, icon, label]) =>
  tabNode(key, icon, label, key === view.tab, key === "gram", key === "settings" ? guestActions.settings : key === "gram" ? () => guestActions.gram() : guestActions.agents)));
 if (generation !== barGeneration) return;
 const count = view.tab === "gram" ? barCount() : null;
 const title = view.tab === "settings" ? "Settings" : view.tab === "gram" ? "Gram" : "Agents";
 // No Back: the browser holds this one share and no machine list to go back to.
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

events.stateChanged.on((s) => {
 if (s.guest?.access.guestID !== state.guest?.access.guestID || s.guest?.access.endpoint.hostID !== state.guest?.access.endpoint.hostID) {
  guestTab = "agents";
 }
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
 guestHome = initGuestHome($("sidebar"), $("detail"), { symbol, avatar, placeInitials, spinner: spinnerSVG }, guestActions, { settings: true, account: accountRoot });
 initInteraction($("detail"), symbol, target => { selectedAgent = target; render(); });
 await initGram({
  el, symbol, placeInitials, spinner: spinnerSVG,
  barChanged: () => { if (guestBar?.tab === "gram") void buildBars(guestBar); },
  guestGramChanged: () => { setTabBadge(); if (guestBar && guestBar.gram !== guestGramOffer().offered) render(); },
 }, $("detail"), $("sidebar"), $("tabbar"));
 if (payload !== "") showOpening();
 let started;
 try {
  started = await start(Desk, payload, location.origin, () => localOwnerHint.get());
 } catch (error) {
  started = { kind: "welcome" as const, welcome: { owner: localOwnerHint.get(), error: errorText(error) } };
 }
 state = await Desk.state();
 board = await Desk.board();
 await document.fonts.ready;
 ready = true;
 showWelcome(started.kind === "welcome" ? started.welcome : null);
 // Back from the account service (?account=1 or ?account_error=) with a share: its Settings,
 // where the result shows. Either way the panel is asked once, so the result shows once.
 if (started.kind === "connected" && signInReturned) guestActions.settings();
 else void account.refresh(true);
}

void init();
