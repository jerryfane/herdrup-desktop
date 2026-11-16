// One Gram for a guest (themartianapp/herdrup#697, design 3B): every shared agent's Gram merged
// into one feed on the client. A port of HerdrKit GuestGramMerge.swift (herdrup#702), so iOS, the
// desktop app and the browser guest show the same feed:
//  1. Order: created time ascending, ties by message id (byte-wise), then by grant.
//  2. Identity: (grant, id); ids are not unique across hosts.
//  3. Paging: a cursor per grant. Only messages at or after the SAFE FLOOR show: the newest of
//     the oldest-held times among grants that still have older pages (a paging grant holding
//     nothing hides everything until its first page lands). Earlier pages the grants whose oldest
//     held message is at the floor or newer; when all are exhausted, everything shows.
//  4. Unread: the sum of the per-grant counts; reading the feed marks, per grant, only that grant's
//     shown messages.
//  5. A reply goes to its message's grant; a new message defaults to the grant of the newest
//     incoming message, else the first grant.

/** What the merge reads of a message: its id on its own host, time, read state and direction. */
export interface GuestGramMessage { id: string; createdUnixMs: number; unread: boolean; fromAgent: boolean }

/** One grant's held Gram: what its feed has fetched (any order) and whether older pages remain. */
export interface GuestGramLane<M extends GuestGramMessage = GuestGramMessage> { grant: string; messages: readonly M[]; hasMore: boolean }

/** One message in the merged feed. `id` ("grant/id") is unique across grants. */
export interface GuestGramMergedItem<M extends GuestGramMessage = GuestGramMessage> { grant: string; message: M; id: string }

const utf8 = new TextEncoder();
function bytewise(a: string, b: string): number {
 if (a === b) return 0;
 const x = utf8.encode(a), y = utf8.encode(b);
 for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
 return x.length - y.length;
}
/** Byte-wise order on (time, id, grant). */
export function compareKeys(a: [number, string, string], b: [number, string, string]): number {
 return a[0] - b[0] || bytewise(a[1], b[1]) || bytewise(a[2], b[2]);
}
const keyOf = (grant: string, m: GuestGramMessage): [number, string, string] => [m.createdUnixMs, m.id, grant];

/** The oldest held time; null when nothing is held. */
export function oldestUnixMs(lane: GuestGramLane): number | null {
 let oldest: number | null = null;
 for (const m of lane.messages) if (oldest === null || m.createdUnixMs < oldest) oldest = m.createdUnixMs;
 return oldest;
}
/** The grant's cursor: its oldest held message, gram.list's before_id. */
export function laneCursor(lane: GuestGramLane): string | null {
 let best: GuestGramMessage | null = null;
 for (const m of lane.messages) if (best === null || compareKeys(keyOf(lane.grant, m), keyOf(lane.grant, best)) < 0) best = m;
 return best?.id ?? null;
}
/** The newest held message, for the inbox row's preview and time. */
export function laneNewest<M extends GuestGramMessage>(lane: GuestGramLane<M>): M | null {
 let best: M | null = null;
 for (const m of lane.messages) if (best === null || compareKeys(keyOf(lane.grant, m), keyOf(lane.grant, best)) > 0) best = m;
 return best;
}
export const laneUnread = (lane: GuestGramLane) => lane.messages.filter(m => m.unread).length;

export interface GuestGramMerge<M extends GuestGramMessage = GuestGramMessage> {
 /** Shown messages, oldest first (newest last). */
 items: GuestGramMergedItem<M>[];
 /** The safe floor; null when no grant has older pages (everything shows). */
 floorUnixMs: number | null;
 /** The grants Earlier should page next; empty when the feed is complete. */
 grantsToPage: string[];
 /** Older messages remain to show (Earlier). */
 hasMore: boolean;
 /** Held messages hidden below the floor. */
 hiddenCount: number;
 /** The grants in the caller's order, for the default target. */
 grants: string[];
 /** The All agents count: the sum of every grant's unread count. */
 unreadCount: number;
 unreadByGrant: Map<string, number>;
 /** What reading the merged feed marks: per grant, the unread ids actually shown. */
 shownUnreadByGrant: Map<string, string[]>;
 /** A new message's default target: the grant of the newest incoming message, else the first. */
 defaultTarget: string | null;
}

export function mergeGuestGram<M extends GuestGramMessage>(lanes: readonly GuestGramLane<M>[]): GuestGramMerge<M> {
 const paging = lanes.filter(lane => lane.hasMore);
 const floor = paging.length === 0 ? null : Math.max(...paging.map(lane => oldestUnixMs(lane) ?? Number.MAX_SAFE_INTEGER));
 const all: GuestGramMergedItem<M>[] = [];
 const seen = new Set<string>();
 for (const lane of lanes) {
  for (const message of lane.messages) {
   const id = `${lane.grant}/${message.id}`;
   if (seen.has(id)) continue;
   seen.add(id);
   all.push({ grant: lane.grant, message, id });
  }
 }
 all.sort((a, b) => compareKeys(keyOf(a.grant, a.message), keyOf(b.grant, b.message)));
 const items = floor === null ? all : all.filter(item => item.message.createdUnixMs >= floor);
 const grantsToPage = floor === null ? [] : paging.filter(lane => (oldestUnixMs(lane) ?? Number.MAX_SAFE_INTEGER) >= floor).map(lane => lane.grant);
 const unreadByGrant = new Map<string, number>();
 for (const lane of lanes) unreadByGrant.set(lane.grant, (unreadByGrant.get(lane.grant) ?? 0) + laneUnread(lane));
 const shownUnreadByGrant = new Map<string, string[]>();
 for (const item of items) if (item.message.unread) shownUnreadByGrant.set(item.grant, [...shownUnreadByGrant.get(item.grant) ?? [], item.message.id]);
 const grants = lanes.map(lane => lane.grant);
 let defaultTarget: string | null = grants[0] ?? null;
 for (let i = items.length - 1; i >= 0; i--) if (items[i]!.message.fromAgent) { defaultTarget = items[i]!.grant; break; }
 return {
  items, floorUnixMs: floor, grantsToPage, hasMore: grantsToPage.length > 0, hiddenCount: all.length - items.length, grants,
  unreadCount: [...unreadByGrant.values()].reduce((sum, n) => sum + n, 0), unreadByGrant, shownUnreadByGrant, defaultTarget,
 };
}

/** A reply goes to the grant of the message it answers. */
export function replyTarget(merge: GuestGramMerge, itemID: string): string | null {
 return merge.items.find(item => item.id === itemID)?.grant ?? null;
}

// ---- The inbox list (design 3B), desktop and web only ----

/** A shared agent as the list shows it. */
export interface GuestGramGrantInfo { id: string; agent: string; owner: string; machine: string }
export interface GuestGramRow<M extends GuestGramMessage = GuestGramMessage> { grant: GuestGramGrantInfo; newest: M | null; unread: number }
export interface GuestGramGroup<M extends GuestGramMessage = GuestGramMessage> { label: string; rows: GuestGramRow<M>[] }

/** One row per shared agent under "owner · machine", the most recently active group and agent
 *  first, agents without messages after by name; labels show only for several groups. */
export function guestGramGroups<M extends GuestGramMessage>(lanes: readonly (GuestGramLane<M> & { info: GuestGramGrantInfo })[]): { groups: GuestGramGroup<M>[]; labelled: boolean } {
 const rows = lanes.map(lane => ({ grant: lane.info, newest: laneNewest(lane), unread: laneUnread(lane) }));
 const time = (row: GuestGramRow<M>) => row.newest?.createdUnixMs ?? -Infinity;
 const byActivity = (a: GuestGramRow<M>, b: GuestGramRow<M>) => time(b) - time(a) || a.grant.agent.localeCompare(b.grant.agent);
 const groups = new Map<string, GuestGramRow<M>[]>();
 for (const row of rows) {
  const label = `${row.grant.owner} · ${row.grant.machine}`;
  groups.set(label, [...groups.get(label) ?? [], row]);
 }
 const ordered = [...groups].map(([label, members]) => ({ label, rows: members.sort(byActivity) }))
  .sort((a, b) => byActivity(a.rows[0]!, b.rows[0]!) || a.label.localeCompare(b.label));
 return { groups: ordered, labelled: ordered.length > 1 };
}
