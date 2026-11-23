import "core-js/actual/promise/with-resolvers";
import { errorDetail, startWithFallback } from "./startup";
import { symbol } from "./symbol";
import { Desk, events, type AgentTarget, type Board, type BoardUpdate, type ConnState, type Row, type Section } from "./mygo";
import { paintShape } from "./continuous";
import { loadGlyphFieldFonts } from "./glyphField";
import { LiveGlyphField, Tone, type FieldLine } from "./glyphFieldLive";
import { agentMenu, folderRow, initFolders, rosterEmptyLine, rosterEntries, star, type FolderDeps } from "./folders";
import { initAgentActions } from "./agentActions";
import { avatarFace, boardShown, trackPhotoConnections } from "./avatars";
import { accountLine, initListExtras, renderSessionPills, rowAge, rowMarkers, updateNeedsYou } from "./sessions";
import { rowPreview } from "./rowStatus";
import { barActions, barCount, focusGramSearch, gramShowing, guestGramOffer, initGram, selectGuestGram, setGuestGram, showGram } from "./gram";
import { initInteraction, selectInteraction, interactionVisible, showInteraction, closeInteraction, interactionBoard } from "./interaction";
import { initHosts } from "./hosts";
import { initSettings } from "./settings";
import { closeWriter } from "./composer";
import { onTextSizeChanged } from "./textSize";
import { initSidebarRail } from "./sidebar";
import { showNewAgent, showNewTerminal } from "./create";
import { terminalRows } from "./terminals";
import { initGuestHome } from "./guestHome";
import { COMPOSER_TEXT_OFFSET, COMPOSER_TEXT_PITCH } from "./composerMetrics";
import { animateDisclosures, applyMotions, motionMode, motionSeconds, SPEC } from "./motion";
import { initStarAsk } from "./starAsk";
import { initAppUpdateAsk } from "./appUpdateAsk";
import { initWebAccess } from "./webAccess";
import { errorText } from "./errors";
import { appUpdateNewer, appUpdatesShown, watchAppUpdate } from "./appUpdates";
import { badge, initialTile, placeInitials, rowAvatar, spinnerSVG } from "./faces";
import { barSlot, commitTabBar, commitTopBar, placeTitle, tabNode } from "./bars";
import { enableLongPress } from "./longPress";
import { deskOffers, ownerWrites, parts, shareShown } from "./shellModel";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const rowsEl = $("rows");
const searchField = $("search-field");
const searchInput = $<HTMLInputElement>("search");
const connectView = $("connect");
const form = $<HTMLFormElement>("connect-form");
// The form never submits as a page would (a GET with the password in the URL): before
// initHosts takes it over, submitting does nothing.
form.addEventListener("submit", event => event.preventDefault());
const select = $("select");
const field = $<HTMLCanvasElement>("field");
// herdrup's DesktopReferenceMock.holdsStill: set by the reference captures (refshot.go).
const holdsStill = (globalThis as { herdrupHoldsStill?: boolean }).herdrupHoldsStill === true;
const liveField = new LiveGlyphField(field, select, holdsStill);
/** The line an agent types into the field: "name › folder · activity" in its status colour
 *  (herdrup HerdrApp.swift glyphFieldLine, 2143-2152). */
const fieldLines = new Map<string, FieldLine>();
function updateFieldLines(b: Board | null) {
  fieldLines.clear();
  for (const section of b?.sections ?? []) for (const row of section.rows) {
    const tone = section.key === "needsYou" || section.key === "unrecognised" ? Tone.waiting
      : section.key === "stopped" ? Tone.died : section.key === "working" ? Tone.working
      : row.status === "done" ? Tone.done : Tone.dim;
    fieldLines.set(row.id, { id: row.id, text: `${row.title} › ${row.preview}`, tone });
  }
  liveField.lines = [...fieldLines.values()];
}

let state: ConnState = { phase: "idle", message: "", machine: "", herdr: "", live: false };
let board: BoardUpdate | null = null;
let tab: "agents" | "gram" | "settings" = "agents";
let choosingHost = false;
// The host home holds a connecting row until the first list (ConnectView #377).
let hostsHold = () => false;
/** initHosts has run: the host screen works. Before, a fallback render shows startupError. */
let hostsReady = false;
let startupError: HTMLElement | null = null;
let settings: ReturnType<typeof initSettings> | null = null;
let rail: Awaited<ReturnType<typeof initSidebarRail>> | null = null;
let starAsk: ReturnType<typeof initStarAsk> | null = null;
let appUpdateAsk: ReturnType<typeof initAppUpdateAsk> | null = null;
// The capsule over the owner's agents list: a newer app first, else the star ask. The two
// share the list's room for it (the star-asking class), which this keeps.
function updateAsks(listVisible: boolean) {
  const updateShows = !!appUpdateAsk?.update(listVisible && appUpdatesShown);
  const starShows = !!starAsk?.update(listVisible && !updateShows);
  $("sidebar").classList.toggle("star-asking", updateShows || starShows);
}
// Settings was asked for from outside its tab (App updates from the update notification or the
// tray, HerdrUp account from the host home's avatar): it shows even with no machine connected,
// as neither needs one, until another tab is chosen.
let settingsAsked = false;
// The owner's tab bar and the sidebar rail choose a tab here, which also leaves that request
// (review of #167).
function selectTab(next: typeof tab) {
  tab = next; choosingHost = false; settingsAsked = false; settingsPushed = false;
  buildTabBar(); void buildTopBar(); render();
}
// ---- Phone layout (rover, gitmoot 456087) ----
// At 700 px and narrower (style.css, "Phone layout") the window takes herdrup's iPhone
// navigation (HerdrApp.swift detailColumn, the compact TabView): one column, as the browser
// guest's page does (web/main.ts). body[data-detail] says what the detail column shows over
// the list: "page" covers the screen (an agent's page, with its own back button, or a Settings
// page, with compactBack), "bars" sits between the top bar and the tab bar (Gram, as the
// iPhone's Gram tab), and "" leaves the list.
const compactQuery = matchMedia("(max-width: 700px)");
// A Settings page chosen from the index, shown over it in the phone layout until its back.
let settingsPushed = false;
let compactBack: HTMLButtonElement | null = null;
/** Sets what the phone layout's detail column shows; `back` is the Settings page's back
 *  button, shown only in the phone layout. */
function placeDetail(detail: "page" | "bars" | "", back = false) {
  document.body.dataset.detail = detail;
  const backShown = back && compactQuery.matches;
  document.body.classList.toggle("compact-back", backShown);
  if (compactBack) compactBack.hidden = !backShown;
}
/** The owner's detail column, as render() leaves it and again when an agent's page closes. */
function placeOwnerDetail(showConnect: boolean) {
  if (showConnect) placeDetail("page");
  else if (tab === "agents") placeDetail(interactionVisible() ? "page" : "");
  else if (tab === "gram") placeDetail("bars");
  else placeDetail(settingsPushed ? "page" : "", settingsPushed);
}
let pendingAgent: AgentTarget | null = null;
let selectedAgent: AgentTarget | null = null;
let activationVersion = 0;
let activationWork = Promise.resolve();
let pageReady = false;
// Connection events retain state immediately; drawing waits for every view's dependencies.
let renderReady = false;
let guestHome: ReturnType<typeof initGuestHome> | null = null;
let guestTab: "agents" | "gram" | "settings" = "agents";
// The guest home's top and tab bars as last built (render): its tab and whether its Gram tab is
// offered; null while the owner's bars show.
let guestBar: { tab: "agents" | "gram" | "settings"; gram: boolean } | null = null;
const guestActions = {
  agents: () => { guestTab = "agents"; settingsPushed = false; render(); },
  settings: () => { closeWriter(); guestTab = "settings"; settingsPushed = false; render(); },
  // The guest's one Gram (#697): every shared agent's, with one selected or All agents.
  gram: (grant: string | null = null) => { closeWriter(); selectGuestGram(grant); guestTab = "gram"; settingsPushed = false; render(); },
  hosts: () => { closeWriter(); closeInteraction(); choosingHost = true; render(); },
  open: (target: AgentTarget) => { guestTab = "agents"; void selectInteraction(target).then(render); },
};
// Disclosure rows ("Idle", "Archived") start closed, as in herdrup.
const open: Record<"idle" | "archived", boolean> = { idle: false, archived: false };

// ---- SF Symbols (macOS) or their open substitutes, as tinted masks (symbol.ts) ----

/** Puts a symbol into `host`, replacing what was there. */
async function place(host: HTMLElement, name: string, size: number, weight: string) {
  host.replaceChildren(await symbol(name, size, weight));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---- Top bar (SectionTopBar) ----

let topBarGeneration = 0;
async function buildTopBar() {
  const generation = ++topBarGeneration, guestView = guestBar, selectedTab = guestView ? guestView.tab : tab;
  let titleNodes: Node[], actionNodes: HTMLElement[];
  const slot = barSlot;
  const back = await slot("chevron.left", guestView ? "Machines" : "Choose host");
  back.tabIndex = 0; back.setAttribute("role", "button");
  const chooseHost = guestView ? guestActions.hosts : () => { closeWriter(); choosingHost = true; settingsAsked = false; render(); };
  back.onclick = chooseHost;
  back.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); chooseHost(); } };
  if (guestView && selectedTab === "gram") {
    // The guest's Gram: as the owner's, its count, Read all and Refresh (3B).
    const count = barCount();
    titleNodes = [document.createTextNode("Gram"), ...(count ? [count] : [])];
    actionNodes = await barActions(() => rail?.minimize());
  } else if (guestView) {
    titleNodes = [document.createTextNode(selectedTab === "settings" ? "Settings" : "Agents")];
    actionNodes = [];
  } else if (selectedTab === "gram") {
    // gramSidebar: "Gram" with the amber unread count, then Read all and Refresh.
    const count = barCount();
    titleNodes = [document.createTextNode("Gram"), ...(count ? [count] : [])];
    actionNodes = await barActions(() => rail?.minimize());
  } else {
    titleNodes = [document.createTextNode(selectedTab === "settings" ? "Settings" : "Agents")];
    const minimize = await slot("sidebar.leading", "Minimise sidebar");
    minimize.tabIndex = 0; minimize.setAttribute("role", "button"); minimize.setAttribute("aria-label", "Minimise sidebar");
    minimize.onclick = () => rail?.minimize();
    minimize.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); rail?.minimize(); } };
    actionNodes = [minimize];
    // New agent and New terminal create on the machine: a web owner's need the creation methods
    // (a later slice) and a terminal-scope link (shellModel.ts deskOffers, ownerWrites).
    if (selectedTab === "agents" && deskOffers("openCreation", "createAgent", "createTerminal") && ownerWrites(state)) {
      const add = await slot("plus", "New agent");
      const enabled = !!board && state.phase === "connected";
      add.tabIndex = enabled ? 0 : -1; add.setAttribute("role", "button"); add.setAttribute("aria-label", "New agent");
      add.setAttribute("aria-disabled", String(!enabled));
      const create = () => { if (board && state.phase === "connected") void showNewAgent({ machineID: board.machineID, session: board.session }); };
      add.onclick = create;
      add.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); create(); } };
      const terminal = await slot("terminal", "New terminal");
      terminal.tabIndex = enabled ? 0 : -1; terminal.setAttribute("role", "button"); terminal.setAttribute("aria-label", "New terminal");
      terminal.setAttribute("aria-disabled", String(!enabled));
      const createTerminal = () => { if (board && state.phase === "connected") void showNewTerminal({ machineID: board.machineID, session: board.session }, renderRows); };
      terminal.onclick = createTerminal;
      terminal.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); createTerminal(); } };
      actionNodes.push(terminal, add);
    }
  }
  // Symbol loads can overlap another tab change. Commit one complete, current bar.
  if (generation !== topBarGeneration) return;
  // Agents and Gram carry the back to the host list.
  commitTopBar(selectedTab !== "settings", back, titleNodes, actionNodes);
}

// ---- Tab bar ----

// Gram's unread count, as the last snapshot reported it (gram.ts barChanged).
let gramUnread = 0;
// Whether a newer Herdrup is out (appUpdates.ts): to install, or to download.
let appUpdateWaiting = false;
watchAppUpdate(s => { appUpdateWaiting = appUpdateNewer(s); setTabBadge(); });
// The unread badges' fill: native's Color(uiColor: .systemRed) in its dark scheme. It is a
// system colour, not a herdrup design token, so it is set here (owner, 2026-11-03: red, as native).
document.documentElement.style.setProperty("--system-red", "#ff453a");
/** sidebarTabItem's tabBadge (HerdrApp.swift 2871-2881): the count on the Gram icon's
 *  top-trailing corner, "99+" past 99, hidden at zero; white on system red. */
function setTabBadge() {
  const unread = guestBar ? guestGramOffer().badge : gramUnread;
  const badge = document.querySelector<HTMLElement>('#tabbar .tab-badge[data-tab="gram"]');
  if (badge) {
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? "99+" : String(unread);
    badge.closest(".tab")?.setAttribute("aria-label", unread ? `Gram, ${unread} unread` : "Gram");
  }
  // The same badge on Settings while a newer Herdrup waits (Settings' suggestion of it).
  const settings = document.querySelector<HTMLElement>('#tabbar .tab-badge[data-tab="settings"]');
  if (settings) {
    // Text only while shown: a hidden "1" still joined the tab's text ("Settings1").
    settings.hidden = !appUpdateWaiting; settings.textContent = appUpdateWaiting ? "1" : "";
    settings.closest(".tab")?.setAttribute("aria-label", appUpdateWaiting ? "Settings, update available" : "Settings");
  }
}
/** The tabs, text only (bars.ts tabNode): built and committed at once. */
function buildTabBar() {
  const guestView = guestBar, selectedTab = guestView ? guestView.tab : tab;
  // A guest's TabView: Agents, Gram while a shared agent shares it (#697), and Settings.
  const items: Array<[typeof tab, string]> = [["agents", "Agents"], ...(!guestView || guestView.gram ? [["gram", "Gram"] as [typeof tab, string]] : []), ["settings", "Settings"]];
  const nodes = items.map(([key, label]) =>
    // The guest's Settings is its own page, without the app update.
    tabNode(key, label, key === selectedTab, key === "gram" || key === "settings" && !guestView && appUpdatesShown, () => {
      if (guestView) {
        if (key === "settings") guestActions.settings(); else if (key === "gram") guestActions.gram(); else guestActions.agents();
        return;
      }
      selectTab(key);
    }));
  commitTabBar(nodes, items.findIndex(([key]) => key === selectedTab));
  setTabBadge();
}

// ---- Rows ----

const px = (name: string) => parseFloat(cssVar(name));

function refreshRowSelection() {
  const inScope = selectedAgent && board && selectedAgent.machineID === board.machineID &&
    selectedAgent.session === (board.session === "default" ? "" : board.session);
  for (const row of rowsEl.querySelectorAll<HTMLElement>(".row")) {
    const selected = !!inScope && row.dataset.id === selectedAgent!.paneID;
    row.classList.toggle("selected", selected);
    row.setAttribute("aria-current", String(selected));
    let surface = row.querySelector<HTMLElement>(":scope > .row-selection");
    if (selected && !surface) {
      surface = el("div", "row-selection");
      surface.setAttribute("aria-hidden", "true");
      row.prepend(surface);
      paintShape(surface, {
        radius: parseFloat(getComputedStyle(row).getPropertyValue("--radius-selection")),
        fill: "var(--color-surface-raised)",
      });
    }
    if (surface) surface.hidden = !selected;
  }
}

async function agentRow(r: Row, separator: boolean): Promise<HTMLElement> {
  const row = el(
    "div",
    "row" + (r.badge === "waiting" ? " waiting" : "") + (separator ? "" : " no-sep") + (r.folderID ? " indented" : ""),
  );
  row.dataset.id = r.id;
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  const openDetail = () => {
    if (!board) return;
    void selectInteraction({ machineID: board.machineID, session: board.session === "default" ? "" : board.session, paneID: r.id }).then(render);
    select.hidden = true;
  };
  row.addEventListener("click", openDetail);
  row.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); } });
  const text = el("div", "text");
  const line1 = el("div", "line1");
  const age = rowAge(r, Date.now());
  line1.append(el("span", "name t-row-name", r.title));
  if (r.starred) line1.append(await star(folderDeps));
  line1.append(...rowMarkers(r), el("span", "spacer"), ...(age ? [age] : []));
  agentMenu(row, r);
  // Topics A-v2: status as words on the preview line, the avatar's face with no badge, no chevron.
  text.append(line1, rowPreview(r, r.preview));
  const account = accountLine(r);
  if (account) text.append(account);
  row.append(rowAvatar(r), text);
  return row;
}

async function disclosure(key: "idle" | "archived", title: string, count: number): Promise<HTMLElement> {
  const d = el("div", "disclosure");
  const chev = el("span", "chev");
  chev.append(await symbol(open[key] ? "chevron.down" : "chevron.right", 12, "semibold"));
  d.append(
    el("span", "title t-disclosure-title", title),
    el("span", "spacer"),
    el("span", "count t-disclosure-count", String(count)),
    chev,
  );
  d.addEventListener("click", () => {
    open[key] = !open[key];
    void renderRows();
  });
  return d;
}

async function archivedCard(r: Row): Promise<HTMLElement> {
  const c = el("div", "archived");
  c.dataset.id = r.id;
  paintShape(c, {
    radius: px("--radius-card"),
    fill: "var(--color-surface)",
    stroke: "var(--color-hairline)",
    strokeWidth: px("--size-hairline"),
  });
  const pic = el("div", "pic");
  pic.append(avatarFace(r.avatar, () => initialTile(r)), await symbol("archivebox.fill", 15, "semibold"));
  const lines = el("div", "lines");
  lines.append(el("span", "title t-card-title", r.title), el("span", "note t-card-subtitle", r.archivedNote ?? "archived"));
  c.append(pic, lines);
  return c;
}

/** The roster in herdrup's order (rosterEntries, App/HerdrApp.swift
 * agentRosterRows): live groups with their folders, then the "Idle" and
 * "Archived" disclosure rows. While searching, every matching agent shows in
 * that order, Idle's included, archived agents are left out, and nothing
 * found says so. */
async function renderRows() {
  if (!renderReady) return;
  const generation = ++rowsGeneration;
  const nodes: HTMLElement[] = [];
  if (!board) {
    if (state.phase === "connecting") {
      const spin = el("div", "loading");
      spin.innerHTML = spinnerSVG;
      nodes.push(spin);
    } else {
      nodes.push(el("p", "empty-line t-empty", state.phase === "error" ? "not connected" : "no machine"));
    }
  } else {
    updateFieldLines(board.board);
    const scope = { machineID: board.machineID, session: board.session };
    const query = searchInput.value;
    const b = board.board;
    // A search lays the list out again in Go (Desk.searchBoard): the
    // matching agents, every folder open (herdrup rosterLayout).
    const shown: Board | null = query === "" ? b : await Desk.searchBoard(query);
    if (generation !== rowsGeneration) return;
    const emptyLine = rosterEmptyLine(b, shown, query !== "");
    if (emptyLine !== null) {
      nodes.push(el("p", "empty-line t-empty", emptyLine));
    } else if (shown) {
      for (const e of rosterEntries(shown, open, query !== "")) {
        switch (e.kind) {
          case "agent": {
            const row = await agentRow(e.row, true);
            // The needs-you pill watches the waiting rows (sessions.ts).
            row.dataset.section = e.section;
            if (e.row.folderID) row.dataset.folderId = e.row.folderID;
            nodes.push(row);
            break;
          }
          case "folder":
            nodes.push(await folderRow(e.folder, folderDeps));
            break;
          case "disclosure":
            nodes.push(await disclosure(e.key, e.title, e.count));
            break;
          case "archived":
            nodes.push(await archivedCard(e.row));
            break;
        }
      }
    }
    try {
      const terminals = await terminalRows(scope, query, symbol, renderRows);
      if (terminals) nodes.push(terminals);
    } catch (error) {
      nodes.push(el("p", "empty-line t-empty", `Saved terminals: ${errorText(error)}`));
    }
  }
  if (generation !== rowsGeneration) return; // a newer render won
  // herdrup shows the spinner or the error in place of the whole list, search
  // field included (App/HerdrApp.swift: `loading && agents.isEmpty`).
  searchField.hidden = !board;
  rowsEl.replaceChildren(...nodes);
  refreshRowSelection();
  applyFolderMotion();
  renderSessionPills();
  const needsYou = tab === "agents" && !choosingHost && board && searchInput.value === "" ? (board.board.sections.find((s: Section) => s.key === "needsYou")?.rows ?? []) : [];
  const waitingRows = [...rowsEl.querySelectorAll<HTMLElement>('[data-section="needsYou"]')];
  const last = waitingRows[waitingRows.length - 1];
  await Promise.all([placeInitials(rowsEl), updateNeedsYou(needsYou, last ? last.offsetTop + last.offsetHeight : null)]);
  if (generation !== rowsGeneration) return;
  drawn = true;
  revealPendingAgent();
}
let rowsGeneration = 0;
let drawn = false;

// A folder's picture shows its first members' avatars without the status
// badge (herdrup AgentFolderPicture).
const folderDeps: FolderDeps = { el, symbol, picture: (r) => avatarFace(r.avatar, () => initialTile(r)), toggled: folderToggled };

// A folder opening or closing (motion spec §2, herdr-round5 motion-spec-send-folders.md). The
// state is saved at the click (folders.ts); this draws the change once the board shows it.
let folderMotion: { id: string; open: boolean; at: number; leaving: HTMLElement[] } | null = null;
function folderToggled(id: string, isOpen: boolean) {
  // Closing: the members drawn now are what collapses away.
  const leaving = isOpen ? [] : [...rowsEl.querySelectorAll<HTMLElement>(".row[data-folder-id]")].filter((r) => r.dataset.folderId === id);
  folderMotion = { id, open: isOpen, at: performance.now(), leaving };
}
function applyFolderMotion() {
  const m = folderMotion;
  if (!m) return;
  if (performance.now() - m.at > 3000) { folderMotion = null; return; }
  const row = [...rowsEl.querySelectorAll<HTMLElement>(".row.folder")].find((r) => r.dataset.folder === m.id);
  const chev = row?.querySelector<HTMLElement>(".chev");
  if (!row || !chev || chev.classList.contains("open") !== m.open) return; // not drawn yet
  folderMotion = null;
  const mode = motionMode();
  if (mode === "still") return;
  if (mode === "full") {
    const [from, to] = m.open ? [0, 90] : [90, 0];
    chev.animate([{ transform: `rotate(${from}deg)` }, { transform: `rotate(${to}deg)` }], { duration: SPEC.chevron.duration, easing: SPEC.chevron.ease });
  }
  // The rows move inside a clipping box whose height animates, so the rows under the folder
  // ride the change; the box unwraps (open) or leaves (close) when it lands.
  const clip = (rows: HTMLElement[]) => {
    const box = el("div", "folder-motion");
    row.after(box); box.append(...rows);
    return { box, height: box.getBoundingClientRect().height };
  };
  if (m.open) {
    const members: HTMLElement[] = [];
    for (let n = row.nextElementSibling; n instanceof HTMLElement && n.dataset.folderId === m.id; n = n.nextElementSibling) members.push(n);
    if (!members.length) return;
    if (mode === "reduced") {
      for (const r of members) r.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SPEC.fade.duration });
      return;
    }
    const o = SPEC.folderOpen, { box, height } = clip(members);
    const motions = [box.animate([{ height: "0px" }, { height: `${height}px` }], { duration: o.duration, easing: o.ease })];
    members.forEach((r, i) => motions.push(r.animate(
      [{ opacity: 0, transform: `translateY(-${o.rise}px)` }, { opacity: 1, transform: "none" }],
      { duration: o.duration, easing: o.ease, delay: Math.min(i, o.staggered - 1) * o.stagger, fill: "backwards" })));
    const unwrap = () => { if (box.isConnected) box.replaceWith(...box.childNodes); };
    void Promise.all(motions.map((a) => a.finished)).then(unwrap, unwrap);
  } else {
    if (mode === "reduced" || !m.leaving.length) return;
    // The rows drawn before the close, now detached: inert copies that count as no row
    // (selection, needs-you, folder lookups).
    for (const r of m.leaving) { for (const key of Object.keys(r.dataset)) delete r.dataset[key]; r.classList.remove("selected"); }
    const c = SPEC.folderClose, { box, height } = clip(m.leaving);
    box.inert = true; box.setAttribute("aria-hidden", "true");
    const remove = () => box.remove();
    box.animate([{ height: `${height}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: c.duration, easing: c.ease, fill: "forwards" }).finished.then(remove, remove);
  }
}

// ---- Detail column ----

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawField() {
  // The field pins the canvas's inline size; clear it so .field's inset:0 box (the detail
  // column now, e.g. after the rail opens) is measured.
  field.style.width = field.style.height = "";
  const r = field.getBoundingClientRect();
  liveField.resize({
    widthPt: r.width,
    heightPt: r.height,
    scale: devicePixelRatio,
    font: cssVar("--font-machine"),
    labelFont: getComputedStyle(select).font,
  });
}

onTextSizeChanged(() => {
  placeTitle();
  void placeInitials(document);
  if (!field.hidden) drawField();
});

// The first render places the window without motion; later swaps push (render below).
let renderedOnce = false, pushTimer = 0;
function render() {
  if (!renderReady) return;
  const showConnect = !(settingsAsked && tab === "settings") && (choosingHost || hostsHold() || (!state.guest && !board && state.phase !== "connecting" && state.phase !== "connected"));
  const guestVisible = shareShown(state) && !showConnect;
  // The guest's Gram is every shared agent's (#697); its tab shows while one shares Gram.
  setGuestGram(guestVisible);
  const gramOffered = guestVisible && guestGramOffer().offered;
  if (guestTab === "gram" && !gramOffered) guestTab = "agents";
  document.body.classList.toggle("guest-mode", guestVisible);
  // The owner's top and tab bars frame the guest home too; rebuild them as it changes.
  const nextBar = guestVisible ? { tab: guestTab, gram: gramOffered } : null;
  if (nextBar?.tab !== guestBar?.tab || nextBar?.gram !== guestBar?.gram) {
    guestBar = nextBar;
    void buildTopBar();
    buildTabBar();
  }
  guestHome?.update(state, board, guestTab === "gram" ? "agents" : guestTab, guestVisible && guestTab !== "gram", interactionVisible() ? selectedAgent?.paneID ?? null : null);
  if (guestVisible) {
    connectView.hidden = true; document.body.classList.remove("host-home-visible");
    rail?.update("agents", null, false);
    field.hidden = true; select.hidden = guestTab !== "agents" || interactionVisible();
    $("roster").hidden = true;
    updateAsks(false);
    // The app's own Settings, with the share's card and page in place of the machine's.
    const share = guestTab === "settings" && guestHome ? guestHome.shareSettings(state.guest!, guestActions.hosts) : null;
    settings?.show(guestTab === "settings", state, board, share);
    showGram(guestTab === "gram");
    showInteraction(guestTab === "agents");
    // Settings as the owner's (a page over its index, with back, on a phone); Gram sits
    // between the bars as the owner's does; the shared agent's page covers them.
    if (guestTab === "settings") placeDetail(settingsPushed ? "page" : "", settingsPushed);
    else placeDetail(guestTab === "gram" ? "bars" : interactionVisible() ? "page" : "");
    return;
  }
  const showsGram = tab === "gram" && !showConnect;
  const showsSettings = tab === "settings" && !showConnect;
  connectView.hidden = !showConnect;
  // HerdrApp.swift 229-233, 637: the machine's home and the host list push in from the
  // trailing edge when one replaces the other.
  if (document.body.classList.contains("host-home-visible") !== showConnect && renderedOnce) {
    document.body.classList.add("pushing");
    clearTimeout(pushTimer);
    pushTimer = window.setTimeout(() => document.body.classList.remove("pushing"), motionSeconds("home") * 1000 + 50);
  }
  renderedOnce = true;
  document.body.classList.toggle("host-home-visible", showConnect);
  rail?.update(tab, board?.board ?? null, !showConnect);
  const fieldWasHidden = field.hidden;
  field.hidden = showConnect || showsGram || showsSettings;
  if (fieldWasHidden && !field.hidden) drawField();
  liveField.wake();
  select.hidden = showConnect || showsGram || showsSettings || interactionVisible();
  showInteraction(!showConnect && !showsGram && !showsSettings);
  $("roster").hidden = showConnect || showsGram || showsSettings;
  updateAsks(!$("roster").hidden);
  showGram(showsGram);
  settings?.show(showsSettings, state, board);
  void renderRows();
  placeOwnerDetail(showConnect);
}

// ---- Wiring ----


searchInput.addEventListener("input", () => void renderRows());


// The shared agent page's Gram button: the guest's Gram with that agent selected (#697).
window.addEventListener("guest-gram", event => {
  // A web owner's agent page (its link is share-shaped) opens the owner's Gram.
  if (!shareShown(state)) { closeWriter(); selectTab("gram"); return; }
  guestActions.gram((event as CustomEvent<string | null>).detail ?? null);
});

// Before the handlers below, so a photo that failed is forgotten before the
// board it is asked for again on renders (avatars.ts).
trackPhotoConnections(events);
events.stateChanged.on((s) => {
  // A web owner's link admitted under another scope: the bar's create buttons follow it.
  const writesChanged = ownerWrites(s) !== ownerWrites(state);
  if (s.guest?.access.guestID !== state.guest?.access.guestID || s.guest?.access.endpoint.hostID !== state.guest?.access.endpoint.hostID) {
    guestTab = "agents";
  }
  state = s;
  if (writesChanged) void buildTopBar();
  if (s.phase !== "connected") { closeWriter(); closeInteraction(); }
  if (s.phase === "idle") board = null;
  render();
});
events.boardChanged.on((b) => {
  board = b;
  interactionBoard(b);
  render();
});

// Retain activation until the originating board has actually rendered. The
// backend also retains it, so an event before this page exists is not lost.
events.agentOpen.on((target) => openAgent(target));
// The update notification and the tray's update item open Settings, App updates, also while
// a share is open (its Settings are the app's too). Go keeps the request until the page shows
// it, so a click that launched the app, or came before Settings existed, is not lost.
function showAppUpdates() {
  if (!settings || !renderReady) return;
  if (!appUpdatesShown) { void Desk.appUpdatesShown(); return; }
  openSettingsPage("appUpdates");
  void Desk.appUpdatesShown();
}
/** Settings at `page`, with or without a machine connected (settingsAsked), also while a share
 *  is open (its Settings are the app's too). It goes by the connection, not the bar on screen:
 *  from the host chooser over an open share (no guest bar drawn), it leaves the chooser for the
 *  share's Settings, as render would show the share again anyway (review of #261). */
function openSettingsPage(page: Parameters<ReturnType<typeof initSettings>["openPage"]>[0]) {
  if (!settings) return;
  closeWriter();
  choosingHost = false;
  if (shareShown(state)) {
    guestTab = "settings";
    settings.openPage(page);
  } else {
    tab = "settings";
    settingsAsked = true;
    settings.openPage(page);
    buildTabBar();
    void buildTopBar();
  }
  render();
}
events.appUpdateOpen.on(showAppUpdates);

function openAgent(target: AgentTarget) {
  pendingAgent = target;
  const version = ++activationVersion;
  if (!pageReady) return;
  tab = "agents";
  choosingHost = false;
  buildTabBar();
  render();
  // Serialize connection/session changes; a superseded request must not
  // finish after the latest one and leave the wrong connection selected.
  activationWork = activationWork.then(async () => {
    if (version !== activationVersion) return;
    try {
      await Desk.activateAgent(target);
    } catch (err) {
      if (version !== activationVersion) return;
      const machines = await Desk.machines().catch(() => []);
      if (version !== activationVersion) return;
      const saved = machines.find((m) => m.id === target.machineID);
      const password = form.elements.namedItem("password");
      if (password instanceof HTMLInputElement) password.value = "";
      if (saved) {
        for (const [key, value] of Object.entries({ ...saved, session: target.session })) {
          const input = form.elements.namedItem(key);
          if (input instanceof HTMLInputElement) input.value = String(value ?? "");
        }
      }
      // Password-only machines cannot reconnect unattended. Show the hosts;
      // the activation stays pending, and connecting its machine with the
      // password (Desk.selectMachine) opens the activation's session.
      choosingHost = true;
      state = { ...state, phase: "error", message: errorText(err) };
      render();
    }
  });
}

function revealPendingAgent() {
  const target = pendingAgent;
  if (!pageReady || !target || !board?.listedAt || tab !== "agents") return;
  const session = board.session === "default" ? "" : board.session;
  if (board.machineID !== target.machineID || session !== target.session) return;
  const row = rowsEl.querySelector<HTMLElement>(`:is(.row, .archived)[data-id="${CSS.escape(target.paneID)}"]`);
  if (!row && searchInput.value !== "") {
    searchInput.value = "";
    void renderRows();
    return;
  }
  const section = board.board.sections.find((s: Section) => s.rows.some((r: Row) => r.id === target.paneID));
  const disclosure = board.board.archived.some((r: Row) => r.id === target.paneID) ? "archived" : section?.key === "idle" ? "idle" : null;
  if (!row && disclosure && !open[disclosure]) {
    open[disclosure] = true;
    void renderRows();
    return;
  }
  const folder = section?.rows.find((r: Row) => r.id === target.paneID)?.folderID;
  const element = row ?? (folder ? rowsEl.querySelector<HTMLElement>(`[data-folder="${CSS.escape(folder)}"]`) : null);
  if (!element) return;
  element.scrollIntoView({ block: "nearest" });
  pendingAgent = null;
  void selectInteraction(target).then(render);
  void Desk.agentOpened(target).catch(() => undefined);
}

window.addEventListener("resize", () => {
  placeTitle();
  drawField();
});

// ⌘F (Ctrl+F off the Mac) on Gram puts the cursor in the sidebar search.
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "f" && (e.metaKey || e.ctrlKey) && !e.altKey && gramShowing()) {
    e.preventDefault();
    focusGramSearch();
  }
});

async function init(rendered: () => void) {
  document.documentElement.style.setProperty("--pixel", `${1 / devicePixelRatio}px`);
  // The composer draft's line pitch and first-line offset (composerMetrics.ts).
  document.documentElement.style.setProperty("--composer-text-pitch", `${COMPOSER_TEXT_PITCH}px`);
  document.documentElement.style.setProperty("--composer-text-offset", `${COMPOSER_TEXT_OFFSET}px`);
  // herdrup's animations as CSS variables (motion.ts); Reduce Motion turns them off.
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  applyMotions(document.documentElement, reduceMotion.matches);
  reduceMotion.addEventListener("change", () => applyMotions(document.documentElement, reduceMotion.matches));
  animateDisclosures(document.body);
  enableLongPress();
  // The detail column changes size while the sidebar slides; the field follows it.
  let fieldFrame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(fieldFrame);
    fieldFrame = requestAnimationFrame(() => { if (!field.hidden) drawField(); });
  }).observe($("detail"));
  if (holdsStill) document.documentElement.classList.add("holds-still");
  // Hovering an agent row makes it type its line in the field at the row's height
  // (HerdrApp.swift 4274-4283, onContinuousHover).
  let hoveredRow: string | null = null;
  const roster = $("roster");
  roster.addEventListener("pointermove", event => {
    const id = (event.target as Element | null)?.closest<HTMLElement>(".row[data-id]")?.dataset.id ?? null;
    if (id !== hoveredRow && hoveredRow) liveField.hoverEnded(hoveredRow);
    hoveredRow = id;
    const line = id ? fieldLines.get(id) : undefined;
    if (line) liveField.hover(line, event.clientY);
  });
  roster.addEventListener("pointerleave", () => { if (hoveredRow) liveField.hoverEnded(hoveredRow); hoveredRow = null; });
  paintShape(searchField, { radius: "capsule", fill: "var(--color-surface)" });
  startupStep("search icon");
  await place($("search-icon"), "magnifyingglass", 15, "medium");
  initFolders(folderDeps);
  initAgentActions({
    row: paneID => board?.board.sections.flatMap(s => s.rows).find(r => r.id === paneID),
    tile: initialTile,
    badge: r => badge(r.badge),
    placeInitials,
    symbol,
  });
  startupStep("sidebar rail");
  rail = await initSidebarRail($("sidebar"), selectTab, () => { placeTitle(); if (!field.hidden) drawField(); void renderRows(); }, symbol, compactQuery);
  // The back button of a Settings page in the phone layout (placeDetail): to the index.
  compactBack = el("button", "compact-back-button");
  compactBack.type = "button"; compactBack.hidden = true;
  compactBack.setAttribute("aria-label", "Settings");
  startupStep("back button");
  compactBack.append(await symbol("chevron.left", 17, "semibold"), el("span", "", "Settings"));
  compactBack.onclick = () => { settingsPushed = false; render(); };
  document.body.append(compactBack);
  compactQuery.addEventListener("change", render);
  startupStep("bars");
  buildTabBar();
  await buildTopBar();
  if (parts.starAsk) starAsk = initStarAsk($("sidebar"), symbol, render);
  if (parts.appUpdates) appUpdateAsk = initAppUpdateAsk($("sidebar"), symbol, render);
  initWebAccess();
  // Its Settings are the app's own (settings.ts, show's share), not a page of its own.
  guestHome = initGuestHome($("sidebar"), $("detail"), { symbol, rowAvatar, placeInitials, spinner: spinnerSVG }, guestActions, { settings: false });
  initInteraction($("detail"), symbol, target => {
    selectedAgent = target; refreshRowSelection();
    // The guest home's row shows the open agent selected, as the roster's does; the phone
    // layout returns to the list when the agent's page closes.
    if (shareShown(state) || compactQuery.matches) render();
  });
  const hosts = initHosts(connectView, form, () => { closeInteraction(); choosingHost = false; tab = "agents"; buildTabBar(); void buildTopBar(); render(); }, symbol, spinnerSVG, () => render(), () => openSettingsPage("herdrupAccount"));
  hostsHold = hosts.holdsHome;
  hostsReady = true;
  // Compact layout: a page opened pushes over the index. Which tab holds Settings follows the
  // connection, not the bar last drawn: from the host chooser over a share there is no guest bar
  // yet, and the account avatar still opens the share's Settings (#270).
  settings = initSettings($("sidebar"), $("detail"), symbol, hosts.reconnect, () => { if ((shareShown(state) ? guestTab : tab) === "settings" && compactQuery.matches) { settingsPushed = true; render(); } });
  startupStep("gram");
  await initGram(
    {
      el,
      symbol,
      placeInitials,
      spinner: spinnerSVG,
      barChanged: unread => {
        if (guestBar) {
          if (guestTab === "gram") void buildTopBar();
          return;
        }
        rail?.unread(unread);
        gramUnread = unread;
        setTabBadge();
        if (tab === "gram") void buildTopBar();
      },
      // The guest's Gram tab comes and goes with the shares that take Gram; its badge follows.
      guestGramChanged: () => { setTabBadge(); if (guestBar && guestBar.gram !== guestGramOffer().offered) render(); },
    },
    $("detail"),
    $("sidebar"),
    $("sidebar-foot"),
  );
  startupStep("list extras");
  await initListExtras({
    symbol,
    roster: $("roster"),
    searchField,
    sidebar: $("sidebar"),
    face: (r, size) => {
      const a = el("div", "avatar");
      a.style.setProperty("--avatar-size", `${size}px`);
      a.append(avatarFace(r.avatar, () => initialTile(r)));
      return a;
    },
    needsYou: () => board?.board.needsYou ?? 0,
    rerender: () => void renderRows(),
  });
  startupStep("desk state");
  const [m, s, b] = await Promise.all([Desk.machine(), Desk.state(), Desk.board()]);
  if (m) {
    for (const [k, v] of Object.entries(m)) {
      const input = form.elements.namedItem(k);
      if (input instanceof HTMLInputElement && v) input.value = String(v);
    }
  }
  state = s;
  // The session of a board the page opens on is recorded too, so a photo
  // that fails on it is forgotten at the first switch (#49).
  if (b) boardShown(b.session);
  board = b ?? null;
  startupStep("fonts");
  await Promise.all([loadGlyphFieldFonts(cssVar("--font-machine")), document.fonts.ready]);
  placeTitle();
  drawField();
  showHostScreen();
  rendered();
  startupStep("rendered");
  // An App updates request from before the page was ready (desk openAppUpdates).
  if (parts.appUpdates) void Desk.appUpdatesPending().then((pending) => { if (pending) showAppUpdates(); }).catch(() => {});
  const version = activationVersion;
  const retained = await Desk.pendingAgent();
  if (version === activationVersion) pendingAgent = retained;
  pageReady = true;
  if (pendingAgent) openAgent(pendingAgent);
}

// Reference mode hook for the parity harness (refshot.go): tells it when
// the current state is drawn and opens the disclosure rows.
declare global {
  interface Window {
    /** Startup's current step and 1 s ticks (startupStep; app/startup_watch.go). */
    __herdrupStartup?: { step: string; ticks: number; fallback?: string };
    herdrupRef: { ready(): boolean; expand(key: "idle" | "archived" | `folder:${string}`, isOpen: boolean): void };
  }
}
window.herdrupRef = {
  ready: () => drawn && document.fonts.status === "loaded",
  expand(key, isOpen) {
    drawn = false;
    if (key.startsWith("folder:")) {
      // Go sends the board back with the folder open or closed.
      void Desk.setFolderOpen(key.slice("folder:".length), isOpen)
        .then(() => Desk.board())
        .then((b) => {
          if (b) boardShown(b.session);
          board = b ?? null;
          return renderRows();
        });
      return;
    }
    open[key as "idle" | "archived"] = isOpen;
    void renderRows();
  },
};

// Startup that throws or never finishes still renders, and says why in the app's output
// (startup.ts); so does any later uncaught error.
// Where startup is, for a device whose window stays on its empty bars (RoverOS):
// app/startup_watch.go reads it from outside the page's timers when no first render has come,
// and ticks says whether this page's timers run at all.
const startup: { step: string; ticks: number; fallback?: string } = { step: "module", ticks: 0 };
window.__herdrupStartup = startup;
const startupTicks = window.setInterval(() => { startup.ticks++; }, 1000);
function startupStep(step: string) {
  startup.step = step;
  if (step === "rendered") clearInterval(startupTicks);
}

const reportPageError = (message: string) => { void Desk.reportPageError(message).catch(() => {}); };
window.addEventListener("error", event => reportPageError(`uncaught: ${errorDetail(event.error ?? event.message)}`));
window.addEventListener("unhandledrejection", event => reportPageError(`unhandled rejection: ${errorDetail(event.reason)}`));
void startWithFallback(init, {
  firstRender: () => {
    if (renderReady) return;
    // The step stays where startup stopped; the fallback that rendered instead goes beside it.
    if (hostsReady) { startup.fallback = "host screen"; showHostScreen(); } else { startup.fallback = "startup error"; showStartupError(); }
  },
  report: reportPageError,
});

/** The first render: whatever startup has drawn, with no startup-error page left over it (one an
 *  earlier fallback showed before the host screen could work). */
function showHostScreen() {
  startupError?.remove(); startupError = null;
  renderReady = true;
  render();
}

/** Startup stopped before the host screen could work: say so in place of the screen, with a
 *  way to start again. The cause is in the app's log (reportPageError). A startup that still
 *  finishes replaces it (init). */
function showStartupError() {
  if (startupError) return;
  startupError = el("section", "startup-error");
  startupError.setAttribute("role", "alert");
  const again = el("button", "", "Try again");
  again.type = "button";
  again.onclick = () => location.reload();
  startupError.append(el("h1", "", "HerdrUp couldn't finish starting"), el("p", "dim", "The reason is in the app's log."), again);
  connectView.hidden = true;
  document.body.append(startupError);
}
