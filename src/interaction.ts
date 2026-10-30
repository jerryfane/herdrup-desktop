import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import "./interaction.css";
import { Desk, events } from "./mygo";
import type { AgentTarget, AgentView, BoardUpdate } from "./mygo";
import { closeWriter, expandWriter } from "./composer";
import { markdown } from "./chatMarkdown";
import { bytes, mergeTranscript, remainingDraft, TerminalSequence } from "./interactionModel";
import type { ByteFrame, Entry, TranscriptPage } from "./interactionModel";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) {
 const node = document.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node;
}
function button(text: string, action: () => void) {
 const b = el("button", "", text); b.type = "button"; b.onclick = action; return b;
}
let root: HTMLElement;
let current: Detail | null = null;
let opening: Promise<void> = Promise.resolve();
export function initInteraction(detail: HTMLElement) {
 root = el("section", "agent-detail"); root.hidden = true; detail.append(root);
 events.terminalChanged.on(e => { if (current?.view?.token === e.token) current.frame(e); });
}
export function interactionVisible() { return current !== null; }
export function showInteraction(show: boolean) { if (root) root.hidden = !show || !current; }
export function closeInteraction() {
 current?.dispose(); current = null;
 if (root) { root.replaceChildren(); root.hidden = true; }
}
export function interactionBoard(board: BoardUpdate | null) {
 if (current && (!board || board.machineID !== current.target.machineID || (board.session === "default" ? "" : board.session) !== current.target.session)) closeInteraction();
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
 status = el("div", "interaction-status");
 body = el("div", "interaction-body");
 chatButton = button("Chat", () => { void this.switchMode("chat"); });
 terminalButton = button("Terminal", () => { void this.switchMode("terminal"); });
 terminal: Terminal | null = null;
 fit: FitAddon | null = null;
 search: SearchAddon | null = null;
 resize: ResizeObserver | null = null;
 resizeTimer: number | undefined;
 refreshTimer: number | undefined;
 inputQueue: Promise<void> = Promise.resolve();
 inputFailed = false;
 terminalReady = false;
 sequence = new TerminalSequence();
 historyCursor: string | null = null;
 terminalID = "";
 chat: TranscriptPage | null = null;
 oldestCursor: string | undefined;
 chatEpoch = 0;
 answering = false;
 entries: Entry[] = [];
 transcript = el("div", "chat-transcript");
 ask = el("div", "chat-ask");
 subagents = el("select");
 subagent = "";
 input = el("textarea", "chat-input");
 send = button("Send", () => { void this.sendPrompt(); });
 sending = false;
 draftKey: string;
 constructor(readonly target: AgentTarget) {
  this.draftKey = "herdrup.prompt." + JSON.stringify(target);
  this.input.rows = 3; this.input.placeholder = "Write a prompt…";
  try { this.input.value = localStorage.getItem(this.draftKey) ?? ""; } catch { /* storage unavailable; keep in memory */ }
  this.input.addEventListener("input", () => this.saveDraft());
  this.input.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void this.sendPrompt(); } });
 }
 saveDraft() {
  try { if (this.input.value) localStorage.setItem(this.draftKey, this.input.value); else localStorage.removeItem(this.draftKey); }
  catch { this.status.textContent = "Draft is kept in this window only: local storage is unavailable."; }
 }
 async open() {
  const bar = el("header", "interaction-toolbar");
  bar.append(this.title, this.chatButton, this.terminalButton, button("Close", () => { closeInteraction(); document.getElementById("select")!.hidden = false; }));
  root.replaceChildren(bar, this.status, this.body);
  try {
   const view = await Desk.openAgentView(this.target, this.token);
   if (this.disposed) { await Desk.closeAgentView(this.token); return; }
   this.view = view; this.title.textContent = view.name;
   this.chatButton.disabled = view.harness !== "omp";
   this.chatButton.title = view.harness === "omp" ? "Read and prompt the agent" : "Chat requires an omp agent; use Terminal for this agent";
   await this.switchMode(view.harness === "omp" ? "chat" : "terminal");
  } catch (e) { if (!this.disposed) this.status.textContent = String(e); }
 }
 stopSurface() {
  closeWriter(); this.generation++;
  clearTimeout(this.refreshTimer);
  clearTimeout(this.resizeTimer);
  this.resize?.disconnect(); this.resize = null;
  this.terminalReady = false;
  this.terminal?.dispose(); this.terminal = null; this.fit = null;
 }
 dispose() { this.disposed = true; this.stopSurface(); this.saveDraft(); void Desk.closeAgentView(this.token); }
 async switchMode(mode: "chat" | "terminal") {
  this.stopSurface(); const generation = this.generation;
  this.mode = mode; this.status.textContent = "";
  this.chatButton.setAttribute("aria-pressed", String(mode === "chat"));
  this.terminalButton.setAttribute("aria-pressed", String(mode === "terminal"));
  this.body.replaceChildren();
  await Desk.stopTerminal(this.token, this.terminalID);
  if (this.disposed || generation !== this.generation) return;
  if (mode === "terminal") await this.openTerminal(generation); else this.openChat(generation);
 }
 async openTerminal(generation: number) {
  const streamID = crypto.randomUUID(); this.terminalID = streamID;
  const tools = el("div", "terminal-tools");
  const query = el("input"); query.type = "search"; query.placeholder = "Find in terminal";
  query.oninput = () => { this.search?.findNext(query.value); };
  query.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? this.search?.findPrevious(query.value) : this.search?.findNext(query.value); } };
  tools.append(query, button("Previous", () => { this.search?.findPrevious(query.value); }), button("Next", () => { this.search?.findNext(query.value); }), button("Copy selection", () => { void Desk.gramCopyText(this.terminal?.getSelection() ?? ""); }), button("Older history", () => { void this.olderTerminal(); }), button("Reconnect", () => { void this.switchMode("terminal"); }));
  const canvas = el("div", "terminal-canvas");
  this.body.append(tools, canvas);
  const styles = getComputedStyle(document.documentElement);
  const term = new Terminal({ fontFamily: styles.getPropertyValue("--font-machine"), fontSize: 14, scrollback: 10000, allowProposedApi: false, theme: { background: styles.getPropertyValue("--color-ground-machine").trim(), foreground: styles.getPropertyValue("--color-text").trim() } });
  this.terminal = term; this.fit = new FitAddon(); this.search = new SearchAddon(); this.sequence = new TerminalSequence(); this.inputFailed = false;
  term.loadAddon(this.fit); term.loadAddon(this.search);
  term.loadAddon(new WebLinksAddon((_event, uri) => { void Desk.openExternalURL(uri).catch(e => { this.status.textContent = String(e); }); }));
  term.open(canvas);
  term.attachCustomKeyEventHandler(e => {
   if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "c") { void Desk.gramCopyText(term.getSelection()); return false; }
   return true;
  });
  term.onData(text => {
   if (!this.terminalReady || this.inputFailed) return;
   this.inputQueue = this.inputQueue.then(async () => {
    if (this.disposed || generation !== this.generation || this.inputFailed) return;
    try { await Desk.terminalInput(this.token, streamID, text); }
    catch(e) { this.inputFailed = true; this.status.textContent = String(e) + " Reconnect before typing again."; }
   });
  });
  const fit = () => {
   if (this.disposed || generation !== this.generation || !this.terminalReady || !canvas.clientWidth) return;
   this.fit?.fit();
   void Desk.terminalSize(this.token, streamID, term.cols, term.rows).catch(e => { if (generation === this.generation) this.status.textContent = "Resize: " + String(e); });
  };
  this.resize = new ResizeObserver(() => { clearTimeout(this.resizeTimer); this.resizeTimer = window.setTimeout(fit, 120); });
  this.resize.observe(canvas);
  try { await Desk.startTerminal(this.token, streamID); if (generation !== this.generation || this.disposed) return; this.terminalReady = true; fit(); term.focus(); }
  catch(e) { if (generation === this.generation) this.status.textContent = String(e); }
 }
 frame(event: { streamID: string; frame?: ByteFrame; error?: string }) {
  if (!this.terminal || event.streamID !== this.terminalID) return;
  if (event.error) { this.status.textContent = "Terminal disconnected: " + event.error; this.terminalReady = false; return; }
  const f = event.frame; if (!f) return;
  if (!this.sequence.accept(f)) { this.status.textContent = "Terminal stream changed. Reconnect to obtain a fresh screen."; this.terminalReady = false; return; }
  try {
   if (f.frame === "reset") {
    this.terminal.reset();
    if (f.cols && f.rows) this.terminal.resize(f.cols, f.rows);
    if (f.history_b64) this.terminal.write(bytes(f.history_b64));
    this.terminal.write(bytes(f.data_b64)); this.historyCursor = f.history_cursor ?? null;
   } else if (f.frame === "data") this.terminal.write(bytes(f.data_b64));
   else if (f.frame === "resize" && f.cols && f.rows) this.terminal.resize(f.cols, f.rows);
   else if (f.frame === "exited") { this.status.textContent = "Pane exited."; this.terminalReady = false; }
  } catch(e) { this.status.textContent = "Invalid terminal frame: " + String(e); this.terminalReady = false; }
 }
 async olderTerminal() {
  if (!this.historyCursor) { this.status.textContent = "No older history is available. Scroll within the terminal for retained output."; return; }
  const generation = this.generation;
  try {
   const page = await Desk.terminalHistory(this.token, this.historyCursor);
   if (this.disposed || generation !== this.generation) return;
   const dialog = el("dialog", "terminal-history"); const area = el("div", "history-canvas");
   const term = new Terminal({ disableStdin: true, cols: this.terminal?.cols ?? 80, rows: 25, scrollback: 10000, fontFamily: "IBM Plex Mono", fontSize: 14 });
   let cursor = page.cursor; const chunks = [bytes(page.history_b64)];
   const older = button("Load older", () => { void (async () => {
    if (!cursor) return; older.disabled = true;
    try { const next = await Desk.terminalHistory(this.token, cursor); cursor = next.cursor; chunks.unshift(bytes(next.history_b64)); term.reset(); chunks.forEach(c => term.write(c)); }
    catch(e) { this.status.textContent = String(e); }
    finally { older.disabled = !cursor; }
   })(); });
   older.disabled = !cursor;
   dialog.append(el("h2", "", "Earlier terminal history"), older, button("Close", () => dialog.close()), area);
   dialog.addEventListener("close", () => { term.dispose(); dialog.remove(); }, { once: true });
   document.body.append(dialog); dialog.showModal(); term.open(area); term.write(chunks[0]!);
  } catch(e) { this.status.textContent = String(e); }
 }
 openChat(generation: number) {
  this.entries = []; this.chat = null; this.subagent = ""; this.oldestCursor = undefined; this.chatEpoch++;
  const tools = el("div", "chat-tools");
  this.subagents.replaceChildren(new Option("Main conversation", ""));
  this.subagents.onchange = () => { this.chatEpoch++; this.subagent = this.subagents.value; this.entries = []; this.chat = null; this.oldestCursor = undefined; this.input.disabled = !!this.subagent; this.send.disabled = !!this.subagent || this.sending; clearTimeout(this.refreshTimer); void this.refreshChat(generation); };
  tools.append(button("Load earlier messages", () => { void this.loadEarlier(generation); }), this.subagents);
  const composer = el("div", "chat-composer");
  composer.append(this.input, button("Expand writing", () => expandWriter(this.input, `Prompt for ${this.view?.name ?? "agent"}`)), this.send);
  this.body.append(tools, this.transcript, this.ask, composer);
  void this.refreshChat(generation);
 }
 async refreshChat(generation: number) {
  const subagent = this.subagent;
  const epoch = this.chatEpoch;
  try {
   const page: TranscriptPage = JSON.parse(await Desk.chatTranscript(this.token, this.chat?.after ?? "", "", subagent));
   if (this.disposed || generation !== this.generation || epoch !== this.chatEpoch) return;
   if (!this.chat || this.chat.session_id !== page.session_id) { this.entries = []; this.oldestCursor = page.before; }
   this.entries = mergeTranscript(this.entries, page.entries ?? []); this.chat = page;
   this.drawChat();
  } catch(e) { if (!this.disposed && generation === this.generation) this.status.textContent = "Chat: " + String(e) + " You can switch to Terminal."; }
  finally { if (!this.disposed && generation === this.generation && epoch === this.chatEpoch) this.refreshTimer = window.setTimeout(() => { void this.refreshChat(generation); }, 1500); }
 }
 async loadEarlier(generation: number) {
  if (!this.chat || !this.oldestCursor) { this.status.textContent = "You are at the start of the retained conversation."; return; }
  const subagent = this.subagent;
  const session = this.chat.session_id;
  const epoch = this.chatEpoch;
  try {
   const page: TranscriptPage = JSON.parse(await Desk.chatTranscript(this.token, "", this.oldestCursor!, subagent));
   if (this.disposed || generation !== this.generation || epoch !== this.chatEpoch || page.session_id !== session) return;
   const oldHeight = this.transcript.scrollHeight;
   this.entries = mergeTranscript(this.entries, page.entries, true); this.oldestCursor = page.before;
   this.drawChat(false); this.transcript.scrollTop += this.transcript.scrollHeight - oldHeight;
  } catch(e) { this.status.textContent = String(e); }
 }
 drawChat(follow = true) {
  const atBottom = this.transcript.scrollHeight - this.transcript.scrollTop - this.transcript.clientHeight < 80;
  const opened = new Set([...this.transcript.querySelectorAll<HTMLDetailsElement>("details[open]")].map(d => d.dataset.id));
  const nodes = this.entries.map(entry => {
   const old = this.transcript.querySelector<HTMLElement>(`[data-id="${CSS.escape(entry.id)}"]`);
   const signature = JSON.stringify(entry);
   if (old?.dataset.signature === signature) return old;
   const node = this.renderEntry(entry); node.dataset.id = entry.id; node.dataset.signature = signature;
   if (node instanceof HTMLDetailsElement) node.open = opened.has(entry.id);
   return node;
  });
  this.transcript.replaceChildren(...nodes);
  if (follow && atBottom) this.transcript.scrollTop = this.transcript.scrollHeight;
  this.ask.replaceChildren();
  const pending = this.chat?.pending_ask;
  if (pending) {
   for (const q of pending.questions) {
    this.ask.append(el("p", "", q.question));
    if (pending.answerable && !this.subagent) for (const option of q.options) {
     const b = button(option, () => { void this.answer(pending.id, option); }); b.disabled = this.answering; this.ask.append(b);
    }
   }
   if (!pending.answerable || this.subagent) this.ask.append(el("p", "", "This question needs the terminal selector. Switch to Terminal to answer."));
  }
  if (!this.subagent) {
   this.subagents.replaceChildren(new Option("Main conversation", ""), ...(this.chat?.subagents ?? []).map(s => { const o = new Option(`${s.label ?? s.task ?? s.id} · ${s.status ?? ""}`, s.id); o.disabled = !s.has_transcript; return o; }));
  }
 }
 renderEntry(entry: Entry): HTMLElement {
  if (entry.kind === "user" || entry.kind === "reply") {
   const article = el("article", `chat-message ${entry.kind}`); article.append(el("small", "", entry.kind === "user" ? String(entry.author_name ?? "You") : this.view?.name ?? "Agent"), markdown(entry.text ?? "")); return article;
  }
  const details = el("details", "chat-step");
  const label = entry.kind === "thinking" ? "Thinking" : entry.kind === "step" ? `${entry.tool ?? "Tool"}: ${entry.intent ?? ""} · ${entry.status ?? ""}` : entry.title ?? entry.kind;
  details.append(el("summary", "", label));
  if (entry.kind === "ask") {
   details.append(markdown((entry.questions ?? []).map(q => `${q.question}\n\n${q.options.join(" · ")}`).join("\n\n")), el("p", "", (entry.answer ?? []).join(", ")));
  } else if (entry.kind === "plan") {
   details.append(markdown((entry.items ?? []).map(i => `- ${i.status ?? (i.done ? "done" : "pending")}: ${i.text}`).join("\n")));
  } else {
   details.append(markdown(entry.text ?? entry.body ?? entry.detail ?? entry.error ?? entry.status ?? JSON.stringify(entry, null, 2)));
  }
  return details;
 }
 async sendPrompt() {
  const text = this.input.value;
  if (this.sending || !text.trim() || this.subagent) return;
  this.sending = true; this.send.disabled = true;
  try {
   const result = JSON.parse(await Desk.chatPrompt(this.token, text));
   if (!this.disposed && result.delivery === "submitted") { this.input.value = remainingDraft(this.input.value, text); this.saveDraft(); }
   if (!this.disposed) this.status.textContent = result.delivery === "submitted" ? "Prompt submitted." : "Written to the terminal; submission not confirmed. Check Terminal before sending again.";
  } catch(e) { if (!this.disposed) this.status.textContent = String(e) + " Your draft is preserved."; }
  finally { this.sending = false; this.send.disabled = !!this.subagent; }
 }
 async answer(askID: string, option: string) {
  if (this.answering || this.subagent) return;
  this.answering = true;
  this.ask.querySelectorAll("button").forEach(b => b.disabled = true);
  try { const result = JSON.parse(await Desk.chatAnswer(this.token, askID, option)); this.status.textContent = result.status === "answered" ? "Answer confirmed." : "Answer sent, not confirmed. Check the terminal before retrying."; }
  catch(e) { this.status.textContent = String(e); }
  finally { this.answering = false; }
 }
}
