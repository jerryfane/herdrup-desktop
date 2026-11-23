// The owner's first screen in the browser: approving this browser (the owner's pick of the
// approval-flow proposals, 2026-11-23). While it waits: the code, large, on the left, and a
// drawing of HerdrUp's "Approve a browser?" on the right, for a computer or an iPhone or iPad
// (proposal B, screen 1). Once approved: "Pick a machine", the machines it may reach (proposal D,
// screen 2). A browser that can't be approved: the notice for Safari, iPhone or iPad (D, 3 and 3b).

import qrcode from "qrcode-generator";
import type { EnvelopeMachine, EnvelopeSkipped } from "../webguest/approve";
import type { OwnerPhase } from "./ownerApproval";
import { deviceLabel, parseUserAgent } from "./browserIdentity";
import type { OwnerRecord } from "./ownerStore";
import { statusText, type MachineStatus } from "./ownerProbe";

/** Which notice this browser gets if it can't be approved. Safari, and every browser on iPhone and
 *  iPad (all WebKit), can't read back a stored X25519 CryptoKey: WebKit's structured clone can't
 *  deserialize it, and IndexedDB answers null (#330). "safari" is Safari on a Mac; "other" is any
 *  other browser, which gets there only when it can't keep the key at all (blocked site data, no
 *  X25519). */
export type BrowserKind = "safari" | "iphone" | "ipad" | "other";

/** This browser: its name for the account (browserDeviceName), and its kind (BrowserKind), from
 *  the same parse of the agent. touchPoints is navigator.maxTouchPoints: Safari on iPad sends the
 *  Mac's user agent, and only touch tells them apart (no Mac has a touch screen). */
export interface ThisBrowser { name: string; kind: BrowserKind }
export function thisBrowser(ua: string, touchPoints = 0): ThisBrowser {
 const parsed = parseUserAgent(ua);
 const kind: BrowserKind = /iPad/.test(ua) || (parsed.os === "macOS" && touchPoints > 1) ? "ipad"
  : parsed.os === "iOS" ? "iphone" : parsed.browser === "Safari" ? "safari" : "other";
 return { name: deviceLabel(parsed), kind };
}

/** The HerdrUp app for iPhone and iPad on the App Store (the owner's link, 2026-11-23). */
export const IOS_APP_URL = "https://apps.apple.com/app/id6798087089";

/** What the screen says when this browser can't be approved, each paragraph with its heading and
 *  action in one place: Safari on a Mac is sent to Chrome, Edge or Firefox, with the app's QR code
 *  for the iPhone and a field to copy this page's link; iPhone and iPad are sent to the app; any
 *  other browser gets the site-data reason. ownerCard draws exactly this. */
export interface UnsupportedNotice {
 eyebrow?: string;
 title: string;
 text: string;
 /** The App Store link, drawn as Apple's badge. */
 app?: { href: string; label: string };
 /** Safari on a Mac: the App Store link as a QR code, and this page's link to copy. */
 computer?: { qrTitle: string; qrText: string };
}
export function unsupportedNotice(kind: BrowserKind): UnsupportedNotice {
 const app = { href: IOS_APP_URL, label: "Download HerdrUp for iPhone and iPad on the App Store" };
 const forComputers = "Web access works only in Chrome, Edge or Firefox on a computer.";
 switch (kind) {
  case "safari":
   return { eyebrow: "Safari isn’t supported yet", title: "Open this page in Chrome, Edge or Firefox.", text: `${forComputers} Safari can’t keep this page’s secure key.`,
    app, computer: { qrTitle: "Get the iPhone and iPad app", qrText: "Scan with your iPhone camera, or" } };
  case "iphone":
  case "ipad":
   return { eyebrow: kind === "iphone" ? "On iPhone, use the app" : "On iPad, use the app", title: "HerdrUp on the web is for computers.",
    text: `${forComputers} On iPhone and iPad, the HerdrUp app reaches your machines directly.`, app };
  case "other":
   return { title: "This browser can't be approved",
    text: "It can't keep a secure key for this page from one visit to the next. Private browsing or blocked site data can cause this; allow site data, or use a current Chrome, Edge or Firefox." };
 }
}

/** The quiet zone round a QR code, in modules: the four DENSO WAVE's specification requires (as
 *  the desktop invitation's code in guestShare.ts). */
const QR_QUIET = 4;

/** href as a QR code: an SVG of its dark modules, one path, with the quiet zone. The notice draws
 *  its App Store link this way, from the same href as its badge. */
function qrSVG(href: string): string {
 const code = qrcode(0, "M"); code.addData(href); code.make();
 const size = code.getModuleCount();
 let path = "";
 for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (code.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
 const side = size + 2 * QR_QUIET;
 return `<svg viewBox="${-QR_QUIET} ${-QR_QUIET} ${side} ${side}" shape-rendering="crispEdges" aria-hidden="true"><path d="${path}"/></svg>`;
}

/** This page's link to open in another browser: no query or fragment (they belong to this visit),
 *  shown without the scheme. */
export function pageLink(href: string): { href: string; shown: string } {
 const url = new URL(href);
 return { href: url.origin + url.pathname, shown: url.host + url.pathname };
}

/** The phases of a live request (the guide's steps show) and of one that ended (retry's words). */
type LivePhase = Extract<OwnerPhase, { kind: "starting" | "waiting" | "code" }>;
type EndedPhase = Extract<OwnerPhase, { kind: "denied" | "expired" | "failed" | "elsewhere" }>;

/** How the guide recovers from a request that ended: the button's label, and the one sentence in
 *  the steps' place that says what to do, worded with that same label. */
export interface Retry { action: "Ask again" | "Try again"; text: string }
const retryWith = (action: Retry["action"], why = ""): Retry => ({ action, text: `${why}${action} for a new code, then approve it in HerdrUp.` });

/** What a phase shows, decided once: the screen's layout and what it holds. The guide shows its
 *  steps only while a request is live (retry: null); a request that ended always has its retry,
 *  whose words stand in the steps' place, as the step "Type the code this page shows" no longer
 *  holds. A failure says what failed on its own (the phase's problem), so its retry words claim
 *  nothing about it. The code the guide shows is the phase's own (guideCode), held once. */
export type OwnerLayout =
 | { view: "list"; record: OwnerRecord }
 | { view: "notice" }
 | { view: "guide"; phase: LivePhase; retry: null }
 | { view: "guide"; phase: EndedPhase; retry: Retry };
export function ownerLayout(phase: OwnerPhase): OwnerLayout {
 switch (phase.kind) {
  case "approved": return { view: "list", record: phase.record };
  case "unsupported": return { view: "notice" };
  case "starting":
  case "waiting":
  case "code": return { view: "guide", phase, retry: null };
  case "denied": return { view: "guide", phase, retry: retryWith("Ask again", "This request wasn't approved. ") };
  case "expired": return { view: "guide", phase, retry: retryWith("Ask again", "This request's code no longer works. ") };
  case "failed": return { view: "guide", phase, retry: retryWith("Try again") };
  // The other tab may finish the approval (then Try again here opens the list, asking nothing), or
  // be closed (then Try again starts a new request): neither is promised a new code.
  case "elsewhere": return { view: "guide", phase, retry: { action: "Try again", text: "Another tab is approving this browser. Finish there, then choose Try again here, or close that tab and choose Try again to start over." } };
 }
}

/** The code a guide's phase shows (its drawing and steps, as its left side), null until a device
 *  opened the request. */
export function guideCode(phase: LivePhase | EndedPhase): string | null {
 return phase.kind === "code" ? phase.code : null;
}

/** The rows rise in only on the way from the code to the list (proposal D's transition); a redraw
 *  of the list (a machine's status changed) or a list that was approved before stays still. */
export function arrives(previous: OwnerPhase["kind"] | null, next: OwnerPhase["kind"]): boolean {
 return previous === "code" && next === "approved";
}

/** The minutes and seconds until expiresAt ("9:38"), never below 0:00. */
export function timeLeft(expiresAt: number, now: number): string {
 const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
 return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Where the guide shows "Approve a browser?": HerdrUp on a computer, or on an iPhone or iPad. */
export type GuidePlatform = "computer" | "phone";
export const GUIDE_PLATFORMS: readonly (readonly [GuidePlatform, string])[] = [["computer", "Mac or PC"], ["phone", "iPhone or iPad"]];

/** The guide's three steps for platform, each a bold start and the rest of the sentence; code is
 *  the code once there is one (null before). */
export function guideSteps(platform: GuidePlatform, browserName: string, code: string | null): { lead: string; rest: string }[] {
 const computer = platform === "computer";
 return [
  { lead: "Open HerdrUp", rest: computer ? " on your Mac or PC. Keep it in front for a moment." : " on your iPhone or iPad. Keep it open for a moment." },
  { lead: "Approve a browser?", rest: ` opens by itself and names ${browserName}.` },
  { lead: code === null ? "Type the code" : `Type ${code}`, rest: `${code === null ? " this page shows" : ""}, ${computer ? "tick" : "pick"} the machines, choose access and time, then ${computer ? "click" : "tap"} Approve.` },
 ];
}

const SKIP_TEXT: Record<EnvelopeSkipped["reason"], string> = {
 needs_update: "Needs a herdr update",
 unsupported: "Doesn't support browser access",
 unreachable: "Couldn't be reached when you approved",
 relay_not_allowed: "Uses a relay this page can't reach",
};

const until = (unix: number) => new Date(unix * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** The machines every verified approver granted, one row each (the latest grant per machine). */
export function approvedMachines(record: OwnerRecord): { machines: EnvelopeMachine[]; skipped: EnvelopeSkipped[] } {
 const machines = new Map<string, EnvelopeMachine>();
 const skipped = new Map<string, EnvelopeSkipped>();
 for (const a of record.approvers) {
  for (const m of a.envelope.machines) {
   const had = machines.get(m.hostID);
   if (had === undefined || m.expiresUnix > had.expiresUnix) machines.set(m.hostID, m);
  }
  for (const s of a.envelope.skipped) skipped.set(s.hostItemID, s);
 }
 const granted = new Set([...machines.values()].map(m => m.hostItemID));
 return { machines: [...machines.values()], skipped: [...skipped.values()].filter(s => !granted.has(s.hostItemID)) };
}

/** "Pick a machine": each granted machine with its probe's status, its access and until when, and
 *  whether Open can reach it; each skipped machine with the reason. */
export interface MachineRow extends RowStatus { machine: EnvelopeMachine; access: string }
export function machineRows(record: OwnerRecord, statuses: ReadonlyMap<string, MachineStatus>): { rows: MachineRow[]; skipped: { label: string; reason: string }[] } {
 const { machines, skipped } = approvedMachines(record);
 return {
  rows: machines.map(m => ({ machine: m, ...rowStatus(statuses.get(m.hostID)), access: `${m.scope === "terminal" ? "Chat and terminal" : "Chat"} · until ${until(m.expiresUnix)}` })),
  skipped: skipped.map(s => ({ label: s.label, reason: SKIP_TEXT[s.reason] + (s.version ? ` (herdr ${s.version})` : "") })),
 };
}

/** A machine row's part its probe sets: the status as words, its state, and whether Open can
 *  reach the machine (not once it ended). */
export interface RowStatus { status: string; state: MachineStatus["kind"]; openable: boolean }
function rowStatus(status: MachineStatus | undefined): RowStatus {
 return { status: statusText(status), state: status?.kind ?? "checking", openable: status?.kind !== "ended" };
}

export interface OwnerActions { again(): void; guestInstead(): void; open(machine: EnvelopeMachine): void }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
 const e = document.createElement(tag);
 if (cls) e.className = cls;
 if (text !== undefined) e.textContent = text;
 return e;
}

function button(cls: string, text: string, run: () => void) {
 const b = el("button", cls, text); b.type = "button";
 b.addEventListener("click", run);
 return b;
}

/** Copies text: done once the clipboard took it, failed when it refused or there is no clipboard
 *  (navigator.clipboard is absent outside a secure context and in some embedded browsers), so the
 *  caller's manual-selection fallback runs either way. */
export function copyText(clipboard: Pick<Clipboard, "writeText"> | undefined, text: string, done: () => void, failed: () => void): void {
 if (clipboard === undefined) { failed(); return; }
 clipboard.writeText(text).then(done, failed);
}

/** A copy button: its icon is the button's, and it says Copied once the clipboard took it. */
const COPY_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/></svg>`;
function copyButton(cls: string, label: string, text: string, failed: () => void) {
 const b = el("button", cls); b.type = "button";
 const word = el("span", "", label);
 b.innerHTML = COPY_ICON; b.append(word);
 b.addEventListener("click", () => copyText(navigator.clipboard as Clipboard | undefined, text, () => { word.textContent = "Copied"; }, failed));
 return b;
}

/** A plain status line: the spinner and what the page waits for (no pill). */
function waiting(spinnerSVG: string, text: string) {
 const w = el("div", "web-owner-waiting");
 const spin = el("span", "web-owner-spinner"); spin.innerHTML = spinnerSVG; spin.setAttribute("aria-hidden", "true");
 w.append(spin, document.createTextNode(text));
 w.setAttribute("role", "status");
 return w;
}

/** The guide's platform, kept across redraws. */
let guidePlatform: GuidePlatform = "computer";

/** A drawn screen; a list's also shows a machine's new status in its row in place (a redraw would
 *  restart the list's entrance), and leaves the rows as they are for a machine it hasn't. */
export interface OwnerCard { root: HTMLElement; showStatus?: (hostID: string, status: MachineStatus) => void }

/** The screen for phase; browser is this browser (thisBrowser), statuses each machine's probe,
 *  arrivedAt when the list arrived from the code (performance.now(), null for none). The list's
 *  entrance is web.css's: the card says only how long ago the list arrived (--arrive-elapsed), so
 *  a redraw during the entrance draws it as far in as it is and one after it draws it still. The
 *  caller adds its error line before and the account part after the screen's body. */
export function ownerCard(phase: OwnerPhase, browser: ThisBrowser, actions: OwnerActions, spinnerSVG: string,
 statuses: ReadonlyMap<string, MachineStatus> = new Map(), arrivedAt: number | null = null): OwnerCard {
 const layout = ownerLayout(phase);
 const screen = el("div", `web-owner web-owner-${layout.view}`);
 const body = el("div", "web-owner-body");
 screen.append(body);
 const guest = (cls: string) => button(cls, "Use a guest invitation instead", actions.guestInstead);
 let showStatus: OwnerCard["showStatus"];
 switch (layout.view) {
  case "list": {
   const list = approvedList(layout.record, statuses, actions.open);
   body.append(...list.parts);
   showStatus = list.showStatus;
   if (arrivedAt !== null) { screen.classList.add("web-owner-arrive"); screen.style.setProperty("--arrive-elapsed", `${Math.max(0, performance.now() - arrivedAt)}ms`); }
   break;
  }
  case "notice":
   body.append(...notice(unsupportedNotice(browser.kind), guest("web-owner-link")));
   break;
  case "guide":
   body.append(layout.retry === null ? liveMain(layout.phase, browser, spinnerSVG, guest) : endedMain(layout.phase, layout.retry, actions, guest),
    guide(browser.name, guideCode(layout.phase), layout.retry));
   break;
 }
 return showStatus ? { root: screen, showStatus } : { root: screen };
}

const actionRow = (...items: HTMLElement[]) => { const r = el("div", "web-owner-actions"); r.append(...items); return r; };

/** The guide's left side while a request is live: what the page waits for, and the code (or
 *  where it will show). */
function liveMain(phase: LivePhase, browser: ThisBrowser, spinnerSVG: string, guest: (cls: string) => HTMLElement): HTMLElement {
 const main = el("div", "web-owner-main");
 const alt = () => { const a = el("div", "web-owner-alt"); a.append(el("span", "", "Not your machines?"), guest("web-owner-action web-owner-small")); return a; };
 const keyNote = () => el("p", "web-owner-note", "This browser made its own key. Your machines accept it only after you approve it.");
 switch (phase.kind) {
  case "starting":
  case "waiting":
   main.append(waiting(spinnerSVG, "Waiting for HerdrUp to open the request"),
    el("h1", "", "Open HerdrUp to get your code"),
    el("p", "web-owner-lead", `Open HerdrUp on your Mac, PC or iPhone. It will ask to approve ${browser.name}.`),
    digits(null), el("p", "web-owner-hint", "Your code shows here once HerdrUp opens the request. HerdrUp looks for requests every few seconds while it is open."),
    el("div", "web-owner-sep"), alt(), keyNote());
   break;
  case "code": {
   const left = el("b", "", timeLeft(phase.expiresAt, Date.now()));
   const tick = setInterval(() => { if (!left.isConnected) clearInterval(tick); else left.textContent = timeLeft(phase.expiresAt, Date.now()); }, 1000);
   const expiry = el("span", "web-owner-expiry", "Expires in "); expiry.append(left);
   const shown = digits(phase.code);
   const copy = copyButton("web-owner-action", "Copy code", phase.code, () => getSelection()?.selectAllChildren(shown));
   main.append(waiting(spinnerSVG, "Waiting for you to approve"),
    el("h1", "", "Enter this code in HerdrUp"),
    el("p", "web-owner-lead", `${phase.approver} opened the request to approve ${browser.name}. Type these 4 digits there.`),
    shown, actionRow(copy, expiry),
    el("p", "web-owner-hint", "When the time runs out, the code stops working and this page offers a new request."),
    el("div", "web-owner-sep"), alt(), keyNote());
   break;
  }
 }
 return main;
}

/** The guide's left side once a request ended: what happened, and retry's button (its words are
 *  the guide's, beside: guide()). */
function endedMain(phase: EndedPhase, retry: Retry, actions: OwnerActions, guest: (cls: string) => HTMLElement): HTMLElement {
 const main = el("div", "web-owner-main");
 const again = button("web-owner-action web-owner-primary", retry.action, actions.again);
 switch (phase.kind) {
  case "denied":
   main.append(el("h1", "", "Not approved"), el("p", "web-owner-lead", "HerdrUp didn't approve this browser."), actionRow(again, guest("web-owner-action")));
   break;
  case "expired":
   main.append(el("h1", "", "The request expired"), el("p", "web-owner-lead", "No device approved this browser in time."), digits(null), actionRow(again, guest("web-owner-action")));
   break;
  case "failed": {
   const problem = el("p", "web-welcome-error", phase.problem); problem.setAttribute("role", "alert");
   main.append(el("h1", "", "Couldn't finish the approval"), problem, actionRow(again, guest("web-owner-action")));
   break;
  }
  case "elsewhere":
   main.append(el("h1", "", "Approving in another tab"), el("p", "web-owner-lead", "This browser's request is open in another tab of this page."), actionRow(again));
   break;
 }
 return main;
}

/** The code's four digits, large; with no code, four faint dots where it will show. */
function digits(code: string | null): HTMLElement {
 const box = el("div", code === null ? "web-owner-code web-owner-code-none" : "web-owner-code");
 if (code === null) box.setAttribute("aria-hidden", "true");
 else box.setAttribute("aria-label", `Code ${code.split("").join(" ")}`);
 for (const d of code ?? "····") box.append(el("span", "", d));
 return box;
}

/** The guide's right side: "Where to approve", the platform switch, the drawing of HerdrUp with
 *  "Approve a browser?" open and its numbered markers, and the steps the markers point to; once
 *  the request ended, retry's words in the steps' place and the drawing without markers, as there
 *  are no steps for them to point to (ownerLayout). The switch is native radios, kept in place when
 *  it changes (only the drawing and the steps are drawn again), so the arrow keys move the choice
 *  and the focus stays on it. */
function guide(browserName: string, code: string | null, retry: Retry | null): HTMLElement {
 const panel = el("div", "web-owner-howto");
 const head = el("div", "web-owner-howto-head");
 const sw = el("div", "web-owner-switch"); sw.setAttribute("role", "radiogroup"); sw.setAttribute("aria-label", "Where to approve");
 const shown = el("div", "web-owner-howto-shown");
 const show = () => {
  let instructions: HTMLElement;
  if (retry !== null) instructions = el("p", "web-owner-howto-ended", retry.text);
  else {
   instructions = el("ol", "web-owner-steps");
   for (const [i, step] of guideSteps(guidePlatform, browserName, code).entries()) {
    const li = el("li");
    const text = el("span"); text.append(el("strong", "", step.lead), document.createTextNode(step.rest));
    li.append(el("span", "web-owner-step-n", String(i + 1)), text);
    instructions.append(li);
   }
  }
  shown.replaceChildren(drawing(guidePlatform, browserName, code, retry === null), instructions);
 };
 for (const [platform, label] of GUIDE_PLATFORMS) {
  const choice = el("label");
  const radio = el("input"); radio.type = "radio"; radio.name = "web-owner-platform"; radio.value = platform; radio.checked = platform === guidePlatform;
  radio.addEventListener("change", () => { if (radio.checked) { guidePlatform = platform; show(); } });
  choice.append(radio, el("span", "", label));
  sw.append(choice);
 }
 head.append(el("strong", "", "Where to approve"), sw);
 show();
 panel.append(head, shown);
 return panel;
}

/** HerdrUp with "Approve a browser?" open, drawn in boxes (aria-hidden: the steps say it); with
 *  numbered, the markers the steps point to. */
function drawing(platform: GuidePlatform, browserName: string, code: string | null, numbered: boolean): HTMLElement {
 const box = el("div", `web-owner-drawing web-owner-drawing-${platform}`); box.setAttribute("aria-hidden", "true");
 const app = el("div", "wod-app");
 const list = el("div", "wod-list");
 for (let i = 0; i < 5; i++) { const r = el("span", "wod-row"); r.append(el("i", "wod-face"), el("span", "wod-lines")); list.append(r); }
 const sheet = el("div", "wod-sheet");
 const boxes = el("span", "wod-boxes");
 for (const d of code ?? "    ") boxes.append(el("i", "", d.trim()));
 const buttons = el("span", "wod-buttons"); buttons.append(el("i", "wod-deny", "Deny"), el("i", "wod-approve", "Approve"));
 sheet.append(el("b", "", "Approve a browser?"), el("span", "wod-lead", `${browserName} wants to reach your machines.`), boxes, el("span", "wod-fields"), buttons);
 if (platform === "computer") app.append(el("span", "wod-lights"), list, el("div", "wod-pane"));
 else app.append(el("span", "wod-island"), list);
 app.append(el("div", "wod-dim"), sheet);
 box.append(app);
 if (numbered) for (const n of ["1", "2", "3"]) box.append(el("span", `wod-marker wod-marker-${n}`, n));
 return box;
}

/** The notice for a browser that can't be approved (unsupportedNotice). */
function notice(n: UnsupportedNotice, guest: HTMLElement): HTMLElement[] {
 const out: HTMLElement[] = [];
 if (n.eyebrow) out.push(el("p", "web-owner-eyebrow", n.eyebrow));
 out.push(el("h1", "", n.title), el("p", "web-owner-lead", n.text));
 if (n.app && n.computer) {
  const block = el("div", "web-owner-qr");
  const code = el("span", "web-owner-qr-code"); code.setAttribute("role", "img"); code.setAttribute("aria-label", "QR code for HerdrUp on the App Store");
  code.innerHTML = qrSVG(n.app.href);
  const words = el("span", "web-owner-qr-text");
  words.append(el("strong", "", n.computer.qrTitle), el("span", "", n.computer.qrText), appBadge(n.app));
  block.append(code, words);
  const link = pageLink(location.href);
  const field = el("div", "web-owner-linkfield");
  const input = el("input"); input.readOnly = true; input.value = link.shown; input.setAttribute("aria-label", "This page's link");
  field.append(input, copyButton("web-owner-action web-owner-primary", "Copy link", link.href, () => input.select()));
  out.push(block, field);
 } else if (n.app) {
  const store = el("div", "web-owner-store");
  store.append(appBadge(n.app), el("span", "", "HerdrUp for iPhone and iPad"));
  out.push(store);
 }
 const bottom = el("div", "web-owner-bottom"); bottom.append(guest);
 out.push(bottom);
 return out;
}

/** Apple's "Download on the App Store" badge, drawn in the app's own ink. */
const APPLE_LOGO = `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.37 1.43c0 1.14-.42 2.2-1.25 3.17-1 1.16-2.2 1.83-3.5 1.72a3.5 3.5 0 0 1-.03-.43c0-1.1.48-2.27 1.33-3.23.42-.49.96-.89 1.62-1.21.65-.32 1.27-.49 1.85-.52.02.17.03.33.03.5zm4.4 16.18c-.35.8-.76 1.54-1.24 2.22-.65.93-1.18 1.57-1.6 1.92-.64.59-1.33.89-2.07.91-.53 0-1.17-.15-1.91-.46-.75-.3-1.43-.46-2.06-.46-.66 0-1.36.16-2.11.46-.76.31-1.37.47-1.84.48-.71.03-1.42-.28-2.12-.93-.45-.39-1.01-1.06-1.69-2.01-.72-1.01-1.32-2.19-1.78-3.53C2.86 12.8 2.6 11.4 2.6 10.05c0-1.55.33-2.88 1-4a5.87 5.87 0 0 1 2.1-2.12 5.64 5.64 0 0 1 2.83-.8c.56 0 1.29.17 2.2.51.9.34 1.48.51 1.73.51.19 0 .83-.2 1.93-.6 1.04-.37 1.91-.53 2.63-.47 1.95.16 3.41.92 4.38 2.3-1.74 1.06-2.6 2.53-2.59 4.42.02 1.47.55 2.69 1.6 3.66.47.45 1 .8 1.59 1.04-.13.37-.26.72-.41 1.06z"/></svg>`;
function appBadge(app: { href: string; label: string }): HTMLElement {
 const a = el("a", "web-owner-appstore");
 a.href = app.href; a.target = "_blank"; a.rel = "noopener"; a.setAttribute("aria-label", app.label);
 const words = el("span"); words.append(el("small", "", "Download on the"), el("b", "", "App Store"));
 a.innerHTML = APPLE_LOGO; a.append(words);
 return a;
}

/** "Pick a machine": who approved, then a row per machine with its status as plain text, its
 *  access and Open; skipped machines with the reason. showStatus updates this list's rows in place. */
function approvedList(record: OwnerRecord, statuses: ReadonlyMap<string, MachineStatus>, open: (m: EnvelopeMachine) => void): { parts: HTMLElement[]; showStatus: NonNullable<OwnerCard["showStatus"]> } {
 const { rows, skipped } = machineRows(record, statuses);
 const names = [...new Set(record.approvers.map(a => a.name))].join(", ");
 const list = el("ul", "web-owner-machines");
 const byHost = new Map<string, { status: HTMLElement; words: Text; open: HTMLButtonElement }>();
 let i = 0;
 for (const r of rows) {
  const row = el("li"); row.style.setProperty("--i", String(i++));
  const text = el("span", "web-owner-machine-text");
  const status = el("span", "web-owner-status"); status.dataset.state = r.state;
  const words = document.createTextNode(r.status);
  status.append(el("i", "web-owner-dot"), words);
  text.append(el("strong", "", r.machine.label), status);
  const b = button("web-owner-action", "Open", () => open(r.machine));
  b.setAttribute("aria-label", `Open ${r.machine.label}`);
  b.disabled = !r.openable;
  row.append(text, el("span", "web-owner-machine-access", r.access), b);
  list.append(row);
  byHost.set(r.machine.hostID, { status, words, open: b });
 }
 for (const s of skipped) {
  const row = el("li", "web-owner-skipped"); row.style.setProperty("--i", String(i++));
  const text = el("span", "web-owner-machine-text"); text.append(el("strong", "", s.label), el("span", "", s.reason));
  row.append(text);
  list.append(row);
 }
 const approvedBy = el("p", "web-owner-eyebrow", "Approved by "); approvedBy.append(el("span", "", names));
 const showStatus = (hostID: string, next: MachineStatus) => {
  const row = byHost.get(hostID);
  if (row === undefined) return;
  const s = rowStatus(next);
  row.status.dataset.state = s.state; row.words.data = s.status; row.open.disabled = !s.openable;
 };
 return { parts: [approvedBy, el("h1", "", "Pick a machine"), el("p", "web-owner-lead", "Open a machine to chat with its agents."), list], showStatus };
}
