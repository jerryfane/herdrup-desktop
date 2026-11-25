// An open topic as the agent's page draws it (interaction.ts with topicsView.ts TopicChat), on the
// shared fake document (fakeDom.ts) with Go answered here: the Inbox's rows under the topic's
// conversation, its width handles, and the Inbox's own composer lent to the topic (the grow handle,
// files pasted or dropped as chips, saved prompts and the mic).
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { FakeDocument, FakeElement } from "./fakeDom";
import type { AgentTarget, GramAttachment } from "../src/mygo";
import type * as Interaction from "../src/interaction";

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

/** Opens the agent's page on Topics (its saved choice) and the topic in it; transcript is the
 *  topic's page. Returns the page's parts the tests read. */
async function openTopic(transcript: string = topicPage()) {
 stored.set("chat.ompOpensIn", "topics");
 answers = {
  "Desk.OpenAgentView": (_target: unknown, token: unknown) => ({ token, paneID: "p1", name: "herdr-app", harness: "omp", heading: "herdr-app", group: "idle", status: "idle", guest: false, guestGram: false, plainTerminal: false, askForm: false, topicSessions: [TOPIC] }),
  "Desk.TopicsAvailable": () => true,
  "Desk.PaneMuted": () => false,
  "Desk.TopicTranscript": () => transcript,
  "Desk.SavedPrompts": () => [{ id: "p1", nickname: "Standup", text: "Post the daily standup" }],
  "Desk.TopicsSend": () => ({ mode: "", delivery: "sent" }),
 };
 await page.selectInteraction(target);
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
