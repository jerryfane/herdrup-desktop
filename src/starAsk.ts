// The GitHub star ask, design D (owner choice 2026-11-01, herdr-app 383403;
// github-star-prompt-proposals.html section D): a capsule floating over the owner's
// agents list just above the tab bar. Star opens the repository; Star and × both end it.
import { Desk } from "./mygo";
import { dismissStarPrompt, onStarPromptChanged, showsStarPrompt, STAR_URL } from "./starPrompt";

type SymbolFn = (name: string, size: number, weight: string) => Promise<HTMLElement>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function initStarAsk(sidebar: HTMLElement, symbol: SymbolFn, changed: () => void) {
  const ask = el("div", "star-ask");
  ask.hidden = true;
  // The mock's shadow: black at 45 % (a colour, so not a stylesheet literal).
  ask.style.setProperty("--star-ask-shadow", "rgb(0 0 0 / 0.45)");
  const badge = el("div", "star-ask-badge");
  void symbol("star.fill", 19, "regular").then((s) => badge.append(s));
  const lines = el("div", "star-ask-lines");
  lines.append(el("div", "star-ask-title", "Enjoying HerdrUp?"), el("div", "star-ask-body", "Star it on GitHub"));
  const end = () => {
    try { dismissStarPrompt(); } catch (error) { console.error("star ask not dismissed", error); }
  };
  const star = el("button", "star-ask-star", "Star");
  star.type = "button";
  star.onclick = () => {
    void Desk.openExternalURL(STAR_URL).catch((error) => console.error("star ask: open GitHub", error));
    end();
  };
  const close = el("button", "star-ask-close");
  close.type = "button";
  close.setAttribute("aria-label", "Not now");
  void symbol("xmark", 15, "medium").then((s) => close.append(s));
  close.onclick = end;
  ask.append(badge, lines, star, close);
  sidebar.append(ask);
  onStarPromptChanged(changed);
  return {
    /** listVisible: the owner's agents list is on screen (never the guest view). */
    update(listVisible: boolean) {
      const shows = listVisible && showsStarPrompt(false);
      ask.hidden = !shows;
      sidebar.classList.toggle("star-asking", shows);
    },
  };
}
