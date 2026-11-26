// An open topic as the agent's page draws it (interaction.ts with topicsView.ts TopicChat), on the
// shared fake document (fakeDom.ts) with Go answered here: the Inbox's rows under the topic's
// conversation, its width handles, and the Inbox's own composer lent to the topic (the grow handle,
// files pasted or dropped as chips, saved prompts and the mic); and a handover between the Inbox
// and a topic (relay) as both chats draw it; and the chat's up arrow to the owner's previous prompt.
import { afterAll, beforeAll, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { FakeDocument, FakeElement } from "./fakeDom";
import type { AgentTarget, GramAttachment } from "../src/mygo";
import type * as Interaction from "../src/interaction";
import * as chatMarkdown from "../src/chatMarkdown";
import { CHAT_POLL_OWNER_MS } from "../src/chatPoll";

// DOMPurify needs a real DOM, which Bun lacks: a message's markdown is its text here.
mock.module("../src/chatMarkdown", () => ({
 ...chatMarkdown,
 markdown: (text: string) => { const body = document.createElement("div"); body.className = "chat-markdown"; body.textContent = text; return body; },
}));

type Answer = (...args: unknown[]) => unknown;

const doc = new FakeDocument();
const G = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
const stored = new Map<string, string>();
/** Go's events as the page subscribed to them (mygo.on), and the calls it made (mygo.call). */
const listeners = new Map<string, Set<(payload: unknown) => void>>();
let calls: { method: string; args: unknown[] }[] = [];
let answers: Record<string, Answer> = {};
/** Every ResizeObserver the page made, with the elements it watches. */
const observers: { run: () => void; watched: Set<unknown> }[] = [];
let page: typeof Interaction;

function emit(name: string, payload: unknown) { for (const l of listeners.get(name) ?? []) l(payload); }
/** Lets the page's pending calls and their follow-ups run (no clock involved). */
async function settle() { for (let i = 0; i < 40; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
/** The page resizes: every observer watching node runs, as a browser's would. */
function resized(node: FakeElement) { for (const o of observers) if (o.watched.has(node)) o.run(); }

const TOPIC = { topicID: "t1", title: "Board pack", createdMs: Date.now() - 60_000 };
const target = { machineID: "m1", session: "", paneID: "p1" } as unknown as AgentTarget;
function file(name: string): GramAttachment {
 return { path: `/tmp/${name}`, name, mime: "application/pdf", isImage: false, size: 2048, state: "ready", label: "2 KB", fraction: 1, determinate: true, indeterminate: false, failed: false };
}
/** A topic page as herdr gives it (agent.transcript with topic). */
function topicPage(over: Record<string, unknown> = {}) {
 return JSON.stringify({ after: "a1", session_id: "s1", entries: [], ...over });
}

beforeAll(async () => {
 const globals: Record<string, unknown> = {
  document: doc, HTMLElement: FakeElement, HTMLDetailsElement: class {}, HTMLInputElement: class {}, Node: FakeElement,
  window: Object.assign(doc.defaultView, { setTimeout, clearTimeout, setInterval, clearInterval, devicePixelRatio: 1 }),
  // The ask form's chevrons (symbol.ts symbolNow) read the page's pixel ratio.
  devicePixelRatio: 1,
  localStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, String(v)); }, removeItem: (k: string) => { stored.delete(k); } },
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  CSS: { escape: (text: string) => text },
  // Reduced motion: a send plays no press animation (the fake elements have no animate()).
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (run: () => void) => setImmediate(run),
  cancelAnimationFrame: clearImmediate,
  ResizeObserver: class {
   readonly watched = new Set<unknown>();
   constructor(run: () => void) { observers.push({ run, watched: this.watched }); }
   observe(node: unknown) { this.watched.add(node); }
   unobserve(node: unknown) { this.watched.delete(node); }
   disconnect() { this.watched.clear(); }
  },
  mygo: {
   on: (name: string, l: (payload: unknown) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(l);
    return () => listeners.get(name)!.delete(l);
   },
   once: () => () => {},
   call: (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
    const answer = answers[method];
    return answer ? Promise.resolve().then(() => answer(...args)) : new Promise(() => {});
   },
  },
 };
 for (const [k, v] of Object.entries(globals)) { saved[k] = G[k]; G[k] = v; }
 // Imported once the fake page stands: the page's modules subscribe to Go's events as they load.
 page = await import("../src/interaction");
 const detail = doc.createElement("div"); doc.body.append(detail);
 page.initInteraction(detail as unknown as HTMLElement, async () => doc.createElement("span") as unknown as Element, () => {});
});
afterAll(() => { page.closeInteraction(); for (const [k, v] of Object.entries(saved)) G[k] = v; });
beforeEach(() => { page.closeInteraction(); calls = []; stored.clear(); });

/** Opens the agent's page on its saved choice (Topics or the Inbox's chat); topic is a topic's
 *  page, inbox the Inbox's, or how the Inbox answers its reads (token, after, before, …); view
 *  overrides fields of the agent's view (e.g. askForm). */
async function openPage(mode: "topics" | "chat", topic: string, inbox: string | ((...args: unknown[]) => string | Promise<string>) = topicPage(), view: Record<string, unknown> = {}) {
 stored.set("chat.ompOpensIn", mode);
 answers = {
  "Desk.OpenAgentView": (_target: unknown, token: unknown) => ({ token, paneID: "p1", name: "herdr-app", harness: "omp", heading: "herdr-app", group: "idle", status: "idle", guest: false, guestGram: false, plainTerminal: false, askForm: false, topicSessions: [TOPIC], ...view }),
  "Desk.TopicsAvailable": () => true,
  "Desk.PaneMuted": () => false,
  "Desk.TopicTranscript": () => topic,
  "Desk.ChatTranscript": typeof inbox === "function" ? inbox : () => inbox,
  "Desk.SavedPrompts": () => [{ id: "p1", nickname: "Standup", text: "Post the daily standup" }],
  "Desk.TopicsSend": () => ({ mode: "", delivery: "sent" }),
 };
 await page.selectInteraction(target);
 await settle();
}

/** Opens the agent's page on Topics (its saved choice) and the topic in it; transcript is the
 *  topic's page. Returns the page's parts the tests read. */
async function openTopic(transcript: string = topicPage()) {
 await openPage("topics", transcript);
 const row = doc.body.all().find(n => n.tagName === "button" && n.text().includes(TOPIC.title));
 if (!row) throw new Error("no row for the topic");
 row.click();
 await settle();
 const chat = doc.body.all().find(n => n.className === "topic-chat");
 if (!chat) throw new Error("the topic didn't open");
 const slot = chat.all().find(n => n.className === "topic-composer-slot")!;
 const transcriptNode = chat.all().find(n => n.className.includes("topic-transcript"))!;
 const token = String(calls.find(c => c.method === "Desk.OpenAgentView")!.args[1]);
 return { chat, slot, transcript: transcriptNode, token, input: slot.all().find(n => n.tagName === "textarea") };
}
const withClass = (node: FakeElement, cls: string) => node.all().filter(n => n.className.split(" ").includes(cls));

test("an open topic draws the Inbox's working dots and model line under its conversation", async () => {
 const { transcript } = await openTopic(topicPage({ working: { intent: "Reading the deck" }, model: { id: "claude-opus-4", provider: "anthropic", thinking_level: "high" } }));
 const working = withClass(transcript, "chat-working");
 expect(working).toHaveLength(1);
 expect(working[0]!.getAttribute("aria-label")).toBe("Working: Reading the deck");
 const model = withClass(transcript, "chat-model");
 expect(model).toHaveLength(1);
 expect(model[0]!.textContent).toContain("claude-opus-4");
 // The rows close the conversation, as under the Inbox.
 expect(transcript.children.at(-1)).toBe(model[0]);
});

test("the conversation's width handles stand over the open topic, the Inbox's hidden", async () => {
 const { chat } = await openTopic();
 const handles = chat.children.filter(n => n.className.startsWith("gcol-handle"));
 expect(handles.map(h => h.className)).toEqual(["gcol-handle leading", "gcol-handle trailing"]);
 chat.clientWidth = 1200; resized(chat);
 expect(handles.every(h => h.shown())).toBe(true);
 // Too narrow to resize: the conversation shows whole, without handles.
 chat.clientWidth = 320; resized(chat);
 expect(handles.some(h => h.shown())).toBe(false);
 const inbox = doc.body.all().filter(n => n.className.startsWith("gcol-handle") && !chat.contains(n));
 expect(inbox).toHaveLength(2);
 expect(inbox.some(h => h.shown())).toBe(false);
});

test("the topic's composer is the Inbox's, with its grow handle sized from the topic's room", async () => {
 const { slot, transcript, input } = await openTopic();
 const handle = slot.all().find(n => n.className === "composer-expand-handle");
 expect(handle).toBeDefined();
 expect(input).toBeDefined();
 expect(input!.placeholder).toBe("Message Board pack");
 // Lines enough to grow and the topic's conversation to grow into: the handle shows.
 transcript.clientHeight = 600;
 input!.value = "one\ntwo\nthree\nfour"; input!.oninput?.(new Event("input"));
 expect(handle!.shown()).toBe(true);
 // No room left in the topic: nothing to grow into.
 transcript.clientHeight = 0;
 input!.value = "one\ntwo\nthree\nfour\nfive"; input!.oninput?.(new Event("input"));
 expect(handle!.shown()).toBe(false);
});

test("a file pasted into the topic's composer becomes a chip there", async () => {
 const { slot, input, token } = await openTopic();
 answers["Desk.PanePasteClipboard"] = (t: unknown) => { emit("pane:attachments", { token: t, files: [file("deck.pdf")], note: "" }); return true; };
 const paste = [...(input!.held.get("paste") ?? [])][0] as ((e: unknown) => void) | undefined;
 expect(paste).toBeDefined();
 let prevented = false;
 paste!({ isTrusted: true, clipboardData: { types: ["Files"], getData: () => "" }, preventDefault: () => { prevented = true; } });
 await settle();
 expect(prevented).toBe(true);
 expect(calls.filter(c => c.method === "Desk.PanePasteClipboard").map(c => c.args)).toEqual([[token]]);
 const chips = withClass(slot, "gchip");
 expect(chips.map(c => c.text())).toEqual(["deck.pdf2 KB"]);
 expect(chips[0]!.shown()).toBe(true);
});

test("a file dropped on the topic's composer becomes a chip there", async () => {
 const { slot, input, token } = await openTopic();
 answers["Desk.PaneAttachFiles"] = (t: unknown, paths: unknown) => { emit("pane:attachments", { token: t, files: (paths as string[]).map(p => file(p.split("/").pop()!)), note: "" }); };
 doc.pointed = input!;
 emit("mygo:file-drop", { paths: ["/Users/me/notes.pdf"], x: 40, y: 600 });
 await settle();
 expect(calls.filter(c => c.method === "Desk.PaneAttachFiles").map(c => c.args)).toEqual([[token, ["/Users/me/notes.pdf"]]]);
 expect(withClass(slot, "gchip").map(c => c.text())).toEqual(["notes.pdf2 KB"]);
 // A drop outside the composer attaches nothing.
 doc.pointed = doc.body;
 emit("mygo:file-drop", { paths: ["/Users/me/other.pdf"], x: 40, y: 40 });
 await settle();
 expect(calls.filter(c => c.method === "Desk.PaneAttachFiles")).toHaveLength(1);
});

test("the topic's composer has the mic and the saved prompts, and a saved prompt goes to the topic", async () => {
 const { slot } = await openTopic();
 const mic = slot.all().find(n => n.tagName === "button" && n.className.includes("composer-microphone"));
 expect(mic?.getAttribute("aria-label")).toBe("Dictate");
 expect(mic!.shown()).toBe(true);
 const prompts = slot.all().find(n => n.tagName === "button" && n.getAttribute("aria-label") === "Saved prompts");
 expect(prompts!.shown()).toBe(true);
 prompts!.click();
 await settle();
 const standup = slot.all().find(n => n.tagName === "button" && n.textContent === "Standup");
 expect(standup?.shown()).toBe(true);
 standup!.click();
 await settle();
 expect(calls.filter(c => c.method === "Desk.TopicsSend").map(c => c.args.slice(1))).toEqual([["t1", "Post the daily standup"]]);
});

// ---- Handovers between the Inbox and a topic (herdr kind "relay", chatRelay.ts) ----

const LONG = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of the minutes.`).join("\n\n");
/** herdr #521's relay entry: topic_id only when a topic sent it (the Inbox's has none). */
function relay(id: string, from: string, direction: string, text: string, topicID?: string) {
 return { kind: "relay", id, ts_ms: Date.now() - 1000, from, ...(topicID ? { topic_id: topicID } : {}), direction, text };
}
/** The chat's rows: the topic's when open, else the Inbox's transcript. */
function inboxTranscript() {
 return doc.body.all().find(n => n.className.split(" ").includes("chat-transcript") && !n.className.includes("topic-transcript"))!;
}

test("a handover reads From Inbox in the topic and From topic <title> in the Inbox, left as the agent's text", async () => {
 const { transcript } = await openTopic(topicPage({ entries: [
  relay("r1", "Inbox", "to_topic", "Draft the **board pack** intro."),
  // A sibling topic's handover (batched turns come split per sender: "<id>:<n>").
  relay("r1:1", "Trip", "to_topic", "Dates are fixed.", "t2"),
 ] }));
 const inTopic = withClass(transcript, "relay");
 expect(inTopic).toHaveLength(2);
 expect(inTopic[0]!.className).toBe("chat-message relay");
 expect(inTopic.map(row => withClass(row, "chat-relay-from").map(n => n.textContent))).toEqual([["From Inbox"], ["From topic Trip"]]);
 expect(withClass(inTopic[0]!, "chat-markdown").map(n => n.textContent)).toEqual(["Draft the **board pack** intro."]);
 // Not the owner's bubble.
 expect(withClass(transcript, "user")).toEqual([]);

 page.closeInteraction();
 const older = { kind: "user", id: "u1", ts_ms: Date.now() - 500, text: "<irc>\nAsked by Inbox (`Main`):\n\nOld shape" };
 await openPage("chat", topicPage(), topicPage({ entries: [relay("r2", "Board pack", "to_inbox", "The intro is drafted.", "t1"), older] }));
 const inbox = inboxTranscript();
 const inInbox = withClass(inbox, "relay");
 expect(withClass(inInbox[0]!, "chat-relay-from").map(n => n.textContent)).toEqual(["From topic Board pack"]);
 // An older herdr's handover (kind "user") stays the owner's bubble, as before.
 const bubbles = withClass(inbox, "user");
 expect(bubbles).toHaveLength(1);
 expect(bubbles[0]!.text()).toContain("Old shape");
});

test("a long handover folds after about six lines with Show all; a short one has no toggle", async () => {
 const { transcript } = await openTopic(topicPage({ entries: [relay("r3", "Inbox", "to_topic", LONG), relay("r4", "Inbox", "to_topic", "Short.")] }));
 const [long, short] = withClass(transcript, "relay");
 const body = (row: FakeElement) => withClass(row, "chat-relay-body")[0]!;
 const toggle = (row: FakeElement) => withClass(row, "chat-relay-toggle")[0]!;
 expect(body(long!).dataset.folded).toBe("true");
 // Laid out: the long body runs past its six-line fold, the short one fits.
 body(long!).scrollHeight = 480; body(long!).clientHeight = 150; resized(body(long!));
 body(short!).scrollHeight = 24; body(short!).clientHeight = 24; resized(body(short!));
 expect(toggle(long!).shown()).toBe(true);
 expect(toggle(long!).textContent).toBe("Show all");
 expect(toggle(short!).shown()).toBe(false);
 toggle(long!).click();
 expect(body(long!).dataset.folded).toBe("false");
 expect(toggle(long!).textContent).toBe("Show less");
 // A capsule, as every button.
 expect(toggle(long!).className.split(" ")).toContain("button-compact");
 toggle(long!).click();
 expect(body(long!).dataset.folded).toBe("true");
 expect(toggle(long!).textContent).toBe("Show all");
});

// Post-merge review of #528 (P3): the topic redrew every row on each read, so a reader's Show less
// lost its focus when the topic changed; an unchanged row now stays attached, as the Inbox's do.
test("an unfolded handover keeps its row and its focus when the topic reads again", async () => {
 const { transcript, token } = await openTopic(topicPage({ entries: [relay("r5", "Inbox", "to_topic", LONG)] }));
 const row = withClass(transcript, "relay")[0]!;
 const body = withClass(row, "chat-relay-body")[0]!, toggle = withClass(row, "chat-relay-toggle")[0]!;
 body.scrollHeight = 480; body.clientHeight = 150; resized(body);
 toggle.click(); toggle.focus();
 const reads = calls.filter(c => c.method === "Desk.TopicTranscript").length;
 emit("topics:changed", { token, topics: [{ topic_id: TOPIC.topicID, title: TOPIC.title, state: "idle", turns: 0, queued: 0, created_unix_ms: 1, last_activity_unix_ms: 1 }],
  offered: true, loaded: true, changed: TOPIC.topicID, suggestions: [], suggestionsServed: false, requestedMs: Date.now() });
 await settle();
 expect(calls.filter(c => c.method === "Desk.TopicTranscript").length).toBeGreaterThan(reads);
 expect(withClass(transcript, "relay")[0]).toBe(row);
 expect(doc.activeElement).toBe(toggle);
 expect(toggle.textContent).toBe("Show less");
});

// herdr 31bd88e6 projects held entries otherwise, so a cursor read before the update fails its
// hash check for good (cursor_expired, "reload the newest page"): the chat stayed on the old view
// and said so, and Refresh read the same cursor again. Now the Inbox and a topic start over from
// their newest page, as Refresh and ⌘R always do; an older page's expired cursor stops paging.
const EXPIRED = "herdr: cursor_expired: the transcript changed under this cursor; reload the newest page";
const reply = (id: string, text: string) => ({ kind: "reply", id, ts_ms: Date.now() - 500, text });
function refreshButton() { return doc.body.all().find(n => n.getAttribute("aria-label") === "Refresh")!; }
function startedOver(node: FakeElement) {
 const text = node.text();
 return [text.includes("The newest page"), text.includes("Projected before the update"), doc.body.text().includes("cursor_expired")];
}

test("a topic whose cursor herdr expired starts over from its newest page", async () => {
 const { transcript, token } = await openTopic(topicPage({ entries: [reply("old", "Projected before the update")] }));
 const reads: unknown[] = [];
 answers["Desk.TopicTranscript"] = (_token: unknown, _topic: unknown, after: unknown) => {
  reads.push(after);
  if (after) throw new Error(EXPIRED);
  return topicPage({ after: "a2", entries: [reply("n1", "The newest page")] });
 };
 emit("topics:changed", { token, topics: [{ topic_id: TOPIC.topicID, title: TOPIC.title, state: "idle", turns: 0, queued: 0, created_unix_ms: 1, last_activity_unix_ms: 1 }],
  offered: true, loaded: true, changed: TOPIC.topicID, suggestions: [], suggestionsServed: false, requestedMs: Date.now() });
 await settle();
 expect(reads).toEqual(["a1", ""]);
 expect(startedOver(transcript)).toEqual([true, false, false]);
});

test("the Inbox whose cursor herdr expired starts over from its newest page", async () => {
 // A session of its own: the Inbox remembers the agent's chat across openings.
 const session = { session_id: "s-expired" };
 await openPage("chat", topicPage(), topicPage({ ...session, entries: [reply("old", "Projected before the update")] }));
 page.closeInteraction();
 // Reopened, the Inbox draws the chat it remembers and reads on from its after cursor.
 const reads: unknown[] = [];
 await openPage("chat", topicPage(), (_token: unknown, after: unknown) => {
  reads.push(after);
  if (after) throw new Error(EXPIRED);
  return topicPage({ ...session, after: "a2", entries: [reply("n1", "The newest page")] });
 });
 expect(reads).toEqual(["a1", ""]);
 expect(startedOver(inboxTranscript())).toEqual([true, false, false]);
});

test("Refresh and ⌘R start the Inbox and an open topic over from their newest page, never from the held cursor", async () => {
 const session = { session_id: "s-refresh" };
 await openPage("chat", topicPage(), topicPage({ ...session, entries: [reply("old", "Projected before the update")] }));
 const reads: unknown[] = [];
 answers["Desk.ChatTranscript"] = (_token: unknown, after: unknown) => { reads.push(after); return topicPage({ ...session, after: "a2", entries: [reply("n1", "The newest page")] }); };
 refreshButton().click();
 await settle();
 expect(reads).toEqual([""]);
 expect(startedOver(inboxTranscript())).toEqual([true, false, false]);

 page.closeInteraction();
 const { transcript } = await openTopic(topicPage({ entries: [reply("old", "Projected before the update")] }));
 const topicReads: unknown[] = [];
 answers["Desk.TopicTranscript"] = (_token: unknown, _topic: unknown, after: unknown) => { topicReads.push(after); return topicPage({ after: "a2", entries: [reply("n1", "The newest page")] }); };
 const listed = calls.filter(c => c.method === "Desk.TopicsRefresh").length;
 expect(page.refreshInteraction()).toBe(true);
 await settle();
 expect(topicReads).toEqual([""]);
 expect(calls.filter(c => c.method === "Desk.TopicsRefresh").length).toBe(listed + 1);
 expect(startedOver(transcript)).toEqual([true, false, false]);
});

// #565: Refresh and an expired cursor start the Inbox over from its newest page; the question
// still pending in the same session keeps the answer typed into it, not yet sent, and where its
// form stands. Another pending question or session drops it.
const ASK = { id: "q1", answerable: true, questions: [], form_answerable: true, form: { fields: [{ name: "name", kind: "text", title: "What should it be called?", value: "Default name" }] } };
function askPage(over: Record<string, unknown> = {}) { return topicPage({ after: "a2", pending_ask: ASK, ...over }); }
/** Types text into the pending question's field and goes on to its Review step. */
function answerAsk(text: string) {
 const box = withClass(inboxTranscript(), "ask-form-input")[0]!;
 box.value = text; box.dispatchEvent(new Event("input"));
 withClass(inboxTranscript(), "ask-form-next")[0]!.click();
}
/** The answer the question's Review step shows, or null off that step. */
function reviewed() { return withClass(inboxTranscript(), "ask-form-review-answer")[0]?.text() ?? null; }

test("Refresh keeps an unsent answer to the question still pending; another question or session drops it", async () => {
 const session = { session_id: "s565" };
 await openPage("chat", topicPage(), askPage(session), { askForm: true });
 answerAsk("Ledger");
 expect(reviewed()).toBe("Ledger");
 refreshButton().click();
 await settle();
 expect(reviewed()).toBe("Ledger");
 // Another question pending in between: the first one's draft went.
 answers["Desk.ChatTranscript"] = () => askPage({ ...session, pending_ask: { ...ASK, id: "q2" } });
 refreshButton().click();
 await settle();
 answers["Desk.ChatTranscript"] = () => askPage(session);
 refreshButton().click();
 await settle();
 expect(reviewed()).toBeNull();
 // A new session, the same question id.
 answerAsk("Ledger");
 answers["Desk.ChatTranscript"] = () => askPage({ session_id: "s565-next" });
 refreshButton().click();
 await settle();
 expect(reviewed()).toBeNull();
});

// #572: a new session pending the same question with the same payload draws a card of its own:
// the field starts from the agent's value, and Next moves that card on, not the old one's state.
test("a new session's same question draws a fresh form whose Next moves on", async () => {
 await openPage("chat", topicPage(), askPage({ session_id: "s572" }), { askForm: true });
 const typed = withClass(inboxTranscript(), "ask-form-input")[0]!;
 typed.value = "Ledger"; typed.dispatchEvent(new Event("input"));
 answers["Desk.ChatTranscript"] = () => askPage({ session_id: "s572-next" });
 refreshButton().click();
 await settle();
 expect(withClass(inboxTranscript(), "ask-form-input")[0]!.value).toBe("Default name");
 withClass(inboxTranscript(), "ask-form-next")[0]!.click();
 expect(reviewed()).toBe("Default name");
});

// #571: herdr refused the submit (ask_form_moved: the Terminal's form changed), and the Review
// step offered only the Terminal. Refresh reloads the form, which may be answerable again: the
// refusal goes, the unsent answer and its step stay, and Submit sends it.
test("Refresh drops a question's terminal-only refusal and keeps its unsent answer at Review", async () => {
 await openPage("chat", topicPage(), askPage({ session_id: "s571" }), { askForm: true });
 answers["Desk.ChatAnswerForm"] = () => ({ code: "ask_form_moved", message: "the form changed" });
 answerAsk("Ledger");
 withClass(inboxTranscript(), "ask-form-submit")[0]!.click();
 await settle();
 expect([withClass(inboxTranscript(), "ask-form-submit").length, withClass(inboxTranscript(), "chat-question-terminal").length]).toEqual([0, 1]);
 refreshButton().click();
 await settle();
 expect([reviewed(), withClass(inboxTranscript(), "chat-question-terminal").length]).toEqual(["Ledger", 0]);
 withClass(inboxTranscript(), "ask-form-submit")[0]!.click();
 await settle();
 expect(calls.filter(c => c.method === "Desk.ChatAnswerForm").map(c => c.args[2])).toEqual([{ name: { text: "Ledger" } }, { name: { text: "Ledger" } }]);
});

test("the Inbox whose cursor herdr expired keeps an unsent answer to the question still pending", async () => {
 const session = { session_id: "s565-expired" };
 await openPage("chat", topicPage(), askPage(session), { askForm: true });
 page.closeInteraction();
 // Reopened, the Inbox draws the chat it remembers; the owner answers while its after read waits.
 const reads: unknown[] = [];
 const waiting = Promise.withResolvers<string>();
 await openPage("chat", topicPage(), (_token: unknown, after: unknown) => {
  reads.push(after);
  return after ? waiting.promise : askPage(session);
 }, { askForm: true });
 answerAsk("Ledger");
 waiting.reject(new Error(EXPIRED));
 await settle();
 expect(reads).toEqual(["a2", ""]);
 expect(reviewed()).toBe("Ledger");
});

// #560 review: the subagent sheet whose older cursor herdr expired starts over, and offers no
// earlier page until a newest page brings a cursor.
test("the subagent sheet whose older cursor herdr expired hides Earlier messages", async () => {
 const reads: string[] = [];
 await openPage("chat", topicPage(), (_token: unknown, after: unknown, before: unknown, subagent: unknown) => {
  if (!subagent) return topicPage({ session_id: "s-sub", subagents: [{ id: "Scout", status: "running", started_ms: Date.now(), has_transcript: true }] });
  reads.push(`${after}|${before}`);
  if (before) throw new Error(EXPIRED);
  return topicPage({ session_id: "s-sub", before: "b1", entries: [reply("s1", "Looking")] });
 });
 withClass(inboxTranscript(), "chat-subagent-row")[0]!.click();
 await settle();
 const sheet = withClass(doc.body, "subagent-sheet")[0]!;
 const earlier = withClass(sheet, "chat-earlier")[0]!;
 expect(earlier.hidden).toBe(false);
 earlier.click();
 await settle();
 expect(reads).toEqual(["|", "|b1"]);
 expect(earlier.hidden).toBe(true);
});

// #560 review: the read that started over owns the restart. A newest page that failed leaves the
// next read starting over too, never resending the expired cursor, and the error it showed goes
// once a page lands. A poll Refresh took over reads nothing more when its cursor expires.
function statusText() { return doc.body.all().find(n => n.className === "interaction-status")!.textContent; }
/** Runs body with the page's owner poll timer (chatPollDelay) held, never run by the clock:
 *  `poll()` runs the Inbox's next read now. */
async function withHeldPoll(body: (poll: () => Promise<void>) => Promise<void>) {
 const win = G.window as { setTimeout: (run: () => void, ms?: number) => unknown };
 const real = win.setTimeout;
 let held: (() => void) | null = null;
 win.setTimeout = (run, ms) => { if (ms !== CHAT_POLL_OWNER_MS) return real(run, ms); held = run; return 0; };
 try {
  await body(async () => { const run = held!; held = null; run(); await settle(); });
 } finally { win.setTimeout = real; }
}

test("the Inbox whose newest page failed after an expired cursor reads its newest page again, then clears the error", async () => {
 const session = { session_id: "s-expired-failed" };
 await openPage("chat", topicPage(), topicPage({ ...session, entries: [reply("old", "Projected before the update")] }));
 page.closeInteraction();
 const reads: unknown[] = [];
 let down = true;
 await withHeldPoll(async poll => {
  await openPage("chat", topicPage(), (_token: unknown, after: unknown) => {
   reads.push(after);
   if (after) throw new Error(EXPIRED);
   if (down) throw new Error("herdr: unavailable: herdr is restarting");
   return topicPage({ ...session, after: "a2", entries: [reply("n1", "The newest page")] });
  });
  expect(reads).toEqual(["a1", ""]);
  expect(statusText()).toStartWith("Chat: herdr: unavailable");
  down = false;
  await poll();
 });
 expect(reads).toEqual(["a1", "", ""]);
 expect(startedOver(inboxTranscript())).toEqual([true, false, false]);
 expect(statusText()).toBe("");
});

test("a topic whose newest page failed after an expired cursor reads its newest page again", async () => {
 const { transcript, token } = await openTopic(topicPage({ entries: [reply("old", "Projected before the update")] }));
 const reads: unknown[] = [];
 let down = true;
 answers["Desk.TopicTranscript"] = (_token: unknown, _topic: unknown, after: unknown) => {
  reads.push(after);
  if (after) throw new Error(EXPIRED);
  if (down) throw new Error("herdr: unavailable: herdr is restarting");
  return topicPage({ after: "a2", entries: [reply("n1", "The newest page")] });
 };
 const changed = () => emit("topics:changed", { token, topics: [{ topic_id: TOPIC.topicID, title: TOPIC.title, state: "idle", turns: 0, queued: 0, created_unix_ms: 1, last_activity_unix_ms: 1 }],
  offered: true, loaded: true, changed: TOPIC.topicID, suggestions: [], suggestionsServed: false, requestedMs: Date.now() });
 changed();
 await settle();
 expect(reads).toEqual(["a1", ""]);
 down = false;
 changed();
 await settle();
 expect(reads).toEqual(["a1", "", ""]);
 expect(startedOver(transcript)).toEqual([true, false, false]);
});

test("a poll Refresh took over reads nothing more when herdr expires its cursor", async () => {
 const session = { session_id: "s-superseded" };
 await openPage("chat", topicPage(), topicPage({ ...session, entries: [reply("old", "Projected before the update")] }));
 page.closeInteraction();
 const reads: unknown[] = [];
 const waiting = Promise.withResolvers<string>();
 await openPage("chat", topicPage(), (_token: unknown, after: unknown) => {
  reads.push(after);
  return after ? waiting.promise : topicPage({ ...session, after: "a2", entries: [reply("n1", "The newest page")] });
 });
 refreshButton().click();
 await settle();
 expect(reads).toEqual(["a1", ""]);
 waiting.reject(new Error(EXPIRED));
 await settle();
 expect(reads).toEqual(["a1", ""]);
 expect(startedOver(inboxTranscript())).toEqual([true, false, false]);
});

test("an older page whose cursor herdr expired stops paging; the topic starts over from its newest page", async () => {
 const { chat, transcript } = await openTopic(topicPage({ before: "b1", entries: [reply("old", "Projected before the update")] }));
 const reads: string[] = [];
 answers["Desk.TopicTranscript"] = (_token: unknown, _topic: unknown, after: unknown, before: unknown) => {
  reads.push(`${after}|${before}`);
  if (before) throw new Error(EXPIRED);
  return topicPage({ after: "a2", entries: [reply("n1", "The newest page")] });
 };
 withClass(chat, "chat-earlier")[0]!.click();
 await settle();
 expect(reads).toEqual(["|b1", "|"]);
 expect(startedOver(transcript)).toEqual([true, false, false]);
 expect(withClass(chat, "chat-earlier")[0]!.hidden).toBe(true);
});

// #560 review P3: after the older cursor expired, a newest page that failed leaves no cursor the
// topic can page with: Earlier messages is hidden however the topic draws, and its action (a
// click that reaches it anyway) reads nothing.
test("a topic whose newest page failed after an older cursor expired offers no Earlier messages", async () => {
 const { chat, token } = await openTopic(topicPage({ before: "b1", entries: [reply("old", "Projected before the update")] }));
 const reads: string[] = [];
 let pending = false;
 answers["Desk.TopicTranscript"] = (_token: unknown, _topic: unknown, after: unknown, before: unknown) => {
  reads.push(`${after}|${before}`);
  if (pending) return new Promise(() => {});
  throw new Error(before ? EXPIRED : "herdr: unavailable: herdr is restarting");
 };
 const earlier = withClass(chat, "chat-earlier")[0]!;
 earlier.click();
 await settle();
 expect([reads, earlier.hidden]).toEqual([["|b1", "|"], true]);
 earlier.dispatchEvent(new Event("click"));
 await settle();
 expect(reads).toEqual(["|b1", "|"]);
 // The topic's state changes (it draws again) while its next newest-page read waits.
 pending = true;
 emit("topics:changed", { token, topics: [{ topic_id: TOPIC.topicID, title: TOPIC.title, state: "working", turns: 0, queued: 0, created_unix_ms: 1, last_activity_unix_ms: 1 }],
  offered: true, loaded: true, changed: TOPIC.topicID, suggestions: [], suggestionsServed: false, requestedMs: Date.now() });
 await settle();
 expect([reads, earlier.hidden]).toEqual([["|b1", "|", "|"], true]);
});

test("an older Inbox page whose cursor herdr expired stops paging; the Inbox starts over from its newest page", async () => {
 const session = { session_id: "s-older" };
 const reads: string[] = [];
 let expired = false;
 await openPage("chat", topicPage(), (_token: unknown, after: unknown, before: unknown) => {
  reads.push(`${after}|${before}`);
  if (before) { expired = true; throw new Error(EXPIRED); }
  return expired ? topicPage({ ...session, after: "a2", entries: [reply("n1", "The newest page")] }) : topicPage({ ...session, before: "b1", entries: [reply("old", "Projected before the update")] });
 });
 // Rows that don't fill the view leave the top in view as the chat lands: it asks for the older
 // page at once (checkTop), whose cursor herdr expired.
 expect(reads.slice(-2)).toEqual(["|b1", "|"]);
 expect(startedOver(inboxTranscript())).toEqual([true, false, false]);
});

// #555: herdr may leave relay_entries off a fallback page and set it on a later page of the same
// session, or the other way. The chat whose handovers change representation starts over from its
// newest page (readLive(null), as for an expired cursor), the Inbox's and a topic's, both ways.
function handover(relays: boolean, direction: "to_topic" | "to_inbox") {
 const from = direction === "to_topic" ? "Inbox" : TOPIC.title;
 return relays
  ? relay("u1", from, direction, "Draft the intro.", direction === "to_inbox" ? TOPIC.topicID : undefined)
  : { kind: "user", id: "u1", ts_ms: Date.now() - 1000, text: `<irc>\nAsked by ${from} (\`Main\`):\n\nDraft the intro.` };
}
function handoverPage(relays: boolean, direction: "to_topic" | "to_inbox", over: Record<string, unknown> = {}) {
 return topicPage({ entries: [handover(relays, direction), { kind: "reply", id: "r1", ts_ms: Date.now() - 500, text: "On it." }], ...(relays ? { relay_entries: true } : {}), ...over });
}
for (const [name, first, then] of [["plain to relay", false, true], ["relay to plain", true, false]] as const) {
 const shown = (node: FakeElement) => [withClass(node, "relay").length, withClass(node, "user").length];
 test(`a topic whose handovers change ${name} starts over from its newest page`, async () => {
  const { transcript, token } = await openTopic(handoverPage(first, "to_topic"));
  expect(shown(transcript)).toEqual(first ? [1, 0] : [0, 1]);
  const reads: unknown[] = [];
  answers["Desk.TopicTranscript"] = (_token: unknown, _topic: unknown, after: unknown) => {
   reads.push(after);
   return after ? topicPage({ resent: [], ...(then ? { relay_entries: true } : {}) }) : handoverPage(then, "to_topic");
  };
  emit("topics:changed", { token, topics: [{ topic_id: TOPIC.topicID, title: TOPIC.title, state: "idle", turns: 0, queued: 0, created_unix_ms: 1, last_activity_unix_ms: 1 }],
   offered: true, loaded: true, changed: TOPIC.topicID, suggestions: [], suggestionsServed: false, requestedMs: Date.now() });
  await settle();
  expect(reads).toEqual(["a1", ""]);
  expect(shown(transcript)).toEqual(then ? [1, 0] : [0, 1]);
 });

 test(`the Inbox whose handovers change ${name} starts over from its newest page`, async () => {
  // A session of its own: the Inbox remembers the agent's chat across openings.
  const session = { session_id: `s555-${name}` };
  await openPage("chat", topicPage(), handoverPage(first, "to_inbox", session));
  expect(shown(inboxTranscript())).toEqual(first ? [1, 0] : [0, 1]);
  page.closeInteraction();
  // Reopened, the Inbox reads on from the chat it remembers (its after cursor).
  const reads: unknown[] = [];
  await openPage("chat", topicPage(), (_token: unknown, after: unknown) => {
   reads.push(after);
   return after ? topicPage({ ...session, resent: [], ...(then ? { relay_entries: true } : {}) }) : handoverPage(then, "to_inbox", session);
  });
  expect(reads).toEqual(["a1", ""]);
  expect(shown(inboxTranscript())).toEqual(then ? [1, 0] : [0, 1]);
 });
}

// #566: a poll whose handovers changed representation starts the Inbox over from its newest page,
// as Refresh and an expired cursor do: the question still pending in the same session keeps its
// unsent answer, and a newest page that failed leaves the next poll starting over too, never
// resending the after cursor, its error gone once a page lands.
test("the Inbox whose handovers changed representation keeps an unsent answer to the question still pending", async () => {
 const session = { session_id: "s566", after: "a2", pending_ask: ASK };
 const reads: unknown[] = [];
 await withHeldPoll(async poll => {
  await openPage("chat", topicPage(), handoverPage(false, "to_inbox", session), { askForm: true });
  answerAsk("Ledger");
  answers["Desk.ChatTranscript"] = (_token: unknown, after: unknown) => {
   reads.push(after);
   return after ? topicPage({ ...session, resent: [], relay_entries: true }) : handoverPage(true, "to_inbox", session);
  };
  await poll();
 });
 expect(reads).toEqual(["a2", ""]);
 expect(withClass(inboxTranscript(), "relay").length).toBe(1);
 expect(reviewed()).toBe("Ledger");
});

test("the Inbox whose newest page failed after its handovers changed reads its newest page again, then clears the error", async () => {
 const session = { session_id: "s566-failed" };
 const reads: unknown[] = [];
 let down = true;
 await withHeldPoll(async poll => {
  await openPage("chat", topicPage(), handoverPage(false, "to_inbox", session));
  answers["Desk.ChatTranscript"] = (_token: unknown, after: unknown) => {
   reads.push(after);
   if (after) return topicPage({ ...session, resent: [], relay_entries: true });
   if (down) throw new Error("herdr: unavailable: herdr is restarting");
   return handoverPage(true, "to_inbox", session);
  };
  await poll();
  expect(reads).toEqual(["a1", ""]);
  expect(statusText()).toStartWith("Chat: herdr: unavailable");
  down = false;
  await poll();
 });
 expect(reads).toEqual(["a1", "", ""]);
 expect(withClass(inboxTranscript(), "relay").length).toBe(1);
 expect(statusText()).toBe("");
});

// #555: an older page in the other representation than the topic's newest page is not merged
// above it; the topic starts over from its newest page.
test("a topic's older page that shows handovers otherwise is not merged", async () => {
 const newest = topicPage({ before: "b1", relay_entries: true, entries: [relay("u2", "Inbox", "to_topic", "Now this.")] });
 const { chat, transcript } = await openTopic(newest);
 const reads: string[] = [];
 answers["Desk.TopicTranscript"] = (_token: unknown, _topic: unknown, after: unknown, before: unknown) => {
  reads.push(`${after}|${before}`);
  return before ? topicPage({ entries: [handover(false, "to_topic")] }) : newest;
 };
 withClass(chat, "chat-earlier")[0]!.click();
 await settle();
 expect(reads).toEqual(["|b1", "|"]);
 expect([withClass(transcript, "relay").length, withClass(transcript, "user").length]).toEqual([1, 0]);
});

// #531: a saved desktop terminal's view (Desk.OpenTerminalView) carried topicSessions null, and the
// page threw on its length before the terminal mounted.
test("a saved terminal opens though its view carries no topic sessions", async () => {
 answers = {
  "Desk.OpenTerminalView": (_target: unknown, token: unknown) => ({ token, paneID: "p9", name: "Build logs", heading: "Build logs", group: "terminal", status: "Terminal", guest: false, guestGram: false, plainTerminal: true, askForm: false, topicSessions: null }),
  "Desk.PaneMuted": () => false,
 };
 await page.selectInteraction(target, undefined, true);
 await settle();
 expect(doc.body.text()).not.toContain("topicSessions");
 // The terminal's surface went up: its key bar is drawn (the fake DOM can't run xterm itself).
 expect(withClass(doc.body, "terminal-key-scroll").length).toBe(1);
});

/** Two topics listed for the open page: Board pack (t1) and Beta (t2), both idle; Organise shows
 *  where `served` (the agent serves suggestions); `proposals` titles one proposal each. */
function twoTopics(token: string, served = false, proposals: string[] = []) {
 const ms = Date.now() - 60_000;
 const info = (topic_id: string, title: string) => ({ topic_id, title, state: "idle", turns: 1, queued: 0, created_unix_ms: ms, last_activity_unix_ms: ms });
 const suggestions = proposals.map((title, i) => ({ suggestion_id: `s${i + 1}`, title, reason: "", message_ids: ["m1"], created_unix_ms: ms }));
 emit("topics:changed", { token, topics: [info("t1", TOPIC.title), info("t2", "Beta")], offered: true, loaded: true, suggestions, suggestionsServed: served || proposals.length > 0, requestedMs: Date.now() });
}
/** Opens a topic from the list; the narrow page brings the list back first (the header's Topics). */
async function openRow(title: string) {
 doc.body.all().find(n => n.tagName === "button" && n.className.includes("topic-list-open"))?.click();
 await settle();
 doc.body.all().find(n => n.tagName === "button" && n.className.includes("topic-row") && n.text().includes(title))!.click();
 await settle();
}
const type = (input: FakeElement, text: string) => { input.value = text; input.dispatchEvent(new Event("input")); };

// #532: with Board pack's send (a file and its caption) out, the owner opens Beta and types the same
// caption. The send's reply clears the caption from Board pack's draft, not Beta's, and its receipt
// is Board pack's, not shown under Beta.
test("a send with a file settles against the topic it was sent to, not the one on screen", async () => {
 const { input, token } = await openTopic();
 twoTopics(token);
 await settle();
 emit("pane:attachments", { token, files: [file("deck.pdf")], note: "" });
 type(input!, "Same caption");
 let reply: (value: unknown) => void = () => {};
 answers["Desk.TopicsSend"] = () => new Promise(resolve => { reply = resolve; });
 input!.dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter" }));
 await settle();
 expect(calls.filter(c => c.method === "Desk.TopicsSend").map(c => c.args.slice(1))).toEqual([["t1", "Same caption"]]);
 await openRow("Beta");
 const beta = doc.body.all().find(n => n.className === "topic-chat")!;
 expect(beta.text()).toContain("Beta");
 type(input!, "Same caption");
 reply({ mode: "queued", delivery: "sent" });
 await settle();
 expect(input!.value).toBe("Same caption");
 expect(beta.text()).not.toContain("Queued");
 // Board pack's draft lost the caption that went out.
 await openRow(TOPIC.title);
 expect(input!.value).toBe("");
});

/** Board pack's send with a file and its caption, out and unanswered. `reopen` opens Beta and then
 *  Board pack again, then herdr's reply (answer) comes; it returns the reopened topic's composer
 *  note. Whatever runs between the two steps happens while the send is out. */
async function startSend() {
 const { input, token } = await openTopic();
 twoTopics(token);
 await settle();
 emit("pane:attachments", { token, files: [file("deck.pdf")], note: "" });
 type(input!, "Same caption");
 const reply = Promise.withResolvers<unknown>();
 answers["Desk.TopicsSend"] = () => reply.promise;
 input!.dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter" }));
 await settle();
 const reopen = async (answer: unknown) => {
  await openRow("Beta");
  await openRow(TOPIC.title);
  reply.resolve(answer);
  await settle();
  return () => chatNote("topic-send-note");
 };
 return { input: input!, token, reopen };
}

/** The open conversation's line of that exact class: "topic-send-note" (the composer's) or
 *  "topic-send-note topic-action-note" (Close or Reopen's). */
function chatNote(className: string) {
 return doc.body.all().find(n => n.className === "topic-chat")!.all().find(n => n.className === className)!;
}

/** Close or Reopen (item) of Board pack, from the open topic's ••• menu (chat) or its row's menu in
 *  the list (row); herdr answers when `answer` settles. */
async function askLifecycle(item: "Close" | "Reopen", answer: Promise<void>, from: "chat" | "row" = "chat") {
 answers["Desk.GramMenu"] = () => true;
 answers[`Desk.Topics${item}`] = () => answer;
 if (from === "chat") doc.body.all().find(n => n.tagName === "button" && n.className === "topic-actions")!.click();
 else {
  // The narrow page brings the list back first (the header's Topics).
  doc.body.all().find(n => n.tagName === "button" && n.className.includes("topic-list-open"))?.click();
  await settle();
  const row = doc.body.all().find(n => n.tagName === "button" && n.className.includes("topic-row") && n.text().includes(TOPIC.title))!;
  row.dispatchEvent(new Event("contextmenu"));
 }
 await settle();
 const menu = calls.filter(c => c.method === "Desk.GramMenu").at(-1)!;
 expect(menu.args[1]).toEqual(from === "chat" ? [item] : ["Rename…", item]);
 emit("gram:menu", { id: menu.args[0], item });
 await settle();
 expect(calls.filter(c => c.method === `Desk.Topics${item}`).at(-1)?.args[1]).toBe(TOPIC.topicID);
}

// #539 review (P2): a send that settled after its topic was left and opened again wrote its notice
// into the conversation it was sent from, gone by then. The pane keeps each topic's latest notice:
// the reopened topic shows it, Beta doesn't, and it is still there when the topic opens again.
test("a refused send's reason shows in its topic opened again before the reply, the caption kept", async () => {
 const { input, reopen } = await startSend();
 const note = await reopen({ delivery: "refused", problem: "The agent is busy with another topic." });
 expect([note().hidden, note().text(), input.value]).toEqual([false, "The agent is busy with another topic.", "Same caption"]);
 await openRow("Beta");
 expect(note().hidden).toBe(true);
 await openRow(TOPIC.title);
 expect([note().hidden, note().text()]).toEqual([false, "The agent is busy with another topic."]);
});

test("an unconfirmed send's warning shows in its topic opened again before the reply, the caption gone", async () => {
 const { input, reopen } = await startSend();
 const note = await reopen({ delivery: "unconfirmed" });
 expect([note().hidden, note().text(), input.value]).toEqual([false, "Couldn't confirm delivery. Check the topic before sending again.", ""]);
});

// #539 post-merge review (P3): a Close asked in Board pack whose answer came after the topic was
// left and opened again, and after the send's warning showed there, cleared that warning. Close and
// Reopen answer on their own line, which never clears a send's notice.
test("a Close answered late leaves the send's warning in the topic opened again", async () => {
 const close = Promise.withResolvers<void>();
 const { reopen } = await startSend();
 await askLifecycle("Close", close.promise);
 const note = await reopen({ delivery: "unconfirmed" });
 const warning = "Couldn't confirm delivery. Check the topic before sending again.";
 expect([note().hidden, note().text()]).toEqual([false, warning]);
 close.resolve();
 await settle();
 expect([note().hidden, note().text(), chatNote("topic-send-note topic-action-note").hidden]).toEqual([false, warning, true]);
});

// #544 review (P3): a Close refused after its topic was left and opened again wrote the refusal
// into the conversation it was asked from, gone by then, so the topic stayed open unexplained. The
// pane keeps Close and Reopen's answer by topic, in a slot of its own beside the send's notice.
test("a Close refused after the topic opened again shows its reason there, the send's warning kept", async () => {
 const close = Promise.withResolvers<void>();
 const { reopen } = await startSend();
 await askLifecycle("Close", close.promise);
 const note = await reopen({ delivery: "unconfirmed" });
 close.reject(new Error("The topic has a turn running."));
 await settle();
 const action = chatNote("topic-send-note topic-action-note");
 expect([action.hidden, action.text(), note().hidden, note().text()])
  .toEqual([false, "The topic has a turn running.", false, "Couldn't confirm delivery. Check the topic before sending again."]);
 await openRow("Beta");
 expect(chatNote("topic-send-note topic-action-note").hidden).toBe(true);
 await openRow(TOPIC.title);
 expect(chatNote("topic-send-note topic-action-note").text()).toBe("The topic has a turn running.");
 // A Close that goes through clears its refusal and nothing else.
 await askLifecycle("Close", Promise.resolve());
 expect([chatNote("topic-send-note topic-action-note").hidden, note().hidden, note().text()])
  .toEqual([true, false, "Couldn't confirm delivery. Check the topic before sending again."]);
});

// #546 review (P3): an older Close's refusal that came back after a newer Close went through wrote
// itself under the closed topic. The newest Close or Reopen per topic owns the topic's notice.
test("an older Close refused after a newer one went through writes nothing", async () => {
 const { token } = await openTopic();
 twoTopics(token);
 await settle();
 const first = Promise.withResolvers<void>();
 await askLifecycle("Close", first.promise);
 await openRow("Beta");
 await openRow(TOPIC.title);
 await askLifecycle("Close", Promise.resolve());
 first.reject(new Error("The topic has a turn running."));
 await settle();
 expect(chatNote("topic-send-note topic-action-note").hidden).toBe(true);
});

// #546 review (P3): a Reopen that went through from the topic's row menu left the conversation's
// older refusal on screen. Both menus go through one Close/Reopen per topic: either one's success
// clears the topic's lifecycle notice, and the send's warning stays.
test("a Reopen from the row menu clears the conversation's refusal, the send's warning kept", async () => {
 const { token, reopen } = await startSend();
 const note = await reopen({ delivery: "unconfirmed" });
 listed(token, "closed", false);
 await settle();
 const refused = Promise.withResolvers<void>();
 await askLifecycle("Reopen", refused.promise);
 refused.reject(new Error("herdr couldn't reopen the topic."));
 await settle();
 expect(chatNote("topic-send-note topic-action-note").text()).toBe("herdr couldn't reopen the topic.");
 await askLifecycle("Reopen", Promise.resolve(), "row");
 await openRow(TOPIC.title);
 expect([chatNote("topic-send-note topic-action-note").hidden, note().hidden, note().text()])
  .toEqual([true, false, "Couldn't confirm delivery. Check the topic before sending again."]);
});

/** The notice over the topic list (TopicsPane.drawNotice). */
const listNotice = () => doc.body.all().find(n => n.className === "topics-problem")!;

// #549 review (P3): Shift+F10 → Close on a focused row redrew the whole list while the Close was
// out, so the row lost the keyboard focus. Only the notice over the list changes.
test("a Close from a focused row's keyboard menu keeps the row and its focus", async () => {
 const { token } = await openTopic();
 twoTopics(token);
 await settle();
 doc.body.all().find(n => n.tagName === "button" && n.className.includes("topic-list-open"))?.click();
 await settle();
 const row = doc.body.all().find(n => n.tagName === "button" && n.className.includes("topic-row") && n.text().includes(TOPIC.title))!;
 row.focus();
 const close = Promise.withResolvers<void>();
 answers["Desk.GramMenu"] = () => true;
 answers["Desk.TopicsClose"] = () => close.promise;
 row.dispatchEvent(Object.assign(new Event("keydown"), { key: "F10", shiftKey: true }));
 await settle();
 const menu = calls.filter(c => c.method === "Desk.GramMenu").at(-1)!;
 expect(menu.args[1]).toEqual(["Rename…", "Close"]);
 emit("gram:menu", { id: menu.args[0], item: "Close" });
 await settle();
 expect(calls.filter(c => c.method === "Desk.TopicsClose").map(c => c.args[1])).toEqual([TOPIC.topicID]);
 expect([row.isConnected, doc.activeElement === row]).toEqual([true, true]);
 close.reject(new Error("The topic has a turn running."));
 await settle();
 expect([row.isConnected, doc.activeElement === row, listNotice().hidden, listNotice().text()]).toEqual([true, true, false, "The topic has a turn running."]);
});

// #549 review (P3): after a row's Close was refused, Organise that went through still showed the
// refusal over the list instead of when Organise starts. The newest list action owns the list's
// notice; the refusal stays in the topic's conversation.
test("Organise replaces a row's Close refusal over the list; the topic still shows it", async () => {
 const { token } = await openTopic();
 twoTopics(token, true);
 await settle();
 const close = Promise.withResolvers<void>();
 await askLifecycle("Close", close.promise, "row");
 close.reject(new Error("The topic has a turn running."));
 await settle();
 expect(listNotice().text()).toBe("The topic has a turn running.");
 answers["Desk.TopicsOrganise"] = () => true;
 doc.body.all().find(n => n.tagName === "button" && n.className.includes("topics-organise"))!.click();
 await settle();
 expect([listNotice().hidden, listNotice().text()]).toEqual([false, "Organise starts when the agent's current turn ends."]);
 await openRow(TOPIC.title);
 expect(chatNote("topic-send-note topic-action-note").text()).toBe("The topic has a turn running.");
});

/** Board pack open on a wide page, the list beside it; `proposals` as twoTopics'. */
async function wideTopic(proposals: string[] = []) {
 const { token } = await openTopic();
 twoTopics(token, false, proposals);
 await settle();
 const surface = doc.body.all().find(n => n.className === "topics-surface")!;
 surface.clientWidth = 1200; resized(surface);
 await settle();
}

/** Chooses item in Board pack's row menu in the list. */
async function fromRow(item: string) {
 answers["Desk.GramMenu"] = () => true;
 doc.body.all().find(n => n.tagName === "button" && n.className.includes("topic-row") && n.text().includes(TOPIC.title))!.dispatchEvent(new Event("contextmenu"));
 await settle();
 const menu = calls.filter(c => c.method === "Desk.GramMenu").at(-1)!;
 expect(menu.args[1]).toContain(item);
 emit("gram:menu", { id: menu.args[0], item });
 await settle();
}

// #550 review (P3): a list action's answer wrote the notice over the list whatever came after it:
// a Rename that went through late erased a newer Close's refusal. Each list action owns the notice
// from its start; an older one's answer leaves it alone.
test("a Rename that goes through late leaves a newer Close refusal over the list", async () => {
 await wideTopic();
 const renamed = Promise.withResolvers<void>();
 answers["Desk.TopicsRename"] = () => renamed.promise;
 await fromRow("Rename…");
 const sheet = doc.body.all().find(n => n.className.includes("topics-rename"))!;
 sheet.all().find(n => n.tagName === "input")!.value = "Board pack 2";
 sheet.all().find(n => n.tagName === "button" && n.className === "topics-sheet-start")!.click();
 await settle();
 expect(calls.filter(c => c.method === "Desk.TopicsRename").map(c => c.args[2])).toEqual(["Board pack 2"]);
 const close = Promise.withResolvers<void>();
 answers["Desk.TopicsClose"] = () => close.promise;
 await fromRow("Close");
 close.reject(new Error("The topic has a turn running."));
 await settle();
 expect(listNotice().text()).toBe("The topic has a turn running.");
 renamed.resolve();
 await settle();
 expect([listNotice().hidden, listNotice().text()]).toEqual([false, "The topic has a turn running."]);
});

test("Not now that goes through while a row's Close is out leaves that Close's later refusal shown", async () => {
 await wideTopic(["Pricing"]);
 const settled = Promise.withResolvers<string>();
 answers["Desk.TopicsSettleSuggestions"] = () => settled.promise;
 doc.body.all().find(n => n.tagName === "button" && n.text() === "Not now")!.click();
 await settle();
 expect(calls.filter(c => c.method === "Desk.TopicsSettleSuggestions").map(c => c.args.slice(1))).toEqual([[[], ["s1"]]]);
 const close = Promise.withResolvers<void>();
 answers["Desk.TopicsClose"] = () => close.promise;
 await fromRow("Close");
 settled.resolve("");
 await settle();
 close.reject(new Error("The topic has a turn running."));
 await settle();
 expect([listNotice().hidden, listNotice().text()]).toEqual([false, "The topic has a turn running."]);
});

// #550 review (P3): opening the row of the topic already open (wide) cleared the list's notice but
// drew nothing, so the old notice stayed. The notice is drawn as it is cleared; the topic's own
// lifecycle note stays in its conversation.
test("opening the open topic's row clears the notice over the list, not the conversation's", async () => {
 await wideTopic();
 const close = Promise.withResolvers<void>();
 answers["Desk.TopicsClose"] = () => close.promise;
 await fromRow("Close");
 close.reject(new Error("The topic has a turn running."));
 await settle();
 expect(listNotice().text()).toBe("The topic has a turn running.");
 doc.body.all().find(n => n.tagName === "button" && n.className.includes("topic-row") && n.text().includes(TOPIC.title))!.click();
 await settle();
 const action = chatNote("topic-send-note topic-action-note");
 expect([listNotice().hidden, action.hidden, action.text()]).toEqual([true, false, "The topic has a turn running."]);
});

// #539 review (P3): a kept row's day header was matched on the prompt's time alone, so after
// midnight yesterday's prompt still said Today. The header is matched on the label it reads now.
test("a topic's day header says Yesterday once midnight passed, when the topic reads again", async () => {
 const evening = new Date(2026, 10, 25, 23, 0).getTime();
 setSystemTime(new Date(evening));
 try {
  const prompt = { kind: "user", id: "u1", ts_ms: evening - 30 * 60_000, text: "Draft the intro." };
  const { transcript, token } = await openTopic(topicPage({ entries: [prompt] }));
  const day = () => withClass(transcript, "chat-day").map(n => n.text());
  expect(day()).toHaveLength(1);
  expect(day()[0]).toStartWith("Today");
  setSystemTime(new Date(evening + 90 * 60_000));
  emit("topics:changed", { token, topics: [{ topic_id: TOPIC.topicID, title: TOPIC.title, state: "idle", turns: 0, queued: 0, created_unix_ms: 1, last_activity_unix_ms: 1 }],
   offered: true, loaded: true, changed: TOPIC.topicID, suggestions: [], suggestionsServed: false, requestedMs: Date.now() });
  await settle();
  expect(day()).toHaveLength(1);
  expect(day()[0]).toStartWith("Yesterday");
 } finally { setSystemTime(); }
});

// The Inbox keeps its rows the same way (drawChat): its day header moves on at midnight too.
test("the Inbox's day header says Yesterday once midnight passed, when the Inbox draws again", async () => {
 const evening = new Date(2026, 10, 25, 23, 0).getTime();
 setSystemTime(new Date(evening));
 try {
  const prompt = { kind: "user", id: "u1", ts_ms: evening - 30 * 60_000, text: "Draft the intro." };
  await openPage("chat", topicPage(), topicPage({ entries: [prompt] }));
  const day = () => withClass(inboxTranscript(), "chat-day").map(n => n.text());
  expect(day()).toHaveLength(1);
  expect(day()[0]).toStartWith("Today");
  setSystemTime(new Date(evening + 90 * 60_000));
  const token = String(calls.find(c => c.method === "Desk.OpenAgentView")!.args[1]);
  twoTopics(token);
  await settle();
  expect(day()).toHaveLength(1);
  expect(day()[0]).toStartWith("Yesterday");
 } finally { setSystemTime(); }
});

/** A topics:changed for the open page: herdr's list of one topic, Board pack, in state. */
function listed(token: string, state: string, stale: boolean) {
 const ms = Date.now() - 60_000;
 emit("topics:changed", { token, topics: [{ topic_id: TOPIC.topicID, title: TOPIC.title, state, turns: 0, queued: 0, created_unix_ms: ms, last_activity_unix_ms: ms }],
  offered: true, loaded: true, stale, suggestions: [], suggestionsServed: false, requestedMs: Date.now() });
}

/** Starts dictation from the composer's mic; returns its token (Dictation.Start's). */
async function dictate(slot: FakeElement): Promise<string> {
 // Answered: the page's dictation queue waits on each call (one capture at a time).
 answers["Dictation.Start"] = () => undefined; answers["Dictation.Stop"] = () => undefined;
 slot.all().find(n => n.tagName === "button" && n.className.includes("composer-microphone"))!.click();
 await settle();
 const start = calls.filter(c => c.method === "Dictation.Start").at(-1);
 if (!start) throw new Error("dictation didn't start");
 return String(start.args[0]);
}

// #533: dictation started in Board pack kept writing after the composer moved to Beta: its next
// result replaced Beta's draft. Changing drafts stops the capture.
test("dictation stops when the composer moves to another topic; a late result writes nowhere", async () => {
 const { slot, input, token } = await openTopic();
 twoTopics(token);
 await settle();
 const dictation = await dictate(slot);
 emit("dictation:changed", { token: dictation, state: "recording", text: "Alpha words" });
 await settle();
 expect(input!.value).toBe("Alpha words");
 await openRow("Beta");
 expect(calls.filter(c => c.method === "Dictation.Stop").map(c => c.args[0])).toEqual([dictation]);
 expect(input!.disabled).toBe(false);
 type(input!, "Beta draft");
 emit("dictation:changed", { token: dictation, state: "recording", text: "Alpha words and more" });
 await settle();
 expect(input!.value).toBe("Beta draft");
});

// #533: the field's disabled state is the topic's and dictation's together: stopping dictation in
// a topic that closed meanwhile leaves its field disabled.
test("stopping dictation keeps a closed topic's field disabled", async () => {
 const { slot, input, token } = await openTopic();
 await dictate(slot);
 expect(input!.disabled).toBe(true);
 listed(token, "closed", false);
 await settle();
 slot.all().find(n => n.tagName === "button" && n.className.includes("composer-microphone"))!.click();
 await settle();
 expect(input!.disabled).toBe(true);
});

test("a topic herdr read from the session file (state unknown) claims neither Idle nor Working, in its row or its header", async () => {
 await openPage("topics", topicPage());
 const token = String(calls.find(c => c.method === "Desk.OpenAgentView")!.args[1]);
 const statuses = () => withClass(doc.body, "topic-status").map(n => n.text());
 // herdr #520: before omp first answers, the list comes from disk, stale, every state unknown.
 listed(token, "unknown", true);
 await settle();
 expect(statuses()).toEqual([]);
 // omp answered: the row says so.
 listed(token, "running", false);
 await settle();
 expect(statuses()).toEqual(["Working"]);
 // The open topic's header too (the narrow page keeps the list's rows, hidden).
 listed(token, "unknown", true);
 await settle();
 doc.body.all().find(n => n.tagName === "button" && n.text().includes(TOPIC.title))!.click();
 await settle();
 const chat = doc.body.all().find(n => n.className === "topic-chat")!;
 expect(statuses()).toEqual([]);
 expect(withClass(chat, "chat-working")).toEqual([]);
 listed(token, "running", false);
 await settle();
 expect([withClass(chat, "topic-status").map(n => n.text()), statuses().length]).toEqual([["Working"], 2]);
});

// herdr-app #559405: the chat's up arrow (Jump to my previous message) on the web. An owner's browser
// (an owner link) opens its agents as the gate's guest views; a herdr whose owner gate stamps the
// browser's prompts as the owner's (turn origin "mine", herdr-app 559688) says so in its ping, and
// only then is the view an ownerLink one (web/desk.ts openAgentView, #575). That view has the arrow
// and lands on them; an owner link to an older herdr and a guest's never show it; the desktop's is
// as before.
const ownerPrompt = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ kind: "user", id, ts_ms: Date.now() - 500, text, author: "owner", ...extra });
const GITMOOT = ownerPrompt("u0", "gitmoot: review PR 12", { origin: "other" });

/** Opens the agent's chat once, as `view` (an AgentView's fields over a desktop owner's) on a
 *  connection with `ownerScope` (an owner link's; none for a guest or the desktop), with the
 *  Inbox answering live reads from `live` (all of it for the first read, what follows later). */
async function openChat(view: Record<string, unknown>, live: { entries: unknown[] }, ownerScope?: string) {
 // A page of its own: no chat remembered from before.
 emit("state:changed", { phase: "idle" });
 stored.set("chat.ompOpensIn", "chat");
 answers = {
  "Desk.OpenAgentView": (_target: unknown, token: unknown) => ({ token, paneID: "p1", name: "herdr-app", harness: "omp", heading: "herdr-app", group: "idle", status: "idle", guest: false, guestGram: false, plainTerminal: false, askForm: false, topicSessions: [], ...view }),
  "Desk.PaneMuted": () => false,
  "Desk.TopicsAvailable": () => false,
  "Desk.GuestChatAvailable": () => true,
  "Desk.State": () => ({ phase: "connected", guest: { features: { gram: false }, ...(ownerScope ? { ownerScope } : {}) } }),
  "Desk.ChatTranscript": (_token: unknown, after: unknown) => {
   const from = after === "" ? 0 : Number(String(after).slice("live".length));
   return topicPage({ session_id: "s-live", after: `live${live.entries.length}`, entries: live.entries.slice(from) });
  },
 };
 await page.selectInteraction(target);
 await settle();
 expect(calls.filter(c => c.method === "Desk.OpenAgentView")).toHaveLength(1);
 const scroll = doc.body.all().find(n => n.className === "chat-scroll")!;
 const jump = doc.body.all().find(n => n.className === "chat-jump-previous-mine")!;
 return { scroll, jump };
}
/** Lays the chat out: each row at its top in the scroller's content (rows `tops` names), the view
 *  scrolled to the end of 3000 px of content in a 600 px window. */
function layOut(scroll: FakeElement, tops: Record<string, number>) {
 for (const [id, top] of Object.entries(tops)) {
  const row = scroll.querySelector(`[data-id="${id}"]`);
  if (!row) throw new Error(`no row ${id}`);
  row.getBoundingClientRect = () => ({ left: 0, top: top - scroll.scrollTop, right: 100, bottom: top - scroll.scrollTop + 100, width: 100, height: 100 });
 }
 scroll.scrollHeight = 3000; scroll.clientHeight = 600; scroll.scrollTop = 2400;
 (scroll as unknown as { onscroll: () => void }).onscroll();
}
const TOPS = { u0: 200, u1: 1200 };

test("an owner's browser has the up arrow, which lands on the prompt the owner sent from it", async () => {
 const live = { entries: [GITMOOT, reply("r0", "Reviewed")] };
 const { scroll, jump } = await openChat({ guest: true, ownerLink: true }, live, "chat");
 answers["Desk.ChatPrompt"] = () => { live.entries.push(ownerPrompt("u1", "Fix the build", { origin: "mine" }), reply("r1", "Fixed")); return JSON.stringify({ delivery: "submitted" }); };
 const input = doc.body.all().find(n => n.tagName === "textarea")!;
 type(input, "Fix the build");
 input.dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter" }));
 await settle();
 expect(calls.filter(c => c.method === "Desk.ChatPrompt").map(c => c.args[1])).toEqual(["Fix the build"]);
 layOut(scroll, TOPS);
 expect(jump.hidden).toBe(false);
 jump.click();
 await settle();
 expect(scroll.scrollTop).toBe(TOPS.u1 - 12);
 // gitmoot's prompt above is not the owner's: the next tap stays.
 jump.click();
 await settle();
 expect(scroll.scrollTop).toBe(TOPS.u1 - 12);
});

// An older herdr records the browser's prompts as other: the arrow would skip them (#575).
test("an owner link to a herdr without owner-browser origins has no up arrow", async () => {
 const live = { entries: [GITMOOT, ownerPrompt("u1", "Fix the build"), reply("r1", "Fixed")] };
 const { scroll, jump } = await openChat({ guest: true }, live, "chat");
 layOut(scroll, TOPS);
 expect(jump.hidden).toBe(true);
});

test("a guest's view never has the up arrow, even with the owner's prompts above", async () => {
 const live = { entries: [GITMOOT, ownerPrompt("u1", "Fix the build"), reply("r1", "Fixed")] };
 const { scroll, jump } = await openChat({ guest: true, guestSelf: "nike", guestOwner: "Jerry" }, live);
 layOut(scroll, TOPS);
 expect(jump.hidden).toBe(true);
});

test("the desktop's arrow lands on the owner's prompts herdr marks as theirs, never on one marked other", async () => {
 const live = { entries: [GITMOOT, ownerPrompt("u1", "Fix the build"), reply("r1", "Fixed")] };
 const { scroll, jump } = await openChat({}, live);
 layOut(scroll, TOPS);
 expect(jump.hidden).toBe(false);
 jump.click();
 await settle();
 expect(scroll.scrollTop).toBe(TOPS.u1 - 12);
 jump.click();
 await settle();
 expect(scroll.scrollTop).toBe(TOPS.u1 - 12);
});
