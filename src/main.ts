import "core-js/actual/promise/with-resolvers";
import { Desk, Symbols, events, type AgentTarget, type Board, type BoardUpdate, type ConnState, type Row, type Section } from "./mygo";
import { continuousPath, paintShape } from "./continuous";
import { drawRestingGlyphField, loadGlyphFieldFonts } from "./glyphField";
import { agentMenu, folderRow, initFolders, rosterEmptyLine, rosterEntries, star, type FolderDeps } from "./folders";
import { avatarFace, boardShown, forgetFailedPhotos } from "./avatars";
import { accountLine, initListExtras, renderSessionPills, rowAge, rowMarkers, updateNeedsYou } from "./sessions";
import { barActions, barCount, focusGramSearch, gramShowing, initGram, showGram } from "./gram";
import { initInteraction, selectInteraction, interactionVisible, showInteraction, closeInteraction, interactionBoard } from "./interaction";
import { initHosts } from "./hosts";
import { initSettings } from "./settings";
import { closeWriter } from "./composer";
import { onTextSizeChanged } from "./textSize";
import { initSidebarRail } from "./sidebar";
import { showNewAgent, showNewTerminal } from "./create";
import { terminalRows } from "./terminals";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const rowsEl = $("rows");
const searchField = $("search-field");
const searchInput = $<HTMLInputElement>("search");
const connectView = $("connect");
const form = $<HTMLFormElement>("connect-form");
const select = $("select");
const field = $<HTMLCanvasElement>("field");

let state: ConnState = { phase: "idle", message: "", machine: "", herdr: "", live: false };
let board: BoardUpdate | null = null;
let tab: "agents" | "gram" | "settings" = "agents";
let choosingHost = false;
let settings: ReturnType<typeof initSettings> | null = null;
let rail: Awaited<ReturnType<typeof initSidebarRail>> | null = null;
let pendingAgent: AgentTarget | null = null;
let selectedAgent: AgentTarget | null = null;
let activationVersion = 0;
let activationWork = Promise.resolve();
let pageReady = false;
// Connection events retain state immediately; drawing waits for every view's dependencies.
let renderReady = false;
// Disclosure rows ("Idle", "Archived") start closed, as in herdrup.
const open: Record<"idle" | "archived", boolean> = { idle: false, archived: false };

// ---- SF Symbols (macOS) or their open substitutes, as tinted masks ----

const symbolCache = new Map<string, Promise<HTMLElement>>();

/** An SF Symbol at a point size and weight, tinted by CSS `color`. Symbols
 * draws at 1, 2 or 3 pixels per point, so the page's ratio is clamped to
 * that. A symbol that fails is logged and left empty, not cached, so one
 * missing icon never stops the page from drawing. */
function symbol(name: string, size: number, weight: string): Promise<HTMLElement> {
  const key = `${name}/${size}/${weight}`;
  let made = symbolCache.get(key);
  if (!made) {
    const scale = Math.min(3, Math.max(1, Math.round(devicePixelRatio)));
    made = Symbols.image(name, size, weight, scale).then((img) => {
      const el = document.createElement("span");
      el.className = "sym";
      el.style.width = `${img.width}px`;
      el.style.height = `${img.height}px`;
      el.style.setProperty("--sym", `url("${img.dataURL}")`);
      return el;
    });
    symbolCache.set(key, made);
    made.catch(() => symbolCache.delete(key));
  }
  return made.then(
    (el) => el.cloneNode(true) as HTMLElement,
    (err) => {
      console.error(`symbol ${key}:`, err);
      return el("span", "sym");
    },
  );
}

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

async function buildTopBar() {
  const leading = $("bar-leading");
  const actions = $("bar-actions");
  const slot = async (name: string, label: string) => {
    const s = el("div", "slot");
    s.title = label;
    await place(s, name, 15, "medium");
    return s;
  };
  const back = await slot("chevron.left", "Choose host");
  back.tabIndex = 0; back.setAttribute("role", "button");
  const chooseHost = () => { closeWriter(); choosingHost = true; render(); };
  back.onclick = chooseHost;
  back.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); chooseHost(); } };
  leading.replaceChildren(back);
  const title = $("bar-title");
  if (tab === "gram") {
    // gramSidebar: "Gram" with the amber unread count, then Read all and Refresh.
    const count = barCount();
    title.replaceChildren(document.createTextNode("Gram"), ...(count ? [count] : []));
    actions.replaceChildren(...(await barActions(() => rail?.minimize())));
  } else {
    title.replaceChildren(document.createTextNode(tab === "settings" ? "Settings" : "Agents"));
    const minimize = await slot("sidebar.leading", "Minimise sidebar");
    minimize.tabIndex = 0; minimize.setAttribute("role", "button"); minimize.setAttribute("aria-label", "Minimise sidebar");
    minimize.onclick = () => rail?.minimize();
    minimize.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); rail?.minimize(); } };
    actions.replaceChildren(minimize);
    if (tab === "agents") {
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
      actions.append(terminal, add);
    }
  }
  // The capsules' shapes go with their children.
  paintShape(leading, { radius: "capsule", fill: "var(--color-surface-raised)" });
  paintShape(actions, { radius: "capsule", fill: "var(--color-surface-raised)" });
  placeTitle();
}

/** SectionBarLayout: centre the title on the bar when it fits, else keep it
 * 8 pt clear of both capsules (herdrup App/SectionTopBar.swift). */
function placeTitle() {
  const bar = $("bar-title").parentElement as HTMLElement;
  const title = $("bar-title");
  const leading = $("bar-leading").getBoundingClientRect().width;
  const actions = $("bar-actions").getBoundingClientRect().width;
  const width = bar.getBoundingClientRect().width;
  const titleLeading = leading > 0 ? leading + 8 : 0;
  const available = Math.max(0, width - titleLeading - actions - 8);
  const w = Math.min(title.getBoundingClientRect().width, available);
  const centre = Math.max(titleLeading + w / 2, Math.min(width / 2, titleLeading + available - w / 2));
  title.style.left = `${centre - w / 2}px`;
}

// ---- Tab bar ----

async function buildTabBar() {
  const items: Array<[typeof tab, string, string]> = [
    ["agents", "square.grid.2x2.fill", "Agents"],
    ["gram", "bubble.left.and.bubble.right.fill", "Gram"],
    ["settings", "gearshape.fill", "Settings"],
  ];
  const nodes = await Promise.all(
    items.map(async ([key, icon, label]) => {
      const t = el("div", "tab" + (key === tab ? " selected" : ""));
      const i = el("div", "icon");
      await place(i, icon, 21, "medium");
      t.append(i, el("span", "t-tab-label", label));
      t.addEventListener("click", () => {
        tab = key;
        choosingHost = false;
        void buildTabBar();
        void buildTopBar();
        render();
      });
      return t;
    }),
  );
  $("tabbar").replaceChildren(...nodes);
}

// ---- Rows ----

const px = (name: string) => parseFloat(cssVar(name));

/** The badge's shape as herdrup draws it (AgentAvatar.glyph): a continuous
 * RoundedRectangle (continuous.ts) filled, then stroked in ground colour
 * centred on the same path, half of it outside. "Round" badges use herdrup's
 * literal corner radius 11, which on the 22 pt box is a continuous capsule,
 * not a circle; squares use radius.badgeSquare.
 *
 * The SVG overhangs the badge box by BADGE_PAD (whole points, more than half
 * the stroke) on every side, so its origin stays on a device pixel: WebKit
 * snaps an SVG's origin to the pixel grid, and an overhang of exactly half the
 * 2.5 pt stroke put it on a half pixel and moved the whole badge 0.5 px. */
const BADGE_PAD = 2;
function badgeShape(square: boolean): HTMLElement {
  const size = px("--size-status-badge");
  const stroke = px("--size-status-badge-stroke");
  const radius = square ? px("--radius-badge-square") : 11;
  const box = size + 2 * BADGE_PAD;
  const d = continuousPath(size, size, radius, BADGE_PAD, BADGE_PAD);
  const shape = el("span", "shape");
  shape.style.inset = `${-BADGE_PAD}px`;
  shape.innerHTML = `<svg width="${box}" height="${box}" viewBox="0 0 ${box} ${box}"><path class="fill" d="${d}"/><path class="edge" d="${d}" stroke-width="${stroke}"/></svg>`;
  return shape;
}

async function badge(kind: string): Promise<HTMLElement | null> {
  const b = el("div", "badge " + kind);
  b.append(badgeShape(kind === "stopped" || kind === "offline"));
  switch (kind) {
    case "waiting":
      b.append(await symbol("exclamationmark", 10, "heavy"));
      return b;
    case "unrecognised":
      b.append(await symbol("questionmark", 10, "heavy"));
      return b;
    case "stopped":
      b.append(await symbol("xmark", 10, "heavy"));
      return b;
    case "offline":
      b.append(await symbol("wifi.slash", 10, "heavy"));
      return b;
    case "working": {
      // TurningRing(diameter: 12, lineWidth: 2) at rest (herdrup
      // App/DesignSystem.swift): Circle().trim(0, 0.72) in a 12 pt frame, so
      // the path's radius is 6 and the 2 pt round-capped stroke reaches 7,
      // past the frame (overflow: visible); from 3 o'clock clockwise, over
      // the ground-filled circle the other badges also have.
      const r = 6;
      const len = 2 * Math.PI * r;
      b.insertAdjacentHTML(
        "beforeend",
        `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="${r}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="${len * 0.72} ${len}"/></svg>`,
      );
      return b;
    }
  }
  return null;
}

const measure = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;

/** A tile with the agent's initial. placeInitials positions the letter once
 * the tile is in the document. */
function initialTile(r: Row): HTMLElement {
  const tile = el("div", `tile tint-${r.tint}`);
  const glyph = el("span", "initial", r.initial);
  tile.append(glyph);
  return tile;
}

/** Puts each tile's initial where SwiftUI puts a centred Text: the run's
 * origin rounded to the nearest device pixel. Left to flex centring, WebKit
 * rounded fractions above a half down, which drew M and W 1 device pixel left
 * of herdrup's. The advance is measured in the letter's computed font, which
 * is loaded first: canvas text falls back to another face while a web font is
 * still loading, and `document.fonts.ready` does not wait for a face nothing
 * had asked for yet (the system font's narrower A put it 1 pixel right). */
async function placeInitials(root: ParentNode) {
  const tiles = [...root.querySelectorAll<HTMLElement>(".tile")].flatMap((tile) => {
    const glyph = tile.querySelector<HTMLElement>(".initial");
    if (!glyph) return [];
    const s = getComputedStyle(glyph);
    return [{ tile, glyph, font: `${s.fontWeight} ${s.fontSize} ${s.fontFamily}` }];
  });
  await Promise.all([...new Set(tiles.map((t) => t.font))].map((f) => document.fonts.load(f)));
  for (const { tile, glyph, font } of tiles) {
    measure.font = font;
    const advance = measure.measureText(glyph.textContent ?? "").width;
    const box = tile.getBoundingClientRect().width;
    if (box <= 0) continue; // A hidden page is positioned when its layout becomes visible.
    glyph.style.left = `${Math.round(((box - advance) / 2) * devicePixelRatio) / devicePixelRatio}px`;
  }
}

async function avatar(r: Row): Promise<HTMLElement> {
  const a = el("div", "avatar");
  a.append(avatarFace(r.avatar, () => initialTile(r)));
  const b = await badge(r.badge);
  if (b) a.append(b);
  return a;
}

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
      nodes.push(el("p", "empty-line t-empty", `Saved terminals: ${String(error)}`));
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

// UIActivityIndicatorView (medium) frozen on its first frame, as herdrup's
// loading references show it (measured on both): 8 round-capped spokes 2.5 pt
// wide from radius 3.6 to 10 in a 20 pt box, textDim at opacity 0.85 at 9
// o'clock, then counter-clockwise 0.85 - 0.144 per spoke for three more, and
// the other four at 0.275.
const spinnerSVG = (() => {
  let s = `<svg width="20" height="20" viewBox="-10 -10 20 20">`;
  for (let i = 0; i < 8; i++) {
    const opacity = i < 4 ? 0.85 - i * 0.144 : 0.275;
    s += `<rect x="-1.25" y="-10" width="2.5" height="6.4" rx="1.25" fill="currentColor" opacity="${opacity.toFixed(3)}" transform="rotate(${-90 - i * 45})"/>`;
  }
  return s + "</svg>";
})();

// ---- Detail column ----

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// herdrup DesktopReferenceMock.glyphFieldSeed, the resting picture's seed.
const glyphFieldSeed = 0x4845524452555031n;

function drawField() {
  const r = field.getBoundingClientRect();
  drawRestingGlyphField(field, {
    widthPt: r.width,
    heightPt: r.height,
    scale: devicePixelRatio,
    seed: glyphFieldSeed,
    // The resting picture draws every glyph in hairline on groundMachine.
    colours: {
      groundMachine: cssVar("--color-ground-machine"),
      hairline: cssVar("--color-hairline"),
    },
    font: cssVar("--font-machine"),
    labelFont: getComputedStyle(select).font,
  });
}

onTextSizeChanged(() => {
  placeTitle();
  void placeInitials(document);
  if (!field.hidden) drawField();
});

function render() {
  if (!renderReady) return;
  const showConnect = choosingHost || (!board && state.phase !== "connecting" && state.phase !== "connected");
  const showsGram = tab === "gram" && !showConnect;
  const showsSettings = tab === "settings" && !showConnect;
  connectView.hidden = !showConnect;
  document.body.classList.toggle("host-home-visible", showConnect);
  rail?.update(tab, board?.board ?? null, !showConnect);
  const fieldWasHidden = field.hidden;
  field.hidden = showConnect || showsGram || showsSettings;
  if (fieldWasHidden && !field.hidden) drawField();
  select.hidden = showConnect || showsGram || showsSettings || interactionVisible();
  showInteraction(!showConnect && !showsGram && !showsSettings);
  $("roster").hidden = showConnect || showsGram || showsSettings;
  showGram(showsGram);
  settings?.show(showsSettings, state, board);
  void renderRows();
}

// ---- Wiring ----


searchInput.addEventListener("input", () => void renderRows());


events.stateChanged.on((s) => {
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
      // Password-only machines cannot reconnect unattended. Show the form;
      // the activation remains pending while the user supplies credentials.
      choosingHost = true;
      state = { ...state, phase: "error", message: err instanceof Error ? err.message : String(err) };
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
  paintShape(searchField, { radius: "capsule", fill: "var(--color-surface)" });
  paintShape($("sidebar"), { radius: px("--sidebar-radius"), fill: "var(--color-ground)", clip: true });
  await place($("search-icon"), "magnifyingglass", 15, "medium");
  initFolders(folderDeps);
  rail = await initSidebarRail($("sidebar"), next => {
    tab = next; choosingHost = false; void buildTabBar(); void buildTopBar(); render();
  }, () => { placeTitle(); if (!field.hidden) drawField(); void renderRows(); }, symbol);
  await Promise.all([buildTopBar(), buildTabBar()]);
  initInteraction($("detail"), symbol, target => { selectedAgent = target; refreshRowSelection(); });
  const hosts = initHosts(connectView, form, () => { closeInteraction(); choosingHost = false; tab = "agents"; void buildTabBar(); void buildTopBar(); render(); }, symbol);
  settings = initSettings($("sidebar"), $("detail"), symbol, hosts.reconnect);
  await initGram(
    {
      el,
      symbol,
      placeInitials,
      spinner: spinnerSVG,
      barChanged: unread => {
        rail?.unread(unread);
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
