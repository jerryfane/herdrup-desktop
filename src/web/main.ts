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
import { commitTabBar, commitTopBar, guestBarActions, placeTitle, tabNode } from "../bars";
import { initGuestHome } from "../guestHome";
import { closeInteraction, initInteraction, interactionBoard, interactionVisible, selectInteraction, showInteraction } from "../interaction";
import { initGram, setGuestGramRecipient, showGram } from "../gram";
import { closeWriter } from "../composer";
import { COMPOSER_TEXT_OFFSET, COMPOSER_TEXT_PITCH } from "../composerMetrics";
import { animateDisclosures, applyMotions } from "../motion";
import { onTextSizeChanged } from "../textSize";
import { errorText } from "../errors";
import { localOwnerHint } from "./storage";
import { start, takeFragment, welcome, type Welcome } from "./start";

// The invitation leaves the address bar before anything else runs (contract Flow 3).
const payload = takeFragment(location, history);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const select = $("select");
const welcomeView = $("welcome");

let state: ConnState = { phase: "idle", message: "", machine: "", herdr: "", live: false };
let board: BoardUpdate | null = null;
let guestTab: "agents" | "settings" = "agents";
let guestGram = false;
let selectedAgent: AgentTarget | null = null;
let shownWelcome: Welcome | null = null;
let guestBar: { tab: "agents" | "settings"; gram: boolean } | null = null;
let guestHome: ReturnType<typeof initGuestHome> | null = null;
let ready = false;

// main.ts guestActions; "hosts" is Leave share or Remove share: this browser holds no other.
const guestActions = {
 agents: () => { guestTab = "agents"; guestGram = false; render(); },
 settings: () => { closeWriter(); guestTab = "settings"; guestGram = false; render(); },
 hosts: () => { closeWriter(); closeInteraction(); showWelcome(welcome(localOwnerHint.get())); },
 terminal: () => { guestGram = false; render(); },
 open: (target: AgentTarget) => { guestTab = "agents"; guestGram = false; void selectInteraction(target).then(render); },
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
async function buildBars(view: { tab: "agents" | "settings"; gram: boolean }) {
 const generation = ++barGeneration;
 const actions = await guestBarActions(view.gram, guestActions.terminal);
 const tabs = await Promise.all(([["agents", "square.grid.2x2.fill", "Agents"], ["settings", "gearshape.fill", "Settings"]] as const).map(([key, icon, label]) =>
  tabNode(key, icon, label, key === view.tab, false, key === "settings" ? guestActions.settings : guestActions.agents)));
 if (generation !== barGeneration) return;
 // No Back: the browser holds this one share and no machine list to go back to.
 commitTopBar(false, null, [document.createTextNode(view.tab === "settings" ? "Settings" : "Agents")], actions);
 commitTabBar(tabs, view.tab === "settings" ? 1 : 0);
}

// ---- main.ts render, guest branch ----

function render() {
 if (!ready) return;
 const guestVisible = !!state.guest && shownWelcome === null;
 welcomeView.hidden = guestVisible;
 document.body.classList.toggle("web-welcome-visible", !guestVisible);
 if (state.guest && !state.guest.features.gram) guestGram = false;
 setGuestGramRecipient(guestVisible ? state.guest!.access.agentName : null);
 document.body.classList.toggle("guest-mode", guestVisible);
 const nextBar = guestVisible ? { tab: guestTab, gram: guestTab === "agents" && guestGram } : null;
 if (nextBar && (nextBar.tab !== guestBar?.tab || nextBar.gram !== guestBar?.gram)) void buildBars(nextBar);
 guestBar = nextBar;
 guestHome?.update(state, board, guestTab, guestVisible, interactionVisible() ? selectedAgent?.paneID ?? null : null);
 select.hidden = !guestVisible || guestTab === "settings" || guestGram || interactionVisible();
 showGram(guestVisible && guestTab === "agents" && guestGram && !!state.guest?.features.gram);
 showInteraction(guestVisible && guestTab === "agents" && !guestGram);
 // What the detail column holds, for the phone layout (web.css): the agent page full-screen,
 // Settings or Gram between the bars, or nothing (the list alone), as the iPhone app's stack.
 document.body.dataset.webDetail = !guestVisible ? "" : guestTab === "settings" || guestGram ? "bars" : interactionVisible() ? "page" : "";
}

window.addEventListener("guest-gram", () => {
 if (!state.guest?.features.gram) return;
 guestTab = "agents"; guestGram = true; render();
});

events.stateChanged.on((s) => {
 if (s.guest?.access.guestID !== state.guest?.access.guestID || s.guest?.access.endpoint.hostID !== state.guest?.access.endpoint.hostID) {
  guestTab = "agents"; guestGram = false;
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
 guestHome = initGuestHome($("sidebar"), $("detail"), { symbol, avatar, placeInitials, spinner: spinnerSVG }, guestActions);
 initInteraction($("detail"), symbol, target => { selectedAgent = target; render(); });
 await initGram({ el, symbol, placeInitials, spinner: spinnerSVG, barChanged: () => {} }, $("detail"), $("sidebar"), $("tabbar"));
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
 showWelcome(started.kind === "welcome" ? started.welcome : null);
}

void init();
