import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { TerminalPrediction } from "./terminalPrediction";
import terminalTheme from "../third_party/herdrup/terminal-theme.json";
import { loadTerminalSymbols, terminalFontFamily } from "./terminalFont";
import { openGuestShare } from "./guestShare";
import { openAvatarSheet } from "./agentActions";
import "@xterm/xterm/css/xterm.css";
import "./interaction.css";
import { Desk, events } from "./mygo";
import type { AgentTarget, AgentTopicSuggestionInfo, AgentView, BoardUpdate, GramAttachment, PaneAction, TopicsUpdate } from "./mygo";
import { closeWriter, ComposerEditor, composerEnterSends, composerGlyph, composerLines, SavedPromptsMenu, composerAttachment, composerFileDrop, composerClipboardPaste } from "./composer";
import { COMPOSER_LINE, COMPOSER_TEXT_PITCH } from "./composerMetrics";
import { composerExpanded } from "./gramModel";
import { ConversationColumn } from "./conversationColumn";
import { ComposerDictation } from "./dictation";
import { markdown, readableMarkdown } from "./chatMarkdown";
import { bytes, chatDayLabel, chatDuration, chatReceipt, currentPlan, groupTranscript, mergeTranscript, planDone, planWindow, readLive, remainingDraft, rowShown, subagentRow, subagentsSummary, TerminalSequence } from "./interactionModel";
import { ChatTail, placeRows } from "./chatTail";
import { relayRow } from "./chatRelay";
import { composerDrafts, unsentLine, type ComposerView, type DraftSend, type PaneDraft } from "./composerDraft";
import { canAnswer, chooser, guestQuestion, promptByline, refusesResize, typesInTerminal, waitingForOwner, withheldFromCaller } from "./guestAnswersModel";
import { CHAT_SEND_FOLLOW_MS, chatPollDelay, isRelayRateLimited, outgoingReceipt, reconcileOutgoing, RELAY_RECONNECTING, sendShown, type Outgoing } from "./chatPoll";
import { connectionOfView, guestPausedPage, guestSendFailure, isGuestPaused, type GuestPausedPage } from "./guestPaused";
import type { GuestQuestion, Viewer } from "./guestAnswersModel";
import { askFormAnswered, askFormCard, askFormState, draftAnswers, type AnswerCredit, type AskFormState } from "./askFormCard";
import type { AskForm, AskFormAnswer, AskFormStatus, FieldValue } from "./askFormModel";
import type { ByteFrame, ChatRow, ComposerReceipt, Entry, PlanItem, TranscriptPage, TranscriptSubagent, WorkRow } from "./interactionModel";
import { forgetChats, recallChat, rememberChat } from "./chatMemory";
import { forgetScreens, recallScreen, rememberScreen } from "./terminalMemory";
import { drawnStart, pendingCardShown, revealedAbove, slidWindow, topAction, windowStarting, type OlderLoad } from "./chatWindow";
import { recordOwnerSend } from "./starPrompt";
import { HISTORY_ROWS, prependTerminalHistory } from "./terminalHistory";
import { animateHeight, cubicBezier, easeOut, motionMode, motionSeconds, SPEC } from "./motion";
import { changeTextSize, onTextSizeChanged, textSize, type TextSurface } from "./textSize";
import { defaultChatMode, type ChatMode } from "./chatPreference";
import { TopicsPane, type TopicComposer } from "./topicsView";
import { foldKey, nextTopicsOffer, ompHarness, resolvedMode, sendNote, topicsShown, type TopicsOffer } from "./topicsModel";
import { carriedText, dismissedText, inboxRows, settledLine, suggestionFromEntry, suggestionTitle, yieldSettled, type ChatSuggestion, type Settled, type SuggestionRow } from "./topicSuggestionsModel";
import chatTextIcon from "../third_party/phosphor/web/chat-text.svg?url";
import envelopeIcon from "../third_party/phosphor/web/envelope.svg?url";
import lightbulbIcon from "../third_party/phosphor/web/lightbulb.svg?url";
import bellIcon from "../third_party/phosphor/web/bell.svg?url";
import bellSlashIcon from "../third_party/phosphor/web/bell-slash.svg?url";
import arrowDownIcon from "../third_party/phosphor/web/arrow-down.svg?url";
import arrowUpIcon from "../third_party/phosphor/regular/arrow-up.svg?url";
import { isMine, previousMine } from "./chatJumpMine";
import circleIcon from "../third_party/phosphor/web/circle-bold.svg?url";
import pauseCircleIcon from "../third_party/phosphor/web/pause-circle-bold.svg?url";
import arrowCircleIcon from "../third_party/phosphor/web/arrow-circle-right-fill.svg?url";
import stopCircleIcon from "../third_party/phosphor/web/stop-circle-bold.svg?url";
import warningCircleIcon from "../third_party/phosphor/web/warning-circle-bold.svg?url";
import { errorText } from "./errors";
import { parseAttachmentPrompt, type PromptFile } from "./chatAttachments";
import arrowCircleDownIcon from "../third_party/phosphor/web/arrow-circle-down.svg?url";
import fileTextIcon from "../third_party/phosphor/web/file-text.svg?url";
import { appleSymbols } from "./platform";
import { sharesAgent } from "./shellModel";

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
/** JumpToLatestButton (JumpToLatestButton.swift:6-27): the 44 pt circle with an 18 pt medium
 *  arrow.down, bottom-centre over the chat or the terminal, shown only away from the tail. The
 *  chat's up arrow to the owner's previous message is the same button with arrow.up. */
function jumpToLatestButton(className: string, label: string, action: () => void, sf = "arrow.down", glyph = arrowDownIcon) {
 const jump = button("", action);
 jump.className = className; jump.hidden = true;
 jump.setAttribute("aria-label", label); jump.title = label;
 if (appleSymbols()) void symbol(sf, 18, "medium").then(icon => jump.replaceChildren(icon));
 else {
  const icon = el("span", "jump-latest-glyph"); icon.style.setProperty("--jump-glyph", `url("${glyph}")`);
  jump.replaceChildren(icon);
 }
 return jump;
}
/** A chat glyph: the SF Symbol on a Mac; elsewhere its Phosphor stand-in, or `fallback`
 *  drawn as a mask where the desktop has none. */
function chatGlyph(sf: string, size: number, fallback?: string): HTMLElement {
 const slot = el("span", "chat-attachments-glyph"); slot.setAttribute("aria-hidden", "true");
 if (fallback && !appleSymbols()) { const mask = el("span", "chat-plan-fallback"); mask.style.setProperty("--plan-icon", `url("${fallback}")`); mask.style.width = mask.style.height = `${size}px`; slot.append(mask); }
 else void symbol(sf, size, "medium").then(icon => slot.replaceChildren(icon));
 return slot;
}
/** The terminal's visible rows as plain text. */
function screenText(term: Terminal): string {
 const buffer = term.buffer.active, lines: string[] = [];
 for (let y = buffer.viewportY; y < buffer.viewportY + term.rows; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
 return lines.join("\n");
}
/** A transcript row's disclosures, itself first when it is one, in document order. */
function disclosures(node: HTMLElement): HTMLDetailsElement[] {
 const inner = [...node.querySelectorAll<HTMLDetailsElement>("details")];
 return node instanceof HTMLDetailsElement ? [node, ...inner] : inner;
}
/** A disclosure's remembered identity: its own id, else its row and place in that row. */
function disclosureKey(d: HTMLDetailsElement, rowID: string, index: number): string {
 return d.dataset.id ?? `${rowID}#${index}`;
}
/** ChatAttachmentBundle (App/ChatAttachments.swift): "N attachments", folded under a prompt's
 *  caption; each file opens by its Gram message id (Desk.gramOpenAttachment: Gram's download
 *  cache and the system's app for it, whether or not Gram has loaded that message), and herdr
 *  decides whether this reader may fetch it. */
function attachmentBundle(files: PromptFile[]): HTMLElement {
 const bundle = el("details", "chat-attachments");
 const summary = el("summary", "chat-attachments-summary");
 summary.append(chatGlyph("paperclip", 14), el("span", "chat-attachments-count", `${files.length} attachment${files.length === 1 ? "" : "s"}`), chatGlyph("chevron.down", 11));
 const status = el("p", "chat-attachments-status"); status.hidden = true; status.setAttribute("role", "status");
 const list = el("div", "chat-attachments-files");
 let opening = false;
 for (const file of files) {
  const row = el("button", "chat-attachment"); row.type = "button";
  // A send still on its way has no Gram id yet: shown, not openable ("Upload not complete").
  const ready = file.messageID !== "";
  row.title = ready ? `Open ${file.name}` : "Upload not complete";
  const trailing = ready ? [chatGlyph("arrow.down.circle", 16, arrowCircleDownIcon)] : [];
  trailing[0]?.classList.add("chat-attachment-open");
  row.append(file.isImage ? chatGlyph("photo", 20) : chatGlyph("doc", 20, fileTextIcon), el("span", "chat-attachment-name", file.name), ...trailing);
  row.disabled = !ready; row.dataset.ready = String(ready);
  row.onclick = () => {
   if (opening || !ready) return;
   opening = true; status.hidden = true; row.setAttribute("aria-busy", "true");
   for (const other of list.querySelectorAll("button")) other.disabled = true;
   void Desk.gramOpenAttachment(file.messageID)
    .catch(error => { status.textContent = `Couldn't open the file: ${errorText(error)}`; status.hidden = false; })
    .finally(() => { opening = false; row.removeAttribute("aria-busy"); for (const other of list.querySelectorAll<HTMLButtonElement>("button")) other.disabled = other.dataset.ready !== "true"; });
  };
  list.append(row);
 }
 bundle.append(summary, list, status);
 return bundle;
}
let root: HTMLElement;
let symbol: (name: string, size: number, weight: string) => Promise<HTMLElement>;
const modeChoices = new Map<string, ChatMode>();
let current: Detail | null = null;
let opening: Promise<void> = Promise.resolve();
let selectionChanged: ((target: AgentTarget | null) => void) | undefined;
export function initInteraction(detail: HTMLElement, renderSymbol: typeof symbol, onSelectionChanged: (target: AgentTarget | null) => void) {
 symbol = renderSymbol;
 selectionChanged = onSelectionChanged;
 root = el("section", "agent-detail"); root.hidden = true; detail.append(root);
 root.addEventListener("animationend", event => { if (event.target === root) root.classList.remove("opening"); });
 events.terminalChanged.on(e => { if (current?.view?.token === e.token) current.frame(e); });
 events.paneAttachments.on(event => {
  if (current?.token !== event.token || current.disposed) return;
  current.attachments = event.files; current.renderAttachments();
  if (event.note) current.status.textContent = event.note;
 });
 events.chatMenu.on(event => { void current?.chooseMessageAction(event.id, event.item); });
 events.topicsChanged.on(update => { if (current?.token === update.token && !current.disposed) current.applyTopics(update); });
 events.paneActionChosen.on(event => { if (current?.view?.paneID === event.paneID && !current.disposed) current.choosePaneAction(event); });
events.stateChanged.on(state => {
 // Chats and terminal screens remembered in memory end with the connection: a disconnect, a
 // removed machine or a left share (all "idle"). A reconnect keeps them; they are keyed by machine.
 if (state.phase === "idle") { forgetChats(); forgetScreens(); }
 const view = current?.view, access = state.guest?.access;
  // A guest's share or a web owner's machine (connectionOfView): the page's own connection only.
  if (!current || !view?.guest || !connectionOfView(current.target.machineID, access)) return;
  // A web owner's plain terminal opens under a terminal-scope grant only (desk.ts openTerminalView):
  // a renewal to another scope closes it, and its row offers Forget (terminals.ts).
  const scope = state.guest?.ownerScope;
  if (current.plainTerminal && scope !== undefined && scope !== "terminal") { closeInteraction(); document.getElementById("select")!.hidden = false; return; }
  // A web owner's scope, as the newest session was admitted under (a renewal can change it).
  current.applyOwnerScope(state.guest?.ownerScope);
  current.applyTerminalTyping(typesInTerminal(view, state.guest));
  // A web owner's plain terminal is no agent: no Gram with it (desk.ts openTerminalView).
  view.guestGram = !current.plainTerminal && !!state.guest?.features.gram;
  current.attach.hidden = !view.guestGram;
  if (current.guestGramButton) current.guestGramButton.hidden = !view.guestGram;
  if (current.guestModes) current.guestModes.hidden = !current.guestChat && !view.guestGram;
  // The relay refuses this network's connects for now (429): the page stays and says so until
  // a list goes through (desk_guest.go runGuest).
  if (state.guest?.availability === "reconnecting") current.status.textContent = RELAY_RECONNECTING;
  else if (current.status.textContent === RELAY_RECONNECTING) current.status.textContent = "";
  // Paused or running again once a list goes through (desk_guest.go runGuest); offline, lost and
  // reconnecting leave the page as it was.
  if (state.phase === "connected" && state.guest?.availability !== "reconnecting") current.applyGuestAvailability(state.guest?.availability);
 });
 onTextSizeChanged(() => current?.resizeText());
 window.addEventListener("keydown", event => {
  if (!current || root.hidden) return;
  if ((event.metaKey || event.ctrlKey) && !event.altKey && ["=", "+", "-", "0"].includes(event.key)) {
   event.preventDefault(); event.stopPropagation();
   current.changeTextSize("terminal", event.key === "0" ? "reset" : event.key === "-" ? -1 : 1);
   return;
  }
  if (event.key.toLowerCase() === "f" && (event.metaKey || event.ctrlKey) && !event.altKey) { event.preventDefault(); event.stopPropagation(); current.toggleFind(true); }
  // ⌥⌘T (Ctrl+Alt+T off the Mac) folds or unfolds the topics column where there is one to fold;
  // the key held down folds once.
  const topics = current.mode === "topics" ? current.topics : null;
  const fold = topics ? foldKey(event, topics.foldable()) : null;
  if (topics && fold) { event.preventDefault(); event.stopPropagation(); if (fold === "toggle") topics.toggleColumn(); }
  if (event.key === "Escape" && current.findOpen) { event.preventDefault(); event.stopPropagation(); current.toggleFind(false); }
 }, true);
}
export function interactionVisible() { return current !== null; }
// A page still leaving (closing) stays drawn until its animation ends.
export function showInteraction(show: boolean) { if (root) root.hidden = !show || (!current && !closing); if (!show) { current?.dictation.stop(); current?.dismissChatSheets(); } }
let closing: Animation | null = null;
/** Closes the agent page. `animated` (the back button) fades it out sliding 40 pt right, as
 *  herdrup does when frontID goes nil (HerdrApp.swift 3160-3179, .easeOut(duration: 0.26));
 *  the agent is disposed at once, only its last frame stays while it leaves. */
export function closeInteraction(animated = false) {
 const wasShown = !!current && !!root && !root.hidden;
 current?.dispose(); current = null;
 closing?.cancel(); closing = null;
 const seconds = animated && wasShown ? motionSeconds("page") : 0;
 if (root && seconds) {
  root.classList.remove("opening"); root.inert = true;
  const leaving = root.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(40px)" }],
   { duration: seconds * 1000, easing: getComputedStyle(document.documentElement).getPropertyValue("--motion-page-ease").trim() || "ease-out", fill: "forwards" });
  closing = leaving;
  leaving.onfinish = () => { if (closing !== leaving) return; closing = null; leaving.cancel(); root.inert = false; root.replaceChildren(); root.hidden = true; };
 } else if (root) { root.inert = false; root.replaceChildren(); root.hidden = true; }
 selectionChanged?.(null);
}
/** The newest board, for what a page reads from it when it opens (the Inbox row's line). */
let lastBoard: BoardUpdate | null = null;
function boardActivity(board: BoardUpdate | null, paneID: string): string {
 for (const section of board?.board.sections ?? []) {
  const row = section.rows.find(row => row.id === paneID);
  if (row) return row.activity ?? "";
 }
 return "";
}
export function interactionBoard(board: BoardUpdate | null) {
 lastBoard = board;
 if (current && (!board || board.machineID !== current.target.machineID || (board.session === "default" ? "" : board.session) !== current.target.session)) closeInteraction();
 if (current?.view && board) {
  for (const section of board.board.sections) {
   const row = section.rows.find(row => row.id === current!.target.paneID);
   if (row) { current.updateStatus(section.key, section.label, row.statusSinceUnixMs); current.topics?.setInboxPreview(row.activity ?? ""); }
  }
 }
}
export async function selectInteraction(target: AgentTarget, initialDraft?: string, plainTerminal = false) {
 if (current && current.plainTerminal === plainTerminal && JSON.stringify(current.target) === JSON.stringify(target)) { root.hidden = false; return; }
 closeInteraction();
 const next = new Detail(target, initialDraft, plainTerminal); current = next; root.hidden = false;
 // HerdrApp.swift 3160-3179: opening an agent fades its page in from 40 pt to the right.
 root.classList.remove("opening"); void root.offsetWidth; root.classList.add("opening");
 selectionChanged?.(target);
 opening = opening.then(async () => { if (!next.disposed) await next.open(); });
 await opening;
}
export function savedTerminalChanged(target: AgentTarget, label: string | null) {
 if (!current?.plainTerminal || JSON.stringify(current.target) !== JSON.stringify(target)) return;
 if (label === null) { closeInteraction(); document.getElementById("select")!.hidden = false; return; }
 current.title.textContent = label;
 if (current.view) { current.view.name = label; current.view.heading = label; }
}
/** How soon after herdr ended a stream another end shows as an error instead of reconnecting. */
const STREAM_RECONNECT_MS = 30_000;
class Detail {
 readonly token = crypto.randomUUID();
 view: AgentView | null = null;
 disposed = false;
 mode: ChatMode = "terminal";
 /** The switch position asked for (modeChoices, else the Settings default); `mode` is what it
  *  resolves to on this agent (topicsModel.ts resolvedMode). */
 asked: ChatMode = "terminal";
 chatAvailable = false;
 /** An omp agent on a server with agent_topics; the page offers Topics once the agent answers
  *  its list (offered) or its session file holds topics (herdrup #745 topicsAvailable). */
 topicsCapable = false;
 topicsOffer: TopicsOffer = { offered: false, refused: false };
 topics: TopicsPane | null = null;
 /** The agent's open topic suggestions as its list reports them (herdrup #788): one shows in the
  *  Inbox at once, before its transcript entry lands. */
 listedSuggestions: AgentTopicSuggestionInfo[] = [];
 suggestionsServed = false;
 /** Suggestions this reader started or set aside, shown at once until the server says otherwise. */
 settledSuggestions = new Map<string, Settled>();
 /** The suggestion whose Start or Not now is on its way, and why the last one did not land. */
 suggestionBusy: string | null = null;
 suggestionProblem: { id: string; message: string } | null = null;
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
 // Counts Find opening and closing: a pending up-arrow jump started under another count stops.
 findGeneration = 0;
 findToggle: HTMLButtonElement | null = null;
 findIndex = 0;
 findMatches: HTMLElement[][] = [];
 more: HTMLButtonElement | null = null;
 status = el("div", "interaction-status");
 body = el("div", "interaction-body");
 column = new ConversationColumn(this.body, () => this.relayout());
 terminalSurface = el("div", "terminal-surface");
 keyRow = el("div", "terminal-key-row");
 // A guest's question line above the composer (GuestPaneView.noteRow, GuestPaneView.swift:557-581).
 guestBanner = el("div", "guest-question-banner");
 // Menu keys go out one after another, in the order they were tapped (GuestPaneView.swift:57-58).
 menuKeyQueue: Promise<void> = Promise.resolve();
 // The guest's host keeps answers for the owner (a host older than guest answers): it withheld
 // `answerable` from a question the buttons could answer, or refused a guest's answer or menu
 // key. Questions wait for the owner for the rest of this page (ChatModel.answersRefused,
 // ChatView.swift:63-66).
 answersRefused = false;
 // The guest's host refused its terminal size: herdrup's note line says so instead of an error
 // (GuestPaneView.resizeRefused, GuestPaneView.swift:81, 449, 573).
 resizeRefused = false;
 // The host's grid, from the stream's reset and resize frames: what a refused guest draws at.
 streamGrid: { cols: number; rows: number } | null = null;
 // The shared agent isn't running (GuestPaneView availability .paused); null while it runs.
 guestPaused: GuestPausedPage | null = null;
 // This page types into the terminal (typesInTerminal): the owner's own, or a terminal-scope web
 // owner's; a guest and a chat-scope owner only watch it.
 terminalTyping = true;
 // The terminal area holds the paused message rather than a stream (replaceTerminal).
 terminalPaused = false;
 shownStatus: [group: string, label: string, since?: number] = ["", ""];
 /** The working dots, the recap and the model line under the chat (chatTail.ts, a topic's too). */
 private readonly tail = new ChatTail();
 /** The last transcript load failed (ChatModel.failure): the working row waits for the next. */
 private chatFailed = false;
 ctrlArmed = false;
 ctrlButton = button("Ctrl", () => this.setCtrl(!this.ctrlArmed));
 chatSurface = el("div", "chat-surface");
 mounted = false;
 // When the terminal last reconnected because herdr ended its stream (frame()).
 streamReconnectAt = 0;
 // The remembered last screen shown until the first frame (terminalMemory.ts), and whether the
 // stream has drawn a screen worth remembering.
 lastScreen: HTMLElement | null = null;
 terminalShown = false;
 // The terminal opens the first time it is shown, not under Chat (ensureTerminal).
 terminalOpened = false;
 terminalStartup: Promise<void> | null = null;
 terminalReconnect: Promise<void> | null = null;
 topicsButton = button("Topics", () => { void this.chooseMode("topics"); });
 chatButton = button("Chat", () => { void this.chooseMode("chat"); });
 terminalButton = button("Terminal", () => { void this.chooseMode("terminal"); });
 terminal: Terminal | null = null;
 prediction: TerminalPrediction | null = null;
 guestShareSheet: HTMLDialogElement | null = null;
 guestGramButton: HTMLButtonElement | null = null;
 guestModes: HTMLElement | null = null;
 guestChat = false;
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
 chatPoll = 0;
 // A guest's last send that has not shown up in the transcript: until when it keeps the poll fast
 // (ChatModel.hasPendingSend and fastPollUntil, chatPoll.ts).
 sendFollow: { until: number } | null = null;
 // Prompts sent from here that the transcript does not show yet, drawn at the tail at once
 // (motion spec §1), and their nodes, kept so each enters once and its receipt cross-fades.
 outgoing: Outgoing[] = [];
 outgoingNodes = new Map<string, HTMLElement>();
 outgoingCount = 0;
 answering = false;
 answerProblem: { askID: string; message: string; offersTerminal: boolean } | null = null;
 localAnswers = new Map<string, string[]>();
 /** omp's HTML-form asks: where the owner is in each, and the answers agent.answer_form
  *  reported before the transcript shows them. */
 formStates = new Map<string, AskFormState>();
 localFormAnswers = new Map<string, { answers: AskFormAnswer[]; sent: boolean }>();
 /** Asks agent.dismiss_ask closed, shown Cancelled until the transcript's form_status says so. */
 localDismissed = new Set<string>();
 entries: Entry[] = [];
 // The drawn window's top row (chatWindow.ts); null: the newest rows, until the first draw pins it.
 drawFrom: string | null = null;
 // The first drawn row's index, as of the last draw.
 drawnIndex = 0;
 // Disclosures the reader opened, kept for rows that leave the window and come back.
 openRows = new Set<string>();
 /** The Inbox's handovers its reader unfolded (chatRelay.ts), by entry id. */
 unfoldedRelays = new Set<string>();
 transcript = el("div", "chat-transcript");
 chatScroll = el("div", "chat-scroll");
 chatFollowing = true;
 chatResize: ResizeObserver | null = null;
 private promptLayoutWidth = 0;
 private promptLayoutDirty = true;
 chatJump = jumpToLatestButton("chat-jump-latest", "Jump to latest message", () => this.glideChatToLatest());
 // The up arrow stacked above it (turn-origin contract): the owner's previous prompt, loading
 // older pages until one is found; busy while it loads.
 chatJumpMine = jumpToLatestButton("chat-jump-previous-mine", "Jump to my previous message", () => { void this.jumpToPreviousMine(); }, "arrow.up", arrowUpIcon);
 private mineBusy = false;
 // requestAnimationFrame id while a jump button's glide runs (glideChatToLatest, glideChatTo); 0 otherwise.
 chatGlide = 0;
 // The terminal's jump button (HerdrApp.swift:5856-5858 owner, GuestPaneView.swift:470-472 guest).
 terminalJump = jumpToLatestButton("terminal-jump-latest", "Jump to latest output", () => this.jumpTerminalToTail());
 subagentSheet: HTMLDialogElement | null = null;
 // The Subagents card's disclosures (ChatView's "subagents-closed" and "subagents-finished").
 subagentsClosed = false;
 subagentsFinishedShown = false;
 // Ticks running subagents' elapsed time each second (ChatSubagentRow's TimelineView).
 subagentTick: number | undefined;
 questionSheet: HTMLDialogElement | null = null;
 noteSheet: HTMLDialogElement | null = null;
 selectionSheet: HTMLDialogElement | null = null;
 messageMenu: { id: string; text: string; markdown: boolean } | null = null;
 refreshQuestion: (() => void) | null = null;
 /** The top of the chat (ChatView topSentinel): empty while idle, "Loading earlier messages" while
  *  the older page loads, a Retry after it failed. Reaching it loads earlier rows (checkTop). */
 earlier = el("div", "chat-earlier");
 olderLoad: OlderLoad = "idle";
 /** Counts each time the chat starts its held history over (a new session, a newest page that
  *  shares nothing with it): an older page asked for before belongs to the history it replaced. */
 private historyEpoch = 0;
 input = el("textarea", "chat-input");
 editor: ComposerEditor | null = null;
 composerResize: ResizeObserver | null = null;
 stopFileDrop: (() => void) | null = null;
 stopClipboardPaste: (() => void) | null = null;
 /** The composer card (openChat): in the page's body, or in the open topic's chat (placeComposer). */
 private composerCard: HTMLElement | null = null;
 /** The open topic the composer writes to while Topics shows it (TopicsHost.composer): the same
  *  composer, its send going to the topic. Null: the Inbox, or the terminal. */
 private topicComposer: TopicComposer | null = null;
 send = button("Send", () => { void this.sendPrompt(); });
 prompts = new SavedPromptsMenu(text => {
  if (this.disposed || this.sending || this.dictation.busy) return;
  this.input.value = text; this.input.dispatchEvent(new Event("input")); void this.sendPrompt();
 }, error => { this.composerNote(errorText(error)); });
 sending = false;
 attachments: GramAttachment[] = [];
 attachmentStrip = el("div", "gstrip pane-attachments");
 picking = false;
 attach = button("", () => { void this.pickFiles(); });
 dictation = new ComposerDictation(this.input, () => {
  const busy = this.dictation?.busy ?? false, paused = !!this.guestPaused;
  this.send.disabled = paused || this.sending || busy; this.prompts.button.disabled = paused || this.sending || busy;
  // Dictation reports its busy state; the field's disabled state is this page's to render, from
  // the page's pause, the topic's (closed) and dictation's together (fieldDisabled, #533).
  this.input.disabled = this.fieldDisabled();
  this.relayout();
 }, () => { this.setCtrl(false); this.editor?.collapse(); });
 /** The field takes no typing while the page is paused, dictation writes it, or it writes to a
  *  closed topic. */
 private fieldDisabled(): boolean { return !!this.guestPaused || (this.dictation?.busy ?? false) || !!this.sendsToTopic()?.closed(); }
 /** The pane's draft and unsent text (composerDraft.ts); the composer stays editable while a write
  *  is out (as Swift's replyBar), and the write's outcome settles there. */
 draft: PaneDraft;
 /** The draft's key: the pane (its AgentTarget), with the topic the composer writes to. */
 private draftKey: string;
 /** The send whose click is queued behind earlier terminal input, not yet dispatched: closing
  *  the composer cancels it, its text coming back (sendPrompt, rule 2). */
 queuedSend: DraftSend | null = null;
 readonly draftView: ComposerView = {
  showField: (text) => { this.input.value = text; this.relayout(); },
  unsentChanged: () => this.drawUnsent(),
  olderChanged: () => this.drawOlder(),
 };
 /** The composer's layout (openChat's), for a field or line that changed without typing. */
 relayout: () => void = () => {};
 // Under the composer, muted lines: the unsent text and Restore (composerDraft.ts restore); in
 // the browser, an older page's draft, read-only, with Copy and Dismiss (never sent).
 composerLines = el("div", "composer-lines");
 unsentRow = el("div", "composer-unsent");
 unsentText = el("span", "composer-unsent-text");
 unsentRestore = el("button", "composer-line-action", "Restore");
 olderRow = el("div", "composer-older");
 olderText = el("span", "composer-older-text");
 olderCopy = el("button", "composer-line-action", "Copy");
 olderDismiss = el("button", "composer-line-action", "Dismiss");
 constructor(readonly target: AgentTarget, initialDraft?: string, readonly plainTerminal = false) {
  this.draftKey = JSON.stringify(target);
  this.draft = composerDrafts.pane(this.draftKey);
  this.input.rows = 1; this.input.placeholder = plainTerminal ? "Write text without running it" : "Type a reply…"; this.input.autocapitalize = "off"; this.input.spellcheck = false;
  this.unsentRestore.type = "button";
  this.unsentRestore.onclick = () => this.stored(this.draft.restore());
  this.unsentRow.append(this.unsentText, this.unsentRestore);
  this.olderCopy.type = "button"; this.olderDismiss.type = "button";
  this.olderRow.append(this.olderText, this.olderCopy, this.olderDismiss);
  this.composerLines.append(this.unsentRow, this.olderRow);
  // Opening reads the pane's texts as stored now (another tab may have changed them).
  this.draft.attach(this.draftView);
  this.input.value = this.draft.draft();
  this.drawUnsent();
  this.drawOlder();
  this.input.addEventListener("beforeinput", event => {
   if (!this.ctrlArmed || !event.data || event.isComposing) return;
   const code = this.controlByte(event.data);
   if (code === null) return;
   event.preventDefault(); this.setCtrl(false); this.queueTerminalInput(code);
  });
  // Every change to the field is an edit, typed or the page's (a saved prompt, dictation).
  this.input.addEventListener("input", () => this.saveDraft());
  if (initialDraft !== undefined) { this.input.value = initialDraft; this.saveDraft(); }
  this.input.addEventListener("keydown", e => { if (composerEnterSends(e)) { e.preventDefault(); void this.sendPrompt(); } });
 }
 /** An edit: the field's text is the pane's draft. */
 saveDraft() {
  this.stored(this.draft.saveDraft(this.input.value));
 }
 /** stored: false when storage refused the pane's texts, which this page still holds. */
 stored(stored: boolean) {
  if (!stored && !this.disposed) this.composerNote("Draft is kept in this window only: local storage is unavailable.");
 }
 /** The topic the composer writes to now: the open topic while Topics shows it. */
 private sendsToTopic(): TopicComposer | null { return this.mode === "topics" ? this.topicComposer : null; }
 /** What the composer has to say (a send's, a file's, the draft's): under the open topic it
  *  writes to, else on the page's note line. */
 private composerNote(text: string) { this.noteTo(this.sendsToTopic(), text); }
 /** A note for one destination: under that topic (shown again when it is), else the page's line. */
 private noteTo(topic: TopicComposer | null, text: string) {
  if (topic) topic.note(text); else this.status.textContent = text;
 }
 /** The field's prompt: the topic's (Message <title>, or Closed) where it writes to one. */
 private composerPlaceholder(): string {
  return this.sendsToTopic()?.placeholder() ?? (this.plainTerminal ? "Write text without running it" : "Type a reply…");
 }
 /** Puts the one composer where it writes now: under the open topic's conversation while Topics
  *  shows one, else in the page's body (the Inbox's, the terminal's). Each place keeps its own
  *  draft (the pane's, or the pane's and topic's); attached files stay with the composer. */
 private placeComposer() {
  const card = this.composerCard;
  if (!card) return;
  const topic = this.sendsToTopic();
  const parent = topic?.slot ?? this.body;
  if (card.parentElement !== parent) parent.append(card, this.composerLines);
  const key = JSON.stringify(topic ? { ...this.target, topic: topic.topicID } : this.target);
  if (key !== this.draftKey) {
   // Dictation writes the draft it started in: it stops before the field shows another (#533).
   this.dictation.stop();
   this.stored(this.draft.flush()); this.draft.detach(this.draftView);
   this.draftKey = key; this.draft = composerDrafts.pane(key);
   this.draft.attach(this.draftView);
   this.input.value = this.draft.draft();
   this.drawUnsent(); this.drawOlder();
  }
  this.input.disabled = this.fieldDisabled();
  this.input.placeholder = this.guestPaused?.placeholder ?? this.composerPlaceholder();
  this.relayout();
 }
 /** The unsent line as the pane's draft has it; the composer's layout makes room for it. */
 drawUnsent() {
  const unsent = this.draft.unsent();
  this.unsentRow.hidden = unsent === null;
  this.unsentText.textContent = unsent === null ? "" : unsentLine(unsent);
  this.unsentText.title = unsent?.text ?? "";
  this.drawLines();
 }
 /** The older page's draft (browser), as stored now: one line, read-only. Copy puts all of it on
  *  the clipboard; Dismiss removes it while it is still the text shown (a newer one is drawn
  *  instead). It never reaches the field or a send. */
 drawOlder() {
  const older = this.draft.older();
  this.olderRow.hidden = older === null;
  this.olderText.textContent = older === null ? "" : `Older draft: ${older.replace(/\s+/g, " ").trim()}`;
  this.olderText.title = older ?? "";
  this.olderCopy.textContent = "Copy";
  this.olderCopy.onclick = older === null ? null : () => {
   navigator.clipboard.writeText(older).then(
    () => { if (!this.disposed) this.olderCopy.textContent = "Copied"; },
    () => { if (!this.disposed) this.status.textContent = "Couldn't copy the older draft."; });
  };
  this.olderDismiss.onclick = older === null ? null : () => {
   if (this.draft.dismissOlder(older) === "refused") { this.status.textContent = "Couldn't dismiss the older draft: local storage is unavailable."; return; }
   this.drawOlder();
  };
  this.drawLines();
 }
 /** The lines under the composer show when either has something; the layout makes room. */
 drawLines() {
  this.composerLines.hidden = this.unsentRow.hidden && this.olderRow.hidden;
  this.relayout();
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
  if (!this.terminalReady || this.inputFailed || this.disposed || !this.terminalTyping) return;
  const generation = this.generation, streamID = this.terminalID, prediction = this.prediction;
  const batch = text ? prediction?.userBytes(text) : undefined;
  this.inputQueue = this.inputQueue.then(async () => {
   if (this.disposed || generation !== this.generation || streamID !== this.terminalID || this.inputFailed) return;
   if (batch !== undefined) prediction?.sent(batch);
   try {
    await Desk.terminalInput(this.token, streamID, text);
    if (batch !== undefined) prediction?.acked(batch);
   }
   catch(e) {
    if (batch !== undefined) prediction?.acked(batch, true);
    if (streamID === this.terminalID && !this.disposed) { this.inputFailed = true; this.status.textContent = errorText(e) + " Reconnect before typing again."; }
   }
  });
 }
 mountKeys() {
  if (this.view?.guest) { this.mountMenuKeys(); return; }
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
  // The same jump as the overlay button: both bump jumpToTailToken (HerdrApp.swift:6417).
  const latest = button("", () => this.jumpTerminalToTail());
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
 /** GuestMenuKeyBar (GuestPaneView.swift:1043-1097) in the quick-key row's place: the owner's
  *  esc, space, arrows, tab and pinned Return, only keys a guest's host accepts and nothing that
  *  types text. A guest pane has no other quick keys; the bar shows while the agent waits. */
 mountMenuKeys() {
  const cap = (label: string, key: string, glyph?: string) => {
   const cap = button(glyph ? "" : label, () => this.sendMenuKey(key));
   cap.setAttribute("aria-label", key);
   if (glyph) cap.append(composerGlyph(glyph, 14));
   cap.onpointerdown = event => event.preventDefault();
   return cap;
  };
  const scroll = el("div", "terminal-key-scroll");
  const space = cap("space", "Space"); space.className = "terminal-space-key";
  const arrows = el("div", "terminal-key-group");
  arrows.append(cap("Left", "Left", "key-left"), cap("Up", "Up", "key-up"), cap("Down", "Down", "key-down"), cap("Right", "Right", "key-right"));
  scroll.append(cap("esc", "Escape"), space, arrows, cap("tab", "Tab"));
  const enter = cap("Enter", "Enter", "key-enter"); enter.className = "terminal-enter-key";
  this.keyRow.classList.add("guest-menu-keys");
  this.keyRow.append(scroll, enter); this.body.append(this.guestBanner, this.keyRow);
  this.updateGuestQuestion();
 }
 /** Presses one of the owner's menu keys in the shared pane (GuestPaneView.sendMenuKey,
  *  GuestPaneView.swift:834-852). A refused key while the agent is still blocked means a host
  *  that keeps answers for the owner (Go reads the agent again): the keys go and the page
  *  waits for the owner. */
 sendMenuKey(key: string) {
  const generation = this.generation;
  this.menuKeyQueue = this.menuKeyQueue.then(async () => {
   if (this.disposed || generation !== this.generation || this.answersRefused) return;
   try {
    const reply = await Desk.guestMenuKey(this.token, key);
    if (this.disposed || generation !== this.generation) return;
    this.status.textContent = "";
    if (reply.ownerAnswers) this.refuseAnswers();
   } catch (error) { if (!this.disposed) this.status.textContent = errorText(error); }
  });
 }
 refuseAnswers() {
  if (this.answersRefused) return;
  this.answersRefused = true;
  this.updateStatus(...this.shownStatus);
  if (this.chat) this.drawChat(false);
 }
 /** The guest's question banner and menu keys for the agent's board group; null for the owner. */
 updateGuestQuestion(): GuestQuestion | null {
  const view = this.view;
  if (!view?.guest) return null;
  // Paused: NOT RUNNING, with no note line and no menu keys (GuestPaneView.swift:406-409, 571).
  const question: GuestQuestion = this.guestPaused ? { banner: null, tone: "faint", menuKeys: false, label: this.guestPaused.pill }
   : guestQuestion(view.name, view.guestOwner ?? "", this.shownStatus[0], this.answersRefused, this.mode === "terminal", this.resizeRefused, this.terminalTyping);
  this.guestBanner.textContent = question.banner ?? "";
  this.guestBanner.hidden = !question.banner;
  this.guestBanner.dataset.keys = String(question.menuKeys);
  this.guestBanner.dataset.tone = question.tone;
  this.keyRow.hidden = !question.menuKeys;
  return question;
 }
 async open() {
  this.attach.setAttribute("aria-label", "Attach file");
  this.attach.append(await symbol("paperclip", 18, "regular"));
  const bar = el("header", "interaction-toolbar");
  const back = button("", () => { closeInteraction(true); document.getElementById("select")!.hidden = false; });
  back.className = "pane-back"; back.setAttribute("aria-label", "Back");
  back.append(await symbol("chevron.left", 16, "semibold"));
  const capsule = el("div", "pane-header-capsule");
  const refresh = button("", () => {
   if (this.mode === "terminal") void this.reconnectTerminal();
   else if (this.mode === "topics") void Desk.topicsRefresh(this.token).catch(() => undefined);
   else void this.refreshChat(this.generation);
  });
  refresh.setAttribute("aria-label", "Refresh");
  refresh.append(await symbol("arrow.clockwise", 15, "medium"));
  // InlineSearchToggle (InlineSearchField.swift): 15 pt semibold, textDim while closed and text
  // while open (toggleFind sets aria-pressed).
  const find = button("", () => this.toggleFind());
  find.className = "pane-find-toggle"; find.setAttribute("aria-label", "Search"); find.setAttribute("aria-pressed", "false");
  find.append(await symbol("magnifyingglass", 15, "semibold"));
  this.findToggle = find;
  // The ••• menu (HerdrApp.swift 6227-6281, PaneHeaderControls.swift 80-119) is Go's native
  // menu (Desk.paneMenu); the item chosen comes back as events.paneActionChosen.
  const more = button("", () => this.showPaneMenu());
  more.setAttribute("aria-label", this.plainTerminal ? "Terminal actions" : "Agent actions");
  this.more = more; void this.showMuted(false);
  capsule.append(find, refresh, more);
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
  bar.append(back, this.titleBlock, this.findBar, capsule);
  const modes = el("div", "chat-terminal-switch");
  modes.append(this.topicsButton, this.chatButton, this.terminalButton);
  modes.hidden = true; this.topicsButton.hidden = true;
  if (this.disposed) return;
  // The note sits above the key row and composer, as herdrup's actionNote (HerdrApp.swift 5849-5855).
  root.replaceChildren(bar, modes, this.body);
  this.body.append(this.status);
  try {
   const view = await (this.plainTerminal ? Desk.openTerminalView(this.target, this.token) : Desk.openAgentView(this.target, this.token));
   if (this.disposed) { await Desk.closeAgentView(this.token); return; }
   this.view = view; this.title.textContent = view.heading;
   // A guest's page starts watching only; a terminal-scope web owner's learns it may type from
   // the connection below, before the terminal opens.
   this.terminalTyping = !view.guest;
   this.updateStatus(view.group, view.status, view.statusSinceUnixMs);
   void Desk.paneMuted(view.paneID).then(muted => this.showMuted(muted), () => undefined);
   const chatAvailable = ompHarness(view.harness) && (!view.guest || await Desk.guestChatAvailable(this.token).catch(() => false));
   if (this.disposed) return;
   this.chatAvailable = chatAvailable;
   this.topicsCapable = chatAvailable && await Desk.topicsAvailable(this.token).catch(() => false);
   if (this.disposed) return;
   if (this.topicsCapable) this.mountTopics(view);
   this.attach.hidden = view.guest && !view.guestGram;
   modes.hidden = !chatAvailable && !view.guestGram;
   if (view.guest) {
    const connection = (await Desk.state().catch(() => null))?.guest;
    this.guestPaused = guestPausedPage(connection?.availability, view.name);
    this.terminalTyping = typesInTerminal(view, connection);
    this.ownerScope = connection?.ownerScope;
    if (this.disposed) return;
    this.guestChat = chatAvailable; this.guestModes = modes;
    // The guest's one Gram with this shared agent selected (#697); the grant is Access.ID().
    const share = (await Desk.state().catch(() => null))?.guest?.access;
    const grant = share ? `${share.endpoint.hostID}/${share.guestID}` : null;
    const gram = button("Gram", () => window.dispatchEvent(new CustomEvent("guest-gram", { detail: grant })));
    gram.hidden = !view.guestGram; this.guestGramButton = gram;
    modes.replaceChildren(...(chatAvailable ? [this.topicsButton, this.chatButton] : []), this.terminalButton, gram);
   }
   this.asked = chatAvailable ? (modeChoices.get(JSON.stringify(this.target)) ?? defaultChatMode()) : "terminal";
   this.topicsButton.hidden = !this.topicsAvailable();
   await this.switchMode(this.resolvedMode());
   // Ask the agent once whether it has topics (#745 .task): the answer may add the Topics button.
   if (this.topicsCapable && this.mode !== "topics") void Desk.topicsRefresh(this.token).catch(() => undefined);
   if (view.guest) this.showGuestPaused();
  } catch (e) { if (!this.disposed) this.status.textContent = errorText(e); }
 }
 /** A web owner's grant scope as last admitted (GuestConnection.ownerScope). */
 ownerScope: string | undefined;
 /** Advances with each change of ownerScope: a resize answer from an earlier one is stale. */
 scopeGeneration = 0;
 /** A renewal admitted the owner under another scope: what the earlier grant refused (the
  *  terminal size, resizeRefused) is asked again under this one, at once. */
 applyOwnerScope(scope: string | undefined) {
  if (scope === this.ownerScope) return;
  this.ownerScope = scope;
  this.scopeGeneration++;
  if (!this.resizeRefused) return;
  this.resizeRefused = false;
  this.updateGuestQuestion();
  this.fitTerminal?.();
 }
 /** A web owner's scope as last admitted: a terminal-scope grant types into the terminal shown
  *  now, a chat-scope one (again) only watches it; a guest never types (typesInTerminal). */
 applyTerminalTyping(typing: boolean) {
  if (typing === this.terminalTyping) return;
  this.terminalTyping = typing;
  if (this.terminal) this.terminal.options.disableStdin = !typing;
  this.updateGuestQuestion();
 }
 /** The share paused or resumed (GuestPaneView.setAvailability, GuestPaneView.swift:757-762). */
 applyGuestAvailability(availability: string | undefined) {
  const view = this.view;
  if (!view?.guest) return;
  const next = guestPausedPage(availability, view.name);
  if (!next === !this.guestPaused) return;
  this.guestPaused = next;
  this.showGuestPaused();
  if (!this.mounted) return;
  // The terminal is unmounted while paused and remounted fresh on resume (:441-445, streamGen).
  void this.reconnectTerminal();
  // The chat reads no more while paused (live: false, :133) and polls again on resume.
  if (next) clearTimeout(this.refreshTimer);
  else if (this.mode === "chat") void this.refreshChat(this.generation);
 }
 /** Pill, note line and composer for the share's availability: paused, the composer is off and
  *  says "Agent unavailable" (canCompose, placeholder: GuestPaneView.swift:515, 587-596). */
 showGuestPaused() {
  const paused = !!this.guestPaused;
  // The mic is also the running dictation's stop button: disabling it would leave capture on
  // with no way to end it (#113 review). Stop first; its words stay in the field, and its
  // render must not re-enable the input after the lines below.
  if (paused) this.dictation.stop();
  this.updateStatus(...this.shownStatus);
  this.input.disabled = this.fieldDisabled();
  this.input.placeholder = this.guestPaused?.placeholder ?? this.composerPlaceholder();
  this.send.disabled = paused || this.sending || this.dictation.busy;
  this.attach.disabled = paused || this.sending || this.picking;
  this.prompts.button.disabled = paused || this.sending || this.dictation.busy;
  this.dictation.button.disabled = paused || this.sending;
  // The working row goes with the poll (ChatView live).
  if (this.chat && this.mode === "chat") this.drawChat(false);
  this.relayout();
 }
 changeTextSize(surface: TextSurface, delta: number | "reset") {
  try { changeTextSize(surface, delta); }
  catch (error) { this.status.textContent = errorText(error); }
 }
 showPaneMenu() {
  const view = this.view;
  if (!view || this.disposed) return;
  void Desk.paneMenu({
   paneID: view.paneID, plain: this.plainTerminal,
   hasSelection: this.mode === "terminal" && !!this.terminal?.hasSelection(),
   canShare: !this.plainTerminal && sharesAgent(view.guest, this.ownerScope),
  }).catch(error => { if (!this.disposed) this.status.textContent = errorText(error); });
 }
 /** Carries out the ••• item Go reports (HerdrApp.swift 6227-6281); the sheet an item opens is
  *  opened with its event (in the browser, with the selection the menu made). */
 choosePaneAction(request: PaneAction) {
  const action = request.action;
  const view = this.view;
  if (!view) return;
  switch (action) {
   case "copy-screen": case "copy-recent":
    // PaneHeaderControls.swift 80-101: agent.read (visible / recent) onto the pasteboard.
    void Desk.readAgentText(this.token, action === "copy-recent").then(text => { if (!this.disposed) return Desk.gramCopyText(text); }).catch(error => { if (!this.disposed) this.status.textContent = errorText(error); });
    break;
   case "copy-selection": void Desk.gramCopyText(this.terminal?.getSelection() ?? ""); break;
   // Section "Text size" (PaneHeaderControls.swift 105-119).
   case "text-increase": this.changeTextSize(this.textSurface(), 1); break;
   case "text-decrease": this.changeTextSize(this.textSurface(), -1); break;
   case "text-reset": this.changeTextSize(this.textSurface(), "reset"); break;
   case "share":
    if (!sharesAgent(view.guest, this.ownerScope)) return;
    this.guestShareSheet?.close();
    this.guestShareSheet = openGuestShare(this.token, view.name);
    break;
   // AgentAvatarMenuButton → AgentAvatarSheet (AgentAvatarViews.swift 277-283; HerdrApp.swift 6252-6254).
   case "avatar": openAvatarSheet(request, view.heading); break;
   // Go has flipped the stored mute; the label follows (HerdrApp.swift 6255-6261).
   case "mute": case "unmute": void this.showMuted(action === "mute"); break;
   // Close agent: Go closed the pane; back to the agents list (HerdrApp.swift 6262-6269).
   case "close": closeInteraction(true); document.getElementById("select")!.hidden = false; break;
  }
 }
 /** PaneActionsMenuLabel (PaneHeaderControls.swift 66-77): an ellipsis, or a struck bell in
  *  waiting while this pane's notifications are muted, 15 pt medium in a 40×44 box. */
 async showMuted(muted: boolean) {
  const more = this.more;
  if (!more) return;
  more.classList.toggle("muted", muted);
  if (!muted) {
   more.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><g fill="currentColor"><circle cx="4" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="16" cy="10" r="1.5"/></g></svg>';
   return;
  }
  if (appleSymbols()) {
   const glyph = await symbol("bell.slash", 15, "medium");
   if (more.classList.contains("muted")) more.replaceChildren(glyph);
   return;
  }
  const glyph = el("span", "pane-muted-glyph");
  glyph.style.setProperty("--muted-icon", `url("${bellSlashIcon}")`);
  more.replaceChildren(glyph);
 }
 resizeText() {
  this.prediction?.reset();
  if (this.terminal) this.terminal.options.fontSize = textSize("terminal");
  this.fitTerminal?.();
  this.promptLayoutDirty = true;
  this.relayout();
  this.followChat();
 }
 updateStatus(group: string, label: string, since?: number) {
  clearInterval(this.statusTimer);
  this.shownStatus = [group, label, since];
  if (this.guestPaused) since = undefined;
  // NEEDS <OWNER> while the question waits for the owner (GuestPaneView.statusPill, GuestPaneView.swift:411-413).
  const shown = this.updateGuestQuestion()?.label ?? label;
  this.stateLine.dataset.group = this.guestPaused ? "paused" : group;
  // The dot for Needs you, the activity indicator while working (owner picks 2026-11-24, item 6).
  const mark = el("span", this.stateLine.dataset.group === "working" ? "activity-spinner" : "pane-state-dot");
  mark.setAttribute("aria-hidden", "true");
  this.stateLine.replaceChildren(mark, el("span", "pane-state-label", shown), this.stateAge);
  const updateAge = () => {
   if (since === undefined) { this.stateAge.textContent = ""; return; }
   const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
   const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
   this.stateAge.textContent = hours > 0 ? `${hours}h ${minutes % 60}m`
    : minutes >= 10 ? `${minutes}m` : minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  };
  updateAge();
  if (since !== undefined) this.statusTimer = window.setInterval(updateAge, 1000);
  // The working row and the recap follow the board status (ChatView's agentStatus) between
  // polls, failed ones included: each redraws when whether it shows no longer matches the page.
  if (this.chat && this.mode === "chat" && (!!this.renderWorking() !== this.tail.shows().working || !!this.renderRecap() !== this.tail.shows().recap)) this.drawChat(false);
 }
 toggleFind(open = !this.findOpen) {
  // A pending up-arrow jump stops when Find opens or closes (herdrup #637, review F2).
  if (open !== this.findOpen) this.findGeneration++;
  this.findOpen = open;
  this.findBar.hidden = !open; this.titleBlock.hidden = open;
  this.findToggle?.setAttribute("aria-pressed", String(open));
  this.findToggle?.setAttribute("aria-label", open ? "Close search" : "Search");
  if (open) { this.findInput.focus(); if (this.chat && this.mode === "chat") this.drawChat(false); this.updateFind(true); }
  else { this.findInput.value = ""; this.pinWindowToView(); this.updateFind(true); if (this.mode === "terminal") this.terminal?.focus(); }
  this.updateChatJump();
 }
 /** `reveal`: bring the current match into view. Only the owner's own Find actions do; a redraw
  *  re-marks the matches where the reader left them (owner 2026-11-10: each poll snapped the
  *  chat back to a match while scrolling). */
 updateFind(reset = false, step = 0, reveal = true) {
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
   this.promptLayoutDirty = true;
   this.fitPromptBubbles();
  }
  const count = this.findMatches.length;
  if (count) this.findIndex = (this.findIndex + step + count) % count;
  this.findMatches.forEach((marks, index) => marks.forEach(mark => mark.classList.toggle("current", index === this.findIndex)));
  this.findCount.textContent = query ? count ? `${this.findIndex + 1} of ${count}` : "No matches" : "";
  const match = this.findMatches[this.findIndex]?.[0];
  if (match && this.findOpen && reveal) {
   for (let ancestor = match.parentElement; ancestor && ancestor !== this.transcript; ancestor = ancestor.parentElement) if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
   match.scrollIntoView({ block: "center" });
  }
 }
 chatAtBottom() { return this.chatScroll.scrollHeight - this.chatScroll.scrollTop - this.chatScroll.clientHeight <= 8; }
 updateChatJump() {
  // An up glide leaves the tail: only a glide to the tail counts as being there.
  const away = !!this.chat && !(this.chatGlide && this.chatFollowing) && !this.chatAtBottom();
  this.chatSurface.classList.toggle("away-from-tail", away);
  this.chatJump.hidden = !away || this.findOpen;
  const first = this.mineNodes(1)[0];
  const above = !!first && this.chatTop(first) < this.chatScroll.scrollTop - 1;
  this.chatJumpMine.hidden = !this.chat || this.mode !== "chat" || this.findOpen || this.viewer().guest || !(above || this.hasEarlier() || this.mineBusy);
  this.chatJumpMine.disabled = this.mineBusy;
  this.chatJumpMine.classList.toggle("busy", this.mineBusy);
  this.chatJumpMine.setAttribute("aria-busy", String(this.mineBusy));
 }
 /** The owner's own prompts on screen, in transcript order (the first `limit` of them). */
 private mineNodes(limit = Infinity): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  for (const entry of this.entries) {
   if (nodes.length >= limit) break;
   if (!isMine(entry)) continue;
   const node = this.transcript.querySelector<HTMLElement>(`[data-id="${CSS.escape(entry.id)}"]`);
   if (node) nodes.push(node);
  }
  return nodes;
 }
 /** A row's top in the chat scroller's content coordinates. */
 private chatTop(node: HTMLElement) {
  return node.getBoundingClientRect().top - this.chatScroll.getBoundingClientRect().top + this.chatScroll.scrollTop;
 }
 /** The up arrow's tap: glide to the owner's prompt closest above the view, loading older pages
  *  (as Earlier messages does) until one is found or the retained history ends. Opening or
  *  closing Find while a page loads cancels it, so a landing page never pulls the chat away
  *  from the search. */
 async jumpToPreviousMine() {
  if (this.mineBusy) return;
  const generation = this.generation, find = this.findGeneration;
  const stale = () => this.disposed || generation !== this.generation || find !== this.findGeneration || this.findOpen || this.mode !== "chat";
  try {
   for (;;) {
    if (stale()) return;
    const target = previousMine(this.mineNodes().map(node => ({ id: node.dataset.id!, top: this.chatTop(node) })), this.chatScroll.scrollTop);
    if (target !== null) {
     const node = this.transcript.querySelector<HTMLElement>(`[data-id="${CSS.escape(target)}"]`);
     if (node) this.glideChatTo(this.chatTop(node) - 12);
     return;
    }
    if (!this.hasEarlier()) return;
    this.mineBusy = true; this.updateChatJump();
    if (!(await this.showEarlier(generation))) return;
   }
  } finally { this.mineBusy = false; this.updateChatJump(); }
 }
 /** Glides the chat up to `top` like the down arrow's glide (Reduce Motion jumps): from more
  *  than two screens away it first snaps to one screen below the target. */
 glideChatTo(top: number) {
  const scroll = this.chatScroll, seconds = motionSeconds("glide");
  this.stopChatGlide(); this.chatFollowing = false;
  const to = Math.max(0, Math.min(top, scroll.scrollHeight - scroll.clientHeight));
  const land = () => { this.chatGlide = 0; this.chatFollowing = this.chatAtBottom(); this.updateChatJump(); };
  if (!seconds || Math.abs(to - scroll.scrollTop) <= 0.5) { scroll.scrollTop = to; land(); return; }
  if (scroll.scrollTop - to > 2 * scroll.clientHeight) scroll.scrollTop = to + scroll.clientHeight;
  const from = scroll.scrollTop, start = performance.now();
  const step = (now: number) => {
   if (this.findOpen || this.mode !== "chat") { this.stopChatGlide(); return; }
   const progress = Math.min(1, (now - start) / (seconds * 1000));
   scroll.scrollTop = from + (to - from) * easeOut(progress);
   if (progress < 1) this.chatGlide = requestAnimationFrame(step);
   else land();
  };
  this.chatGlide = requestAnimationFrame(step);
  this.updateChatJump();
 }
 followChat() {
  if (this.chatFollowing && !this.chatGlide && !this.findOpen && this.mode === "chat") this.chatScroll.scrollTop = this.chatScroll.scrollHeight;
  this.updateChatJump();
 }
 /** The chat jump button's tap (ChatView.swift:636-639), ChatScrollPosition.animateToLatest
  *  (ChatScrollPosition.swift:42-57): from more than two screens away it first snaps to one
  *  screen above the tail, then glides the last screen in 0.3 s ease-out. The tail counts as
  *  reached at once, so the button and the composer fade go now and following resumes.
  *  Reduce Motion (a 0 s glide) jumps. */
 glideChatToLatest(motion?: { seconds: number; curve: (x: number) => number }) {
  const scroll = this.chatScroll, seconds = motion ? motion.seconds : motionSeconds("glide"), curve = motion?.curve ?? easeOut;
  const bottom = () => scroll.scrollHeight - scroll.clientHeight;
  this.stopChatGlide(); this.chatFollowing = true;
  if (!seconds || Math.abs(bottom() - scroll.scrollTop) <= 0.5) { this.followChat(); return; }
  if (bottom() - scroll.scrollTop > 2 * scroll.clientHeight) scroll.scrollTop = bottom() - scroll.clientHeight;
  const from = scroll.scrollTop, start = performance.now();
  const step = (now: number) => {
   if (this.findOpen || this.mode !== "chat") { this.stopChatGlide(); return; }
   const progress = Math.min(1, (now - start) / (seconds * 1000));
   // The tail is read every frame, so output arriving mid-glide extends the glide.
   scroll.scrollTop = from + (bottom() - from) * curve(progress);
   if (progress < 1) this.chatGlide = requestAnimationFrame(step);
   else { this.chatGlide = 0; this.followChat(); }
  };
  this.chatGlide = requestAnimationFrame(step);
  this.updateChatJump();
 }
 stopChatGlide() { cancelAnimationFrame(this.chatGlide); this.chatGlide = 0; }
 /** Shown while the reader is scrolled back from the live tail and hidden at it
  *  (`!terminalAtTail`, HerdrApp.swift:5856, GuestPaneView.swift:470). xterm's viewport is
  *  at the tail when its top row is the buffer's base. */
 updateTerminalJump() {
  const buffer = this.terminal?.buffer.active;
  this.terminalJump.hidden = !buffer || buffer.viewportY >= buffer.baseY;
 }
 /** LiveTerminalView.jumpToTail (LiveTerminalView.swift:1870-1916), not animated: a mouse-mode
  *  or alternate-screen agent keeps its own viewport, so the owner sends it Ctrl+End; a guest
  *  is view-only and sends nothing. The local scrollback returns to the tail either way, which
  *  is where native's (wheel-forwarding) view already is in the Ctrl+End case. */
 jumpTerminalToTail() {
  const term = this.terminal;
  if (!term) return;
  if (this.terminalTyping && (term.buffer.active.type === "alternate" || term.modes.mouseTrackingMode !== "none")) this.queueTerminalInput("\x1b[1;5F");
  term.scrollToBottom();
  this.updateTerminalJump();
 }
 dismissChatSheets() {
  this.subagentSheet?.close(); this.questionSheet?.close(); this.noteSheet?.close(); this.selectionSheet?.close();
  this.guestShareSheet?.close(); this.guestShareSheet = null;
  this.messageMenu = null;
 }
 stopSurface() {
  closeWriter(); this.generation++;
  clearInterval(this.statusTimer);
  this.dismissChatSheets();
  this.editor?.dispose(); this.editor = null;
  this.stopFileDrop?.(); this.stopFileDrop = null;
  this.stopClipboardPaste?.(); this.stopClipboardPaste = null;
  this.chatResize?.disconnect(); this.chatResize = null; this.stopChatGlide();
  this.prompts.dispose();
  this.dictation.dispose();
  this.composerResize?.disconnect(); this.composerResize = null;
  this.column.dispose();
  clearTimeout(this.refreshTimer);
  clearInterval(this.subagentTick); this.subagentTick = undefined;
  clearTimeout(this.resizeTimer);
  clearTimeout(this.historyTimer); this.historyRequest++;
  this.resize?.disconnect(); this.resize = null;
  this.fitTerminal = null;
  this.terminalReady = false;
  this.prediction?.dispose(); this.prediction = null;
  this.disposeTerminal(); this.fit = null;
 }
 dispose() { this.disposed = true; this.topics?.dispose(); this.stopSurface(); this.stored(this.draft.flush()); this.queuedSend?.cancel(); this.draft.detach(this.draftView); void Desk.closeAgentView(this.token); }
 /** Topics' text follows the chat's size. */
 textSurface(): TextSurface { return this.mode === "terminal" ? "terminal" : "chat"; }
 // A saved terminal's view from an older desk carries no list (#531): null is none.
 topicsAvailable(): boolean { return topicsShown(this.topicsCapable, this.topicsOffer, !!this.view?.topicSessions?.length); }
 resolvedMode(): ChatMode { return resolvedMode(this.asked, this.chatAvailable, this.topicsAvailable()); }
 mountTopics(view: AgentView) {
  const pane = new TopicsPane({
   token: this.token, guest: view.guest, guestSelf: view.guestSelf ?? "", agentName: view.name,
   topicSessions: view.topicSessions,
   renderRow: (row, unfolded) => this.renderRow(row, unfolded),
   // The Inbox's own cards, drawn into the topic's transcript; a topic's subagents don't open.
   renderPlan: (items, container, session) => this.renderPlan(items, container, session),
   renderSubagents: (agents, container) => this.renderSubagents(agents, container, false),
   renderOutgoing: message => this.renderOutgoing(message),
   openInbox: () => { void this.chooseMode("chat"); },
   // The page's one composer, lent to the open topic (null: it closed): placed and sent there.
   composer: target => { this.topicComposer = target; this.placeComposer(); },
   symbol: (name, size, weight) => symbol(name, size, weight),
  });
  pane.root.hidden = true;
  pane.setInboxPreview(boardActivity(lastBoard, this.target.paneID));
  this.topics = pane; this.body.append(pane.root);
 }
 /** The agent's topics changed (Go's TopicsChanged): the list, and whether the page offers them;
  *  an agent that stops offering them goes back to Chat (#745 onChange(of: showsTopics)). */
 applyTopics(update: TopicsUpdate) {
  if (!this.topics) return;
  const offered = this.topicsAvailable();
  this.topicsOffer = nextTopicsOffer(this.topicsOffer, update);
  this.topics.apply(update);
  // Every list answer reaches the Inbox: the server's state wins over a local Start / Not now line.
  this.listedSuggestions = update.suggestions ?? []; this.suggestionsServed = update.suggestionsServed;
  this.settledSuggestions = yieldSettled(this.settledSuggestions, this.listedSuggestions, update.requestedMs);
  if (this.mode === "chat" && this.chat) this.drawChat(false);
  this.topicsButton.hidden = !this.topicsAvailable();
  if (offered !== this.topicsAvailable() && this.resolvedMode() !== this.mode) void this.switchMode(this.resolvedMode());
 }
 async chooseMode(mode: ChatMode) {
  modeChoices.set(JSON.stringify(this.target), mode);
  this.asked = mode;
  await this.switchMode(this.resolvedMode());
 }
 async switchMode(mode: ChatMode) {
  const generation = this.generation;
  this.prediction?.reset();
  this.mode = mode; this.status.textContent = "";
  this.placeComposer();
  if (mode !== "chat") this.dismissChatSheets();
  // The Topics list has its own search (#745: no Find over Topics).
  if (mode === "topics" && this.findOpen) this.toggleFind(false);
  if (this.findToggle) this.findToggle.hidden = mode === "topics";
  this.topicsButton.setAttribute("aria-pressed", String(mode === "topics"));
  if (this.topics) {
   this.topics.root.hidden = mode !== "topics"; this.topics.show(mode === "topics");
   // iOS ChatView: the open Inbox follows the list while the agent's suggestions are served (Go decides).
   void Desk.topicsFollowInbox(this.token, mode === "chat").catch(() => undefined);
  }
  this.body.dataset.mode = mode;
  this.updateGuestQuestion();
  this.setCtrl(false);
  this.column.setVisible(mode === "chat");
  this.chatButton.setAttribute("aria-pressed", String(mode === "chat"));
  this.terminalButton.setAttribute("aria-pressed", String(mode === "terminal"));
  this.chatSurface.hidden = mode !== "chat";
  this.updateChatJump();
  this.terminalSurface.inert = mode !== "terminal";
  this.terminalSurface.setAttribute("aria-hidden", String(mode !== "terminal"));
  this.terminalSurface.classList.toggle("covered", mode !== "terminal");
  clearTimeout(this.refreshTimer);
  if (!this.mounted) {
   this.mounted = true;
   this.body.append(this.terminalSurface, this.chatSurface, ...this.column.handles, this.column.readout);
   this.openChat(generation);
   if (mode === "terminal") await this.ensureTerminal(generation);
  } else if (mode === "chat") {
   // A chat restored from memory while Terminal showed (openChat draws only in Chat) draws now,
   // at its tail, rather than after the read (review of #212).
   if (this.chat && !this.transcript.querySelector("[data-id]")) this.drawChat();
   void this.refreshChat(generation);
  } else if (mode === "topics") {
   // Topics draws from Go's list (TopicsChanged); nothing to read here.
  } else if (!this.terminalOpened) {
   await this.ensureTerminal(generation);
  } else {
   this.terminal?.focus();
  }
  this.relayout();
 }
 /** Opens the terminal the first time it is shown (herdrup slow-network fix 6): under Chat its
  *  stream, backfill and input stream would compete with the chat's first page on the link. */
 async ensureTerminal(generation: number) {
  if (this.terminalOpened) return;
  this.terminalOpened = true;
  if (this.guestPaused) await this.reconnectTerminal();
  else { this.terminalStartup = this.openTerminal(generation); await this.terminalStartup; }
 }
 // One reconnect at a time: a refresh while one runs joins it rather than opening a second stream.
 // A terminal not yet shown has nothing to reconnect: it opens fresh when shown.
 reconnectTerminal(): Promise<void> {
  if (!this.terminalOpened) return Promise.resolve();
  this.terminalReconnect ??= this.replaceTerminal().finally(() => {
   this.terminalReconnect = null;
   // The share paused or resumed while this one ran: follow it.
   if (!this.disposed && !!this.guestPaused !== this.terminalPaused) void this.reconnectTerminal();
  });
  return this.terminalReconnect;
 }
 /** Ends the terminal, remembering its screen first (terminalMemory.ts) when the stream drew one:
  *  every teardown goes through here, so the memory is the latest screen seen (review of #213). */
 disposeTerminal() {
  if (this.terminal && this.terminalShown) rememberScreen(JSON.stringify(this.target), screenText(this.terminal));
  this.terminal?.dispose(); this.terminal = null;
 }
 async replaceTerminal() {
  if (this.terminalStartup) await this.terminalStartup;
  if (this.disposed) return;
  this.terminalReady = false;
  clearTimeout(this.resizeTimer);
  clearTimeout(this.historyTimer); this.historyRequest++;
  this.resize?.disconnect(); this.resize = null;
  this.fitTerminal = null;
  this.prediction?.dispose(); this.prediction = null;
  this.disposeTerminal();
  await Desk.stopTerminal(this.token, this.terminalID);
  if (this.disposed) return;
  this.terminalSurface.replaceChildren();
  this.terminalPaused = !!this.guestPaused;
  if (this.guestPaused) {
   // Unmounted while paused, with the centre message in its place (GuestPaneView.swift:441-445, 487-491).
   this.terminalStartup = null; this.terminalID = "";
   const { icon, title, detail } = this.guestPaused.center;
   const card = el("div", "guest-home-message guest-paused-message");
   const disc = el("span", "guest-home-message-icon"); disc.append(await symbol(icon, 17, "semibold"));
   card.append(disc, el("strong", "", title), el("p", "", detail));
   if (!this.disposed) this.terminalSurface.replaceChildren(card);
   return;
  }
  this.terminalStartup = this.openTerminal(this.generation);
  await this.terminalStartup;
 }
 async openTerminal(generation: number) {
  const streamID = crypto.randomUUID(); this.terminalID = streamID;
  const canvas = el("div", "terminal-canvas");
  this.historyCursor = null; this.historyRequest++; this.historyLoading = false; this.historyArmed = false;
  this.historyButton.className = "terminal-history-load"; this.historyButton.hidden = true;
  this.terminalJump.hidden = true;
  this.terminalSurface.append(canvas, this.historyButton, this.terminalJump);
  // The screen as last seen, until the stream's first screen replaces it.
  this.terminalShown = false;
  this.lastScreen?.remove();
  const remembered = recallScreen(JSON.stringify(this.target));
  this.lastScreen = remembered ? el("pre", "terminal-last-screen", remembered) : null;
  if (this.lastScreen) { this.lastScreen.setAttribute("aria-hidden", "true"); this.lastScreen.style.fontSize = `${textSize("terminal")}px`; canvas.append(this.lastScreen); }
  const styles = getComputedStyle(document.documentElement);
  loadTerminalSymbols();
  // A guest never types into the terminal: herdr's guest gate refuses pane.send_text, so xterm's
  // input and its own replies (focus reports, DA/DSR) stay off (iOS guests send no terminal input);
  // so does a chat-scope web owner's. A terminal-scope owner's types (applyTerminalTyping).
  // SearchAddon decorations require xterm's proposed decoration API.
  const term = new Terminal({ fontFamily: terminalFontFamily(styles.getPropertyValue("--font-machine")), fontSize: textSize("terminal"), scrollback: HISTORY_ROWS, allowProposedApi: true, theme: terminalTheme, disableStdin: !this.terminalTyping });
  this.terminal = term; this.fit = new FitAddon(); this.search = new SearchAddon(); this.sequence = new TerminalSequence(); this.inputFailed = false; this.streamGrid = null;
  term.options.linkHandler = { activate: (_event, uri) => { void Desk.openExternalURL(uri).catch(e => { this.status.textContent = errorText(e); }); } };
  term.loadAddon(this.fit); term.loadAddon(this.search);
  this.search.onDidChangeResults(result => {
   if (this.mode === "terminal" && this.findOpen) this.findCount.textContent = result.resultCount ? `${result.resultIndex + 1} of ${result.resultCount}` : "No matches";
  });
  term.loadAddon(new WebLinksAddon((_event, uri) => { void Desk.openExternalURL(uri).catch(e => { this.status.textContent = errorText(e); }); }));
  term.open(canvas);
  this.prediction = new TerminalPrediction(term, this.target.machineID);
  const armHistory = () => { this.historyArmed = true; this.updateHistoryPaging(true); };
  canvas.addEventListener("wheel", event => { if (event.deltaY < 0) armHistory(); }, { passive: true });
  canvas.addEventListener("touchmove", armHistory, { passive: true });
  canvas.addEventListener("pointerdown", event => {
   if (event.target instanceof Element && event.target.closest(".scrollbar")) armHistory();
  });
  // New output and the reader's own scrolling both move the viewport against the tail.
  term.onScroll(() => { this.updateHistoryPaging(true); this.updateTerminalJump(); });
  term.onWriteParsed(() => { this.updateHistoryPaging(); this.updateTerminalJump(); });
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
   // Once the host refused guest resizing it stays on its own grid: draw that grid and propose
   // nothing more (LiveTerminalView.fitsStreamWidth, GuestPaneView.swift:442).
   if (this.resizeRefused) { this.keepStreamGrid(); this.updateHistoryPaging(); this.updateTerminalJump(); return; }
   this.fit?.fit();
   this.updateHistoryPaging(); this.updateTerminalJump();
   // Answered under the scope it was sent under: a refusal from before a scope change (a
   // renewal) says nothing about the new grant (applyOwnerScope).
   const scopeAsked = this.scopeGeneration;
   void Desk.terminalSize(this.token, streamID, term.cols, term.rows).catch(e => {
    if (generation !== this.generation || streamID !== this.terminalID || scopeAsked !== this.scopeGeneration) return;
    if (this.view?.guest && refusesResize(String(e))) { this.resizeRefused = true; this.keepStreamGrid(); this.updateGuestQuestion(); return; }
    const message = errorText(e);
    this.status.textContent = this.view?.guest && isRelayRateLimited(message) ? RELAY_RECONNECTING : "Resize: " + message;
   });
  };
  this.fitTerminal = fit;
  this.resize = new ResizeObserver(() => { clearTimeout(this.resizeTimer); this.resizeTimer = window.setTimeout(fit, 120); });
  this.resize.observe(canvas);
  try { await Desk.startTerminal(this.token, streamID); if (generation !== this.generation || streamID !== this.terminalID || this.disposed) return; this.terminalReady = true; fit(); if (this.mode === "terminal") term.focus(); }
  catch(e) {
   if (generation !== this.generation || streamID !== this.terminalID || this.disposed) return;
   // Refused at the start because the agent isn't running (guest_paused, a chat-scope owner's
   // owner_paused): paused, as when the stream ends for it (frame), not an error line.
   if (this.view?.guest && isGuestPaused(errorText(e))) this.applyGuestAvailability("paused");
   else this.status.textContent = errorText(e);
  }
 }
 frame(event: { streamID: string; frame?: ByteFrame; error?: string; reconnect?: boolean }) {
  if (!this.terminal || event.streamID !== this.terminalID) return;
  if (event.error && this.view?.guest && isGuestPaused(event.error)) { this.applyGuestAvailability("paused"); return; }
  // herdr ended the stream for a slow or failed reader and asks for a new one (herdr #410): open
  // it quietly, once per STREAM_RECONNECT_MS; a second end inside that shows the error below.
  if (event.error && event.reconnect && Date.now() - this.streamReconnectAt > STREAM_RECONNECT_MS) {
   this.streamReconnectAt = Date.now(); this.prediction?.reset(); this.terminalReady = false;
   void this.reconnectTerminal();
   return;
  }
  if (event.error) { this.prediction?.reset(); this.status.textContent = "Terminal disconnected: " + event.error; this.terminalReady = false; this.updateHistoryPaging(true); return; }
  const f = event.frame; if (!f) return;
  if (!this.sequence.accept(f)) { this.prediction?.reset(); this.status.textContent = "Terminal stream changed. Reconnect to obtain a fresh screen."; this.terminalReady = false; this.updateHistoryPaging(true); return; }
  try {
   if (f.frame === "reset") {
    this.lastScreen?.remove(); this.lastScreen = null; this.terminalShown = true;
    this.historyRequest++; this.historyLoading = false; this.historyArmed = false; this.historyRetryAt = 0;
    clearTimeout(this.historyTimer);
    this.prediction?.reset();
    this.terminal.reset();
    if (f.cols && f.rows) { this.streamGrid = { cols: f.cols, rows: f.rows }; this.terminal.resize(f.cols, f.rows); }
    if (f.history_b64) this.terminal.write(bytes(f.history_b64));
    this.terminal.write(bytes(f.data_b64)); this.historyCursor = f.history_cursor ?? null;
   } else if (f.frame === "data") {
    const prediction = this.prediction, data = bytes(f.data_b64);
    if (data.length) prediction?.outputReceived();
    this.terminal.write(data, () => { if (data.length) prediction?.outputParsed(); });
   }
   else if (f.frame === "resize" && f.cols && f.rows) { this.streamGrid = { cols: f.cols, rows: f.rows }; this.terminal.resize(f.cols, f.rows); }
   else if (f.frame === "exited") { this.prediction?.reset(); this.status.textContent = "Pane exited."; this.terminalReady = false; }
  } catch(e) { this.prediction?.reset(); this.status.textContent = "Invalid terminal frame: " + errorText(e); this.terminalReady = false; }
  this.updateHistoryPaging(); this.updateTerminalJump();
 }
 /** A refused guest's terminal back on the host's grid, whatever the window fitted it to. */
 private keepStreamGrid() {
  const grid = this.streamGrid, term = this.terminal;
  if (grid && term && (term.cols !== grid.cols || term.rows !== grid.rows)) term.resize(grid.cols, grid.rows);
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
   this.prediction?.reset();
   const inserted = await prependTerminalHistory(term, bytes(page.history_b64), current);
   if (inserted === null) return;
   this.historyCursor = inserted === 0 && page.history_b64 ? null : page.cursor ?? null;
  } catch(error) {
   if (current()) { this.status.textContent = `Earlier output: ${errorText(error)}`; this.historyRetryAt = Date.now() + 2000; }
  } finally {
   if (request === this.historyRequest) { this.historyLoading = false; this.updateHistoryPaging(true); }
  }
 }
 renderAttachments() {
  this.attachmentStrip.hidden = this.attachments.length === 0;
  const failed = (error: unknown) => { if (!this.disposed) this.composerNote(errorText(error)); };
  this.attachmentStrip.replaceChildren(...this.attachments.map(file => composerAttachment(file, this.sending,
   () => { void Desk.paneRemoveAttachment(this.token, file.path).catch(failed); },
   () => { void Desk.paneRetryAttachment(this.token, file.path).catch(failed); })));
  this.relayout();
 }
 async pickFiles(paths?: string[]) {
  if (this.disposed || this.sending || this.picking || !this.token) return;
  this.picking = true; this.attach.disabled = true;
  try { if (paths) await Desk.paneAttachFiles(this.token, paths); else await Desk.panePickFiles(this.token); }
  catch(error) { if (!this.disposed) this.composerNote(errorText(error)); }
  finally { this.picking = false; this.attach.disabled = this.sending || !!this.guestPaused; }
 }
 openChat(generation: number) {
  this.entries = []; this.drawFrom = null; this.drawnIndex = 0; this.openRows.clear(); this.unfoldedRelays.clear(); this.chat = null; this.oldestCursor = undefined; this.chatEpoch++; this.historyEpoch++; this.sendFollow = null; this.outgoing = []; this.olderLoad = "idle"; this.topReached = false;
  this.answerProblem = null; this.localAnswers.clear(); this.localDismissed.clear();
  this.input.disabled = this.fieldDisabled(); this.send.disabled = this.sending || !!this.guestPaused;
  const composer = this.composerCard = el("div", "chat-composer");
  const actions = el("div", "composer-actions");
  this.attach.className = "composer-action";
  this.send.className = "composer-action primary";
  if (!this.plainTerminal) actions.append(this.attach);
  actions.append(this.dictation.button);
  this.send.replaceChildren(composerGlyph("send", 22)); this.send.setAttribute("aria-label", this.plainTerminal ? "Write to terminal" : "Send reply");
  this.prompts.mount(actions); actions.append(this.send);
  this.attachmentStrip.hidden = true;
  composer.append(this.attachmentStrip, this.dictation.strip, this.input, actions);
  if (!this.plainTerminal) {
   this.stopFileDrop = composerFileDrop(composer, paths => { void this.pickFiles(paths); });
   this.stopClipboardPaste = composerClipboardPaste(this.input, () => Desk.panePasteClipboard(this.token), error => {
    if (!this.disposed) this.composerNote(errorText(error));
   });
  }
  this.mountKeys();
  const probe = el("div", "composer-text-probe");
  composer.append(probe);
  let wrapped = false;
  const layout = () => {
   if (!this.editor || !composer.isConnected) return;
   const hasContent = this.input.value.trim().length > 0 || this.attachments.length > 0;
   this.send.hidden = !hasContent; this.prompts.button.hidden = hasContent;
   this.column.update();
   const width = composer.clientWidth - 26;
   // Lines are counted at the drawn pitch; the field is ComposerStyle.lineHeight per line.
   const lineHeight = COMPOSER_LINE;
   const measure = (w: number) => composerLines(probe, this.input.value, w, COMPOSER_TEXT_PITCH);
   const inline = width - actions.offsetWidth - 4;
   wrapped = composerExpanded(false, measure, inline, wrapped);
   const stacked = this.editor!.open || this.attachments.length > 0 || (!this.dictation.strip.hidden && !!this.input.value) || wrapped;
   composer.classList.toggle("expanded", stacked);
   const lines = measure(stacked ? width : inline);
   // Swift gives the writer the warm terminal's room, including its key-row allowance; under a
   // topic, the room its conversation leaves.
   const topic = this.sendsToTopic();
   const room = topic ? topic.room() : this.terminalSurface.clientHeight;
   this.input.style.height = `${this.editor!.update(lines, room, lineHeight)}px`;
   // Under a topic the composer and its lines sit in the topic's column, in flow.
   if (topic) { composer.style.bottom = ""; this.fitPromptBubbles(); return; }
   // The lines under the composer: the composer and what stands on it move up by them.
   const unsentHeight = this.composerLines.hidden ? 0 : this.composerLines.offsetHeight;
   composer.style.bottom = `${unsentHeight}px`;
   const composerHeight = composer.offsetHeight + 12 + unsentHeight;
   this.body.style.setProperty("--composer-height", `${composerHeight}px`);
   // The note takes layout height, as in herdrup (it is part of bottomChromeHeight there).
   this.body.style.setProperty("--note-height", `${this.status.offsetHeight}px`);
   this.fitPromptBubbles();
  };
  this.editor = new ComposerEditor(composer, this.input, layout);
  this.input.oninput = layout;
  this.relayout = layout;
  this.composerResize = new ResizeObserver(layout);
  this.composerResize.observe(composer);
  this.composerResize.observe(this.body);
  this.composerResize.observe(this.chatSurface);
  this.composerResize.observe(this.status);
  this.chatFollowing = true;
  this.chatJump.hidden = true; this.chatJumpMine.hidden = true;
  // The up arrow sits in the body, over the composer's column (placement C), not in the chat.
  this.chatScroll.append(this.transcript); this.chatSurface.append(this.chatScroll, this.chatJump); this.body.append(this.chatJumpMine);
  // The glide owns the offset until it lands; it counts as at the tail from the tap.
  this.chatScroll.onscroll = () => { if (!this.chatGlide) this.chatFollowing = this.chatAtBottom(); this.updateChatJump(); this.checkTop(); };
  // The reader's own wheel or drag ends a glide still running, rather than fighting it. A wheel up
  // at the top asks for earlier messages again (a page that left the top in view reveals only).
  this.chatScroll.onpointerdown = () => {
   if (!this.chatGlide) return;
   this.stopChatGlide(); this.chatFollowing = this.chatAtBottom(); this.updateChatJump();
  };
  this.chatScroll.onwheel = (e: WheelEvent) => {
   if (this.chatGlide) { this.stopChatGlide(); this.chatFollowing = this.chatAtBottom(); this.updateChatJump(); }
   if (e.deltaY < 0) this.checkTop(true);
  };
  this.chatResize = new ResizeObserver(() => this.followChat());
  this.chatResize.observe(this.transcript); this.chatResize.observe(this.chatScroll);
  // In the body, or under the open topic when the page opens on Topics.
  this.placeComposer();
  // The chat as last read draws at once; the first read asks only for what came after it.
  const remembered = recallChat(JSON.stringify(this.target));
  if (remembered) {
   this.chat = remembered.page; this.entries = remembered.entries; this.oldestCursor = remembered.oldestCursor;
   if (this.mode === "chat") this.drawChat();
  }
  if (this.mode === "chat") void this.refreshChat(generation);
 }
 // The latest call owns the poll: an earlier reply still in flight is dropped and schedules nothing.
 async refreshChat(generation: number) {
  const epoch = this.chatEpoch, poll = ++this.chatPoll;
  clearTimeout(this.refreshTimer);
  try {
   // held_from: the oldest page held, "" once nothing is older (herdr #430). A server without
   // `resent` may re-send a prompt the chat has not loaded: readLive reads the newest page then.
   const stale = () => this.disposed || generation !== this.generation || epoch !== this.chatEpoch || poll !== this.chatPoll;
   const live = await readLive(this.chat, () => ({ entries: this.entries, hasOlder: !!this.oldestCursor }), async after => {
    const read: TranscriptPage = JSON.parse(await Desk.chatTranscript(this.token, after, "", "", after ? this.oldestCursor ?? "" : ""));
    return stale() ? null : read;
   });
   if (!live) return;
   const page = live.page;
   // What the page held before this read, older history included: only the live tail's new user
   // entries can be the send.
   const held = new Set(this.entries.map(entry => entry.id));
   if (live.reset) {
    if (this.chat && this.chat.session_id !== page.session_id) this.outgoing = [];
    this.entries = []; this.drawFrom = null; this.drawnIndex = 0; this.openRows.clear(); this.oldestCursor = page.before; this.historyEpoch++;
    this.answerProblem = null; this.localAnswers.clear(); this.formStates.clear(); this.localFormAnswers.clear(); this.localDismissed.clear();
   }
   // mergeTranscript drops re-sent older history a live page lists (liveEntries), so the send
   // checks below read the merged entries: an old prompt with the same words is not the send.
   this.entries = live.entries; this.chat = page; this.chatFailed = false;
   // Only a guest of a host older than guest answers is ever withheld an answerable question
   // (ChatView.swift:262-263).
   if (withheldFromCaller(page.pending_ask)) this.refuseAnswers();
   for (const entry of this.entries) {
    if (entry.kind !== "ask") continue;
    if (entry.answer) this.localAnswers.delete(entry.id);
    if (entry.form_answer || entry.form_status) { this.localFormAnswers.delete(entry.id); this.formStates.delete(entry.id); this.localDismissed.delete(entry.id); }
   }
   if (this.sendFollow && sendShown(held, this.entries)) this.sendFollow = null;
   this.outgoing = reconcileOutgoing(this.outgoing, held, this.entries, Date.now());
   if (this.status.textContent === RELAY_RECONNECTING) this.status.textContent = "";
   this.drawChat();
   // A chat whose rows do not fill the view never scrolls: its top is in view as it lands.
   requestAnimationFrame(() => this.checkTop());
   rememberChat(JSON.stringify(this.target), { page: this.chat, entries: this.entries, oldestCursor: this.oldestCursor });
  } catch(e) {
   if (!this.disposed && generation === this.generation && poll === this.chatPoll) {
    const message = errorText(e);
    this.status.textContent = this.view?.guest && isRelayRateLimited(message) ? RELAY_RECONNECTING : "Chat: " + message + " You can switch to Terminal.";
    if (!this.chatFailed) { this.chatFailed = true; if (this.chat) this.drawChat(false); }
   }
  }
  finally {
   if (!this.disposed && !this.guestPaused && this.mode === "chat" && generation === this.generation && epoch === this.chatEpoch && poll === this.chatPoll) {
    const delay = chatPollDelay({ guest: !!this.view?.guest, working: !!this.chat?.working, sendPending: !!this.sendFollow, followUntil: this.sendFollow?.until ?? 0, now: Date.now() });
    this.refreshTimer = window.setTimeout(() => { void this.refreshChat(generation); }, delay);
   }
  }
 }
 /** Rows above the drawn window, loaded or not (as of the last draw: this runs on every scroll). */
 hasEarlier(): boolean {
  return !!this.oldestCursor || this.drawnIndex > 0;
 }
 /** Reaching the top of the chat (ChatView showOlder): the next window of rows already loaded,
  *  else the next older page. A fetch goes when the reader arrives at the top (or wheels up
  *  there): a page that still leaves the top in view reveals only, as on iPhone, so one arrival
  *  never walks the whole history. Then the top offers "Earlier messages" to tap (herdrup-desktop
  *  #239): rows that do not fill the view never scroll, and a touch has no wheel. `force`: the
  *  reader asked again (a wheel up at the top). */
 checkTop(force = false) {
  if (this.disposed || this.mode !== "chat" || !this.chat) return;
  const s = this.chatScroll;
  const at = { scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, following: this.chatFollowing, finding: this.findOpen };
  const reached = topAction({ ...at, drawnStart: 0, olderPage: true, load: "idle", fetches: true }) === "fetch";
  const arrived = reached && (force || !this.topReached);
  this.topReached = reached;
  const action = topAction({ ...at, drawnStart: this.drawnIndex, olderPage: !!this.oldestCursor, load: this.olderLoad, fetches: arrived });
  this.earlierOffered = action === "offer";
  this.renderEarlier();
  if (action === "reveal") this.revealEarlier();
  else if (action === "fetch") void this.loadEarlier(this.generation);
 }
 private topReached = false;
 private earlierOffered = false;
 /** The next window of loaded rows above the drawn ones; the row on top stays where it was. */
 revealEarlier() {
  const rows = this.chatRows();
  const start = drawnStart(rows, this.drawFrom);
  if (start === 0) return;
  const oldHeight = this.chatScroll.scrollHeight;
  this.chatFollowing = false;
  this.drawFrom = revealedAbove(rows, windowStarting(rows, start));
  this.drawChat(false); this.chatScroll.scrollTop += this.chatScroll.scrollHeight - oldHeight;
 }
 /** The next window of rows already loaded, else the page before the oldest loaded one (the up
  *  arrow's walk); either way the row on top stays where it was. True when rows were added. */
 async showEarlier(generation: number): Promise<boolean> {
  const rows = this.chatRows();
  // Find draws every loaded row: only the older page adds any.
  const start = this.findOpen ? 0 : drawnStart(rows, this.drawFrom);
  if (start === 0) return this.loadEarlier(generation);
  this.revealEarlier();
  return true;
 }
 /** Loads the page before the oldest one shown and draws a window more of it; true when it did.
  *  The top shows "Loading earlier messages" meanwhile, and a Retry when it failed. A page that
  *  lands after the chat started its history over (historyEpoch) belongs to history it no longer
  *  holds, and is dropped (#241). */
 async loadEarlier(generation: number): Promise<boolean> {
  if (!this.chat || !this.oldestCursor || this.olderLoad === "loading") return false;
  const session = this.chat.session_id;
  const epoch = this.chatEpoch, history = this.historyEpoch;
  const current = () => !this.disposed && generation === this.generation && epoch === this.chatEpoch && history === this.historyEpoch && this.chat?.session_id === session;
  this.olderLoad = "loading"; this.renderEarlier();
  try {
   const page: TranscriptPage = JSON.parse(await Desk.chatTranscript(this.token, "", this.oldestCursor!, "", ""));
   if (!current() || page.session_id !== session) { if (epoch === this.chatEpoch) { this.olderLoad = "idle"; this.renderEarlier(); } return false; }
   this.olderLoad = "idle";
   const oldHeight = this.chatScroll.scrollHeight;
   this.chatFollowing = false;
   const before = this.chatRows();
   const top = windowStarting(before, drawnStart(before, this.drawFrom));
   this.entries = mergeTranscript(this.entries, page.entries, { older: true }); this.oldestCursor = page.before;
   rememberChat(JSON.stringify(this.target), { page: this.chat!, entries: this.entries, oldestCursor: this.oldestCursor });
   this.drawFrom = revealedAbove(this.chatRows(), top) ?? this.drawFrom;
   this.drawChat(false); this.chatScroll.scrollTop += this.chatScroll.scrollHeight - oldHeight;
   // A page that leaves the top in view offers the next one (checkTop never fetches it itself).
   requestAnimationFrame(() => this.checkTop());
   return true;
  } catch {
   if (epoch === this.chatEpoch) { this.olderLoad = current() ? "failed" : "idle"; this.renderEarlier(); }
   return false;
  }
 }
 /** The top of the chat as olderLoad says: nothing while idle, the loading line, or the Retry;
  *  idle at the top with older pages left that no scroll will reach, "Earlier messages". */
 renderEarlier() {
  const e = this.earlier;
  const state = this.olderLoad === "idle" && this.earlierOffered && this.oldestCursor ? "offer" : this.olderLoad;
  e.hidden = state === "idle";
  if (e.dataset.state === state) return;
  e.dataset.state = state;
  if (state === "loading") {
   e.replaceChildren(el("span", "chat-earlier-spinner"), el("span", "", "Loading earlier messages"));
   e.setAttribute("role", "status");
  } else if (state === "failed") {
   e.replaceChildren(Object.assign(button("Couldn't load earlier messages · Retry", () => { this.olderLoad = "idle"; void this.loadEarlier(this.generation); }), { className: "button-plain button-compact" }));
   e.removeAttribute("role");
  } else if (state === "offer") {
   e.replaceChildren(Object.assign(button("Earlier messages", () => { void this.loadEarlier(this.generation); }), { className: "button-plain button-compact" }));
   e.removeAttribute("role");
  } else e.replaceChildren();
 }
 /** Find closed: Find drew every loaded row, so the window now starts no lower than the row on
  *  screen, which stays where it is. */
 pinWindowToView() {
  if (!this.chat || this.mode !== "chat") return;
  const rows = this.chatRows();
  const viewTop = this.chatScroll.getBoundingClientRect().top;
  const anchor = [...this.transcript.children].find((node): node is HTMLElement =>
   node instanceof HTMLElement && !!node.dataset.id && node.getBoundingClientRect().bottom > viewTop);
  const index = anchor ? rows.findIndex(row => row.id === anchor.dataset.id) : -1;
  if (!anchor || index < 0) return;
  const top = anchor.getBoundingClientRect().top;
  this.drawFrom = windowStarting(rows, Math.min(index, drawnStart(rows, this.drawFrom)));
  this.drawChat(false);
  this.chatScroll.scrollTop += anchor.getBoundingClientRect().top - top;
 }
 /** The Inbox's rows: the transcript's, with the agent's topic suggestions (herdrup #788). */
 chatRows(): (ChatRow | SuggestionRow)[] {
  return inboxRows(groupTranscript(this.entries, !!this.chat?.working), this.listedSuggestions, this.settledSuggestions);
 }
 /** A suggestion's card or line, or the "<Title> starts here" mark (ChatTopicSuggestion.swift).
  *  Owner picks 2026-11-24: the card is Before's (1182f1e4) outlined card with the message count's
  *  glyph, Not now and Start as capsules, and a Start or Not now that failed as a faint line in the
  *  card (items 8, 9); "Continued in topic" is the Apple-clean quiet line with the topic's name as a
  *  tinted link (item 10). `interactive`: the Inbox, where Start and Not now act (owner and guest alike). */
 renderSuggestionRow(row: SuggestionRow, interactive: boolean): HTMLElement {
  if (row.kind === "mark") {
   const mark = el("div", "chat-summary chat-suggestion-mark");
   mark.append(el("span", "chat-summary-rule"), el("span", "chat-summary-text", `${suggestionTitle(row.title)} starts here`), el("span", "chat-summary-rule"));
   return mark;
  }
  const s: ChatSuggestion = row.suggestion, title = suggestionTitle(s.title);
  if (s.state === "dismissed") return el("div", "chat-day chat-suggestion-dismissed", dismissedText(s));
  if (s.state === "accepted") {
   const line = el("p", "chat-suggestion-continued-row");
   const link = el("a", "chat-suggestion-continued", title);
   if (s.topicID) {
    const topicID = s.topicID;
    // The target names the topic (copied or opened elsewhere); a click here opens it in place.
    link.href = `#topic=${encodeURIComponent(topicID)}`; link.onclick = event => { event.preventDefault(); void this.openTopic(topicID); };
   }
   line.append("Continued in topic ", link); return line;
  }
  const card = el("div", "chat-message chat-suggestion-card");
  const head = el("p", "chat-suggestion-title"); head.append("New subject? Start a topic: ", el("strong", "", title));
  card.append(head);
  if (s.reason) card.append(el("p", "chat-suggestion-reason", s.reason));
  if (s.messageCount > 0) { const count = el("p", "chat-suggestion-count"); count.append(chatGlyph("text.bubble", 12, chatTextIcon), el("span", "", carriedText(s.messageCount))); card.append(count); }
  const problem = this.suggestionProblem?.id === s.id ? this.suggestionProblem.message : null;
  if (problem) {
   // In the card (Before, owner picks 2026-11-24, item 9), with its own Dismiss capsule.
   const note = el("div", "chat-suggestion-problem"); note.setAttribute("role", "status");
   const dismiss = button("Dismiss", () => { this.suggestionProblem = null; this.drawChat(false); }); dismiss.className = "chat-suggestion-problem-dismiss button-compact";
   note.append(el("span", "chat-suggestion-problem-text", problem), dismiss);
   card.append(note);
  }
  if (interactive) {
   const busy = this.suggestionBusy !== null;
   const later = button("Not now", () => { void this.settleSuggestion(s.id, false); }); later.className = "button-secondary"; later.disabled = busy;
   const start = button("Start", () => { void this.settleSuggestion(s.id, true); }); start.className = "button-filled"; start.disabled = busy;
   const actions = el("div", "chat-suggestion-actions"); actions.append(later, start); card.append(actions);
  }
  return card;
 }
 /** Start (accept_suggestion, then the topic opens) or Not now (dismiss_suggestion): a local line
  *  shows at once and yields to the server's state (ChatModel.settleLocally). */
 async settleSuggestion(id: string, start: boolean) {
  if (this.suggestionBusy) return;
  this.suggestionBusy = id; this.suggestionProblem = null; this.drawChat(false);
  let topicID = "";
  try {
   if (start) topicID = await Desk.topicsAcceptSuggestion(this.token, id);
   else await Desk.topicsDismissSuggestion(this.token, id);
   const line = settledLine(id, start ? "accepted" : "dismissed", topicID || undefined, this.listedSuggestions, this.entries, Date.now());
   if (line) this.settledSuggestions.set(id, line);
  } catch (error) {
   this.suggestionProblem = { id, message: (start ? "Couldn't start it: " : "Couldn't set it aside: ") + errorText(error) };
  }
  this.suggestionBusy = null;
  if (this.disposed) return;
  this.drawChat(false);
  if (topicID) void this.openTopic(topicID);
 }
 /** Opens a topic by id in the Topics view (a suggestion's Start, its "Continued in topic"). */
 async openTopic(topicID: string) {
  await this.chooseMode("topics");
  this.topics?.openTopic(topicID);
 }
 drawChat(follow = true) {
  // Disclosures by their row and place in it, so a row leaving the window and coming back keeps
  // every one's state, whether or not its renderer named it.
  for (const node of this.transcript.children) {
   if (!(node instanceof HTMLElement) || !node.dataset.id) continue;
   disclosures(node).forEach((d, i) => { const key = disclosureKey(d, node.dataset.id!, i); if (d.open) this.openRows.add(key); else this.openRows.delete(key); });
  }
  const opened = this.openRows;
  const rows = this.chatRows();
  // The window (chatWindow.ts): Find draws every loaded row, so all of them stay searchable; a
  // chat following its tail slides back to the newest rows; the first draw pins the top, so
  // rows arriving at the tail never push out what the reader sees.
  if (!this.findOpen) this.drawFrom = slidWindow(rows, this.drawFrom, follow && this.chatFollowing && !this.chatGlide);
  const windowStart = drawnStart(rows, this.drawFrom);
  // Pin the top (the first draw, or a top row that a merge above replaced) where it is drawn now.
  if (rows.length && (this.drawFrom === null || !rows.some(row => row.id === this.drawFrom))) this.drawFrom = windowStarting(rows, windowStart);
  const start = this.findOpen ? 0 : windowStart;
  this.drawnIndex = start;
  const now = new Date();
  const nodes = rows.slice(start).map(row => {
   const old = this.transcript.querySelector<HTMLElement>(`[data-id="${CSS.escape(row.id)}"]`);
   const signature = JSON.stringify(row.kind === "entry" && row.entry.kind === "ask" ? this.questionSignature(row, row.entry.id)
    : row.kind === "suggestion" ? [row, this.suggestionBusy === row.suggestion.id, this.suggestionProblem?.id === row.suggestion.id ? this.suggestionProblem.message : null]
    : row.kind === "mark" ? row : rowShown(row, now));
   if (old?.dataset.signature === signature) return old;
   const node = row.kind === "suggestion" || row.kind === "mark" ? this.renderSuggestionRow(row, true)
    : row.kind === "entry" && row.entry.kind === "ask" ? this.renderQuestion(row.entry, this.chat?.pending_ask) : this.renderRow(row);
   node.dataset.id = row.id; node.dataset.signature = signature;
   disclosures(node).forEach((d, i) => { d.open = opened.has(disclosureKey(d, row.id, i)); });
   return node;
  });
  this.renderEarlier();
  nodes.unshift(this.earlier);
  const pending = this.chat?.pending_ask;
  // The card shows unless its transcript row is drawn: a row above the window is not on the page.
  if (pending && pendingCardShown(rows, start, pending.id)) {
   // Kept attached while unchanged, as entry rows are: a form's Other or text field keeps its
   // focus and caret across polls.
   const id = `pending-ask:${pending.id}`, signature = JSON.stringify(this.questionSignature(null, pending.id));
   const old = this.transcript.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
   if (old?.dataset.signature === signature) nodes.push(old);
   else {
    const node = this.renderQuestion({ kind:"ask", id:pending.id, ts_ms:0, questions:pending.questions, form:pending.form }, pending);
    node.dataset.id = id; node.dataset.signature = signature;
    nodes.push(node);
   }
  }
  for (const message of this.outgoing) nodes.push(this.renderOutgoing(message));
  // A bubble the open topic still shows (its sends draw with renderOutgoing too) stays.
  for (const [id, node] of this.outgoingNodes) if (!this.outgoing.some(message => message.id === id) && !node.isConnected) this.outgoingNodes.delete(id);
  const plan = currentPlan(this.chat, this.entries);
  if (plan.length) nodes.push(this.renderPlan(plan));
  const agents = this.chat?.subagents ?? [];
  if (agents.length) nodes.push(this.renderSubagents(agents));
  const working = this.renderWorking();
  if (working) nodes.push(working);
  const recap = this.renderRecap();
  if (recap) nodes.push(recap);
  const model = this.renderModel();
  if (model) nodes.push(model);
  // Keep unchanged rows attached: detaching them on each poll loses keyboard focus.
  placeRows(this.transcript, nodes);
  this.fitPromptBubbles();
  if (follow) this.followChat();
  if (this.findOpen && this.mode === "chat") { const index = this.findIndex; this.updateFind(true, index, false); }
  this.refreshQuestion?.();
 }
 /** What a question card shows depends on: redraw it only when one of these changes. */
 private questionSignature(row: ChatRow | null, id: string): unknown[] {
  // A form's state appears on its first draw at version 0: count none as 0 too, or the first
  // unchanged poll would redraw the card and take the focus from a field being typed in.
  return [row, this.chat?.pending_ask, this.answering, this.answerProblem, this.localAnswers.get(id), this.answersRefused, this.formStates.get(id)?.version ?? 0, this.localFormAnswers.get(id), this.localDismissed.has(id), this.view?.askForm];
 }
 /** ChatView.sessionFooter's ChatWorkingDots (ChatWorkingDots.swift): while the agent works —
  * its board status, or with none yet the transcript's working turn — and the chat loads. */
 private renderWorking(): HTMLElement | null {
  const group = this.shownStatus[0];
  return this.tail.working(!this.guestPaused && !this.chatFailed && (group === "working" || (!group && !!this.chat?.working)), this.chat?.working?.intent || "");
 }
 /** ChatView.outgoingBubble: a prompt sent from here, at the tail until the transcript shows it,
  *  with its receipt under it. It enters once (motion spec §1.3: from opacity 0, 14 px down and
  *  96 % scale, anchored bottom-trailing); a later receipt cross-fades in 150 ms (§1.5). */
 private renderOutgoing(message: Outgoing): HTMLElement {
  const receipt = outgoingReceipt(message.state);
  const mode = motionMode();
  let node = this.outgoingNodes.get(message.id);
  if (node) {
   const line = node.querySelector<HTMLElement>(".chat-send-receipt")!;
   if (line.textContent !== receipt) {
    line.textContent = receipt;
    if (mode !== "still") line.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SPEC.receipt.duration });
   }
   return node;
  }
  node = el("article", "chat-message user chat-outgoing");
  if (message.text) {
   const bubble = el("div", "chat-user-text");
   bubble.append(el("span", "chat-user-content", message.text)); node.append(bubble);
   this.promptLayoutDirty = true;
  }
  // Its files, folded as they will be once sent; they open from the chat once the transcript
  // shows the prompt with their Gram ids.
  if (message.files.length) node.append(attachmentBundle(message.files.map(file => ({ ...file, messageID: "" }))));
  const line = el("span", "chat-send-receipt", receipt);
  line.setAttribute("role", "status");
  node.append(line);
  if (mode === "full") {
   node.animate([
    { opacity: 0, transform: "translateY(14px) scale(0.96)" },
    { opacity: 1, transform: "none" },
   ], { duration: SPEC.bubble.duration, easing: SPEC.bubble.ease });
  } else if (mode === "reduced") {
   node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SPEC.fade.duration });
  }
  this.outgoingNodes.set(message.id, node);
  return node;
 }
 /** ChatView.recapDivider: omp's recap of its last finished turn, above the model line, once the
  *  agent is done (no working turn, not working on the board) and no send of ours is still
  *  waiting to show. */
 private renderRecap(): HTMLElement | null {
  return this.tail.recap(this.chat?.recap, !this.chat?.working && this.shownStatus[0] !== "working" && !this.outgoing.length);
 }
 /** ChatView.sessionFooter's model line, under the conversation. */
 private renderModel(): HTMLElement | null { return this.tail.model(this.chat?.model); }
 private fitPromptBubbles() {
  const first = this.transcript.querySelector<HTMLElement>(".chat-message.user");
  const width = first?.getBoundingClientRect().width ?? 0;
  if (!width || (!this.promptLayoutDirty && width === this.promptLayoutWidth)) return;
  this.promptLayoutWidth = width; this.promptLayoutDirty = false;
  const bubbles = [...this.transcript.querySelectorAll<HTMLElement>(".chat-user-text")];
  for (const bubble of bubbles) {
   bubble.style.width = "";
   (bubble.firstElementChild as HTMLElement).style.width = "";
  }
  // Swift lays Text out at the proposed width, then sizes its background to the
  // resulting lines. Keep that proposal: narrowing Text again changes its wrap.
  const range = document.createRange();
  const measured = bubbles.map(bubble => {
   const content = bubble.firstElementChild as HTMLElement;
   const style = getComputedStyle(bubble), bounds = bubble.getBoundingClientRect();
   const left = parseFloat(style.paddingLeft), padding = left + parseFloat(style.paddingRight);
   range.selectNodeContents(content);
   let ink = 0;
   for (const line of range.getClientRects()) ink = Math.max(ink, line.right - bounds.left - left);
   return { bubble, content, proposal: Math.max(0, bounds.width - padding),
    fitted: Math.min(bounds.width, Math.ceil((ink + padding) * devicePixelRatio) / devicePixelRatio) };
  });
  for (const { bubble, content, proposal, fitted } of measured) {
   content.style.width = `${proposal}px`; bubble.style.width = `${fitted}px`;
  }
 }
 renderPlan(items: PlanItem[], container: HTMLElement = this.transcript, session = this.chat?.session_id): HTMLElement {
  const card = el("section", "chat-plan chat-message");
  // ChatView.swift's ChatStyle.ok is distinct from the shared agent-state green.
  card.style.setProperty("--chat-ok", "#7fc89a");
  card.dataset.session = session ?? "";
  const previous = container.querySelector<HTMLElement>(".chat-plan");
  let open = previous?.dataset.session === card.dataset.session && previous?.dataset.open === "true";
  const done = items.filter(planDone).length;
  const draw = () => {
   card.dataset.open = String(open);
   const toggle = button("", () => { const from = card.getBoundingClientRect().height; open = !open; draw(); animateHeight(card, from, "quick"); });
   toggle.className = "chat-plan-heading";
   toggle.setAttribute("aria-expanded", String(open));
   toggle.setAttribute("aria-label", `To-do, ${done} of ${items.length} done`);
   const chevron = el("span", "chat-plan-chevron");
   chevron.setAttribute("aria-hidden", "true");
   void symbol(open ? "chevron.down" : "chevron.right", 10, "bold").then(icon => chevron.append(icon));
   toggle.append(chevron, el("span", "", `TODO · ${done} OF ${items.length}`));
   if (!open && done === items.length) toggle.append(el("span", "chat-plan-complete", "✓ All done"));
   card.replaceChildren(toggle);
   const shown = open ? items.map((_, index) => index) : planWindow(items);
   shown.forEach((index, position) => {
    const item = items[index]!, completed = planDone(item);
    if (item.phase && (position === 0 || items[shown[position - 1]!]!.phase !== item.phase)) {
     const phase = el("div", "chat-plan-phase", item.phase);
     if (position > 0) phase.classList.add("continued");
     card.append(phase);
    }
    const row = el("div", "chat-plan-row");
    row.dataset.state = completed ? "completed" : item.status ?? "unknown";
    row.setAttribute("aria-label", `${item.text}: ${completed ? "Done" : item.status === "in_progress" ? "In progress" : item.status === "blocked" ? "Blocked" : "Pending"}`);
    const marker = el("span", "chat-plan-marker");
    marker.setAttribute("aria-hidden", "true");
    const name = completed ? "checkmark" : item.status === "in_progress" ? "arrow.right.circle.fill" : item.status === "blocked" ? "pause.circle" : "circle";
    if (completed || appleSymbols()) {
     void symbol(name, 12, "semibold").then(icon => marker.append(icon));
    } else {
     const icon = el("span", "chat-plan-fallback");
     const image = item.status === "in_progress" ? arrowCircleIcon : item.status === "blocked" ? pauseCircleIcon : circleIcon;
     icon.style.setProperty("--plan-icon", `url("${image}")`); marker.append(icon);
    }
    row.append(marker, el("span", "chat-plan-text", item.text)); card.append(row);
   });
   if (items.length > shown.length && done !== items.length) {
    const more = button(`+${items.length - shown.length} more`, () => { open = true; draw(); });
    more.className = "chat-plan-more"; card.append(more);
   }
  };
  draw(); return card;
 }
 /** ChatView.subagentsCard: omp's `task` subagents, each running one with what it does now and
  *  for how long, the finished ones folded into one line. An owner's row with a transcript opens
  *  that conversation read-only; a guest's rows do not open (herdr refuses them), nor a topic's
  *  (opens false: herdr reads a subagent beside the Inbox's session only). The card stays attached
  *  in its container while its subagents are unchanged, so a poll keeps a focused row focused. */
 renderSubagents(agents: TranscriptSubagent[], container: HTMLElement = this.transcript, opens = !this.view?.guest): HTMLElement {
  if (agents.some(agent => agent.status === "running")) this.subagentTick ??= window.setInterval(() => this.tickSubagents(), 1000);
  const signature = JSON.stringify([agents, opens]);
  const previous = container.querySelector<HTMLElement>(".chat-subagents");
  if (previous?.dataset.signature === signature) return previous;
  const card = el("section", "chat-subagents chat-message");
  card.dataset.signature = signature;
  const running = agents.filter(agent => agent.status === "running");
  const finished = agents.filter(agent => agent.status !== "running");
  const summary = subagentsSummary(agents);
  const heading = (text: string, open: boolean, className: string, label: string, hint: string, toggle: () => void) => {
   // draw() replaces the heading; focus moves to its replacement, so a keyboard user can toggle back (#132).
   const control = button("", () => {
    const from = card.getBoundingClientRect().height, focused = document.activeElement === control;
    toggle(); draw(); animateHeight(card, from, "quick");
    if (focused) card.querySelector<HTMLElement>(`[data-disclosure="${className}"]`)?.focus({ preventScroll: true });
   });
   control.className = className; control.dataset.disclosure = className;
   control.setAttribute("aria-expanded", String(open)); control.setAttribute("aria-label", label); control.title = hint;
   const chevron = el("span", "chat-plan-chevron"); chevron.setAttribute("aria-hidden", "true");
   void symbol(open ? "chevron.down" : "chevron.right", 10, "bold").then(icon => chevron.append(icon));
   control.append(chevron, el("span", "", text));
   return control;
  };
  const row = (agent: TranscriptSubagent) => {
   const words = subagentRow(agent, Date.now()), opensRow = opens && agent.has_transcript;
   const item = opensRow ? button("", () => this.openSubagent(agent.id)) : el("div");
   item.className = "chat-subagent-row"; item.dataset.mark = words.mark;
   item.setAttribute("aria-label", words.spoken);
   if (opensRow) item.title = "Opens its conversation"; else item.setAttribute("role", "group");
   const mark = el("span", "chat-subagent-mark", { running: "", completed: "✓", failed: "✗", unknown: "?" }[words.mark]);
   mark.setAttribute("aria-hidden", "true");
   const title = el("span", "chat-subagent-title");
   title.append(el("strong", "", words.title), el("span", "", words.label));
   const detail = el("span", "chat-subagent-detail", words.detail);
   if (words.mark === "running") { detail.dataset.started = String(agent.started_ms ?? 0); detail.dataset.intent = agent.last_intent ?? ""; }
   const lines = el("span", "chat-subagent-lines"); lines.append(title, detail);
   item.append(mark, lines);
   if (opensRow) {
    const chevron = el("span", "chat-subagent-chevron"); chevron.setAttribute("aria-hidden", "true");
    void symbol("chevron.right", 10, "bold").then(icon => chevron.append(icon));
    item.append(chevron);
   }
   return item;
  };
  const draw = () => {
   const open = !this.subagentsClosed, showsFinished = this.subagentsFinishedShown;
   card.replaceChildren(heading(`SUBAGENTS · ${summary.toUpperCase()}`, open, "chat-plan-heading", `Subagents, ${summary}`,
    open ? "Hides the subagents" : "Shows the subagents", () => { this.subagentsClosed = !this.subagentsClosed; }));
   if (!open) return;
   card.append(...running.map(row));
   if (!finished.length) return;
   card.append(heading(`${finished.length} finished`, showsFinished, "chat-plan-heading chat-subagents-finished", `${finished.length} finished`,
    showsFinished ? "Hides the finished subagents" : "Shows the finished subagents", () => { this.subagentsFinishedShown = !this.subagentsFinishedShown; }));
   if (showsFinished) card.append(...finished.map(row));
  };
  draw(); return card;
 }
 /** The running subagents' times, in the chat and in an open topic's (both in the page's body). */
 private tickSubagents() {
  const now = Date.now();
  for (const detail of this.body.querySelectorAll<HTMLElement>(".chat-subagent-detail[data-started]")) {
   detail.textContent = subagentRow({ id: "", status: "running", started_ms: Number(detail.dataset.started), last_intent: detail.dataset.intent || null, has_transcript: false }, now).detail;
  }
 }
 openSubagent(id: string) {
  this.subagentSheet?.close();
  const dialog = el("dialog", "subagent-sheet");
  this.subagentSheet = dialog;
  const header = el("header"); header.append(el("strong", "", id), button("Done", () => dialog.close()));
  const messages = el("div", "chat-transcript"), notice = el("p", "interaction-status");
  // The sheet's own conversation: the handovers its reader unfolds stay unfolded while it is open.
  const unfolded = new Set<string>();
  const earlier = button("Earlier messages", () => { void load(true); }); earlier.className = "chat-earlier button-plain button-compact"; earlier.hidden = true;
  dialog.append(header, notice, messages); document.body.append(dialog);
  let open = true, busy = false, page: TranscriptPage | null = null, entries: Entry[] = [], before: string | undefined, timer: number | undefined;
  const load = async (older: boolean) => {
   if (busy || !open || this.disposed || (older && !before)) return;
   busy = true; earlier.disabled = true; clearTimeout(timer);
   const session = page?.session_id;
   try {
    const next: TranscriptPage = JSON.parse(await Desk.chatTranscript(this.token, older ? "" : page?.after ?? "", older ? before! : "", id, older ? "" : before ?? ""));
    if (!open || this.disposed || (older && (next.session_id !== session || page?.session_id !== session))) return;
    const follow = messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 8, height = messages.scrollHeight;
    if (page?.session_id !== next.session_id) { entries = []; before = next.before; }
    entries = mergeTranscript(entries, next.entries, { older, resent: next.resent });
    if (older) before = next.before; else page = next;
    const expanded = new Set([...messages.querySelectorAll<HTMLDetailsElement>("details[open]")].map(node => node.dataset.id));
    const nodes = groupTranscript(entries, !!page?.working).map(row => {
     const node = this.renderRow(row, unfolded);
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
   } catch(error) { if (open) notice.textContent = errorText(error); }
   finally { busy = false; earlier.disabled = false; if (open && !this.disposed) timer = window.setTimeout(() => { void load(false); }, 1500); }
  };
  dialog.addEventListener("close", () => { open = false; clearTimeout(timer); dialog.remove(); if (this.subagentSheet === dialog) this.subagentSheet = null; }, { once: true });
  dialog.showModal(); void load(false);
 }
 private workSummary(details: HTMLDetailsElement): HTMLElement {
  const summary = el("summary"), chevron = el("span", "chat-work-chevron");
  chevron.setAttribute("aria-hidden", "true"); summary.append(chevron);
  const draw = () => {
   const open = details.open;
   void symbol(open ? "chevron.down" : "chevron.right", 10, "bold").then(icon => {
    if (details.open === open) chevron.replaceChildren(icon);
   });
  };
  details.addEventListener("toggle", draw); draw();
  return summary;
 }
 renderWork(work: WorkRow): HTMLElement {
  const group = el("section", "chat-work");
  const thought = work.thoughts.at(-1);
  if (thought) {
   const details = el("details", "chat-thought"); details.dataset.id = `t:${work.id}`;
   const summary = this.workSummary(details);
   const line = thought.split(/\r?\n/)[0] ?? thought, end = line.indexOf(". ");
   summary.append(el("strong", "", "Thought"), el("span", "thought-preview", end < 0 ? line : line.slice(0, end + 1)));
   const text = work.thoughts.join("\n\n"), content = markdown(text);
   this.bindMessageMenu(content, text, true);
   details.append(summary, content); group.append(details);
  }
  if (work.steps.length) {
   const details = el("details", "chat-work-steps"); details.dataset.id = `s:${work.id}`;
   const duration = chatDuration(work.endMs - work.startMs);
   const summary = this.workSummary(details), label = el("span");
   label.append(el("span", "", work.live ? "Working" : `Worked for ${duration}`), el("span", "work-count", ` · ${work.steps.length} step${work.steps.length === 1 ? "" : "s"}`));
   summary.append(label);
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
  // Dismissed here (agent.dismiss_ask): Cancelled now, before the transcript's form_status.
  const status = entry.form_status ?? (this.localDismissed.has(entry.id) ? "cancelled" : null);
  const active = !answer && !status && pending?.id === entry.id ? pending : undefined;
  const questions = entry.questions ?? active?.questions ?? [];
  const card = el("section", "chat-question");
  card.dataset.state = answer ? "answered" : active ? "open" : "unanswered";
  const row = el("div", showLink ? "chat-message chat-question-row" : "chat-question-row");
  row.append(card);
  if (showLink) {
   const open = button("Open question", () => this.openQuestion(entry.id));
   open.className = "chat-question-open button-plain button-compact"; row.append(open);
  }
  // A guest answers as the owner does unless the host keeps answers for the owner (ChatAskCard,
  // ChatView.swift:1738-1870).
  const viewer = this.viewer();
  const waiting = waitingForOwner(viewer, this.answersRefused);
  const form = entry.form ?? (pending?.id === entry.id ? pending.form : null) ?? null;
  if (form || entry.form_answer) { this.renderFormQuestion(card, entry, form, status ? undefined : pending, viewer, waiting, showLink ? "chat" : "sheet", status); return row; }
  card.append(el("p", "chat-question-title", questions.map(question => question.question).join("\n")));
  if (answer) {
   const chosen = el("p", "chat-question-answer", "✓ " + chooser(viewer, waiting));
   chosen.append(el("strong", "", answer.join(", "))); card.append(chosen); return row;
  }
  // A plain ask settles with form_status too (herdr #484): cancelled by Dismiss or Esc, or timed out.
  if (!active) { card.append(el("p", "chat-question-note", status === "cancelled" ? "Cancelled" : status === "timed_out" ? "Timed out without an answer" : "Not answered")); return row; }
  const options = el("div", "chat-question-options");
  const question = questions[0];
  const answerable = canAnswer(active, waiting);
  question?.options.forEach((option, index) => {
   const choice = answerable ? button("", () => { void this.answer(active.id, option); }) : el("div");
   choice.append(el("span", "", option));
   choice.className = `chat-question-option${answerable ? index === (question.recommended ?? 0) ? " primary" : "" : " readonly"}`;
   if (choice instanceof HTMLButtonElement) choice.disabled = this.answering;
   options.append(choice);
  });
  card.append(options);
  const problem = this.answerProblem?.askID === entry.id ? this.answerProblem : null;
  if (waiting !== null) {
   const line = el("p", "chat-question-waiting");
   line.append(el("span", "chat-question-waiting-dot"), el("span", "", `WAITING FOR ${waiting.toUpperCase()} TO ANSWER`));
   card.append(line);
   // Dismiss still shows while waiting, so its refusal must too (herdrup#782, #787).
   if (problem) card.append(el("p", "chat-question-problem", problem.message));
  } else {
   if (problem) card.append(el("p", "chat-question-problem", problem.message));
   if (problem ? problem.offersTerminal : !answerable) {
    const terminal = button("Answer in Terminal", () => { void this.chooseMode("terminal"); });
    terminal.className = "chat-question-terminal"; card.append(terminal);
   }
  }
  // ChatAskCard.dismissButton (herdrup #781): its own line under the options, 8 above; herdr's
  // dismissable alone decides, a guest waiting for the owner included (herdrup #787).
  if (active.dismissable === true) {
   const dismiss = button("Dismiss", () => { void this.dismissAsk(active.id); });
   dismiss.className = "chat-question-dismiss button-plain"; dismiss.disabled = this.answering; card.append(dismiss);
  }
  return row;
 }
 /** omp's HTML-form ask (owner 2026-11-10, proposal B): the stepper while it waits, the answers
  *  once given. Answering needs a host with capabilities.ask_form and herdr's form_answerable;
  *  otherwise the form shows read-only with "Answer in Terminal", or a guest waits for the owner.
  *  `status`: how it settled (form_status, or Cancelled once dismissed here). */
 renderFormQuestion(card: HTMLElement, entry: Entry, form: AskForm | null, pending: TranscriptPage["pending_ask"], viewer: Viewer, waiting: string | null, surface: "chat" | "sheet", status: AskFormStatus | null) {
  card.classList.add("ask-form");
  const local = entry.form_answer ? undefined : this.localFormAnswers.get(entry.id);
  const answers = entry.form_answer ?? local?.answers;
  if (answers || status) {
   card.dataset.state = "answered";
   const credit: AnswerCredit = !viewer.guest ? "you" : waiting === null ? "anyone" : { owner: waiting };
   card.append(...askFormAnswered(form, answers ?? [], status, credit, local?.sent ?? false));
   return;
  }
  const active = pending?.id === entry.id ? pending : undefined;
  if (!active || !form) {
   card.dataset.state = "unanswered";
   if (form?.intro) card.append(el("p", "ask-form-intro", form.intro));
   card.append(el("p", "chat-question-note", "Not answered"));
   return;
  }
  card.dataset.state = "open";
  let state = this.formStates.get(entry.id);
  if (!state) { state = askFormState(form); this.formStates.set(entry.id, state); }
  const problem = this.answerProblem?.askID === entry.id ? this.answerProblem : null;
  card.append(...askFormCard({
   form, state, waiting,
   answerable: !!this.view?.askForm && active.form_answerable === true && waiting === null && !problem?.offersTerminal,
   sending: this.answering,
   problem,
   surface,
   changed: () => this.drawChat(false),
   submit: values => { void this.answerForm(entry.id, values, () => draftAnswers(form, state.draft)); },
   terminal: () => { void this.chooseMode("terminal"); },
   // AskFormStepper.dismissLink (herdrup #781): herdr's dismissable, where this viewer answers.
   dismiss: active.dismissable === true ? () => { void this.dismissAsk(entry.id); } : null,
  }));
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
   const entry = this.entries[index] ?? (pending?.id === id ? {kind:"ask", id, ts_ms:0, questions:pending.questions, form:pending.form} : undefined);
   let prompt: Entry | undefined;
   for (let i = index < 0 ? this.entries.length - 1 : index - 1; i >= 0; i--) {
    if (this.entries[i]!.kind === "summary") break;
    if (this.entries[i]!.kind === "user") { prompt = this.entries[i]; break; }
   }
   const next = JSON.stringify([this.chat?.session_id, entry, prompt, pending, this.answering, this.answerProblem, this.localAnswers.get(id), this.answersRefused, this.formStates.get(id)?.version ?? 0, this.localFormAnswers.get(id), this.view?.askForm]);
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
  if (appleSymbols() || !style.icon) {
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
    if (!this.disposed && this.messageMenu?.id === id) { this.messageMenu = null; this.status.textContent = errorText(error); }
   });
  };
  element.addEventListener("contextmenu", event => { event.preventDefault(); open(); });
  element.addEventListener("keydown", event => {
   if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); open(); }
  });
 }
 async chooseMessageAction(id: string, item: string) {
  const message = this.messageMenu;
  if (!message || message.id !== id || this.disposed || this.mode === "terminal" || root.hidden) return;
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
 /** ChatView.dayLabel: "Today" 13 pt semibold and " 4:12 PM" regular, textFaint, centred, 4 pt above and below. */
 renderDay(ms: number): HTMLElement {
  const { day, time } = chatDayLabel(ms, new Date());
  const row = el("div", "chat-day"); row.append(el("strong", "", day), document.createTextNode(` ${time}`));
  return row;
 }
 renderRow(row: ChatRow, unfolded = this.unfoldedRelays): HTMLElement {
  if (row.kind === "day") return this.renderDay(row.ms);
  if (row.kind === "work") return this.renderWork(row);
  return this.renderEntry(row.entry, unfolded);
 }
 /** Who reads this chat (ChatView.swift ChatViewer). */
 private viewer(): Viewer {
  return this.view?.guest ? { guest: true, me: this.view.guestSelf ?? "", owner: this.view.guestOwner ?? "" } : { guest: false };
 }
 renderEntry(entry: Entry, unfolded = this.unfoldedRelays): HTMLElement {
  if (entry.kind === "ask") return this.renderQuestion(entry, undefined, false, false);
  if (entry.kind === "note") return this.renderNote(entry);
  // A topic's or subagent's chat shows a suggestion without Start and Not now.
  if (entry.kind === "topic_suggestion") return this.renderSuggestionRow({ kind: "suggestion", id: entry.id, suggestion: suggestionFromEntry(entry) }, false);
  if (entry.kind === "plan") {
   // Swift retains this row's gap; only the footer draws the current plan.
   const gap = el("div", "chat-plan-snapshot"); gap.setAttribute("aria-hidden", "true"); return gap;
  }
  // ChatRowView .summary: a compaction, its words centred between two quiet hairlines.
  if (entry.kind === "summary") {
   const row = el("div", "chat-summary");
   row.append(el("span", "chat-summary-rule"), el("span", "chat-summary-text", entry.text ?? ""), el("span", "chat-summary-rule"));
   row.querySelectorAll(".chat-summary-rule").forEach(rule => rule.setAttribute("aria-hidden", "true"));
   return row;
  }
  // ChatRowView .turnFailed: a turn that stopped or failed, with herdr's error if any.
  if (entry.kind === "turn_end") {
   const aborted = entry.status === "aborted";
   const row = el("div", "chat-turn-failed");
   row.dataset.status = aborted ? "aborted" : "failed";
   const icon = el("span", "chat-turn-failed-icon"); icon.setAttribute("aria-hidden", "true");
   // SF Symbols on a Mac; elsewhere the matching Phosphor glyph, as the plan card's markers.
   if (appleSymbols()) void symbol(aborted ? "stop.circle" : "exclamationmark.circle", 12, "semibold").then(glyph => icon.append(glyph));
   else { const glyph = el("span", "chat-plan-fallback"); glyph.style.setProperty("--plan-icon", `url("${aborted ? stopCircleIcon : warningCircleIcon}")`); icon.append(glyph); }
   row.append(icon, el("span", "chat-turn-failed-text", aborted ? "Stopped" : `Failed${entry.error ? ` · ${entry.error}` : ""}`));
   return row;
  }
  // A handover between the Inbox and a topic (chatRelay.ts): the agent's side, under who sent it.
  if (entry.kind === "relay") {
   const row = relayRow(entry, markdown(entry.text ?? ""), unfolded);
   this.bindMessageMenu(row, entry.text ?? "", true, true);
   return row;
  }
  if (entry.kind === "user" || entry.kind === "reply") {
   const article = el("article", `chat-message ${entry.kind}`);
   let copied = entry.text ?? "";
   if (entry.kind === "user") {
    // ChatView.promptBubble: whose prompt it was, above the bubble, when not the reader's own.
    const byline = promptByline(this.viewer(), entry.author, entry.author_name);
    if (byline) { article.classList.add("has-byline"); article.append(el("span", "chat-byline", byline)); }
    // A prompt with Gram files (GramAttachmentPrompt): its caption, then the files folded
    // under it, never herdr's download instructions.
    const sent = parseAttachmentPrompt(entry.text ?? "");
    const caption = sent ? sent.caption : entry.text ?? "";
    if (!sent || caption) {
     const bubble = el("div", "chat-user-text");
     bubble.append(el("span", "chat-user-content", caption)); article.append(bubble);
     this.promptLayoutDirty = true;
    }
    if (sent) { article.append(attachmentBundle(sent.files)); copied = caption; }
   }
   else article.append(markdown(entry.text ?? ""));
   this.bindMessageMenu(article, copied, entry.kind === "reply", entry.kind === "reply");
   return article;
  }
  const details = el("details", "chat-step");
  const label = entry.kind === "thinking" ? "Thinking" : entry.kind === "step" ? `${entry.tool ?? "Tool"}: ${entry.intent ?? ""} · ${entry.status ?? ""}` : entry.title ?? entry.kind;
  details.append(el("summary", "", label));
  details.append(markdown(entry.text ?? entry.body ?? entry.detail ?? entry.error ?? entry.status ?? JSON.stringify(entry, null, 2)));
  return details;
 }
 /** A send and the pane's stored draft, in this order:
  *  (1) at the click the composer's text becomes the send's reservation (PaneDraft.reserve),
  *      stored in click order, before any edit that follows: a reload brings it back
  *      (composerDraft.ts: Not sent when this page said, going away, that it never went out;
  *      else "Might have been sent"). A reservation storage refused leaves the text in the field;
  *  (2) only the dispatch waits, behind earlier terminal input (inputQueue); a send cancelled
  *      before it (the composer closed) brings its text back;
  *  (3) the send's dispatch (DraftSend.dispatch) marks it sending, makes the Desk call, and
  *      settles it: the Desk resolving takes it out, the Desk rejecting brings it back
  *      (Desk.chatPrompt rejects only a write that definitely didn't go out, or the host refused).
  *      Stored while the Desk has it, a reload shows it as text that may have been sent. A
  *      reservation "gone" (released first) sends and puts back nothing; one storage "refused"
  *      to mark sending sends nothing and is released. A failure after the dispatch resolved
  *      puts nothing back (the text went out).
  *  The composer itself refuses no text: each Desk decides what a pane takes (a plain terminal's
  *  line break: one bracketed paste where the machine can write one, desktop and browser alike). */
 async sendPrompt() {
  const text = this.input.value;
  // Under an open topic the same send goes to the topic (topicCall); a closed topic takes none.
  const topic = this.sendsToTopic();
  if (this.guestPaused || this.sending || this.dictation.busy || topic?.closed() || (!text.trim() && !this.attachments.length)) return;
  // A failed key send leaves the agent's input line unknown: say so, with the text kept, rather
  // than doing nothing. A topic's send (agent.topics.send) never goes through that line.
  if (!topic && this.inputFailed) { this.composerNote("An earlier key send failed. Reconnect before sending again."); return; }
  const hasAttachments = this.attachments.length > 0;
  // The send settles where it was sent from (#532): its draft and its topic as at the click, not
  // whichever the composer shows when the reply comes back.
  const draftKey = this.draftKey, draft = this.draft;
  const note = (text: string) => this.noteTo(topic, text);
  // Motion spec §1, all in the tap's frame: the composer clearing (its height shrinking on the
  // bubble's curve), the press, the bubble entering and the chat gliding to it.
  const mode = motionMode();
  if (mode === "full" && !hasAttachments) {
   this.input.style.transition = `height ${SPEC.bubble.duration}ms ${SPEC.bubble.ease}`;
   window.setTimeout(() => { this.input.style.transition = ""; }, SPEC.bubble.duration + 20);
  }
  // The reservation (rule 1) is taken now, ahead of the next edit; the field clears with it (the
  // draft shows without the text). Refused by storage, the text stays in the field, unsent.
  const send = hasAttachments ? null : this.draft.reserve(text);
  if (send && send.outcome !== "reserved") {
   if (send.outcome === "refused") this.composerNote("Couldn't save the draft; not sent.");
   return;
  }
  this.queuedSend = send;
  // True once Desk.chatPrompt resolved: the text went out, and nothing puts it back.
  let dispatched = false;
  if (mode === "full") {
   // Clearing the field swaps Send for Saved Prompts in this frame, so the press plays on the
   // trailing action slot: whichever of the two now shows (spec §3, as iOS).
   const trailing = this.send.hidden ? this.prompts.button : this.send;
   trailing.animate([
    { transform: "scale(1)", easing: "ease-out" },
    { transform: "scale(0.88)", offset: SPEC.press.down, easing: SPEC.bubble.ease },
    { transform: "scale(1)" },
   ], { duration: SPEC.press.duration });
  }
  // Only against a loaded transcript (TranscriptStore.stageOutgoing's hasSnapshot): the first
  // page would otherwise count every old prompt as new and could take the bubble (#139). A
  // topic's bubble is the topic's to draw (TopicComposer.stage).
  const outgoing: Outgoing | null = topic || (this.mode === "chat" && !this.plainTerminal && this.chat)
   ? { id: `outgoing:${++this.outgoingCount}`, text: text.trim(), files: this.attachments.map(a => ({ name: a.name, isImage: a.isImage })), guest: this.view?.guest ? this.view.guestSelf ?? "" : "", state: "sending", until: Date.now() + CHAT_SEND_FOLLOW_MS } : null;
  const staged = outgoing && topic ? topic.stage(outgoing) : null;
  const setOutgoing = (state: Outgoing["state"] | null) => {
   if (!outgoing || this.disposed) return;
   if (staged) { staged(state); return; }
   this.outgoing = state ? this.outgoing.map(o => o.id === outgoing.id ? { ...o, state } : o) : this.outgoing.filter(o => o.id !== outgoing.id);
   if (this.mode === "chat") this.drawChat(false);
  };
  if (outgoing && !staged) {
   this.outgoing = [...this.outgoing, outgoing];
   this.drawChat(false);
   if (mode === "full") this.glideChatToLatest({ seconds: SPEC.bubble.duration / 1000, curve: cubicBezier(...SPEC.bubble.bezier) });
   else { this.chatFollowing = true; this.followChat(); }
  }
  this.sending = true; this.dictation.button.disabled = true; this.send.disabled = true; this.attach.disabled = true; this.prompts.button.disabled = true; this.renderAttachments();
  try {
   // The send's turn, behind earlier terminal input (a topic's send skips it: it writes no
   // terminal); or its end, when its page gave it up (back from the back/forward cache: its text
   // is back), which frees the composer at once.
   const queue = topic ? Promise.resolve() : this.inputQueue;
   const turn = await (send ? Promise.race([queue.then(() => true), send.gaveUp.then(() => false)]) : queue.then(() => true));
   if (!turn) { setOutgoing(null); return; }
   // Closed while queued: dispose released the reservation.
   if (this.disposed) return;
   if (!topic && this.inputFailed) {
    send?.cancel();
    throw new Error("An earlier key send failed. Reconnect before sending again.");
   }
   // The dispatch (rule 3): from here closing the composer doesn't cancel the send.
   this.queuedSend = null;
   // The poll goes fast until the prompt shows up (ChatModel.followSend, ChatView.swift:111-114).
   if (!topic) this.sendFollow = { until: Date.now() + CHAT_SEND_FOLLOW_MS };
   // Each Desk's reply as one typed receipt, at its own binding: only the Inbox's is JSON.
   const call = topic ? (prompt: string) => this.topicCall(topic, prompt) : async (prompt: string) => chatReceipt(await Desk.chatPrompt(this.token, prompt));
   // Rule 3: the send's dispatch puts the text back only when the Desk call rejects (it throws then).
   const outcome = send ? await send.dispatch(call) : { sent: true as const, value: await call(text) };
   if (!outcome.sent) {
    this.sendFollow = null;
    setOutgoing(null);
    if (outcome.outcome === "refused" && !this.disposed) note("Couldn't save the draft; not sent.");
    return;
   }
   dispatched = true;
   const ownerSend = this.view?.guest === false;
   const result = outcome.value;
   setOutgoing(result.delivery === "submitted" ? "submitted" : "unconfirmed");
   // Only a confirmed owner prompt counts: not a guest's, not a plain-terminal write, not unconfirmed.
   if (result.delivery === "submitted" && ownerSend) recordOwnerSend();
   if (hasAttachments) {
    // The caption leaves its own draft: the field when it still shows that draft, else the store.
    const left = remainingDraft(draft.draft(), text);
    if (!this.disposed && this.draftKey === draftKey) { this.input.value = left; this.input.dispatchEvent(new Event("input")); }
    else this.stored(draft.saveDraft(left));
   }
   if (!this.disposed) note(result.note ?? (result.delivery === "submitted" ? "" : "Written to the terminal; submission not confirmed. Check Terminal before sending again."));
   if (!this.disposed && this.plainTerminal && result.delivery === "written") this.terminal?.focus();
   // A guest has no events: look for the prompt now rather than at the next poll (GuestPaneView.swift:882-886).
   if (!this.disposed && this.view?.guest && this.mode === "chat") void this.refreshChat(this.generation);
  } catch(e) {
   if (dispatched) {
    // The text went out: the failure is this page's (the receipt, the drawing), not the send's.
    console.error("after a send", e);
    if (!this.disposed) note(errorText(e));
    return;
   }
   this.sendFollow = null;
   // A failed send keeps today's error: the text back (rule 3, above) and the reason (spec §1.5).
   setOutgoing(null);
   if (!this.disposed) {
    const message = errorText(e);
    note((this.view?.guest && guestSendFailure(message, this.view.name)) || message);
    // A refused send moves the page to paused at once (failureNote's apply, GuestPaneView.swift:915-917).
    if (this.view?.guest && isGuestPaused(message)) this.applyGuestAvailability("paused");
   }
  }
  finally {
   send?.cancel();
   if (this.queuedSend === send) this.queuedSend = null;
   const paused = !!this.guestPaused;
   this.sending = false; this.dictation.button.disabled = paused; this.send.disabled = paused || this.dictation.busy; this.attach.disabled = paused || this.picking; this.prompts.button.disabled = paused || this.dictation.busy;
   if (!this.disposed) this.renderAttachments();
  }
 }
 /** The Inbox's send, to the open topic (Desk.topicsSend: agent.topics.send, the composer's files
  *  posted as the Inbox posts them and named in the message): refused, it rejects with herdr's
  *  reason, so the draft and the files stay; else the receipt the send reads, with the topic's
  *  note (a queued message says so; an unconfirmed one asks to check). */
 private async topicCall(topic: TopicComposer, prompt: string): Promise<ComposerReceipt> {
  const reply = await Desk.topicsSend(this.token, topic.topicID, prompt);
  if (reply.delivery === "refused") throw new Error(reply.problem || "The agent refused.");
  return reply.delivery === "sent" ? { delivery: "submitted", note: sendNote(reply.mode) ?? "" }
   : { delivery: "unconfirmed", note: reply.problem || "Couldn't confirm delivery. Check the topic before sending again." };
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
   } else if (result.ownerAnswers) {
    // An older host that keeps answers for the owner: wait for them, as before (ChatView.swift:153-155).
    this.refuseAnswers();
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
   // The answer shows in the transcript now, not at the next poll (ChatModel.answer, ChatView.swift:174).
   if (current() && this.mode === "chat") void this.refreshChat(this.generation);
  }
 }
 /** Submit an HTML-form ask's answers (agent.answer_form; `values` lists only the fields that
  *  differ from the agent's recommendation). `sentAnswers` words the draft, shown while herdr
  *  sent the answers but hasn't confirmed them (sent_unconfirmed). */
 async answerForm(askID: string, values: Record<string, FieldValue>, sentAnswers: () => AskFormAnswer[]) {
  if (this.answering || this.localFormAnswers.has(askID)) return;
  const epoch = this.chatEpoch, session = this.chat?.session_id;
  const current = () => !this.disposed && epoch === this.chatEpoch && session === this.chat?.session_id;
  this.answering = true; this.answerProblem = null;
  this.drawChat(false);
  try {
   const result = await Desk.chatAnswerForm(this.token, askID, values);
   if (!current()) return;
   if (result.code === "ask_not_pending") {
    if (this.chat?.pending_ask?.id === askID) this.chat.pending_ask = undefined;
   } else if (result.ownerAnswers) {
    this.refuseAnswers();
   } else if (result.code) {
    // ask_form_moved: someone is answering in the Terminal; ask_unsupported: controls herdr
    // can't drive. Both hand the form to the Terminal (contract: agent.answer_form errors), as
    // does any answer herdr refuses with "answer in the terminal", plain or in parentheses: a
    // textarea too long, an answer like the placeholder, combined characters (herdr #394
    // form.rs). herdr's own reason is shown then. Other invalid answers stay editable here.
    const handOff = /\(?answer in the terminal\)?\.?$/i.test(result.message ?? "");
    const terminal = result.code === "ask_form_moved" || result.code === "ask_unsupported" || result.code === "ask_form_invalid" && handOff;
    this.answerProblem = {
     askID,
     message: result.code === "ask_form_moved" && !handOff ? "The form changed in the Terminal. Finish it there."
      : result.code === "ask_unsupported" ? "This form can't be answered from the chat."
      : handOff ? `herdr can't answer this from the chat: ${result.message}`
      : `Couldn't send: ${result.message}`,
     offersTerminal: terminal,
    };
   } else if (result.status === "sent_unconfirmed") {
    this.localFormAnswers.set(askID, { answers: sentAnswers(), sent: true });
   } else {
    this.localFormAnswers.set(askID, { answers: result.answers ?? [], sent: false });
   }
  } catch {
   if (current()) this.answerProblem = { askID, message: "Couldn't reach the agent. Try again.", offersTerminal: false };
  } finally {
   this.answering = false;
   if (current()) this.drawChat(false);
   if (current() && this.mode === "chat") void this.refreshChat(this.generation);
  }
 }
 /** Dismiss: close the pending ask as cancelled (agent.dismiss_ask, Esc in omp's dialog;
  *  ChatModel.dismissAsk, herdrup #781). An ask already gone (answered elsewhere, or replaced)
  *  refreshes quietly; any other refusal shows on the card like an answer's. */
 async dismissAsk(askID: string) {
  if (this.answering || this.localDismissed.has(askID)) return;
  const epoch = this.chatEpoch, session = this.chat?.session_id;
  const current = () => !this.disposed && epoch === this.chatEpoch && session === this.chat?.session_id;
  this.answering = true; this.answerProblem = null;
  this.drawChat(false);
  try {
   const result = await Desk.chatDismissAsk(this.token, askID);
   if (!current()) return;
   if (result.code === "ask_not_pending" || result.code === "ask_mismatch") {
    if (this.chat?.pending_ask?.id === askID) this.chat.pending_ask = undefined;
   } else if (result.code) {
    this.answerProblem = { askID, message: `Couldn't dismiss: ${result.message || result.code}`, offersTerminal: false };
   } else if (result.dismissed) {
    this.localDismissed.add(askID); this.formStates.delete(askID);
   } else {
    // herdr answered without saying the ask closed: the card stays as it is.
    this.answerProblem = { askID, message: "Couldn't dismiss: herdr did not confirm it", offersTerminal: false };
   }
  } catch {
   if (current()) this.answerProblem = { askID, message: "Couldn't reach the agent. Try again.", offersTerminal: false };
  } finally {
   this.answering = false;
   if (current()) this.drawChat(false);
   if (current() && this.mode === "chat") void this.refreshChat(this.generation);
  }
 }
}
