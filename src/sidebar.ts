import type { Board } from "./mygo";
import "./sidebar.css";

type Tab = "agents" | "gram" | "settings";
type Symbol = (name: string, size: number, weight: string) => Promise<HTMLElement>;

export async function initSidebarRail(sidebar: HTMLElement, select: (tab: Tab) => void, changed: () => void, symbol: Symbol) {
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
  function apply() {
    const collapsed = minimized && available;
    document.body.classList.toggle("sidebar-minimized", collapsed);
    sidebar.inert = collapsed; rail.hidden = !collapsed;
  }
  function setMinimized(value: boolean) {
    minimized = value;
    try { localStorage.setItem("sidebarMinimized", String(value)); } catch (error) { console.warn("Sidebar preference is session-only", error); }
    apply(); changed();
  }
  expand.onclick = () => setMinimized(false);
  window.addEventListener("keydown", event => {
    if (!available || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k" || document.querySelector("dialog[open]")) return;
    event.preventDefault(); event.stopPropagation(); setMinimized(!minimized);
  }, true);
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
