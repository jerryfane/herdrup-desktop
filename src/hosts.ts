import { Desk, events } from "./mygo";
import type { Machine, SavedMachine } from "./mygo";
import "./hosts.css";
import { showPairing } from "./pairing";
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

type SymbolRenderer = (name: string, size: number, weight: string) => Promise<HTMLElement>;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] {
 const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
}
function action(text: string, run: () => void) {
 const button = element("button", "", text); button.type = "button"; button.onclick = run; return button;
}

// `holdChanged` re-renders the window when the connecting hold starts or ends;
// `spinner` is the shared small progress view.
export function initHosts(container: HTMLElement, form: HTMLFormElement, showAgents: () => void, symbol: SymbolRenderer, spinner: string, holdChanged: () => void) {
 const home = element("div", "host-home");
 const header = element("header", "host-home-header");
 const mark = element("img", "host-home-mark"); mark.src = "/herdrup/app-logo.png"; mark.alt = "";
 const identity = element("div", "host-home-identity");
 const subtitle = element("p", "", "connect to your machine");
 identity.append(element("h1", "", "herdrup"), subtitle); header.append(mark, identity);
 const section = element("section", "host-home-saved");
 const rows = element("div", "host-home-rows");
 section.append(element("h2", "", "SAVED"), rows);
 const message = element("p", "host-home-message"); message.setAttribute("role", "status"); message.hidden = true;
 const report = (error: unknown) => { message.textContent = errorText(error); message.hidden = false; };
 const sheet = element("dialog", "host-editor");
 const sheetHeader = element("header", "host-editor-header");
 const title = element("strong", "");
 const cancel = action("Cancel", () => sheet.close()); sheetHeader.append(cancel, title);
 const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
 const saveOnly = action("Save without connecting", () => { void save(false); });
 saveOnly.className = "host-save-only";
 const error = element("p", "host-editor-error"); error.setAttribute("role", "alert"); error.hidden = true;
 const nicknameLabel = element("label", "", "Nickname");
 const nickname = element("input", ""); nickname.name = "nickname"; nickname.placeholder = "My Mac"; nickname.autocomplete = "off";
 nicknameLabel.append(nickname); form.prepend(nicknameLabel);
 form.append(saveOnly, error);
 sheet.append(sheetHeader, form); document.body.append(sheet);
 const add = action("Add host", () => edit()); add.className = "host-add";
 void symbol("plus", 15, "semibold").then(icon => { icon.setAttribute("aria-hidden", "true"); add.prepend(icon); });
 const pair = action("Scan pairing code", () => showPairing(refresh, async machine => { await Desk.selectMachine(machine.id, ""); showAgents(); }, () => edit())); pair.className = "host-pair";
 const shared = element("section", "host-home-saved");
 const sharedRows = element("div", "host-home-rows"); shared.append(element("h2", "", "SHARED WITH YOU"), sharedRows);
 const invite = action("Scan invite", () => showGuestScan(refresh, showAgents)); invite.className = "host-invite";
 let pasting = false;
 const paste = action("Paste", () => {
  pasting = true; paste.disabled = true;
  void Desk.readGuestInvitationClipboard().then(text => showGuestAccept(refresh, showAgents, text)).catch(report).finally(() => { pasting = false; void refreshPaste(); });
 }); paste.className = "host-invite-paste"; paste.setAttribute("aria-label", "Paste invite link"); paste.disabled = true;
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
  subtitle.textContent = hasShared ? "your shared agents" : "connect to your machine";
  if (hasShared && pair.parentElement !== ownerBody) { ownerBody.append(empty, pair, add); shared.after(ownerSetup); }
  else if (!hasShared && pair.parentElement !== home) { ownerSetup.remove(); shared.after(empty, pair, add); ownerSetup.open = false; }
 };
 home.append(header, section, shared, empty, pair, add, inviteActions, message); container.replaceChildren(home);
 async function openPendingInvitation() {
  const text = await Desk.takeGuestInvitation();
  if (text) showGuestAccept(refresh, showAgents, text);
 }
 events.guestInvitationOpened.on(() => { void openPendingInvitation().catch(report); });
 void openPendingInvitation().catch(report);
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
 document.addEventListener("click", closeMenu);
 document.addEventListener("keydown", event => { if (event.key === "Escape") closeMenu(); });
 sheet.addEventListener("close", () => { (form.elements.namedItem("password") as HTMLInputElement).value = ""; });
 function edit(machine?: SavedMachine) {
  editing = machine ?? null; error.hidden = true;
  for (const key of ["nickname", "host", "port", "user", "keyPath", "session", "password"]) {
   const input = form.elements.namedItem(key);
   if (input instanceof HTMLInputElement) input.value = key === "port" ? String(machine?.port ?? 22) : String(machine?.[key as keyof Machine] ?? "");
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
    const icon = element("span", "host-home-icon");
    if (appleSymbols()) icon.append(await symbol("person.2", 19, "regular"));
    else { const glyph = element("span", "host-computer-glyph"); glyph.style.setProperty("--host-computer", `url("${usersIcon}")`); icon.append(glyph); }
    const lines = element("span", "host-home-lines");
    lines.append(element("span", "host-home-name", access.machineLabel), element("span", "host-home-address", `${access.agentName} · shared by ${access.ownerName}`));
    const chevron = element("span", "host-home-chevron"); chevron.setAttribute("aria-hidden", "true");
    chevron.append(await symbol("chevron.right", 13, "semibold"));
    row.append(icon, lines, chevron); sharedNodes.push(row);
   }
   if (generation !== version) return;
   sharedRows.replaceChildren(...sharedNodes);
   section.hidden = machines.length === 0;
   const next: HTMLElement[] = [];
   for (const machine of machines) {
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
    const icon = element("span", "host-home-icon");
    if (appleSymbols()) icon.append(await symbol("desktopcomputer", 19, "regular"));
    else {
     // SF Symbols are licensed only for Apple platforms; use the same pinned
     // open icon family as the portable symbol renderer.
     const glyph = element("span", "host-computer-glyph");
     glyph.style.setProperty("--host-computer", `url("${desktopIcon}")`); icon.append(glyph);
    }
    const lines = element("span", "host-home-lines");
    // SavedHost.label and ConnectView.secondaryLine: the nickname over user@host, or the
    // host over the user name alone.
    const nickname = machine.nickname?.trim() ?? "";
    lines.append(element("span", "host-home-name", nickname || machine.host), element("span", "host-home-address", busy ? "Connecting…" : nickname ? `${machine.user}@${machine.host}` : machine.user));
    const chevron = element("span", "host-home-chevron"); chevron.setAttribute("aria-hidden", "true");
    if (busy) { chevron.classList.add("host-home-spinner"); chevron.innerHTML = spinner; }
    else chevron.append(await symbol("chevron.right", 13, "semibold"));
    row.append(icon, lines, chevron);
    const openMenu = (x: number, y: number) => {
     closeMenu(); menu = element("div", "host-context-menu"); menu.setAttribute("role", "menu");
     const editButton = action("Edit", () => edit(machine)); editButton.setAttribute("role", "menuitem");
     const deleteButton = action("Delete", () => remove(machine)); deleteButton.setAttribute("role", "menuitem");
     menu.append(editButton, deleteButton); document.body.append(menu);
     menu.style.left = `${Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8))}px`;
     menu.style.top = `${Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8))}px`; editButton.focus();
    };
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
 };
}
