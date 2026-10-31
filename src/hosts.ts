import { Desk, events } from "./mygo";
import type { Machine, SavedMachine } from "./mygo";
import "./hosts.css";
import { showPairing } from "./pairing";
import desktopIcon from "../third_party/phosphor/web/desktop.svg?url";

type SymbolRenderer = (name: string, size: number, weight: string) => Promise<HTMLElement>;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] {
 const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
}
function action(text: string, run: () => void) {
 const button = element("button", "", text); button.type = "button"; button.onclick = run; return button;
}

export function initHosts(container: HTMLElement, form: HTMLFormElement, showAgents: () => void, symbol: SymbolRenderer) {
 const home = element("div", "host-home");
 const header = element("header", "host-home-header");
 const mark = element("img", "host-home-mark"); mark.src = "/herdrup/app-logo.png"; mark.alt = "";
 const identity = element("div", "host-home-identity");
 identity.append(element("h1", "", "herdrup"), element("p", "", "connect to your machine")); header.append(mark, identity);
 const section = element("section", "host-home-saved");
 const rows = element("div", "host-home-rows");
 section.append(element("h2", "", "SAVED"), rows);
 const message = element("p", "host-home-message"); message.setAttribute("role", "status"); message.hidden = true;
 const report = (error: unknown) => { message.textContent = String(error); message.hidden = false; };
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
 home.append(header, section, pair, add, message); container.replaceChildren(home);
 let editing: SavedMachine | null = null;
 let saving = false;
 let connecting = false;
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
   if (connect) await Desk.connect(machine, String(data.get("password") ?? ""));
   else await Desk.saveMachine(machine, editing?.id ?? "");
   sheet.close(); await refresh(); if (connect) showAgents();
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
  try {
   const machines = await Desk.machines(); if (generation !== version) return;
   section.hidden = machines.length === 0;
   const next: HTMLElement[] = [];
   for (const machine of machines) {
    const row = action("", () => { void (async () => {
     row.disabled = true; message.hidden = true;
     try { const secret = machine.keyPath ? "" : await password(machine); if (secret === null) return; await Desk.selectMachine(machine.id, secret); showAgents(); }
     catch (failure) { report(failure); }
     finally { row.disabled = connecting; }
    })(); });
    row.className = "host-home-row";
    row.disabled = connecting;
    const icon = element("span", "host-home-icon");
    if (navigator.platform.startsWith("Mac")) icon.append(await symbol("desktopcomputer", 19, "regular"));
    else {
     // SF Symbols are licensed only for Apple platforms; use the same pinned
     // open icon family as the portable symbol renderer.
     const glyph = element("span", "host-computer-glyph");
     glyph.style.setProperty("--host-computer", `url("${desktopIcon}")`); icon.append(glyph);
    }
    const lines = element("span", "host-home-lines");
    lines.append(element("span", "host-home-name", machine.nickname || machine.host), element("span", "host-home-address", `${machine.user}@${machine.host}${machine.port && machine.port !== 22 ? ":" + machine.port : ""}`));
    const chevron = element("span", "host-home-chevron"); chevron.setAttribute("aria-hidden", "true");
    chevron.append(await symbol("chevron.right", 13, "semibold"));
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
  if (state.phase === "error") report(`${state.machine}: ${state.message}`);
  else message.hidden = true;
  void refresh();
 });
 void refresh();
 return {
  refresh,
  async reconnect() {
   const machine = (await Desk.machines()).find(machine => machine.active);
   if (!machine) throw new Error("Choose a saved host before reconnecting.");
   const secret = machine.keyPath ? "" : await password(machine);
   if (secret !== null) await Desk.selectMachine(machine.id, secret);
  },
 };
}
