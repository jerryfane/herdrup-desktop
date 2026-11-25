// The owner's screens in the browser, as parts of the desktop's host home (hostHome.ts; the owner's
// pick, 2026-11-25): approving this browser, one section of the host home ("APPROVE THIS BROWSER",
// the code and the three steps as rows); once approved, one section of the machines it may reach
// ("APPROVED BY …", a desktop row each). A browser that can't be approved keeps its own notice
// (Safari, iPhone or iPad: noticeCard), drawn as before.

import qrcode from "qrcode-generator";
import type { EnvelopeMachine, EnvelopeSkipped } from "../webguest/approve";
import { element as el, hostRowChevron, hostRowIcon, hostRowLines, hostRowValue, hostSection, type BrowserAccess } from "../hostHome";
import { ACCESS_CHOICES } from "../webAccessModel";
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
 *  other browser gets the site-data reason. noticeCard draws exactly this. */
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

/** The phases of a live request (the steps show) and of one that ended (retry's words). */
type LivePhase = Extract<OwnerPhase, { kind: "starting" | "waiting" | "code" }>;
type EndedPhase = Extract<OwnerPhase, { kind: "denied" | "expired" | "failed" | "elsewhere" }>;

/** How the approval recovers from a request that ended: the button's label, and the one sentence
 *  that says what to do, worded with that same label. */
export interface Retry { action: "Ask again" | "Try again"; text: string }
const retryWith = (action: Retry["action"]): Retry => ({ action, text: `${action} for a new code, then approve it in HerdrUp.` });

/** What a phase shows, decided once: the host home's section and what it holds. The approval
 *  shows its steps only while a request is live (retry: null); a request that ended always has its
 *  retry, whose words stand in the steps' place, as the step "Type the code" no longer holds. A
 *  failure says what failed on its own (the phase's problem), so its retry words claim nothing
 *  about it. The code shown is the phase's own (guideCode), held once. */
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
  case "denied":
  case "expired": return { view: "guide", phase, retry: retryWith("Ask again") };
  case "failed": return { view: "guide", phase, retry: retryWith("Try again") };
  // The other tab may finish the approval (then Try again here opens the list, asking nothing), or
  // be closed (then Try again starts a new request): neither is promised a new code.
  case "elsewhere": return { view: "guide", phase, retry: { action: "Try again", text: "Finish there, then choose Try again here, or close that tab and choose Try again to start over." } };
 }
}

/** The code a phase shows, null until a device opened the request. */
export function guideCode(phase: LivePhase | EndedPhase): string | null {
 return phase.kind === "code" ? phase.code : null;
}

/** The minutes and seconds until expiresAt ("9:38"), never below 0:00. */
export function timeLeft(expiresAt: number, now: number): string {
 const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
 return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The three steps, each a row: its start, and the rest of the sentence under it; code is the code
 *  once there is one (null before). HerdrUp on a computer, an iPhone or an iPad alike. */
export function guideSteps(browserName: string, code: string | null): { lead: string; rest: string }[] {
 return [
  { lead: "Open HerdrUp", rest: "On your Mac, PC, iPhone or iPad. Keep it open for a moment." },
  { lead: "Approve a browser?", rest: `Opens by itself and names ${browserName}.` },
  { lead: code === null ? "Type the code this page shows" : `Type ${code}`, rest: "Choose the machines, access and time, then Approve." },
 ];
}

const SKIP_TEXT: Record<EnvelopeSkipped["reason"], string> = {
 needs_update: "Needs a herdr update",
 unsupported: "Doesn't support browser access",
 unreachable: "Couldn't be reached when you approved",
 relay_not_allowed: "Uses a relay this page can't reach",
};

const until = (unix: number) => new Date(unix * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** The machines every verified approver granted, one row each (the latest grant per machine), with
 *  who granted it. */
export function approvedMachines(record: OwnerRecord): { machines: EnvelopeMachine[]; skipped: EnvelopeSkipped[]; approvedBy: Map<string, string> } {
 const machines = new Map<string, EnvelopeMachine>();
 const approvedBy = new Map<string, string>();
 const skipped = new Map<string, EnvelopeSkipped>();
 for (const a of record.approvers) {
  for (const m of a.envelope.machines) {
   const had = machines.get(m.hostID);
   if (had === undefined || m.expiresUnix > had.expiresUnix) { machines.set(m.hostID, m); approvedBy.set(m.hostID, a.name); }
  }
  for (const s of a.envelope.skipped) skipped.set(s.hostItemID, s);
 }
 const granted = new Set([...machines.values()].map(m => m.hostItemID));
 return { machines: [...machines.values()], skipped: [...skipped.values()].filter(s => !granted.has(s.hostItemID)), approvedBy };
}

/** The section's label: every approver, in one ("APPROVED BY MAC, IPHONE"). */
export function approvedByLabel(record: OwnerRecord): string {
 return `APPROVED BY ${[...new Set(record.approvers.map(a => a.name))].join(", ")}`.toUpperCase();
}

/** What this browser may do on a machine it was approved for (Settings → Machines, its ACCESS
 *  group): who approved it, the access, until when; null when the list no longer has it. */
export function machineAccess(record: OwnerRecord, hostID: string): BrowserAccess | null {
 const { machines, approvedBy } = approvedMachines(record);
 const m = machines.find(x => x.hostID === hostID);
 if (m === undefined) return null;
 return { approvedBy: approvedBy.get(hostID) ?? "", access: ACCESS_CHOICES.find(([scope]) => scope === m.scope)?.[1] ?? m.scope, until: until(m.expiresUnix) };
}

/** The approved machines: each granted machine with its probe's status and whether it can be
 *  opened; each skipped machine with the reason. */
export interface MachineRow extends RowStatus { machine: EnvelopeMachine }
export function machineRows(record: OwnerRecord, statuses: ReadonlyMap<string, MachineStatus>): { rows: MachineRow[]; skipped: { label: string; reason: string }[] } {
 const { machines, skipped } = approvedMachines(record);
 return {
  rows: machines.map(m => ({ machine: m, ...rowStatus(statuses.get(m.hostID)) })),
  skipped: skipped.map(s => ({ label: s.label, reason: SKIP_TEXT[s.reason] + (s.version ? ` (herdr ${s.version})` : "") })),
 };
}

/** A machine row's part its probe sets: the status as words, its state, and whether the row can
 *  open the machine (not once it ended). */
export interface RowStatus { status: string; state: MachineStatus["kind"]; openable: boolean }
function rowStatus(status: MachineStatus | undefined): RowStatus {
 return { status: statusText(status), state: status?.kind ?? "checking", openable: status?.kind !== "ended" };
}

/** What the approval's buttons do: ask again (a new request), or take the guest's way. */
export interface OwnerActions { again(): void; guestInstead(): void }

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

/** The words under the approval for a key this browser made: no machine takes it before. */
const KEY_NOTE = "This browser made its own key. Your machines accept it only after you approve it.";

/** The approval inside the host home (the layout's guide), the parts after the header: the section
 *  "APPROVE THIS BROWSER" (what the page waits for, the title, the code and its expiry while a
 *  request is live, then the three steps as rows; once it ended, what happened and the way on),
 *  then the guest's way and the key's note. */
export function approvalParts(layout: Extract<OwnerLayout, { view: "guide" }>, browser: ThisBrowser, actions: OwnerActions, spinnerSVG: string): HTMLElement[] {
 const section = hostSection("APPROVE THIS BROWSER", "host-home-approval");
 const head = el("div", "host-home-approval-head");
 section.rows.append(head);
 const guest = (cls: string) => button(cls, "Use a guest invitation instead", actions.guestInstead);
 const title = (text: string) => el("h3", "host-home-approval-title", text);
 const lead = (text: string) => el("p", "host-home-approval-lead", text);
 if (layout.retry === null) {
  const phase = layout.phase;
  const code = guideCode(phase);
  const shown = digits(code);
  if (phase.kind === "code") {
   head.append(waiting(spinnerSVG, "Waiting for you to approve"), title("Enter this code in HerdrUp"),
    lead(`${phase.approver} opened the request to approve ${browser.name}. Type these 4 digits there.`), shown);
   const left = el("b", "", timeLeft(phase.expiresAt, Date.now()));
   const tick = setInterval(() => { if (!left.isConnected) clearInterval(tick); else left.textContent = timeLeft(phase.expiresAt, Date.now()); }, 1000);
   const expiry = el("span", "host-home-approval-expiry", "Expires in "); expiry.append(left);
   const row = el("div", "host-home-approval-actions");
   row.append(copyButton("button-secondary button-large", "Copy code", phase.code, () => getSelection()?.selectAllChildren(shown)), expiry);
   head.append(row);
  } else {
   head.append(waiting(spinnerSVG, "Waiting for HerdrUp to open the request"), title("Open HerdrUp to get your code"),
    lead(`Open HerdrUp on your Mac, PC or iPhone. It will ask to approve ${browser.name}.`), shown);
  }
  for (const [i, step] of guideSteps(browser.name, code).entries()) {
   const row = el("div", "host-home-row host-home-step");
   row.append(hostRowIcon(String(i + 1)), hostRowLines(step.lead, step.rest));
   section.rows.append(row);
  }
  return [section.root, guest("host-home-guest button-plain button-large"), el("p", "host-home-note", KEY_NOTE)];
 }
 const phase = layout.phase;
 const again = button("button-filled button-large", layout.retry.action, actions.again);
 const row = el("div", "host-home-approval-actions");
 row.append(again);
 switch (phase.kind) {
  case "denied": head.append(title("Not approved"), lead("HerdrUp didn't approve this browser.")); break;
  case "expired": head.append(title("The request expired"), lead("No device approved this browser in time.")); break;
  case "failed": {
   const problem = lead(phase.problem); problem.className += " host-home-approval-problem"; problem.setAttribute("role", "alert");
   head.append(title("Couldn't finish the approval"), problem);
   break;
  }
  case "elsewhere": head.append(title("Approving in another tab"), lead("This browser's request is open in another tab of this page.")); break;
 }
 // Another tab holding the request has no guest's way here: that tab may still finish it.
 if (phase.kind !== "elsewhere") row.append(guest("button-plain button-large"));
 head.append(lead(layout.retry.text), row);
 return [section.root];
}

/** A status line: the spinner and what the page waits for (no pill). */
function waiting(spinnerSVG: string, text: string) {
 const w = el("div", "host-home-approval-status");
 const spin = el("span", "host-home-spinner"); spin.innerHTML = spinnerSVG; spin.setAttribute("aria-hidden", "true");
 w.append(spin, text);
 w.setAttribute("role", "status");
 return w;
}

/** The code's four digits; with no code, four faint dots where it will show. */
function digits(code: string | null): HTMLElement {
 const box = el("div", code === null ? "host-home-code host-home-code-none" : "host-home-code");
 if (code === null) box.setAttribute("aria-hidden", "true");
 else box.setAttribute("aria-label", `Code ${code.split("").join(" ")}`);
 for (const d of code ?? "····") box.append(el("span", "", d));
 return box;
}

/** A row's glyphs, drawn once and copied for each row (hostGlyph, the chevron's symbol). */
export interface RowGlyphs { icon(): HTMLElement; chevron(): HTMLElement }

/** The approved machines section; showStatus puts a machine's new status in its row in place, and
 *  leaves the rows as they are for a machine the section hasn't. */
export interface MachineSection { root: HTMLElement; showStatus(hostID: string, status: MachineStatus): void }

/** "APPROVED BY …": a desktop row per machine (its name alone: a machine reached through a relay
 *  has no address for the second line the desktop's rows show; "Connecting…" while it opens), its
 *  status at the end, the chevron; picking the row opens the machine, which a machine whose access
 *  ended can't. Each skipped machine is a dimmed row with the reason. glyphs is null until drawn;
 *  opening is the machine whose link is being opened. */
export function machineSection(record: OwnerRecord, statuses: ReadonlyMap<string, MachineStatus>, glyphs: RowGlyphs | null,
 opening: string | null, spinnerSVG: string, open: (m: EnvelopeMachine) => void): MachineSection {
 const { rows, skipped } = machineRows(record, statuses);
 const section = hostSection(approvedByLabel(record));
 const byHost = new Map<string, { row: HTMLButtonElement; value: HTMLElement }>();
 for (const r of rows) {
  const busy = r.machine.hostID === opening;
  const row = button(busy ? "host-home-row connecting" : "host-home-row", "", () => open(r.machine));
  row.disabled = !r.openable;
  if (busy) row.setAttribute("aria-busy", "true");
  const value = hostRowValue(r.status); value.hidden = busy;
  row.append(hostRowIcon(glyphs?.icon() ?? ""), hostRowLines(r.machine.label, busy ? "Connecting…" : null), value,
   busy ? hostRowChevron(null, spinnerSVG) : hostRowChevron(glyphs?.chevron() ?? null));
  section.rows.append(row);
  byHost.set(r.machine.hostID, { row, value });
 }
 for (const s of skipped) {
  const row = el("div", "host-home-row host-home-row-off");
  row.append(hostRowIcon(glyphs?.icon() ?? ""), hostRowLines(s.label, s.reason));
  section.rows.append(row);
 }
 if (rows.length === 0 && skipped.length === 0) {
  section.rows.hidden = true;
  section.root.append(el("p", "host-home-message", "No machines were approved for this browser."));
 }
 return {
  root: section.root,
  showStatus(hostID, next) {
   const shown = byHost.get(hostID);
   if (shown === undefined) return;
   const s = rowStatus(next);
   shown.value.textContent = s.status; shown.row.disabled = !s.openable;
  },
 };
}

/** The notice for a browser that can't be approved (unsupportedNotice), with the guest's way. */
export function noticeCard(browser: ThisBrowser, guestInstead: () => void): HTMLElement {
 const screen = el("div", "web-owner web-owner-notice");
 const body = el("div", "web-owner-body");
 body.append(...notice(unsupportedNotice(browser.kind), button("web-owner-link", "Use a guest invitation instead", guestInstead)));
 screen.append(body);
 return screen;
}

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
  const input = el("input", ""); input.readOnly = true; input.value = link.shown; input.setAttribute("aria-label", "This page's link");
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
 const words = el("span", ""); words.append(el("small", "", "Download on the"), el("b", "", "App Store"));
 a.innerHTML = APPLE_LOGO; a.append(words);
 return a;
}
