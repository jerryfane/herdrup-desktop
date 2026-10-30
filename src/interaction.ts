import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import "./interaction.css";
import { Desk, events } from "./mygo";
import type { AgentTarget, AgentView, BoardUpdate, GramAttachment } from "./mygo";
import { closeWriter, ComposerEditor, composerGlyph, SavedPromptsMenu, composerAttachment, composerFileDrop, composerClipboardPaste } from "./composer";
import { ConversationColumn } from "./conversationColumn";
import { ComposerDictation } from "./dictation";
import { markdown, readableMarkdown } from "./chatMarkdown";
import { bytes, currentPlan, groupTranscript, mergeTranscript, planDone, planWindow, remainingDraft, TerminalSequence } from "./interactionModel";
import type { ByteFrame, Entry, PlanItem, TranscriptPage, WorkRow } from "./interactionModel";
import { HISTORY_ROWS, prependTerminalHistory } from "./terminalHistory";
import { changeTextSize, onTextSizeChanged, textSize, type TextSurface } from "./textSize";
import { defaultChatMode } from "./chatPreference";
import envelopeIcon from "../third_party/phosphor/web/envelope.svg?url";
import lightbulbIcon from "../third_party/phosphor/web/lightbulb.svg?url";
import bellIcon from "../third_party/phosphor/web/bell.svg?url";
import arrowDownIcon from "../third_party/phosphor/web/arrow-down.svg?url";

const noteStyles: Record<string, { label: string; symbol: string; icon?: string }> = {
 gitmoot: { label: "Gitmoot", symbol: "envelope", icon: envelopeIcon },
 async_result: { label: "Async result", symbol: "tray.and.arrow.down" },
 advisor: { label: "Advisor", symbol: "lightbulb", icon: lightbulbIcon },
 other: { label: "Agent", symbol: "bell", icon: bellIcon },
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) {
 const node = document.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node;
}
function button(text: string, action: () => void) {
 const b = el("button", "", text); b.type = "button"; b.onclick = action; return b;
}
let root: HTMLElement;
let symbol: (name: string, size: number, weight: string) => Promise<HTMLElement>;
const modeChoices = new Map<string, "chat" | "terminal">();
let current: Detail | null = null;
let opening: Promise<void> = Promise.resolve();
export function initInteraction(detail: HTMLElement, renderSymbol: typeof symbol) {
 symbol = renderSymbol;
 root = el("section", "agent-detail"); root.hidden = true; detail.append(root);
 events.terminalChanged.on(e => { if (current?.view?.token === e.token) current.frame(e); });
 events.paneAttachments.on(event => {
  if (current?.token !== event.token || current.disposed) return;
  current.attachments = event.files; current.renderAttachments();
  if (event.note) current.status.textContent = event.note;
 });
 events.chatMenu.on(event => { void current?.chooseMessageAction(event.id, event.item); });
 onTextSizeChanged(() => current?.resizeText());
 window.addEventListener("keydown", event => {
  if (!current || root.hidden) return;
  if ((event.metaKey || event.ctrlKey) && !event.altKey && ["=", "+", "-", "0"].includes(event.key)) {
   event.preventDefault(); event.stopPropagation();
   current.changeTextSize("terminal", event.key === "0" ? "reset" : event.key === "-" ? -1 : 1);
   return;
  }
  if (event.key.toLowerCase() === "f" && (event.metaKey || event.ctrlKey) && !event.altKey) { event.preventDefault(); event.stopPropagation(); current.toggleFind(true); }
  if (event.key === "Escape" && current.findOpen) { event.preventDefault(); event.stopPropagation(); current.toggleFind(false); }
 }, true);
}
export function interactionVisible() { return current !== null; }
export function showInteraction(show: boolean) { if (root) root.hidden = !show || !current; if (!show) { current?.dictation.stop(); current?.dismissChatSheets(); } }
export function closeInteraction() {
 current?.dispose(); current = null;
 if (root) { root.replaceChildren(); root.hidden = true; }
}
export function interactionBoard(board: BoardUpdate | null) {
 if (current && (!board || board.machineID !== current.target.machineID || (board.session === "default" ? "" : board.session) !== current.target.session)) closeInteraction();
 if (current?.view && board) {
  for (const section of board.board.sections) {
   const row = section.rows.find(row => row.id === current!.target.paneID);
   if (row) current.updateStatus(section.key, section.label, row.statusSinceUnixMs);
  }
 }
}
export async function selectInteraction(target: AgentTarget) {
 if (current && JSON.stringify(current.target) === JSON.stringify(target)) { root.hidden = false; return; }
 closeInteraction();
 const next = new Detail(target); current = next; root.hidden = false;
 opening = opening.then(async () => { if (!next.disposed) await next.open(); });
 await opening;
}
class Detail {
 readonly token = crypto.randomUUID();
 view: AgentView | null = null;
 disposed = false;
 mode: "chat" | "terminal" = "terminal";
 generation = 0;
 title = el("strong");
 titleBlock = el("div", "pane-title-block");
 stateLine = el("div", "pane-state");
 stateAge = el("span", "pane-state-age");
 statusTimer: number | undefined;
 findBar = el("div", "pane-find");
 findInput = el("input");
 findCount = el("span", "pane-find-count");
 findOpen = false;
 findIndex = 0;
 findMatches: HTMLElement[][] = [];
 actions = el("div", "pane-actions");
 outsideActions = (event: PointerEvent) => { if (!(event.target instanceof Node) || !this.actions.contains(event.target)) this.actions.hidden = true; };
 status = el("div", "interaction-status");
 body = el("div", "interaction-body");
 column = new ConversationColumn(this.body, () => this.input.dispatchEvent(new Event("input")));
 terminalSurface = el("div", "terminal-surface");
 keyRow = el("div", "terminal-key-row");
 ctrlArmed = false;
 ctrlButton = button("Ctrl", () => this.setCtrl(!this.ctrlArmed));
 chatSurface = el("div", "chat-surface");
 mounted = false;
 terminalStartup: Promise<void> | null = null;
 chatButton = button("Chat", () => { void this.chooseMode("chat"); });
 terminalButton = button("Terminal", () => { void this.chooseMode("terminal"); });
 terminal: Terminal | null = null;
 fit: FitAddon | null = null;
 search: SearchAddon | null = null;
 resize: ResizeObserver | null = null;
 resizeTimer: number | undefined;
 fitTerminal: (() => void) | null = null;
 refreshTimer: number | undefined;
 inputQueue: Promise<void> = Promise.resolve();
 inputFailed = false;
 terminalReady = false;
 sequence = new TerminalSequence();
 historyCursor: string | null = null;
 historyRequest = 0;
 historyLoading = false;
 historyArmed = false;
 historyRetryAt = 0;
 historyTimer: number | undefined;
 historyButton = button("Load earlier output", () => {
  this.historyArmed = true; this.historyRetryAt = 0; void this.olderTerminal();
 });
 terminalID = "";
 chat: TranscriptPage | null = null;
 oldestCursor: string | undefined;
 chatEpoch = 0;
 answering = false;
 answerProblem: { askID: string; message: string; offersTerminal: boolean } | null = null;
 localAnswers = new Map<string, string[]>();
 entries: Entry[] = [];
 transcript = el("div", "chat-transcript");
 chatScroll = el("div", "chat-scroll");
 chatFollowing = true;
 chatResize: ResizeObserver | null = null;
 chatJump = button("", () => { this.chatFollowing = true; this.followChat(); });
 subagentSheet: HTMLDialogElement | null = null;
 questionSheet: HTMLDialogElement | null = null;
 noteSheet: HTMLDialogElement | null = null;
 selectionSheet: HTMLDialogElement | null = null;
 messageMenu: { id: string; text: string; markdown: boolean } | null = null;
 refreshQuestion: (() => void) | null = null;
 earlier = button("Earlier messages", () => { void this.loadEarlier(this.generation); });
 input = el("textarea", "chat-input");
 editor: ComposerEditor | null = null;
 composerResize: ResizeObserver | null = null;
 stopFileDrop: (() => void) | null = null;
 stopClipboardPaste: (() => void) | null = null;
 send = button("Send", () => { void this.sendPrompt(); });
 prompts = new SavedPromptsMenu(text => {
  if (this.disposed || this.sending || this.dictation.busy) return;
  this.input.value = text; this.input.dispatchEvent(new Event("input")); void this.sendPrompt();
 }, error => { this.status.textContent = String(error); });
 sending = false;
 attachments: GramAttachment[] = [];
 attachmentStrip = el("div", "gstrip pane-attachments");
 picking = false;
 attach = button("", () => { void this.pickFiles(); });
 dictation = new ComposerDictation(this.input, () => {
  const busy = this.dictation?.busy ?? false;
  this.send.disabled = this.sending || busy; this.prompts.button.disabled = this.sending || busy;
  this.input.dispatchEvent(new Event("input"));
 }, () => { this.setCtrl(false); this.editor?.collapse(); });
 draftKey: string;
 constructor(readonly target: AgentTarget) {
  this.draftKey = "herdrup.prompt." + JSON.stringify(target);
  this.input.rows = 1; this.input.placeholder = "Type a reply…"; this.input.autocapitalize = "off"; this.input.spellcheck = false;
  try { this.input.value = localStorage.getItem(this.draftKey) ?? ""; } catch { /* storage unavailable; keep in memory */ }
  this.input.addEventListener("beforeinput", event => {
   if (!this.ctrlArmed || !event.data || event.isComposing) return;
   const code = this.controlByte(event.data);
   if (code === null) return;
   event.preventDefault(); this.setCtrl(false); this.queueTerminalInput(code);
  });
  this.input.addEventListener("input", () => this.saveDraft());
  this.input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void this.sendPrompt(); } });
 }
 saveDraft() {
  try { if (this.input.value) localStorage.setItem(this.draftKey, this.input.value); else localStorage.removeItem(this.draftKey); }
  catch { this.status.textContent = "Draft is kept in this window only: local storage is unavailable."; }
 }
 setCtrl(armed: boolean) {
  this.ctrlArmed = armed; this.ctrlButton.setAttribute("aria-pressed", String(armed));
 }
 controlByte(text: string): string | null {
  if (text.length !== 1) return null;
  const code = text.toUpperCase().charCodeAt(0);
  return text === " " ? "\0" : text === "?" ? "\x7f" : code >= 64 && code <= 95 ? String.fromCharCode(code & 31) : null;
 }
 queueTerminalInput(text: string) {
  if (!this.terminalReady || this.inputFailed || this.disposed) return;
  const generation = this.generation, streamID = this.terminalID;
  this.inputQueue = this.inputQueue.then(async () => {
   if (this.disposed || generation !== this.generation || streamID !== this.terminalID || this.inputFailed) return;
   try { await Desk.terminalInput(this.token, streamID, text); }
   catch(e) { if (streamID === this.terminalID && !this.disposed) { this.inputFailed = true; this.status.textContent = String(e) + " Reconnect before typing again."; } }
  });
 }
 mountKeys() {
  const scroll = el("div", "terminal-key-scroll");
  const cap = (label: string, sequence: string, glyph?: string) => {
   const key = button(glyph ? "" : label, () => { this.setCtrl(false); if (!this.sending) this.queueTerminalInput(sequence); });
   key.setAttribute("aria-label", label);
   if (glyph) key.append(composerGlyph(glyph, 14));
   key.onpointerdown = event => event.preventDefault();
   return key;
  };
  const group = (...keys: HTMLElement[]) => { const row = el("div", "terminal-key-group"); row.append(...keys); return row; };
  const space = cap("space", " "); space.className = "terminal-space-key";
  const latest = button("", () => {
   if (this.terminal?.modes.mouseTrackingMode === "none") this.terminal.scrollToBottom();
   else this.queueTerminalInput("\x1b[1;5F");
  });
  latest.setAttribute("aria-label", "Jump to latest output"); latest.append(composerGlyph("key-latest", 14));
  this.ctrlButton.onpointerdown = event => event.preventDefault(); this.setCtrl(false);
  scroll.append(cap("esc", "\x1b"), space,
   group(cap("Left", "\x1b[D", "key-left"), cap("Up", "\x1b[A", "key-up"), cap("Down", "\x1b[B", "key-down"), cap("Right", "\x1b[C", "key-right")),
   group(cap("end", "\x1b[F"), cap("Jump to top", "\x1b[1;5H", "key-top"), latest),
   group(cap("tab", "\t"), cap("S-Tab", "\x1b[Z")),
   group(this.ctrlButton, cap("^P", "\x10"), cap("^C", "\x03")));
  const enter = cap("Enter", "\r", "key-enter"); enter.className = "terminal-enter-key";
  this.keyRow.append(scroll, enter); this.body.append(this.keyRow);
 }
 async open() {
  this.attach.setAttribute("aria-label", "Attach file");
  this.attach.append(await symbol("paperclip", 18, "regular"));
  const bar = el("header", "interaction-toolbar");
  const back = button("", () => { closeInteraction(); document.getElementById("select")!.hidden = false; });
  back.className = "pane-back"; back.setAttribute("aria-label", "Back");
  back.append(await symbol("chevron.left", 16, "semibold"));
  const capsule = el("div", "pane-header-capsule");
  const refresh = button("", () => {
   if (this.mode === "terminal") void this.reconnectTerminal();
   else { clearTimeout(this.refreshTimer); void this.refreshChat(this.generation); }
  });
  refresh.setAttribute("aria-label", "Refresh");
  refresh.append(await symbol("arrow.clockwise", 15, "medium"));
  const find = button("", () => this.toggleFind());
  find.setAttribute("aria-label", "Find");
  find.append(await symbol("magnifyingglass", 15, "medium"));
  const more = button("", () => { this.actions.hidden = !this.actions.hidden; });
  more.setAttribute("aria-label", "Agent actions");
  more.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><g fill="currentColor"><circle cx="4" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="16" cy="10" r="1.5"/></g></svg>';
  more.onpointerdown = event => event.stopPropagation();
  capsule.append(find, refresh, more);
  this.actions.hidden = true;
  this.actions.setAttribute("role", "menu");
  for (const [label, recent] of [["Copy screen", false], ["Copy recent output", true]] as const) {
   this.actions.append(button(label, () => {
    this.actions.hidden = true;
    void Desk.readAgentText(this.token, recent).then(text => { if (!this.disposed) return Desk.gramCopyText(text); }).catch(error => { if (!this.disposed) this.status.textContent = String(error); });
   }));
  }
  this.actions.append(button("Copy selection", () => { this.actions.hidden = true; void Desk.gramCopyText(this.terminal?.getSelection() ?? ""); }));
  this.actions.append(el("div", "pane-action-heading", "Text size"));
  for (const [label, delta] of [["Increase", 1], ["Decrease", -1], ["Reset", "reset"]] as const) {
   this.actions.append(button(label, () => {
    this.actions.hidden = true;
    this.changeTextSize(this.mode, delta);
   }));
  }
  this.findInput.type = "search"; this.findInput.placeholder = "Find";
  this.findInput.oninput = () => this.updateFind(true);
  this.findInput.onkeydown = event => {
   if (event.key === "Escape") { event.preventDefault(); this.toggleFind(false); }
   if (event.key === "Enter") { event.preventDefault(); this.updateFind(false, event.shiftKey ? -1 : 1); }
  };
  const previous = button("", () => this.updateFind(false, -1)); previous.setAttribute("aria-label", "Previous match"); previous.append(await symbol("chevron.up", 12, "semibold"));
  const next = button("", () => this.updateFind(false, 1)); next.setAttribute("aria-label", "Next match"); next.append(await symbol("chevron.down", 12, "semibold"));
  this.findBar.append(this.findInput, this.findCount, previous, next); this.findBar.hidden = true;
  this.titleBlock.append(this.title, this.stateLine);
  bar.append(back, this.titleBlock, this.findBar, capsule, this.actions);
  const modes = el("div", "chat-terminal-switch");
  modes.append(this.chatButton, this.terminalButton);
  modes.hidden = true;
  if (this.disposed) return;
  document.addEventListener("pointerdown", this.outsideActions);
  root.replaceChildren(bar, modes, this.status, this.body);
  try {
   const view = await Desk.openAgentView(this.target, this.token);
   if (this.disposed) { await Desk.closeAgentView(this.token); return; }
   this.view = view; this.title.textContent = view.heading;
   this.updateStatus(view.group, view.status, view.statusSinceUnixMs);
   const chatAvailable = /^omp(?:$| |-)/i.test(view.harness);
   modes.hidden = !chatAvailable;
   await this.switchMode(chatAvailable ? (modeChoices.get(JSON.stringify(this.target)) ?? defaultChatMode()) : "terminal");
  } catch (e) { if (!this.disposed) this.status.textContent = String(e); }
 }
 changeTextSize(surface: TextSurface, delta: number | "reset") {
  try { changeTextSize(surface, delta); }
  catch (error) { this.status.textContent = String(error); }
 }
 resizeText() {
  if (this.terminal) this.terminal.options.fontSize = textSize("terminal");
  this.fitTerminal?.();
  this.followChat();
 }
 updateStatus(group: string, label: string, since?: number) {
  clearInterval(this.statusTimer);
  this.stateLine.dataset.group = group;
  this.stateLine.replaceChildren(el("span", "pane-state-dot"), el("span", "pane-state-label", label), this.stateAge);
  const updateAge = () => {
   if (since === undefined) { this.stateAge.textContent = ""; return; }
   const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
   this.stateAge.textContent = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`;
  };
  updateAge();
  if (since !== undefined) this.statusTimer = window.setInterval(updateAge, 1000);
 }
 toggleFind(open = !this.findOpen) {
  this.findOpen = open;
  this.findBar.hidden = !open; this.titleBlock.hidden = open;
  if (open) { this.findInput.focus(); this.updateFind(true); }
  else { this.findInput.value = ""; this.updateFind(true); if (this.mode === "terminal") this.terminal?.focus(); }
  this.updateChatJump();
 }
 updateFind(reset = false, step = 0) {
  const query = this.findInput.value;
  if (this.mode === "terminal") {
   if (!query) { this.search?.clearDecorations(); this.findCount.textContent = ""; return; }
   const styles = getComputedStyle(document.documentElement);
   const options = { decorations: { matchBackground: styles.getPropertyValue("--color-surface-raised").trim(), activeMatchBackground: styles.getPropertyValue("--color-text-dim").trim(), matchOverviewRuler: styles.getPropertyValue("--color-text-dim").trim(), activeMatchColorOverviewRuler: styles.getPropertyValue("--color-text").trim() } };
   if (step < 0) this.search?.findPrevious(query, options); else this.search?.findNext(query, options);
   return;
  }
  if (reset) {
   this.findIndex = 0;
   for (const mark of this.transcript.querySelectorAll("mark.pane-find-hit")) { const parent = mark.parentNode!; mark.replaceWith(document.createTextNode(mark.textContent ?? "")); parent.normalize(); }
   this.findMatches = [];
   if (query) {
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    for (const row of this.transcript.children) {
     const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
     const nodes: { node: Text; start: number; end: number }[] = [];
     let text = "", node: Node | null;
     while ((node = walker.nextNode())) { const start = text.length; text += node.textContent ?? ""; nodes.push({ node: node as Text, start, end: text.length }); }
     const hits = [...text.matchAll(pattern)].map(hit => ({ start: hit.index!, end: hit.index! + hit[0].length, marks: [] as HTMLElement[] }));
     for (const part of nodes) {
      const matches = hits.filter(hit => hit.start < part.end && hit.end > part.start);
      if (!matches.length) continue;
      const fragment = document.createDocumentFragment(); let at = 0;
      for (const hit of matches) {
       const start = Math.max(0, hit.start - part.start), end = Math.min(part.node.length, hit.end - part.start);
       fragment.append(document.createTextNode(part.node.data.slice(at, start)));
       const mark = el("mark", "pane-find-hit", part.node.data.slice(start, end)); fragment.append(mark); hit.marks.push(mark); at = end;
      }
      fragment.append(document.createTextNode(part.node.data.slice(at))); part.node.replaceWith(fragment);
     }
     this.findMatches.push(...hits.map(hit => hit.marks));
    }
   }
  }
  const count = this.findMatches.length;
  if (count) this.findIndex = (this.findIndex + step + count) % count;
  this.findMatches.forEach((marks, index) => marks.forEach(mark => mark.classList.toggle("current", index === this.findIndex)));
  this.findCount.textContent = query ? count ? `${this.findIndex + 1} of ${count}` : "No matches" : "";
  const match = this.findMatches[this.findIndex]?.[0];
  if (match && this.findOpen) {
   for (let ancestor = match.parentElement; ancestor && ancestor !== this.transcript; ancestor = ancestor.parentElement) if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
   match.scrollIntoView({ block: "center" });
  }
 }
 chatAtBottom() { return this.chatScroll.scrollHeight - this.chatScroll.scrollTop - this.chatScroll.clientHeight < 80; }
 updateChatJump() { this.chatJump.hidden = !this.chat || this.findOpen || this.chatAtBottom(); }
 followChat() {
  if (this.chatFollowing && !this.findOpen && this.mode === "chat") this.chatScroll.scrollTop = this.chatScroll.scrollHeight;
  this.updateChatJump();
 }
 dismissChatSheets() {
  this.subagentSheet?.close(); this.questionSheet?.close(); this.noteSheet?.close(); this.selectionSheet?.close();
  this.messageMenu = null;
 }
 stopSurface() {
  closeWriter(); this.generation++;
  clearInterval(this.statusTimer);
  document.removeEventListener("pointerdown", this.outsideActions);
  this.dismissChatSheets();
  this.editor?.dispose(); this.editor = null;
  this.stopFileDrop?.(); this.stopFileDrop = null;
  this.stopClipboardPaste?.(); this.stopClipboardPaste = null;
  this.chatResize?.disconnect(); this.chatResize = null;
  this.prompts.dispose();
  this.dictation.dispose();
  this.composerResize?.disconnect(); this.composerResize = null;
  this.column.dispose();
  clearTimeout(this.refreshTimer);
  clearTimeout(this.resizeTimer);
  clearTimeout(this.historyTimer); this.historyRequest++;
  this.resize?.disconnect(); this.resize = null;
  this.fitTerminal = null;
  this.terminalReady = false;
  this.terminal?.dispose(); this.terminal = null; this.fit = null;
 }
 dispose() { this.disposed = true; this.stopSurface(); this.saveDraft(); void Desk.closeAgentView(this.token); }
 async chooseMode(mode: "chat" | "terminal") {
  modeChoices.set(JSON.stringify(this.target), mode);
  await this.switchMode(mode);
 }
 async switchMode(mode: "chat" | "terminal") {
  const generation = this.generation;
  this.mode = mode; this.status.textContent = "";
  if (mode === "terminal") this.dismissChatSheets();
  this.body.dataset.mode = mode;
  this.setCtrl(false);
  this.column.setVisible(mode === "chat");
  this.chatButton.setAttribute("aria-pressed", String(mode === "chat"));
  this.terminalButton.setAttribute("aria-pressed", String(mode === "terminal"));
  this.chatSurface.hidden = mode !== "chat";
  this.terminalSurface.inert = mode === "chat";
  this.terminalSurface.setAttribute("aria-hidden", String(mode === "chat"));
  this.terminalSurface.classList.toggle("covered", mode === "chat");
  clearTimeout(this.refreshTimer);
  if (!this.mounted) {
   this.mounted = true;
   this.body.append(this.terminalSurface, this.chatSurface, ...this.column.handles, this.column.readout);
   this.openChat(generation);
   this.terminalStartup = this.openTerminal(generation);
   await this.terminalStartup;
  } else if (mode === "chat") {
   void this.refreshChat(generation);
  } else {
   this.terminal?.focus();
  }
  this.input.dispatchEvent(new Event("input"));
 }
 async reconnectTerminal() {
  if (this.terminalStartup) await this.terminalStartup;
  if (this.disposed) return;
  this.terminalReady = false;
  clearTimeout(this.resizeTimer);
  clearTimeout(this.historyTimer); this.historyRequest++;
  this.resize?.disconnect(); this.resize = null;
  this.fitTerminal = null;
  this.terminal?.dispose(); this.terminal = null;
  await Desk.stopTerminal(this.token, this.terminalID);
  if (this.disposed) return;
  this.terminalSurface.replaceChildren();
  this.terminalStartup = this.openTerminal(this.generation);
  await this.terminalStartup;
 }
 async openTerminal(generation: number) {
  const streamID = crypto.randomUUID(); this.terminalID = streamID;
  const canvas = el("div", "terminal-canvas");
  this.historyCursor = null; this.historyRequest++; this.historyLoading = false; this.historyArmed = false;
  this.historyButton.className = "terminal-history-load"; this.historyButton.hidden = true;
  this.terminalSurface.append(canvas, this.historyButton);
  const styles = getComputedStyle(document.documentElement);
  // SearchAddon decorations require xterm's proposed decoration API.
  const term = new Terminal({ fontFamily: styles.getPropertyValue("--font-machine"), fontSize: textSize("terminal"), scrollback: HISTORY_ROWS, allowProposedApi: true, theme: { background: styles.getPropertyValue("--color-ground-machine").trim(), foreground: styles.getPropertyValue("--color-text").trim() } });
  this.terminal = term; this.fit = new FitAddon(); this.search = new SearchAddon(); this.sequence = new TerminalSequence(); this.inputFailed = false;
  term.options.linkHandler = { activate: (_event, uri) => { void Desk.openExternalURL(uri).catch(e => { this.status.textContent = String(e); }); } };
  term.loadAddon(this.fit); term.loadAddon(this.search);
  this.search.onDidChangeResults(result => {
   if (this.mode === "terminal" && this.findOpen) this.findCount.textContent = result.resultCount ? `${result.resultIndex + 1} of ${result.resultCount}` : "No matches";
  });
  term.loadAddon(new WebLinksAddon((_event, uri) => { void Desk.openExternalURL(uri).catch(e => { this.status.textContent = String(e); }); }));
  term.open(canvas);
  const armHistory = () => { this.historyArmed = true; this.updateHistoryPaging(true); };
  canvas.addEventListener("wheel", event => { if (event.deltaY < 0) armHistory(); }, { passive: true });
  canvas.addEventListener("touchmove", armHistory, { passive: true });
  canvas.addEventListener("pointerdown", event => {
   if (event.target instanceof Element && event.target.closest(".scrollbar")) armHistory();
  });
  term.onScroll(() => this.updateHistoryPaging(true));
  term.onWriteParsed(() => this.updateHistoryPaging());
  term.attachCustomKeyEventHandler(e => {
   if (e.defaultPrevented) return false;
   if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "c") { void Desk.gramCopyText(term.getSelection()); return false; }
   if (e.type === "keydown" && e.shiftKey && (e.key === "PageUp" || e.key === "Home")) armHistory();
   return true;
  });
  term.onData(text => {
   if (generation !== this.generation || streamID !== this.terminalID) return;
   if (this.ctrlArmed) { const code = this.controlByte(text); this.setCtrl(false); if (code !== null) text = code; }
   this.queueTerminalInput(text);
  });
  const fit = () => {
   if (this.disposed || generation !== this.generation || streamID !== this.terminalID || !this.terminalReady || !canvas.clientWidth) return;
   this.fit?.fit();
   this.updateHistoryPaging();
   void Desk.terminalSize(this.token, streamID, term.cols, term.rows).catch(e => { if (generation === this.generation && streamID === this.terminalID) this.status.textContent = "Resize: " + String(e); });
  };
  this.fitTerminal = fit;
  this.resize = new ResizeObserver(() => { clearTimeout(this.resizeTimer); this.resizeTimer = window.setTimeout(fit, 120); });
  this.resize.observe(canvas);
  try { await Desk.startTerminal(this.token, streamID); if (generation !== this.generation || streamID !== this.terminalID || this.disposed) return; this.terminalReady = true; fit(); if (this.mode === "terminal") term.focus(); }
  catch(e) { if (generation === this.generation && streamID === this.terminalID && !this.disposed) this.status.textContent = String(e); }
 }
 frame(event: { streamID: string; frame?: ByteFrame; error?: string }) {
  if (!this.terminal || event.streamID !== this.terminalID) return;
  if (event.error) { this.status.textContent = "Terminal disconnected: " + event.error; this.terminalReady = false; this.updateHistoryPaging(true); return; }
  const f = event.frame; if (!f) return;
  if (!this.sequence.accept(f)) { this.status.textContent = "Terminal stream changed. Reconnect to obtain a fresh screen."; this.terminalReady = false; this.updateHistoryPaging(true); return; }
  try {
   if (f.frame === "reset") {
    this.historyRequest++; this.historyLoading = false; this.historyArmed = false; this.historyRetryAt = 0;
    clearTimeout(this.historyTimer);
    this.terminal.reset();
    if (f.cols && f.rows) this.terminal.resize(f.cols, f.rows);
    if (f.history_b64) this.terminal.write(bytes(f.history_b64));
    this.terminal.write(bytes(f.data_b64)); this.historyCursor = f.history_cursor ?? null;
   } else if (f.frame === "data") this.terminal.write(bytes(f.data_b64));
   else if (f.frame === "resize" && f.cols && f.rows) this.terminal.resize(f.cols, f.rows);
   else if (f.frame === "exited") { this.status.textContent = "Pane exited."; this.terminalReady = false; }
  } catch(e) { this.status.textContent = "Invalid terminal frame: " + String(e); this.terminalReady = false; }
  this.updateHistoryPaging();
 }
 updateHistoryPaging(schedule = false) {
  const term = this.terminal;
  const nearTop = !!term && this.terminalReady && term.buffer.active.type === "normal" && term.buffer.active.viewportY < term.rows;
  this.historyButton.hidden = !this.historyCursor || !nearTop;
  this.historyButton.disabled = this.historyLoading;
  this.historyButton.textContent = this.historyLoading ? "Loading earlier output…" : "Load earlier output";
  if (!schedule) return;
  clearTimeout(this.historyTimer);
  if (nearTop && this.historyArmed && this.historyCursor && !this.historyLoading && this.mode === "terminal" && !this.disposed) {
   this.historyTimer = window.setTimeout(() => { void this.olderTerminal(); }, Math.max(300, this.historyRetryAt - Date.now()));
  }
 }
 async olderTerminal() {
  const term = this.terminal, cursor = this.historyCursor;
  if (!term || !this.terminalReady || !cursor || this.historyLoading || this.mode !== "terminal" || term.buffer.active.type !== "normal" || term.buffer.active.viewportY >= term.rows) return;
  const request = ++this.historyRequest, stream = this.terminalID;
  const current = () => !this.disposed && request === this.historyRequest && term === this.terminal && stream === this.terminalID && cursor === this.historyCursor;
  this.historyLoading = true; this.updateHistoryPaging();
  try {
   const result = await Desk.terminalHistory(this.token, cursor);
   if (!current()) return;
   if (result.unavailable) { this.historyCursor = null; this.status.textContent = `Earlier output: ${result.unavailable}`; return; }
   const page = result.page;
   if (!page) throw new Error("The history response contained no page.");
   const inserted = await prependTerminalHistory(term, bytes(page.history_b64), current);
   if (inserted === null) return;
   this.historyCursor = inserted === 0 && page.history_b64 ? null : page.cursor ?? null;
  } catch(error) {
   if (current()) { this.status.textContent = `Earlier output: ${String(error)}`; this.historyRetryAt = Date.now() + 2000; }
  } finally {
   if (request === this.historyRequest) { this.historyLoading = false; this.updateHistoryPaging(true); }
  }
 }
 renderAttachments() {
  this.attachmentStrip.hidden = this.attachments.length === 0;
  const failed = (error: unknown) => { if (!this.disposed) this.status.textContent = String(error); };
  this.attachmentStrip.replaceChildren(...this.attachments.map(file => composerAttachment(file, this.sending,
   () => { void Desk.paneRemoveAttachment(this.token, file.path).catch(failed); },
   () => { void Desk.paneRetryAttachment(this.token, file.path).catch(failed); })));
  this.input.dispatchEvent(new Event("input"));
 }
 async pickFiles(paths?: string[]) {
  if (this.disposed || this.sending || this.picking || !this.token) return;
  this.picking = true; this.attach.disabled = true;
  try { if (paths) await Desk.paneAttachFiles(this.token, paths); else await Desk.panePickFiles(this.token); }
  catch(error) { if (!this.disposed) this.status.textContent = String(error); }
  finally { this.picking = false; this.attach.disabled = this.sending; }
 }
 openChat(generation: number) {
  this.entries = []; this.chat = null; this.oldestCursor = undefined; this.chatEpoch++;
  this.answerProblem = null; this.localAnswers.clear();
  this.input.disabled = false; this.send.disabled = this.sending;
  const composer = el("div", "chat-composer");
  const actions = el("div", "composer-actions");
  actions.append(this.attach, this.dictation.button);
  this.send.replaceChildren(composerGlyph("send", 22)); this.send.setAttribute("aria-label", "Send reply");
  this.prompts.mount(actions); actions.append(this.send);
  this.attachmentStrip.hidden = true;
  composer.append(this.attachmentStrip, this.dictation.strip, this.input, actions);
  this.stopFileDrop = composerFileDrop(composer, paths => { void this.pickFiles(paths); });
  this.stopClipboardPaste = composerClipboardPaste(this.input, () => Desk.panePasteClipboard(this.token), error => {
   if (!this.disposed) this.status.textContent = String(error);
  });
  this.mountKeys();
  const probe = el("div", "composer-text-probe");
  composer.append(probe);
  const layout = () => {
   if (!this.editor || !composer.isConnected) return;
   const hasContent = this.input.value.trim().length > 0 || this.attachments.length > 0;
   this.send.hidden = !hasContent; this.prompts.button.hidden = hasContent;
   this.column.update();
   const width = composer.clientWidth - 26;
   const measure = (w: number) => {
    probe.style.width = `${Math.max(1, w)}px`;
    probe.textContent = this.input.value + (this.input.value.endsWith("\n") || !this.input.value ? " " : "");
    return Math.max(1, Math.round(probe.getBoundingClientRect().height / 24));
   };
   const stacked = this.editor!.open || this.attachments.length > 0 || (!this.dictation.strip.hidden && !!this.input.value) || measure(width - actions.offsetWidth) > 1;
   composer.classList.toggle("expanded", stacked);
   const lines = measure(stacked ? width : width - actions.offsetWidth);
   const room = Math.max(0, this.body.clientHeight - 68);
   this.input.style.height = `${this.editor!.update(lines, room)}px`;
   const composerHeight = composer.offsetHeight + 12;
   this.body.style.setProperty("--composer-height", `${composerHeight}px`);
   this.body.style.setProperty("--input-inset", `${composerHeight + (this.mode === "terminal" ? 50 : 0)}px`);
  };
  this.editor = new ComposerEditor(composer, this.input, layout);
  this.input.oninput = layout;
  this.composerResize = new ResizeObserver(layout);
  this.composerResize.observe(composer);
  this.composerResize.observe(this.body);
  this.composerResize.observe(this.chatSurface);
  this.chatFollowing = true;
  this.chatJump.className = "chat-jump-latest"; this.chatJump.hidden = true;
  this.chatJump.setAttribute("aria-label", "Jump to latest message"); this.chatJump.title = "Jump to latest message";
  if (navigator.platform.startsWith("Mac")) void symbol("arrow.down", 18, "medium").then(icon => this.chatJump.replaceChildren(icon));
  else {
   const icon = el("span", "chat-jump-glyph"); icon.style.setProperty("--jump-glyph", `url("${arrowDownIcon}")`);
   this.chatJump.replaceChildren(icon);
  }
  this.chatScroll.append(this.transcript); this.chatSurface.append(this.chatScroll, this.chatJump);
  this.chatScroll.onscroll = () => { this.chatFollowing = this.chatAtBottom(); this.updateChatJump(); };
  this.chatResize = new ResizeObserver(() => this.followChat());
  this.chatResize.observe(this.transcript); this.chatResize.observe(this.chatScroll);
  this.body.append(composer);
  if (this.mode === "chat") void this.refreshChat(generation);
 }
 async refreshChat(generation: number) {
  const epoch = this.chatEpoch;
  try {
   const page: TranscriptPage = JSON.parse(await Desk.chatTranscript(this.token, this.chat?.after ?? "", "", ""));
   if (this.disposed || generation !== this.generation || epoch !== this.chatEpoch) return;
   if (!this.chat || this.chat.session_id !== page.session_id) {
    this.entries = []; this.oldestCursor = page.before;
    this.answerProblem = null; this.localAnswers.clear();
   }
   this.entries = mergeTranscript(this.entries, page.entries ?? []); this.chat = page;
   for (const entry of this.entries) if (entry.kind === "ask" && entry.answer) this.localAnswers.delete(entry.id);
   this.drawChat();
  } catch(e) { if (!this.disposed && generation === this.generation) this.status.textContent = "Chat: " + String(e) + " You can switch to Terminal."; }
  finally { if (!this.disposed && this.mode === "chat" && generation === this.generation && epoch === this.chatEpoch) this.refreshTimer = window.setTimeout(() => { void this.refreshChat(generation); }, 1500); }
 }
 async loadEarlier(generation: number) {
  if (!this.chat || !this.oldestCursor) { this.status.textContent = "You are at the start of the retained conversation."; return; }
  const session = this.chat.session_id;
  const epoch = this.chatEpoch;
  try {
   const page: TranscriptPage = JSON.parse(await Desk.chatTranscript(this.token, "", this.oldestCursor!, ""));
   if (this.disposed || generation !== this.generation || epoch !== this.chatEpoch || page.session_id !== session || this.chat?.session_id !== session) return;
   const oldHeight = this.chatScroll.scrollHeight;
   this.chatFollowing = false;
   this.entries = mergeTranscript(this.entries, page.entries, true); this.oldestCursor = page.before;
   this.drawChat(false); this.chatScroll.scrollTop += this.chatScroll.scrollHeight - oldHeight;
  } catch(e) { this.status.textContent = String(e); }
 }
 drawChat(follow = true) {
  const opened = new Set([...this.transcript.querySelectorAll<HTMLDetailsElement>("details[open]")].map(d => d.dataset.id));
  const nodes = groupTranscript(this.entries, !!this.chat?.working).filter(row => row.kind !== "entry" || row.entry.kind !== "plan").map(row => {
   const old = this.transcript.querySelector<HTMLElement>(`[data-id="${CSS.escape(row.id)}"]`);
   const signature = JSON.stringify(row.kind === "entry" && row.entry.kind === "ask" ? [row, this.chat?.pending_ask, this.answering, this.answerProblem, this.localAnswers.get(row.entry.id)] : row);
   if (old?.dataset.signature === signature) return old;
   const node = row.kind === "work" ? this.renderWork(row) : row.entry.kind === "ask" ? this.renderQuestion(row.entry, this.chat?.pending_ask) : this.renderEntry(row.entry);
   node.dataset.id = row.id; node.dataset.signature = signature;
   for (const disclosure of node.querySelectorAll<HTMLDetailsElement>("details")) disclosure.open = opened.has(disclosure.dataset.id);
   if (node instanceof HTMLDetailsElement) node.open = opened.has(row.id);
   return node;
  });
  this.earlier.className = "chat-earlier"; this.earlier.hidden = !this.oldestCursor;
  nodes.unshift(this.earlier);
  const pending = this.chat?.pending_ask;
  if (pending && !this.entries.some(entry => entry.kind === "ask" && entry.id === pending.id)) {
   nodes.push(this.renderQuestion({ kind:"ask", id:pending.id, ts_ms:0, questions:pending.questions }, pending));
  }
  const plan = currentPlan(this.chat, this.entries);
  if (plan.length) nodes.push(this.renderPlan(plan));
  const agents = this.chat?.subagents ?? [];
  if (agents.length) nodes.push(this.renderSubagents(agents));
  this.transcript.replaceChildren(...nodes);
  if (follow) this.followChat();
  if (this.findOpen && this.mode === "chat") { const index = this.findIndex; this.updateFind(true, index); }
  this.refreshQuestion?.();
 }
 renderPlan(items: PlanItem[], container = this.transcript, session = this.chat?.session_id): HTMLElement {
  const card = el("section", "chat-plan chat-message");
  card.dataset.session = session ?? "";
  const previous = container.querySelector<HTMLElement>(".chat-plan");
  let open = previous?.dataset.session === card.dataset.session && previous?.dataset.open === "true";
  const done = items.filter(planDone).length;
  const draw = () => {
   card.dataset.open = String(open);
   const toggle = button("", () => { open = !open; draw(); });
   toggle.className = "chat-plan-heading";
   toggle.setAttribute("aria-expanded", String(open));
   toggle.setAttribute("aria-label", `To-do, ${done} of ${items.length} done`);
   toggle.append(el("span", "chat-plan-chevron", open ? "⌄" : "›"), el("span", "", `TODO · ${done} OF ${items.length}`));
   if (!open && done === items.length) toggle.append(el("span", "chat-plan-complete", "All done"));
   card.replaceChildren(toggle);
   const shown = open ? items.map((_, index) => index) : planWindow(items);
   shown.forEach((index, position) => {
    const item = items[index]!, completed = planDone(item);
    if (item.phase && (position === 0 || items[shown[position - 1]!]!.phase !== item.phase)) card.append(el("div", "chat-plan-phase", item.phase));
    const row = el("div", "chat-plan-row");
    row.dataset.state = completed ? "completed" : item.status ?? "unknown";
    row.setAttribute("aria-label", `${item.text}: ${completed ? "Done" : item.status === "in_progress" ? "In progress" : item.status === "blocked" ? "Blocked" : "Pending"}`);
    const marker = el("span", "chat-plan-marker", completed ? "✓" : item.status === "in_progress" ? "➜" : item.status === "blocked" ? "Ⅱ" : "○");
    marker.setAttribute("aria-hidden", "true");
    row.append(marker, el("span", "chat-plan-text", item.text)); card.append(row);
   });
   if (items.length > shown.length && done !== items.length) {
    const more = button(`+${items.length - shown.length} more`, () => { open = true; draw(); });
    more.className = "chat-plan-more"; card.append(more);
   }
  };
  draw(); return card;
 }
 renderSubagents(agents: NonNullable<TranscriptPage["subagents"]>): HTMLElement {
  const running = agents.filter(agent => agent.status === "running");
  const finished = agents.filter(agent => agent.status !== "running");
  const previous = this.transcript.querySelector<HTMLDetailsElement>(".chat-subagents");
  const card = el("details", "chat-subagents"); card.open = previous?.open ?? true;
  card.append(el("summary", "", `SUBAGENTS · ${running.length ? `${running.length} RUNNING` : `${finished.length} FINISHED`}`));
  const row = (agent: typeof agents[number]) => {
   const item = button("", () => this.openSubagent(agent.id)); item.className = "chat-subagent-row"; item.disabled = !agent.has_transcript;
   item.append(el("strong", "", agent.id), el("span", "", agent.label ?? agent.task ?? ""), el("small", "", agent.status ?? ""));
   return item;
  };
  card.append(...running.map(row));
  if (finished.length) {
   const folded = el("details"); folded.open = previous?.querySelector("details")?.open ?? false;
   folded.append(el("summary", "", `${finished.length} finished`), ...finished.map(row)); card.append(folded);
  }
  return card;
 }
 openSubagent(id: string) {
  this.subagentSheet?.close();
  const dialog = el("dialog", "subagent-sheet");
  this.subagentSheet = dialog;
  const header = el("header"); header.append(el("strong", "", id), button("Done", () => dialog.close()));
  const messages = el("div", "chat-transcript"), notice = el("p", "interaction-status");
  const earlier = button("Earlier messages", () => { void load(true); }); earlier.className = "chat-earlier"; earlier.hidden = true;
  dialog.append(header, notice, messages); document.body.append(dialog);
  let open = true, busy = false, page: TranscriptPage | null = null, entries: Entry[] = [], before: string | undefined, timer: number | undefined;
  const load = async (older: boolean) => {
   if (busy || !open || this.disposed || (older && !before)) return;
   busy = true; earlier.disabled = true; clearTimeout(timer);
   const session = page?.session_id;
   try {
    const next: TranscriptPage = JSON.parse(await Desk.chatTranscript(this.token, older ? "" : page?.after ?? "", older ? before! : "", id));
    if (!open || this.disposed || (older && (next.session_id !== session || page?.session_id !== session))) return;
    const follow = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80, height = messages.scrollHeight;
    if (page?.session_id !== next.session_id) { entries = []; before = next.before; }
    entries = mergeTranscript(entries, next.entries, older);
    if (older) before = next.before; else page = next;
    const expanded = new Set([...messages.querySelectorAll<HTMLDetailsElement>("details[open]")].map(node => node.dataset.id));
    const nodes = groupTranscript(entries, !!page?.working).filter(row => row.kind !== "entry" || row.entry.kind !== "plan").map(row => {
     const node = row.kind === "work" ? this.renderWork(row) : this.renderEntry(row.entry);
     node.dataset.id = row.id;
     if (node instanceof HTMLDetailsElement) node.open = expanded.has(row.id);
     node.querySelectorAll<HTMLDetailsElement>("details").forEach(detail => { detail.open = expanded.has(detail.dataset.id); });
     return node;
    });
    const plan = currentPlan(page, entries);
    if (plan.length) nodes.push(this.renderPlan(plan, messages, page?.session_id));
    earlier.hidden = !before;
    messages.replaceChildren(earlier, ...nodes);
    if (older) messages.scrollTop += messages.scrollHeight - height;
    else if (follow) messages.scrollTop = messages.scrollHeight;
    notice.textContent = "";
   } catch(error) { if (open) notice.textContent = String(error); }
   finally { busy = false; earlier.disabled = false; if (open && !this.disposed) timer = window.setTimeout(() => { void load(false); }, 1500); }
  };
  dialog.addEventListener("close", () => { open = false; clearTimeout(timer); dialog.remove(); if (this.subagentSheet === dialog) this.subagentSheet = null; }, { once: true });
  dialog.showModal(); void load(false);
 }
 renderWork(work: WorkRow): HTMLElement {
  const group = el("section", "chat-work");
  const thought = work.thoughts.at(-1);
  if (thought) {
   const details = el("details", "chat-thought"); details.dataset.id = `t:${work.id}`;
   const summary = el("summary");
   const line = thought.split(/\r?\n/)[0] ?? thought, end = line.indexOf(". ");
   summary.append(el("strong", "", "Thought"), el("span", "thought-preview", end < 0 ? line : line.slice(0, end + 1)));
   const text = work.thoughts.join("\n\n"), content = markdown(text);
   this.bindMessageMenu(content, text, true);
   details.append(summary, content); group.append(details);
  }
  if (work.steps.length) {
   const details = el("details", "chat-work-steps"); details.dataset.id = `s:${work.id}`;
   const seconds = Math.max(0, Math.floor((work.endMs - work.startMs) / 1000));
   const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60), rest = minutes % 60;
   const duration = seconds < 60 ? `${Math.max(seconds, 1)} s` : minutes < 60 ? `${minutes} min` : rest ? `${hours} h ${rest} min` : `${hours} h`;
   const summary = el("summary");
   summary.append(el("span", "", work.live ? "Working" : `Worked for ${duration}`), el("span", "work-count", ` · ${work.steps.length} step${work.steps.length === 1 ? "" : "s"}`));
   const list = el("div", "chat-work-list");
   for (const step of work.steps) {
    const detail = el("details", "chat-tool"); detail.dataset.id = step.id;
    const title = el("summary");
    title.append(el("span", `tool-dot ${step.status ?? ""}`), el("code", "", step.tool ?? ""), el("span", "", step.intent ?? ""));
    detail.append(title);
    if (step.detail) detail.append(el("pre", "", step.detail));
    list.append(detail);
   }
   details.append(summary, list); group.append(details);
  }
  return group;
 }
 renderQuestion(entry: Entry, pending?: TranscriptPage["pending_ask"], showLink = true, useLocalAnswer = true): HTMLElement {
  const answer = entry.answer ?? (useLocalAnswer ? this.localAnswers.get(entry.id) : undefined);
  const active = !answer && pending?.id === entry.id ? pending : undefined;
  const questions = entry.questions ?? active?.questions ?? [];
  const card = el("section", "chat-question");
  card.dataset.state = answer ? "answered" : active ? "open" : "unanswered";
  const row = el("div", showLink ? "chat-message chat-question-row" : "chat-question-row");
  row.append(card);
  if (showLink) {
   const open = button("Open question", () => this.openQuestion(entry.id));
   open.className = "chat-question-open"; row.append(open);
  }
  card.append(el("p", "chat-question-title", questions.map(question => question.question).join("\n")));
  if (answer) {
   const chosen = el("p", "chat-question-answer", "✓ You chose ");
   chosen.append(el("strong", "", answer.join(", "))); card.append(chosen); return row;
  }
  if (!active) { card.append(el("p", "chat-question-note", "Not answered")); return row; }
  const options = el("div", "chat-question-options");
  const question = questions[0];
  const canAnswer = active.answerable && questions.length === 1 && !question?.multi;
  question?.options.forEach((option, index) => {
   const choice = canAnswer ? button(option, () => { void this.answer(active.id, option); }) : el("div", "", option);
   choice.className = `chat-question-option${canAnswer ? index === (question.recommended ?? 0) ? " primary" : "" : " readonly"}`;
   if (choice instanceof HTMLButtonElement) choice.disabled = this.answering;
   options.append(choice);
  });
  card.append(options);
  const problem = this.answerProblem?.askID === entry.id ? this.answerProblem : null;
  if (problem) card.append(el("p", "chat-question-problem", problem.message));
  if (problem ? problem.offersTerminal : !canAnswer) {
   const terminal = button("Answer in Terminal", () => { void this.chooseMode("terminal"); });
   terminal.className = "chat-question-terminal"; card.append(terminal);
  }
  return row;
 }
 openQuestion(id: string) {
  this.questionSheet?.close();
  const dialog = el("dialog", "subagent-sheet chat-question-sheet");
  const header = el("header"); header.append(el("strong", "", "Question"), button("Done", () => dialog.close()));
  const content = el("div", "chat-transcript");
  dialog.append(header, content); document.body.append(dialog);
  this.questionSheet = dialog;
  const session = this.chat?.session_id;
  let signature = "";
  const refresh = () => {
   const pending = this.chat?.pending_ask;
   const index = this.entries.findIndex(entry => entry.kind === "ask" && entry.id === id);
   const entry = this.entries[index] ?? (pending?.id === id ? {kind:"ask", id, ts_ms:0, questions:pending.questions} : undefined);
   let prompt: Entry | undefined;
   for (let i = index < 0 ? this.entries.length - 1 : index - 1; i >= 0; i--) {
    if (this.entries[i]!.kind === "summary") break;
    if (this.entries[i]!.kind === "user") { prompt = this.entries[i]; break; }
   }
   const next = JSON.stringify([this.chat?.session_id, entry, prompt, pending, this.answering, this.answerProblem, this.localAnswers.get(id)]);
   if (next === signature) return; signature = next;
   const expanded = content.querySelector("details")?.open ?? false;
   content.replaceChildren();
   if (!entry || session !== this.chat?.session_id) { content.append(el("p", "", "This question is no longer available.")); return; }
   content.append(this.renderQuestion(entry, pending, false));
   if (prompt?.text) {
    const context = el("details", "chat-question-context"); context.open = expanded;
    context.append(el("summary", "", "Show context"), markdown(prompt.text)); content.append(context);
   }
  };
  this.refreshQuestion = refresh;
  dialog.addEventListener("close", () => {
   dialog.remove();
   if (this.questionSheet === dialog) { this.questionSheet = null; this.refreshQuestion = null; }
  }, { once:true });
  refresh(); dialog.showModal();
 }
 renderNote(entry: Entry): HTMLElement {
  const style = noteStyles[entry.source ?? "other"] ?? noteStyles.other!;
  const title = (entry.title ?? "") + (entry.from ? ` · from ${entry.from}` : "");
  const card = button("", () => this.openNote(entry, title, style.label));
  card.className = "chat-message chat-note";
  card.setAttribute("aria-label", `${style.label} note: ${entry.title ?? ""}`);
  const icon = el("span", "chat-note-icon"); icon.setAttribute("aria-hidden", "true");
  if (navigator.platform.startsWith("Mac") || !style.icon) {
   void symbol(style.symbol, 14, "medium").then(glyph => icon.append(glyph));
  } else {
   const glyph = el("span", "chat-note-glyph");
   glyph.style.setProperty("--note-icon", `url("${style.icon}")`); icon.append(glyph);
  }
  let kicker = style.label.toUpperCase();
  if (entry.ts_ms > 0) kicker += " · " + new Date(entry.ts_ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toUpperCase();
  const lines = el("span", "chat-note-lines");
  lines.append(el("span", "chat-note-kicker", kicker), el("span", "chat-note-title", title));
  const chevron = el("span", "chat-note-chevron", "›"); chevron.setAttribute("aria-hidden", "true");
  card.append(icon, lines, chevron); return card;
 }
 openNote(entry: Entry, title: string, source: string) {
  this.noteSheet?.close();
  const dialog = el("dialog", "subagent-sheet chat-note-sheet");
  const header = el("header"); header.append(el("strong", "", "Note"), button("Done", () => dialog.close()));
  const content = el("div", "chat-note-content");
  const context = el("details", "chat-question-context");
  context.append(el("summary", "", "Show context"), markdown(entry.body ?? ""));
  content.append(el("h2", "", title), el("p", "chat-note-kicker", source.toUpperCase()), context);
  dialog.append(header, content); document.body.append(dialog); this.noteSheet = dialog;
  dialog.addEventListener("close", () => {
   dialog.remove(); if (this.noteSheet === dialog) this.noteSheet = null;
  }, { once: true });
  dialog.showModal();
 }
 bindMessageMenu(element: HTMLElement, text: string, markdown: boolean, offersMarkdown = false) {
  element.tabIndex = 0; element.setAttribute("aria-haspopup", "menu");
  const open = () => {
   const id = crypto.randomUUID(); this.messageMenu = { id, text, markdown };
   void Desk.chatMenu(id, offersMarkdown).catch(error => {
    if (!this.disposed && this.messageMenu?.id === id) { this.messageMenu = null; this.status.textContent = String(error); }
   });
  };
  element.addEventListener("contextmenu", event => { event.preventDefault(); open(); });
  element.addEventListener("keydown", event => {
   if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); open(); }
  });
 }
 async chooseMessageAction(id: string, item: string) {
  const message = this.messageMenu;
  if (!message || message.id !== id || this.disposed || this.mode !== "chat" || root.hidden) return;
  this.messageMenu = null;
  if (item === "Copy as Markdown") { await Desk.gramCopyText(message.text); return; }
  const content = message.markdown ? readableMarkdown(message.text) : el("div", "chat-readable-text", message.text);
  if (item === "Copy") { await Desk.gramCopyText(content.textContent ?? ""); return; }
  if (item !== "Select Text") return;
  this.selectionSheet?.close();
  const dialog = el("dialog", "subagent-sheet chat-selection-sheet");
  const header = el("header"); header.append(el("strong", "", "Select Text"), button("Done", () => dialog.close()));
  dialog.append(header, content); document.body.append(dialog); this.selectionSheet = dialog;
  dialog.addEventListener("close", () => {
   dialog.remove(); if (this.selectionSheet === dialog) this.selectionSheet = null;
  }, { once: true });
  dialog.showModal();
 }
 renderEntry(entry: Entry): HTMLElement {
  if (entry.kind === "ask") return this.renderQuestion(entry, undefined, false, false);
  if (entry.kind === "note") return this.renderNote(entry);
  if (entry.kind === "user" || entry.kind === "reply") {
   const article = el("article", `chat-message ${entry.kind}`);
   if (entry.kind === "user") article.append(el("div", "chat-user-text", entry.text ?? ""));
   else article.append(markdown(entry.text ?? ""));
   this.bindMessageMenu(article, entry.text ?? "", entry.kind === "reply", entry.kind === "reply");
   return article;
  }
  const details = el("details", "chat-step");
  const label = entry.kind === "thinking" ? "Thinking" : entry.kind === "step" ? `${entry.tool ?? "Tool"}: ${entry.intent ?? ""} · ${entry.status ?? ""}` : entry.title ?? entry.kind;
  details.append(el("summary", "", label));
  details.append(markdown(entry.text ?? entry.body ?? entry.detail ?? entry.error ?? entry.status ?? JSON.stringify(entry, null, 2)));
  return details;
 }
 async sendPrompt() {
  const text = this.input.value;
  if (this.sending || this.dictation.busy || this.inputFailed || (!text.trim() && !this.attachments.length)) return;
  const hasAttachments = this.attachments.length > 0;
  if (!hasAttachments) { this.input.value = ""; this.input.dispatchEvent(new Event("input")); }
  this.sending = true; this.dictation.button.disabled = true; this.send.disabled = true; this.attach.disabled = true; this.prompts.button.disabled = true; this.renderAttachments();
  try {
   await this.inputQueue;
   if (this.disposed) return;
   if (this.inputFailed) throw new Error("An earlier key send failed. Reconnect before sending again.");
   const result = JSON.parse(await Desk.chatPrompt(this.token, text));
   if (!this.disposed && hasAttachments) { this.input.value = remainingDraft(this.input.value, text); this.saveDraft(); this.input.dispatchEvent(new Event("input")); }
   if (!this.disposed) this.status.textContent = result.note ?? (result.delivery === "submitted" ? "" : "Written to the terminal; submission not confirmed. Check Terminal before sending again.");
  } catch(e) {
   if (!this.disposed) {
    if (!hasAttachments && !this.input.value) { this.input.value = text; this.input.dispatchEvent(new Event("input")); }
    this.status.textContent = String(e);
   }
  }
  finally {
   this.sending = false; this.dictation.button.disabled = false; this.send.disabled = this.dictation.busy; this.attach.disabled = this.picking; this.prompts.button.disabled = this.dictation.busy;
   if (!this.disposed) this.renderAttachments();
  }
 }
 async answer(askID: string, option: string) {
  if (this.answering || this.localAnswers.has(askID)) return;
  const epoch = this.chatEpoch, session = this.chat?.session_id;
  const current = () => !this.disposed && epoch === this.chatEpoch && session === this.chat?.session_id;
  this.answering = true; this.answerProblem = null;
  this.drawChat(false);
  try {
   const result = await Desk.chatAnswer(this.token, askID, option);
   if (!current()) return;
   if (result.code === "ask_not_pending") {
    if (this.chat?.pending_ask?.id === askID) this.chat.pending_ask = undefined;
   } else if (result.code) {
    const terminal = result.code === "ask_unsupported" || result.code === "ask_ui_not_found";
    this.answerProblem = {
     askID,
     message: result.code === "selection_mismatch" ? "omp's options changed. Check the question in the Terminal." : terminal ? "This question can't be answered from the chat." : `Couldn't answer: ${result.message}`,
     offersTerminal: terminal || result.code === "selection_mismatch",
    };
   } else if (result.status === "answered" || result.status === "sent_unconfirmed") {
    this.localAnswers.set(askID, [option]);
   } else {
    this.answerProblem = { askID, message: "Answer sent, not confirmed. Check the terminal before retrying.", offersTerminal: true };
   }
  } catch {
   if (current()) this.answerProblem = { askID, message: "Couldn't reach the agent. Try again.", offersTerminal: false };
  } finally {
   this.answering = false;
   if (current()) this.drawChat(false);
   // Keep the existing poll; refreshing here would start a second polling loop.
  }
 }
}
