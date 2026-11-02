import { Desk, events, type BoardUpdate } from "./mygo";
import { selectInteraction } from "./interaction";
import "./create.css";

type Scope = Pick<BoardUpdate, "machineID" | "session">;
let active: { scope: Scope; close(): void } | null = null;
const session = (value: string) => value === "default" ? "" : value;
events.boardChanged.on(board => {
  if (active && (board.machineID !== active.scope.machineID || session(board.session) !== session(active.scope.session))) active.close();
});
events.stateChanged.on(state => { if (state.phase !== "connected") active?.close(); });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") {
  const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
}
function button(text: string, action: () => void) {
  const node = el("button", "", text); node.type = "button"; node.onclick = action; return node;
}

export async function showNewAgent(scope: Scope) {
  active?.close();
  const token = crypto.randomUUID();
  let disposed = false, busy = false, ready = false, attempted = false, directoryGeneration = 0;
  const modal = el("dialog", "settings-sheet new-agent-sheet");
  modal.setAttribute("aria-labelledby", "new-agent-title");
  const header = el("header", "settings-sheet-header"), title = el("h2", "", "New agent"); title.id = "new-agent-title";
  const cancel = button("Cancel", () => { if (!busy) modal.close(); }); header.append(title, cancel);
  const form = el("form", "new-agent-form"), status = el("p", "new-agent-status"); status.setAttribute("role", "status"); status.hidden = true;
  const folder = el("input"); folder.type = "text"; folder.placeholder = "Current remote folder"; folder.autocomplete = "off"; folder.spellcheck = false;
  const kind = el("select");
  const task = el("textarea"); task.rows = 5; task.placeholder = "What should the agent do?";
  const start = el("button", "new-agent-start", "Start agent"); start.type = "submit";
  const fields = [folder, kind, task];
  function field(label: string, control: HTMLElement) { const wrapper = el("label", "new-agent-field"); wrapper.append(el("span", "new-agent-label", label), control); return wrapper; }
  function error(reason: unknown) { status.textContent = String(reason); status.hidden = false; }
  function update() {
    const path = folder.value.trim(), valid = !path || path.startsWith("/");
    folder.setCustomValidity(valid ? "" : "Use an absolute path on the remote machine, or leave this empty.");
    start.disabled = !ready || busy || attempted || !valid || !task.value.trim() || !kind.value;
    cancel.disabled = busy;
    for (const field of fields) field.disabled = busy;
    browse.disabled = busy || !ready;
    start.textContent = busy ? "Starting…" : "Start agent";
  }
  const browse = button("Browse…", () => { void browseDirectory(folder.value.trim() || ""); });
  const folderControl = el("div", "new-agent-folder"); folderControl.append(folder, browse);
  form.append(field("Folder", folderControl), field("Agent", kind), field("Task", task), el("p", "new-agent-hint", "The task will be ready in the composer. Send it when the agent is ready."), status, start);
  modal.append(header, form);
  let browser: HTMLElement | null = null;
  function leaveBrowser() { directoryGeneration++; browser?.remove(); browser = null; form.hidden = false; folder.focus(); }
  async function browseDirectory(path: string) {
    const at = ++directoryGeneration;
    if (!browser) { browser = el("section", "new-agent-browser"); modal.append(browser); form.hidden = true; }
    const page = browser; page.replaceChildren(el("p", "new-agent-hint", "Loading folders…"));
    try {
      const listing = JSON.parse(await Desk.creationDirectory(token, path)) as { path: string; entries: { name: string; is_dir: boolean }[] };
      if (disposed || at !== directoryGeneration || page !== browser) return;
      const toolbar = el("div", "new-agent-folder-actions");
      const parent = listing.path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
      const up = button("Up", () => { void browseDirectory(parent); }); up.disabled = listing.path === "/";
      toolbar.append(button("Back", leaveBrowser), up, button("Use this folder", () => { folder.value = listing.path; leaveBrowser(); update(); }));
      const heading = el("p", "new-agent-path", listing.path), list = el("div", "new-agent-directories");
      for (const entry of listing.entries.filter(entry => entry.is_dir)) {
        list.append(button(entry.name, () => { void browseDirectory(`${listing.path.replace(/\/+$/, "")}/${entry.name}`); }));
      }
      if (!list.childElementCount) list.append(el("p", "new-agent-hint", "No subfolders."));
      page.replaceChildren(toolbar, heading, list); toolbar.querySelector<HTMLButtonElement>("button")!.focus();
    } catch (reason) {
      if (disposed || at !== directoryGeneration || page !== browser) return;
      page.replaceChildren(button("Back to manual path entry", leaveBrowser), el("p", "new-agent-status", String(reason)));
    }
  }
  form.addEventListener("input", update);
  form.addEventListener("submit", event => {
    event.preventDefault(); if (start.disabled) return;
    busy = true; status.hidden = true; update();
    void (async () => {
      try {
        const draft = task.value.trim();
        const result = await Desk.createAgent(token, folder.value, kind.value);
        if (disposed) return;
        if (result.phase !== "started") {
          attempted = result.phase === "uncertain"; error(result.message); return;
        }
        attempted = true;
        await selectInteraction({ machineID: scope.machineID, session: session(scope.session), paneID: result.paneID }, draft);
        if (!disposed) { document.getElementById("select")!.hidden = true; modal.close(); }
      } catch (reason) { if (!disposed) error(reason); }
      finally { if (!disposed) { busy = false; update(); } }
    })();
  });
  modal.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  const owner = { scope, close: () => { if (!disposed) modal.close(); } };
  active = owner;
  modal.addEventListener("close", () => {
    disposed = true; directoryGeneration++;
    if (active === owner) active = null;
    modal.remove(); void Desk.closeCreation(token).catch(console.error);
  }, { once: true });
  document.body.append(modal); modal.showModal(); update();
  try {
    await Desk.openCreation(scope.machineID, scope.session, token);
    if (disposed) { await Desk.closeCreation(token); return; }
    const kinds = JSON.parse(await Desk.creationKinds(token)) as { kind: string; installed: boolean }[];
    if (disposed) return;
    const available = kinds.filter(item => item.installed).map(item => item.kind);
    for (const value of available.length ? available : ["claude", "codex", "gemini"]) { const option = el("option", "", value); option.value = value; kind.append(option); }
    kind.value = available.includes("claude") || !available.length ? "claude" : available[0]!;
    ready = true; update(); task.focus();
  } catch (reason) { if (!disposed) { error(reason); update(); } }
}

export async function showNewTerminal(scope: Scope, changed: () => Promise<void>) {
  active?.close();
  const token = crypto.randomUUID();
  let disposed = false, busy = true;
  const modal = el("dialog", "settings-sheet new-terminal-sheet");
  const header = el("header", "settings-sheet-header"), heading = el("h2", "", "New terminal");
  heading.id = "new-terminal-title"; modal.setAttribute("aria-labelledby", heading.id);
  const close = button("Close", () => { if (!busy) modal.close(); }); close.disabled = true;
  const status = el("p", "new-terminal-status", "Opening a shell on this machine…"); status.setAttribute("role", "status");
  header.append(heading, close); modal.append(header, status);
  const owner = { scope, close: () => modal.close() }; active = owner;
  modal.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  modal.addEventListener("close", () => {
    disposed = true; if (active === owner) active = null;
    modal.remove(); void Desk.closeCreation(token).catch(console.error);
  }, { once: true });
  document.body.append(modal); modal.showModal();
  try {
    await Desk.openCreation(scope.machineID, scope.session, token);
    if (disposed) { await Desk.closeCreation(token); return; }
    const result = await Desk.createTerminal(token);
    if (disposed) return;
    if (result.phase !== "started" || !result.terminal) { status.textContent = result.message; return; }
    await changed();
    if (disposed) return;
    await selectInteraction({ machineID: scope.machineID, session: session(scope.session), paneID: result.terminal.paneID }, undefined, true);
    if (!disposed) document.querySelector<HTMLElement>(`.saved-terminal-row[data-id="${CSS.escape(result.terminal.paneID)}"]`)?.scrollIntoView({ block: "nearest" });
    if (!disposed) { document.getElementById("select")!.hidden = true; modal.close(); }
  } catch (error) { if (!disposed) status.textContent = String(error); }
  finally { if (!disposed) { busy = false; close.disabled = false; } }
}
