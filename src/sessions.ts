// The agent list's extras around the plain rows: the session pills under the
// search field (herdrup App/SessionPills.swift), the needs-you pill pinned
// under the top bar (App/NeedsYouPill.swift) and the card's markers, age and
// account line (App/HerdrApp.swift card() and rowMarkers()).
import { Desk, events, type Row, type SessionPill } from "./mygo";
import { accountLabel, needsYouText, timeInState, waitingOutOfSight } from "./listExtras";

type SymbolFn = (name: string, size: number, weight: string) => Promise<HTMLElement>;

interface Host {
  symbol: SymbolFn;
  /** The roster's scroll view, whose content starts with the search field. */
  roster: HTMLElement;
  searchField: HTMLElement;
  sidebar: HTMLElement;
  /** The agent's avatar at a size, without its badge. */
  face: (r: Row, size: number) => HTMLElement;
  /** The needs-you count of the board shown, live. */
  needsYou: () => number;
  rerender: () => void;
}

let host: Host;
let pills: SessionPill[] = [];
let accounts: Record<string, string> = {};
const pillsEl = document.createElement("div");
pillsEl.className = "session-pills";
pillsEl.hidden = true;
// herdrup literals that are no design token, so they are not in tokens.css:
// the count's ink Color(hex: 0x231603) (App/SessionPills.swift) and the
// needs-you pill's shadow, black at 0.45 (App/NeedsYouPill.swift).
pillsEl.style.setProperty("--session-count-ink", "#231603");
const needsYouEl = document.createElement("button");
needsYouEl.type = "button";
needsYouEl.className = "needs-you-pill";
needsYouEl.dataset.testid = "needs-you-pill";
needsYouEl.style.setProperty("--needs-you-shadow", "rgb(0 0 0 / 0.45)");
let waiting: Row[] = [];
let waitingBottom: number | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export async function initListExtras(h: Host) {
  host = h;
  h.searchField.after(pillsEl);
  h.sidebar.append(needsYouEl);
  needsYouEl.addEventListener("click", () => h.roster.scrollTo({ top: 0, behavior: "smooth" }));
  h.roster.addEventListener("scroll", sight, { passive: true });
  events.sessionsChanged.on((p) => {
    pills = p;
    renderSessionPills();
  });
  events.accountsChanged.on((a) => {
    accounts = a;
    h.rerender();
  });
  const [p, a] = await Promise.all([Desk.sessionPills(), Desk.accounts()]);
  pills = p ?? [];
  accounts = a ?? {};
  renderSessionPills();
}

// ---- Session pills ----

/** One pill per running session, shown only with two or more. */
export function renderSessionPills() {
  pillsEl.hidden = pills.length < 2;
  pillsEl.replaceChildren(
    ...pills.map((p) => {
      const b = el("button", "session-pill" + (p.selected ? " selected" : ""));
      b.type = "button";
      b.append(el("span", "name t-session-pill", p.name));
      const count = p.selected ? host.needsYou() : p.needsYou;
      if (count > 0) b.append(el("span", "count t-session-count", String(count)));
      b.title = count > 0 ? `${p.name}, ${count} need you` : p.name;
      b.addEventListener("click", () => {
        if (!p.selected) void Desk.selectSession(p.default ? "" : p.name);
      });
      return b;
    }),
  );
}

// ---- The card's extras ----

/** rowMarkers: "no account", then "stale", after the name and star. */
export function rowMarkers(r: Row): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (r.noAccount) out.push(el("span", "marker no-account t-marker-pill", "no account"));
  if (r.stale) {
    const m = el("span", "marker stale t-marker-pill", "stale");
    m.title = "status not confirmed on the last poll";
    m.dataset.testid = "agent-row-stale-marker";
    out.push(m);
  }
  return out;
}

/** How long the agent has been in its state, before the chevron. */
export function rowAge(r: Row, nowUnixMs: number): HTMLElement | null {
  const age = timeInState(r.statusSinceUnixMs, nowUnixMs);
  return age === null ? null : el("span", "age t-row-age", age);
}

/** The account the agent runs on, under the preview; in died when herdr
 * no longer knows that account. */
export function accountLine(r: Row): HTMLElement | null {
  const label = accountLabel(r.account, accounts);
  return label === null ? null : el("div", "account t-account-label" + (r.noAccount ? " unresolved" : ""), label);
}

// ---- Needs-you pill ----

/** After each render: the needs-you rows (every one, those in closed folders
 * too; none while searching) and the bottom of their section in the roster's
 * content, null when it is not drawn. */
export async function updateNeedsYou(rows: Row[], sectionBottom: number | null) {
  waiting = rows;
  waitingBottom = sectionBottom;
  const n = rows.length;
  const parts: HTMLElement[] = [];
  const faces = el("span", "faces");
  for (const r of rows.slice(0, 3)) {
    const f = el("span", "face-ring");
    f.append(host.face(r, 32));
    faces.append(f);
  }
  if (n > 3) faces.append(el("span", "more t-needs-more", `+${n - 3}`));
  parts.push(faces);
  const only = n === 1 ? rows[0] : undefined;
  if (only) {
    const label = el("span", "label");
    label.append(el("span", "name t-pill-name", only.title));
    if (only.activity) label.append(el("span", "detail t-pill-detail", only.activity));
    parts.push(label);
  } else {
    parts.push(el("span", "label name t-pill-name", needsYouText(n)));
  }
  const chev = el("span", "chev");
  chev.append(await host.symbol(n === 1 ? "chevron.right" : "chevron.up", 12, "semibold"));
  parts.push(chev);
  if (waiting !== rows) return; // a newer update won
  needsYouEl.replaceChildren(...parts);
  needsYouEl.title = only ? `${only.title} needs you` : needsYouText(n);
  needsYouEl.style.top = `${host.roster.offsetTop}px`;
  sight();
}

function sight() {
  const shows = waiting.length > 0 && waitingOutOfSight(host.roster.scrollTop, waitingBottom);
  needsYouEl.classList.toggle("shown", shows);
}
