// The Topics view of an omp agent's page (herdrup #745 TopicsView.swift, herdr #475): New topic,
// search, the Inbox pinned first, the topics by last activity in day sections and the closed ones
// last; a topic opens its own chat, beside the list when the page is wide (iPad's layout) and in
// place of it otherwise. The list comes from Go (Desk.topicsFollow publishes topicsChanged).
import "./topics.css";
import { Desk, events } from "./mygo";
import type { TopicsUpdate } from "./mygo";
import { errorText } from "./errors";
import { composerEnterSends } from "./composer";
import { CHAT_SEND_FOLLOW_MS, chatPollDelay, outgoingReceipt, reconcileOutgoing, type Outgoing } from "./chatPoll";
import { groupTranscript, mergeTranscript, type ChatRow, type Entry, type TranscriptPage } from "./interactionModel";
import { rowTime } from "./gramDates";
import { activityMs, messageTooLong, searchTopics, sendNote, statusDot, statusText, topicSections, topicTitle, type TopicInfo } from "./topicsModel";

/** iPad's regular width: the list beside the open topic's chat at this page width and above. */
export const TOPICS_WIDE_PX = 760;
const TOO_LONG = "Messages are limited to 32 KB. Send it in parts.";
const UNCONFIRMED = "Couldn't confirm delivery. Check the topic before sending again.";

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

/** A neutral pill with one small dot, or plain text for a closed topic (TopicStatusPill). */
export function topicPill(t: TopicInfo): HTMLElement | null {
 const text = statusText(t);
 if (text === null) return null;
 const dot = statusDot(t);
 if (!dot) return el("span", "topic-status-plain", text);
 const pill = el("span", "topic-status");
 const mark = el("span", "topic-status-dot"); mark.dataset.dot = dot; mark.setAttribute("aria-hidden", "true");
 pill.append(mark, el("span", "", text));
 return pill;
}

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
 private readonly resize: ResizeObserver;
 private sheet: HTMLDialogElement | null = null;

 constructor(private readonly host: TopicsHost) {
  const head = el("div", "topics-head");
  head.append(el("strong", "", "Topics"));
  // Text only: square.and.pencil has no Windows/Linux stand-in (src/web/symbols.data.ts).
  const create = button("New topic", "topics-new", () => this.openNewTopic());
  head.append(create);
  this.searchInput.type = "search"; this.searchInput.placeholder = "Search topics";
  this.searchInput.setAttribute("aria-label", "Search topics");
  this.searchInput.oninput = () => this.drawList();
  this.problem.setAttribute("role", "status"); this.problem.hidden = true;
  this.column.append(head, this.searchInput, this.problem, this.rows);
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
  this.disposed = true; this.resize.disconnect();
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
  this.update = u;
  this.drawList();
  const open = this.selected ? u.topics.find(t => t.topic_id === this.selected) : undefined;
  if (open && this.chat) { this.chat.setTopic(open); if (u.changed === open.topic_id) this.chat.refresh(); }
  if (this.wide && !this.chat) this.drawPlaceholder();
 }

 private topics(): TopicInfo[] { return this.update?.topics ?? []; }

 private layout() {
  this.root.dataset.layout = this.wide ? "wide" : "narrow";
  this.chat?.setBack(!this.wide);
  this.column.hidden = !this.wide && this.selected !== null;
  this.side.hidden = !this.wide && this.selected === null;
  if (this.wide && !this.chat) this.drawPlaceholder();
  this.drawList();
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
   this.chat = new TopicChat(this.host, topic, () => this.select(null));
   this.chat.setBack(!this.wide);
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
  this.problem.replaceChildren(); this.problem.hidden = note === "";
  if (note) { const dot = el("span", "topics-problem-dot"); dot.setAttribute("aria-hidden", "true"); this.problem.append(dot, el("span", "", note)); }
  const nodes: HTMLElement[] = [this.inboxRow()];
  const shown = searchTopics(this.topics(), query);
  for (const section of topicSections(shown, new Date())) {
   nodes.push(el("h3", "topics-section", section.id.toUpperCase()));
   for (const topic of section.topics) nodes.push(this.row(topic));
  }
  if (u?.loaded && !this.topics().length && !u.problem) nodes.push(el("p", "topics-empty", "No topics yet. A topic is a lasting line of work with its own conversation."));
  else if (query.trim() !== "" && !shown.length) nodes.push(el("p", "topics-empty", "No topic matches."));
  this.rows.replaceChildren(...nodes);
 }

 private inboxRow(): HTMLElement {
  const row = button("", "topics-inbox", () => this.host.openInbox());
  row.title = "Opens the agent's own conversation";
  const icon = el("span", "topics-inbox-icon"); icon.setAttribute("aria-hidden", "true");
  void this.host.symbol("tray", 15, "semibold").then(svg => icon.append(svg));
  const lines = el("span", "topics-row-lines");
  lines.append(el("strong", "", "Inbox"), el("span", "topics-row-activity", this.inbox || "The agent's own conversation"));
  const chevron = el("span", "topics-chevron"); chevron.setAttribute("aria-hidden", "true");
  void this.host.symbol("chevron.right", 12, "semibold").then(svg => chevron.append(svg));
  row.append(icon, lines, chevron);
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
  const pill = topicPill(topic); if (pill) top.append(pill);
  const ms = activityMs(topic);
  if (ms > 0) top.append(el("span", "topic-row-time", rowTime(new Date(ms), new Date())));
  row.append(top);
  if (topic.last_activity) row.append(el("span", "topics-row-activity", topic.last_activity));
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
     this.update = { ...(this.update ?? { token: this.host.token, offered: true, loaded: true, topics: [] }),
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
 private readonly back: HTMLButtonElement;
 private readonly title = el("strong", "topic-chat-title");
 private readonly pill = el("span", "topic-chat-pill");
 private readonly messages = el("div", "chat-transcript topic-transcript");
 private readonly notice = el("p", "interaction-status topic-notice");
 private readonly note = el("p", "topic-send-note");
 private readonly input = el("textarea", "topic-input");
 private readonly send: HTMLButtonElement;
 private readonly earlier = button("Earlier messages", "chat-earlier", () => { void this.load(true); });
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

 constructor(private readonly host: TopicsHost, private topic: TopicInfo, close: () => void) {
  this.back = button("", "topic-back", close);
  this.back.setAttribute("aria-label", "Topics");
  void host.symbol("chevron.left", 14, "semibold").then(icon => this.back.append(icon));
  const actions = button("", "topic-actions", () => popup([this.topic.state === "closed" ? "Reopen" : "Close"], item => {
   const call = item === "Reopen" ? Desk.topicsReopen : Desk.topicsClose;
   void call(this.host.token, this.topic.topic_id).then(() => this.showNote(null), error => this.showNote(errorText(error)));
  }));
  actions.setAttribute("aria-label", "Topic actions"); actions.setAttribute("aria-haspopup", "menu");
  // The page's own ••• (interaction.ts showMuted): ellipsis has no Windows/Linux stand-in.
  actions.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><g fill="currentColor"><circle cx="4" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="16" cy="10" r="1.5"/></g></svg>';
  const heading = el("div", "topic-chat-heading"); heading.append(this.title, this.pill);
  const header = el("header", "topic-chat-header"); header.append(this.back, heading, actions);
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

 setBack(shown: boolean) { this.back.hidden = !shown; }
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
  const pill = topicPill(topic);
  this.pill.replaceChildren(...(pill ? [pill] : []));
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
   settle("submitted");
   this.showNote(sendNote(reply.mode));
  } catch (error) {
   const words = errorText(error);
   // A refusal the agent answered (gone, refused, unreachable) leaves the words back in the
   // composer to send again; anything else may have reached it: no one-tap duplicate.
   const refused = words === TOO_LONG || words.startsWith("The agent refused") || words === "This topic is gone." || words === "This agent is gone." || words === "Agent not reachable" || words === "This agent has no topics.";
   if (refused) { settle(null); if (this.input.value === "") this.input.value = text; this.showNote(words); }
   else { settle("unconfirmed"); this.showNote(words === "The agent didn't answer in time." ? words : UNCONFIRMED); }
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
   const raw = await Desk.topicTranscript(this.host.token, this.topic.topic_id, older ? "" : this.page?.after ?? "", older ? this.before! : "", older ? "" : this.before ?? "");
   const next: TranscriptPage = JSON.parse(raw);
   if (this.disposed || (older && (next.session_id !== session || this.page?.session_id !== session))) return;
   const height = this.messages.scrollHeight;
   const follow = this.messages.scrollHeight - this.messages.scrollTop - this.messages.clientHeight <= 8;
   if (this.page?.session_id !== next.session_id) { this.entries = []; this.before = next.before; }
   this.entries = mergeTranscript(this.entries, next.entries, { older, resent: next.resent });
   if (older) this.before = next.before; else this.page = next;
   if (!older) this.outgoing = reconcileOutgoing(this.outgoing, held, next.entries, Date.now());
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
