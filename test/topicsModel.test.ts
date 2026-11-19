// The Topics view's decisions (src/topicsModel.ts), against herdrup #745: TopicsView.swift
// (sections, pill, search), HerdrKit AgentTopics.swift (ordering) and ChatPreference.swift.
import { expect, test } from "bun:test";
import { nextTopicsOffer, orderedTopics, topicSendDelivery, topicsShown, resolvedMode, searchTopics, sendNote, statusDot, statusText, topicSections, topicsNotOffered, topicsProblem, topicTitle, type TopicInfo } from "../src/topicsModel";

const topic = (id: string, over: Partial<TopicInfo> = {}): TopicInfo => ({
 topic_id: id, title: id, state: "idle", turns: 1, queued: 0, created_unix_ms: 0, last_activity_unix_ms: 0, ...over,
});

test("open topics by last activity, newest first, then the closed ones; rows without an id dropped", () => {
 const list = [
  topic("old", { last_activity_unix_ms: 100 }),
  topic("closed-new", { state: "closed", last_activity_unix_ms: 900 }),
  topic("new", { last_activity_unix_ms: 500 }),
  topic("", { last_activity_unix_ms: 999 }),
  topic("started", { created_unix_ms: 700 }),
  topic("closed-old", { state: "closed", last_activity_unix_ms: 200 }),
  topic("b-tie", { last_activity_unix_ms: 100 }),
 ];
 expect(orderedTopics(list).map(t => t.topic_id)).toEqual(["started", "new", "b-tie", "old", "closed-new", "closed-old"]);
});

test("open topics fall under Today, This week and Earlier by local day; closed ones under Closed", () => {
 const now = new Date(2026, 10, 19, 15, 0);
 const at = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h).getTime();
 const sections = topicSections([
  topic("today", { last_activity_unix_ms: at(2026, 10, 19, 0) }),
  topic("six-days", { last_activity_unix_ms: at(2026, 10, 13) }),
  topic("seven-days", { last_activity_unix_ms: at(2026, 10, 12, 23) }),
  topic("gone", { state: "closed", last_activity_unix_ms: at(2026, 10, 19) }),
 ], now);
 expect(sections.map(s => [s.id, s.topics.map(t => t.topic_id)])).toEqual([
  ["Today", ["today"]], ["This week", ["six-days"]], ["Earlier", ["seven-days"]], ["Closed", ["gone"]],
 ]);
 expect(topicSections([topic("x", { last_activity_unix_ms: now.getTime() })], now).map(s => s.id)).toEqual(["Today"]);
});

test("the pill reads the state, with what waits; one dot, none for Closed or an unknown state", () => {
 expect([statusText(topic("a", { state: "running" })), statusDot(topic("a", { state: "running" }))]).toEqual(["Working", "working"]);
 expect(statusText(topic("a", { state: "starting" }))).toBe("Starting");
 expect([statusText(topic("a", { state: "idle", queued: 2 })), statusDot(topic("a"))]).toEqual(["Idle · 2 queued", "done"]);
 expect([statusText(topic("a", { state: "dead" })), statusDot(topic("a", { state: "dead" }))]).toEqual(["Stopped", "died"]);
 expect([statusText(topic("a", { state: "closed" })), statusDot(topic("a", { state: "closed" }))]).toEqual(["Closed", null]);
 expect([statusText(topic("a", { state: "unknown" })), statusDot(topic("a", { state: "unknown" }))]).toEqual([null, null]);
});

test("search matches the title or the newest step, ignoring case; a blank query keeps everything", () => {
 const list = [topic("1", { title: "Q4 board pack" }), topic("2", { title: "Diokan", last_activity: "Read the BOARD minutes" }), topic("3", { title: "Trip" })];
 expect(searchTopics(list, "  board ").map(t => t.topic_id)).toEqual(["1", "2"]);
 expect(searchTopics(list, "").length).toBe(3);
 expect(topicTitle(topic("x", { title: "  " }))).toBe("Untitled topic");
});

test("Topics opens only where the agent has topics; otherwise Chat, or the terminal without Chat", () => {
 expect(resolvedMode("topics", true, true)).toBe("topics");
 expect(resolvedMode("topics", true, false)).toBe("chat");
 expect(resolvedMode("topics", false, false)).toBe("terminal");
 expect(resolvedMode("chat", false, true)).toBe("terminal");
 expect(resolvedMode("terminal", true, true)).toBe("terminal");
});

test("refusals in the app's words; only a queued send leaves a note", () => {
 expect(topicsProblem("topics_unreachable")).toBe("Agent not reachable");
 expect(topicsProblem("topic_rejected", "busy")).toBe("The agent refused: busy");
 expect(topicsProblem("topic_rejected")).toBe("The agent refused.");
 expect(topicsProblem("something_new")).toBe("Couldn't reach the agent.");
 expect([topicsNotOffered("topics_unsupported"), topicsNotOffered("agent_not_found"), topicsNotOffered("topics_unreachable")]).toEqual([true, true, false]);
 expect(sendNote("queued")).toBe("Queued: the topic reads it when its current turn ends.");
 expect([sendNote("turn"), sendNote("steered")]).toEqual([null, null]);
});

test("a send herdr refused can be sent again; a timeout, an unknown code or a broken link may have arrived", () => {
 expect(["topic_rejected", "topics_unreachable", "topic_not_found", "agent_not_found", "topics_unsupported", "unsupported"].map(topicSendDelivery)).toEqual(Array(6).fill("refused"));
 expect(["topics_timeout", "something_new", ""].map(topicSendDelivery)).toEqual(["unconfirmed", "unconfirmed", "unconfirmed"]);
});

test("a failed list read keeps Topics for an agent whose session holds topics; only its answer removes it (#250)", () => {
 let offer = { offered: false, refused: false };
 expect(topicsShown(true, offer, true)).toBe(true);
 offer = nextTopicsOffer(offer, { offered: false, loaded: true, problem: "Agent not reachable" });
 expect(topicsShown(true, offer, true)).toBe(true);
 offer = nextTopicsOffer(offer, { offered: true, loaded: true });
 expect(topicsShown(true, offer, false)).toBe(true);
 offer = nextTopicsOffer(offer, { offered: false, loaded: true });
 expect([topicsShown(true, offer, true), topicsShown(true, offer, false)]).toEqual([false, false]);
 // After a refusal, a later failed read does not bring it back.
 offer = nextTopicsOffer(offer, { offered: false, loaded: true, problem: "Couldn't reach the agent." });
 expect(topicsShown(true, offer, true)).toBe(false);
 expect(topicsShown(false, { offered: true, refused: false }, true)).toBe(false);
});
