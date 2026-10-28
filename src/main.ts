import { Desk, Symbols, events, type BoardUpdate, type ConnState, type Row, type Section } from "./mygo";
import { drawRestingGlyphField } from "./glyphField";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const rowsEl = $("rows");
const connectView = $("connect");
const form = $<HTMLFormElement>("connect-form");
const connectError = $("connect-error");
const disconnect = $<HTMLButtonElement>("disconnect");
const select = $("select");
const field = $<HTMLCanvasElement>("field");

let state: ConnState = { phase: "idle", message: "", machine: "", herdr: "", live: false };
let board: BoardUpdate | null = null;
let tab: "agents" | "gram" | "settings" = "agents";
// Disclosure rows ("Idle", "Archived") start closed, as in herdrup.
const open: Record<"idle" | "archived", boolean> = { idle: false, archived: false };

// ---- SF Symbols (macOS) or their open substitutes, as tinted masks ----

const symbolCache = new Map<string, Promise<HTMLElement>>();

/** An SF Symbol at a point size and weight, tinted by CSS `color`. */
function symbol(name: string, size: number, weight: string): Promise<HTMLElement> {
  const key = `${name}/${size}/${weight}`;
  let made = symbolCache.get(key);
  if (!made) {
    made = Symbols.image(name, size, weight, Math.max(1, Math.round(devicePixelRatio))).then((img) => {
      const el = document.createElement("span");
      el.className = "sym";
      el.style.width = `${img.width}px`;
      el.style.height = `${img.height}px`;
      el.style.setProperty("--sym", `url("${img.dataURL}")`);
      return el;
    });
    symbolCache.set(key, made);
  }
  return made.then((el) => el.cloneNode(true) as HTMLElement);
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
  leading.replaceChildren(await slot("chevron.left", "Back"));
  actions.replaceChildren(
    await slot("sidebar.leading", "Minimise sidebar"),
    await slot("terminal", "New terminal"),
    await slot("plus", "New agent"),
  );
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
        void buildTabBar();
        render();
      });
      return t;
    }),
  );
  $("tabbar").replaceChildren(...nodes);
}

// ---- Rows ----

async function badge(kind: string): Promise<HTMLElement | null> {
  const b = el("div", "badge " + kind);
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
      // TurningRing at rest: 12 pt, 2 pt round-capped stroke, 72% of the
      // circle from 3 o'clock clockwise (herdrup App/DesignSystem.swift).
      const r = 5;
      const len = 2 * Math.PI * r;
      b.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="${r}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="${len * 0.72} ${len}"/></svg>`;
      return b;
    }
  }
  return null;
}

async function avatar(r: Row): Promise<HTMLElement> {
  const a = el("div", "avatar");
  const tile = el("div", `tile tint-${r.tint}`, r.initial);
  a.append(tile);
  const b = await badge(r.badge);
  if (b) a.append(b);
  return a;
}

async function agentRow(r: Row, separator: boolean): Promise<HTMLElement> {
  const row = el("div", "row" + (r.badge === "waiting" ? " waiting" : "") + (separator ? "" : " no-sep"));
  row.dataset.id = r.id;
  const text = el("div", "text");
  const line1 = el("div", "line1");
  const chev = el("span", "chev");
  chev.append(await symbol("chevron.right", 12, "semibold"));
  line1.append(el("span", "name t-row-name", r.title), el("span", "spacer"), chev);
  text.append(line1, el("div", "preview t-row-preview", r.preview));
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
  const pic = el("div", "pic");
  pic.append(el("div", `tile tint-${r.tint}`, r.initial), await symbol("archivebox.fill", 15, "semibold"));
  const lines = el("div", "lines");
  lines.append(el("span", "title t-card-title", r.title), el("span", "note t-card-subtitle", r.archivedNote ?? "archived"));
  c.append(pic, lines);
  return c;
}

/** The roster in herdrup's order: live groups as plain rows, then the
 * "Idle" and "Archived" disclosure rows (App/HerdrApp.swift agentRosterRows). */
async function renderRows() {
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
    const sections = board.board.sections;
    const live = sections.filter((s: Section) => s.key !== "idle");
    const idle = sections.find((s: Section) => s.key === "idle");
    if (live.length === 0 && !idle && board.board.archived.length === 0) {
      nodes.push(el("p", "empty-line t-empty", "no agents"));
    }
    for (const s of live) {
      for (const r of s.rows) nodes.push(await agentRow(r, true));
    }
    if (idle) {
      nodes.push(await disclosure("idle", "Idle", idle.rows.length));
      if (open.idle) for (const r of idle.rows) nodes.push(await agentRow(r, true));
    }
    const archived = board.board.archived;
    if (archived.length > 0) {
      nodes.push(await disclosure("archived", "Archived", archived.length));
      if (open.archived) for (const r of archived) nodes.push(await archivedCard(r));
    }
  }
  if (generation !== rowsGeneration) return; // a newer render won
  rowsEl.replaceChildren(...nodes);
  drawn = true;
}
let rowsGeneration = 0;
let drawn = false;

// UIActivityIndicatorView (medium) at rest: 8 spokes fading round.
const spinnerSVG = (() => {
  let s = `<svg width="20" height="20" viewBox="-10 -10 20 20">`;
  for (let i = 0; i < 8; i++) {
    const opacity = 1 - i * 0.1;
    s += `<rect x="-1.25" y="-9" width="2.5" height="5.5" rx="1.25" fill="currentColor" opacity="${opacity.toFixed(2)}" transform="rotate(${-i * 45})"/>`;
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
  });
}

function render() {
  const showConnect = tab === "settings" || (!board && state.phase !== "connecting" && state.phase !== "connected");
  connectView.hidden = !showConnect;
  field.hidden = showConnect;
  select.hidden = showConnect;
  connectError.hidden = state.phase !== "error";
  connectError.textContent = state.phase === "error" ? `${state.machine}: ${state.message}` : "";
  disconnect.hidden = state.phase === "idle";
  void renderRows();
}

// ---- Wiring ----

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(form);
  const get = (k: string) => String(f.get(k) ?? "").trim();
  try {
    board = null;
    tab = "agents";
    void buildTabBar();
    await Desk.connect(
      { host: get("host"), port: Number(get("port")) || 22, user: get("user"), keyPath: get("keyPath"), session: get("session") },
      String(f.get("password") ?? ""),
    );
  } catch (err) {
    state = { ...state, phase: "error", message: err instanceof Error ? err.message : String(err) };
    render();
  }
});

disconnect.addEventListener("click", () => {
  board = null;
  void Desk.disconnect();
});

events.stateChanged.on((s) => {
  state = s;
  if (s.phase === "idle") board = null;
  render();
});
events.boardChanged.on((b) => {
  board = b;
  render();
});

window.addEventListener("resize", () => {
  placeTitle();
  drawField();
});

async function init() {
  document.documentElement.style.setProperty("--pixel", `${1 / devicePixelRatio}px`);
  await place($("search-icon"), "magnifyingglass", 15, "medium");
  await Promise.all([buildTopBar(), buildTabBar()]);
  const [m, s, b] = await Promise.all([Desk.machine(), Desk.state(), Desk.board()]);
  if (m) {
    for (const [k, v] of Object.entries(m)) {
      const input = form.elements.namedItem(k);
      if (input instanceof HTMLInputElement && v) input.value = String(v);
    }
  }
  state = s;
  board = b ?? null;
  await document.fonts.ready;
  placeTitle();
  drawField();
  render();
}

// Reference mode hook for the parity harness (refshot.go): tells it when
// the current state is drawn and opens the disclosure rows.
declare global {
  interface Window {
    herdrupRef: { ready(): boolean; expand(key: "idle" | "archived", isOpen: boolean): void };
  }
}
window.herdrupRef = {
  ready: () => drawn && document.fonts.status === "loaded",
  expand(key, isOpen) {
    open[key] = isOpen;
    drawn = false;
    void renderRows();
  },
};

void init();
