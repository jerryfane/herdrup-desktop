import { Desk, events, type AgentTarget, type BoardUpdate, type SavedTerminal } from "./mygo";
import { savedTerminalChanged, selectInteraction } from "./interaction";
import "./terminals.css";

type Scope = Pick<BoardUpdate, "machineID" | "session">;
type SymbolRenderer = (name: string, size: number, weight: string) => Promise<HTMLElement>;
const session = (value: string) => value === "default" ? "" : value;
let active: { scope: Scope; close(): void } | null = null;
events.boardChanged.on(board => { if (active && (active.scope.machineID !== board.machineID || session(active.scope.session) !== session(board.session))) active.close(); });
events.stateChanged.on(state => { if (state.phase !== "connected") active?.close(); });
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = "") { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node; }
function button(text: string, action: () => void) { const node = el("button", "", text); node.type = "button"; node.onclick = action; return node; }

export async function terminalRows(scope: Scope, query: string, symbol: SymbolRenderer, changed: () => Promise<void>): Promise<HTMLElement | null> {
  const saved = await Desk.savedTerminals(scope.machineID, scope.session);
  const needle = query.trim().toLocaleLowerCase();
  const entries = saved.filter(entry => !needle || entry.label.toLocaleLowerCase().includes(needle));
  if (!entries.length) return null;
  const section = el("section", "saved-terminals"), heading = el("h2", "saved-terminals-heading", "Terminals");
  section.append(heading);
  for (const entry of entries) {
    const target = { machineID: scope.machineID, session: session(scope.session), paneID: entry.paneID };
    const row = el("div", "row saved-terminal-row"); row.dataset.id = entry.paneID; row.tabIndex = 0;
    row.setAttribute("role", "button"); row.setAttribute("aria-label", entry.label);
    const icon = el("span", "saved-terminal-icon"); icon.setAttribute("aria-hidden", "true"); icon.append(await symbol("terminal", 17, "semibold"));
    const label = el("span", "saved-terminal-label t-card-title", entry.label);
    const text = el("span", "saved-terminal-text"); text.append(label, el("span", "saved-terminal-kind t-card-subtitle", "shell"));
    const open = () => { void selectInteraction(target, undefined, true).then(() => { document.getElementById("select")!.hidden = true; }).catch(error => { label.textContent = `${entry.label}: ${String(error)}`; }); };
    const manage = () => manageTerminal(target, entry, changed);
    const options = button("…", manage); options.setAttribute("aria-label", `${entry.label} options`);
    options.onclick = event => { event.stopPropagation(); manage(); };
    row.onclick = open;
    row.onkeydown = event => {
      if (event.target !== row) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); manage(); }
    };
    row.oncontextmenu = event => { event.preventDefault(); manage(); };
    row.append(icon, text, options); section.append(row);
  }
  return section;
}

function manageTerminal(target: AgentTarget, terminal: SavedTerminal, changed: () => Promise<void>) {
  active?.close();
  let disposed = false, busy = false;
  const modal = el("dialog", "settings-sheet terminal-manage-sheet");
  const heading = el("h2", "", terminal.label); heading.id = "terminal-manage-title";
  modal.setAttribute("aria-labelledby", heading.id);
  const header = el("header", "settings-sheet-header"); header.append(heading, button("Close", () => { if (!busy) modal.close(); }));
  const label = el("input", "terminal-label-input"); label.value = terminal.label; label.setAttribute("aria-label", "Terminal name");
  const status = el("p", "terminal-manage-status"); status.hidden = true; status.setAttribute("role", "status");
  const actions = el("div", "terminal-manage-actions"), confirmation = el("div", "terminal-confirmation"); confirmation.hidden = true;
  const report = (error: unknown) => { status.textContent = String(error); status.hidden = false; };
  async function perform(work: () => Promise<void>, nextLabel: string | null) {
    if (busy || disposed) return;
    busy = true; status.hidden = true; label.disabled = true;
    modal.querySelectorAll("button").forEach(node => { node.disabled = true; });
    try {
      await work(); if (disposed) return;
      savedTerminalChanged(target, nextLabel);
      await changed(); if (!disposed) modal.close();
    } catch (error) { if (!disposed) report(error); }
    finally {
      busy = false; if (!disposed) { label.disabled = false; modal.querySelectorAll("button").forEach(node => { node.disabled = false; }); }
    }
  }
  function confirm(closeRemote: boolean) {
    label.hidden = true; actions.hidden = true; confirmation.hidden = false;
    confirmation.replaceChildren(el("p", "", closeRemote ? "Close this terminal and end its shell and any running program?" : "Forget this terminal on this device? Its shell keeps running on the machine."),
      button("Cancel", () => { confirmation.hidden = true; actions.hidden = false; label.hidden = false; }),
      button(closeRemote ? "Close terminal" : "Forget terminal", () => { void perform(() => closeRemote ? Desk.closeTerminal(target) : Desk.forgetTerminal(target), null); }));
  }
  actions.append(button("Save name", () => {
    const name = label.value.trim(); if (!name) { report("Enter a terminal name."); label.focus(); return; }
    void perform(() => Desk.renameTerminal(target, name), name);
  }), button("Close terminal…", () => confirm(true)), button("Forget without closing…", () => confirm(false)));
  modal.append(header, label, actions, confirmation, status);
  const owner = { scope: target, close: () => modal.close() }; active = owner;
  modal.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  modal.addEventListener("close", () => {
    disposed = true; if (active === owner) active = null; modal.remove();
    document.querySelector<HTMLElement>(`.saved-terminal-row[data-id="${CSS.escape(target.paneID)}"]`)?.focus();
  }, { once: true });
  document.body.append(modal); modal.showModal(); label.focus(); label.select();
}
