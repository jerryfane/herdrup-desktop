import { Desk, events } from "./mygo";
import type { Machine, SavedMachine } from "./mygo";

export function initHosts(container: HTMLElement, form: HTMLFormElement, showAgents: () => void) {
 const list = document.createElement("section"); list.className = "host-list";
 const heading = document.createElement("h2"); heading.textContent = "Your hosts";
 const explanation = document.createElement("p"); explanation.textContent = "Choose a saved SSH connection, or add one below. Passwords are never saved.";
 const message = document.createElement("p"); message.setAttribute("role", "status");
 const rows = document.createElement("div");
 list.append(heading, explanation, rows, message); container.prepend(list);
 const fill = (m: Partial<Machine>) => {
  for (const key of ["host", "port", "user", "keyPath", "session", "password"]) {
   const input = form.elements.namedItem(key);
   if (input instanceof HTMLInputElement) input.value = key === "port" ? String(m.port ?? 22) : String(m[key as keyof Machine] ?? "");
  }
  form.querySelector<HTMLInputElement>("input")?.focus();
 };
 const add = document.createElement("button"); add.type = "button"; add.textContent = "Add another host"; add.onclick = () => fill({}); list.append(add);
 function password(machine: SavedMachine): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const dialog = document.createElement("dialog"); dialog.className = "host-password";
  const title = document.createElement("h2"); title.textContent = `Connect to ${machine.host}`;
  const label = document.createElement("label"); label.textContent = "SSH password (not saved)";
  const input = document.createElement("input"); input.type = "password"; input.autocomplete = "current-password"; label.append(input);
  const controls = document.createElement("form"); controls.method = "dialog";
  const cancel = document.createElement("button"); cancel.textContent = "Cancel"; cancel.value = "cancel";
  const connect = document.createElement("button"); connect.textContent = "Connect"; connect.value = "connect";
  controls.append(cancel, connect); dialog.append(title, label, controls); document.body.append(dialog);
  dialog.addEventListener("close", () => { resolve(dialog.returnValue === "connect" ? input.value : null); input.value = ""; dialog.remove(); }, { once: true });
  dialog.showModal(); input.focus(); return promise;
 }
 let version = 0;
 async function refresh() {
  const generation = ++version;
  try {
   const machines = await Desk.machines(); if (generation !== version) return;
   rows.replaceChildren();
   if (!machines.length) { const empty = document.createElement("p"); empty.textContent = "No saved hosts yet."; rows.append(empty); }
   for (const m of machines) {
    const row = document.createElement("article"); row.className = "host-row";
    const name = document.createElement("strong"); name.textContent = `${m.user}@${m.host}:${m.port || 22}`;
    const detail = document.createElement("p"); detail.textContent = `${m.session || "Default session"} · ${m.keyPath ? "SSH key" : "Password"}${m.active ? " · Selected" : ""}`;
    const connect = document.createElement("button"); connect.textContent = "Connect"; connect.type = "button";
    connect.onclick = () => { void (async () => {
     connect.disabled = true; message.textContent = "";
     try { const secret = m.keyPath ? "" : await password(m); if (secret === null) return; await Desk.selectMachine(m.id, secret); showAgents(); }
     catch(e) { message.textContent = String(e); }
     finally { connect.disabled = false; }
    })(); };
    const edit = document.createElement("button"); edit.textContent = "Edit connection"; edit.type = "button"; edit.onclick = () => fill(m);
    const remove = document.createElement("button"); remove.textContent = "Remove"; remove.type = "button";
    remove.onclick = () => {
     const dialog = document.createElement("dialog"); dialog.className = "host-password";
     const question = document.createElement("p"); question.textContent = `Remove ${m.user}@${m.host}?${m.active ? " This disconnects the active host." : ""} Remote data is not deleted.`;
     const controls = document.createElement("form"); controls.method = "dialog";
     const cancel = document.createElement("button"); cancel.textContent = "Cancel";
     const confirm = document.createElement("button"); confirm.textContent = "Remove host"; confirm.value = "remove"; controls.append(cancel, confirm);
     dialog.append(question, controls); document.body.append(dialog);
     dialog.addEventListener("close", () => { if (dialog.returnValue === "remove") void Desk.removeMachine(m.id).then(refresh).catch(e => { message.textContent = String(e); }); dialog.remove(); }, { once: true });
     dialog.showModal();
    };
    row.append(name, detail, connect, edit, remove); rows.append(row);
   }
  } catch(e) { message.textContent = String(e); }
 }
 events.stateChanged.on(() => { void refresh(); });
 form.addEventListener("submit", () => { setTimeout(() => { void refresh(); }, 300); });
 void refresh();
 return refresh;
}
