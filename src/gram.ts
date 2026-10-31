// herdrup's Gram screen at regular width (iPad and Mac), from herdrup 9876878: the sidebar
// (App/HerdrApp.swift gramSidebar, GramSidebarConversations; GramCards.swift
// GramConversationRow), the page (App/GramView.swift iPadBody: the floating header over the
// feed, the banner, the composer), the rows and cards (GramView.swift GramRow, GramCards.swift)
// and the composer's parts (App/ComposerView.swift). The data and its rules are Desk's
// (desk_gram*.go); the decisions are in gramModel.ts, gramMention.ts and gramText.ts.
import { avatarFace } from "./avatars";
import { paintShape } from "./continuous";
import { rowTime, separator } from "./gramDates";
import { ComposerEditor, composerGlyph as glyph, composerRing as ring, composerAttachment, composerFileDrop, composerClipboardPaste } from "./composer";
import { ConversationColumn } from "./conversationColumn";
import { ComposerDictation } from "./dictation";
import { onTextSizeChanged } from "./textSize";
import {
  activeQuery,
  addressing,
  complete,
  draftAddress,
  draftHint,
  draftRecipient,
  mentionNames,
  pickStillHolds,
  sharedNames,
  unaddressed,
  type DraftAddress,
  type GramAgent,
} from "./gramMention";
import * as model from "./gramModel";
import { agentName, foldToggleLabel, gramTextFolds, rowPreview, savedPreview, segments, type GramTextSegment } from "./gramText";
import {
  Desk,
  events,
  type AvatarFace,
  type GramAttachment,
  type GramDownloadProgress,
  type GramMessage,
  type GramSnapshot,
  type GramUploadProgress,
  type SavedGram,
} from "./mygo";

export type GramDeps = {
  el: <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => HTMLElementTagNameMap[K];
  symbol: (name: string, size: number, weight: string) => Promise<HTMLElement>;
  /** Puts each initial tile's letter on a device pixel (main.ts placeInitials). */
  placeInitials: (root: ParentNode) => Promise<void>;
  /** The frozen UIActivityIndicatorView (main.ts). */
  spinner: string;
  /** The sidebar's top bar changed (title, count or actions): re-place and re-paint it. */
  barChanged: (unread: number) => void;
};

let deps: GramDeps;
let el: GramDeps["el"];

// ---- State ----

let snap: GramSnapshot | null = null;
/** The Gram tab is showing. */
let shown = false;
let showingSaved = false;
let search = "";
/** How many of the newest messages the inbox and Saved draw. */
let renderLimit = model.RENDER_WINDOW;
let savedLimit = model.RENDER_WINDOW;
let unreadRule: model.UnreadRule | null = null;
let ruleCaptured = false;
/** The feed has landed on the newest message since it showed. */
let landed = false;
/** The sentinel may fetch: once per arrival, re-armed when it leaves. */
let pageArmed = true;
let pageRequested = false;
let searchingOlder = false;
let searchedWithoutMatch: number | null = null;
let showingNew = false;
let feedTip = 0;
/** Read-more segments opened, by message id. */
const expanded = new Map<string, Set<number>>();
const downloads = new Map<string, GramDownloadProgress>();
const uploads = new Map<string, GramUploadProgress>();
/** Image previews by message id: a data URL, or null once one failed. */
const images = new Map<string, string | null>();
/** The code on the clipboard, for "Copied" (a shared receipt, 1.6 s). */
let copied: string | null = null;
let copiedTimer: number | undefined;
let setupCopied = false;
let draft = "";
let caret = 0;
let pickedAgent: GramAgent | null = null;
let draftPosted: number | null = null;
let draftRevision = 0;
let submittedDraftRevision: number | null = null;
let posting = false;
let picking = false;
let wrapped = false;
let composerFocused = false;
let dictation: ComposerDictation | null = null;
const SETUP_DISMISSED = "gram.setupCardDismissed";

/** The setup card's one-liner (GramView.setupCommand). */
const SETUP_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/jerryfane/herdr/master/" +
  "skills/herdrup-gram-skill/SKILL.md --create-dirs " +
  "-o ~/.claude/skills/herdrup-gram-skill/SKILL.md";

// ---- Elements ----

let page: HTMLElement;
let side: HTMLElement;
let sideSearch: HTMLInputElement;
let sideClear: HTMLElement;
let conversations: HTMLElement;
let header: HTMLElement;
let content: HTMLElement;
let banner: HTMLElement;
let composer: HTMLElement;
let hintEl: HTMLElement;
let card: HTMLElement;
let input: HTMLTextAreaElement;
let mirror: HTMLElement;
let strip: HTMLElement;
let actions: HTMLElement;
let mentionHost: HTMLElement;
let newButton: HTMLElement;
let column: ConversationColumn;
let scroller: HTMLElement | null = null;
let headerHeight = 0;

// ---- Small builders ----

/** An SF Symbol (or its Phosphor stand-in) that fills in once drawn; `display: contents`, so
 * it lays out as the symbol itself. */
function icon(name: string, size: number, weight: string, cls = ""): HTMLElement {
  const host = el("span", "gi" + (cls ? " " + cls : ""));
  void deps.symbol(name, size, weight).then((s) => host.replaceChildren(s));
  return host;
}


function button(cls: string, label: string, action: () => void): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    action();
  });
  return b;
}

function centeredSpinner(): HTMLElement {
  const s = el("div", "gspinner");
  s.innerHTML = deps.spinner;
  return s;
}


// ---- Avatars (GramAvatar: the roster agent's face, else the initial tile) ----

const faces = new Map<string, Promise<AvatarFace>>();
const facesKnown = new Map<string, AvatarFace>();

function faceOf(name: string): Promise<AvatarFace> {
  let f = faces.get(name);
  if (!f) {
    f = Desk.gramSenderAvatar(name).then((face) => {
      facesKnown.set(name, face);
      return face;
    });
    faces.set(name, f);
    f.catch(() => faces.delete(name));
  }
  return f;
}

function tile(face: AvatarFace): HTMLElement {
  const t = el("div", `tile tint-${face.tint}`);
  t.append(el("span", "initial", face.initial));
  return t;
}

/** A round avatar of `size` for a Gram sender's routing name; `ring` cuts it out of what it
 * overlaps with a 2 pt ring in that colour (gramRing). */
function gramAvatar(name: string, size: number, ringClass = ""): HTMLElement {
  const a = el("div", "avatar gavatar" + (ringClass ? " " + ringClass : ""));
  a.style.setProperty("--avatar-size", `${size}px`);
  const fill = (face: AvatarFace) => {
    a.replaceChildren(avatarFace(face.avatar, () => tile(face)));
    void deps.placeInitials(a);
  };
  const known = facesKnown.get(name);
  if (known) fill(known);
  else void faceOf(name).then(fill, () => undefined);
  return a;
}

/** A symbol on a surfaceRaised circle, in place of faces (19 semibold brand at 44 pt). */
function symbolAvatar(name: string): HTMLElement {
  const a = el("div", "gsymavatar");
  a.append(icon(name, 19, "semibold"));
  return a;
}

// ---- Sidebar (gramSidebar) ----

/** The Gram section bar's actions: hide-sidebar, then Read all while the inbox shows with
 * something unread, then Refresh. */
export async function barActions(minimize: () => void): Promise<HTMLElement[]> {
  const slot = async (name: string, label: string, action?: () => void) => {
    const s = el("div", "slot");
    s.title = label;
    s.append(await deps.symbol(name, 15, "medium"));
    if (action) {
      s.classList.add("action");
      s.tabIndex = 0; s.setAttribute("role", "button"); s.setAttribute("aria-label", label);
      s.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); action(); } };
      s.addEventListener("click", action);
    }
    return s;
  };
  const out = [await slot("sidebar.leading", "Minimise sidebar", minimize)];
  if (!showingSaved && (snap?.unreadCount ?? 0) > 0) {
    out.push(await slot("envelope.open", "Read all", () => void Desk.gramMarkAllRead().catch(() => undefined)));
  }
  out.push(await slot("arrow.clockwise", "Refresh", () => void Desk.gramRefresh().catch(() => undefined)));
  return out;
}

/** The amber unread count after the title (SectionTopBar), or null. */
export function barCount(): HTMLElement | null {
  const n = snap?.unreadCount ?? 0;
  return n > 0 ? el("span", "gcount", String(n)) : null;
}

/** A barActions-relevant fingerprint, so the bar is rebuilt only when it changes. */
let barKey = "";
function updateBar() {
  const key = `${showingSaved}/${snap?.unreadCount ?? 0}`;
  if (key === barKey) return;
  barKey = key;
  deps.barChanged(snap?.unreadCount ?? 0);
}

function buildSidebar(): HTMLElement {
  side = el("div", "gram-side");
  const field = el("label", "search gsearch");
  const mag = el("span", "search-icon");
  mag.append(icon("magnifyingglass", 15, "medium"));
  sideSearch = el("input", "t-search");
  sideSearch.type = "text";
  sideSearch.placeholder = "Search";
  sideSearch.autocomplete = "off";
  sideSearch.spellcheck = false;
  sideSearch.setAttribute("autocapitalize", "off");
  sideClear = button("gclear", "Clear search", () => {
    sideSearch.value = "";
    setSearch("");
  });
  sideClear.append(icon("xmark.circle.fill", 15, "regular"));
  sideSearch.addEventListener("input", () => setSearch(sideSearch.value));
  field.append(mag, sideSearch, sideClear);
  paintShape(field, { radius: "capsule", fill: "var(--color-surface)", stroke: "var(--color-hairline)", strokeWidth: 1 });
  conversations = el("div", "gconversations");
  side.append(field, conversations);
  return side;
}

function setSearch(text: string) {
  if (text === search) return;
  search = text;
  sideClear.hidden = text === "";
  // A new search starts from the newest window and ends the last one's search of older history.
  renderLimit = model.RENDER_WINDOW;
  savedLimit = model.RENDER_WINDOW;
  searchedWithoutMatch = null;
  searchingOlder = false;
  pageRequested = false;
  pageArmed = text === "";
  landed = false;
  renderContent();
}

function conversationRow(o: {
  title: string;
  avatars: string[];
  symbol: string | null;
  preview: HTMLElement;
  time: number | null;
  unread: boolean;
  selected: boolean;
  select: () => void;
}): HTMLElement {
  const row = el("div", "gconv" + (o.selected ? " selected" : ""));
  row.setAttribute("role", "button");
  const pic = el("div", "gconv-pic");
  const names = model.distinctAgentNames(o.avatars, 2);
  if (o.symbol) pic.append(symbolAvatar(o.symbol));
  else if (names.length === 2) {
    pic.classList.add("pair");
    pic.append(gramAvatar(names[0]!, 29), gramAvatar(names[1]!, 29, "ringed"));
  } else if (names[0] !== undefined) pic.append(gramAvatar(names[0], 44));
  else pic.append(symbolAvatar("bubble.left.and.bubble.right.fill"));
  const text = el("div", "gconv-text");
  const line = el("div", "gconv-line");
  line.append(el("span", "gconv-title", o.title), el("span", "gconv-spacer"));
  if (o.time !== null) line.append(el("span", "gconv-time", rowTime(new Date(o.time), new Date())));
  o.preview.classList.add("gconv-preview");
  text.append(line, o.preview);
  row.append(pic, text);
  if (o.unread) row.append(el("span", "gconv-dot"));
  row.addEventListener("click", o.select);
  return row;
}

function renderSidebar() {
  if (!snap) return;
  const messages = snap.messages;
  const senders = model.recentAgentSenders(messages);
  const newest = messages[0];
  const gramPreview = el("div");
  if (newest) {
    for (const run of rowPreview({
      fromAgent: newest.fromAgent,
      senderName: newest.name,
      to: newest.to ?? null,
      text: newest.text,
      fileName: newest.attachmentPreview ?? null,
    })) {
      gramPreview.append(run.strong ? el("strong", "", run.text) : document.createTextNode(run.text));
    }
  }
  const saved = snap.saved[0];
  const savedText = saved
    ? savedPreview({ fromAgent: saved.fromAgent, from: saved.from, text: saved.text, fileName: savedFileName(saved) })
    : "No saved messages yet";
  conversations.replaceChildren(
    conversationRow({
      title: "Gram",
      avatars: senders,
      symbol: senders.length === 0 ? "bubble.left.and.bubble.right.fill" : null,
      preview: gramPreview,
      time: newest?.createdUnixMs ?? null,
      unread: snap.unreadCount > 0,
      selected: !showingSaved,
      select: () => setSaved(false),
    }),
    conversationRow({
      title: "Saved",
      avatars: [],
      symbol: "bookmark.fill",
      preview: el("div", "", savedText),
      time: saved?.createdUnixMs ?? null,
      unread: false,
      selected: showingSaved,
      select: () => setSaved(true),
    }),
  );
}

/** A saved copy's file in a preview: its name, or "<name> (expired)". */
function savedFileName(s: SavedGram): string | null {
  if (s.file) return s.file.name;
  return s.expiredFile ? `${s.expiredFile.name} (expired)` : null;
}

function setSaved(saved: boolean) {
  if (saved === showingSaved) return;
  showingSaved = saved;
  landed = false;
  renderAll();
}

// ---- Page (iPadBody) ----

function buildPage(): HTMLElement {
  page = el("section", "gram");
  const body = el("div", "gram-body");
  content = el("div", "gram-content");
  header = el("header", "gram-header gcol");
  newButton = button("gnew", "New messages", () => {
    showingNew = false;
    newButton.hidden = true;
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  });
  newButton.append(icon("chevron.down", 13, "semibold"), el("span", "", "New messages"));
  newButton.hidden = true;
  column = new ConversationColumn(page, () => measureFolds(page));
  body.append(content, header, newButton, ...column.handles, column.readout);
  banner = el("div", "gram-banner gcol");
  composer = buildComposer();
  page.append(body, banner, composer);
  const relayout = () => {
    column.update();
    const h = header.offsetHeight;
    if (Math.abs(h - headerHeight) > 0.5) {
      headerHeight = h;
      page.style.setProperty("--gram-header", `${h}px`);
      observeFeed();
    }
    measureFolds(page);
    void deps.placeInitials(page);
    layoutComposer();
    requestAnimationFrame(() => { for (const name of page.querySelectorAll<HTMLElement>(".gram-middle-name")) fitMiddleName(name); });
  };
  new ResizeObserver(relayout).observe(page);
  onTextSizeChanged(relayout);
  return page;
}

function renderHeader() {
  // headerIdentity: the cluster over the "Gram ›" pill, which opens the agents sheet.
  const identity = el("button", "gidentity");
  identity.type = "button";
  identity.setAttribute("aria-label", "Gram");
  const cluster = el("div", "gcluster");
  for (const p of model.clusterPlaces((snap?.messages ?? []).filter((m) => m.fromAgent).map((m) => m.from))) {
    const a = gramAvatar(p.name, p.size, "ringed");
    a.style.left = `${p.x}px`;
    a.style.top = `${p.y}px`;
    cluster.append(a);
  }
  const pill = el("span", "gpill glass");
  pill.append(el("span", "", "Gram"), icon("chevron.right", 9, "bold", "faint"));
  identity.append(cluster, pill);
  identity.addEventListener("click", openAgentsSheet);
  // headerTrailing: Saved alone, since the sidebar owns search here.
  const trailing = el("div", "gtrailing glass");
  const toggle = button("gsaved-toggle" + (showingSaved ? " on" : ""), "Saved", () => setSaved(!showingSaved));
  toggle.append(icon(showingSaved ? "bookmark.fill" : "bookmark", 15, "semibold"));
  trailing.append(toggle);
  header.replaceChildren(identity, trailing);
}

function renderBanner() {
  const text = snap?.status ?? "";
  banner.hidden = text === "";
  banner.textContent = text;
}

// ---- Content ----

function renderAll() {
  if (!snap) return;
  renderSidebar();
  updateBar();
  renderHeader();
  renderBanner();
  renderContent();
  renderComposer();
}

function visibleMessages(): GramMessage[] {
  return model.filterMessages(snap?.messages ?? [], search);
}

/** The state shown in place of a list (centered: icon 28 textFaint, title 15 medium textDim,
 * body 13 textFaint, spacing 8). */
function stateView(o: { icon?: string; title?: string; body?: string; extra?: HTMLElement; spacing?: number; titleClass?: string }): HTMLElement {
  const box = el("div", "gstate");
  const stack = el("div", "gstate-stack");
  if (o.spacing) stack.style.gap = `${o.spacing}px`;
  if (o.icon) stack.append(icon(o.icon, 28, "regular", "gstate-icon"));
  if (o.title) stack.append(el("div", o.titleClass ?? "gstate-title", o.title));
  if (o.body) stack.append(el("div", "gstate-body", o.body));
  if (o.extra) stack.append(o.extra);
  box.append(stack);
  return box;
}

function capsuleButton(text: string, action: () => void, disabled = false, spinner = false): HTMLButtonElement {
  const b = button("gcapsule", text, action);
  if (spinner) {
    const s = el("span", "gcapsule-spin");
    s.innerHTML = deps.spinner;
    b.append(s);
  }
  b.append(el("span", "", text));
  b.disabled = disabled;
  return b;
}

function renderContent() {
  if (!snap) return;
  if (showingSaved) {
    renderSaved();
    return;
  }
  const messages = snap.messages;
  const visible = visibleMessages();
  const setup = model.showsSetupCard(localStorage.getItem(SETUP_DISMISSED) === "1", messages);
  const view = model.inboxView({
    phase: snap.phase,
    unavailable: snap.unavailable,
    messageCount: messages.length,
    visibleCount: visible.length,
    search,
    showsSetupCard: setup,
    hasMore: snap.hasMore,
  });
  switch (view.kind) {
    case "loading":
      showState(stateView({ extra: centeredSpinner() }));
      return;
    case "unavailable":
      showState(
        stateView({
          icon: "bubble.left.and.exclamationmark.bubble.right",
          title: view.text,
          titleClass: "gstate-message",
          spacing: 12,
          extra: capsuleButton("Retry", () => void Desk.gramRefresh().catch(() => undefined)),
        }),
      );
      return;
    case "empty":
      showState(stateView({ icon: "tray", title: "No messages yet", body: "Agents you message, and their replies, appear here." }));
      return;
    case "noMatches": {
      const t = model.noMatchesText(view.hasOlder, view.loadedCount, search, snap.olderError ?? null);
      const extra = t.offersOlder
        ? capsuleButton(searchingOlder ? "Searching older messages…" : "Search older messages", () => void searchOlder(), searchingOlder, searchingOlder)
        : undefined;
      extra?.classList.add("gsearch-older");
      showState(
        stateView({ icon: view.hasOlder && snap.olderError ? "exclamationmark.triangle" : "magnifyingglass", title: t.title, body: t.body, extra }),
      );
      return;
    }
    case "feed":
      renderFeed(visible, setup);
  }
}

function showState(node: HTMLElement) {
  scroller = null;
  feedObserver?.disconnect();
  newButton.hidden = true;
  content.replaceChildren(node);
}

// ---- The inbox feed (WindowedBottomFeed) ----

let feedList: HTMLElement;
let sentinelEl: HTMLElement | null = null;
let footerEl: HTMLElement;
const rowNodes = new Map<string, { sig: string; node: HTMLElement }>();
let feedObserver: IntersectionObserver | null = null;
const onScreen = new Set<string>();

function ensureScroller(kind: "inbox" | "saved") {
  if (scroller && scroller.dataset.kind === kind && scroller.parentElement === content) return;
  rowNodes.clear();
  onScreen.clear();
  scroller = el("div", "gram-scroll");
  scroller.dataset.kind = kind;
  const col = el("div", "gram-feed gcol");
  feedList = el("div", "gram-rows");
  footerEl = el("div", "gram-footer");
  col.append(feedList, footerEl);
  scroller.append(col);
  scroller.addEventListener("scroll", () => {
    if (atBottom()) {
      showingNew = false;
      newButton.hidden = true;
    }
  });
  content.replaceChildren(scroller);
  observeFeed();
}

function atBottom(): boolean {
  return !!scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 24;
}

/** The rows' and the sentinel's visibility below the floating header. */
function observeFeed() {
  feedObserver?.disconnect();
  if (!scroller) return;
  feedObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const t = e.target as HTMLElement;
        if (t.classList.contains("gsentinel")) {
          if (e.isIntersecting) onSentinelArrival();
          else if (!pageRequested) pageArmed = true;
          continue;
        }
        const id = t.dataset.id;
        if (!id) continue;
        if (e.isIntersecting) {
          onScreen.add(id);
          if (landed) rowSeen(id);
        } else onScreen.delete(id);
      }
    },
    { root: scroller, rootMargin: `-${Math.round(headerHeight)}px 0px 0px 0px` },
  );
  for (const n of feedList.querySelectorAll<HTMLElement>("[data-id]")) feedObserver.observe(n);
  if (sentinelEl) feedObserver.observe(sentinelEl);
}

function rowSeen(id: string) {
  if (showingSaved) return;
  const m = snap?.messages.find((x) => x.id === id);
  if (!m) return;
  if (!ruleCaptured) captureRule();
  if (m.unread) void Desk.gramMarkRead(id).catch(() => undefined);
}

function captureRule() {
  ruleCaptured = true;
  unreadRule = model.captureUnreadRule(snap?.messages ?? []);
}

/** The first row on screen and how far below the viewport's top it is, to put back after the
 * rows change. */
function anchorRow(): { id: string; offset: number } | null {
  if (!scroller) return null;
  const top = scroller.getBoundingClientRect().top + headerHeight;
  for (const n of feedList.children) {
    const r = (n as HTMLElement).getBoundingClientRect();
    if (r.bottom > top) return { id: (n as HTMLElement).dataset.id ?? "", offset: r.top - top };
  }
  return null;
}

function restoreAnchor(a: { id: string; offset: number } | null) {
  if (!a || !scroller) return;
  const n = rowNodes.get(a.id)?.node;
  if (!n || !n.isConnected) return;
  const top = scroller.getBoundingClientRect().top + headerHeight;
  scroller.scrollTop += n.getBoundingClientRect().top - top - a.offset;
}

/** The previously-top row after older rows land, kept where it was. */
let pageAnchor: { id: string; offset: number } | null = null;

function renderFeed(visible: GramMessage[], setup: boolean) {
  if (!snap) return;
  const fresh = !scroller || scroller.dataset.kind !== "inbox";
  ensureScroller("inbox");
  const sc = scroller!;
  const wasAtBottom = !fresh && atBottom();
  const keep = fresh ? null : pageAnchor ?? anchorRow();
  const tip = Math.max(0, ...snap.messages.map((m) => m.createdUnixMs));
  const tipIsMine = snap.messages.some((m) => m.createdUnixMs === tip && m.pending);
  if (!ruleCaptured && shown) captureRule();

  const drawn = model.drawnWindow(visible, renderLimit);
  const entries = model.feedEntries(drawn, unreadRule);
  const now = new Date();
  const nodes: HTMLElement[] = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const m = entry.message;
    seen.add(m.id);
    const sep = entry.separator ? separator(entry.separator, now) : null;
    const gaps = model.rowGaps(index, entry);
    const dl = downloads.get(m.id);
    const sig = JSON.stringify([
      m,
      entry.startsGroup,
      entry.endsGroup,
      entry.unreadCount,
      sep,
      gaps,
      [...(expanded.get(m.id) ?? [])],
      dl ? [dl.done, dl.size, dl.state] : null,
      m.text.includes("```") ? copied : null,
    ]);
    const cached = rowNodes.get(m.id);
    if (cached && cached.sig === sig) {
      nodes.push(cached.node);
      return;
    }
    const slot = el("div", "gslot");
    slot.dataset.id = m.id;
    if (sep) {
      const s = el("div", "gseparator");
      s.style.marginTop = `${gaps.separator}px`;
      s.append(el("strong", "", sep.day), document.createTextNode(` ${sep.time}`));
      slot.append(s);
    }
    if (entry.unreadCount !== null) {
      const r = el("div", "gunread");
      r.style.marginTop = `${gaps.rule}px`;
      r.append(el("span", "gunread-line"), el("span", "gunread-text", `${entry.unreadCount} unread`), el("span", "gunread-line"));
      slot.append(r);
    }
    const row = messageRow(m, entry.startsGroup, entry.endsGroup);
    row.style.marginTop = `${gaps.row}px`;
    slot.append(row);
    if (cached) feedObserver?.unobserve(cached.node);
    rowNodes.set(m.id, { sig, node: slot });
    feedObserver?.observe(slot);
    nodes.push(slot);
  });
  for (const [id, r] of rowNodes) {
    if (!seen.has(id)) {
      feedObserver?.unobserve(r.node);
      rowNodes.delete(id);
      onScreen.delete(id);
    }
  }
  // The sentinel: older messages held above the window, or on herdr.
  const wantSentinel = model.showsSentinel(visible.length, renderLimit, snap.hasMore);
  if (wantSentinel) {
    const line = model.sentinelLine({
      pageError: snap.olderError ?? null,
      searching: search !== "",
      searchingOlder,
      searchedWithoutMatch,
    });
    const s = el("div", "gsentinel" + (line.tappable ? " tappable" : ""));
    if (line.icon === "spinner") {
      const sp = el("span", "gsentinel-spin");
      sp.innerHTML = deps.spinner;
      s.append(sp);
    } else s.append(icon(line.icon === "retry" ? "arrow.clockwise" : "arrow.up", 12, "semibold"));
    s.append(el("span", "", line.text));
    if (line.tappable) {
      s.addEventListener("click", () => {
        pageArmed = true;
        void requestOlder(true);
      });
    }
    if (sentinelEl) feedObserver?.unobserve(sentinelEl);
    sentinelEl = s;
    feedObserver?.observe(s);
    nodes.unshift(s);
  } else {
    if (sentinelEl) feedObserver?.unobserve(sentinelEl);
    sentinelEl = null;
  }
  feedList.replaceChildren(...nodes);
  footerEl.replaceChildren(...(setup ? [setupCard()] : []));
  measureFolds(feedList);
  void deps.placeInitials(feedList);

  if (!landed) {
    sc.scrollTop = sc.scrollHeight;
    requestAnimationFrame(() => {
      if (scroller !== sc) return;
      sc.scrollTop = sc.scrollHeight;
      landed = true;
      feedTip = tip;
      for (const id of onScreen) rowSeen(id);
      if (sentinelEl && isOnScreen(sentinelEl)) onSentinelArrival();
    });
  } else if (tip > feedTip) {
    // A newer message: followed only at the bottom or when it is your own post.
    if (wasAtBottom || tipIsMine) sc.scrollTop = sc.scrollHeight;
    else {
      restoreAnchor(keep);
      showingNew = true;
    }
    feedTip = tip;
  } else if (wasAtBottom && !pageAnchor) {
    sc.scrollTop = sc.scrollHeight;
  } else {
    restoreAnchor(keep);
  }
  pageAnchor = null;
  newButton.hidden = !showingNew;
}

function isOnScreen(n: HTMLElement): boolean {
  if (!scroller) return false;
  const r = n.getBoundingClientRect();
  const s = scroller.getBoundingClientRect();
  return r.bottom > s.top + headerHeight && r.top < s.bottom;
}

function onSentinelArrival() {
  if (showingSaved) {
    revealOlderSaved();
    return;
  }
  void requestOlder(false);
}

/** One older window per arrival of the sentinel: loaded messages above the window first, else
 * the next page; during a search, older pages until one adds a match. */
async function requestOlder(tapped: boolean) {
  if (!snap || !landed || !pageArmed || pageRequested) return;
  if (snap.olderError && !tapped) return;
  pageArmed = false;
  pageRequested = true;
  const top = anchorRow();
  const visible = visibleMessages();
  let grew = false;
  if (visible.length > renderLimit) {
    renderLimit += model.RENDER_WINDOW;
    grew = true;
  } else if (search === "") {
    grew = await Desk.gramLoadOlder().catch(() => false);
    snap = await Desk.gramState();
    if (grew) renderLimit = Math.max(renderLimit, visibleMessages().length);
  } else {
    grew = await loadOlderMatches();
  }
  pageRequested = false;
  if (grew) pageAnchor = top;
  else pageArmed = true;
  renderAll();
}

/** Older pages, at most five per arrival, until one adds a match for the search. */
async function loadOlderMatches(): Promise<boolean> {
  const before = visibleMessages().length;
  searchingOlder = true;
  renderContent();
  let found = false;
  for (let i = 0; i < model.SEARCH_PAGES_PER_ARRIVAL && snap?.hasMore; i++) {
    const grew = await Desk.gramLoadOlder().catch(() => false);
    snap = await Desk.gramState();
    if (!grew) break;
    if (visibleMessages().length > before) {
      found = true;
      break;
    }
  }
  searchingOlder = false;
  searchedWithoutMatch = found ? null : (snap?.messages.length ?? 0);
  if (found) renderLimit = Math.max(renderLimit, visibleMessages().length);
  return found;
}

/** "Search older messages" in the No matches state. */
async function searchOlder() {
  if (searchingOlder) return;
  await loadOlderMatches();
  renderAll();
}

function setupCard(): HTMLElement {
  const c = el("div", "gsetup");
  paintShape(c, { radius: 14, fill: "var(--color-surface)", stroke: "var(--color-hairline)", strokeWidth: 1 });
  const top = el("div", "gsetup-top");
  const lines = el("div", "gsetup-lines");
  lines.append(el("div", "gsetup-title", "Set up gram for your agents"), el("div", "gsetup-body", "Paste this to your agents so they can message you here."));
  const close = button("gsetup-close", "Dismiss", () => {
    localStorage.setItem(SETUP_DISMISSED, "1");
    renderContent();
  });
  close.append(icon("xmark", 12, "semibold"));
  top.append(lines, close);
  const cmd = el("div", "gsetup-command", SETUP_COMMAND);
  const copy = button("gsetup-copy", "Copy command", () => {
    void Desk.gramCopyText(SETUP_COMMAND);
    setupCopied = true;
    copy.textContent = "Copied ✓";
  });
  copy.textContent = setupCopied ? "Copied ✓" : "Copy command";
  c.append(top, cmd, copy);
  return c;
}

// ---- Saved (GramSavedFeed) ----

function renderSaved() {
  if (!snap) return;
  const all = snap.saved;
  const visible = model.filterSaved(all, search);
  const view = model.savedView(all.length, visible.length);
  if (view === "empty") {
    showState(stateView({ icon: "bookmark", title: "No saved messages yet", body: "Tap the bookmark on a message to keep it here." }));
    return;
  }
  if (view === "noMatches") {
    const t = model.noMatchesText(false, all.length, search, null);
    showState(stateView({ icon: "magnifyingglass", title: t.title, body: t.body }));
    return;
  }
  const fresh = !scroller || scroller.dataset.kind !== "saved";
  ensureScroller("saved");
  const sc = scroller!;
  const keep = fresh ? null : pageAnchor ?? anchorRow();
  const drawn = model.drawnWindow(visible, savedLimit);
  const nodes: HTMLElement[] = [];
  const seen = new Set<string>();
  for (const s of drawn) {
    seen.add(s.id);
    const dl = downloads.get(s.id);
    const sig = JSON.stringify([s, [...(expanded.get(s.id) ?? [])], dl ? [dl.done, dl.size, dl.state] : null, s.text.includes("```") ? copied : null, Math.floor(Date.now() / 60000)]);
    const cached = rowNodes.get(s.id);
    if (cached && cached.sig === sig) {
      nodes.push(cached.node);
      continue;
    }
    const slot = el("div", "gslot saved");
    slot.dataset.id = s.id;
    slot.append(savedRow(s));
    rowNodes.set(s.id, { sig, node: slot });
    nodes.push(slot);
  }
  for (const id of rowNodes.keys()) if (!seen.has(id)) rowNodes.delete(id);
  if (all.length > 0 && visible.length > savedLimit) {
    const s = el("div", "gsentinel");
    const sp = el("span", "gsentinel-spin");
    sp.innerHTML = deps.spinner;
    s.append(sp, el("span", "", "Loading older saved messages…"));
    if (sentinelEl) feedObserver?.unobserve(sentinelEl);
    sentinelEl = s;
    feedObserver?.observe(s);
    nodes.unshift(s);
  } else sentinelEl = null;
  feedList.replaceChildren(...nodes);
  footerEl.replaceChildren();
  measureFolds(feedList);
  void deps.placeInitials(feedList);
  if (!landed) {
    sc.scrollTop = sc.scrollHeight;
    requestAnimationFrame(() => {
      sc.scrollTop = sc.scrollHeight;
      landed = true;
      if (sentinelEl && isOnScreen(sentinelEl)) revealOlderSaved();
    });
  } else restoreAnchor(keep);
  pageAnchor = null;
  newButton.hidden = true;
}

function revealOlderSaved() {
  if (!landed || !pageArmed) return;
  pageArmed = false;
  pageAnchor = anchorRow();
  savedLimit += model.RENDER_WINDOW;
  renderSaved();
}

// ---- Rows (GramRow, SavedGramRow / GramLoneMessage) ----

function messageRow(m: GramMessage, startsGroup: boolean, endsGroup: boolean): HTMLElement {
  const mine = !m.fromAgent;
  const row = el("div", "grow " + (mine ? "mine" : "theirs") + (m.saved ? " saved" : ""));
  if (startsGroup && !mine) row.append(senderLine(m));
  const line = el("div", "grow-line");
  if (!mine) line.append(endsGroup ? gramAvatar(m.from, 28) : el("div", "gavatar-space"));
  const parts = el("div", "gparts");
  const segs = segments(m.text);
  const imageFile = m.file?.isImage ? m.file : undefined;
  const hasCard = (!!m.file && !m.file.isImage) || !!m.expiredFile;
  const hasText = segs.length > 0 || hasCard;
  const items = model.menuItems({ hasFile: !!m.file, hasText: m.text !== "", saved: m.saved, savedCopy: false });
  const menu = (part: HTMLElement) =>
    part.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      void Desk.gramMenu(m.id, items);
    });
  if (hasText) {
    const part = textPart(m.id, segs, mine, hasCard, (embedded) => fileCardFor(m, embedded));
    if (model.showsTail({ endsGroup, hasText: segs.length > 0, hasCard, hasImage: !!imageFile })) part.append(tail(mine));
    if (m.saved) part.append(savedBadge());
    menu(part);
    parts.append(part);
  }
  if (imageFile) {
    const part = el("div", "gpart");
    part.append(imageCard(m.id, imageFile.name, imageFile.sizeLabel, imageFile.preview));
    if (m.saved && !hasText) part.append(savedBadge());
    menu(part);
    parts.append(part);
  }
  line.append(parts);
  row.append(line);
  if (mine && m.statusVerb) {
    const st = el("div", "gstatus" + (m.grabbedBy ? " grabbed" : ""));
    st.append(el("strong", "", m.statusVerb), document.createTextNode(` ${m.statusRest ?? ""}`));
    row.append(st);
  }
  return row;
}

function senderLine(m: GramMessage): HTMLElement {
  const s = el("div", "gsender");
  s.append(el("span", "", m.name));
  if (m.machine) s.append(el("span", "gsender-machine", ` · ${m.machine}`));
  return s;
}

/** GramRow.age: "now", "Nm", "Nh", "Nd". */
function age(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function savedRow(s: SavedGram): HTMLElement {
  const mine = !s.fromAgent;
  const row = el("div", "grow lone " + (mine ? "mine" : "theirs"));
  const head = el("div", "glone-head");
  const unsave = button("glone-unsave", "Unsave", () => void Desk.gramSetSaved(s.id, false).catch(() => undefined));
  unsave.append(icon("bookmark.fill", 12, "semibold"));
  head.append(el("span", "glone-from", s.fromAgent ? s.from : "You"), el("span", "glone-age", age(s.createdUnixMs)), unsave);
  row.append(head);
  const line = el("div", "grow-line");
  if (!mine) line.append(gramAvatar(s.from, 28));
  const segs = segments(s.text);
  const hasCard = !!s.file || !!s.expiredFile;
  if (segs.length > 0 || hasCard) {
    const parts = el("div", "gparts");
    const part = textPart(s.id, segs, mine, hasCard, (embedded) =>
      s.file
        ? fileCard(s.id, s.file.name, s.file.mime, sizeLabel(s.file.size), embedded)
        : expiredCard(s.expiredFile!.name, sizeLabel(s.expiredFile!.size), embedded),
    );
    if (segs.length > 0 && !hasCard) part.append(tail(mine));
    const items = model.menuItems({ hasFile: !!s.file, hasText: s.text !== "", saved: true, savedCopy: true });
    part.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      void Desk.gramMenu(s.id, items);
    });
    parts.append(part);
    line.append(parts);
  }
  row.append(line);
  return row;
}

/** herdrup's displaySize: "N B", "N KB", "N.N MB". */
function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileCardFor(m: GramMessage, embedded: boolean): HTMLElement | null {
  if (m.file && !m.file.isImage) return fileCard(m.id, m.file.name, m.file.mime, m.file.sizeLabel, embedded);
  if (m.expiredFile) return expiredCard(m.expiredFile.name, m.expiredFile.sizeLabel, embedded);
  return null;
}

/** GramTextPart: a plain bubble for prose alone; a card the whole cap wide once there is code or
 * a file; the bare file card for a file with no text. */
function textPart(
  id: string,
  segs: GramTextSegment[],
  mine: boolean,
  hasCard: boolean,
  cardOf: (embedded: boolean) => HTMLElement | null,
): HTMLElement {
  const part = el("div", "gpart");
  const hasCode = segs.some((s) => s.kind === "code");
  const fill = mine ? "var(--gram-out-fill)" : "var(--color-surface-raised)";
  if (segs.length === 0 && hasCard) {
    const c = cardOf(false);
    if (c) part.append(c);
    part.classList.add("wide");
    return part;
  }
  const bubble = el("div", "gbubble " + (mine ? "out" : "in"));
  if (hasCode || hasCard) {
    part.classList.add("wide");
    bubble.classList.add("card");
    segs.forEach((s, i) => {
      if (s.kind === "text") {
        const p = prose(id, s.text, i, mine);
        p.classList.add("in-card");
        bubble.append(p);
      } else bubble.append(codeBlock(s.code, s.language));
    });
    const c = hasCard ? cardOf(true) : null;
    if (c) bubble.append(c);
    else bubble.append(el("div", "gcard-end"));
    paintShape(bubble, { radius: 18, fill, clip: true });
  } else {
    bubble.classList.add("plain");
    segs.forEach((s, i) => {
      if (s.kind === "text") bubble.append(prose(id, s.text, i, mine));
    });
    paintShape(bubble, { radius: 18, fill });
  }
  part.append(bubble);
  return part;
}

/** GramFoldingText: whole up to eight lines; past that the eighth ends in "…" and "Read more" /
 * "Show less" sits under it. The open segments are the page's, by message and segment. */
function prose(id: string, text: string, index: number, mine: boolean): HTMLElement {
  const box = el("div", "gprose");
  const open = expanded.get(id)?.has(index) ?? false;
  const body = el("div", "gprose-text" + (open ? "" : " clamp"));
  for (const run of model.linkRuns(text)) {
    if (run.href === null) body.append(document.createTextNode(run.text));
    else {
      const a = el("a", "glink", run.text);
      a.href = run.href;
      a.target = "_blank";
      a.rel = "noopener";
      body.append(a);
    }
  }
  const toggle = button("gfold", foldToggleLabel(open), () => {
    const set = expanded.get(id) ?? new Set<number>();
    if (open) set.delete(index);
    else set.add(index);
    if (set.size === 0) expanded.delete(id);
    else expanded.set(id, set);
    renderContent();
  });
  toggle.textContent = foldToggleLabel(open);
  toggle.hidden = true;
  box.dataset.open = open ? "1" : "";
  box.append(body, toggle);
  box.classList.add(mine ? "out" : "in");
  return box;
}

/** Shows "Read more" where the whole text is taller than eight lines of it, both measured at
 * the shown width. */
function measureFolds(root: ParentNode) {
  for (const box of root.querySelectorAll<HTMLElement>(".gprose")) {
    const body = box.firstElementChild as HTMLElement;
    const toggle = box.lastElementChild as HTMLElement;
    const open = box.dataset.open === "1";
    body.classList.add("clamp");
    const folded = body.getBoundingClientRect().height;
    body.classList.remove("clamp");
    const full = body.getBoundingClientRect().height;
    if (!open) body.classList.add("clamp");
    toggle.hidden = !gramTextFolds(full, folded);
  }
}

function codeBlock(code: string, language: string | null): HTMLElement {
  const b = el("div", "gcode");
  paintShape(b, { radius: 11, fill: "var(--color-ground-machine)", stroke: "var(--color-hairline)", strokeWidth: 1 });
  const isCopied = copied === code;
  const copy = () => {
    void Desk.gramCopyText(code);
    copied = code;
    clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => {
      copied = null;
      renderContent();
    }, 1600);
    renderContent();
  };
  const pre = el("pre", "gcode-text", code);
  const scroll = el("div", "gcode-scroll");
  scroll.append(pre);
  if (!code.includes("\n")) {
    b.classList.add("one-line");
    const c = button("gcode-copy-glyph" + (isCopied ? " copied" : ""), isCopied ? "Copied" : "Copy code", copy);
    c.append(icon(isCopied ? "checkmark" : "doc.on.doc", 14, "semibold"));
    b.append(scroll, c);
  } else {
    const head = el("div", "gcode-head");
    if (language) head.append(el("span", "gcode-lang", language));
    head.append(el("span", "gcode-spacer"));
    const c = button("gcode-copy" + (isCopied ? " copied" : ""), isCopied ? "Copied" : "Copy code", copy);
    c.append(icon(isCopied ? "checkmark" : "doc.on.doc", 11, "semibold"), el("span", "", isCopied ? "Copied" : "Copy"));
    head.append(c);
    b.append(head, scroll);
  }
  return b;
}

const measureCtx = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;

/** A name cut in the middle to fit its line once laid out (SwiftUI `.truncationMode(.middle)`). */
function middleName(cls: string, name: string): HTMLElement {
  const n = el("span", `${cls} gram-middle-name`, name);
  n.title = name;
  requestAnimationFrame(() => fitMiddleName(n));
  return n;
}
function fitMiddleName(n: HTMLElement) {
  const name = n.title;
  n.textContent = name;
  const max = n.clientWidth;
  if (max <= 0 || n.scrollWidth <= max) return;
  const s = getComputedStyle(n);
  measureCtx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
  n.textContent = model.middleTruncate(name, max, (t) => measureCtx.measureText(t).width);
}

function openFile(id: string) {
  if (downloads.get(id)?.state === "downloading") return;
  void Desk.gramOpenFile(id).catch((err: unknown) => {
    // A program or script is never opened: saving it is what is left.
    if (String(err).includes("is a program or script")) void Desk.gramSaveFile(id).catch(() => undefined);
  });
}

/** GramFileCard: the document icon with its extension, the name and "<kind> · <size>"; the whole
 * card opens the file. Alone it is an agent card; under text, a hairline rule opens it. */
function fileCard(id: string, name: string, mime: string, size: string, embedded: boolean): HTMLElement {
  const c = el("div", "gfile" + (embedded ? " embedded" : ""));
  c.setAttribute("role", "button");
  c.setAttribute("aria-label", `Open ${name}`);
  const doc = el("div", "gdoc");
  doc.append(el("span", "gdoc-label", model.documentLabel(name)));
  const dl = downloads.get(id);
  if (dl?.state === "downloading") {
    const r = el("span", "gdoc-ring");
    r.append(ring(22, dl.size > 0 ? dl.done / dl.size : null));
    doc.append(r);
  }
  const lines = el("div", "gfile-lines");
  const kind = model.fileKind(name, mime);
  lines.append(middleName("gfile-name", name), el("span", "gfile-detail", [kind, size].filter((s) => s !== "").join(" · ")));
  const rowEl = el("div", "gfile-row");
  rowEl.append(doc, lines);
  c.append(rowEl);
  c.addEventListener("click", () => openFile(id));
  if (!embedded) paintShape(c, { radius: 18, fill: "var(--color-surface-raised)", clip: true });
  return c;
}

function expiredCard(name: string, size: string, embedded: boolean): HTMLElement {
  const c = el("div", "gfile expired" + (embedded ? " embedded" : ""));
  const pic = el("div", "gexpired-icon");
  pic.append(icon("clock.badge.xmark", 22, "regular"));
  const lines = el("div", "gfile-lines");
  lines.append(middleName("gfile-name", name), el("span", "gfile-detail", ["No longer available", size].join(" · ")));
  const rowEl = el("div", "gfile-row");
  rowEl.append(pic, lines);
  c.append(rowEl);
  if (!embedded) paintShape(c, { radius: 18, fill: "var(--color-surface-raised)", clip: true });
  return c;
}

const imageDims = new Map<string, { width: number; height: number }>();
const imageTimers = new Map<string, number>();
let imageObserver: IntersectionObserver | null = null;

/** GramImageCard: the picture once fetched, else a placeholder naming the file; opens on click. */
function imageCard(id: string, name: string, size: string, preview: boolean): HTMLElement {
  const c = el("div", "gimage");
  c.setAttribute("role", "button");
  c.setAttribute("aria-label", `Open ${name}, ${size}`);
  c.dataset.image = id;
  const dl = downloads.get(id);
  const url = images.get(id);
  const box = model.imageBox(url ? (imageDims.get(id) ?? null) : null);
  c.style.setProperty("--box-w", `${box.width}px`);
  c.style.aspectRatio = `${box.width} / ${box.height}`;
  if (url) {
    const img = el("img", "gimage-pic");
    img.alt = "";
    img.src = url;
    c.append(img);
    if (dl?.state === "downloading") {
      const r = el("span", "gimage-ring");
      r.append(ring(28, dl.size > 0 ? dl.done / dl.size : null));
      c.append(r);
    }
  } else {
    const ph = el("div", "gimage-placeholder");
    if (dl?.state === "downloading") ph.append(ring(28, dl.size > 0 ? dl.done / dl.size : null));
    else ph.append(icon("photo", 28, "regular", "faint"));
    const label = el("div", "gimage-label");
    label.append(middleName("gimage-name", name), el("span", "gimage-size", ` · ${size}`));
    ph.append(label);
    c.append(ph);
    if (preview && url === undefined) {
      imageObserver ??= new IntersectionObserver((entries) => {
        for (const e of entries) {
          const t = e.target as HTMLElement;
          const mid = t.dataset.image ?? "";
          if (e.isIntersecting && landed) {
            if (imageTimers.has(mid)) continue;
            // A card must stay on screen a moment: a fling only flies past.
            imageTimers.set(
              mid,
              window.setTimeout(() => {
                imageTimers.delete(mid);
                imageObserver?.unobserve(t);
                void loadImage(mid);
              }, model.IMAGE_PREVIEW_DELAY_MS),
            );
          } else {
            clearTimeout(imageTimers.get(mid));
            imageTimers.delete(mid);
          }
        }
      });
      imageObserver.observe(c);
    }
  }
  paintShape(c, { radius: 18, fill: "var(--color-surface-raised)", clip: true });
  c.addEventListener("click", () => openFile(id));
  return c;
}

async function loadImage(id: string) {
  if (images.has(id)) return;
  try {
    const url = await Desk.gramImage(id);
    const img = new Image();
    img.src = url;
    await img.decode();
    imageDims.set(id, { width: img.naturalWidth, height: img.naturalHeight });
    images.set(id, url);
  } catch {
    images.set(id, null);
    return;
  }
  // Redraw the rows that show it.
  for (const [rid, r] of rowNodes) if (rid === id) r.sig = "";
  renderContent();
}

/** GramSavedBadge: the tapback on the part's top corner. */
function savedBadge(): HTMLElement {
  const b = el("div", "gbadge");
  b.append(el("span", "gbadge-dot small"), el("span", "gbadge-dot"));
  const cap = el("span", "gbadge-cap");
  cap.append(icon("bookmark.fill", 13, "semibold"));
  b.append(cap);
  return b;
}

/** BubbleTail in a 24 x 22 box whose x = 6 is the bubble's edge, mirrored for yours. */
function tail(mine: boolean): HTMLElement {
  const t = el("span", "gtail " + (mine ? "out" : "in"));
  t.innerHTML =
    `<svg width="24" height="22" viewBox="0 0 24 22"><path d="M6 0L6 12C6 16.8 3.8 20.3 0 22C7 22.7 14 22.3 24 22L24 0Z"/></svg>`;
  return t;
}

// ---- Context menu choices ----

function chooseMenu(id: string, item: string) {
  const m = snap?.messages.find((x) => x.id === id);
  const s = snap?.saved.find((x) => x.id === id);
  const text = m?.text ?? s?.text ?? "";
  switch (item) {
    case "Save to Files":
      void Desk.gramSaveFile(id).catch(() => undefined);
      break;
    case "Copy":
      void Desk.gramCopyText(text);
      break;
    case "Save":
    case "Unsave":
      void Desk.gramSetSaved(id, item === "Save").catch(() => undefined);
      break;
    case "Delete":
      void Desk.gramDelete(id).catch(() => undefined);
      break;
  }
}

// ---- Composer ----

function agents(): GramAgent[] {
  return (snap?.agents ?? []).map((a) => ({ from: a.from, name: a.name, machine: a.machine || null }));
}

function address(): DraftAddress {
  return draftAddress(draft, agents(), pickedAgent);
}

function buildComposer(): HTMLElement {
  const c = el("div", "gram-composer gcol");
  hintEl = el("div", "ghint");
  hintEl.hidden = true;
  card = el("div", "gcard");
  paintShape(card, { radius: 28, fill: "var(--color-surface)", stroke: "var(--gram-card-edge)", strokeWidth: 1 });
  const field = el("div", "gfield");
  mirror = el("div", "gfield-mirror");
  mirror.setAttribute("aria-hidden", "true");
  input = el("textarea", "gfield-input");
  input.rows = 1;
  input.placeholder = "Queue, or @ an agent…";
  input.spellcheck = true;
  input.setAttribute("autocapitalize", "sentences");
  field.append(mirror, input);
  strip = el("div", "gstrip");
  actions = el("div", "gactions");
  card.append(field, strip, actions);
  editor = new ComposerEditor(card, input, layoutComposer);
  stopFileDrop?.();
  stopFileDrop = composerFileDrop(card, paths => { void pickFiles(paths); });
  stopClipboardPaste?.();
  stopClipboardPaste = composerClipboardPaste(input, () => {
    if (picking || posting || snap?.sending || !shown) return Promise.reject(new Error("Wait for the current attachment operation to finish."));
    return Desk.gramPasteClipboard();
  }, error => { banner.hidden = false; banner.textContent = String(error); });
  mentionHost = el("div", "gmentions");
  mentionHost.hidden = true;
  dictation = new ComposerDictation(input, renderComposer, () => editor.collapse());
  field.prepend(dictation.strip);
  c.append(mentionHost, hintEl, card);

  const caretMoved = () => {
    caret = input.selectionStart ?? input.value.length;
    renderComposer();
  };
  input.addEventListener("input", () => {
    draft = input.value;
    draftRevision++;
    caret = input.selectionStart ?? draft.length;
    if (pickedAgent && !pickStillHolds(draft, agents(), pickedAgent)) pickedAgent = null;
    renderComposer();
  });
  input.addEventListener("keyup", caretMoved);
  input.addEventListener("click", caretMoved);
  input.addEventListener("scroll", () => (mirror.scrollTop = input.scrollTop));
  input.addEventListener("focus", () => {
    composerFocused = true;
    card.classList.add("focused");
  });
  input.addEventListener("blur", () => {
    composerFocused = false;
    card.classList.remove("focused");
  });
  input.addEventListener("keydown", (e) => {
    // ⌘Return sends (Ctrl+Return off the Mac).
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  });
  return c;
}

function setDraft(text: string, newCaret: number) {
  draft = text;
  draftRevision++;
  input.value = text;
  caret = newCaret;
  input.setSelectionRange(newCaret, newCaret);
  renderComposer();
}

/** The field's text with the addressing mention in brand colour, under the transparent
 * textarea (accentRanges). */
function renderMirror(a: DraftAddress) {
  const text = draft;
  if (!a.accent) mirror.textContent = text + "\n";
  else {
    mirror.replaceChildren(
      document.createTextNode(text.slice(0, a.accent.start)),
      el("span", "gaccent", text.slice(a.accent.start, a.accent.end)),
      document.createTextNode(text.slice(a.accent.end) + "\n"),
    );
  }
  mirror.scrollTop = input.scrollTop;
}

let lineProbe: HTMLElement | null = null;
let editor: ComposerEditor;
let stopFileDrop: (() => void) | undefined;
let stopClipboardPaste: (() => void) | undefined;

/** The text's lines at `width`, measured as the field draws it (ComposerTextMetrics.lines). */
function linesAt(width: number): number {
  lineProbe ??= (() => {
    const p = el("div", "gfield-probe");
    document.body.append(p);
    return p;
  })();
  lineProbe.style.width = `${Math.max(1, width)}px`;
  lineProbe.textContent = draft === "" || draft.endsWith("\n") ? draft + " " : draft;
  return Math.max(1, Math.round(lineProbe.getBoundingClientRect().height / 24));
}

/** One row at rest; the stacked layout once a file is attached or the text wraps. The field
 * shows five lines before it scrolls. */
function layoutComposer() {
  if (!card.isConnected) return;
  const contentWidth = card.clientWidth - 12;
  const actionsWidth = actions.offsetWidth;
  // The field's insets: 5 + 7 leading, 2 trailing.
  const inline = contentWidth - actionsWidth - 4 - 14;
  const hasAttachments = (snap?.attachments.length ?? 0) > 0;
  const expand = editor.open || (!!dictation && !dictation.strip.hidden && draft.length > 0) || (contentWidth > 0 && model.composerExpanded(hasAttachments, linesAt, inline, wrapped));
  wrapped = expand && !hasAttachments && !editor.open;
  card.classList.toggle("expanded", expand);
  const lines = linesAt(expand ? contentWidth - 14 : inline);
  const host = card.closest<HTMLElement>(".gram")!;
  const room = Math.max(0, host.clientHeight - headerHeight - banner.offsetHeight - hintEl.offsetHeight - 12 - 56 - 12);
  input.style.height = `${editor.update(lines, room)}px`;
  mirror.style.height = input.style.height;
}

function chip(a: GramAttachment): HTMLElement {
  return composerAttachment(model.mergeChip(a, uploads.get(a.path)), snap?.sending ?? false,
    () => void Desk.gramCancelAttachment(a.path).catch(() => undefined),
    () => void Desk.gramRetryAttachment(a.path).catch(() => undefined));
}

/** ComposerActionIcon: a 40 pt circle in a 44 pt target. */
function actionIcon(cls: string, label: string, action: () => void): HTMLButtonElement {
  const b = button("gaction " + cls, label, action);
  b.append(el("span", "gaction-circle"));
  return b;
}

function renderComposer() {
  if (!card) return;
  const a = address();
  const list = activeQuery(draft, caret);
  const matches = list ? model.mentionMatches(agents(), list.query) : [];
  const hint = model.shownHint(draftHint(a.route), matches.length > 0);
  hintEl.hidden = hint === null;
  hintEl.textContent = hint ?? "";
  renderMirror(a);
  renderMentions(matches);

  const attachments = snap?.attachments ?? [];
  strip.hidden = attachments.length === 0;
  strip.replaceChildren(...attachments.map(chip));

  const sending = snap?.sending ?? false;
  const attach = actionIcon("attach", "Attach file", () => void pickFiles());
  attach.append(icon("paperclip", 18, "regular", "dim"));
  attach.disabled = sending || picking;
  if (dictation) dictation.button.disabled = sending || posting;
  const nodes: HTMLElement[] = dictation ? [attach, dictation.button] : [attach];
  // Send takes the saved prompts' place once there is something to send.
  if (attachments.length > 0 || draft.trim() !== "") {
    const s = actionIcon("primary", "Send gram", () => void send());
    if (sending && snap?.sendProgressShown) s.append(ring(18, snap.sendProgress));
    else if (sending) s.append(glyph("sending", 18));
    else s.append(glyph("send", 18));
    s.classList.toggle("busy", sending);
    s.disabled = !!dictation?.busy || !model.canSend(a, attachments.length, sending, picking);
    nodes.push(s);
  }
  actions.replaceChildren(...nodes);
  layoutComposer();
}

function renderMentions(matches: GramAgent[]) {
  mentionHost.hidden = matches.length === 0;
  if (matches.length === 0) {
    mentionHost.replaceChildren();
    return;
  }
  const shared = sharedNames(agents());
  const list = el("div", "gmention-list");
  list.append(el("div", "gmention-head", "Send to one agent"));
  for (const agent of matches) {
    const row = el("div", "gmention-row");
    const t = model.agentTitle(agent, shared);
    const lines = el("div", "gmention-lines");
    lines.append(el("span", "gmention-name", t.title));
    if (t.machineLine) lines.append(el("span", "gmention-machine", t.machineLine));
    row.append(gramAvatar(agent.from, 32), lines);
    // Keep the field's focus and caret.
    row.addEventListener("mousedown", (e) => e.preventDefault());
    row.addEventListener("click", () => pick(agent));
    list.append(row);
  }
  list.append(el("div", "gmention-foot", "No @ and it goes to the shared queue."));
  paintShape(list, { radius: 18, fill: "var(--color-surface-raised)", stroke: "var(--color-hairline)", strokeWidth: 1 });
  mentionHost.replaceChildren(list);
  void deps.placeInitials(list);
}

function pick(agent: GramAgent) {
  const active = activeQuery(draft, caret);
  if (!active) return;
  const next = complete(draft, active, agent.name);
  pickedAgent = agent;
  setDraft(next, model.caretAfter(draft, caret, next));
  input.focus();
}

async function pickFiles(paths?: string[]) {
  if (picking || posting || snap?.sending || !shown) return;
  picking = true;
  renderComposer();
  try {
    if (paths) await Desk.gramAttachFiles(paths); else await Desk.gramPickFiles();
  } catch {
    // The banner names what was skipped.
  } finally {
    picking = false;
    renderComposer();
  }
}

async function send() {
  if (dictation?.busy) return;
  const a = address();
  const attachments = snap?.attachments ?? [];
  if (!model.canSend(a, attachments.length, (snap?.sending ?? false) || posting, picking)) return;
  // Capture both route and revision. An acknowledgement belongs to this
  // submission, never to text typed while its upload or post was pending.
  const to = draftRecipient(a);
  const revision = draftRevision;
  submittedDraftRevision = revision;
  posting = true;
  try {
    await Desk.gramPost(a.body, to ? [to] : [], attachments.map((x) => x.path));
  } catch {
    // The backend's banner reports failure; leave unsent text intact.
  } finally {
    posting = false;
  }
}

// ---- Agents sheet (the "Gram ›" pill) ----

function openAgentsSheet() {
  const d = el("dialog", "gsheet");
  const draw = () => {
    const a = address();
    const head = el("div", "gsheet-head");
    head.append(el("span", "gsheet-title", "Gram"));
    const done = button("gsheet-done", "Done", () => d.close());
    done.textContent = "Done";
    head.append(done);
    const first = el("div", "gsheet-group");
    const readAll = sheetRow("envelope.open", "Read all", null, () => void Desk.gramMarkAllRead().catch(() => undefined));
    readAll.toggleAttribute("disabled", (snap?.markingAllRead ?? false) || (snap?.unreadCount ?? 0) === 0);
    const refresh = sheetRow("arrow.clockwise", "Refresh", null, () => void Desk.gramRefresh().catch(() => undefined));
    if (snap?.refreshing) {
      const s = el("span", "gsheet-spin");
      s.innerHTML = deps.spinner;
      refresh.append(s);
      refresh.toggleAttribute("disabled", true);
    }
    first.append(readAll, refresh);
    const write = el("div", "gsheet-group");
    const shared = sharedNames(agents());
    for (const agent of agents()) {
      const t = model.agentTitle(agent, shared);
      const row = sheetRow(null, t.title, t.machineLine, () => {
        pickedAgent = agent;
        const next = addressing(draft, agent.name, mentionNames(agents()));
        setDraft(next, next.length);
        d.close();
      });
      row.prepend(gramAvatar(agent.from, 32));
      if (model.isAddressed(a, agent)) row.append(icon("checkmark", 17, "semibold", "brand"));
      write.append(row);
    }
    const queue = sheetRow("tray.and.arrow.down", "Shared queue", "Any agent can grab it", () => {
      pickedAgent = null;
      const next = unaddressed(draft, mentionNames(agents()));
      setDraft(next, next.length);
      d.close();
    });
    queue.classList.add("queue");
    if (model.isAddressed(a, null)) queue.append(icon("checkmark", 17, "semibold", "brand"));
    write.append(queue);
    d.replaceChildren(head, first, el("div", "gsheet-section", "Write to"), write);
    void deps.placeInitials(d);
  };
  draw();
  const off = events.gramChanged.on(() => queueMicrotask(draw));
  d.addEventListener("close", () => {
    off();
    d.remove();
  });
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  });
  document.body.append(d);
  d.showModal();
}

function sheetRow(symbolName: string | null, title: string, subtitle: string | null, action: () => void): HTMLElement {
  const row = el("div", "gsheet-row");
  row.setAttribute("role", "button");
  if (symbolName) {
    const i = el("span", "gsheet-icon");
    i.append(icon(symbolName, 15, "semibold"));
    row.append(i);
  }
  const lines = el("div", "gsheet-lines");
  lines.append(el("span", "gsheet-row-title", title));
  if (subtitle) lines.append(el("span", "gsheet-row-sub", subtitle));
  row.append(lines, el("span", "gsheet-spacer"));
  row.addEventListener("click", () => {
    if (!row.hasAttribute("disabled")) action();
  });
  return row;
}


// ---- Wiring ----

function onSnapshot(s: GramSnapshot) {
  const prevUnread = snap?.unreadCount ?? 0;
  snap = s;
  if (draftPosted !== null && s.draftPosted > draftPosted) {
    if (submittedDraftRevision === draftRevision) {
      pickedAgent = null;
      setDraft("", 0);
    }
    submittedDraftRevision = null;
  } else if (draftPosted !== null && s.draftPosted < draftPosted) {
    // Reconnecting replaces the backend composer and resets its counter.
    submittedDraftRevision = null;
  }
  draftPosted = s.draftPosted;
  for (const [path, ev] of uploads) {
    const c = s.attachments.find((a) => a.path === path);
    if (!c || c.state !== ev.state) uploads.delete(path);
  }
  // A new visit's rule: unread went from none to some.
  if (prevUnread === 0 && s.unreadCount > 0 && shown) captureRule();
  if (s.phase === "loading" && s.messages.length === 0) {
    // A new connection: nothing of the last one's feed applies.
    landed = false;
    renderLimit = model.RENDER_WINDOW;
    images.clear();
    faces.clear();
    facesKnown.clear();
  }
  if (!shown) {
    updateBar();
    return;
  }
  renderAll();
}

/** Builds the Gram page into `detail` and its sidebar into `sidebar`, both hidden until shown. */
export async function initGram(d: GramDeps, detail: HTMLElement, sidebar: HTMLElement, before: HTMLElement) {
  deps = d;
  el = d.el;
  // GramBubble.outFill and the composer card's edge: herdrup literals, not tokens (GramView.swift
  // GramBubble, ComposerView.swift strokeBorder), set here as sessions.ts does its own.
  const root = document.documentElement.style;
  root.setProperty("--gram-out-fill", "#5a4ed6");
  root.setProperty("--gram-mention-shadow", "rgb(0 0 0 / 0.5)");
  root.setProperty("--gram-readout-fill", "rgb(64 70 110 / 0.96)");
  root.setProperty("--gram-readout-edge", "rgb(255 255 255 / 0.2)");
  root.setProperty("--gram-readout-shadow", "rgb(0 0 0 / 0.7)");
  root.setProperty("--gram-grip-active", "rgb(204 210 230 / 0.9)");
  detail.append(buildPage());
  sidebar.insertBefore(buildSidebar(), before);
  page.hidden = true;
  side.hidden = true;
  sideClear.hidden = true;
  events.gramChanged.on(onSnapshot);
  events.gramUpload.on((ev) => {
    if (ev.state === "removed") uploads.delete(ev.path);
    else uploads.set(ev.path, ev);
    if (shown) renderComposer();
  });
  events.gramDownload.on((ev) => {
    if (ev.state === "downloading") downloads.set(ev.id, ev);
    else downloads.delete(ev.id);
    if (shown) renderContent();
  });
  events.gramMenu.on(({ id, item }) => chooseMenu(id, item));
  onSnapshot(await Desk.gramState());
}

/** Shows or hides Gram (the tab). Polling and mark-read follow it, as herdrup's. */
export function showGram(on: boolean) {
  if (on === shown || !page) return;
  shown = on;
  if (!on) dictation?.stop();
  page.hidden = !on;
  side.hidden = !on;
  void Desk.gramSetVisible(on);
  if (on) {
    landed = false;
    pageArmed = search === "";
    barKey = "";
    column.update();
    renderAll();
  } else {
    // The next visit captures its own "N unread" rule.
    ruleCaptured = false;
    unreadRule = null;
    showingNew = false;
  }
}

/** ⌘F on Gram: the cursor goes to the sidebar search. */
export function focusGramSearch() {
  sideSearch.focus();
  sideSearch.select();
}

export function gramShowing(): boolean {
  return shown;
}

export function gramComposerFocused(): boolean {
  return composerFocused;
}
