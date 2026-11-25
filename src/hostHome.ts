// The host home's parts, the same on the desktop (hosts.ts: saved SSH hosts, pairing, shares) and
// in the browser (web/hosts.ts: the machines an owner approved this browser for): the header with
// the logo, the account avatar and the title; a section of rows; a row's icon, lines, trailing
// value and chevron. Icons fill in once the symbol renderer has drawn them.
import "./hosts.css";
import personIcon from "../third_party/phosphor/web/user-fill.svg?url";
import { accountAvatar, type AvatarAccount } from "./accountAvatar";
import { appleSymbols } from "./platform";

export type SymbolRenderer = (name: string, size: number, weight: string) => Promise<HTMLElement>;

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] {
 const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
}

/** What the browser may do on the machine it opened (web/hosts.ts), for Settings → Machines: who
 *  approved it, the access ("Chat and terminal", "Chat only") and until when. The desktop's
 *  machines have none. */
export interface BrowserAccess { approvedBy: string; access: string; until: string }

export interface HostHomeHeader {
 root: HTMLElement;
 /** The title and the line under it. */
 title(heading: string, subtitle: string): void;
 /** The avatar for the account's state (null: the service couldn't be reached), as accountAvatar
  *  decides; hidden when there is nothing to open. */
 showAccount(state: AvatarAccount | null, offersSignIn: boolean): void;
}

/** The logo row, with the account avatar at its end (accountAvatar.ts), which opens Settings,
 *  HerdrUp account (openAccount); under it the title. */
export function hostHomeHeader(symbol: SymbolRenderer, openAccount: () => void): HostHomeHeader {
 const header = element("header", "host-home-header");
 // BASE_URL: the browser build serves public/ under /web/ (vite.web.config.ts runtimeAssets).
 const mark = element("img", "host-home-mark"); mark.src = `${import.meta.env.BASE_URL}herdrup/app-logo.png`; mark.alt = "";
 const avatar = element("button", "host-home-account"); avatar.type = "button"; avatar.hidden = true;
 avatar.onclick = openAccount;
 const person = element("span", "host-home-account-person"); person.setAttribute("aria-hidden", "true");
 if (appleSymbols()) void symbol("person.fill", 15, "regular").then(node => person.append(node));
 else { const icon = element("span", "host-home-account-glyph"); icon.style.setProperty("--host-icon", `url("${personIcon}")`); person.append(icon); }
 const logoRow = element("div", "host-home-logo-row"); logoRow.append(mark, avatar);
 const identity = element("div", "host-home-identity");
 const heading = element("h1", "", "herdrup");
 const subtitle = element("p", "", "connect to your machine");
 identity.append(heading, subtitle); header.append(logoRow, identity);
 return {
  root: header,
  title(text, line) { heading.textContent = text; subtitle.textContent = line; },
  showAccount(state, offersSignIn) {
   const look = accountAvatar(state, offersSignIn);
   avatar.hidden = !look.shown;
   if (!look.shown) return;
   const circle = element("span", `host-home-account-circle ${state?.signedIn ? "in" : "out"}`);
   circle.append(look.initial ?? person);
   if (look.dot) circle.append(element("span", `host-home-account-dot ${look.dot}`));
   avatar.replaceChildren(circle);
   avatar.setAttribute("aria-label", `HerdrUp account, ${look.value}`); avatar.title = look.value;
  },
 };
}

/** A section: its label over one card of rows. */
export function hostSection(label: string, cls = ""): { root: HTMLElement; label: HTMLElement; rows: HTMLElement } {
 const root = element("section", cls ? `host-home-saved ${cls}` : "host-home-saved");
 const heading = element("h2", "", label);
 const rows = element("div", "host-home-rows");
 root.append(heading, rows);
 return { root, label: heading, rows };
}

/** A row's icon glyph: the SF Symbol on a Mac, else the open icon family's stand-in (SF Symbols
 *  are licensed only for Apple platforms). */
export async function hostGlyph(symbol: SymbolRenderer, sf: string, fallback: string): Promise<HTMLElement> {
 if (appleSymbols()) return symbol(sf, 19, "regular");
 const glyph = element("span", "host-computer-glyph"); glyph.style.setProperty("--host-computer", `url("${fallback}")`);
 return glyph;
}

/** A row's icon slot, holding its glyph (hostGlyph) or a short text such as a step's number. */
export function hostRowIcon(glyph: HTMLElement | string): HTMLElement {
 const icon = element("span", "host-home-icon");
 icon.append(glyph);
 return icon;
}

/** A row's name, over its second line when it has one. */
export function hostRowLines(name: string, second: string | null): HTMLElement {
 const lines = element("span", "host-home-lines");
 lines.append(element("span", "host-home-name", name));
 if (second !== null) lines.append(element("span", "host-home-address", second));
 return lines;
}

/** A short status at the row's end, before the chevron, in the dim ink (no dot). */
export function hostRowValue(text: string): HTMLElement {
 return element("span", "host-home-value", text);
}

/** The row's trailing chevron (its glyph: symbol "chevron.right" 13 semibold; null while it is
 *  being drawn), or, while the row's machine connects, the small progress view in its place. */
export function hostRowChevron(glyph: HTMLElement | null, spinner?: string): HTMLElement {
 const chevron = element("span", spinner === undefined ? "host-home-chevron" : "host-home-chevron host-home-spinner"); chevron.setAttribute("aria-hidden", "true");
 if (spinner !== undefined) chevron.innerHTML = spinner;
 else if (glyph !== null) chevron.append(glyph);
 return chevron;
}
