// The sidebar's top bar (SectionTopBar) and glass tab bar as both builds draw them: the owner's
// window (main.ts) and the browser guest (web/main.ts) fill the same #bar-leading, #bar-title,
// #bar-actions and #tabbar.

import { paintShape } from "./continuous";
import { symbol } from "./symbol";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A capsule's button: the symbol at 15 pt medium, its label as the tooltip. */
export async function barSlot(name: string, label: string): Promise<HTMLElement> {
  const s = el("div", "slot");
  s.title = label;
  s.replaceChildren(await symbol(name, 15, "medium"));
  return s;
}

/** GuestHomeView.header (App/GuestHomeView.swift 164-178): SectionTopBar(title: "Agents") with no
 *  actions. While Gram replaces the terminal, the right capsule carries the way back to it (the
 *  pane's Terminal tab, GuestPaneView.swift 233). */
export async function guestBarActions(gram: boolean, terminal: () => void): Promise<HTMLElement[]> {
  if (!gram) return [];
  const back = await barSlot("terminal", "Back to Terminal");
  back.tabIndex = 0; back.setAttribute("role", "button"); back.setAttribute("aria-label", "Back to Terminal");
  back.onclick = terminal;
  back.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); terminal(); } };
  return [back];
}

/** Puts one complete bar in place. SectionTopBar(title: "Settings") passes no leading slot
 *  (HerdrApp.swift 2388): leadingShown is false there. */
export function commitTopBar(leadingShown: boolean, back: HTMLElement | null, titleNodes: Node[], actionNodes: HTMLElement[]) {
  const leading = $("bar-leading"), actions = $("bar-actions");
  leading.hidden = !leadingShown;
  leading.replaceChildren(...(back ? [back] : []));
  $("bar-title").replaceChildren(...titleNodes);
  actions.replaceChildren(...actionNodes);
  // The guest home's bar has no actions (GuestHomeView.swift 166-171): no empty capsule.
  actions.hidden = actionNodes.length === 0;
  // The capsules' shapes go with their children.
  paintShape(leading, { radius: "capsule", fill: "var(--color-surface-raised)" });
  paintShape(actions, { radius: "capsule", fill: "var(--color-surface-raised)" });
  placeTitle();
}

/** SectionBarLayout: centre the title on the bar when it fits, else keep it
 * 8 pt clear of both capsules (herdrup App/SectionTopBar.swift). */
export function placeTitle() {
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

/** One tab. Keyboard users reach and switch tabs (issue #94): Tab focuses it, Enter or Space
 *  activates it, and the selected tab reads as the current page. A div with a button's role, not
 *  a <button>, which WebKit letters differently (parity 41516232593). */
export async function tabNode(key: string, icon: string, label: string, selected: boolean, badge: boolean, activate: () => void): Promise<HTMLElement> {
  const t = el("div", "tab" + (selected ? " selected" : ""));
  t.dataset.tab = key;
  t.tabIndex = 0;
  t.setAttribute("role", "button");
  if (selected) t.setAttribute("aria-current", "page");
  t.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    t.click();
  });
  const i = el("div", "icon");
  i.replaceChildren(await symbol(icon, 21, "medium"));
  if (badge) {
    const b = el("span", "tab-badge");
    b.setAttribute("aria-hidden", "true"); b.dataset.tab = key; b.hidden = true;
    i.append(b);
  }
  t.append(i, el("span", "t-tab-label", label));
  t.addEventListener("click", activate);
  return t;
}

/** Replaces every tab, keeping the keyboard on the same one (issue #96); the selected pill
 *  slides between tabs (HerdrApp.swift 2837). */
export function commitTabBar(nodes: HTMLElement[], selectedIndex: number) {
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("#tabbar .tab")?.dataset.tab;
  $("tabbar").replaceChildren(...nodes);
  if (focused) nodes.find((n) => n.dataset.tab === focused)?.focus();
  $("tabbar").style.setProperty("--tab-count", String(nodes.length));
  $("tabbar").style.setProperty("--tab-index", String(selectedIndex));
}
