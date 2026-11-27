// An omp agent's Topics, kept free of the DOM so bun tests it (herdrup #745 TopicsView.swift,
// HerdrKit AgentTopics.swift, ChatPreference.swift; herdr #475).

import type { AgentTopicInfo, TopicSession, TopicsUpdate } from "./mygo";
import type { ChatMode } from "./chatPreference";
import type { TranscriptPage } from "./interactionModel";

export type TopicInfo = AgentTopicInfo;
export type { TopicsUpdate };

/** desk_topics.go ompHarness: an omp agent, plain or a named build ("omp …", "omp-…"); only omp
 *  has Topics and omp's Topics switch. */
export function ompHarness(harness: string): boolean {
 return /^omp(?:$| |-)/i.test(harness);
}

/** An Antigravity CLI (agy) agent, plain or a named build ("agy …", "agy-…"). */
export function agyHarness(harness: string): boolean {
 return /^agy(?:$| |-)/i.test(harness);
}

/** Whether a harness can use the Chat view when its server capability allows it. */
export function chatHarness(harness: string): boolean {
 return ompHarness(harness) || agyHarness(harness);
}

/** Whether Chat is available for a view: omp agents need the host's transcript support; agy agents
 *  additionally require the server's `transcript_agy` capability. Topics remain omp-only. */
export function chatAvailableFor(
 harness: string,
 guest: boolean,
 transcriptAgy: boolean | undefined,
 guestChat: { available: boolean; transcriptAgy?: boolean } | null | undefined,
): boolean {
 if (ompHarness(harness)) return !guest || !!guestChat?.available;
 if (agyHarness(harness)) return guest ? (!!guestChat?.available && !!guestChat?.transcriptAgy) : !!transcriptAgy;
 return false;
}

/** The mode a page shows for the one asked for (ChatPreference.resolved): Topics only where the
 *  agent has them; a Topics or Chat default without Chat opens the terminal. */
export function resolvedMode(mode: ChatMode, chatAvailable: boolean, topicsAvailable: boolean): ChatMode {
 if (mode === "topics" && topicsAvailable) return "topics";
 if (mode === "terminal") return "terminal";
 return chatAvailable ? "chat" : "terminal";
}

/** When a topic last did something: its newest step, else when it started (AgentTopic.activityUnixMs). */
export function activityMs(t: TopicInfo): number {
 return Math.max(t.last_activity_unix_ms ?? 0, t.created_unix_ms ?? 0);
}

/** "Untitled topic" for a topic without a title. */
export function topicTitle(t: TopicInfo): string {
 return t.title.trim() === "" ? "Untitled topic" : t.title;
}

/** The status as words ("Working", "Idle · 2 queued"), null for a state this app does not know
 *  (TopicStatusPill.text). */
export function statusText(t: TopicInfo): string | null {
 const label = ({ starting: "Starting", running: "Working", idle: "Idle", dead: "Stopped", closed: "Closed" } as Record<string, string>)[t.state];
 if (!label) return null;
 return t.queued > 0 ? `${label} · ${t.queued} queued` : label;
}

/** The mark before a status (Apple clean, owner picks 2026-11-24, item 12): the activity indicator
 *  while a topic works, a grey dot while it idles; no mark for Stopped or Closed. */
export function statusDot(t: TopicInfo): "working" | "idle" | null {
 if (t.state === "starting" || t.state === "running") return "working";
 return t.state === "idle" ? "idle" : null;
}

/** Which parts of the Topics view show (Topics A-v2 "fold the column"). Wide: the open topic (or
 *  the placeholder) always, the list beside it unless folded; a fold with no topic open keeps the
 *  list, so the page is never empty. Narrow: the list, or the open topic in its place. Wherever the
 *  list is not shown, the topic's header offers the "Topics" text button that brings it back. */
export function topicsLayout(wide: boolean, folded: boolean, topicOpen: boolean): { list: boolean; chat: boolean } {
 if (!wide) return { list: !topicOpen, chat: topicOpen };
 return { list: !folded || !topicOpen, chat: true };
}

/** There is a column to fold: wide, beside an open topic. The fold button shows and the shortcut
 *  acts only then, so neither changes the kept preference without changing the page (#344: a
 *  narrow page has no column; leaving its topic would drop the unsent draft). */
export function canFold(wide: boolean, topicOpen: boolean): boolean {
 return wide && topicOpen;
}

/** ⌥⌘T on a Mac, Ctrl+Alt+T elsewhere, folds or unfolds the topics column. `code`, not `key`:
 *  Option turns the T key into "†" on a Mac. */
export function isFoldShortcut(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code">): boolean {
 return (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && e.code === "KeyT";
}

/** What a keydown does to the fold: "toggle" once per press where there is a column to fold;
 *  "swallow" for the key held down (auto-repeat), which must not flap the column; null for any
 *  other key, or where nothing can fold, so the key goes on to the page. */
export function foldKey(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code" | "repeat">, foldable: boolean): "toggle" | "swallow" | null {
 if (!foldable || !isFoldShortcut(e)) return null;
 return e.repeat ? "swallow" : "toggle";
}
/** The shortcut as the header's hint shows it. */
export function foldShortcutLabel(mac: boolean): string {
 return mac ? "⌥⌘T" : "Ctrl+Alt+T";
}

/** Topics whose title or newest step holds the query, case-insensitively (TopicsList.shown). */
export function searchTopics(topics: readonly TopicInfo[], query: string): TopicInfo[] {
 const q = query.trim().toLocaleLowerCase();
 if (q === "") return [...topics];
 return topics.filter(t => t.title.toLocaleLowerCase().includes(q) || (t.last_activity ?? "").toLocaleLowerCase().includes(q));
}

export interface TopicSection { id: "Today" | "This week" | "Earlier" | "Closed"; topics: TopicInfo[] }

/** Open topics by day (Today, This week: the six days before today, Earlier), then Closed; empty
 *  sections left out (TopicsList.sections). `now` is local time. */
export function topicSections(topics: readonly TopicInfo[], now: Date): TopicSection[] {
 const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
 const weekAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
 const today: TopicInfo[] = [], week: TopicInfo[] = [], earlier: TopicInfo[] = [], closed: TopicInfo[] = [];
 for (const t of topics) {
  if (t.state === "closed") { closed.push(t); continue; }
  const at = activityMs(t);
  if (at >= startOfToday) today.push(t);
  else if (at >= weekAgo) week.push(t);
  else earlier.push(t);
 }
 const sections: TopicSection[] = [
  { id: "Today", topics: today }, { id: "This week", topics: week }, { id: "Earlier", topics: earlier }, { id: "Closed", topics: closed },
 ];
 return sections.filter(s => s.topics.length > 0);
}

/** The note under a topic's composer after a send (TopicsModel.deliver): only a queued message
 *  says anything. */
export function sendNote(mode: string): string | null {
 return mode === "queued" ? "Queued: the topic reads it when its current turn ends." : null;
}

/** The host caps a topic message at 32 KiB, as agent.prompt (TopicsModel.maxMessageBytes). */
export const TOPIC_MESSAGE_BYTES = 32 * 1024;
export function messageTooLong(text: string): boolean {
 return new TextEncoder().encode(text).length > TOPIC_MESSAGE_BYTES;
}

/** The Topics view's order (AgentTopicList.ordered, desk_topics.go orderedTopics): open topics by
 *  last activity, newest first, then the closed ones the same way; rows without an id dropped. */
export function orderedTopics(topics: readonly TopicInfo[]): TopicInfo[] {
 return topics.filter(t => t.topic_id !== "").sort((a, b) => {
  const ac = a.state === "closed", bc = b.state === "closed";
  if (ac !== bc) return ac ? 1 : -1;
  const x = activityMs(a), y = activityMs(b);
  if (x !== y) return y - x;
  return a.topic_id < b.topic_id ? -1 : a.topic_id > b.topic_id ? 1 : 0;
 });
}

/** Why a topics call failed, in the iPhone app's words (TopicsModel.describe, desk_topics.go
 *  topicsProblem). */
export function topicsProblem(code: string, message = ""): string {
 switch (code) {
  case "topics_unreachable": return "Agent not reachable";
  case "topics_timeout": return "The agent didn't answer in time.";
  case "topic_rejected": return message === "" ? "The agent refused." : "The agent refused: " + message;
  case "topic_not_found": return "This topic is gone.";
  case "agent_not_found": return "This agent is gone.";
  case "topics_unsupported": return "This agent has no topics.";
  case "suggestion_not_found": return "That suggestion is gone.";
  case "already_accepted": return "Someone already started that topic.";
  case "organise_running": return "The agent is already organising.";
  case "topics_disabled": return "Topics are off for this agent.";
  case "invalid_message_ids": return "The agent's picked messages are no longer in its conversation.";
 }
 return "Couldn't reach the agent.";
}

/** A refusal that means the agent has no topics (any more): the page goes back to Chat.
 *  agent_not_found is not that answer (an agent herdr briefly can't resolve, as while it starts a
 *  topic): it keeps the list, as every other failure does (desk_topics.go topicsNotOffered). */
export function topicsNotOffered(code: string): boolean {
 return code === "topics_unsupported" || code === "unsupported";
}

/** The topics the agent's session file holds (AgentView.topicSessions) as the list shows them
 *  until the agent answers: their ids and titles, in the list's order, state unknown. */
export function seededTopics(sessions: readonly TopicSession[]): TopicInfo[] {
 return orderedTopics(sessions.map(s => ({ topic_id: s.topicID, title: s.title, state: "unknown", queued: 0, turns: 0, created_unix_ms: s.createdMs, last_activity_unix_ms: s.createdMs })));
}

/** The topics the list shows: the agent's answer once it gave one, else the ones its session file
 *  holds (a first read still on its way, or one that failed). A cached answer that is stale and
 *  empty is not the agent's word either. */
export function listedTopics(u: Pick<TopicsUpdate, "offered" | "topics" | "stale"> | null, seeded: readonly TopicInfo[]): TopicInfo[] {
 if (u?.offered && !(u.stale && u.topics.length === 0)) return u.topics;
 return [...seeded];
}

/** A topic works (its chat shows the working dots, as the Inbox's ChatView.sessionFooter): it
 *  runs or starts, or its page has a working turn (iOS TopicChat: a state that isn't working is no
 *  status, so the page's turn decides). */
export function topicWorking(t: Pick<TopicInfo, "state">, page: Pick<TranscriptPage, "working"> | null): boolean {
 return t.state === "running" || t.state === "starting" || !!page?.working;
}

/** How a failed agent.topics.send went, by herdr's code (desk_topics.go topicSendDelivery, iOS
 *  TopicsModel.deliver): its refusals were not delivered; a timeout, an unknown code or a broken
 *  link ("") may have been. */
export function topicSendDelivery(code: string): "refused" | "unconfirmed" {
 switch (code) {
  case "topics_unreachable": case "topic_rejected": case "topic_not_found": case "agent_not_found":
  case "topics_unsupported": case "invalid_params": case "unsupported":
   return "refused";
 }
 return "unconfirmed";
}

/** What the page knows about an agent's topics offer (#745 topicsAvailable). `refused`: the agent
 *  answered it has none (not offered, no problem). A failed read carries a problem and is not that
 *  answer, so a session-backed offer and its polling survive it (#250). */
export interface TopicsOffer { offered: boolean; refused: boolean }
export function nextTopicsOffer(prev: TopicsOffer, u: Pick<TopicsUpdate, "offered" | "loaded" | "problem">): TopicsOffer {
 return { offered: u.offered, refused: u.loaded && !u.problem ? !u.offered : prev.refused };
}
/** The page shows Topics: a server with agent_topics, and the agent answered its list or its
 *  session file holds topics, unless it answered it has none. */
export function topicsShown(capable: boolean, offer: TopicsOffer, topicSessions: boolean): boolean {
 return capable && (offer.offered || (!offer.refused && topicSessions));
}
