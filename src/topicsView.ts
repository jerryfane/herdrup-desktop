// The Topics view of an omp agent's page (herdrup #745 TopicsView.swift, herdr #475): New topic,
// search, the Inbox pinned first, the topics by last activity in day sections and the closed ones
// last; a topic opens its own chat, beside the list when the page is wide (iPad's layout) and in
// place of it otherwise. The list comes from Go (Desk.topicsFollow publishes topicsChanged).
import "./topics.css";
import { Desk, events } from "./mygo";
import type { AgentTopicSuggestionInfo, TopicsUpdate } from "./mygo";
import { errorText } from "./errors";
import { composerEnterSends } from "./composer";
import { CHAT_SEND_FOLLOW_MS, chatPollDelay, outgoingReceipt, reconcileOutgoing, type Outgoing } from "./chatPoll";
import { groupTranscript, mergeTranscript, readLive, type ChatRow, type Entry, type TranscriptPage } from "./interactionModel";
import { rowTime } from "./gramDates";
import { activityMs, canFold, foldShortcutLabel, messageTooLong, searchTopics, sendNote, statusDot, statusText, topicSections, topicsLayout, topicTitle, type TopicInfo } from "./topicsModel";
import { createLabel, isTicked, keptUnticks, messagesText, ORGANISE_WAIT_MS, organiseNote, organiseOver, proposalsHeading, settlePlan, suggestionTitle, tickedCount } from "./topicSuggestionsModel";
import { appleSymbols } from "./platform";
import infoIcon from "../third_party/phosphor/web/info.svg?url";
import tickedIcon from "../third_party/phosphor/web/check-circle-fill.svg?url";
import untickedIcon from "../third_party/phosphor/web/circle.svg?url";

/** iPad's regular width: the list beside the open topic's chat at this page width and above. */
export const TOPICS_WIDE_PX = 760;
const TOO_LONG = "Messages are limited to 32 KB. Send it in parts.";
const UNCONFIRMED = "Couldn't confirm delivery. Check the topic before sending again.";
/** "About topics", word for word as the owner approved it (topics-info proposal 1, 22 Nov). */
const ABOUT_TOPICS: readonly [string, string][] = [
 ["One subject each", "Topics are separate conversations with the same agent, one per subject (for example “Q4 board pack”). Each keeps its own history, so subjects don’t mix."],
 ["The Inbox", "The Inbox is the agent’s main conversation. Messages from outside (other agents, Gram, reviews) arrive there. Replies to something a topic started go back to that topic."],
 ["Starting a topic", "Tap New topic and give it a title and a first message. Topics are not created automatically. The short summary under each topic is written automatically after each reply."],
 ["Working in parallel", "Several topics can work at the same time. A topic can look at another topic’s conversation, and the Inbox knows what every topic is doing."],
 ["Closing", "Closing a topic keeps everything: it writes a closing note, and you can reopen it later. Nothing is deleted."],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
 const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node;
}
function button(text: string, cls: string, run: () => void): HTMLButtonElement {
 const b = el("button", cls, text); b.type = "button"; b.onclick = run; return b;
}

/** What the page lends the Topics view. */
export interface TopicsHost {
 token: string;
 /** The guest's own name ("" for the owner): a topic send is credited as a Chat send is. */
 guestSelf: string;
 /** The agent's name as its row shows it: "SUGGESTED BY <NAME>". */
 agentName: string;
 guest: boolean;
 /** The chat's renderer for one transcript row; a question in it is not answered here (#745
  *  ChatModel.answersQuestions: a topic's question is the Inbox's, in the terminal). */
 renderRow(row: ChatRow): HTMLElement;
 /** Opens the agent's own conversation: the page's Chat view. */
 openInbox(): void;
 symbol(name: string, size: number, weight: string): Promise<Element>;
}

// Menus go through the native popup (Desk.gramMenu): its choice comes back as a gramMenu event.
const menus = new Map<string, (item: string) => void>();
events.gramMenu.on(({ id, item }) => { const chosen = menus.get(id); if (chosen) { menus.delete(id); chosen(item); } });
function popup(items: string[], chosen: (item: string) => void) {
 const id = "topics:" + crypto.randomUUID();
 menus.set(id, chosen);
 void Desk.gramMenu(id, items).then(shown => { if (!shown) menus.delete(id); }, () => menus.delete(id));
}

/** A topic's status as muted words after its mark (Apple clean, owner picks 2026-11-24, item 12):
 *  the activity indicator while it works, a grey dot while it idles, none otherwise. */
export function topicStatus(t: TopicInfo): HTMLElement | null {
 const text = statusText(t);
 if (text === null) return null;
 const status = el("span", "topic-status");
 const mark = statusDot(t);
 if (mark) { const node = el("span", mark === "working" ? "activity-spinner" : "topic-status-dot"); node.setAttribute("aria-hidden", "true"); status.append(node); }
 status.append(el("span", "topic-status-text", text));
 return status;
}

/** The column's fold (⌥⌘T), kept as the sidebar keeps its own (sidebar.ts sidebarMinimized). */
const FOLDED_KEY = "topicsColumnFolded";
function storedFold(): boolean {
 try { return localStorage.getItem(FOLDED_KEY) === "true"; } catch { return false; }
}
/** The fold's shortcut as the header shows it beside the "Topics" button. */
const FOLD_HINT = foldShortcutLabel(navigator.platform.startsWith("Mac"));

export class TopicsPane {
 readonly root = el("div", "topics-surface");
 private readonly column = el("div", "topics-column");
 private readonly side = el("div", "topics-side");
 private readonly problem = el("p", "topics-problem");
 private readonly rows = el("div", "topics-list");
 private readonly searchInput = el("input", "topics-search");
 private update: TopicsUpdate | null = null;
 private selected: string | null = null;
 private chat: TopicChat | null = null;
 private actionNote: string | null = null;
 private inbox = "";
 private wide = false;
 private shown = false;
 private disposed = false;
 /** The column folded away beside an open topic (⌥⌘T); kept across launches. */
 private folded = storedFold();
 private readonly foldButton = button("", "topics-fold", () => this.setFolded(true));
 private readonly resize: ResizeObserver;
 private sheet: HTMLDialogElement | null = null;
 // Organise (herdrup #788, TopicsView.swift proposal 3): the agent proposes topics from its Inbox.
 private readonly organiseButton = button("", "topics-organise button-compact", () => void this.organise());
 private readonly bar = el("div", "topics-proposals-bar");
 private organising = false;
 private organiseText: string | null = null;
 /** When the agent took Organise (ms), and the timer that ends its wait. */
 private organiseAt = Infinity;
 private organiseTimer: ReturnType<typeof setTimeout> | undefined;
 /** The newest Organise request: an older one's reply, error or wait changes nothing. */
 private organiseSeq = 0;
 /** Proposals the reader unticked; every other one is ticked. */
 private unticked = new Set<string>();
 /** Create N topics or Not now is going through the proposals. */
 private settling = false;
 constructor(private readonly host: TopicsHost) {
  const head = el("div", "topics-head");
  // The fold: a circle (an icon-only button), shown where there is a column to fold.
  this.foldButton.setAttribute("aria-label", "Hide topics"); this.foldButton.title = `Hide topics (${FOLD_HINT})`;
  void host.symbol("sidebar.leading", 16, "medium").then(icon => this.foldButton.append(icon));
  const heading = el("span", "topics-heading");
  heading.append(el("strong", "", "Topics"), this.aboutButton());
  head.append(this.foldButton, heading);
  // Organise and New topic as capsules (owner picks 2026-11-24: all buttons are capsules); Organise
  // only where the agent's suggestions are served. No plus glyph: beside an open topic the 320 px
  // column holds the fold, the heading and both capsules on one line only without it.
  const create = button("New topic", "topics-new button-compact", () => this.openNewTopic());
  this.organiseButton.hidden = true;
  head.append(this.organiseButton, create);
  this.searchInput.type = "search"; this.searchInput.placeholder = "Search topics";
  this.searchInput.setAttribute("aria-label", "Search topics");
  this.searchInput.oninput = () => this.drawList();
  // The search field with its glyph (Apple clean, item 11).
  const search = el("label", "topics-search-field");
  const glyph = el("span", "topics-search-glyph"); glyph.setAttribute("aria-hidden", "true");
  void host.symbol("magnifyingglass", 13, "semibold").then(icon => glyph.append(icon));
  search.append(glyph, this.searchInput);
  this.problem.setAttribute("role", "status"); this.problem.hidden = true;
  this.bar.hidden = true;
  this.column.append(head, search, this.problem, this.rows, this.bar);
  const rule = el("div", "topics-rule"); rule.setAttribute("aria-hidden", "true");
  this.root.append(this.column, rule, this.side);
  this.resize = new ResizeObserver(() => {
   const wide = this.root.clientWidth >= TOPICS_WIDE_PX;
   if (wide !== this.wide) { this.wide = wide; this.layout(); }
  });
  this.resize.observe(this.root);
  this.wide = this.root.clientWidth >= TOPICS_WIDE_PX;
  this.layout();
 }

 /** Topics shows or hides: Go follows the list only while it shows. */
 show(shown: boolean) {
  if (this.disposed || shown === this.shown) return;
  this.shown = shown;
  void Desk.topicsFollow(this.host.token, shown).catch(() => undefined);
  this.chat?.setActive(shown);
 }

 dispose() {
  this.disposed = true; this.resize.disconnect(); clearTimeout(this.organiseTimer);
  this.sheet?.close(); this.chat?.dispose(); this.chat = null;
  if (this.shown) void Desk.topicsFollow(this.host.token, false).catch(() => undefined);
 }

 /** The Inbox row's second line: what the agent does in its own conversation. */
 setInboxPreview(activity: string) {
  if (activity === this.inbox) return;
  this.inbox = activity; this.drawList();
 }

 apply(u: TopicsUpdate) {
  if (this.disposed) return;
  // New proposals arrived, or Organise's wait ran out: it has answered.
  if (this.organising && organiseOver(this.update?.suggestions ?? [], u.suggestions ?? [], this.organiseAt, performance.now())) this.endOrganise();
  this.unticked = keptUnticks(this.unticked, u.suggestions ?? []);
  this.update = u;
  this.drawList();
  if (this.pendingOpen && u.topics.some(t => t.topic_id === this.pendingOpen)) { const id = this.pendingOpen; this.pendingOpen = null; this.select(id); }
  const open = this.selected ? u.topics.find(t => t.topic_id === this.selected) : undefined;
  if (open && this.chat) { this.chat.setTopic(open); if (u.changed === open.topic_id) this.chat.refresh(); }
  if (this.wide && !this.chat) this.drawPlaceholder();
 }

 private topics(): TopicInfo[] { return this.update?.topics ?? []; }

 /** Opens a topic by id (a suggestion's Start or its "Continued in topic" line): one that just
  *  started opens once the list brings it. */
 openTopic(id: string) {
  if (this.topics().some(t => t.topic_id === id)) { this.pendingOpen = null; this.select(id); return; }
  this.pendingOpen = id;
  void Desk.topicsRefresh(this.host.token).catch(() => undefined);
 }
 private pendingOpen: string | null = null;

 private layout() {
  this.root.dataset.layout = this.wide ? "wide" : "narrow";
  const shown = topicsLayout(this.wide, this.folded, this.selected !== null);
  this.column.hidden = !shown.list;
  this.side.hidden = !shown.chat;
  const foldable = this.foldable();
  this.foldButton.hidden = !foldable;
  // The hint names the shortcut only where it acts (a narrow page has no column to fold).
  this.chat?.setListButton(!shown.list, foldable);
  if (this.wide && !this.chat) this.drawPlaceholder();
  this.drawList();
 }

 private setFolded(folded: boolean) {
  this.folded = folded;
  try { localStorage.setItem(FOLDED_KEY, String(folded)); } catch (error) { console.warn("Topics column fold is session-only", error); }
  this.layout();
 }

 /** The header's "Topics" button: the list comes back (unfolded when wide, in place of the
  *  topic when narrow). */
 private showList() { if (this.wide) this.setFolded(false); else this.select(null); }

 /** The fold button and ⌥⌘T act only beside an open topic on a wide page (canFold). */
 foldable(): boolean { return canFold(this.wide, this.selected !== null); }

 /** ⌥⌘T: folds or unfolds the column beside an open topic; elsewhere nothing to fold. */
 toggleColumn() {
  if (this.foldable()) this.setFolded(!this.folded);
 }

 private drawPlaceholder() {
  this.side.replaceChildren(el("p", "topics-placeholder", this.topics().length ? "Choose a topic." : "Start a topic to give the agent a new line of work."));
 }

 private select(id: string | null) {
  if (id === this.selected && (id === null || this.chat)) { this.chat?.focus(); return; }
  this.selected = id;
  this.chat?.dispose(); this.chat = null;
  const topic = id ? this.topics().find(t => t.topic_id === id) : undefined;
  if (topic) {
   this.chat = new TopicChat(this.host, topic, () => this.showList());
   this.chat.setActive(this.shown);
   this.side.replaceChildren(this.chat.root);
   this.chat.focus();
  } else {
   this.selected = null;
   if (this.wide) this.drawPlaceholder(); else this.side.replaceChildren();
  }
  this.layout();
 }

 private drawList() {
  const u = this.update, query = this.searchInput.value;
  const note = this.actionNote ?? u?.problem ?? "";
  this.problem.replaceChildren(); this.problem.hidden = note === "" && this.organiseText === null;
  // A refusal or problem has a dot; what Organise is doing is plain dim text (TopicsView: topics-organise-note).
  if (note) { const dot = el("span", "topics-problem-dot"); dot.setAttribute("aria-hidden", "true"); this.problem.append(dot, el("span", "", note)); }
  else if (this.organiseText !== null) this.problem.append(el("span", "topics-organise-note", this.organiseText));
  this.drawOrganise();
  const nodes: HTMLElement[] = [this.inboxRow()];
  const suggestions = this.suggestions();
  if (suggestions.length && query === "") {
   const heading = el("h3", "topics-section", proposalsHeading(this.host.agentName));
   heading.dataset.proposals = "";
   nodes.push(heading, ...suggestions.map(s => this.proposalRow(s)));
  }
  const shown = searchTopics(this.topics(), query);
  for (const section of topicSections(shown, new Date())) {
   nodes.push(el("h3", "topics-section", section.id));
   for (const topic of section.topics) nodes.push(this.row(topic));
  }
  if (u?.loaded && !this.topics().length && !u.problem) nodes.push(el("p", "topics-empty", "No topics yet. A topic is a lasting line of work with its own conversation."));
  else if (query.trim() !== "" && !shown.length) nodes.push(el("p", "topics-empty", "No topic matches."));
  this.rows.replaceChildren(...nodes);
  this.drawBar();
 }

 private suggestions(): AgentTopicSuggestionInfo[] { return this.update?.suggestions ?? []; }

 /** Organise in the bar: shown where suggestions are served, dim and disabled while it runs. */
 private drawOrganise() {
  const b = this.organiseButton;
  b.hidden = !this.update?.suggestionsServed;
  b.disabled = this.organising;
  b.replaceChildren();
  if (this.organising) { const spin = el("span", "ring-spinner"); spin.setAttribute("aria-hidden", "true"); b.append(spin); }
  b.append(document.createTextNode("Organise"));
 }

 /** Asks the agent to propose topics from its Inbox (TopicsModel.organise). */
 private async organise() {
  if (this.organising) return;
  const seq = ++this.organiseSeq;
  this.organising = true; this.organiseText = null; this.actionNote = null; this.organiseAt = Infinity; this.drawList();
  try {
   const queued = await Desk.topicsOrganise(this.host.token);
   if (this.disposed || seq !== this.organiseSeq) return;
   if (this.organising) {
    // performance.now: elapsed time, which a change of the wall clock doesn't move.
    this.organiseText = organiseNote(queued); this.organiseAt = performance.now();
    clearTimeout(this.organiseTimer);
    this.organiseTimer = setTimeout(() => { if (seq === this.organiseSeq && this.organising && !this.disposed) { this.endOrganise(); this.drawList(); } }, ORGANISE_WAIT_MS);
   }
  } catch (error) {
   if (this.disposed || seq !== this.organiseSeq) return;
   this.organising = false; this.organiseText = errorText(error);
  }
  this.drawList();
 }

 private endOrganise() {
  this.organising = false; this.organiseText = null; this.organiseAt = Infinity; clearTimeout(this.organiseTimer);
 }

 /** One proposal: ticked until the reader unticks it, with its message count and the agent's reason. */
 private proposalRow(s: AgentTopicSuggestionInfo): HTMLElement {
  const ticked = isTicked(this.unticked, s.suggestion_id);
  const title = suggestionTitle(s.title);
  const row = button("", "topics-proposal", () => {
   if (this.unticked.has(s.suggestion_id)) this.unticked.delete(s.suggestion_id); else this.unticked.add(s.suggestion_id);
   this.drawList();
  });
  row.dataset.proposal = s.suggestion_id;
  row.disabled = this.settling;
  row.setAttribute("role", "checkbox"); row.setAttribute("aria-checked", String(ticked));
  row.setAttribute("aria-label", title);
  if (s.reason) row.setAttribute("aria-description", s.reason);
  const tick = el("span", "topics-proposal-tick"); tick.setAttribute("aria-hidden", "true");
  // checkmark.circle.fill / circle: SF on a Mac, Phosphor's check-circle fill and circle elsewhere.
  if (appleSymbols()) void this.host.symbol(ticked ? "checkmark.circle.fill" : "circle", 20, "regular").then(svg => tick.append(svg));
  else { const mask = el("span", "topics-proposal-glyph"); mask.style.setProperty("--tick-icon", `url("${ticked ? tickedIcon : untickedIcon}")`); tick.append(mask); }
  const lines = el("span", "topics-row-lines");
  const top = el("span", "topic-row-top");
  top.append(el("strong", "topic-row-title", title));
  const count = messagesText(s.message_ids.length);
  if (count) top.append(el("span", "topic-row-time", count));
  lines.append(top);
  if (s.reason) lines.append(el("span", "topics-proposal-reason", s.reason));
  row.append(tick, lines);
  return row;
 }

 /** Not now · Create N topics under the list while there are proposals. */
 private drawBar() {
  const suggestions = this.suggestions();
  this.bar.hidden = suggestions.length === 0;
  if (this.bar.hidden) { this.bar.replaceChildren(); return; }
  const count = tickedCount(suggestions, this.unticked);
  const dismiss = button("Not now", "button-secondary", () => void this.settle(false));
  const create = button(createLabel(count), "button-filled", () => void this.settle(true));
  dismiss.disabled = this.settling; create.disabled = this.settling || count === 0;
  this.bar.replaceChildren(dismiss, create);
 }

 /** Create N topics starts the ticked proposals and sets the rest aside; Not now sets all aside. */
 private async settle(create: boolean) {
  if (this.settling) return;
  this.settling = true; this.drawList();
  const plan = settlePlan(this.suggestions(), create ? this.unticked : new Set(this.suggestions().map(s => s.suggestion_id)));
  try {
   const problem = await Desk.topicsSettleSuggestions(this.host.token, plan.accept, plan.dismiss);
   this.actionNote = problem === "" ? null : problem;
  } catch (error) { this.actionNote = errorText(error); }
  this.settling = false; this.unticked = new Set();
  this.drawList();
 }

 /** The Inbox, first in the list: a plain row like a topic's (Topics A-v2: no icon, no chevron). */
 private inboxRow(): HTMLElement {
  const row = button("", "topics-inbox", () => this.host.openInbox());
  row.title = "Opens the agent's own conversation";
  const top = el("span", "topic-row-top");
  top.append(el("strong", "topic-row-title", "Inbox"));
  const line = el("span", "topic-row-line");
  line.append(el("span", "topics-row-activity", this.inbox || "The agent's own conversation"));
  row.append(top, line);
  return row;
 }

 private row(topic: TopicInfo): HTMLElement {
  const row = button("", "topic-row", () => { this.actionNote = null; this.select(topic.topic_id); });
  row.dataset.topic = topic.topic_id;
  if (topic.state === "closed") row.dataset.closed = "";
  if (this.wide && this.selected === topic.topic_id) row.setAttribute("aria-current", "true");
  const title = topicTitle(topic);
  row.setAttribute("aria-label", title);
  const value = [statusText(topic), topic.last_activity].filter((part): part is string => !!part).join(", ");
  if (value) row.setAttribute("aria-description", value);
  const top = el("span", "topic-row-top");
  top.append(el("strong", "topic-row-title", title));
  const ms = activityMs(topic);
  if (ms > 0) top.append(el("span", "topic-row-time", rowTime(new Date(ms), new Date())));
  // Status, then the newest step: "• Working · Drawing the waiting state…".
  const line = el("span", "topic-row-line");
  const status = topicStatus(topic); if (status) line.append(status);
  if (status && topic.last_activity) line.append(el("span", "topic-row-sep", "·"));
  if (topic.last_activity) line.append(el("span", "topics-row-activity", topic.last_activity));
  row.append(top);
  if (line.childElementCount) row.append(line);
  const menu = () => popup(["Rename…", topic.state === "closed" ? "Reopen" : "Close"], item => {
   if (item === "Rename…") this.openRename(topic);
   else if (item === "Reopen") void this.act(() => Desk.topicsReopen(this.host.token, topic.topic_id));
   else if (item === "Close") void this.act(() => Desk.topicsClose(this.host.token, topic.topic_id));
  });
  row.setAttribute("aria-haspopup", "menu");
  row.addEventListener("contextmenu", event => { event.preventDefault(); menu(); });
  row.addEventListener("keydown", event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); menu(); } });
  return row;
 }

 private async act(call: () => Promise<void>) {
  try { await call(); this.actionNote = null; }
  catch (error) { this.actionNote = errorText(error); }
  if (!this.disposed) this.drawList();
 }

 /** The "i" after the Topics heading: info.circle in the secondary ink (SF on a Mac, Phosphor's
  *  info elsewhere). */
 private aboutButton(): HTMLButtonElement {
  const b = button("", "topics-about-button", () => this.openAbout(b));
  b.setAttribute("aria-label", "About topics"); b.setAttribute("aria-haspopup", "dialog"); b.title = "About topics";
  if (appleSymbols()) void this.host.symbol("info.circle", 17, "regular").then(icon => b.append(icon));
  else { const mask = el("span", "topics-about-glyph"); mask.style.setProperty("--about-icon", `url("${infoIcon}")`); b.append(mask); }
  return b;
 }

 /** About topics: a popover pointing at the "i" when the page is wide (iPad), a sheet with Done
  *  otherwise (iPhone). Escape or a click outside closes the popover; the list never moves. */
 private openAbout(anchor: HTMLElement) {
  this.sheet?.close();
  const popover = this.wide;
  const dialog = el("dialog", popover ? "topics-about topics-about-popover" : "subagent-sheet topics-sheet topics-about"); this.sheet = dialog;
  dialog.setAttribute("aria-label", "About topics");
  const header = el("header");
  header.append(el("strong", "", "About topics"));
  if (!popover) header.append(button("Done", "topics-sheet-done", () => dialog.close()));
  const body = el("div", "topics-about-body");
  for (const [title, text] of ABOUT_TOPICS) { const part = el("section"); part.append(el("h3", "", title), el("p", "", text)); body.append(part); }
  dialog.append(header, body);
  // The popover is placed once, under the "i": a resize (which may also switch Topics to the
  // narrow layout) closes it, as iPad drops a popover when the size changes; the sheet stays.
  const resized = () => dialog.close();
  dialog.addEventListener("close", () => { removeEventListener("resize", resized); dialog.remove(); anchor.setAttribute("aria-expanded", "false"); if (this.sheet === dialog) this.sheet = null; }, { once: true });
  if (popover) {
   addEventListener("resize", resized);
   // A click on the transparent backdrop lands on the dialog itself, outside its box.
   dialog.addEventListener("click", event => {
    const r = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) dialog.close();
   });
  }
  document.body.append(dialog); dialog.showModal(); anchor.setAttribute("aria-expanded", "true");
  if (popover) {
   const a = anchor.getBoundingClientRect(), width = Math.min(320, innerWidth - 16);
   const top = a.bottom + 8;
   dialog.style.left = `${Math.max(8, Math.min(a.left - 16, innerWidth - width - 8))}px`;
   dialog.style.top = `${top}px`; dialog.style.width = `${width}px`;
   dialog.style.maxHeight = `${Math.max(160, innerHeight - top - 16)}px`;
  }
  body.scrollTop = 0;
 }

 /** New topic: a title and the first message, which starts its first turn (NewTopicSheet). */
 private openNewTopic() {
  this.sheet?.close();
  const dialog = el("dialog", "subagent-sheet topics-sheet"); this.sheet = dialog;
  dialog.setAttribute("aria-label", "New topic");
  const title = el("input"), message = el("textarea"), problem = el("p", "topics-sheet-problem");
  title.placeholder = "e.g. Q4 board pack"; title.maxLength = 200;
  message.placeholder = "What should this topic work on?"; message.rows = 5;
  problem.hidden = true;
  let starting = false;
  const start = button("Start", "topics-sheet-start", () => { void go(); });
  const cancel = button("Cancel", "topics-sheet-cancel", () => dialog.close());
  const ready = () => { start.disabled = starting || title.value.trim() === "" || message.value.trim() === ""; };
  title.oninput = ready; message.oninput = ready;
  const go = async () => {
   if (start.disabled) return;
   starting = true; start.textContent = "Starting…"; problem.hidden = true; ready();
   try {
    if (messageTooLong(message.value.trim())) throw new Error(TOO_LONG);
    const id = await Desk.topicsNew(this.host.token, title.value, message.value);
    if (this.disposed) return;
    dialog.close();
    // Its row arrives with the list the start publishes; the chat opens on it now.
    if (!this.topics().some(t => t.topic_id === id)) {
     const now = Date.now();
     this.update = { ...(this.update ?? { token: this.host.token, offered: true, loaded: true, topics: [], suggestions: [], suggestionsServed: false, requestedMs: 0 }),
      topics: [{ topic_id: id, title: title.value.trim(), state: "starting", queued: 0, turns: 0, created_unix_ms: now, last_activity_unix_ms: now }, ...this.topics()] };
    }
    this.select(id);
   } catch (error) {
    problem.textContent = errorText(error); problem.hidden = false;
   } finally { starting = false; start.textContent = "Start"; ready(); }
  };
  message.onkeydown = event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void go(); } };
  title.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); message.focus(); } };
  const header = el("header"); header.append(cancel, el("strong", "", "New topic"), start);
  const field = (label: string, input: HTMLElement) => { const f = el("label", "topics-field"); f.append(el("span", "", label), input); return f; };
  const body = el("div", "topics-sheet-body"); body.append(field("TITLE", title), field("FIRST MESSAGE", message), problem);
  dialog.append(header, body); document.body.append(dialog);
  dialog.addEventListener("close", () => { dialog.remove(); if (this.sheet === dialog) this.sheet = null; }, { once: true });
  ready(); dialog.showModal(); title.focus();
 }

 private openRename(topic: TopicInfo) {
  this.sheet?.close();
  const dialog = el("dialog", "subagent-sheet topics-sheet topics-rename"); this.sheet = dialog;
  dialog.setAttribute("aria-label", "Rename topic");
  const field = el("input"); field.value = topic.title; field.placeholder = "Title"; field.setAttribute("aria-label", "Title");
  const rename = () => {
   const title = field.value.trim();
   dialog.close();
   if (title === "" || title === topic.title) return;
   void this.act(() => Desk.topicsRename(this.host.token, topic.topic_id, title));
  };
  field.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); rename(); } };
  const header = el("header"); header.append(button("Cancel", "topics-sheet-cancel", () => dialog.close()), el("strong", "", "Rename topic"), button("Rename", "topics-sheet-start", rename));
  const body = el("div", "topics-sheet-body"); body.append(field);
  dialog.append(header, body); document.body.append(dialog);
  dialog.addEventListener("close", () => { dialog.remove(); if (this.sheet === dialog) this.sheet = null; }, { once: true });
  dialog.showModal(); field.select();
 }
}

/** One topic's conversation (TopicChat): agent.transcript with `topic`, and a composer that sends
 *  to this topic only (agent.topics.send). */
class TopicChat {
 readonly root = el("div", "topic-chat");
 /** "Topics ⌥⌘T": shown wherever the list is not (folded, or narrow). */
 private readonly list = el("span", "topic-list-button");
 private readonly listButton: HTMLButtonElement;
 private readonly hint = el("span", "topic-list-hint", FOLD_HINT);
 private readonly title = el("strong", "topic-chat-title");
 private readonly status = el("span", "topic-chat-status");
 private readonly messages = el("div", "chat-transcript topic-transcript");
 private readonly notice = el("p", "interaction-status topic-notice");
 private readonly note = el("p", "topic-send-note");
 private readonly input = el("textarea", "topic-input");
 private readonly send: HTMLButtonElement;
 private readonly earlier = button("Earlier messages", "chat-earlier button-plain button-compact", () => { void this.load(true); });
 private page: TranscriptPage | null = null;
 private entries: Entry[] = [];
 private before: string | undefined;
 private outgoing: Outgoing[] = [];
 private outgoingCount = 0;
 private followUntil = 0;
 private sending = false;
 private busy = false;
 private again = false;
 private active = false;
 private disposed = false;
 private timer: number | undefined;

 constructor(private readonly host: TopicsHost, private topic: TopicInfo, showList: () => void) {
  // The topic's header (Apple clean, owner picks 2026-11-24, items 14 and 15): [sidebar Topics ⌥⌘T |]
  // ‹ Inbox | title, status … •••, its text buttons capsules.
  this.listButton = button("Topics", "topic-list-open button-compact", showList);
  void host.symbol("sidebar.leading", 16, "medium").then(icon => { icon.setAttribute("aria-hidden", "true"); this.listButton.prepend(icon); });
  this.hint.setAttribute("aria-hidden", "true");
  const rule = () => { const r = el("span", "topic-chat-rule"); r.setAttribute("aria-hidden", "true"); return r; };
  this.list.append(this.listButton, this.hint, rule());
  const inbox = button("", "topic-inbox-link button-compact", () => host.openInbox());
  inbox.title = "Opens the agent's own conversation";
  const chevron = el("span", "topic-inbox-chevron"); chevron.setAttribute("aria-hidden", "true");
  void host.symbol("chevron.left", 13, "semibold").then(icon => chevron.append(icon));
  inbox.append(chevron, el("span", "", "Inbox"));
  const actions = button("", "topic-actions", () => popup([this.topic.state === "closed" ? "Reopen" : "Close"], item => {
   const call = item === "Reopen" ? Desk.topicsReopen : Desk.topicsClose;
   void call(this.host.token, this.topic.topic_id).then(() => this.showNote(null), error => this.showNote(errorText(error)));
  }));
  actions.setAttribute("aria-label", "Topic actions"); actions.setAttribute("aria-haspopup", "menu");
  // The page's own ••• (interaction.ts showMuted): ellipsis has no Windows/Linux stand-in.
  actions.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><g fill="currentColor"><circle cx="4" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="16" cy="10" r="1.5"/></g></svg>';
  const heading = el("div", "topic-chat-heading"); heading.append(this.title, this.status);
  const header = el("header", "topic-chat-header"); header.append(this.list, inbox, rule(), heading, actions);
  this.earlier.hidden = true;
  this.notice.setAttribute("role", "status");
  this.note.setAttribute("role", "status"); this.note.hidden = true;
  this.input.rows = 1;
  this.input.oninput = () => { this.showNote(null); this.updateComposer(); };
  this.input.onkeydown = event => { if (composerEnterSends(event)) { event.preventDefault(); void this.sendText(); } };
  this.send = button("", "topic-send", () => { void this.sendText(); });
  this.send.setAttribute("aria-label", "Send to topic");
  void host.symbol("arrow.up", 14, "semibold").then(icon => this.send.append(icon));
  const composer = el("div", "topic-composer"); composer.append(this.input, this.send);
  this.root.append(header, this.notice, this.messages, this.note, composer);
  this.setTopic(topic);
  this.messages.append(this.earlier);
 }

 /** The "Topics" button wherever the list is not shown; its ⌥⌘T hint only where the shortcut folds. */
 setListButton(shown: boolean, foldable: boolean) {
  this.list.hidden = !shown; this.hint.hidden = !foldable;
  this.listButton.title = foldable ? `Show topics (${FOLD_HINT})` : "Show topics";
 }
 focus() { if (!this.input.disabled) this.input.focus(); }

 setActive(active: boolean) {
  if (active === this.active || this.disposed) return;
  this.active = active;
  clearTimeout(this.timer);
  if (active) void this.load(false);
 }

 dispose() { this.disposed = true; this.active = false; clearTimeout(this.timer); }

 setTopic(topic: TopicInfo) {
  this.topic = topic;
  const title = topicTitle(topic);
  this.title.textContent = title;
  const status = topicStatus(topic);
  this.status.replaceChildren(...(status ? [status] : []));
  const closed = topic.state === "closed";
  this.input.placeholder = closed ? "Closed. Reopen it to continue." : `Message ${topic.title.trim() ? topic.title.trim() : "this topic"}`;
  this.input.setAttribute("aria-label", this.input.placeholder);
  this.updateComposer();
 }

 /** The open topic changed (an owner's agent.topics.changed): read its tail now. */
 refresh() { if (this.active) void this.load(false); }

 private showNote(note: string | null) {
  this.note.textContent = note ?? ""; this.note.hidden = !note;
 }

 private updateComposer() {
  const closed = this.topic.state === "closed";
  this.input.disabled = closed;
  this.root.dataset.closed = String(closed);
  this.send.disabled = closed || this.sending || this.input.value.trim() === "";
 }

 private async sendText() {
  const text = this.input.value.trim();
  if (this.topic.state === "closed" || this.sending || text === "") return;
  if (messageTooLong(text)) { this.showNote(TOO_LONG); return; }
  const message: Outgoing = { id: `topic-outgoing:${++this.outgoingCount}`, text, files: [], guest: this.host.guest ? this.host.guestSelf : "", state: "sending", until: Date.now() + CHAT_SEND_FOLLOW_MS };
  this.outgoing = [...this.outgoing, message];
  this.sending = true; this.showNote(null); this.input.value = ""; this.updateComposer();
  this.followUntil = message.until;
  this.draw(true);
  const settle = (state: Outgoing["state"] | null) => {
   this.outgoing = state ? this.outgoing.map(o => o.id === message.id ? { ...o, state } : o) : this.outgoing.filter(o => o.id !== message.id);
  };
  try {
   const reply = await Desk.topicsSend(this.host.token, this.topic.topic_id, text);
   // Desk classifies the send (TopicSendReply.delivery); its problem text is only shown.
   if (reply.delivery === "sent") { settle("submitted"); this.showNote(sendNote(reply.mode)); }
   else if (reply.delivery === "refused") { settle(null); if (this.input.value === "") this.input.value = text; this.showNote(reply.problem ?? null); }
   else { settle("unconfirmed"); this.showNote(reply.problem ?? UNCONFIRMED); }
  } catch (error) {
   // The page itself failed (the view closed, the link went): it may have been sent.
   settle("unconfirmed"); this.showNote(errorText(error) || UNCONFIRMED);
  } finally {
   this.sending = false;
   if (!this.disposed) { this.updateComposer(); this.draw(false); void this.load(false); }
  }
 }

 private async load(older: boolean) {
  if (this.disposed || !this.active || (older && !this.before)) return;
  if (this.busy) { if (!older) this.again = true; return; }
  this.busy = true; this.earlier.disabled = true; clearTimeout(this.timer);
  const session = this.page?.session_id;
  try {
   const held = new Set(this.entries.map(entry => entry.id));
   // Scroll state is read when the reply is applied, not when the read started: a reader who
   // scrolled up while it was pending stays where they are (#252 review).
   let height = 0, follow = false;
   const measure = () => { height = this.messages.scrollHeight; follow = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight <= 8; };
   if (older) {
    const next: TranscriptPage = JSON.parse(await Desk.topicTranscript(this.host.token, this.topic.topic_id, "", this.before!, ""));
    if (this.disposed || next.session_id !== session || this.page?.session_id !== session) return;
    measure();
    this.entries = mergeTranscript(this.entries, next.entries ?? [], { older: true });
    this.before = next.before;
   } else {
    // The chat's own live read (readLive): an after page that may re-send unloaded history is
    // replaced by the newest page, as the agent's chat does (#749 review F2).
    const live = await readLive(this.page, () => ({ entries: this.entries, hasOlder: !!this.before }), async after => {
     const read: TranscriptPage = JSON.parse(await Desk.topicTranscript(this.host.token, this.topic.topic_id, after, "", after ? this.before ?? "" : ""));
     return this.disposed ? null : read;
    });
    if (!live) return;
    measure();
    if (live.reset) this.before = live.page.before;
    this.entries = live.entries; this.page = live.page;
    this.outgoing = reconcileOutgoing(this.outgoing, held, this.entries, Date.now());
   }
   this.notice.textContent = "";
   this.draw(follow);
   if (older) this.messages.scrollTop += this.messages.scrollHeight - height;
  } catch (error) {
   if (!this.disposed) this.notice.textContent = errorText(error);
  } finally {
   this.busy = false; this.earlier.disabled = false;
   if (!this.disposed && this.active) {
    if (this.again) { this.again = false; void this.load(false); }
    else {
     const working = !!this.page?.working || this.topic.state === "running" || this.topic.state === "starting";
     this.timer = window.setTimeout(() => { void this.load(false); }, chatPollDelay({ guest: this.host.guest, working, sendPending: this.outgoing.length > 0, followUntil: this.followUntil, now: Date.now() }));
    }
   }
  }
 }

 private draw(follow: boolean) {
  const expanded = new Set([...this.messages.querySelectorAll<HTMLDetailsElement>("details[open]")].map(node => node.dataset.id));
  const nodes = groupTranscript(this.entries, !!this.page?.working).map(row => {
   const node = this.host.renderRow(row);
   node.dataset.id = row.id;
   if (node instanceof HTMLDetailsElement) node.open = expanded.has(row.id);
   node.querySelectorAll<HTMLDetailsElement>("details").forEach(detail => { detail.open = expanded.has(detail.dataset.id); });
   return node;
  });
  for (const message of this.outgoing) {
   const node = el("article", "chat-message user chat-outgoing");
   const bubble = el("div", "chat-user-text"); bubble.append(el("span", "chat-user-content", message.text));
   const line = el("span", "chat-send-receipt", outgoingReceipt(message.state)); line.setAttribute("role", "status");
   node.append(bubble, line); nodes.push(node);
  }
  this.earlier.hidden = !this.before;
  this.messages.replaceChildren(this.earlier, ...nodes);
  if (follow) this.messages.scrollTop = this.messages.scrollHeight;
 }
}
