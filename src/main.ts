import { Desk, events, type BoardUpdate, type ConnState, type Row, type Section } from "./mygo";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const connectView = $("connect");
const form = $<HTMLFormElement>("connect-form");
const connectError = $("connect-error");
const boardView = $("board");
const footer = $("footer");
const needs = $("needs");
const connDot = $("conn-dot");
const connText = $("conn-text");
const disconnect = $<HTMLButtonElement>("disconnect");

// Sections the user opened or closed, by key; others use their default.
const toggled = new Map<string, boolean>();
let state: ConnState = { phase: "idle", message: "", machine: "", herdr: "", live: false };
let board: BoardUpdate | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// The status dot of each section: amber needs you, blue working.
const DOT_BY_SECTION: Record<string, string> = {
  needsYou: "needs",
  stopped: "stopped",
  working: "working",
};

function renderRow(r: Row, sectionKey: string): HTMLElement {
  const row = el("div", "card row" + (r.offline ? " offline" : ""));
  row.title = `${r.id} · ${r.status || "no status"}`;
  const dot = r.offline ? "" : sectionKey === "idle" && r.done ? "done" : (DOT_BY_SECTION[sectionKey] ?? "");
  row.append(el("span", "dot " + dot));
  const text = el("div");
  text.append(el("div", "title", r.title));
  if (r.detail) text.append(el("div", "detail", r.detail));
  row.append(text, el("span", "meta", r.offline ? "offline" : r.agent));
  return row;
}

function renderSection(s: Section): HTMLElement {
  const open = toggled.get(s.key) ?? !s.collapsed;
  const wrap = el("section", "section");
  const head = el("button", "section-head");
  head.append(el("span", undefined, s.label), el("span", "count", String(s.rows.length)), el("span", "chev", open ? "▾" : "▸"));
  head.addEventListener("click", () => {
    toggled.set(s.key, !open);
    render();
  });
  wrap.append(head);
  if (open) {
    const rows = el("div", "rows");
    rows.append(...s.rows.map((r) => renderRow(r, s.key)));
    wrap.append(rows);
  }
  return wrap;
}

function render() {
  const showForm = state.phase === "idle" || (state.phase === "error" && !board);
  connectView.hidden = !showForm;
  boardView.hidden = showForm;
  disconnect.hidden = state.phase === "idle";

  connDot.className = "dot " + state.phase;
  connText.textContent =
    state.phase === "connected"
      ? `${state.machine} · ${state.herdr} · ${state.live ? "live" : "polling"}`
      : state.phase === "connecting"
        ? `connecting to ${state.machine}…`
        : state.phase === "error"
          ? `${state.machine}: ${state.message}`
          : "not connected";
  connectError.hidden = !(state.phase === "error" && showForm);
  connectError.textContent = state.message;

  const n = board?.board.needsYou ?? 0;
  needs.hidden = n === 0;
  $("needs-text").textContent = n === 1 ? "1 needs you" : `${n} need you`;

  if (!board) {
    boardView.replaceChildren(el("p", "empty", state.phase === "connecting" ? "Loading agents…" : ""));
    footer.textContent = "";
    return;
  }
  const b = board.board;
  if (b.sections.length === 0) {
    boardView.replaceChildren(el("p", "empty", "No agents on this machine."));
  } else {
    boardView.replaceChildren(...b.sections.map(renderSection));
  }
  const at = new Date(board.listedAt).toLocaleTimeString();
  footer.textContent = `${b.total} agents${b.archived.length ? ` · ${b.archived.length} archived` : ""} · updated ${at}`;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(form);
  const get = (k: string) => String(f.get(k) ?? "").trim();
  try {
    board = null;
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

async function init() {
  const [m, s, b] = await Promise.all([Desk.machine(), Desk.state(), Desk.board()]);
  if (m) {
    for (const [k, v] of Object.entries(m)) {
      const input = form.elements.namedItem(k);
      if (input instanceof HTMLInputElement && v) input.value = String(v);
    }
  }
  state = s;
  board = b ?? null;
  render();
}
void init();
