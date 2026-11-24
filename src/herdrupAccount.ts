// The HerdrUp account in the apps (design #698 §2.3, §3, §6): the Settings page "HerdrUp account"
// and, on desktop, the first-launch sign-in (owner pick 1B). Shown only once the account service
// lists web sign-in. The session itself is Go's (desk_account.go) on desktop and the account
// service's cookie in the browser (src/web/accountDesk.ts).
//
// Signed in, the Settings page is the Swift app's HerdrUpAccountContent (App/AccountViews.swift at
// herdrup 434d0241): who is signed in; SYNCED (machines and prompts, Sync now); DEVICES (rename,
// remove); Sign out, confirmed; Delete account. Without a Settings glyph (the guest page, the owner
// screen) it keeps the short form.
import "./herdrupAccount.css";
import { Desk, events } from "./mygo";
import type { AccountDeleteInfo, AccountDevice, AccountDevices, AccountState, AccountSyncStatus } from "./mygo";
import { errorText } from "./errors";
import { sameAccountState, syncedLine, syncedView } from "./accountView";
import { deskOffers } from "./shellModel";

export const ACCOUNT_TITLE = "HerdrUp account";
/** The panel's problem when the service's health check fails (no answer, not 200, not JSON). */
const UNREACHABLE = "Couldn't reach the account service.";
/** The first-launch sign-in was answered (any choice): it never comes back. */
const WELCOME_SEEN = "account.welcomeSeen";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
 const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node;
}

// Provider marks: Apple's in the ink colour; Google's "G" in its own colours, which its sign-in
// branding requires (content, not decoration).
const APPLE_MARK = '<svg viewBox="0 0 17 20" width="15" height="18" aria-hidden="true"><path fill="currentColor" d="M14.06 10.62c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.18-1.73-1.35-.14-2.64.8-3.33.8-.69 0-1.74-.78-2.87-.76-1.47.02-2.83.86-3.59 2.17-1.54 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.24 2.73 2.2 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.4 1.2-2.46-.03-.01-2.3-.88-2.32-3.5zM11.88 4.16c.6-.73 1-1.74.89-2.75-.86.04-1.9.57-2.52 1.3-.55.64-1.04 1.67-.91 2.66.96.07 1.94-.49 2.54-1.21z"/></svg>';
const GOOGLE_MARK = '<svg viewBox="0 0 18 18" width="17" height="17" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';

/** "Continue with Apple" and "Continue with Google", for the providers the service offers. */
function providerButtons(providers: readonly string[], pick: (provider: "apple" | "google") => void): HTMLButtonElement[] {
 const apple = el("button", "account-provider button-filled button-large"); apple.type = "button";
 apple.innerHTML = APPLE_MARK; apple.append(el("span", "", "Continue with Apple")); apple.onclick = () => pick("apple");
 const google = el("button", "account-provider button-secondary button-large"); google.type = "button";
 google.innerHTML = GOOGLE_MARK; google.append(el("span", "", "Continue with Google")); google.onclick = () => pick("google");
 return [...(providers.includes("apple") ? [apple] : []), ...(providers.includes("google") ? [google] : [])];
}

/** A Settings row's leading glyph: settings.ts glyph() (SF Symbol on macOS, Phosphor elsewhere). */
export type Glyph = (symbol: string, size?: number, weight?: string) => HTMLElement;

/** Machines and prompts stay here whatever happens to the account (Swift's wording, "computer"). */
const KEPT = "Your machines and prompts stay on this computer.";

/** What the account page calls: the app's Desk and events (tests pass their own). */
export interface AccountBridge { desk: typeof Desk; events: typeof events }
const appBridge: AccountBridge = { desk: Desk, events };

/** The Settings page "HerdrUp account": sign in; signed in, the account as Swift shows it. */
export class HerdrUpAccountPanel {
 readonly root = el("div", "account-panel");
 available = false;
 private providers: string[] = [];
 private state: AccountState | null = null;
 private waiting = false;
 private busy: "" | "signing-out" | "syncing" | "device" = "";
 private devices: AccountDevices | null = null;
 private sync: AccountSyncStatus | null = null;
 private devicesProblem = "";
 /** A Rename or Remove the service refused: shown under DEVICES until the next device action. */
 private deviceNote = "";
 private deleteInfo: AccountDeleteInfo | null = null;
 /** A deletion's outcome, shown on the signed-out page after it (or on this page if it failed). */
 private deleteNote = "";
 private deleting = false;
 /** Bumped by each full details load: an older load's devices and delete info are dropped. */
 private detailsGeneration = 0;
 /** Bumped when a session ends: answers asked for under the old one are dropped. */
 private session = 0;
 /** SYNCED ordering across both loaders: each request takes a number, and only an answer newer
  *  than the one shown replaces it. */
 private syncSeq = 0;
 private syncShown = 0;
 /** SYNCED's value nodes on the signed-in page, null when it isn't shown (showSynced). */
 private synced: { machines: HTMLElement; prompts: HTMLElement; line: HTMLElement } | null = null;
 /** A refresh is reading the session: it loads the details once it has, so the session event the
  *  same check publishes doesn't load them too. */
 private refreshing = 0;

 constructor(private readonly changed: () => void, private readonly glyph: Glyph | null = null, private readonly bridge: AccountBridge = appBridge) {
  const { events } = bridge;
  // A state that shows nothing new here (a background sync, failed or not: SYNCED reloads on its
  // own below) leaves the panel as it is, so the control the person is on keeps keyboard focus.
  events.accountChanged.on(s => {
   if (!this.waiting && sameAccountState(this.state, s)) return;
   this.waiting = false; this.applyState(s, this.refreshing === 0); this.draw(); this.changed();
  });
  events.accountDeleted.on(r => {
   this.deleting = false;
   this.deleteNote = r.deleted
    ? r.manualRevoke
     ? "Your HerdrUp account is deleted. Apple didn't confirm it stopped Sign in with Apple for HerdrUp: in your Apple Account settings, open Sign in with Apple, choose HerdrUp and select Stop using."
     : "Your HerdrUp account is deleted. Your machines and prompts stay on this computer."
    : r.problem ?? "";
   this.draw();
  });
  // A sync that finished (in the background, after sign-in, or elsewhere) refreshes SYNCED: the
  // desktop tells it with syncedMachinesChanged, the browser with accountChanged after each round
  // (loadSyncStatus reads state and status, and publishes nothing, so this doesn't loop). While a
  // refresh runs it owns the read: it loads SYNCED once it has the session.
  const synced = () => { if (this.state?.signedIn && this.refreshing === 0) void this.loadSyncStatus(); };
  events.accountChanged.on(synced);
  events.syncedMachinesChanged.on(synced);
  events.savedPromptsChanged.on(synced);
 }

 /** The full signed-in screen: Settings' page in a build whose Desk has the devices and sync. */
 private get full(): boolean {
  return this.glyph !== null && deskOffers(this.bridge.desk, "accountSyncStatus", "accountSyncNow", "accountDevices", "accountEnrolAgain", "accountRenameDevice", "accountRemoveDevice");
 }

 /** The index row's value. */
 summary(): string { return this.state?.signedIn ? "Signed in" : "Not signed in"; }
 get signedIn(): boolean { return !!this.state?.signedIn; }

 /** Whether the service offers sign-in, and the session as the app holds it; `check` asks the
  *  service too (a removed device shows signed out). A service that can't be reached keeps the
  *  panel, with the problem: only a service that answers and lists no web sign-in hides it. */
 async refresh(check = false): Promise<void> {
  const desk = this.bridge.desk;
  let unreachable = false;
  this.refreshing++;
  try {
   try { this.providers = await desk.accountProviders(); }
   catch { this.providers = []; unreachable = true; }
   this.available = unreachable || this.providers.length > 0;
   if (this.available) {
    let s: AccountState;
    try {
     s = check ? await desk.accountCheck() : await desk.accountState();
     if (unreachable && !s.problem) s = { ...s, problem: UNREACHABLE };
    } catch (error) { s = { signedIn: false, persistent: true, problem: errorText(error) }; }
    this.applyState(s, false);
   }
  } finally { this.refreshing--; }
  this.draw(); this.changed();
  if (this.state?.signedIn) void this.loadDetails();
 }

 /** Takes a new account state, from an event or a check alike. A session that ended takes its
  *  devices, counts, notes and any deletion it was waiting on with it; one that began loads its
  *  details (unless the caller loads them itself). */
 private applyState(s: AccountState, load = true) {
  const was = this.state?.signedIn;
  this.state = s;
  if (!s.signedIn) {
   if (was !== false) this.session++;
   this.devices = null; this.sync = null; this.deleteInfo = null; this.deleting = false; this.deviceNote = "";
  } else if (!was && load) void this.loadDetails();
 }

 private takeSync(at: number, value: AccountSyncStatus) {
  if (at > this.syncShown) { this.syncShown = at; this.sync = value; }
 }

 /** The SYNCED counts and the DEVICES list, and how the account is deleted where the Desk can
  *  tell (not the browser's: Delete account there points to the app). */
 private async loadDetails() {
  if (!this.full || !this.state?.signedIn) return;
  const session = this.session, at = ++this.detailsGeneration, syncAt = ++this.syncSeq;
  const desk = this.bridge.desk;
  const deleteInfo = deskOffers(desk, "accountDeleteInfo") ? desk.accountDeleteInfo() : Promise.resolve(null);
  const [sync, devices, del] = await Promise.allSettled([desk.accountSyncStatus(), desk.accountDevices(), deleteInfo]);
  if (session !== this.session) return;
  if (sync.status === "fulfilled") this.takeSync(syncAt, sync.value);
  this.takeDetails(session, at, devices, del);
  this.draw();
 }

 /** The one way into the details cache: an answer asked for under session, as details load at,
  *  is taken only while both are still the panel's (another session, or a newer load, drops it):
  *  the devices (or why they couldn't be read), and the delete info when there is one. */
 private takeDetails(session: number, at: number, devices: PromiseSettledResult<AccountDevices>, deleteInfo?: PromiseSettledResult<AccountDeleteInfo | null>) {
  if (session !== this.session || at !== this.detailsGeneration) return;
  if (devices.status === "fulfilled") { this.devices = devices.value; this.devicesProblem = ""; }
  else this.devicesProblem = errorText(devices.reason);
  if (deleteInfo?.status === "fulfilled") this.deleteInfo = deleteInfo.value;
 }

 /** SYNCED alone, after a sync finished: its values change in place (the rest of the page, and
  *  the control the person is on, stay); the page is redrawn only when the account shown changed.
  *  Only an answer newer than the one shown is taken, its counts and its account state (the
  *  failure line) together: an older read that comes later changes nothing. */
 private async loadSyncStatus() {
  if (!this.full) return;
  const session = this.session, syncAt = ++this.syncSeq;
  const [sync, state] = await Promise.allSettled([this.bridge.desk.accountSyncStatus(), this.bridge.desk.accountState()]);
  if (session !== this.session || syncAt <= this.syncShown) return;
  this.syncShown = syncAt;
  const shown = this.state, shownSync = shown ? syncedView(shown, this.sync) : "";
  if (sync.status === "fulfilled") this.sync = sync.value;
  if (state.status === "fulfilled" && state.value.signedIn) this.state = state.value;
  const s = this.state;
  if (s === null || !sameAccountState(shown, s) || this.synced === null) this.draw();
  else if (syncedView(s, this.sync) !== shownSync) this.showSynced(s);
 }

 /** SYNCED's values: the counts, and the line under Sync now (its node kept, as the counts'). */
 private showSynced(s: AccountState) {
  if (this.synced === null) return;
  const sync = this.sync, { machines, prompts, line } = this.synced;
  machines.textContent = sync ? String(sync.machines) : "–";
  prompts.textContent = sync ? String(sync.prompts) : "–";
  const text = syncedLine(s, sync);
  line.textContent = text;
  line.hidden = !text;
 }

 private draw() {
  const s = this.state;
  const full = !!s?.signedIn && this.full;
  this.root.classList.toggle("account-panel-full", full);
  this.root.classList.toggle("settings-glyph-rows", full);
  this.synced = null;
  if (s?.signedIn && this.full) { this.root.replaceChildren(...this.signedInScreen(s)); return; }
  const nodes: HTMLElement[] = [];
  if (s?.signedIn) {
   const who = el("div", "account-who");
   who.append(el("strong", "", "Signed in"), el("span", "account-hint", s.displayHint ? `as ${s.displayHint}` : "with Apple or Google"));
   const signOut = el("button", "account-sign-out button-secondary", "Sign out"); signOut.type = "button"; signOut.disabled = this.busy !== "";
   signOut.onclick = () => { void this.signOut(); };
   nodes.push(who, signOut);
  } else {
   nodes.push(el("p", "account-lead", this.full
    ? "Sign in to bring your machines and prompts to every device you use. Keys, passwords and pairing secrets never leave this computer."
    : "Sign in to your HerdrUp account."));
   const buttons = el("div", "account-providers");
   buttons.append(...providerButtons(this.providers, provider => {
    this.waiting = true; this.draw();
    void this.bridge.desk.accountSignIn(provider).catch(error => { this.waiting = false; this.state = { ...(this.state ?? { signedIn: false, persistent: true }), problem: errorText(error) }; this.draw(); });
   }));
   nodes.push(buttons);
   if (this.waiting) nodes.push(el("p", "account-note", "Finish signing in in your browser."));
  }
  if (s?.problem) { const line = el("p", "account-note account-problem", s.problem); line.setAttribute("role", "status"); nodes.push(line); }
  if (!s?.signedIn && this.deleteNote) { const line = el("p", "account-note account-problem", this.deleteNote); line.setAttribute("role", "status"); nodes.push(line); }
  if (s && !s.persistent) nodes.push(el("p", "account-note", "This computer has no credential store, so you'll sign in again each time herdrup starts."));
  if (!this.full) nodes.push(el("p", "account-note", "Keys and pairing secrets stay on this device."));
  this.root.replaceChildren(...nodes);
 }

 // ---- Signed in (HerdrUpAccountContent.signedIn) ----

 private signedInScreen(s: AccountState): HTMLElement[] {
  const glyph = this.glyph!;
  const nodes: HTMLElement[] = [];
  const identity = row(glyph("person.crop.circle.fill"), s.displayHint || "Signed in", s.displayHint ? "Google" : "Apple or Google");
  nodes.push(group(null, [identity]));
  const line = el("span", "settings-row-subtitle", "");
  const syncNow = row(glyph("arrow.triangle.2.circlepath"), this.busy === "syncing" ? "Syncing…" : "Sync now", line, null, () => { void this.syncNow(); });
  syncNow.disabled = this.busy !== "";
  const machines = value(""), prompts = value("");
  nodes.push(group("SYNCED", [
   row(glyph("desktopcomputer"), "Machines", "", machines),
   row(glyph("text.bubble"), "Prompts", "", prompts),
   syncNow,
  ]));
  this.synced = { machines, prompts, line };
  this.showSynced(s);
  nodes.push(footnote("Keys, passwords and host-key pins stay on each device. A machine from your account asks for its key or a pairing the first time you open it here."));
  const deviceRows: HTMLElement[] = [];
  const enrolment = this.devices?.enrolment ?? "";
  if (enrolment) {
   const again = row(glyph("exclamationmark.triangle"), "This computer isn't added", enrolmentProblem(enrolment), value("Try again"), () => { void this.enrolAgain(); });
   again.disabled = this.busy !== "";
   deviceRows.push(again);
  }
  for (const device of this.devices?.devices ?? []) deviceRows.push(this.deviceRow(device));
  if (!this.devices) deviceRows.push(row(glyph("desktopcomputer"), this.devicesProblem ? "Couldn't load devices" : "Loading devices…", this.devicesProblem));
  nodes.push(group("DEVICES", deviceRows));
  if (this.deviceNote) { const line = footnote(this.deviceNote); line.setAttribute("role", "status"); nodes.push(line); }
  const signOut = row(glyph("rectangle.portrait.and.arrow.right"), this.busy === "signing-out" ? "Signing out…" : "Sign out", "", null, () => { void this.confirmSignOut(); });
  signOut.disabled = this.busy !== "";
  nodes.push(group(null, [signOut]));
  // Delete is confirmed by a fresh sign-in in the browser (herdrup #783), once the service lists
  // web_delete; until then it points to the app that can.
  if (this.deleteInfo?.offered) {
   const del = row(glyph("trash"), this.deleting ? "Waiting for the confirmation in your browser…" : "Delete account", "", null, () => { void this.confirmDelete(); });
   del.classList.add("account-row-destructive"); del.disabled = this.busy !== "" || this.deleting;
   nodes.push(group(null, [del]));
   nodes.push(footnote("Deleting removes the account and everything synced to it from HerdrUp's servers. Machines and prompts stay on this computer."));
  } else {
   nodes.push(group(null, [row(glyph("trash"), "Delete account", "To delete your account, use the HerdrUp app on iPhone or iPad.")]));
  }
  if (this.deleteNote) { const line = footnote(this.deleteNote); line.setAttribute("role", "status"); nodes.push(line); }
  if (s.problem) { const line = footnote(s.problem); line.setAttribute("role", "status"); nodes.push(line); }
  if (!s.persistent) nodes.push(footnote("This computer has no credential store, so you'll sign in again each time herdrup starts."));
  return nodes;
 }

 private deviceRow(device: AccountDevice): HTMLElement {
  const glyph = this.glyph!;
  const manage = el("button", "account-device-manage"); manage.type = "button";
  manage.append(glyph("ellipsis.circle"));
  manage.setAttribute("aria-label", `Manage ${device.name}`);
  manage.disabled = this.busy !== "";
  manage.onclick = event => { event.stopPropagation(); this.deviceMenu(device, manage); };
  return row(glyph(deviceIcon(device.platform)), device.name, device.current ? "This computer" : platformName(device.platform), manage);
 }

 /** The device's menu: Rename, Remove (Swift's Menu). Placed in the body at a fixed position
  *  under the ⋯ button, so the settings group's rounded clip never cuts it (no popover API:
  *  older WebKitGTK lacks it). Closes on a pick, Escape, a click elsewhere or a scroll. */
 private deviceMenu(device: AccountDevice, anchor: HTMLElement) {
  document.querySelector(".account-device-menu")?.remove();
  const menu = el("div", "account-device-menu"); menu.setAttribute("role", "menu");
  const close = () => {
   menu.remove();
   document.removeEventListener("pointerdown", outside, true);
   removeEventListener("scroll", close, true); removeEventListener("resize", close);
  };
  const outside = (e: Event) => { if (!menu.contains(e.target as Node)) close(); };
  const item = (label: string, run: () => void) => {
   const b = el("button", "", label); b.type = "button"; b.setAttribute("role", "menuitem");
   b.onclick = () => { close(); run(); }; return b;
  };
  menu.append(item("Rename", () => this.rename(device)), item("Remove", () => { void this.remove(device); }));
  menu.onkeydown = e => { if (e.key === "Escape") { close(); anchor.focus(); } };
  document.body.append(menu);
  const r = anchor.getBoundingClientRect(), m = menu.getBoundingClientRect();
  const top = r.bottom + 4 + m.height > innerHeight ? Math.max(8, r.top - 4 - m.height) : r.bottom + 4;
  menu.style.left = `${Math.max(8, Math.min(r.right - m.width, innerWidth - m.width - 8))}px`;
  menu.style.top = `${top}px`;
  document.addEventListener("pointerdown", outside, true);
  addEventListener("scroll", close, true); addEventListener("resize", close);
  (menu.firstElementChild as HTMLElement).focus();
 }

 private rename(device: AccountDevice) {
  const dialog = el("dialog", "folder-naming account-rename");
  const form = el("form");
  const input = el("input"); input.value = device.name; input.maxLength = 64; input.setAttribute("aria-label", "Device name");
  const buttons = el("div", "buttons");
  const cancel = el("button", "button-secondary", "Cancel"); cancel.type = "button"; cancel.onclick = () => dialog.close();
  const save = el("button", "", "Rename"); save.type = "submit";
  buttons.append(cancel, save);
  form.append(el("h2", "", "Rename device"), input, buttons);
  form.onsubmit = event => {
   event.preventDefault(); dialog.close();
   const name = input.value.trim();
   if (!name || name === device.name) return;
   void this.deviceAction(this.bridge.desk.accountRenameDevice(device.id, name), `Couldn't rename ${device.name}`);
  };
  dialog.append(form); document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal(); input.select();
 }

 private async remove(device: AccountDevice) {
  const ok = await confirm(`Remove ${device.name}?`,
   device.current ? `This signs this computer out of the account. ${KEPT.replace("Your machines", "Its machines")}`
    : `${device.name} is signed out of the account and can no longer open shares bound to it.`, "Remove device");
  if (ok) await this.deviceAction(this.bridge.desk.accountRemoveDevice(device.id), `Couldn't remove ${device.name}`);
 }

 private async deviceAction(work: Promise<void>, failure: string) {
  const session = this.session;
  this.busy = "device"; this.deviceNote = ""; this.draw();
  try { await work; } catch (error) { if (session === this.session) this.deviceNote = `${failure}: ${errorText(error)}`; }
  this.busy = "";
  if (this.state?.signedIn) await this.loadDetails(); else this.draw();
 }

 /** Adds this browser again; its answer goes in as a details load does (takeDetails). */
 private async enrolAgain() {
  const session = this.session, at = ++this.detailsGeneration;
  this.busy = "device"; this.draw();
  const [devices] = await Promise.allSettled([this.bridge.desk.accountEnrolAgain()]);
  this.takeDetails(session, at, devices);
  this.busy = ""; this.draw();
 }

 private async syncNow() {
  this.busy = "syncing"; this.draw();
  try { await this.bridge.desk.accountSyncNow(); } catch { /* the row says the last sync didn't finish */ }
  this.busy = "";
  const next = await this.bridge.desk.accountState().catch(() => null);
  if (next) this.applyState(next, false);
  if (this.state?.signedIn) await this.loadDetails(); else this.draw();
 }

 private async confirmSignOut() {
  if (await confirm("Sign out of your HerdrUp account?", `${KEPT} Changes stop syncing until you sign in again.`, "Sign out")) await this.signOut();
 }

 /** Delete account (Swift confirmDelete): the confirmation, then a fresh sign-in in the browser
  *  with the provider this session used (asked for when a session from Preview 21 didn't keep
  *  it). The result arrives on accountDeleted. */
 private async confirmDelete() {
  const known = this.deleteInfo?.provider ?? "";
  const name = (p: string) => p === "google" ? "Google" : "Apple";
  const message = `This deletes the account, its devices and everything synced to it. ${known ? `To confirm, sign in with ${name(known)} again.` : "To confirm, sign in again with the provider you used."} ${KEPT}`;
  let provider = known;
  if (known) {
   if (!await confirm("Delete your HerdrUp account?", message, "Delete account")) return;
  } else {
   provider = await choose("Delete your HerdrUp account?", message, [["apple", "Delete with Apple"], ["google", "Delete with Google"]].filter(([p]) => this.providers.length === 0 || this.providers.includes(p!)) as [string, string][]);
   if (!provider) return;
  }
  this.deleting = true; this.deleteNote = ""; this.draw();
  try { await this.bridge.desk.accountDelete(provider); }
  catch (error) { this.deleting = false; this.deleteNote = `Couldn't start the deletion: ${errorText(error)}`; this.draw(); }
 }

 private async signOut() {
  this.busy = "signing-out"; this.draw();
  let next: AccountState;
  try { next = await this.bridge.desk.accountSignOut(); } catch (error) { next = { signedIn: false, persistent: true, problem: errorText(error) }; }
  this.busy = ""; this.applyState(next);
  this.draw(); this.changed();
 }
}

// ---- Row anatomy: Settings' glyph rows (settings.css .settings-group / .settings-row) ----

function group(label: string | null, rows: HTMLElement[]): HTMLElement {
 const section = el("section", "settings-section");
 if (label) section.append(el("h3", "settings-section-label", label));
 const box = el("div", "settings-group account-group"); box.append(...rows);
 section.append(box);
 return section;
}

/** A row: its label and subtitle (text, or a node the caller keeps to change it). */
function row(icon: HTMLElement, label: string, subtitle: string | HTMLElement = "", trailing: HTMLElement | null = null, action?: () => void): HTMLButtonElement {
 const node = el("button", "settings-row account-row"); node.type = "button";
 if (action) node.onclick = action; else node.classList.add("account-row-static");
 const lines = el("span", "settings-row-lines"); lines.append(el("span", "settings-row-label", label));
 if (typeof subtitle !== "string") lines.append(subtitle);
 else if (subtitle) lines.append(el("span", "settings-row-subtitle", subtitle));
 node.append(icon, lines);
 if (trailing) node.append(trailing);
 return node;
}

function value(text: string): HTMLElement { return el("span", "settings-row-value", text); }
function footnote(text: string): HTMLElement { return el("p", "account-footnote", text); }

/** SwiftUI confirmationDialog as Desktop draws it (agentActions.ts confirmAction). */
function confirm(title: string, message: string, action: string): Promise<boolean> {
 const dialog = el("dialog", "folder-naming agent-confirm");
 const buttons = el("div", "buttons");
 let chosen = false;
 const cancel = el("button", "button-secondary", "Cancel"); cancel.type = "button"; cancel.onclick = () => dialog.close();
 const act = el("button", "button-destructive", action); act.type = "button"; act.onclick = () => { chosen = true; dialog.close(); };
 buttons.append(cancel, act);
 dialog.append(el("h2", "", title), el("p", "", message), buttons);
 document.body.append(dialog);
 const { promise, resolve } = Promise.withResolvers<boolean>();
 dialog.addEventListener("close", () => { dialog.remove(); resolve(chosen); }, { once: true });
 dialog.showModal();
 return promise;
}

/** The confirmation with one destructive action per choice; resolves to the chosen value or "". */
function choose(title: string, message: string, choices: [string, string][]): Promise<string> {
 const dialog = el("dialog", "folder-naming agent-confirm");
 const buttons = el("div", "buttons");
 let chosen = "";
 const cancel = el("button", "button-secondary", "Cancel"); cancel.type = "button"; cancel.onclick = () => dialog.close();
 buttons.append(cancel);
 for (const [value, label] of choices) {
  const b = el("button", "button-destructive", label); b.type = "button"; b.onclick = () => { chosen = value; dialog.close(); };
  buttons.append(b);
 }
 dialog.append(el("h2", "", title), el("p", "", message), buttons);
 document.body.append(dialog);
 const { promise, resolve } = Promise.withResolvers<string>();
 dialog.addEventListener("close", () => { dialog.remove(); resolve(chosen); }, { once: true });
 dialog.showModal();
 return promise;
}

function enrolmentProblem(code: string): string {
 switch (code) {
  case "too_many_devices": return "The account has 20 devices. Remove one, then try again.";
  case "device_in_other_account": return "Its device key belongs to another HerdrUp account.";
  default: return "Sync works; shares bound to the account need it. It's tried again next time.";
 }
}

function deviceIcon(platform: string): string {
 switch (platform) {
  case "ios": return "iphone";
  case "ipados": return "ipad";
  case "macos": return "laptopcomputer";
  case "web": return "globe";
  default: return "desktopcomputer";
 }
}

function platformName(platform: string): string {
 switch (platform) {
  case "ios": return "iPhone";
  case "ipados": return "iPad";
  case "macos": return "Mac";
  case "windows": return "Windows";
  case "linux": return "Linux";
  case "web": return "Web";
  default: return platform;
 }
}

/** Desktop's first-launch sign-in (1B): before the host home on a first launch, answered once. */
/** AccountWelcome.decide's answer: hidden, or shown with the providers it offers (never without). */
export type WelcomeDecision = { show: false } | { show: true; providers: readonly string[] };

export class AccountWelcome {
 readonly root = el("section", "account-welcome");
 private waiting = false;
 private providers: string[] = [];
 private shownFor = false;

 constructor(private readonly done: () => void) {
  this.root.hidden = true;
  this.root.setAttribute("aria-label", "Sign in");
  this.root.dataset.smoke = "welcome"; // the first-run smoke's hook (app/smoke.go)
  events.accountChanged.on(s => { if (s.signedIn && !this.root.hidden) this.finish(); else if (!this.root.hidden) this.draw(s.problem ?? ""); });
 }

 private static seen(): boolean { try { return localStorage.getItem(WELCOME_SEEN) === "1"; } catch { return true; } }

 /** Whether the sign-in shows: a first launch (nothing saved or shared), the service offers
  *  sign-in and nobody is signed in. Nothing on screen changes (commit does), so the caller can
  *  drop a decision a newer one has replaced. */
 async decide(firstLaunch: boolean): Promise<WelcomeDecision> {
  if (!firstLaunch || AccountWelcome.seen()) return { show: false };
  if (this.shownFor) return { show: true, providers: this.providers };
  const providers = await Desk.accountProviders().catch(() => [] as string[]);
  const state = providers.length ? await Desk.accountState().catch(() => null) : null;
  if (!providers.length || !state || state.signedIn || AccountWelcome.seen()) return { show: false };
  return { show: true, providers };
 }

 /** Puts a decision on screen: the sign-in drawn the first time it shows, or hidden. */
 commit(decision: WelcomeDecision) {
  if (!decision.show) { this.root.hidden = true; return; }
  if (!this.shownFor) { this.providers = [...decision.providers]; this.shownFor = true; this.draw(""); }
  this.root.hidden = false;
 }

 private finish() {
  try { localStorage.setItem(WELCOME_SEEN, "1"); } catch { /* shown again next launch */ }
  this.root.hidden = true; this.done();
 }

 private draw(problem: string) {
  const mark = el("img", "account-welcome-mark"); mark.src = "/herdrup/app-logo.png"; mark.alt = "";
  const top = el("div", "account-welcome-top");
  top.append(mark, el("h1", "", "HerdrUp"), el("p", "account-welcome-lead", "Sign in to your HerdrUp account."));
  const actions = el("div", "account-welcome-actions");
  actions.append(...providerButtons(this.providers, provider => {
   this.waiting = true; this.draw("");
   void Desk.accountSignIn(provider).catch(error => { this.waiting = false; this.draw(errorText(error)); });
  }));
  const skip = el("button", "account-welcome-skip button-plain button-large", "Set up without an account"); skip.type = "button"; skip.dataset.smoke = "welcome-skip";
  skip.onclick = () => this.finish();
  actions.append(skip);
  if (this.waiting) actions.append(el("p", "account-note", "Finish signing in in your browser."));
  if (problem) { const line = el("p", "account-note account-problem", problem); line.setAttribute("role", "status"); actions.append(line); }
  const foot = el("p", "account-welcome-foot", "Keys and pairing secrets stay on this computer. You can sign in later in Settings.");
  this.root.replaceChildren(top, actions, foot);
 }
}
