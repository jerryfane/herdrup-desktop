// A newer Herdrup, said over the owner's agents list (owner, 2026-11-08): the star ask's
// capsule (starAsk.ts), which it replaces while it shows. Update installs and restarts;
// where this install can't update itself, Download opens the release. × hides it until
// the next version.
import { Desk } from "./mygo";
import type { AppUpdateState } from "./mygo";
import { appReleaseURL, appUpdateNewer, appUpdatePercent, watchAppUpdate } from "./appUpdates";

type SymbolFn = (name: string, size: number, weight: string) => Promise<HTMLElement>;
type Store = Pick<Storage, "getItem" | "setItem">;

const DISMISSED = "herdrup.appUpdate.dismissed";

export interface AppUpdateAsk { title: string; body: string; action: "update" | "download"; busy: boolean }

/** What the capsule says for s, or null when it doesn't show: no newer version, or this one
 *  dismissed (an update already under way still shows its progress). */
export function appUpdateAsk(s: AppUpdateState | null, dismissed: string | null): AppUpdateAsk | null {
  if (!s || !appUpdateNewer(s)) return null;
  const v = s.version;
  switch (s.phase) {
    case "installing": {
      const p = appUpdatePercent(s);
      return { title: "Updating", body: p === null ? "Downloading…" : `Downloading · ${p}%`, action: "update", busy: true };
    }
    case "restarting":
      return { title: "Updating", body: "Restarting…", action: "update", busy: true };
    case "outdated":
      return dismissed === v ? null : { title: "New version", body: v, action: "download", busy: false };
    default:
      return dismissed === v ? null : { title: "Update ready", body: s.error ? "Didn't install; try again" : v, action: "update", busy: false };
  }
}

function local(): Store | null {
  try { return localStorage; } catch { return null; }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function initAppUpdateAsk(sidebar: HTMLElement, symbol: SymbolFn, changed: () => void, store: Store | null = local()) {
  // The star ask's capsule and styles (style.css .star-ask), with its own content.
  const ask = el("div", "star-ask app-update-ask");
  ask.id = "app-update-ask";
  ask.hidden = true;
  ask.setAttribute("role", "status");
  ask.style.setProperty("--star-ask-shadow", "rgb(0 0 0 / 0.45)");
  const badge = el("div", "star-ask-badge");
  void symbol("tray.and.arrow.down", 19, "regular").then((s) => badge.append(s));
  const title = el("div", "star-ask-title"), body = el("div", "star-ask-body");
  const lines = el("div", "star-ask-lines");
  lines.append(title, body);
  const act = el("button", "star-ask-star");
  act.type = "button";
  const close = el("button", "star-ask-close");
  close.type = "button";
  close.setAttribute("aria-label", "Not now");
  void symbol("xmark", 15, "medium").then((s) => close.append(s));
  ask.append(badge, lines, act, close);
  sidebar.append(ask);

  let state: AppUpdateState | null = null, visible = false;
  const dismissed = () => store?.getItem(DISMISSED) ?? null;
  const dismiss = () => {
    if (!state) return;
    try { store?.setItem(DISMISSED, state.version); } catch (error) { console.error("update ask not dismissed", error); }
    changed();
  };
  act.onclick = () => {
    const now = appUpdateAsk(state, dismissed());
    if (!now || now.busy || !state) return;
    if (now.action === "download") {
      void Desk.openExternalURL(appReleaseURL(state.version)).catch((error) => console.error("update ask: open release", error));
      dismiss();
    } else {
      void Desk.installAppUpdate().catch((error) => console.error("update ask: install", error));
    }
  };
  close.onclick = dismiss;
  watchAppUpdate((s) => { state = s; changed(); });

  const render = () => {
    const now = visible ? appUpdateAsk(state, dismissed()) : null;
    ask.hidden = !now;
    if (!now) return false;
    title.textContent = now.title;
    ask.setAttribute("aria-label", `${now.title}: herdrup ${state!.version}. ${now.body}`);
    body.textContent = now.body;
    act.textContent = now.action === "download" ? "Download" : "Update";
    act.disabled = now.busy;
    // .star-ask-close sets display, so hidden alone would not hide it.
    close.style.display = now.busy ? "none" : "";
    sidebar.classList.add("star-asking");
    return true;
  };
  return {
    /** Whether it shows for listVisible: the owner's agents list is on screen. */
    shows(listVisible: boolean) { return listVisible && !!appUpdateAsk(state, dismissed()); },
    update(listVisible: boolean) { visible = listVisible; return render(); },
  };
}
