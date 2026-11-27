import { AccountWelcome } from "./herdrupAccount";
import { Desk, events } from "./mygo";
import type { Machine, PairingOffer, PairOpenTarget, PairRequestView, SavedMachine, SyncedMachine } from "./mygo";
import { element, hostGlyph, hostHomeHeader, hostRowChevron, hostRowIcon, hostRowLines, hostSection, type BrowserAccess, type SymbolRenderer } from "./hostHome";
import { isOpenTarget, notAddedLine, pairFailuresAfter, pairLayout, pairNextStep, pairProblemNote, pairRequestCard, pairResultSection, pairResultTarget, showPairing, showPairChoice, thisDevice } from "./pairing";
import { showGuestAccept, showGuestScan } from "./guestAccept";
import desktopIcon from "../third_party/phosphor/web/desktop.svg?url";
import usersIcon from "../third_party/phosphor/web/users.svg?url";
import networkIcon from "../third_party/phosphor/web/network.svg?url";
import lockOpenIcon from "../third_party/phosphor/web/lock-open.svg?url";

// HerdrSetup (HerdrApp.swift 746-760). Only "this iPhone" becomes "this computer"
// (coordinator 379911); the rest of the copy is the native text.
const setup = {
 install: "curl -fsSL https://herdrup.app/install.sh | sh",
 pair: "herdr pair",
 start: "herdr",
 tailscale: "Tailscale is connected on this computer and your computer.",
 ssh: "SSH is enabled on the computer. On Mac, turn on Remote Login.",
};
import qrIcon from "../third_party/phosphor/web/qr-code.svg?url";
import clipboardIcon from "../third_party/phosphor/web/clipboard.svg?url";
import { errorText } from "./errors";
import { appleSymbols } from "./platform";

function action(text: string, run: () => void) {
 const button = element("button", "", text); button.type = "button"; button.onclick = run; return button;
}

// `holdChanged` re-renders the window when the connecting hold starts or ends;
// `spinner` is the shared small progress view.
export function initHosts(container: HTMLElement, form: HTMLFormElement, showAgents: () => void, symbol: SymbolRenderer, spinner: string, holdChanged: () => void, openAccount: () => void) {
 const home = element("div", "host-home");
 // The account avatar (accountAvatar.ts) at the end of the logo row; it opens Settings, HerdrUp
 // account, which is also where signing in happens.
 const header = hostHomeHeader(symbol, openAccount);
 // "Welcome back" while the account has machines to pair here (1B-dk), else the plain title; a
 // sign-out puts the plain one back.
 let hasShares = false;
 const drawIdentity = (welcomeBack: boolean) => header.title(welcomeBack ? "Welcome back" : "herdrup",
  welcomeBack ? (accountHint ? `Signed in · ${accountHint}` : "Signed in") : hasShares ? "your shared agents" : "connect to your machine");
 const { root: section, rows } = hostSection("SAVED");
 const message = element("p", "host-home-message"); message.setAttribute("role", "status"); message.hidden = true;
 const report = (error: unknown) => { message.textContent = errorText(error); message.hidden = false; };
 const sheet = element("dialog", "host-editor");
 const sheetHeader = element("header", "host-editor-header");
 const title = element("strong", "");
 const cancel = action("Cancel", () => sheet.close()); cancel.className = "button-plain button-compact"; sheetHeader.append(cancel, title);
 const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
 const saveOnly = action("Save without connecting", () => { void save(false); });
 saveOnly.className = "host-save-only button-plain button-large";
 const error = element("p", "host-editor-error"); error.setAttribute("role", "alert"); error.hidden = true;
 const nicknameLabel = element("label", "", "Nickname");
 const nickname = element("input", ""); nickname.name = "nickname"; nickname.placeholder = "My Mac"; nickname.autocomplete = "off";
 nicknameLabel.append(nickname); form.prepend(nicknameLabel);
 form.append(saveOnly, error);
 sheet.append(sheetHeader, form); document.body.append(sheet);
 const add = action("Add host", () => edit()); add.className = "host-add button-secondary button-large";
 // The first-run smoke (app/smoke.go) finds the host actions and the welcome by these hooks.
 add.dataset.smoke = "host-action";
 void symbol("plus", 15, "semibold").then(icon => { icon.setAttribute("aria-hidden", "true"); add.prepend(icon); });
 const startPairing = (offer?: PairingOffer) => showPairing(refresh, async machine => { await Desk.selectMachine(machine.id, ""); showAgents(); }, () => edit(), offer);
 const pair = action("Scan pairing code", () => startPairing()); pair.className = "host-pair button-filled button-large";
 pair.dataset.smoke = "host-action";
 // 1B-dk "Welcome back": the account's machines this device hasn't saved, each to pair here.
 // Rows are the saved rows' neutral style (no colour per machine).
 const { root: synced, rows: syncedRows } = hostSection("FROM YOUR ACCOUNT", "host-home-synced"); synced.hidden = true;
 let syncedMachines: SyncedMachine[] = [];
 let accountHint: string | null = null; // null: signed out
 const pairSynced = async (m: SyncedMachine) => {
  // pair-v1 (option B): with the service offering it, the choice between another device's
  // approval and herdr pair (n2); without it (or signed out), the way it always was: a key
  // machine pairs with `herdr pair` (its key is made here); a password one is added with its
  // fields filled, and the password typed here.
  if (accountHint !== null && await Desk.pairRequestOffered().catch(() => false)) {
   showPairChoice({ count: syncedMachines.length, password: syncedMachines.some(s => !s.key), here, approve: () => void startRequest(), qr: () => startPairing() }, qrGlyph(16));
   return;
  }
  if (m.key) startPairing();
  else edit(undefined, { nickname: m.nickname ?? "", host: m.host, port: m.port, user: m.user, keyPath: "", session: "" });
 };
 const drawSynced = () => {
  synced.hidden = accountHint === null || syncedMachines.length === 0;
  syncedRows.replaceChildren(...syncedMachines.map(m => {
   const row = element("div", "host-home-row host-home-synced-row");
   // A machine the other device couldn't add the key to says why, and keeps its button.
   const failed = pairView?.phase === "done" ? pairView.machines.find(r => r.result === "failed" && r.syncedId === m.id) : undefined;
   const lines = hostRowLines(m.nickname?.trim() || m.host, failed ? notAddedLine(pairView!, failed)
    : `${m.user}@${m.host}${m.port !== 22 ? `:${m.port}` : ""} · synced from your account`);
   const pairButton = action("Pair this device", () => void pairSynced(m)); pairButton.className = "host-home-pair-synced";
   row.append(lines, pairButton);
   return row;
  }));
  drawIdentity(accountHint !== null && syncedMachines.length > 0);
  // The results leave out a failed machine the account lists (its row here says why).
  drawPair();
 };
 // ---- Pair from another device (pair-v1), this computer asking ----
 // The request lives in Go (Desk.pairRequest*); the page reads it on a timer while it shows
 // (pairReadDelay), so the reads stop with the page. The card (n3/n5) sits under the header; the
 // machines it saved (n4) list under "PAIRED BY …" in place of their SAVED rows.
 const here = thisDevice(navigator.platform);
 const pairBox = element("div", "host-home-pair-request");
 let pairView: PairRequestView | null = null;
 // The machines saved here, as the last refresh read them (null before it): a result whose
 // machine is gone says so, and the rest have the saved host's menu.
 let savedList: SavedMachine[] | null = null;
 let pairStarted = 0, pairExpiresAt = 0, pairFailures = 0, pairTimer: ReturnType<typeof setTimeout> | undefined;
 const rowGlyphs: { icon: Node | null; chevron: Node | null } = { icon: null, chevron: null };
 void hostGlyph(symbol, "desktopcomputer", desktopIcon).then(icon => { rowGlyphs.icon = icon; drawPair(); });
 void symbol("chevron.right", 13, "semibold").then(chevron => { rowGlyphs.chevron = chevron; drawPair(); });
 const glyphs = {
  machine: () => (rowGlyphs.icon?.cloneNode(true) as HTMLElement | undefined) ?? element("span", ""),
  chevron: () => (rowGlyphs.chevron?.cloneNode(true) as HTMLElement | undefined) ?? element("span", ""),
 };
 function qrGlyph(size: number): HTMLElement {
  if (appleSymbols()) { const slot = element("span", "pairing-choice-glyph"); void symbol("qrcode.viewfinder", size, "semibold").then(icon => slot.append(icon)); return slot; }
  const icon = element("span", "host-action-glyph"); icon.style.width = icon.style.height = `${size}px`; icon.style.setProperty("--host-icon", `url("${qrIcon}")`); return icon;
 }
 /** The saved machines the results list shows as rows to open (joined by profile, pairResultTarget):
  *  their SAVED rows step aside. A profile saved since at a result's address keeps its row. */
 const pairShown = () => new Set(pairView && pairLayout(pairView).results ? pairView.machines.flatMap(m => { const id = pairResultTarget(m, savedList); return id ? [id] : []; }) : []);
 function drawPair() {
  const view = pairView, layout = view ? pairLayout(view) : null;
  home.classList.toggle("host-home-pairing", !!layout?.card && layout.card !== "ended");
  if (!view || !layout) { pairBox.replaceChildren(); return; }
  const parts: HTMLElement[] = [];
  if (layout.card) parts.push(...pairRequestCard(view, here, accountHint ?? "", spinner, pairExpiresAt, {
   cancel: () => void cancelRequest(), again: () => void startRequest(), qr: () => startPairing(),
  }));
  if (layout.results) parts.push(...pairResultSection(view, here, syncedMachines, savedList, glyphs, spinner, {
   open: target => void openPaired(target), qr: () => startPairing(),
   // The row's profile as it drew it: one changed since gets the redrawn list, not a menu.
   menu: (target, x, y) => { const machine = savedList?.find(m => isOpenTarget(m, target)); if (machine) openMachineMenu(machine, x, y); else void refresh(); },
  }));
  const problem = pairProblemNote(view); if (problem) parts.push(problem);
  pairBox.replaceChildren(...parts);
 }
 function showRequest(view: PairRequestView | null) {
  const before = pairView;
  pairView = view;
  if (view && view.id !== before?.id) { pairStarted = Date.now(); pairFailures = 0; }
  if (view && (view.phase === "waiting" || view.phase === "claimed")) pairExpiresAt = Date.now() + view.expiresIn * 1000;
  drawSynced();
  // A list saved machines, one is gone, or the results took their rows: SAVED and the account's list redraw.
  const shown = (v: PairRequestView | null) => `${v?.machines.filter(m => m.profileId && m.reach !== "removed").length ?? 0}:${!!v && pairLayout(v).results}`;
  if (shown(view) !== shown(before)) void refresh();
  schedulePair();
 }
 function schedulePair() {
  clearTimeout(pairTimer);
  const view = pairView; if (!view) return;
  const next = pairNextStep(view, Date.now() - pairStarted, pairFailures); if (!next) return;
  pairTimer = setTimeout(() => void (next.connect ? connectPaired(view.id) : readRequest(view.id)), next.wait);
 }
 async function readRequest(id: string) {
  try { const view = await Desk.pairRequestRead(id); if (pairView?.id === id) { pairFailures = pairFailuresAfter(view, pairFailures); message.hidden = true; showRequest(view); } }
  catch (failure) {
   if (pairView?.id !== id) return;
   // Gone here (another window asked again): show what Go has now; else say why and read again
   // later, the request as it was meanwhile.
   const now = await Desk.pairRequestCurrent().catch(() => undefined);
   if (pairView?.id !== id) return;
   if (now !== undefined && now?.id !== id) { showRequest(now); return; }
   report(failure); pairFailures++; schedulePair();
  }
 }
 async function connectPaired(id: string) {
  try { const view = await Desk.pairRequestConnect(id); if (pairView?.id === id) { pairFailures = 0; showRequest(view); } }
  catch (failure) { if (pairView?.id === id) { pairFailures++; report(failure); schedulePair(); } }
 }
 async function startRequest() {
  message.hidden = true;
  try { showRequest(await Desk.pairRequestStart()); } catch (failure) { report(failure); }
 }
 async function cancelRequest() {
  const view = pairView; if (!view) return;
  clearTimeout(pairTimer); pairView = null; drawSynced();
  try { await Desk.pairRequestCancel(view.id); } catch (failure) { report(failure); }
 }
 /** Opens a result row's profile only while it is the one the row drew (Go checks again as it
  *  selects it); one changed or replaced since redraws the list instead. */
 async function openPaired(target: PairOpenTarget) {
  message.hidden = true;
  try {
   const machine = (await Desk.machines()).find(m => isOpenTarget(m, target)); if (!machine) { void refresh(); return; }
   const secret = machine.keyPath ? "" : await password(machine); if (secret === null) return;
   beginAttempt(); if (!await Desk.selectPairedMachine(target, secret)) void refresh();
  } catch (failure) { report(failure); }
 }
 void Desk.pairRequestCurrent().then(view => { if (view) showRequest(view); }, () => undefined);
 // accountVersion: an older refresh still waiting on the service never draws over a newer one.
 let accountVersion = 0;
 const refreshAccount = async () => {
  const at = ++accountVersion;
  const state = await Desk.accountState().catch(() => null);
  // null: the service couldn't be reached, which is not "no sign-in" (accountAvatar.ts).
  const providers = state?.signedIn ? [] : await Desk.accountProviders().catch(() => null);
  if (at !== accountVersion) return;
  accountHint = state?.signedIn ? state.displayHint ?? "" : null;
  header.showAccount(state, providers === null || providers.length > 0);
  syncedMachines = accountHint === null ? [] : await Desk.syncedMachines().catch(() => []);
  drawSynced();
 };
 events.syncedMachinesChanged.on(list => { syncedMachines = list; drawSynced(); });
 events.accountChanged.on(() => { void refreshAccount(); });
 void refreshAccount();
 const { root: shared, rows: sharedRows } = hostSection("SHARED WITH YOU");
 const invite = action("Scan invite", () => showGuestScan(refresh, showAgents)); invite.className = "host-invite button-secondary button-large";
 let pasting = false;
 const paste = action("Paste", () => {
  pasting = true; paste.disabled = true;
  void Desk.readGuestInvitationClipboard().then(text => showGuestAccept(refresh, showAgents, text)).catch(report).finally(() => { pasting = false; void refreshPaste(); });
 }); paste.className = "host-invite-paste button-plain"; paste.setAttribute("aria-label", "Paste invite link"); paste.disabled = true;
 async function refreshPaste() {
  try { const hasText = await Desk.hasGuestInvitationClipboardText(); paste.disabled = pasting || !hasText; }
  catch (error) { paste.disabled = true; report(error); }
 }
 window.addEventListener("focus", () => { void refreshPaste(); });
 for (const [button, name, size, fallback] of [[pair, "qrcode.viewfinder", 16, qrIcon], [invite, "qrcode.viewfinder", 15, qrIcon], [paste, "doc.on.clipboard", 16, clipboardIcon]] as const) {
  if (appleSymbols()) {
   void symbol(name, size, "semibold").then(icon => { icon.setAttribute("aria-hidden", "true"); button.prepend(icon); });
  } else {
   const icon = element("span", "host-action-glyph"); icon.setAttribute("aria-hidden", "true");
   icon.style.width = icon.style.height = `${size}px`; icon.style.setProperty("--host-icon", `url("${fallback}")`); button.prepend(icon);
  }
 }
 const inviteActions = element("div", "host-invite-actions"); inviteActions.append(invite, paste);
 // ConnectView.emptyState (HerdrApp.swift 1018-1069): what the app is, the two
 // prerequisites and the commands that start everything, each copyable.
 const empty = element("div", "host-empty"); empty.hidden = true; // refresh decides
 {
  const glyphFor = (sf: string, url: string) => {
   const slot = element("span", "host-empty-glyph"); slot.setAttribute("aria-hidden", "true");
   if (appleSymbols()) void symbol(sf, 12, "medium").then(node => slot.append(node));
   else { const glyph = element("span", "host-computer-glyph"); glyph.style.setProperty("--host-computer", `url("${url}")`); slot.append(glyph); }
   return slot;
  };
  const prerequisite = (text: string, sf: string, url: string, id: string) => {
   const row = element("div", "host-empty-prerequisite"); row.id = id;
   row.append(glyphFor(sf, url), element("span", "", text)); return row;
  };
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const commands: HTMLButtonElement[] = [];
  const command = (text: string) => {
   const node = element("button", "host-empty-command"); node.type = "button";
   node.setAttribute("aria-label", `Copy command: ${text}`);
   const mark = element("span", "host-empty-copy"); mark.setAttribute("aria-hidden", "true");
   const paint = async (copied: boolean) => { mark.replaceChildren(await symbol(copied ? "checkmark" : "doc.on.doc", 12, "semibold")); mark.classList.toggle("copied", copied); node.setAttribute("aria-label", copied ? "Copied" : `Copy command: ${text}`); };
   void paint(false);
   // CopiedCommandReceipt: one receipt at a time, reverting after 1.6 s.
   node.onclick = () => void Desk.gramCopyText(text).then(() => {
    clearTimeout(copiedTimer);
    for (const other of commands) if (other !== node) other.dispatchEvent(new Event("uncopy"));
    void paint(true); copiedTimer = setTimeout(() => void paint(false), 1600);
   }).catch(report);
   node.addEventListener("uncopy", () => void paint(false));
   node.append(element("code", "", text), mark); commands.push(node); return node;
  };
  const before = element("div", "host-empty-before");
  before.append(element("h3", "", "BEFORE PAIRING"),
   prerequisite(setup.tailscale, "network", networkIcon, "pairing-prerequisite-tailscale"),
   prerequisite(setup.ssh, "lock.open", lockOpenIcon, "pairing-prerequisite-ssh"));
  const steps = element("div", "host-empty-steps");
  steps.append(command(setup.install), element("span", "host-empty-step", "then"), command(setup.pair),
   element("span", "host-empty-step", "scan the code it prints, then start herdr"), command(setup.start));
  empty.append(element("p", "host-empty-lead", "herdrup controls coding agents running on your computer."), before,
   element("p", "host-empty-note", "Then, on your computer, run:"), steps,
   element("p", "host-empty-note", "herdr keeps running after you close the terminal. No keys to copy."));
 }
 // ConnectView: with shared machines, your own setup folds into a collapsed
 // "Connect your own machine" disclosure; without, it stays on the page.
 const ownerSetup = element("details", "host-owner-setup");
 const ownerSummary = element("summary", "", "Connect your own machine");
 const ownerChevron = element("span", "host-owner-setup-chevron"); ownerChevron.setAttribute("aria-hidden", "true");
 ownerSummary.append(ownerChevron);
 void symbol("chevron.right", 13, "semibold").then(glyph => ownerChevron.append(glyph));
 const ownerBody = element("div", "host-owner-setup-body");
 ownerSetup.append(ownerSummary, ownerBody);
 const placeOwnerSetup = (hasShared: boolean) => {
  hasShares = hasShared; drawIdentity(accountHint !== null && syncedMachines.length > 0);
  if (hasShared && pair.parentElement !== ownerBody) { ownerBody.append(empty, pair, add); shared.after(ownerSetup); }
  else if (!hasShared && pair.parentElement !== home) { ownerSetup.remove(); shared.after(empty, pair, add); ownerSetup.open = false; }
 };
 home.append(header.root, pairBox, section, synced, shared, empty, pair, add, inviteActions, message);
 // The first-launch sign-in (1B) stands in front of the host home until it is answered. (The
 // browser has its own host home, web/hosts.ts.)
 const welcome = new AccountWelcome(() => { home.hidden = false; });
 container.replaceChildren(welcome.root, home);
 // "settled" once the first refresh has decided whether the first-launch welcome shows (its
 // provider lookup can take a while); the home stays visible meanwhile, so a launch without a
 // network still shows it. The first-run smoke waits for it.
 container.dataset.welcome = "pending";
 async function openPendingInvitation() {
  const text = await Desk.takeGuestInvitation();
  if (text) showGuestAccept(refresh, showAgents, text);
 }
 events.guestInvitationOpened.on(() => { void openPendingInvitation().catch(report); });
 void openPendingInvitation().catch(report);
 // A herdrup://pair# link the system opened: its confirmation, Connect to pair (its token
 // stays in Go).
 async function openPendingPairing() {
  const offer = await Desk.takePairingLink();
  if (offer) startPairing(offer);
 }
 events.pairingLinkOpened.on(() => { void openPendingPairing().catch(report); });
 void openPendingPairing().catch(report);
 let editing: SavedMachine | null = null;
 let saving = false;
 let connecting = false;
 // ConnectView #377: after a connect starts, the machine list stays up with that row
 // held and "Connecting…" until the first agent list arrives or fails, or 10 s pass.
 let holding = false, revealed = false, target = "";
 let holdTimer: ReturnType<typeof setTimeout> | undefined;
 const beginAttempt = () => { revealed = false; };
 const release = (show: boolean) => {
  holding = false; revealed = true; clearTimeout(holdTimer);
  if (show) showAgents();
  holdChanged(); void refresh();
 };
 // The ConnState label: user@host, or user@JoinHostPort(host, port) off port 22.
 const labelOf = (m: SavedMachine) => `${m.user}@${!m.port || m.port === 22 ? m.host : (m.host.includes(":") ? `[${m.host}]` : m.host) + ":" + m.port}`;
 // The list redraw is asynchronous; show the held row on the existing node at once.
 const markBusy = () => {
  for (const row of rows.querySelectorAll<HTMLButtonElement>(".host-home-row")) {
   row.disabled = true;
   if (row.dataset.label !== target) continue;
   row.classList.add("connecting"); row.setAttribute("aria-busy", "true");
   const address = row.querySelector(".host-home-address"); if (address) address.textContent = "Connecting…";
   const chevron = row.querySelector(".host-home-chevron"); if (chevron) { chevron.classList.add("host-home-spinner"); chevron.innerHTML = spinner; }
  }
 };
 let menu: HTMLElement | null = null;
 const closeMenu = () => { menu?.remove(); menu = null; };
 /** A saved host's menu (Edit, Delete) at x, y: its SAVED row's, and its pairing result's. */
 const openMachineMenu = (machine: SavedMachine, x: number, y: number) => {
  closeMenu(); menu = element("div", "host-context-menu"); menu.setAttribute("role", "menu");
  const editButton = action("Edit", () => edit(machine)); editButton.setAttribute("role", "menuitem");
  const deleteButton = action("Delete", () => remove(machine)); deleteButton.setAttribute("role", "menuitem");
  menu.append(editButton, deleteButton); document.body.append(menu);
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`; editButton.focus();
 };
 document.addEventListener("click", closeMenu);
 document.addEventListener("keydown", event => { if (event.key === "Escape") closeMenu(); });
 sheet.addEventListener("close", () => { (form.elements.namedItem("password") as HTMLInputElement).value = ""; });
 /** `prefill`: a new host's fields, as an account machine to pair (1B) brings them. */
 function edit(machine?: SavedMachine, prefill?: Partial<Machine>) {
  editing = machine ?? null; error.hidden = true;
  const from: Partial<Machine> = machine ?? prefill ?? {};
  for (const key of ["nickname", "host", "port", "user", "keyPath", "session", "password"]) {
   const input = form.elements.namedItem(key);
   if (input instanceof HTMLInputElement) input.value = key === "port" ? String(from.port ?? 22) : String(from[key as keyof Machine] ?? "");
  }
  title.textContent = machine ? "Edit host" : "Add host";
  submit.textContent = machine ? "Save" : "Save & Connect"; saveOnly.hidden = !!machine;
  sheet.showModal(); nickname.focus();
 }
 async function save(connect: boolean) {
  if (saving || !form.reportValidity()) return;
  saving = true; submit.disabled = true; saveOnly.disabled = true; error.hidden = true;
  const data = new FormData(form), get = (key: string) => String(data.get(key) ?? "").trim();
  const machine: Machine = { nickname: get("nickname"), host: get("host"), port: Number(get("port")) || 22, user: get("user"), keyPath: get("keyPath"), session: get("session") };
  try {
  if (editing?.paired && machine.host === editing.host && machine.port === editing.port) machine.paired = true;
   if (!editing && !machine.keyPath && !String(data.get("password") ?? "")) throw new Error("Add a private key file or password.");
   if (connect) { beginAttempt(); await Desk.connect(machine, String(data.get("password") ?? "")); }
   else await Desk.saveMachine(machine, editing?.id ?? "");
   sheet.close(); await refresh();
  } catch (failure) { error.textContent = String(failure); error.hidden = false; }
  finally { saving = false; submit.disabled = false; saveOnly.disabled = false; }
 }
 form.addEventListener("submit", event => { event.preventDefault(); void save(editing === null); });
 function password(machine: SavedMachine): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const dialog = element("dialog", "host-password");
  const title = element("h2", "", `Connect to ${machine.nickname || machine.host}`);
  const label = element("label", "", "SSH password (not saved)");
  const input = element("input", ""); input.type = "password"; input.autocomplete = "current-password"; label.append(input);
  const controls = element("form", ""); controls.method = "dialog";
  const cancel = element("button", "", "Cancel"); cancel.value = "cancel";
  const connect = element("button", "", "Connect"); connect.value = "connect";
  controls.append(cancel, connect); dialog.append(title, label, controls); document.body.append(dialog);
  dialog.addEventListener("close", () => { resolve(dialog.returnValue === "connect" ? input.value : null); input.value = ""; dialog.remove(); }, { once: true });
  dialog.showModal(); input.focus(); return promise;
 }
 function remove(machine: SavedMachine) {
  const dialog = element("dialog", "host-password");
  const question = element("p", "", `Remove ${machine.nickname || machine.host}?${machine.active ? " This disconnects the active host." : ""} Remote data is not deleted.`);
  const controls = element("form", ""); controls.method = "dialog";
  const cancel = element("button", "", "Cancel");
  const confirm = element("button", "", "Remove host"); confirm.value = "remove"; controls.append(cancel, confirm);
  dialog.append(question, controls); document.body.append(dialog);
  dialog.addEventListener("close", () => { if (dialog.returnValue === "remove") void Desk.removeMachine(machine.id).then(refresh).catch(report); dialog.remove(); }, { once: true });
  dialog.showModal();
 }
 let version = 0;
 async function refresh() {
  const generation = ++version;
  void refreshPaste();
  try {
   const [machines, shares] = await Promise.all([Desk.machines(), Desk.sharedConnections()]); if (generation !== version) return;
   savedList = machines; drawPair();
   if (accountHint !== null) void Desk.syncedMachines().then(list => { syncedMachines = list; drawSynced(); }, () => undefined);
   const welcomed = await welcome.decide(machines.length === 0 && shares.length === 0);
   // Only the newest refresh decides: an older lookup answering late changes nothing. The
   // welcome, the home and "settled" change together.
   if (generation !== version) return;
   if (welcomed !== null) { welcome.commit(welcomed); home.hidden = welcomed.show; }
   container.dataset.welcome = "settled";
   shared.hidden = shares.length === 0;
   placeOwnerSetup(shares.length > 0);
   // Without shares the instructions show only while nothing is saved; inside the
   // owner-setup disclosure they always do.
   empty.hidden = shares.length === 0 && machines.length > 0;
   // Native sharedSection row: person.2, machine label over "agents · shared by owner",
   // chevron. Several grants on one machine would open Swift's combined machine home,
   // which needs simultaneous guest connections; until then each grant keeps its own row.
   const sharedNodes: HTMLElement[] = [];
   for (const access of shares) {
    const row = action("", () => { row.disabled = true; void Desk.connectGuest(`${access.endpoint.hostID}/${access.guestID}`).then(showAgents).catch(report).finally(() => { row.disabled = connecting; }); });
    row.className = "host-home-row"; row.disabled = connecting;
    const icon = hostRowIcon(await hostGlyph(symbol, "person.2", usersIcon));
    const lines = hostRowLines(access.machineLabel, `${access.agentName} · shared by ${access.ownerName}`);
    const chevron = hostRowChevron(await symbol("chevron.right", 13, "semibold"));
    row.append(icon, lines, chevron); sharedNodes.push(row);
   }
   if (generation !== version) return;
   sharedRows.replaceChildren(...sharedNodes);
   const paired = pairShown();
   const listed = machines.filter(machine => !paired.has(machine.id));
   section.hidden = listed.length === 0;
   const next: HTMLElement[] = [];
   for (const machine of listed) {
    const row = action("", () => { void (async () => {
     row.disabled = true; message.hidden = true;
     try { const secret = machine.keyPath ? "" : await password(machine); if (secret === null) return; beginAttempt(); await Desk.selectMachine(machine.id, secret); }
     catch (failure) { report(failure); }
     finally { row.disabled = connecting; }
    })(); });
    const busy = holding && labelOf(machine) === target;
    row.className = "host-home-row" + (busy ? " connecting" : ""); row.dataset.label = labelOf(machine);
    row.disabled = connecting;
    if (busy) row.setAttribute("aria-busy", "true");
    // SF Symbols are licensed only for Apple platforms; elsewhere the same pinned open icon
    // family as the portable symbol renderer (hostGlyph).
    const icon = hostRowIcon(await hostGlyph(symbol, "desktopcomputer", desktopIcon));
    // SavedHost.label and ConnectView.secondaryLine: the nickname over user@host, or the
    // host over the user name alone.
    const nickname = machine.nickname?.trim() ?? "";
    const lines = hostRowLines(nickname || machine.host, busy ? "Connecting…" : nickname ? `${machine.user}@${machine.host}` : machine.user);
    const chevron = busy ? hostRowChevron(null, spinner) : hostRowChevron(await symbol("chevron.right", 13, "semibold"));
    row.append(icon, lines, chevron);
    const openMenu = (x: number, y: number) => openMachineMenu(machine, x, y);
    row.oncontextmenu = event => { event.preventDefault(); openMenu(event.clientX, event.clientY); };
    row.onkeydown = event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); const rect = row.getBoundingClientRect(); openMenu(rect.left + 20, rect.bottom); } };
    next.push(row);
   }
   if (generation === version) rows.replaceChildren(...next);
  } catch (failure) { report(failure); }
 }
 events.stateChanged.on(state => {
  connecting = state.phase === "connecting";
  if (connecting && !revealed && !state.guest) {
   target = state.machine;
   if (!holding) { holding = true; holdTimer = setTimeout(() => release(true), 10_000); markBusy(); holdChanged(); }
  } else if (holding) { release(state.phase === "connected"); }
  if (state.phase === "error") report(`${state.machine}: ${state.message}`);
  else message.hidden = true;
  void refresh();
 });
 void refresh();
 return {
  refresh,
  holdsHome: () => holding,
  async reconnect() {
   const machine = (await Desk.machines()).find(machine => machine.active);
   if (!machine) throw new Error("Choose a saved host before reconnecting.");
   const secret = machine.keyPath ? "" : await password(machine);
   if (secret !== null) await Desk.selectMachine(machine.id, secret);
  },
  /** The browser's access to the machine it opened (web/hosts.ts); a desktop's machines are its own. */
  access: (): BrowserAccess | null => null,
 };
}
