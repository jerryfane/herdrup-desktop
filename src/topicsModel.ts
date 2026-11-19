// An omp agent's Topics, kept free of the DOM so bun tests it (herdrup #745 TopicsView.swift,
// HerdrKit AgentTopics.swift, ChatPreference.swift; herdr #475).

import type { AgentTopicInfo, TopicsUpdate } from "./mygo";
import type { ChatMode } from "./chatPreference";

export type TopicInfo = AgentTopicInfo;
export type { TopicsUpdate };

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

/** The pill's one dot (TopicStatusPill.dot): working, done, died; none for Closed (plain text). */
export function statusDot(t: TopicInfo): "working" | "done" | "died" | null {
 switch (t.state) {
  case "starting": case "running": return "working";
  case "idle": return "done";
  case "dead": return "died";
 }
 return null;
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
 }
 return "Couldn't reach the agent.";
}

/** A refusal that means the agent has no topics (any more): the page goes back to Chat. */
export function topicsNotOffered(code: string): boolean {
 return code === "topics_unsupported" || code === "agent_not_found" || code === "unsupported";
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
