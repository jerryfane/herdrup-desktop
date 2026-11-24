// The guest's Gram list, ported from desk_guest_gram.go (guestGramPage, gramAnswer) and
// internal/gramstore/inbox.go. A guest's gram.list carries no digest, store id or unread count, so
// the Inbox keeps only what a guest answer can change.

/** herdrapi.GramFileInfo. A guest's file may come without `mime` (HerdrKit GuestGram.swift); the
 *  projection gives it application/octet-stream, so everything after reads a string. */
export interface WireFile { name: string; mime: string; size: number; sha256: string }
type GuestWireFile = Omit<WireFile, "mime"> & { mime?: string | null };

/** internal/guest/gram.go GramMessage: the host's guest projection. */
export interface GuestGramMessage {
 id: string;
 direction: string;
 from: string;
 text: string;
 created_unix_ms: number;
 file?: GuestWireFile | null;
 expired_file?: GuestWireFile | null;
 read: boolean;
}
export interface GuestGramPage { messages: GuestGramMessage[]; has_more: boolean }

/** The fields of herdrapi.GramMessageInfo a guest row has (gramAnswer). */
export interface GramInfo {
 id: string;
 direction: string;
 from: string;
 to?: string;
 text: string;
 createdUnixMs: number;
 readByOwner: boolean;
 file?: WireFile;
 expiredFile?: WireFile;
 /** The owner's list only: who grabbed an unaddressed post, and a federated sender's machine. */
 grabbedBy?: string;
 machineLabel?: string;
}

export const AGENT_TO_OWNER = "agent_to_owner";
/** GramView.pageSize and maxRefreshLimit (desk_gram.go:43-46). */
export const GRAM_PAGE_SIZE = 40;
export const GRAM_MAX_REFRESH_LIMIT = 500;

export function isUnread(m: GramInfo): boolean { return m.direction === AGENT_TO_OWNER && !m.readByOwner; }

/** unreadCount: the owner's list counts the whole store's unread (gramstore.Answer.UnreadCount);
 *  a guest's has no count. digest and storeID are the owner's list's (gramstore.Answer); unchanged
 *  is a gram_list_unchanged answer to if_unchanged_digest: no messages, NOT an empty inbox. */
export interface GramAnswer { messages: GramInfo[]; hasMore: boolean; unreadCount?: number; digest?: string; storeID?: string; unchanged?: boolean }

/** herdrapi.GramMessageInfo: the owner's gram.list rows. */
export interface OwnerGramMessage {
 id: string;
 direction: string;
 from: string;
 to?: string | null;
 text: string;
 created_unix_ms: number;
 read_by_owner?: boolean;
 file?: WireFile | null;
 expired_file?: WireFile | null;
 grabbed_by?: string | null;
 machine_label?: string | null;
}
/** herdrapi.ResponseResultGramList, or ResponseResultGramListUnchanged (type gram_list_unchanged). */
export interface OwnerGramList { type?: string; messages?: OwnerGramMessage[] | null; has_more?: boolean; unread_count?: number; digest?: string; store_id?: string }

/** One owner row as GramInfo. */
export function ownerInfo(m: OwnerGramMessage): GramInfo {
 const item: GramInfo = { id: m.id, direction: m.direction, from: m.from, text: m.text, createdUnixMs: m.created_unix_ms, readByOwner: !!m.read_by_owner };
 if (m.to) item.to = m.to;
 if (m.file) item.file = m.file;
 if (m.expired_file) item.expiredFile = m.expired_file;
 if (m.grabbed_by) item.grabbedBy = m.grabbed_by;
 if (m.machine_label) item.machineLabel = m.machine_label;
 return item;
}

/** gramstore.FromList: the owner's list answer, with the store's unread count and digest. */
export function ownerAnswer(list: OwnerGramList): GramAnswer {
 const ids = { digest: list.digest ?? "", storeID: list.store_id ?? "" };
 if (list.type === "gram_list_unchanged") return { messages: [], hasMore: false, unchanged: true, ...ids };
 const a: GramAnswer = { messages: (list.messages ?? []).map(ownerInfo), hasMore: !!list.has_more, ...ids };
 if (typeof list.unread_count === "number") a.unreadCount = list.unread_count;
 return a;
}

/** Answer.BadgeCount: the store's count when the answer has one, else its rows. */
export function badgeCount(a: GramAnswer): number { return a.unreadCount ?? a.messages.length; }

/** guest.Transport.GramList's limit: 100 when unset, at most 500 (internal/guest/gram.go:27-38). */
export function listLimit(limit?: number): number { return Math.min(limit || 100, 500); }

/** guestGramPage (desk_guest_gram.go:21-42): one page, or with unreadOnly every older page while one
 *  has more. An older page that fails returns the pages read so far, marked hasMore, with the error. */
export async function guestGramPage(list: (limit: number, before?: string) => Promise<GuestGramPage>, limit: number, unreadOnly: boolean, before?: string): Promise<{ page: GuestGramPage; error?: unknown }> {
 const page = await list(listLimit(limit), before);
 const out: GuestGramPage = { messages: [...(page.messages ?? [])], has_more: !!page.has_more };
 if (!unreadOnly) return { page: out };
 for (let next = out; next.has_more && next.messages.length > 0;) {
  const cursor = next.messages[next.messages.length - 1]?.id ?? "";
  try { next = await list(listLimit(limit), cursor); }
  catch (error) { out.has_more = true; return { page: out, error }; }
  next = { messages: next.messages ?? [], has_more: !!next.has_more };
  if (next.messages.at(-1)?.id === cursor) break; // a cursor that does not advance would never end
  out.messages.push(...next.messages);
  out.has_more = next.has_more;
 }
 return { page: out };
}

/** gramAnswer's guest projection (desk_guest_gram.go:75-88): the guest's read mark as the owner's,
 *  your posts addressed to the shared agent, and with unreadOnly only unread rows. */
export function projectGuestPage(page: GuestGramPage, agent: string, unreadOnly: boolean): GramAnswer {
 const messages: GramInfo[] = [];
 for (const m of page.messages) {
  const item: GramInfo = { id: m.id, direction: m.direction, from: m.from, text: m.text, createdUnixMs: m.created_unix_ms, readByOwner: m.read };
  const file = (f: GuestWireFile): WireFile => ({ ...f, mime: typeof f.mime === "string" && f.mime !== "" ? f.mime : "application/octet-stream" });
  if (m.file) item.file = file(m.file);
  else if (m.expired_file) item.expiredFile = file(m.expired_file);
  if (item.direction !== AGENT_TO_OWNER) item.to = agent;
  if (!unreadOnly || isUnread(item)) messages.push(item);
 }
 return { messages, hasMore: page.has_more };
}

function same(a: GramInfo, b: GramInfo): boolean {
 return a.id === b.id && a.direction === b.direction && a.from === b.from && a.to === b.to && a.text === b.text &&
  a.createdUnixMs === b.createdUnixMs && a.readByOwner === b.readByOwner && a.grabbedBy === b.grabbedBy && a.machineLabel === b.machineLabel &&
  JSON.stringify(a.file ?? null) === JSON.stringify(b.file ?? null) && JSON.stringify(a.expiredFile ?? null) === JSON.stringify(b.expiredFile ?? null);
}

// ---- Ordering: list answers against this device's writes ----
//
// The order this browser sends requests in says nothing about what herdr's snapshot of the store
// holds: a write sent after a list may land before herdr reads the list, and one sent before may
// land after. So no list answer is ever adjusted for a write. The rule:
// - A list answer (head, older page, unread-only) is ACCEPTED only when no write (mark-read,
//   delete, post) was in flight at any time between its request being sent and its answer
//   arriving: none in flight when it was sent and none started since (so none is in flight now).
//   A batch (Read all) is one write, in flight from its first call until its last settles.
// - Otherwise it is DISCARDED whole (no rows, no counts, no digest, no Saved expiry). The request
//   of the same kind goes out again once the writes have settled, once per quiet spell (Recovery):
//   a discarded head list or older page owes a head list, a discarded unread-only list (the hidden
//   tab's badge) owes the unread-only list, never a narrower one in its place.
// - Until then each write's own acknowledgement is what shows: a confirmed read reads its row, a
//   delete removes it, a post shows pending. An accepted head list sent after a post's
//   acknowledgement is the word on that post: listed it shows as listed, absent it is gone (deleted
//   elsewhere), also when the answer is "unchanged".
// - An accepted older page is taken only when it comes from the store the shown head came from:
//   its digest (the store's) equals the head's. Another digest (the store changed between them,
//   either way) rejects it whole, no rows, count or Saved expiry; a head list is asked again and
//   paging goes on from that head's cursor.
// - While a guest's Gram is hidden its badge comes from the unread-only walk alone: a head list
//   (the newest 40, accepted or recovered) never writes it, nor does a confirmed read.

/** The writes as a list request sees them: how many are in flight, and how many ever started. */
export interface WriteMark { inFlight: number; started: number }

/** The rule above: whether a list answer whose request was sent at `sent` may be folded in now. */
export function acceptAnswer(sent: WriteMark, now: WriteMark): boolean {
 return sent.inFlight === 0 && now.started === sent.started;
}

/** What a discarded answer owes once the writes have settled: a head list, the unread-only list. */
export interface Recovery { head: boolean; badge: boolean }

/** A discarded answer of `kind` adds what it owes to `owed` (the same kind; an older page a head). */
export function owe(owed: Recovery, kind: "head" | "page" | "badge"): Recovery {
 return kind === "badge" ? { ...owed, badge: true } : { ...owed, head: true };
}

/** gramstore.Inbox: the held list, replaced by a head load and grown by older pages of the same
 *  generation; only accepted answers (acceptAnswer) come in. The owner's answers carry the store's
 *  unread count, which then is the badge (serverUnread), and a digest a head load sends back so an
 *  unchanged store keeps every page held; a guest's carry neither. */
export class Inbox {
 messages: GramInfo[] = [];
 hasLoaded = false;
 hasMore = false;
 generation = 0;
 /** Reads this device confirmed of messages not held, each counted once until a head list. */
 #readOutsideWindow = new Set<string>();
 #serverUnread: number | null = null;
 #digest = "";
 #storeID = "";
 /** The digest of the store the shown head list came from (herdr's, kept when a local edit clears
  *  the conditional digest): an older page must come from the same store. */
 #headDigest = "";

 unreadCount(): number { return this.#serverUnread ?? this.messages.filter(isUnread).length; }

 /** The cursor of the next older page; "" when there is none. */
 nextCursor(): string { return this.hasMore ? this.messages.at(-1)?.id ?? "" : ""; }

 /** Inbox.ConditionalDigest: the digest to send as if_unchanged_digest, only while the list it
  *  fingerprints is held. */
 conditionalDigest(): string { return this.hasLoaded ? this.#digest : ""; }

 /** Inbox.Apply: an accepted head answer replaces the list; reports a change. An unchanged answer
  *  keeps everything held, older pages included; another store (store_id) starts over. */
 apply(a: GramAnswer): boolean {
  if (this.#storeID !== "" && a.storeID && this.#storeID !== a.storeID) {
   this.messages = []; this.hasLoaded = false; this.hasMore = false;
   this.#serverUnread = null; this.#digest = ""; this.#headDigest = "";
   this.generation++;
  }
  if (a.storeID) this.#storeID = a.storeID;
  // The digest is not adopted from an unchanged answer: a late one must not re-arm a digest a
  // local edit cleared.
  if (a.unchanged) return false;
  const fresh = a.messages.map(m => ({ ...m }));
  const changed = fresh.length !== this.messages.length || fresh.some((m, i) => !same(m, this.messages[i]!));
  this.messages = fresh;
  this.#readOutsideWindow.clear();
  this.#digest = a.digest ?? "";
  this.#headDigest = a.digest ?? "";
  this.hasLoaded = true;
  this.#serverUnread = a.unreadCount ?? null;
  this.hasMore = a.hasMore;
  if (changed) this.generation++;
  return changed;
 }

 /** Inbox.AppendPage: an accepted older page built on generation, unless a head load replaced the
  *  list since, it is another store's, or it comes from another state of the store than the shown
  *  head (digests differ, when both are known): then "rejected", and nothing of it (rows, count) is
  *  taken. A taken page "grew" the list or added nothing new ("same"); its count is the store's,
  *  even when it adds no rows. */
 appendPage(a: GramAnswer, generation: number): "rejected" | "grew" | "same" {
  if (generation !== this.generation) return "rejected";
  if (this.#storeID !== "" && a.storeID && this.#storeID !== a.storeID) return "rejected";
  if (this.#headDigest !== "" && a.digest && a.digest !== this.#headDigest) return "rejected";
  const known = new Set(this.messages.map(m => m.id));
  const before = this.messages.length;
  for (const m of a.messages) if (!known.has(m.id)) { this.messages.push({ ...m }); known.add(m.id); }
  this.hasMore = a.hasMore;
  if (a.unreadCount !== undefined) {
   // The held digest does not certify this page's count: the next head load reconciles it.
   if (this.#serverUnread !== a.unreadCount) this.#digest = "";
   this.#serverUnread = a.unreadCount;
  }
  if (a.messages.length > 0) this.hasLoaded = true;
  return this.messages.length > before ? "grew" : "same";
 }

 /** Inbox.Remove: a delete herdr acknowledged: the row goes, an unread one out of the store's count. */
 remove(id: string) {
  const i = this.messages.findIndex(m => m.id === id);
  this.#digest = "";
  if (i < 0) return;
  if (isUnread(this.messages[i]!) && this.#serverUnread !== null) this.#serverUnread = Math.max(0, this.#serverUnread - 1);
  this.messages.splice(i, 1);
 }

 /** Inbox.MarkRead: a read herdr acknowledged; once per message. */
 markRead(id: string) {
  const m = this.messages.find(f => f.id === id);
  if (m) {
   if (!isUnread(m)) return;
   m.readByOwner = true;
  } else {
   if (this.#readOutsideWindow.has(id)) return;
   this.#readOutsideWindow.add(id);
  }
  if (this.#serverUnread !== null) this.#serverUnread = Math.max(0, this.#serverUnread - 1);
  this.#digest = "";
 }
}
