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

/** One tab, text only (Topics A-v2). Keyboard users reach and switch tabs (issue #94): Tab
 *  focuses it, Enter or Space activates it, and the selected tab reads as the current page. A div
 *  with a button's role, not a <button>, which WebKit letters differently (parity 41516232593). */
export function tabNode(key: string, label: string, selected: boolean, badge: boolean, activate: () => void): HTMLElement {
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
  const name = el("span", "t-tab-label", label);
  if (badge) {
    const b = el("span", "tab-badge");
    b.setAttribute("aria-hidden", "true"); b.dataset.tab = key; b.hidden = true;
    name.append(b);
  }
  t.append(name);
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
  watchFoot();
}

let footWatched = false;
/** The sidebar's lists end above its foot, the tab bar with any notice stacked over it
 *  (#sidebar-foot): its laid-out height, whatever the text size, is their bottom inset. */
function watchFoot() {
  if (footWatched) return;
  footWatched = true;
  const foot = $("sidebar-foot");
  new ResizeObserver(() => document.documentElement.style.setProperty("--tabbar-inset", `${foot.getBoundingClientRect().height}px`)).observe(foot);
}
