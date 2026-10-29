// The Gram screen's decisions, kept free of the DOM so bun tests them. Ported from herdrup
// 9876878: App/GramView.swift (feed entries, the unread rule, search, the states, the sentinel,
// @ list, Send), App/GramCards.swift (GramCardMetrics, GramThumbnails.boxSize, the avatar
// cluster), App/LinkText.swift (linkified), App/ComposerView.swift (the chip's icon), and
// Sources/HerdrKit/ConversationColumnWidth.swift (the column Gram shares with Chat).
import { canSendDraft, type DraftAddress, type GramAgent } from "./gramMention";
import { agentName } from "./gramText";

// MARK: - Feed

/** What the feed reads of a message (GramMessage in mygo.ts has all of it). */
export type FeedMessage = {
  id: string;
  fromAgent: boolean;
  from: string;
  to?: string;
  createdUnixMs: number;
};

/** One feed row and what draws above it (herdrup `GramFeedEntry`). */
export type FeedEntry<M extends FeedMessage> = {
  message: M;
  /** The time separator above the row: the message's own time. */
  separator: Date | null;
  /** The "N unread" rule above the row. */
  unreadCount: number | null;
  startsGroup: boolean;
  endsGroup: boolean;
};

/** Where the "N unread" rule sits and the count it shows. */
export type UnreadRule = { messageID: string; count: number };

/** How many of the newest messages the feed draws; each arrival at the top shows this many more. */
export const RENDER_WINDOW = 80;

/** Whether two messages (oldest first) belong to one group: the same side, and the same agent
 * (theirs) or the same recipient (yours). */
export function sameRun(a: FeedMessage, b: FeedMessage): boolean {
  if (a.fromAgent !== b.fromAgent) return false;
  return a.fromAgent ? a.from === b.from : (a.to ?? null) === (b.to ?? null);
}

function localSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * `rows` (oldest first) with their separators, the unread rule above `rule`'s message and their
 * sender groups. A separator goes above the first row, and above a row more than an hour after
 * the one before it or on another day. A separator or the rule breaks a group.
 */
export function feedEntries<M extends FeedMessage>(
  rows: readonly M[],
  rule: UnreadRule | null,
  sameDay: (a: Date, b: Date) => boolean = localSameDay,
): FeedEntry<M>[] {
  const markers = rows.map((m, i) => {
    const date = new Date(m.createdUnixMs);
    const prev = i > 0 ? new Date(rows[i - 1]!.createdUnixMs) : null;
    const separates = prev === null || (date.getTime() - prev.getTime()) / 1000 > 3600 || !sameDay(date, prev);
    return { separator: separates ? date : null, unread: rule?.messageID === m.id ? rule.count : null };
  });
  const breaks = (i: number) => markers[i]!.separator !== null || markers[i]!.unread !== null;
  return rows.map((message, i) => ({
    message,
    separator: markers[i]!.separator,
    unreadCount: markers[i]!.unread,
    startsGroup: i === 0 || breaks(i) || !sameRun(rows[i - 1]!, message),
    endsGroup: i + 1 === rows.length || breaks(i + 1) || !sameRun(message, rows[i + 1]!),
  }));
}

/** The feed's top gap for a row (herdrup `GramFeedRow`): none at the very top, 2 inside a
 * group, 10 between groups and after a marker. The separator gets 16 above it (none on the
 * first row), the rule 12 (none when it is the first thing). */
export function rowGaps(index: number, entry: FeedEntry<FeedMessage>): { separator: number; rule: number; row: number } {
  const afterMarker = entry.separator !== null || entry.unreadCount !== null;
  return {
    separator: index === 0 ? 0 : 16,
    rule: index === 0 && entry.separator === null ? 0 : 12,
    row: index === 0 && !afterMarker ? 0 : entry.startsGroup ? 10 : 2,
  };
}

/** The rule as a visit captures it before anything is marked read: on the oldest unread message,
 * counting the unread ones held. `messages` are newest first. None unread: no rule. */
export function captureUnreadRule(messages: readonly (FeedMessage & { unread: boolean })[]): UnreadRule | null {
  const unread = messages.filter((m) => m.unread);
  const oldest = unread[unread.length - 1];
  return oldest ? { messageID: oldest.id, count: unread.length } : null;
}

/** The newest `limit` of `messages` (newest first), oldest first, as the feed draws them. */
export function drawnWindow<M>(messages: readonly M[], limit: number): M[] {
  return messages.slice(0, limit).reverse();
}

function contains(haystack: string | undefined, needle: string): boolean {
  return (haystack ?? "").toLocaleLowerCase().includes(needle);
}

/** The inbox after the search: the text, the sender (routing and display name), the recipient
 * and the file's name match, ignoring case. An empty search shows everything. */
export function filterMessages<
  M extends { text: string; from: string; senderName: string; to?: string; file?: { name: string }; expiredFile?: { name: string } },
>(messages: readonly M[], search: string): M[] {
  if (search === "") return [...messages];
  const q = search.toLocaleLowerCase();
  return messages.filter(
    (m) =>
      contains(m.text, q) ||
      contains(m.from, q) ||
      contains(m.senderName, q) ||
      contains(m.to, q) ||
      contains((m.file ?? m.expiredFile)?.name, q),
  );
}

/** The saved list after the search: a saved copy has no recipient, so sender, text and file name. */
export function filterSaved<S extends { text: string; from: string; file?: { name: string }; expiredFile?: { name: string } }>(
  saved: readonly S[],
  search: string,
): S[] {
  if (search === "") return [...saved];
  const q = search.toLocaleLowerCase();
  return saved.filter((s) => contains(s.text, q) || contains(s.from, q) || contains((s.file ?? s.expiredFile)?.name, q));
}

// MARK: - States

/** What the inbox shows (herdrup `inboxContent`). */
export type InboxView =
  | { kind: "loading" }
  | { kind: "unavailable"; text: string }
  | { kind: "empty" }
  | { kind: "noMatches"; hasOlder: boolean; loadedCount: number }
  | { kind: "feed" };

export function inboxView(s: {
  phase: string;
  unavailable?: string;
  messageCount: number;
  visibleCount: number;
  search: string;
  showsSetupCard: boolean;
  hasMore: boolean;
}): InboxView {
  if (s.phase === "loading" || s.phase === "idle") return { kind: "loading" };
  if (s.phase === "unavailable") return { kind: "unavailable", text: s.unavailable ?? "" };
  if (s.messageCount === 0 && !s.showsSetupCard) return { kind: "empty" };
  if (s.search !== "" && s.messageCount > 0 && s.visibleCount === 0) {
    return { kind: "noMatches", hasOlder: s.hasMore, loadedCount: s.messageCount };
  }
  return { kind: "feed" };
}

/** What the Saved list shows. Saved is local and complete, so "No matches" has nothing older. */
export function savedView(savedCount: number, visibleCount: number): "empty" | "noMatches" | "feed" {
  if (savedCount === 0) return "empty";
  return visibleCount === 0 ? "noMatches" : "feed";
}

/** The "set up gram" card shows until an agent has written in the loaded window or it is dismissed. */
export function showsSetupCard(dismissed: boolean, messages: readonly { fromAgent: boolean }[]): boolean {
  return !dismissed && !messages.some((m) => m.fromAgent);
}

/** The feed's top sentinel: shown while older messages are held above the window or on herdr. */
export function showsSentinel(visibleCount: number, renderLimit: number, hasMore: boolean): boolean {
  return visibleCount > renderLimit || hasMore;
}

/** The sentinel's line (herdrup `inboxSentinel`). `spinner` draws the small progress view before it,
 * `retry` the arrow.clockwise of a failure, `arrow` the arrow.up of a search; `tappable` when a
 * tap does something. */
export function sentinelLine(s: {
  pageError: string | null;
  searching: boolean;
  searchingOlder: boolean;
  searchedWithoutMatch: number | null;
}): { text: string; icon: "spinner" | "retry" | "arrow"; tappable: boolean } {
  if (s.pageError !== null) return { text: `${s.pageError} Tap to retry.`, icon: "retry", tappable: true };
  if (s.searching && !s.searchingOlder) {
    return {
      text:
        s.searchedWithoutMatch !== null
          ? `No older matches in ${s.searchedWithoutMatch} messages. Tap or scroll up to search further`
          : "Tap or scroll up to search older messages",
      icon: "arrow",
      tappable: true,
    };
  }
  return { text: s.searching ? "Searching older messages…" : "Loading older messages…", icon: "spinner", tappable: false };
}

/** The "No matches" state's lines. */
export function noMatchesText(
  hasOlder: boolean,
  loadedCount: number,
  search: string,
  pageError: string | null,
): { title: string; body: string; offersOlder: boolean } {
  if (!hasOlder) return { title: "No matches", body: `Nothing in this list matches “${search}”.`, offersOlder: false };
  return {
    title: "No matches in recent messages",
    body:
      pageError !== null
        ? `${pageError} Nothing in the ${loadedCount} loaded matches “${search}”.`
        : `Nothing in the ${loadedCount} most recent messages matches “${search}”.`,
    offersOlder: true,
  };
}

/** At most this many older pages are fetched per arrival while searching (`searchPagesPerArrival`). */
export const SEARCH_PAGES_PER_ARRIVAL = 5;

// MARK: - Cards

/** An image card's size cap on iPad/Mac. */
export const IMAGE_CARD = { width: 440, height: 236 } as const;

/** The image card's box: the cap while the picture is unknown, then the picture's shape clamped
 * to 3:4 … 4:1, as large as fits the cap (herdrup `GramThumbnails.boxSize`). */
export function imageBox(
  picture: { width: number; height: number } | null,
  cap: { width: number; height: number } = IMAGE_CARD,
): { width: number; height: number } {
  if (!picture || picture.width <= 0 || picture.height <= 0) return { width: cap.width, height: cap.height };
  const aspect = Math.min(Math.max(picture.width / picture.height, 3 / 4), 4);
  const width = Math.min(cap.width, cap.height * aspect);
  return { width, height: width / aspect };
}

/** A staged file's chip with the latest upload event for it (sent at most once a percent,
 * between snapshots): the event's share and label while its state is the chip's. */
export function mergeChip<C extends { path: string; state: string; fraction: number; label: string }>(
  chip: C,
  event: { path: string; state: string; fraction: number; label: string } | undefined,
): C {
  if (!event || event.path !== chip.path || event.state !== chip.state) return chip;
  return { ...chip, fraction: event.fraction, label: event.label };
}

/**
 * The file's kind as Files names it (herdrup asks UTType for `localizedDescription`), from the
 * extension, else the mime type's family. A desktop has no UTType: this is the macOS wording of
 * the common types, and "" for the rest, which leaves the size alone on the card.
 */
export function fileKind(name: string, mime: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const known = FILE_KINDS[ext];
  if (known) return known;
  const family = mime.split("/")[0];
  if (family === "image") return "Image";
  if (family === "video") return "Movie";
  if (family === "audio") return "Audio";
  return mime.startsWith("text/") ? "Text" : "";
}

const FILE_KINDS: Record<string, string> = {
  png: "PNG image",
  jpg: "JPEG image",
  jpeg: "JPEG image",
  gif: "GIF image",
  heic: "HEIF image",
  webp: "WebP image",
  svg: "SVG image",
  tiff: "TIFF image",
  pdf: "PDF document",
  txt: "Plain Text",
  md: "Markdown document",
  csv: "comma-separated values",
  json: "JSON",
  html: "HTML text",
  xml: "XML text",
  log: "Log File",
  zip: "ZIP archive",
  gz: "gzip compressed archive",
  tgz: "gzip compressed archive",
  tar: "tar archive",
  mov: "QuickTime movie",
  mp4: "MPEG-4 movie",
  mp3: "MP3 audio",
  wav: "Waveform audio",
  go: "Go source",
  ts: "TypeScript source",
  js: "JavaScript script",
  py: "Python script",
  sh: "Shell script",
  swift: "Swift source",
  rs: "Rust source",
  yaml: "YAML",
  yml: "YAML",
};

/** `text` cut in the middle with "…" to fit `max` as `measure` measures it (SwiftUI's
 * `.truncationMode(.middle)`): as many characters as fit, the extra one before the cut. */
export function middleTruncate(text: string, max: number, measure: (s: string) => number): string {
  if (measure(text) <= max) return text;
  const chars = [...text];
  const cut = (keep: number) => chars.slice(0, Math.ceil(keep / 2)).join("") + "…" + chars.slice(chars.length - Math.floor(keep / 2)).join("");
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(cut(mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  return cut(lo);
}

/** Whether the composer leaves its one row for the stacked layout (`AdaptiveComposer.expanded`):
 * a file is attached, or the text needs more than one line beside the buttons. Once wrapped it
 * stays wrapped until the text fits 16 pt narrower, so typing at the edge cannot flicker. */
export function composerExpanded(hasAttachments: boolean, linesAt: (width: number) => number, inlineWidth: number, wrapped: boolean): boolean {
  return hasAttachments || linesAt(wrapped ? inlineWidth - 16 : inlineWidth) > 1;
}

/** A card must stay on screen this long before its preview is fetched, so a fling only passes it. */
export const IMAGE_PREVIEW_DELAY_MS = 250;

/** The document icon's label: up to four letters of the extension, upper-cased. */
export function documentLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toUpperCase().slice(0, 4);
}

/** The bubble tail shows only on a group's last message, on a part that ends in text: never on
 * a picture, a bare file card or a text + file card. */
export function showsTail(s: { endsGroup: boolean; hasText: boolean; hasCard: boolean; hasImage: boolean }): boolean {
  return s.endsGroup && s.hasText && !s.hasCard && !s.hasImage;
}

/** The message's context menu, in herdrup's order. Saved copies have no Save or Delete. */
export function menuItems(s: { hasFile: boolean; hasText: boolean; saved: boolean; savedCopy: boolean }): string[] {
  const items: string[] = [];
  if (s.hasFile) items.push("Save to Files");
  if (s.hasText) items.push("Copy");
  if (!s.savedCopy) items.push(s.saved ? "Unsave" : "Save", "Delete");
  return items;
}

export type LinkRun = { text: string; href: string | null };

/**
 * Plain text split into prose and links, as NSDataDetector finds them in herdrup's `linkified`:
 * `http(s)://…` and `www.…` up to whitespace, without trailing punctuation or an unmatched
 * closing bracket. A `www.` link opens over https.
 */
export function linkRuns(text: string): LinkRun[] {
  const out: LinkRun[] = [];
  const re = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let url = m[0];
    for (;;) {
      const tail = url[url.length - 1]!;
      if (".,;:!?'\"".includes(tail)) {
        url = url.slice(0, -1);
        continue;
      }
      const pair = ({ ")": "(", "]": "[", "}": "{" } as Record<string, string>)[tail];
      if (pair && url.split(tail).length > url.split(pair).length) {
        url = url.slice(0, -1);
        continue;
      }
      break;
    }
    if (/^www\.$/i.test(url) || /^https?:\/\/$/i.test(url)) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index), href: null });
    out.push({ text: url, href: /^www\./i.test(url) ? `https://${url}` : url });
    last = m.index + url.length;
    re.lastIndex = last;
  }
  if (last < text.length) out.push({ text: text.slice(last), href: null });
  return out;
}

// MARK: - Avatars and the sidebar

/** The first routing name of each distinct bare name, in order, at most `limit`. */
export function distinctAgentNames(names: readonly string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const bare = agentName(name);
    if (seen.has(bare)) continue;
    seen.add(bare);
    out.push(name);
    if (out.length === limit) break;
  }
  return out;
}

/** The header cluster's avatars: the most recent sender 38 pt at (20, 2), the next two 26 pt at
 * x 0 and 52, y 16, in a 78 x 48 box. `names` are agents' routing names, newest first. */
export function clusterPlaces(names: readonly string[]): { name: string; size: number; x: number; y: number }[] {
  const shown = distinctAgentNames(names, 3);
  const out: { name: string; size: number; x: number; y: number }[] = [];
  if (shown.length > 1) out.push({ name: shown[1]!, size: 26, x: 0, y: 16 });
  if (shown.length > 2) out.push({ name: shown[2]!, size: 26, x: 52, y: 16 });
  if (shown[0] !== undefined) out.push({ name: shown[0], size: 38, x: 20, y: 2 });
  return out;
}

/** The Gram row's faces: the two most recent distinct agents that wrote, by bare name. */
export function recentAgentSenders(messages: readonly { fromAgent: boolean; name: string }[]): string[] {
  const names: string[] = [];
  for (const m of messages) {
    if (!m.fromAgent) continue;
    if (!names.includes(m.name)) names.push(m.name);
    if (names.length === 2) break;
  }
  return names;
}

// MARK: - Composer

/** Every agent matching the "@" being typed, names starting with the query first, then names
 * containing it; every agent for a bare "@". */
export function mentionMatches(agents: readonly GramAgent[], query: string): GramAgent[] {
  const q = query.toLowerCase();
  if (q === "") return [...agents];
  const starting = agents.filter((a) => a.name.toLowerCase().startsWith(q));
  const containing = agents.filter((a) => !a.name.toLowerCase().startsWith(q) && a.name.toLowerCase().includes(q));
  return [...starting, ...containing];
}

/** An agent's title in the @ list and the sheet: with its machine when another agent shares the
 * name ("clientloop · hetzner-1", or "· this device"); `machineLine` is the line under it. */
export function agentTitle(agent: GramAgent, shared: ReadonlySet<string>): { title: string; machineLine: string | null } {
  if (shared.has(agent.name.toLowerCase())) {
    return { title: `${agent.name} · ${agent.machine ?? "this device"}`, machineLine: null };
  }
  return { title: agent.name, machineLine: agent.machine };
}

/** Whether the draft goes to `agent` (by routing name), or with null to the shared queue: the
 * sheet's checkmark. */
export function isAddressed(address: DraftAddress, agent: GramAgent | null): boolean {
  switch (address.route.kind) {
    case "queue":
      return agent === null;
    case "agent":
      return agent !== null && address.route.agent.from === agent.from;
    default:
      return false;
  }
}

/** Whether Send may fire: the route allows it and there is something to say, and no send or
 * file pick is in flight. */
export function canSend(address: DraftAddress, attachments: number, sending: boolean, picking: boolean): boolean {
  return !sending && !picking && canSendDraft(address, attachments > 0);
}

/** The hint above the card shows only while the @ list is closed. */
export function shownHint(hint: string | null, listOpen: boolean): string | null {
  return listOpen ? null : hint;
}

/** A chip's icon glyph (ComposerAttachmentChip): check once uploaded or sent, alert on failure,
 * else a photo or a file. */
export function chipGlyph(c: { state: string; failed: boolean; isImage: boolean }): "check" | "alert" | "photo" | "file" {
  if (c.state === "sent" || c.state === "uploaded") return "check";
  if (c.failed) return "alert";
  return c.isImage ? "photo" : "file";
}

/** A chip's ring: a share while uploading with a known size, spinning while sending or an upload
 * has no size; none otherwise. */
export function chipRing(c: { determinate: boolean; indeterminate: boolean; fraction: number }): number | "spin" | null {
  if (c.determinate) return c.fraction;
  return c.indeterminate ? "spin" : null;
}

/** Where the caret goes after the draft changes from `before` to `after` by a pick: the same
 * distance from the end, as herdrup's field keeps it. */
export function caretAfter(before: string, caret: number, after: string): number {
  return Math.max(0, Math.min(after.length, after.length - (before.length - caret)));
}

// MARK: - Column width (HerdrKit ConversationColumnWidth)

export const COLUMN = { minimum: 560, readable: 720, wide: 1000, full: 100_000, snapDistance: 12 } as const;

type Snap = "Readable" | "Wide" | "Full";

export function sanitizedWidth(stored: number): number {
  if (!Number.isFinite(stored) || stored <= 0) return COLUMN.wide;
  return Math.min(COLUMN.full, Math.max(COLUMN.minimum, stored));
}

/** The width drawn: the chosen one, never more than the room there is. */
export function displayedWidth(stored: number, available: number): number {
  return Math.min(sanitizedWidth(stored), Math.max(0, available));
}

function clampedWidth(width: number, available: number): number {
  return Math.min(Math.max(0, available), Math.max(COLUMN.minimum, width));
}

function snapPoints(available: number): { width: number; snap: Snap }[] {
  const points: { width: number; snap: Snap }[] = [];
  if (COLUMN.readable <= available) points.push({ width: COLUMN.readable, snap: "Readable" });
  if (COLUMN.wide <= available) points.push({ width: COLUMN.wide, snap: "Wide" });
  points.push({ width: Math.max(0, available), snap: "Full" });
  return points;
}

/** A drag of one edge: the column grows by twice the outward move (it stays centred), clamped
 * to the minimum and the room, and snaps within 12 pt of Readable, Wide and Full. */
export function draggedWidth(start: number, translation: number, edge: "leading" | "trailing", available: number): number {
  const outwards = edge === "trailing" ? translation : -translation;
  const width = clampedWidth(Math.round(start + 2 * outwards), available);
  let nearest: { width: number } | null = null;
  for (const p of snapPoints(available)) {
    if (!nearest || Math.abs(p.width - width) < Math.abs(nearest.width - width)) nearest = p;
  }
  return nearest && Math.abs(nearest.width - width) <= COLUMN.snapDistance ? nearest.width : width;
}

/** What is kept for a width: Readable and Wide by name, the whole room as Full. */
export function storedWidth(width: number, available: number): number {
  if (Math.abs(width - COLUMN.readable) < 0.5) return COLUMN.readable;
  if (Math.abs(width - COLUMN.wide) < 0.5) return COLUMN.wide;
  if (width >= available - 0.5) return COLUMN.full;
  return width;
}

/** The readout while resizing: "720 pt · Readable", or the points alone between snaps. */
export function widthReadout(width: number, available: number): string {
  const points = `${Math.round(width)} pt`;
  const snap = snapPoints(available).find((p) => Math.abs(p.width - width) < 0.5)?.snap;
  return snap ? `${points} · ${snap}` : points;
}
