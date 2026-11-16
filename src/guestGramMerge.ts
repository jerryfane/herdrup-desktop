// One Gram for a guest (themartianapp/herdrup#697, design 3B): every shared agent's Gram merged
// into one feed on the client. A port of HerdrKit GuestGramMerge.swift (herdrup#702 @1a8e0bbb), so
// iOS, the desktop app and the browser guest show the same feed:
//  1. Order: created time ascending, ties by message id (byte-wise), then by grant.
//  2. Identity: (grant, id); ids are not unique across hosts.
//  3. Paging: a cursor per grant (its last held message in the host's order). The SAFE FLOOR is
//     the newest of the oldest-held times among loaded grants that still have older pages, and
//     only messages STRICTLY NEWER than it show: herdr orders equal times by its store, not by
//     id, so a page ending inside one millisecond may still miss messages of it with any id.
//     Earlier pages the grants whose oldest held time is at the floor or newer; a grant with no
//     more pages stops counting; when all are exhausted, everything shows.
//  4. A grant whose first answer hasn't landed is unknown, not exhausted: nothing shows (or is
//     marked read, or paged) until every grant's first answer or failure is in.
//  5. Unread: the sum of the per-grant counts; reading the feed marks, per grant, only that
//     grant's shown messages.
//  6. A reply goes to its message's grant; a new message defaults to the grant of the newest
//     incoming message, else the first grant.

/** What the merge reads of a message: its id on its own host, time, read state and direction. */
export interface GuestGramMessage { id: string; createdUnixMs: number; unread: boolean; fromAgent: boolean }

/** One grant's held Gram: its messages newest first in the host's order, whether older pages
 *  remain, and whether its first answer (or failure) has landed. */
export interface GuestGramLane<M extends GuestGramMessage = GuestGramMessage> { grant: string; messages: readonly M[]; hasMore: boolean; loaded: boolean }

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
/** The grant's cursor, gram.list's before_id: its last held message in the host's order. */
export function laneCursor(lane: GuestGramLane): string | null {
 return lane.messages.at(-1)?.id ?? null;
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
 /** The safe floor: only messages strictly newer show. null when no loaded grant has older pages
  *  (everything shows, unless pending). */
 floorUnixMs: number | null;
 /** A grant's first answer hasn't landed: nothing shows yet. */
 pending: boolean;
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
 const pending = lanes.some(lane => !lane.loaded);
 // A paging grant holding nothing hides everything until it holds something.
 const paging = lanes.filter(lane => lane.loaded && lane.hasMore);
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
 const items = pending ? [] : floor === null ? all : all.filter(item => item.message.createdUnixMs > floor);
 const grantsToPage = pending || floor === null ? [] : paging.filter(lane => (oldestUnixMs(lane) ?? Number.MAX_SAFE_INTEGER) >= floor).map(lane => lane.grant);
 const unreadByGrant = new Map<string, number>();
 for (const lane of lanes) unreadByGrant.set(lane.grant, (unreadByGrant.get(lane.grant) ?? 0) + laneUnread(lane));
 const shownUnreadByGrant = new Map<string, string[]>();
 for (const item of items) if (item.message.unread) shownUnreadByGrant.set(item.grant, [...shownUnreadByGrant.get(item.grant) ?? [], item.message.id]);
 const grants = lanes.map(lane => lane.grant);
 let defaultTarget: string | null = grants[0] ?? null;
 for (let i = items.length - 1; i >= 0; i--) if (items[i]!.message.fromAgent) { defaultTarget = items[i]!.grant; break; }
 return {
  items, floorUnixMs: floor, pending, grantsToPage, hasMore: grantsToPage.length > 0, hiddenCount: all.length - items.length, grants,
  unreadCount: [...unreadByGrant.values()].reduce((sum, n) => sum + n, 0), unreadByGrant, shownUnreadByGrant, defaultTarget,
 };
}

/** A reply goes to the grant of the message it answers. */
export function replyTarget(merge: GuestGramMerge, itemID: string): string | null {
 return merge.items.find(item => item.id === itemID)?.grant ?? null;
}

// ---- The inbox list (design 3B), desktop and web only ----

/** A shared agent as the list shows it. */
export interface GuestGramGrantInfo { id: string; agent: string; owner: string; machine: string; terminal: string; label: string }

/** What the guest's Gram calls each share's agent, unique across all of them (HerdrKit
 *  GuestAccess.recipientLabels, #702 @fd1d1a5e). A name held once stays bare. Within a group
 *  sharing a name, a label that still collides gains one more part at a time: owner and machine
 *  ("enyo-ui · Jerry · Studio"), then the terminal (host-local, so never without the machine), then
 *  the host id's first 6 characters, then the guest id. A share's id is Access.ID(), "<host>/<guest>". */
export function recipientLabels(shares: readonly { id: string; agent: string; owner: string; machine: string; terminal: string }[]): Map<string, string> {
 const label = (share: (typeof shares)[number], level: number) => {
  const slash = share.id.indexOf("/");
  const host = slash < 0 ? share.id : share.id.slice(0, slash), guestID = slash < 0 ? "" : share.id.slice(slash + 1);
  const parts = [share.agent, share.owner, share.machine, share.terminal, [...host].slice(0, 6).join(""), guestID];
  return parts.slice(0, [1, 3, 4, 5, 6][Math.min(level, 4)]).join(" · ");
 };
 const labels = new Map<string, string>();
 const groups = new Map<string, (typeof shares)[number][]>();
 for (const share of shares) groups.set(share.agent, [...groups.get(share.agent) ?? [], share]);
 for (const group of groups.values()) {
  const levels = new Map(group.map(share => [share.id, 0]));
  for (let round = 0; round < 5; round++) {
   const current = group.map(share => [share, label(share, levels.get(share.id)!)] as const);
   const counts = new Map<string, number>();
   for (const [, text] of current) counts.set(text, (counts.get(text) ?? 0) + 1);
   const colliding = current.filter(([, text]) => counts.get(text)! > 1);
   if (colliding.length === 0) break;
   for (const [share] of colliding) levels.set(share.id, levels.get(share.id)! + 1);
  }
  for (const share of group) labels.set(share.id, label(share, levels.get(share.id)!));
 }
 return labels;
}
export interface GuestGramRow<M extends GuestGramMessage = GuestGramMessage> { grant: GuestGramGrantInfo; newest: M | null; unread: number }
export interface GuestGramGroup<M extends GuestGramMessage = GuestGramMessage> { label: string; rows: GuestGramRow<M>[] }

/** One row per shared agent under "owner · machine", the most recently active group and agent
 *  first, agents without messages after by name; labels show only for several groups. */
export function guestGramGroups<M extends GuestGramMessage>(lanes: readonly (GuestGramLane<M> & { info: GuestGramGrantInfo })[]): { groups: GuestGramGroup<M>[]; labelled: boolean } {
 const rows = lanes.map(lane => ({ grant: lane.info, newest: laneNewest(lane), unread: laneUnread(lane) }));
 const time = (row: GuestGramRow<M>) => row.newest?.createdUnixMs ?? -Infinity;
 const byActivity = (a: GuestGramRow<M>, b: GuestGramRow<M>) => time(b) - time(a) || a.grant.label.localeCompare(b.grant.label);
 const groups = new Map<string, GuestGramRow<M>[]>();
 for (const row of rows) {
  const label = `${row.grant.owner} · ${row.grant.machine}`;
  groups.set(label, [...groups.get(label) ?? [], row]);
 }
 const ordered = [...groups].map(([label, members]) => ({ label, rows: members.sort(byActivity) }))
  .sort((a, b) => byActivity(a.rows[0]!, b.rows[0]!) || a.label.localeCompare(b.label));
 return { groups: ordered, labelled: ordered.length > 1 };
}
