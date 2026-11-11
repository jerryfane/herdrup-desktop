import { Desk, events } from "./mygo";
import type { AppUpdateState, BoardUpdate, ConnState, Machine, PeerSummary, SavedMachineStatus } from "./mygo";
import { changeTextSize, changeUIFontScale, onTextSizeChanged, textSize, uiFontScale } from "./textSize";
import { predictionMode, changePredictionMode } from "./typingPreference";
import type { PredictionMode } from "./predictiveEcho";
import { typingLatency, latencyLines } from "./typingLatency";
import { defaultChatMode, changeDefaultChatMode } from "./chatPreference";
import { AccountSettings } from "./settingsAccounts";
import accountIcon from "../third_party/phosphor/web/key.svg?url";
import { GuestSettings } from "./settingsGuests";
import guestsIcon from "../third_party/phosphor/web/users.svg?url";
import { NotificationsSettings } from "./settingsNotifications";
import { SavedSwitch } from "./settingsSwitch";
import { ServerUpdateSettings, type UpdateSuggestion } from "./settingsUpdates";
import { AppUpdateSettings, appUpdateNewer, appUpdateSummary, appUpdatesShown, watchAppUpdate } from "./appUpdates";
import notificationIcon from "../third_party/phosphor/web/bell.svg?url";
import { version } from "../package.json";
import "./settings.css";
import textSizeIcon from "../third_party/phosphor/web/text-aa.svg?url";
import reportIcon from "../third_party/phosphor/web/chat-text.svg?url";
import privacyIcon from "../third_party/phosphor/web/shield-check.svg?url";
import termsIcon from "../third_party/phosphor/web/file-text.svg?url";
import codeIcon from "../third_party/phosphor/web/code.svg?url";
import addIcon from "../third_party/phosphor/web/plus-circle.svg?url";
import keyboardIcon from "../third_party/phosphor/web/keyboard.svg?url";
import latencyIcon from "../third_party/phosphor/web/gauge.svg?url";
import updateIcon from "../third_party/phosphor/web/arrow-circle-down.svg?url";
import externalLinkIcon from "../third_party/phosphor/web/arrow-up-right-bold.svg?url";
import pickerIcon from "../third_party/phosphor/web/caret-up-down.svg?url";
import chatsIcon from "../third_party/phosphor/web/chats.svg?url";
import sparkleIcon from "../third_party/phosphor/web/sparkle-bold.svg?url";
import usageIcon from "../third_party/phosphor/web/chart-bar.svg?url";
import { agentGuideFooter } from "./copyForAgent";
import { federationAddCommand, federationAgentPrompt } from "./agentPrompts";
import { errorText } from "./errors";
import { appleSymbols } from "./platform";

const settingIcons: Record<string, string> = {
  "textformat.size": textSizeIcon, "exclamationmark.bubble": reportIcon,
  "lock.shield": privacyIcon, "doc.text": termsIcon,
  "chevron.left.forwardslash.chevron.right": codeIcon, "plus.circle": addIcon,
  "key.horizontal": accountIcon,
  "person.2": guestsIcon,
  "bell": notificationIcon,
  "keyboard": keyboardIcon,
  "arrow.down.circle": updateIcon,
  "gauge.with.needle": latencyIcon, "arrow.up.right": externalLinkIcon,
  "chevron.up.chevron.down": pickerIcon,
  "bubble.left.and.bubble.right": chatsIcon,
  "sparkles": sparkleIcon,
  "chart.bar": usageIcon,
};

type SymbolRenderer = (name: string, size: number, weight: string) => Promise<HTMLElement>;
type Page = "machines" | "accounts" | "sharedAccess" | "notifications" | "textSize" | "typingLatency" | "appUpdates";
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = cls; node.textContent = text; return node;
}
function button(label: string, action: () => void) {
  const node = el("button", "", label); node.type = "button"; node.onclick = action; return node;
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `opened` runs when a page is chosen: the phone layout shows it in place of the index
 *  (main.ts, compact). */
export function initSettings(sidebar: HTMLElement, detail: HTMLElement, symbol: SymbolRenderer, reconnect: () => Promise<void>, opened: () => void) {
  const index = el("nav", "settings-index"); index.setAttribute("aria-label", "Settings"); index.hidden = true;
  sidebar.insertBefore(index, document.getElementById("tabbar"));
  const page = el("section", "settings-detail"); page.hidden = true; detail.append(page);
  const title = el("h1", "settings-page-title", "Machines"), body = el("div", "settings-page-body");
  // detailHeader: the page's summary line under the title, amber when it warns.
  const subtitle = el("p", "settings-page-subtitle"); subtitle.hidden = true;
  const message = el("p", "settings-message"); message.hidden = true; message.setAttribute("role", "status");
  page.append(title, subtitle, message, body);
  let visible = false, selected: Page = "machines", generation = 0, identity = "", busy = "";
  let latencyTimer: number | undefined;
  let state: ConnState | null = null, board: BoardUpdate | null = null, machine: Machine | null = null;
  let statuses: SavedMachineStatus[] = [], peers: PeerSummary[] = [], federationError = "";
  let machineNameNodes: HTMLElement[] = [], connectionNodes: HTMLElement[] = [];
  let machineVersion = "";
  let versionNodes: HTMLElement[] = [];
  let reconnectButton: HTMLButtonElement | null = null, reach: HTMLElement | null = null;
  let reconnectNote: HTMLElement | null = null;
  let openDialog: HTMLDialogElement | null = null;
  const report = (error: unknown) => { message.textContent = errorText(error); message.hidden = false; };
  let settingsToken = "";
  const accountSummary = el("span", "settings-row-value"), guestSummary = el("span", "settings-row-value"), notificationSummary = el("span", "settings-row-value");
  const headers: Partial<Record<Page, { text: string; warn: boolean }>> = {};
  // Declared before the page models: their constructors report a first summary at once.
  let exhausted: string[] = [], update: UpdateSuggestion | null = null, appUpdate: AppUpdateState | null = null, suggestionsKey = "";
  const suggestions = el("div", "settings-suggestions");
  const setHeader = (at: Page, text: string, warn = false) => { headers[at] = { text, warn }; if (selected === at) showSubtitle(); };
  const accounts = new AccountSettings(report, glyph, summary => {
    accountSummary.textContent = summary.value; setHeader("accounts", summary.header, summary.warn);
    exhausted = summary.exhausted; renderSuggestions();
  });
  const guests = new GuestSettings(report, (value, header) => { guestSummary.textContent = value; setHeader("sharedAccess", header); });
  const notifications = new NotificationsSettings(report, (value, header, warn) => {
    notificationSummary.textContent = value; notificationSummary.classList.toggle("warn", warn); setHeader("notifications", header, warn);
  }, select => menuPicker(select));
  // usageCountRow (HerdrApp.swift): on by default; Go keeps the install ID and deletes it when off.
  const usageCount = new SavedSwitch(glyph("chart.bar", 18), {
    title: "Share anonymous usage count", fallback: true,
    subtitle: () => "Once a day: a random ID, the app version and the platform. Nothing about your agents or machines.",
    load: () => Desk.getShareUsageCount(), save: on => Desk.setShareUsageCount(on),
  });
  usageCount.root.id = "settings-usage-count";
  // The app's own update (appUpdates.ts): the About row's status, its page, and a suggestion while one waits.
  const appUpdateValue = el("span", "settings-row-value"), appUpdates = new AppUpdateSettings(report);
  watchAppUpdate(next => { appUpdate = next; appUpdateValue.textContent = appUpdateSummary(next); renderSuggestions(); });
  const updates = new ServerUpdateSettings(report, next => { update = next; renderSuggestions(); });
  function closeScope() {
    accounts.setScope("");
    guests.setScope("");
    updates.setScope("");
    const token = settingsToken; settingsToken = "";
    if (token) void Desk.closeSettings(token).catch(report);
    machineVersion = "";
    updateVersion();
  }
  async function openScope(at: number) {
    if (state?.phase !== "connected" || !board) return;
    const token = crypto.randomUUID(), target = board; settingsToken = token;
    try {
      await Desk.openSettings(target.machineID, target.session, token);
      if (at !== generation || !visible) { void Desk.closeSettings(token); return; }
      accounts.setScope(token);
      guests.setMachines(name(), statuses, peers); guests.setScope(token);
      updates.setScope(token, name());
      const version = await Desk.settingsMachineVersion(token);
      if (at !== generation || !visible || settingsToken !== token) return;
      machineVersion = version;
      updateVersion();
    } catch (error) { if (at === generation) report(error); }
  }
  function glyph(name: string, size = 20, weight = "regular") {
    const slot = el("span", "settings-glyph"); slot.setAttribute("aria-hidden", "true");
    if (!appleSymbols() && settingIcons[name]) {
      const image = el("span", "settings-portable-glyph");
      image.style.setProperty("--settings-icon", `url("${settingIcons[name]}")`);
      image.style.width = image.style.height = `${size}px`; slot.append(image);
    } else {
      void symbol(name, size, weight).then(node => slot.append(node)).catch(report);
    }
    return slot;
  }
  function menuPicker(select: HTMLSelectElement) {
    const picker = el("span", "settings-menu-picker"), value = el("span");
    value.setAttribute("aria-hidden", "true");
    const sync = () => { value.textContent = select.selectedOptions[0]?.text ?? ""; };
    select.addEventListener("change", sync); sync();
    picker.append(value, glyph("chevron.up.chevron.down", 13, "medium"), select);
    return picker;
  }
  function name() { return machine?.nickname || machine?.host || state?.machine || "Machine"; }
  function updateVersion() {
    for (const node of versionNodes) {
      node.textContent = machineVersion;
      node.hidden = !machineVersion;
    }
  }
  function versionLine() {
    const node = el("span", "settings-machine-version", machineVersion);
    node.hidden = !machineVersion;
    versionNodes.push(node);
    return node;
  }
  function disc(size: number, label: string) {
    const node = el("span", "settings-machine-disc", Array.from(label.trim())[0]?.toUpperCase() || "?");
    node.style.setProperty("--disc-size", `${size}px`); node.setAttribute("aria-hidden", "true"); return node;
  }
  /** savedMachineRow's and peerRow's disc: AgentIdentity.gradient(for:) and glyph(for:) of the
   *  label (DesignSystem.swift 141-172), a 40 pt circle (owner, herdrup #594 e189af0). */
  function identityTile(label: string) {
    const kind = label.toLowerCase();
    const [tint, glyph] = kind.includes("claude") ? [1, "\u2731"] : kind.includes("codex") ? [2, "C"]
      : kind.includes("gemini") ? [3, "\u2726"] : [0, Array.from(label.trim())[0]?.toUpperCase() || "?"];
    const node = el("span", `settings-identity-tile tint-${tint}`, glyph);
    node.setAttribute("aria-hidden", "true"); return node;
  }
  function group(label: string, rows: HTMLElement[]) {
    const section = el("section", "settings-section");
    section.append(el("h2", "settings-section-label", label));
    const card = el("div", "settings-group"); card.append(...rows); section.append(card); return section;
  }
  function row(label: string, icon: string | HTMLElement, action: () => void, subtitle = "", value: string | HTMLElement = "") {
    const node = button("", action); node.className = "settings-row";
    const lines = el("span", "settings-row-lines"); lines.append(el("span", "settings-row-label", label));
    if (subtitle) lines.append(el("span", "settings-row-subtitle", subtitle));
    node.append(typeof icon === "string" ? glyph(icon, 18) : icon, lines);
    if (value) node.append(typeof value === "string" ? el("span", "settings-row-value", value) : value);
    return node;
  }
  function link(label: string, icon: string | HTMLElement, url: string) {
    const node = row(label, icon, () => { void Desk.openExternalURL(url).catch(report); });
    node.append(glyph("arrow.up.right", 12, "semibold")); return node;
  }
  /** discordRow (HerdrApp.swift 9518-9561): Discord's own mark in its own blurple, 18 pt
   *  wide and scaled to fit, never tinted (synced with NOTICE-Discord-Brand.txt). */
  function discordGlyph() {
    const slot = el("span", "settings-glyph"), mark = el("img", "settings-discord-mark") as HTMLImageElement;
    slot.setAttribute("aria-hidden", "true"); mark.src = "/herdrup/discord-mark.png"; mark.alt = "";
    slot.append(mark); return slot;
  }
  function showSubtitle() {
    const line = selected === "typingLatency" ? { text: "Key press to screen, on this computer", warn: false } : headers[selected];
    subtitle.textContent = line?.text ?? ""; subtitle.hidden = !line?.text; subtitle.classList.toggle("warn", !!line?.warn);
  }
  // suggestionsGroup (HerdrApp.swift 8087-8127): only while something waits, under the card.
  function renderSuggestions() {
    const appVersion = appUpdatesShown && appUpdateNewer(appUpdate) ? appUpdate!.version : "";
    const appSubtitle = appUpdate?.phase === "outdated" ? "Download it from its release page" : "A newer version of this app is ready";
    const key = JSON.stringify([update, exhausted, appVersion, appSubtitle]);
    if (key === suggestionsKey) return;
    suggestionsKey = key;
    const rows: HTMLElement[] = [];
    const pill = (count: number, tone: string) => { const node = el("span", `count-pill t-count-pill ${tone}`, String(count)); node.setAttribute("aria-hidden", "true"); return node; };
    if (update) {
      const node = row(update.title, "arrow.down.circle", () => choose("machines"), update.subtitle, pill(1, "waiting"));
      node.id = "settings-suggestion-update"; rows.push(node);
    }
    if (appVersion) {
      const node = row(`Update herdrup to ${appVersion}`, "arrow.down.circle", () => choose("appUpdates"), appSubtitle, pill(1, "waiting"));
      node.id = "settings-suggestion-app-update"; rows.push(node);
    }
    if (exhausted.length) {
      const node = row(exhausted.length === 1 ? exhausted[0]! : `${exhausted.length} accounts are exhausted`, "key.horizontal", () => choose("accounts"),
        exhausted.length === 1 ? "Exhausted. Its agents can move to another account." : "Their agents can move to another account.", pill(exhausted.length, "stopped"));
      node.id = "settings-suggestion-exhausted"; rows.push(node);
    }
    const card = el("div", "settings-group"); card.append(...rows);
    suggestions.replaceChildren(...(rows.length ? [card] : [])); suggestions.hidden = !rows.length;
  }
  function choose(next: Page) {
    if (next !== "accounts") accounts.closeDialogs();
    if (next !== "sharedAccess") guests.closeDialogs();
    selected = next; message.hidden = true; renderIndex(); renderPage(); opened();
  }
  function renderIndex() {
    machineNameNodes = []; connectionNodes = [];
    versionNodes = [];
    const card = button("", () => choose("machines")); card.className = "settings-machine-card";
    card.setAttribute("aria-current", selected === "machines" ? "page" : "false");
    const lines = el("span", "settings-machine-card-lines"), label = el("strong", "settings-machine-card-name", name());
    machineNameNodes.push(label);
    const connection = el("span", "settings-machine-card-status"); connectionNodes.push(connection);
    lines.append(label, connection, versionLine()); card.append(disc(60, name()), lines);
    const accountRow = row("Accounts", "key.horizontal", () => choose("accounts"), "", accountSummary);
    accountRow.setAttribute("aria-current", selected === "accounts" ? "page" : "false");
    const sharedRow = row("Shared access", "person.2", () => choose("sharedAccess"), "", guestSummary);
    sharedRow.setAttribute("aria-current", selected === "sharedAccess" ? "page" : "false");
    const sizing = row("Text size", "textformat.size", () => choose("textSize"), "", `${Math.round(uiFontScale() * 100)}% · ${textSize("terminal")} pt`);
    sizing.setAttribute("aria-current", selected === "textSize" ? "page" : "false");
    const notificationRow = row("Notifications", "bell", () => choose("notifications"), "", notificationSummary);
    notificationRow.setAttribute("aria-current", selected === "notifications" ? "page" : "false");
    const chatChoice = el("select", "settings-choice");
    chatChoice.setAttribute("aria-label", "omp agents open in");
    for (const [value, label] of [["chat", "Chat"], ["terminal", "Terminal"]] as const) {
      const option = el("option", "", label); option.value = value; chatChoice.append(option);
    }
    chatChoice.value = defaultChatMode();
    chatChoice.onchange = () => {
      try { changeDefaultChatMode(chatChoice.value === "terminal" ? "terminal" : "chat"); }
      catch (error) { chatChoice.value = defaultChatMode(); report(error); }
    };
    const chatPreferenceRow = el("label", "settings-row"), chatPreferenceLines = el("span", "settings-row-lines");
    chatPreferenceLines.append(el("span", "settings-row-label", "omp agents open in"), el("span", "settings-row-subtitle", "Claude Code and Codex agents always open in the terminal."));
    // glyphRow("omp agents open in", systemImage: "bubble.left.and.bubble.right") (HerdrApp.swift 8198): outlined.
    chatPreferenceRow.append(glyph("bubble.left.and.bubble.right", 18), chatPreferenceLines, menuPicker(chatChoice));
    const typingRow = el("label", "settings-row settings-chat-preference"), typingLines = el("span", "settings-row-lines");
    typingLines.append(el("span", "settings-row-label", "Instant typing"), el("span", "settings-row-subtitle", "Shows what you type at once and checks it against the server."));
    const typingChoice = el("select", "settings-choice"); typingChoice.setAttribute("aria-label", "Instant typing"); typingChoice.id = "settings-instant-typing";
    for (const [value, label] of [["auto", "Auto"], ["always", "Always"], ["off", "Off"]]) {
      const option = el("option", "", label); option.value = value!; typingChoice.append(option);
    }
    typingChoice.value = predictionMode();
    typingChoice.onchange = () => { try { changePredictionMode(typingChoice.value as PredictionMode); } catch (error) { typingChoice.value = predictionMode(); report(error); } };
    typingRow.append(glyph("keyboard", 18), typingLines, menuPicker(typingChoice));
    const latencyRow = row("Typing latency", "gauge.with.needle", () => choose("typingLatency"));
    latencyRow.setAttribute("aria-current", selected === "typingLatency" ? "page" : "false");
    const appUpdatesRow = row("App updates", "arrow.down.circle", () => choose("appUpdates"), "", appUpdateValue);
    appUpdatesRow.id = "settings-app-updates";
    appUpdatesRow.setAttribute("aria-current", selected === "appUpdates" ? "page" : "false");
    const footer = el("div", "settings-version");
    footer.append(el("span", "", `herdrup ${version}`), el("span", "settings-version-stance", "dark only, on purpose"));
    suggestionsKey = ""; renderSuggestions();
    index.replaceChildren(card, suggestions, group("YOUR HERD", [accountRow, sharedRow, notificationRow]), group("PREFERENCES", [sizing, typingRow, chatPreferenceRow]), group("HELP", [
      latencyRow,
      link("Report a bug or request a feature", "exclamationmark.bubble", "https://github.com/themartianapp/herdrup/issues"),
    ]), group("ABOUT", [
      link("Join the Discord", discordGlyph(), "https://discord.gg/pq7qj4dDqt"),
      link("Privacy Policy", "lock.shield", "https://herdrup.app/legal/privacy"),
      link("Terms of Service", "doc.text", "https://herdrup.app/legal/terms"),
      link("Open source on GitHub", "chevron.left.forwardslash.chevron.right", "https://github.com/themartianapp/herdrup"),
      ...(appUpdatesShown ? [appUpdatesRow] : []),
      usageCount.root,
    ]), footer);
    updateConnection();
  }
  function updateConnection() {
    updates.setHost(name());
    for (const node of machineNameNodes) node.textContent = name();
    const connected = state?.phase === "connected";
    for (const node of connectionNodes) {
      const status = connected ? "Connected" : "Disconnected";
      if (node.classList.contains("settings-machine-card-status")) {
        node.textContent = `${status} · ${plural(board?.board.total ?? 0, "agent")}`;
        node.closest(".settings-machine-card")?.setAttribute("aria-label", `Machines, ${name()}, ${node.textContent}`);
      } else {
        const dot = el("span", "settings-status-dot"); dot.dataset.state = connected ? "reachable" : "offline";
        node.replaceChildren(dot, document.createTextNode(status));
      }
    }
    if (reconnectButton) {
      const refused = state?.phase === "error" && state.message.includes("refusing to connect");
      reconnectButton.disabled = state?.phase === "connecting" || refused;
      if (reconnectNote) reconnectNote.hidden = !refused;
    }
    if (reach) {
      const offline = peers.filter(peer => peer.reachability === "offline").length;
      const text = offline ? `${offline} offline` : peers.some(peer => peer.reachability === "degraded") ? "some slow" : "all reachable";
      reach.textContent = `${plural(peers.length + 1, "machine")} · ${plural(board?.board.total ?? 0, "agent")} · ${text}`;
    }
  }
  function renderPage() {
    clearInterval(latencyTimer);
    reconnectButton = null; reconnectNote = null; reach = null;
    machineNameNodes = machineNameNodes.filter(node => index.contains(node));
    connectionNodes = connectionNodes.filter(node => index.contains(node));
    versionNodes = versionNodes.filter(node => index.contains(node));
    showSubtitle();
    title.textContent = selected === "machines" ? "Machines" : selected === "accounts" ? "Accounts" : selected === "sharedAccess" ? "Shared access" : selected === "notifications" ? "Notifications" : selected === "typingLatency" ? "Typing latency" : selected === "appUpdates" ? "App updates" : "Text size";
    body.replaceChildren();
    if (selected === "accounts") { body.append(accounts.root); return; }
    if (selected === "sharedAccess") { body.append(guests.root); return; }
    if (selected === "notifications") { body.append(notifications.root); void notifications.refresh(); return; }
    if (selected === "appUpdates") { body.append(appUpdates.root); return; }
    if (selected === "typingLatency") {
      const results = el("div");
      const instruction = el("p", "settings-latency-hint", "Type normally in a terminal, then come back here.");
      const explanation = el("p", "settings-latency-hint", "Screen time ends when xterm renders; prediction time ends when the overlay draws. Output after a send is attributed as its echo.");
      const refreshLatency = () => {
        const reports = typingLatency.snapshot();
        results.replaceChildren(...reports.map(item => {
          const block = el("div", "settings-latency-report");
          block.append(...latencyLines(item).map(line => el("p", "", line)));
          return group(item.host.toUpperCase(), [block]);
        }));
        if (!reports.length) results.append(group("", [el("p", "settings-latency-report", "No typing measured yet.")]));
      };
      const copy = button("Copy report", () => {
        const reportText = typingLatency.snapshot().map(item => [item.host, ...latencyLines(item)].join("\n")).join("\n\n");
        void Desk.gramCopyText(`herdrup typing latency — xterm render / overlay draw\n${reportText || "No typing measured yet."}`).then(() => { copy.textContent = "Copied"; }).catch(report);
      }); copy.className = "settings-plain-row action";
      const reset = button("Reset", () => { typingLatency.reset(); copy.textContent = "Copy report"; refreshLatency(); }); reset.className = "settings-plain-row action";
      body.append(instruction, results, group("REPORT", [copy, reset]), explanation);
      refreshLatency(); if (visible) latencyTimer = window.setInterval(refreshLatency, 1000);
      return;
    }
    if (selected === "textSize") {
      for (const size of [
        { key:"app", title:"App text — lists, menus & settings", sample:"The quick brown fox", value:uiFontScale(), label:`${Math.round(uiFontScale() * 100)}%`, min:0.9, max:1.4, default:1, step:0.1, change:changeUIFontScale },
        { key:"terminal", title:"Terminal text — agent output", sample:"~ $ herdr", value:textSize("terminal"), label:`${textSize("terminal")} pt`, min:9, max:24, default:12.5, step:1, change:(delta: number | "reset") => changeTextSize("terminal", delta) },
      ]) {
        const preview = el("div", "settings-size-preview"), text = el("span", `settings-${size.key}-preview`, size.sample);
        if (size.key === "terminal") text.style.fontSize = `${size.value}px`;
        preview.append(text, el("span", "", size.label));
        const controls = el("div", "settings-size-controls");
        for (const [label, delta] of [["A−", -size.step], ["Reset", "reset"], ["A+", size.step]] as const) {
          const control = button(label, () => { try { size.change(delta); } catch (error) { report(error); } });
          control.dataset.textControl = `${size.key}-${label}`;
          control.disabled = delta === "reset" ? size.value === size.default : delta < 0 ? size.value <= size.min : size.value >= size.max;
          controls.append(control);
        }
        body.append(group(size.title, [preview, controls]));
      }
      return;
    }
    const hero = el("div", "settings-machine-hero"), label = el("h2", "settings-machine-hero-name", name());
    machineNameNodes.push(label); const connection = el("p", "settings-machine-connection"); connectionNodes.push(connection);
    hero.append(disc(88, name()), label, connection, versionLine());
    reconnectButton = button("Reconnect now", () => { void reconnect().catch(report); }); reconnectButton.className = "settings-plain-row action";
    reconnectNote = el("span", "settings-action-note", "verify the host key first");
    reconnectNote.hidden = true; reconnectButton.append(reconnectNote);
    const copy = button("Copy diagnostics", () => {
      void Desk.gramCopyText(`herdrup-desktop ${version}, host ${name()}`).then(() => {
        copy.textContent = "Copied"; window.setTimeout(() => { copy.textContent = "Copy diagnostics"; }, 2000);
      }).catch(report);
    }); copy.className = "settings-plain-row action";
    body.append(hero, updates.root, group("CONNECTION", [reconnectButton, copy]), federation());
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
      item.append(identityTile(saved.displayLabel), lines);
      if (saved.peer) item.append(peerBadge(saved.peer));
      item.append(change); rows.push(item);
    }
    for (const peer of peers.filter(peer => !statuses.some(saved => saved.profileID === peer.alias))) {
      const item = el("div", "settings-federation-row"), lines = el("div", "settings-row-lines");
      lines.append(el("strong", "", peer.label || peer.alias), el("span", "settings-row-subtitle", plural(peer.agentCount, "agent")));
      item.append(identityTile(peer.alias), lines, peerBadge(peer)); rows.push(item);
    }
    if (!rows.length) {
      const empty = el("div", "settings-federation-empty");
      empty.append(el("p", "", "No saved machines yet."), el("p", "settings-row-subtitle", "Save an SSH machine on your home box, then opt it into federation here.")); rows.push(empty);
    }
    if (federationError) rows.push(el("p", "settings-inline-error", federationError));
    rows.push(row("How to add a machine", "plus.circle", showFederationGuide, "Connect another computer to your home box"));
    return group("FEDERATION", rows);
  }
  function peerBadge(peer: PeerSummary) {
    const badge = el("span", peer.reachability === "offline" ? "settings-peer-offline" : "settings-status-dot");
    badge.dataset.state = peer.reachability;
    badge.setAttribute("role", "img"); badge.setAttribute("aria-label", peer.reachability);
    if (peer.reachability === "offline") badge.append(glyph("wifi.slash", 11, "bold"));
    return badge;
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
    modal.append(el("pre", "", federationAddCommand), button("Copy command", () => { void Desk.gramCopyText(federationAddCommand).catch(report); }));
    modal.append(agentGuideFooter(federationAgentPrompt, glyph, report, () => modal.close())); modal.showModal();
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
    guests.setMachines(name(), statuses, peers);
    renderIndex(); renderPage();
  }
  events.machineStatusChanged.on(next => {
    if (!visible) return;
    statuses = next; federationError = ""; guests.setMachines(name(), statuses, peers);
    if (selected === "machines") renderPage();
  });
  let peerRead = 0;
  events.boardChanged.on(() => {
    if (!visible || state?.phase !== "connected") return;
    const at = generation, request = ++peerRead;
    void Desk.peers().then(next => {
      if (at !== generation || request !== peerRead || JSON.stringify(next) === JSON.stringify(peers)) return;
      peers = next;
      statuses = statuses.map(saved => ({ ...saved, peer: peers.find(peer => peer.alias === saved.profileID) ?? null }));
      guests.setMachines(name(), statuses, peers);
      if (selected === "machines") renderPage();
    }).catch(error => { if (at === generation) report(error); });
  });
  onTextSizeChanged(() => {
    if (!visible) return;
    const focused = (document.activeElement as HTMLElement | null)?.dataset.textControl;
    renderIndex(); renderPage();
    if (focused) body.querySelector<HTMLButtonElement>(`[data-text-control="${focused}"]`)?.focus();
  });
  renderIndex(); renderPage();
  return {
    /** Shows one page of Settings (the update notification's and the tray's App updates). */
    openPage(next: Page) { choose(next); },
    show(show: boolean, nextState: ConnState, nextBoard: BoardUpdate | null) {
      const nextID = `${nextBoard?.machineID ?? ""}\0${nextBoard?.session ?? ""}`;
      const reload = show && (!visible || identity !== nextID || state?.phase !== nextState.phase);
      state = nextState; board = nextBoard; identity = nextID; visible = show; index.hidden = !show; page.hidden = !show;
      if (!show) { generation++; busy = ""; openDialog?.close(); closeScope(); clearInterval(latencyTimer); }
      updateConnection();
      if (reload) { openDialog?.close(); message.hidden = true; machine = null; statuses = []; peers = []; renderIndex(); renderPage(); void refresh(); void usageCount.refresh(); void notifications.refresh(); }
    },
  };
}
