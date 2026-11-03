import "core-js/actual/promise/with-resolvers";
import { symbol } from "./symbol";
import { Desk, events, type AgentTarget, type Board, type BoardUpdate, type ConnState, type Row, type Section } from "./mygo";
import { paintShape } from "./continuous";
import { loadGlyphFieldFonts } from "./glyphField";
import { LiveGlyphField, Tone, type FieldLine } from "./glyphFieldLive";
import { agentMenu, folderRow, initFolders, rosterEmptyLine, rosterEntries, star, type FolderDeps } from "./folders";
import { initAgentActions } from "./agentActions";
import { avatarFace, boardShown, forgetFailedPhotos } from "./avatars";
import { accountLine, initListExtras, renderSessionPills, rowAge, rowMarkers, updateNeedsYou } from "./sessions";
import { barActions, barCount, focusGramSearch, gramShowing, initGram, showGram, setGuestGramRecipient } from "./gram";
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
import { animateDisclosures, applyMotions, motionSeconds } from "./motion";
import { initStarAsk } from "./starAsk";
import { errorText } from "./errors";
import { appUpdatesShown, watchAppUpdate } from "./appUpdates";
import { avatar, badge, initialTile, placeInitials, spinnerSVG } from "./faces";
import { barSlot, commitTabBar, commitTopBar, guestBarActions, placeTitle, tabNode } from "./bars";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const rowsEl = $("rows");
const searchField = $("search-field");
const searchInput = $<HTMLInputElement>("search");
const connectView = $("connect");
const form = $<HTMLFormElement>("connect-form");
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
let settings: ReturnType<typeof initSettings> | null = null;
let rail: Awaited<ReturnType<typeof initSidebarRail>> | null = null;
let starAsk: ReturnType<typeof initStarAsk> | null = null;
let pendingAgent: AgentTarget | null = null;
let selectedAgent: AgentTarget | null = null;
let activationVersion = 0;
let activationWork = Promise.resolve();
let pageReady = false;
// Connection events retain state immediately; drawing waits for every view's dependencies.
let renderReady = false;
let guestHome: ReturnType<typeof initGuestHome> | null = null;
let guestTab: "agents" | "settings" = "agents";
let guestGram = false;
// The guest home's top and tab bars as last built (render): its tab, and whether Gram
// replaces the terminal; null while the owner's bars show.
let guestBar: { tab: "agents" | "settings"; gram: boolean } | null = null;
const guestActions = {
  agents: () => { guestTab = "agents"; guestGram = false; render(); },
  settings: () => { closeWriter(); guestTab = "settings"; guestGram = false; render(); },
  hosts: () => { closeWriter(); closeInteraction(); choosingHost = true; render(); },
  terminal: () => { guestGram = false; render(); },
  open: (target: AgentTarget) => { guestTab = "agents"; guestGram = false; void selectInteraction(target).then(render); },
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
  const chooseHost = guestView ? guestActions.hosts : () => { closeWriter(); choosingHost = true; render(); };
  back.onclick = chooseHost;
  back.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); chooseHost(); } };
  if (guestView) {
    titleNodes = [document.createTextNode(selectedTab === "settings" ? "Settings" : "Agents")];
    actionNodes = await guestBarActions(guestView.gram, guestActions.terminal);
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
    if (selectedTab === "agents") {
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

let tabBarGeneration = 0;
// Gram's unread count, as the last snapshot reported it (gram.ts barChanged).
let gramUnread = 0;
// Whether a newer Herdrup waits to be installed (appUpdates.ts).
let appUpdateWaiting = false;
watchAppUpdate(s => { appUpdateWaiting = s.phase === "available"; setTabBadge(); });
// The unread badges' fill: native's Color(uiColor: .systemRed) in its dark scheme. It is a
// system colour, not a herdrup design token, so it is set here (owner, 2026-11-03: red, as native).
document.documentElement.style.setProperty("--system-red", "#ff453a");
/** sidebarTabItem's tabBadge (HerdrApp.swift 2871-2881): the count on the Gram icon's
 *  top-trailing corner, "99+" past 99, hidden at zero; white on system red. */
function setTabBadge() {
  const badge = document.querySelector<HTMLElement>('#tabbar .tab-badge[data-tab="gram"]');
  if (badge) {
    badge.hidden = gramUnread === 0;
    badge.textContent = gramUnread > 99 ? "99+" : String(gramUnread);
    badge.closest(".tab")?.setAttribute("aria-label", gramUnread ? `Gram, ${gramUnread} unread` : "Gram");
  }
  // The same badge on Settings while a newer Herdrup waits (Settings' suggestion of it).
  const settings = document.querySelector<HTMLElement>('#tabbar .tab-badge[data-tab="settings"]');
  if (settings) {
    // Text only while shown: a hidden "1" still joined the tab's text ("Settings1").
    settings.hidden = !appUpdateWaiting; settings.textContent = appUpdateWaiting ? "1" : "";
    settings.closest(".tab")?.setAttribute("aria-label", appUpdateWaiting ? "Settings, update available" : "Settings");
  }
}
async function buildTabBar() {
  const generation = ++tabBarGeneration, guestView = guestBar, selectedTab = guestView ? guestView.tab : tab;
  // A guest's TabView holds Agents and Settings only; the shared agent's Gram is a tab of
  // its own screen (App/GuestHomeView.swift 29-31, 96-105).
  const items: Array<[typeof tab, string, string]> = [
    ["agents", "square.grid.2x2.fill", "Agents"],
    ...(guestView ? [] : [["gram", "bubble.left.and.bubble.right.fill", "Gram"] as [typeof tab, string, string]]),
    ["settings", "gearshape.fill", "Settings"],
  ];
  const nodes = await Promise.all(
    items.map(([key, icon, label]) =>
      // The guest's Settings is its own page, without the app update.
      tabNode(key, icon, label, key === selectedTab, key === "gram" || key === "settings" && !guestView && appUpdatesShown, () => {
        if (guestView) {
          if (key === "settings") guestActions.settings(); else guestActions.agents();
          return;
        }
        tab = key;
        choosingHost = false;
        void buildTabBar();
        void buildTopBar();
        render();
      })),
  );
  if (generation !== tabBarGeneration) return;
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
  const chev = el("span", "chev");
  chev.append(await symbol("chevron.right", 12, "semibold"));
  const age = rowAge(r, Date.now());
  line1.append(el("span", "name t-row-name", r.title));
  if (r.starred) line1.append(await star(folderDeps));
  line1.append(...rowMarkers(r), el("span", "spacer"), ...(age ? [age] : []), chev);
  agentMenu(row, r);
  text.append(line1, el("div", "preview t-row-preview", r.preview));
  const account = accountLine(r);
  if (account) text.append(account);
  row.append(await avatar(r), text);
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
const folderDeps: FolderDeps = { el, symbol, picture: (r) => avatarFace(r.avatar, () => initialTile(r)) };

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
  const showConnect = choosingHost || hostsHold() || (!state.guest && !board && state.phase !== "connecting" && state.phase !== "connected");
  const guestVisible = !!state.guest && !showConnect;
  if (state.guest && !state.guest.features.gram) guestGram = false;
  setGuestGramRecipient(guestVisible ? state.guest!.access.agentName : null);
  document.body.classList.toggle("guest-mode", guestVisible);
  // The owner's top and tab bars frame the guest home too; rebuild them as it changes.
  const nextBar = guestVisible ? { tab: guestTab, gram: guestTab === "agents" && guestGram } : null;
  if (nextBar?.tab !== guestBar?.tab || nextBar?.gram !== guestBar?.gram) {
    guestBar = nextBar;
    void buildTopBar();
    void buildTabBar();
  }
  guestHome?.update(state, board, guestTab, guestVisible, interactionVisible() ? selectedAgent?.paneID ?? null : null);
  if (guestVisible) {
    connectView.hidden = true; document.body.classList.remove("host-home-visible");
    rail?.update("agents", null, false);
    field.hidden = true; select.hidden = guestTab === "settings" || guestGram || interactionVisible();
    $("roster").hidden = true;
    starAsk?.update(false);
    settings?.show(false, state, board);
    showGram(guestTab === "agents" && guestGram && !!state.guest?.features.gram);
    showInteraction(guestTab === "agents" && !guestGram);
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
  starAsk?.update(!$("roster").hidden);
  showGram(showsGram);
  settings?.show(showsSettings, state, board);
  void renderRows();
}

// ---- Wiring ----


searchInput.addEventListener("input", () => void renderRows());


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
  // Each connection attempt is a new connection: photos that failed on the
  // last one are asked for again, as Desk's own store does.
  if (s.phase === "connecting") forgetFailedPhotos();
  render();
});
events.boardChanged.on((b) => {
  boardShown(b.session);
  board = b;
  interactionBoard(b);
  render();
});

// Retain activation until the originating board has actually rendered. The
// backend also retains it, so an event before this page exists is not lost.
events.agentOpen.on((target) => openAgent(target));

function openAgent(target: AgentTarget) {
  pendingAgent = target;
  const version = ++activationVersion;
  if (!pageReady) return;
  tab = "agents";
  choosingHost = false;
  void buildTabBar();
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

async function init() {
  document.documentElement.style.setProperty("--pixel", `${1 / devicePixelRatio}px`);
  // The composer draft's line pitch and first-line offset (composerMetrics.ts).
  document.documentElement.style.setProperty("--composer-text-pitch", `${COMPOSER_TEXT_PITCH}px`);
  document.documentElement.style.setProperty("--composer-text-offset", `${COMPOSER_TEXT_OFFSET}px`);
  // herdrup's animations as CSS variables (motion.ts); Reduce Motion turns them off.
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  applyMotions(document.documentElement, reduceMotion.matches);
  reduceMotion.addEventListener("change", () => applyMotions(document.documentElement, reduceMotion.matches));
  animateDisclosures(document.body);
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
  await place($("search-icon"), "magnifyingglass", 15, "medium");
  initFolders(folderDeps);
  initAgentActions({
    row: paneID => board?.board.sections.flatMap(s => s.rows).find(r => r.id === paneID),
    tile: initialTile,
    badge: r => badge(r.badge),
    placeInitials,
    symbol,
  });
  rail = await initSidebarRail($("sidebar"), next => {
    tab = next; choosingHost = false; void buildTabBar(); void buildTopBar(); render();
  }, () => { placeTitle(); if (!field.hidden) drawField(); void renderRows(); }, symbol);
  await Promise.all([buildTopBar(), buildTabBar()]);
  starAsk = initStarAsk($("sidebar"), symbol, render);
  guestHome = initGuestHome($("sidebar"), $("detail"), { symbol, avatar, placeInitials, spinner: spinnerSVG }, guestActions);
  initInteraction($("detail"), symbol, target => {
    selectedAgent = target; refreshRowSelection();
    // The guest home's row shows the open agent selected, as the roster's does.
    if (state.guest) render();
  });
  const hosts = initHosts(connectView, form, () => { closeInteraction(); choosingHost = false; tab = "agents"; void buildTabBar(); void buildTopBar(); render(); }, symbol, spinnerSVG, () => render());
  hostsHold = hosts.holdsHome;
  settings = initSettings($("sidebar"), $("detail"), symbol, hosts.reconnect);
  await initGram(
    {
      el,
      symbol,
      placeInitials,
      spinner: spinnerSVG,
      barChanged: unread => {
        rail?.unread(unread);
        gramUnread = unread;
        setTabBadge();
        if (tab === "gram") void buildTopBar();
      },
    },
    $("detail"),
    $("sidebar"),
    $("tabbar"),
  );
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
  await Promise.all([loadGlyphFieldFonts(cssVar("--font-machine")), document.fonts.ready]);
  placeTitle();
  drawField();
  renderReady = true;
  render();
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

void init();
