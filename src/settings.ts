import { Desk, events } from "./mygo";
import type { BoardUpdate, ConnState, Machine, PeerSummary, SavedMachineStatus } from "./mygo";
import { changeTextSize, onTextSizeChanged, textSize } from "./textSize";
import { AccountSettings } from "./settingsAccounts";
import accountIcon from "../third_party/phosphor/web/user-circle.svg?url";
import { version } from "../package.json";
import "./settings.css";
import textSizeIcon from "../third_party/phosphor/web/text-aa.svg?url";
import reportIcon from "../third_party/phosphor/web/chat-text.svg?url";
import privacyIcon from "../third_party/phosphor/web/shield-check.svg?url";
import termsIcon from "../third_party/phosphor/web/file-text.svg?url";
import codeIcon from "../third_party/phosphor/web/code.svg?url";
import addIcon from "../third_party/phosphor/web/plus-circle.svg?url";

const settingIcons: Record<string, string> = {
  "textformat.size": textSizeIcon, "exclamationmark.bubble": reportIcon,
  "lock.shield": privacyIcon, "doc.text": termsIcon,
  "chevron.left.forwardslash.chevron.right": codeIcon, "plus.circle": addIcon,
  "person.crop.circle": accountIcon,
};

type SymbolRenderer = (name: string, size: number, weight: string) => Promise<HTMLElement>;
type Page = "machines" | "accounts" | "textSize";
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
}
function button(label: string, action: () => void) {
  const node = el("button", "", label); node.type = "button"; node.onclick = action; return node;
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function initSettings(sidebar: HTMLElement, detail: HTMLElement, symbol: SymbolRenderer, reconnect: () => Promise<void>) {
  const index = el("nav", "settings-index"); index.setAttribute("aria-label", "Settings"); index.hidden = true;
  sidebar.insertBefore(index, document.getElementById("tabbar"));
  const page = el("section", "settings-detail"); page.hidden = true; detail.append(page);
  const title = el("h1", "settings-page-title", "Machines"), body = el("div", "settings-page-body");
  const message = el("p", "settings-message"); message.hidden = true; message.setAttribute("role", "status");
  page.append(title, message, body);
  let visible = false, selected: Page = "machines", generation = 0, identity = "", busy = "";
  let state: ConnState | null = null, board: BoardUpdate | null = null, machine: Machine | null = null;
  let statuses: SavedMachineStatus[] = [], peers: PeerSummary[] = [], federationError = "";
  let machineNameNodes: HTMLElement[] = [], connectionNodes: HTMLElement[] = [];
  let reconnectButton: HTMLButtonElement | null = null, reach: HTMLElement | null = null;
  let openDialog: HTMLDialogElement | null = null;
  const report = (error: unknown) => { message.textContent = String(error); message.hidden = false; };
  let settingsToken = "";
  const accounts = new AccountSettings(report);
  function closeScope() {
    accounts.setScope("");
    const token = settingsToken; settingsToken = "";
    if (token) void Desk.closeSettings(token).catch(report);
  }
  async function openScope(at: number) {
    if (state?.phase !== "connected" || !board) return;
    const token = crypto.randomUUID(), target = board; settingsToken = token;
    try {
      await Desk.openSettings(target.machineID, target.session, token);
      if (at !== generation || !visible) { void Desk.closeSettings(token); return; }
      accounts.setScope(token);
    } catch (error) { if (at === generation) report(error); }
  }
  function glyph(name: string, size = 20) {
    const slot = el("span", "settings-glyph"); slot.setAttribute("aria-hidden", "true");
    if (!navigator.platform.startsWith("Mac") && settingIcons[name]) {
      const image = el("span", "settings-portable-glyph");
      image.style.setProperty("--settings-icon", `url("${settingIcons[name]}")`);
      image.style.width = image.style.height = `${size}px`; slot.append(image);
    } else {
      void symbol(name, size, "regular").then(node => slot.append(node)).catch(report);
    }
    return slot;
  }
  function name() { return machine?.nickname || machine?.host || state?.machine || "Machine"; }
  function disc(size: number, label: string) {
    const node = el("span", "settings-machine-disc", Array.from(label.trim())[0]?.toUpperCase() || "?");
    node.style.setProperty("--disc-size", `${size}px`); node.setAttribute("aria-hidden", "true"); return node;
  }
  function group(label: string, rows: HTMLElement[]) {
    const section = el("section", "settings-section");
    section.append(el("h2", "settings-section-label", label));
    const card = el("div", "settings-group"); card.append(...rows); section.append(card); return section;
  }
  function row(label: string, icon: string, action: () => void, subtitle = "", value = "") {
    const node = button("", action); node.className = "settings-row";
    const lines = el("span", "settings-row-lines"); lines.append(el("span", "settings-row-label", label));
    if (subtitle) lines.append(el("span", "settings-row-subtitle", subtitle));
    node.append(glyph(icon), lines);
    if (value) node.append(el("span", "settings-row-value", value));
    node.append(glyph("chevron.right", 12)); return node;
  }
  function link(label: string, icon: string, url: string) {
    return row(label, icon, () => { void Desk.openExternalURL(url).catch(report); });
  }
  function choose(next: Page) { if (next !== "accounts") accounts.closeDialogs(); selected = next; message.hidden = true; renderIndex(); renderPage(); }
  function renderIndex() {
    machineNameNodes = []; connectionNodes = [];
    const card = button("", () => choose("machines")); card.className = "settings-machine-card";
    card.setAttribute("aria-current", selected === "machines" ? "page" : "false");
    const lines = el("span", "settings-machine-card-lines"), label = el("strong", "settings-machine-card-name", name());
    machineNameNodes.push(label);
    const connection = el("span", "settings-machine-card-status"); connectionNodes.push(connection);
    lines.append(label, connection); card.append(disc(60, name()), lines, glyph("chevron.right", 12));
    const accountRow = row("Accounts", "person.crop.circle", () => choose("accounts"), "Subscriptions on your home box");
    accountRow.setAttribute("aria-current", selected === "accounts" ? "page" : "false");
    const sizing = row("Text size", "textformat.size", () => choose("textSize"), "", `${textSize("terminal")} pt`);
    sizing.setAttribute("aria-current", selected === "textSize" ? "page" : "false");
    index.replaceChildren(card, group("HERD", [accountRow]), group("PREFERENCES", [sizing]), group("HELP", [
      link("Report a bug or request a feature", "exclamationmark.bubble", "https://github.com/themartianapp/herdrup/issues"),
    ]), group("ABOUT", [
      link("Join the Discord", "bubble.left.and.bubble.right.fill", "https://discord.gg/pq7qj4dDqt"),
      link("Privacy Policy", "lock.shield", "https://herdrup.themartian.app/legal/privacy"),
      link("Terms of Service", "doc.text", "https://herdrup.themartian.app/legal/terms"),
      link("Open source on GitHub", "chevron.left.forwardslash.chevron.right", "https://github.com/themartianapp/herdrup"),
    ]), el("p", "settings-version", `herdrup ${version}`));
    updateConnection();
  }
  function updateConnection() {
    for (const node of machineNameNodes) node.textContent = name();
    const connected = state?.phase === "connected";
    for (const node of connectionNodes) {
      const dot = el("span", "settings-status-dot"); dot.dataset.state = connected ? "reachable" : "offline";
      node.replaceChildren(dot, document.createTextNode(connected ? "Connected" : "Disconnected"));
      if (node.classList.contains("settings-machine-card-status")) node.append(document.createTextNode(` · ${plural(board?.board.total ?? 0, "agent")}`));
    }
    if (reconnectButton) {
      const refused = state?.phase === "error" && state.message.includes("refusing to connect");
      reconnectButton.disabled = state?.phase === "connecting" || refused;
      reconnectButton.title = refused ? "verify the host key first" : "";
    }
    if (reach) {
      const offline = peers.filter(peer => peer.reachability === "offline").length;
      const text = offline ? `${offline} offline` : peers.some(peer => peer.reachability === "degraded") ? "some slow" : "all reachable";
      reach.textContent = `${plural(peers.length + 1, "machine")} · ${plural(board?.board.total ?? 0, "agent")} · ${text}`;
    }
  }
  function renderPage() {
    reconnectButton = null; reach = null;
    machineNameNodes = machineNameNodes.filter(node => index.contains(node));
    connectionNodes = connectionNodes.filter(node => index.contains(node));
    title.textContent = selected === "machines" ? "Machines" : selected === "accounts" ? "Accounts" : "Text size";
    body.replaceChildren();
    if (selected === "accounts") { body.append(accounts.root); return; }
    if (selected === "textSize") {
      const preview = el("div", "settings-size-preview");
      const text = el("span", "settings-terminal-preview", "~ $ herdr"); text.style.fontSize = `${textSize("terminal")}px`;
      preview.append(text, el("span", "", `${textSize("terminal")} pt`));
      const controls = el("div", "settings-size-controls");
      for (const [label, delta] of [["A−", -1], ["Reset", "reset"], ["A+", 1]] as const) {
        const control = button(label, () => { try { changeTextSize("terminal", delta); } catch (error) { report(error); } });
        control.disabled = delta === -1 ? textSize("terminal") <= 9 : delta === 1 ? textSize("terminal") >= 24 : textSize("terminal") === 12.5;
        controls.append(control);
      }
      body.append(group("Terminal text — agent output", [preview, controls])); return;
    }
    const hero = el("div", "settings-machine-hero"), label = el("h2", "settings-machine-hero-name", name());
    machineNameNodes.push(label); const connection = el("p", "settings-machine-connection"); connectionNodes.push(connection);
    hero.append(disc(88, name()), label, connection);
    reconnectButton = button("Reconnect now", () => { void reconnect().catch(report); }); reconnectButton.className = "settings-plain-row";
    const copy = button("Copy diagnostics", () => {
      void Desk.gramCopyText(`herdrup-desktop ${version}, host ${name()}`).then(() => {
        copy.textContent = "Copied"; window.setTimeout(() => { copy.textContent = "Copy diagnostics"; }, 2000);
      }).catch(report);
    }); copy.className = "settings-plain-row";
    body.append(hero, group("CONNECTION", [reconnectButton, copy]), federation());
    reach = el("p", "settings-reach"); body.append(reach); updateConnection();
  }
  function federation() {
    const rows: HTMLElement[] = [];
    for (const saved of statuses) {
      const item = el("div", "settings-federation-row");
      let status = saved.savedState === "disabled" ? "Disabled" : saved.savedState === "coordinator_disabled" ? "Coordinator off" : saved.hasFederationPolicy ? saved.federationReachability || "Connecting" : "Not federated";
      if (saved.peer) status += ` · ${plural(saved.peer.agentCount, "agent")}`;
      if (saved.stale) status += " (stale)";
      const lines = el("div", "settings-row-lines"); lines.append(el("strong", "", saved.displayLabel), el("span", "settings-row-subtitle", status));
      const change = button(busy === saved.profileID ? "Changing…" : saved.hasFederationPolicy ? "Unfederate" : "Federate", () => {
        if (saved.hasFederationPolicy) void setFederation(saved, false);
        else confirmFederation(saved);
      });
      change.disabled = state?.phase !== "connected" || !!busy || (saved.savedState === "disabled" && !saved.hasFederationPolicy);
      item.append(disc(40, saved.displayLabel), lines);
      if (saved.peer) item.append(peerDot(saved.peer));
      item.append(change); rows.push(item);
    }
    for (const peer of peers.filter(peer => !statuses.some(saved => saved.profileID === peer.alias))) {
      const item = el("div", "settings-federation-row"), lines = el("div", "settings-row-lines");
      lines.append(el("strong", "", peer.label || peer.alias), el("span", "settings-row-subtitle", plural(peer.agentCount, "agent")));
      item.append(disc(40, peer.label || peer.alias), lines, peerDot(peer)); rows.push(item);
    }
    if (!rows.length) {
      const empty = el("div", "settings-federation-empty");
      empty.append(el("p", "", "No saved machines yet."), el("p", "settings-row-subtitle", "Save an SSH machine on your home box, then opt it into federation here.")); rows.push(empty);
    }
    if (federationError) rows.push(el("p", "settings-inline-error", federationError));
    rows.push(row("How to add a machine", "plus.circle", showFederationGuide, "Connect another computer to your home box"));
    return group("FEDERATION", rows);
  }
  function peerDot(peer: PeerSummary) {
    const dot = el("span", "settings-status-dot"); dot.dataset.state = peer.reachability; dot.setAttribute("aria-label", peer.reachability); return dot;
  }
  function dialog(title: string) {
    openDialog?.close(); const modal = el("dialog", "settings-sheet");
    const header = el("header", "settings-sheet-header"); header.append(el("h2", "", title), button("Close", () => modal.close()));
    modal.append(header); document.body.append(modal); openDialog = modal;
    modal.addEventListener("close", () => { if (openDialog === modal) openDialog = null; modal.remove(); }, { once: true }); return modal;
  }
  function confirmFederation(saved: SavedMachineStatus) {
    const at = generation;
    const modal = dialog(`Federate ${saved.displayLabel}?`);
    modal.append(el("p", "", "Continuous federation gives the home box full SSH authority over this Herdr session. Confirm that this is the machine you intend to trust."));
    modal.append(button("Cancel", () => modal.close()), button("Federate", () => {
      modal.close(); if (at === generation) void setFederation(saved, true);
    })); modal.showModal();
  }
  async function setFederation(saved: SavedMachineStatus, enabled: boolean) {
    if (busy || !visible || state?.phase !== "connected") return;
    const at = generation; busy = saved.profileID; message.hidden = true; renderPage();
    try { await Desk.setMachineFederation(saved.profileID, enabled); }
    catch (error) { if (at === generation) report(error); }
    finally { if (at === generation) { busy = ""; renderPage(); } }
  }
  function showFederationGuide() {
    const modal = dialog("How to add a machine");
    for (const [title, text] of [
      ["Install Herdr", "Install the jerryfane/herdr fork on the other machine and start its Herdr server."],
      ["Connect over SSH", "Join it to your Tailscale tailnet (or another reachable network), check its SSH host key, and authorize your home box's SSH public key."],
      ["Save the machine", "On your home box run the command below. It saves an SSH profile without granting continuous federation access."],
      ["Opt in explicitly", "Tap Federate beside the saved machine here, or run herdr machine federate <label> on the home box. A remote identity change fails closed."],
    ]) { modal.append(el("h3", "", title), el("p", "", text)); }
    const command = "herdr machine add --label mac-studio user@mac-studio";
    modal.append(el("pre", "", command), button("Copy command", () => { void Desk.gramCopyText(command).catch(report); })); modal.showModal();
  }
  async function refresh() {
    const at = ++generation; busy = ""; federationError = "";
    closeScope(); void openScope(at);
    const [saved, machines, remotePeers] = await Promise.allSettled([Desk.machine(), Desk.machineStatuses(), Desk.peers()]);
    if (at !== generation || !visible) return;
    machine = saved.status === "fulfilled" ? saved.value : null;
    statuses = machines.status === "fulfilled" ? machines.value : [];
    peers = remotePeers.status === "fulfilled" ? remotePeers.value : [];
    if (machines.status === "rejected") federationError = String(machines.reason);
    if (saved.status === "rejected") report(saved.reason);
    renderIndex(); renderPage();
  }
  events.machineStatusChanged.on(next => { if (!visible) return; statuses = next; federationError = ""; if (selected === "machines") renderPage(); });
  let peerRead = 0;
  events.boardChanged.on(() => {
    if (!visible || state?.phase !== "connected") return;
    const at = generation, request = ++peerRead;
    void Desk.peers().then(next => {
      if (at !== generation || request !== peerRead || JSON.stringify(next) === JSON.stringify(peers)) return;
      peers = next;
      statuses = statuses.map(saved => ({ ...saved, peer: peers.find(peer => peer.alias === saved.profileID) ?? null }));
      if (selected === "machines") renderPage();
    }).catch(error => { if (at === generation) report(error); });
  });
  onTextSizeChanged(() => { if (visible) { renderIndex(); renderPage(); } });
  renderIndex(); renderPage();
  return {
    show(show: boolean, nextState: ConnState, nextBoard: BoardUpdate | null) {
      const nextID = `${nextBoard?.machineID ?? ""}\0${nextBoard?.session ?? ""}`;
      const reload = show && (!visible || identity !== nextID || state?.phase !== nextState.phase);
      state = nextState; board = nextBoard; identity = nextID; visible = show; index.hidden = !show; page.hidden = !show;
      if (!show) { generation++; busy = ""; openDialog?.close(); closeScope(); }
      updateConnection();
      if (reload) { openDialog?.close(); message.hidden = true; machine = null; statuses = []; peers = []; renderIndex(); renderPage(); void refresh(); }
    },
  };
}
