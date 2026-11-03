// The guest's Gram list, ported from desk_guest_gram.go (guestGramPage, gramAnswer) and
// internal/gramstore/inbox.go. A guest's gram.list carries no digest, store id or unread count, so
// the Inbox keeps only what a guest answer can change.

/** herdrapi.GramFileInfo. */
export interface WireFile { name: string; mime: string; size: number; sha256: string }

/** internal/guest/gram.go GramMessage: the host's guest projection. */
export interface GuestGramMessage {
 id: string;
 direction: string;
 from: string;
 text: string;
 created_unix_ms: number;
 file?: WireFile | null;
 expired_file?: WireFile | null;
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
}

export const AGENT_TO_OWNER = "agent_to_owner";
/** GramView.pageSize and maxRefreshLimit (desk_gram.go:43-46). */
export const GRAM_PAGE_SIZE = 40;
export const GRAM_MAX_REFRESH_LIMIT = 500;

export function isUnread(m: GramInfo): boolean { return m.direction === AGENT_TO_OWNER && !m.readByOwner; }

export interface GramAnswer { messages: GramInfo[]; hasMore: boolean }

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
  if (m.file) item.file = m.file;
  else if (m.expired_file) item.expiredFile = m.expired_file;
  if (item.direction !== AGENT_TO_OWNER) item.to = agent;
  if (!unreadOnly || isUnread(item)) messages.push(item);
 }
 return { messages, hasMore: page.has_more };
}

function same(a: GramInfo, b: GramInfo): boolean {
 return a.id === b.id && a.direction === b.direction && a.from === b.from && a.to === b.to && a.text === b.text &&
  a.createdUnixMs === b.createdUnixMs && a.readByOwner === b.readByOwner &&
  JSON.stringify(a.file ?? null) === JSON.stringify(b.file ?? null) && JSON.stringify(a.expiredFile ?? null) === JSON.stringify(b.expiredFile ?? null);
}

/** gramstore.Inbox for guest answers: reads this device made win over an answer asked for before them
 *  (readStamp), the list is replaced by a head load and grown by older pages of the same generation. */
export class Inbox {
 messages: GramInfo[] = [];
 hasLoaded = false;
 hasMore = false;
 generation = 0;
 readStamp = 0;
 #localReads = new Map<string, number>();
 #confirmedReads = new Map<string, number>();
 #readOutsideWindow = new Set<string>();

 unreadCount(): number { return this.messages.filter(isUnread).length; }

 /** The cursor of the next older page; "" when there is none. */
 nextCursor(): string { return this.hasMore ? this.messages.at(-1)?.id ?? "" : ""; }

 /** Inbox.Apply: a head answer asked for at readStamp `asked` replaces the list; reports a change. */
 apply(a: GramAnswer, asked: number): boolean {
  const fresh = a.messages.map(m => ({ ...m }));
  for (const [id, stamp] of this.#localReads) {
   if (stamp <= asked) continue;
   const m = fresh.find(f => f.id === id);
   if (m && isUnread(m)) m.readByOwner = true;
  }
  for (const [id, stamp] of this.#localReads) if (stamp <= asked) this.#localReads.delete(id);
  const changed = fresh.length !== this.messages.length || fresh.some((m, i) => !same(m, this.messages[i]!));
  this.messages = fresh;
  this.hasLoaded = true;
  this.hasMore = a.hasMore;
  if (changed) this.generation++;
  return changed;
 }

 /** Inbox.AppendPage: an older page built on generation, unless a head load replaced the list since. */
 appendPage(a: GramAnswer, generation: number, asked: number): boolean {
  if (generation !== this.generation) return false;
  if (a.messages.length === 0) { this.hasMore = a.hasMore; return false; }
  const page = a.messages.map(m => ({ ...m }));
  for (const [id, stamp] of this.#confirmedReads) {
   if (stamp <= asked) continue;
   const m = page.find(f => f.id === id);
   if (m && isUnread(m)) m.readByOwner = true;
  }
  const known = new Set(this.messages.map(m => m.id));
  const before = this.messages.length;
  for (const m of page) if (!known.has(m.id)) { this.messages.push(m); known.add(m.id); }
  this.hasMore = a.hasMore;
  this.hasLoaded = true;
  return this.messages.length > before;
 }

 /** Inbox.MarkRead: a read herdr confirmed. */
 markRead(id: string) {
  const m = this.messages.find(f => f.id === id);
  if (m) {
   if (!isUnread(m)) return;
   m.readByOwner = true;
  } else {
   if (this.#readOutsideWindow.has(id)) return;
   this.#readOutsideWindow.add(id);
  }
  this.readStamp++;
  this.#localReads.set(id, this.readStamp);
  this.#confirmedReads.set(id, this.readStamp);
 }
}
