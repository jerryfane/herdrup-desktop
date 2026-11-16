// One Gram for a guest (themartianapp/herdrup#697, design 3B): the merge of every shared agent's
// Gram into one feed, as agreed with iOS (herdr-app 492993/493009). Pure, so both runtimes (the
// desktop app and the browser guest) and their tests share the rules:
//  - order: created time, then message id; a message is keyed by its grant and its id;
//  - paging: each grant has its own cursor. Only messages at or after the safe floor show (the
//    newest oldest-held time among grants with more pages), since anything older may still be
//    missing from another grant; Earlier pages exactly the grants at or above the floor;
//  - unread: per grant, the All row's count their sum; a reply goes to its message's grant.
import { isUnread, type GramInfo } from "./web/gramInbox";

/** One shared agent the guest holds (a saved grant). Only a grant whose host shares Gram counts. */
export interface GuestGrant { id: string; agent: string; owner: string; machine: string; gram: boolean }

/** A grant's held Gram: the messages read so far (any order) and whether older ones remain. */
export interface GrantFeed { grant: GuestGrant; messages: GramInfo[]; hasMore: boolean }

/** A message in the merged feed, with the grant it came from. */
export interface MergedMessage { key: string; grant: GuestGrant; message: GramInfo }

export const mergedKey = (grantID: string, messageID: string) => `${grantID}\u0000${messageID}`;

/** Created time, then id by code unit (a fixed order where two hosts' clocks agree to the ms). */
export function compareMerged(a: MergedMessage, b: MergedMessage): number {
 const t = a.message.createdUnixMs - b.message.createdUnixMs;
 if (t !== 0) return t;
 return a.message.id < b.message.id ? -1 : a.message.id > b.message.id ? 1 : 0;
}

const gramFeeds = (feeds: readonly GrantFeed[]) => feeds.filter(feed => feed.grant.gram);

function oldestHeld(feed: GrantFeed): number | null {
 let oldest: number | null = null;
 for (const m of feed.messages) if (oldest === null || m.createdUnixMs < oldest) oldest = m.createdUnixMs;
 return oldest;
}

/** The newest oldest-held time among grants with more pages: older messages may be missing from
 *  one of them, so they wait. null once every grant is exhausted (everything shows). */
export function safeFloor(feeds: readonly GrantFeed[]): number | null {
 let floor: number | null = null;
 for (const feed of gramFeeds(feeds)) {
  if (!feed.hasMore) continue;
  const oldest = oldestHeld(feed);
  if (oldest !== null && (floor === null || oldest > floor)) floor = oldest;
 }
 return floor;
}

/** The merged feed, oldest first: every Gram grant's messages at or after the safe floor. With a
 *  selected grant, only its messages, all of them (one grant has no gap to guard). */
export function mergedFeed(feeds: readonly GrantFeed[], selected: string | null = null): MergedMessage[] {
 const shown = gramFeeds(feeds).filter(feed => selected === null || feed.grant.id === selected);
 const floor = selected === null ? safeFloor(feeds) : null;
 const out: MergedMessage[] = [];
 for (const feed of shown) {
  for (const message of feed.messages) {
   if (floor !== null && message.createdUnixMs < floor) continue;
   out.push({ key: mergedKey(feed.grant.id, message.id), grant: feed.grant, message });
  }
 }
 return out.sort(compareMerged);
}

/** Whether Earlier has anything to fetch for the merged feed (or the selected grant). */
export function hasOlder(feeds: readonly GrantFeed[], selected: string | null = null): boolean {
 return gramFeeds(feeds).some(feed => feed.hasMore && (selected === null || feed.grant.id === selected));
}

/** The grants Earlier pages: with a selection that grant; else those with more pages whose oldest
 *  held message is at the floor or newer, which lowers the floor. */
export function olderPlan(feeds: readonly GrantFeed[], selected: string | null = null): string[] {
 const candidates = gramFeeds(feeds).filter(feed => feed.hasMore);
 if (selected !== null) return candidates.filter(feed => feed.grant.id === selected).map(feed => feed.grant.id);
 const floor = safeFloor(feeds);
 return candidates.filter(feed => { const oldest = oldestHeld(feed); return oldest === null || floor === null || oldest >= floor; }).map(feed => feed.grant.id);
}

export const unreadCount = (feed: GrantFeed) => feed.messages.filter(isUnread).length;
/** The All row's and the tab badge's count: the sum of every Gram grant's unread. */
export const totalUnread = (feeds: readonly GrantFeed[]) => gramFeeds(feeds).reduce((sum, feed) => sum + unreadCount(feed), 0);

/** What showing `messages` marks read, by grant: each grant's unread among them. */
export function readPlan(messages: readonly MergedMessage[]): Map<string, string[]> {
 const plan = new Map<string, string[]>();
 for (const { grant, message } of messages) {
  if (!isUnread(message)) continue;
  const ids = plan.get(grant.id) ?? [];
  ids.push(message.id);
  plan.set(grant.id, ids);
 }
 return plan;
}

export interface AgentRow { grant: GuestGrant; latest: GramInfo | null; unread: number }
export interface AgentGroup { label: string; rows: AgentRow[] }
export interface InboxList {
 /** The All agents row: the newest message overall, the two newest distinct agents, the sum. */
 all: { latest: MergedMessage | null; agents: GuestGrant[]; unread: number };
 groups: AgentGroup[];
 /** Group labels show only when there is more than one group. */
 labelled: boolean;
}

const newest = (messages: readonly GramInfo[]) => messages.reduce<GramInfo | null>((best, m) => best === null || m.createdUnixMs > best.createdUnixMs || m.createdUnixMs === best.createdUnixMs && m.id > best.id ? m : best, null);

/** The sidebar: All agents, then one row per Gram grant under "owner · machine", the most recently
 *  active group and agent first; agents without messages after, by name. */
export function inboxList(feeds: readonly GrantFeed[]): InboxList {
 const rows: AgentRow[] = gramFeeds(feeds).map(feed => ({ grant: feed.grant, latest: newest(feed.messages), unread: unreadCount(feed) }));
 const time = (row: AgentRow) => row.latest?.createdUnixMs ?? -Infinity;
 const byActivity = (a: AgentRow, b: AgentRow) => time(b) - time(a) || a.grant.agent.localeCompare(b.grant.agent);
 const groups = new Map<string, AgentRow[]>();
 for (const row of rows) {
  const label = `${row.grant.owner} · ${row.grant.machine}`;
  groups.set(label, [...(groups.get(label) ?? []), row]);
 }
 const ordered = [...groups].map(([label, members]) => ({ label, rows: members.sort(byActivity) }))
  .sort((a, b) => byActivity(a.rows[0]!, b.rows[0]!) || a.label.localeCompare(b.label));
 const merged = mergedFeed(feeds);
 const agents: GuestGrant[] = [];
 for (let i = merged.length - 1; i >= 0 && agents.length < 2; i--) {
  const grant = merged[i]!.grant;
  if (!agents.some(a => a.id === grant.id)) agents.push(grant);
 }
 return { all: { latest: merged.at(-1) ?? null, agents, unread: totalUnread(feeds) }, groups: ordered, labelled: ordered.length > 1 };
}

/** The composer's "to": the selected grant; in All the agent of the newest message from an agent
 *  shown, else the first row's. null while no grant shares Gram. */
export function defaultRecipient(feeds: readonly GrantFeed[], selected: string | null = null): GuestGrant | null {
 const grants = gramFeeds(feeds).map(feed => feed.grant);
 if (selected !== null) return grants.find(grant => grant.id === selected) ?? null;
 const feed = mergedFeed(feeds);
 for (let i = feed.length - 1; i >= 0; i--) if (feed[i]!.message.direction === "agent_to_owner") return feed[i]!.grant;
 return inboxList(feeds).groups[0]?.rows[0]?.grant ?? null;
}
