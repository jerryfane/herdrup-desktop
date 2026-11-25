// An open topic as the agent's page draws it (interaction.ts with topicsView.ts TopicChat), on the
// shared fake document (fakeDom.ts) with Go answered here: the Inbox's rows under the topic's
// conversation, its width handles, and the Inbox's own composer lent to the topic (the grow handle,
// files pasted or dropped as chips, saved prompts and the mic); and a handover between the Inbox
// and a topic (relay) as both chats draw it.
import { afterAll, beforeAll, beforeEach, expect, mock, setSystemTime, test } from "bun:test";
import { FakeDocument, FakeElement } from "./fakeDom";
import type { AgentTarget, GramAttachment } from "../src/mygo";
import type * as Interaction from "../src/interaction";
import * as chatMarkdown from "../src/chatMarkdown";

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
  document: doc, HTMLElement: FakeElement, HTMLDetailsElement: class {}, Node: FakeElement,
  window: Object.assign(doc.defaultView, { setTimeout, clearTimeout, setInterval, clearInterval, devicePixelRatio: 1 }),
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
 *  page, inbox the Inbox's. */
async function openPage(mode: "topics" | "chat", topic: string, inbox = topicPage()) {
 stored.set("chat.ompOpensIn", mode);
 answers = {
  "Desk.OpenAgentView": (_target: unknown, token: unknown) => ({ token, paneID: "p1", name: "herdr-app", harness: "omp", heading: "herdr-app", group: "idle", status: "idle", guest: false, guestGram: false, plainTerminal: false, askForm: false, topicSessions: [TOPIC] }),
  "Desk.TopicsAvailable": () => true,
  "Desk.PaneMuted": () => false,
  "Desk.TopicTranscript": () => topic,
  "Desk.ChatTranscript": () => inbox,
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
function relay(id: string, from: string, direction: string, text: string) {
 return { kind: "relay", id, ts_ms: Date.now() - 1000, from, topic_id: "t1", direction, text };
}
/** The chat's rows: the topic's when open, else the Inbox's transcript. */
function inboxTranscript() {
 return doc.body.all().find(n => n.className.split(" ").includes("chat-transcript") && !n.className.includes("topic-transcript"))!;
}

test("a handover reads From Inbox in the topic and From topic <title> in the Inbox, left as the agent's text", async () => {
 const { transcript } = await openTopic(topicPage({ entries: [relay("r1", "Inbox", "to_topic", "Draft the **board pack** intro.")] }));
 const inTopic = withClass(transcript, "relay");
 expect(inTopic).toHaveLength(1);
 expect(inTopic[0]!.className).toBe("chat-message relay");
 expect(withClass(inTopic[0]!, "chat-relay-from").map(n => n.textContent)).toEqual(["From Inbox"]);
 expect(withClass(inTopic[0]!, "chat-markdown").map(n => n.textContent)).toEqual(["Draft the **board pack** intro."]);
 // Not the owner's bubble.
 expect(withClass(transcript, "user")).toEqual([]);

 page.closeInteraction();
 const older = { kind: "user", id: "u1", ts_ms: Date.now() - 500, text: "<irc>\nAsked by Inbox (`Main`):\n\nOld shape" };
 await openPage("chat", topicPage(), topicPage({ entries: [relay("r2", "Board pack", "to_inbox", "The intro is drafted."), older] }));
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
