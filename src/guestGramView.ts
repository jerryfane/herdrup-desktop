// The guest's one Gram (themartianapp/herdrup#697, design 3B) as gram.ts draws it: the shared
// agents' snapshots (Desk.guestGramState, one per grant, their message ids "<grant>\x1f<id>")
// merged by guestGramMerge.ts into one GramSnapshot, for All agents or one agent. Pure.
import { guestGramGroups, mergeGuestGram, type GuestGramGrantInfo, type GuestGramGroup, type GuestGramLane, type GuestGramMerge, type GuestGramMessage } from "./guestGramMerge";
import type { GramMessage, GramSnapshot, GuestGramSnapshot, GuestGramState } from "./mygo";

export const GRANT_SEP = "\u001f";

/** A feed row with what the merge reads of it. */
export interface Row extends GuestGramMessage { row: GramMessage }

export interface GuestGramView {
 /** What gram.ts draws: the merged feed, newest first, and the scope's counts and state. */
 snapshot: GramSnapshot;
 merge: GuestGramMerge<Row>;
 /** The sidebar: All agents (newest shown message, its two newest agents, the summed count). */
 all: { newest: GramMessage | null; agents: string[]; unread: number };
 groups: GuestGramGroup<Row>[];
 labelled: boolean;
 /** The shared agents with Gram, by grant id. */
 grants: Map<string, GuestGramGrantInfo>;
 /** Who the composer posts to. */
 recipient: GuestGramGrantInfo | null;
 /** Every shared agent's unread: the Gram tab's badge. */
 badge: number;
 /** Some shared agent shares Gram: the guest's Gram tab shows. */
 offered: boolean;
}

const empty = (): GramSnapshot => ({
 phase: "idle", messages: [], unreadCount: 0, hasMore: false, loadingOlder: false, refreshing: false, markingAllRead: false,
 agents: [], saved: [], localMachine: "", attachments: [], sending: false, sendProgress: 0, sendProgressShown: false, draftPosted: 0, visible: false,
});

const rawID = (id: string) => id.slice(id.indexOf(GRANT_SEP) + 1);

function lane(state: GuestGramState): GuestGramLane<Row> & { info: GuestGramGrantInfo } {
 const g = state.grant;
 // The sender line reads "agent · owner" (3B), not the host's machine.
 const messages = state.gram.messages.map(m => ({ id: rawID(m.id), createdUnixMs: m.createdUnixMs, unread: m.unread, fromAgent: m.fromAgent, row: m.fromAgent ? { ...m, machine: g.owner } : m }));
 return { grant: g.id, info: { id: g.id, agent: g.agent, owner: g.owner, machine: g.machine }, messages, hasMore: state.gram.hasMore };
}

/** The view of `s` for the selected grant (null: All agents) and an explicit recipient pick. */
export function guestGramView(s: GuestGramSnapshot, selected: string | null): GuestGramView {
 const shared = s.grants.filter(g => g.grant.gram);
 const lanes = shared.map(lane);
 const grants = new Map(lanes.map(l => [l.grant, l.info]));
 const scope = selected !== null && grants.has(selected) ? shared.filter(g => g.grant.id === selected) : shared;
 const scoped = lanes.filter(l => scope.some(g => g.grant.id === l.grant));
 const merge = mergeGuestGram(scoped);
 const whole = mergeGuestGram(lanes);
 // Unread counts are each shared agent's own (its unread-only walk while Gram is hidden, its
 // inbox while it shows), as the owner's badge is: the loaded messages miss a hidden Gram's new ones.
 const unread = new Map(shared.map(g => [g.grant.id, g.gram.unreadCount]));
 const sum = (ids: Iterable<string>) => [...ids].reduce((n, id) => n + (unread.get(id) ?? 0), 0);
 const listed = guestGramGroups(lanes);
 const groups = listed.groups.map(group => ({ ...group, rows: group.rows.map(row => ({ ...row, unread: unread.get(row.grant.id) ?? 0 })) }));
 const labelled = listed.labelled;
 const recipientID = (s.recipient && grants.has(s.recipient) ? s.recipient : null) ?? (selected !== null && grants.has(selected) ? selected : merge.defaultTarget);
 const recipient = recipientID ? grants.get(recipientID) ?? null : null;
 const posting = shared.find(g => g.grant.id === recipientID)?.gram;
 const snaps = scope.map(g => g.gram);
 const snapshot: GramSnapshot = {
  ...empty(),
  phase: snaps.length === 0 ? (s.grants.some(g => !g.grant.ready) ? "loading" : "idle")
   : snaps.some(g => g.phase === "loaded") ? "loaded" : snaps.every(g => g.phase === "unavailable") ? "unavailable" : "loading",
  unavailable: snaps.find(g => g.unavailable)?.unavailable,
  messages: merge.items.map(item => item.message.row).reverse(),
  unreadCount: sum(scope.map(g => g.grant.id)),
  hasMore: merge.hasMore,
  loadingOlder: snaps.some(g => g.loadingOlder),
  olderError: snaps.find(g => g.olderError)?.olderError,
  status: posting?.status || snaps.find(g => g.status)?.status,
  refreshing: snaps.some(g => g.refreshing),
  markingAllRead: snaps.some(g => g.markingAllRead),
  saved: shared[0]?.gram.saved ?? [],
  visible: snaps.some(g => g.visible),
  attachments: posting?.attachments ?? [],
  sending: posting?.sending ?? false,
  sendProgress: posting?.sendProgress ?? 0,
  sendProgressShown: posting?.sendProgressShown ?? false,
  draftPosted: posting?.draftPosted ?? 0,
 };
 const agents: string[] = [];
 for (let i = whole.items.length - 1; i >= 0 && agents.length < 2; i--) {
  const agent = grants.get(whole.items[i]!.grant)!.agent;
  if (!agents.includes(agent)) agents.push(agent);
 }
 return {
  snapshot, merge, all: { newest: whole.items.at(-1)?.message.row ?? null, agents, unread: sum(unread.keys()) }, groups, labelled,
  grants, recipient, badge: sum(unread.keys()), offered: shared.length > 0,
 };
}

/** The grant a feed row (its "<grant>\x1f<id>") belongs to. */
export const grantOf = (id: string): string | null => id.includes(GRANT_SEP) ? id.slice(0, id.indexOf(GRANT_SEP)) : null;
