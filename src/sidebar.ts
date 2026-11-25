import type { Board } from "./mygo";
import { motionSeconds } from "./motion";
import "./sidebar.css";

type Tab = "agents" | "gram" | "settings";
type Symbol = (name: string, size: number, weight: string) => Promise<HTMLElement>;

/** `compact` is herdrup's phone layout (main.ts compactQuery): the list is the screen there, so
 *  a minimised sidebar is expanded, keeping the desktop preference. */
export async function initSidebarRail(sidebar: HTMLElement, select: (tab: Tab) => void, changed: () => void, symbol: Symbol, compact: MediaQueryList) {
  let minimized = false, available = true;
  try { minimized = localStorage.getItem("sidebarMinimized") === "true"; } catch { /* Session-only if storage is unavailable. */ }
  const rail = document.createElement("nav"); rail.className = "sidebar-rail"; rail.setAttribute("aria-label", "Sections");
  const expand = document.createElement("button"); expand.className = "sidebar-expand"; expand.type = "button";
  expand.setAttribute("aria-label", "Expand sidebar"); expand.title = "Expand sidebar (⌘K / Ctrl+K)";
  expand.append(await symbol("sidebar.leading", 16, "medium")); rail.append(expand);
  const tabs = new Map<Tab, HTMLButtonElement>();
  const gramBadge = document.createElement("span"); gramBadge.className = "sidebar-rail-badge"; gramBadge.hidden = true; gramBadge.setAttribute("aria-hidden", "true");
  for (const [tab, icon, label] of [["agents", "square.grid.2x2.fill", "Agents"], ["gram", "bubble.left.and.bubble.right.fill", "Gram"], ["settings", "gearshape.fill", "Settings"]] as const) {
    const button = document.createElement("button"); button.type = "button"; button.className = "sidebar-rail-section";
    button.setAttribute("aria-label", label); button.title = label;
    button.append(await symbol(icon, 18, "medium"));
    if (tab === "gram") button.append(gramBadge);
    button.onclick = () => { setMinimized(false); select(tab); };
    tabs.set(tab, button); rail.append(button);
  }
  const divider = document.createElement("hr"); rail.append(divider);
  function count(label: string) {
    const root = document.createElement("div"), dot = document.createElement("span"), text = document.createElement("span");
    root.className = `sidebar-rail-count ${label === "working" ? "working" : "waiting"}`;
    root.setAttribute("role", "img");
    dot.className = "sidebar-rail-dot"; dot.setAttribute("aria-hidden", "true"); text.setAttribute("aria-hidden", "true"); root.append(dot, text); rail.append(root);
    return (value: number) => { root.hidden = value === 0; text.textContent = String(value); root.setAttribute("aria-label", `${value} ${label}`); };
  }
  const waiting = count("need you"), working = count("working"); waiting(0); working(0); divider.hidden = true;
  document.body.append(rail);
  const resizer = sidebarResizer(changed);
  function apply() {
    const collapsed = minimized && available && !compact.matches;
    document.body.classList.toggle("sidebar-minimized", collapsed);
    sidebar.inert = collapsed; rail.hidden = !collapsed;
    resizer.hidden = collapsed || !available;
  }
  let moving = 0;
  function setMinimized(value: boolean) {
    minimized = value;
    try { localStorage.setItem("sidebarMinimized", String(value)); } catch (error) { console.warn("Sidebar preference is session-only", error); }
    // The split view animates its columns (~0.3 s, HerdrApp.swift toggleSidebar); only a
    // toggle moves them, not the column hiding for the host home or a guest.
    document.body.classList.add("sidebar-moving");
    clearTimeout(moving);
    moving = window.setTimeout(() => document.body.classList.remove("sidebar-moving"), motionSeconds("sidebar") * 1000 + 50);
    apply(); changed();
  }
  expand.onclick = () => setMinimized(false);
  window.addEventListener("keydown", event => {
    if (!available || compact.matches || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k" || document.querySelector("dialog[open]")) return;
    event.preventDefault(); event.stopPropagation(); setMinimized(!minimized);
  }, true);
  compact.addEventListener("change", apply);
  apply();
  return {
    minimize: () => setMinimized(true),
    update(tab: Tab, board: Board | null, show: boolean) {
      available = show;
      for (const [key, button] of tabs) button.setAttribute("aria-current", key === tab ? "page" : "false");
      const needsYou = board?.needsYou ?? 0, active = board?.sections.find(section => section.key === "working")?.agentCount ?? 0;
      waiting(needsYou); working(active); divider.hidden = needsYou === 0 && active === 0;
      apply();
    },
    unread(count: number) {
      gramBadge.hidden = count === 0; gramBadge.textContent = String(count);
      tabs.get("gram")!.setAttribute("aria-label", count ? `Gram, ${count} unread` : "Gram");
    },
  };
}

/** Where the dragged width is remembered (HerdrApp.swift "ui.sidebarWidth"). */
export const SIDEBAR_WIDTH_KEY = "ui.sidebarWidth";

/** A remembered width, clamped to the column's bounds; the minimum when none is stored or it is
 *  unreadable (HerdrApp.swift recordSidebarWidth keeps sidebarWidthRange). */
export function storedSidebarWidth(raw: string | null, min: number, max: number): number {
  const width = raw === null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(width) ? Math.min(max, Math.max(min, Math.round(width))) : min;
}

/** Drags the sidebar's edge between the bounds, as the split view's divider does; the width is
 *  stored once it has held still for half a second (HerdrApp.swift sidebarWidthSettle), so a
 *  drag commits once, where it ended. Arrow keys move it 10 px for keyboard users. */
function sidebarResizer(changed: () => void): HTMLElement {
  const root = document.documentElement;
  // DesignTokens.Size.sidebarMin...sidebarMax, as tokens.css carries them.
  const token = (name: string) => parseFloat(getComputedStyle(root).getPropertyValue(name));
  const min = token("--size-sidebar-min"), max = token("--size-sidebar-max");
  let width = min;
  try { width = storedSidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY), min, max); } catch { /* Session-only if storage is unavailable. */ }
  const handle = document.createElement("div");
  handle.className = "sidebar-resizer"; handle.tabIndex = 0;
  handle.setAttribute("role", "separator"); handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "Sidebar width");
  handle.setAttribute("aria-valuemin", String(min)); handle.setAttribute("aria-valuemax", String(max));
  let settle = 0;
  const set = (next: number) => {
   next = Math.min(max, Math.max(min, Math.round(next)));
   if (next === width && root.style.getPropertyValue("--sidebar-width")) return;
   width = next;
   root.style.setProperty("--sidebar-width", `${width}px`);
   handle.setAttribute("aria-valuenow", String(width));
   changed();
   clearTimeout(settle);
   settle = window.setTimeout(() => {
    try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch (error) { console.warn("Sidebar width is session-only", error); }
   }, 500);
  };
  root.style.setProperty("--sidebar-width", `${width}px`);
  handle.setAttribute("aria-valuenow", String(width));
  handle.onpointerdown = event => {
   if (event.button !== 0) return;
   event.preventDefault();
   handle.setPointerCapture(event.pointerId);
   const start = event.clientX, from = width;
   document.body.classList.add("sidebar-resizing");
   handle.onpointermove = move => set(from + move.clientX - start);
   handle.onpointerup = handle.onpointercancel = () => {
    handle.onpointermove = handle.onpointerup = handle.onpointercancel = null;
    document.body.classList.remove("sidebar-resizing");
   };
  };
  handle.onkeydown = event => {
   const step = event.key === "ArrowRight" ? 10 : event.key === "ArrowLeft" ? -10 : 0;
   if (event.key === "Home") { event.preventDefault(); set(min); }
   else if (event.key === "End") { event.preventDefault(); set(max); }
   else if (step) { event.preventDefault(); set(width + step); }
  };
  document.body.append(handle);
  return handle;
}
