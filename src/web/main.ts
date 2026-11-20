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
import { start, takeFragment, welcome, type Welcome } from "./start";
import { ACCOUNT_TITLE, HerdrUpAccountPanel } from "../herdrupAccount";
import { signInReturned } from "./mygo";

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
let shownWelcome: Welcome | null = null;
let guestBar: { tab: GuestTab; gram: boolean } | null = null;
let guestHome: ReturnType<typeof initGuestHome> | null = null;
let ready = false;

// The HerdrUp account (design #698 §2.3): on the guest's Settings and on the plain screen without
// a grant, once the account service offers web sign-in on this origin (guest.herdrup.app only).
const account = new HerdrUpAccountPanel(() => { if (shownWelcome) showWelcome(shownWelcome); else render(); });
const accountRoot = () => account.available ? account.root : null;
// Back from the account service (?account=1 or ?account_error=): the guest lands on Settings,
// where the result shows.
let landOnSettings = signInReturned;

// main.ts guestActions; "hosts" is Leave share or Remove share: this browser holds no other.
const guestActions = {
 agents: () => { guestTab = "agents"; render(); },
 settings: () => { closeWriter(); guestTab = "settings"; void account.refresh(true); render(); },
 // The guest's one Gram (#697): this browser's shared agents (one until accounts, #698).
 gram: (grant: string | null = null) => { closeWriter(); selectGuestGram(grant); guestTab = "gram"; render(); },
 hosts: () => { closeWriter(); closeInteraction(); showWelcome(welcome(localOwnerHint.get())); },
 open: (target: AgentTarget) => { guestTab = "agents"; void selectInteraction(target).then(render); },
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
 const e = document.createElement(tag);
 if (cls) e.className = cls;
 if (text !== undefined) e.textContent = text;
 return e;
}

// ---- The plain screen without a grant ----

function showWelcome(w: Welcome | null) {
 shownWelcome = w;
 if (w === null) { welcomeView.hidden = true; render(); return; }
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
  guestTab = landOnSettings ? "settings" : "agents";
  landOnSettings = false;
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
 void account.refresh(true);
 if (payload !== "") showOpening();
 let started;
 try {
  started = await start(Desk, payload, location.origin, () => localOwnerHint.get());
 } catch (error) {
  started = { kind: "welcome" as const, welcome: welcome(localOwnerHint.get(), errorText(error)) };
 }
 state = await Desk.state();
 board = await Desk.board();
 await document.fonts.ready;
 ready = true;
 // No share to land in: the result shows on this screen instead.
 if (started.kind === "welcome") landOnSettings = false;
 showWelcome(started.kind === "welcome" ? started.welcome : null);
}

void init();
