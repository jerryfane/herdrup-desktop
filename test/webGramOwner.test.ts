// The owner's Gram on an owner link (S6): the store as herdr lists it to its owner, the agents the
// owner gate lets it write to, posts shown at once, delete, saved copies kept with their machine,
// mark read; against a scripted owner link.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import type { AgentInfo } from "../src/web/board";
import { GuestClient } from "../src/web/engine";
import { events } from "../src/web/events";
import { deleteNote, gramDesk, gramRow, guestGramDesk } from "../src/web/gram";
import { acceptAnswer, Inbox, owe, ownerAnswer, ownerInfo, type OwnerGramMessage, type Recovery, type WriteMark } from "../src/web/gramInbox";
import type { GramSnapshot } from "../src/mygo";
import { expireSaved, ownerAgents, ownerSavedCopies, withSaved } from "../src/web/gramOwner";
import { closeSettings, onLinkChanged, openSettings, settingsScope, setLink, type GuestAccess, type WebLink } from "../src/web/link";
import { SavedStore } from "../src/web/gramSaved";
import type { Locks } from "../src/web/locks";
import { currentOwnerLink, OWNER_REFUSED, OwnerRefusedError, settingsLink, type OwnerLink } from "../src/web/ownerLink";
import { createGuestDesk } from "../src/web/desk";
import { MemoryGrantStore, MemoryOwnerHint } from "../src/web/storage";
import { MemoryIdentityStore } from "../src/webguest/identity";
import { HerdrAPIError } from "../src/webguest/errors";

const row = (id: string, extra: Partial<OwnerGramMessage> = {}): OwnerGramMessage =>
 ({ id, direction: "agent_to_owner", from: "docs", text: "hi " + id, created_unix_ms: 1000, ...extra });
const list = (messages: OwnerGramMessage[], extra: Record<string, unknown> = {}) => ({ type: "gram_list", digest: "", store_id: "", has_more: false, messages, ...extra });

const roster: AgentInfo[] = [
 { pane_id: "p1", name: "docs" }, { pane_id: "p2", name: "build" }, { pane_id: "p3", name: "old", archived: { at: "x" } },
 { pane_id: "p4", name: "far/api", machine_id: "far", machine_label: "Far box", reachability: "reachable" },
];

/** Opens an owner link to machine hostID/label (features say no Gram, as herdr's owner hello does),
 *  answering through handle, published as desk.ts publishes it: the link with its owner context. */
function ownerLink(handle: (method: string, params: Record<string, unknown>) => unknown, hostID = "h", label = "dev", agents: AgentInfo[] = roster): WebLink {
 const access = {
  guestID: "grant-" + hostID, guestName: "", machineLabel: label, ownerName: "", agentName: "", agentTarget: "",
  endpoint: { relay: "wss://relay.invalid", hostID, hostPublicKey: new Uint8Array(32) }, acceptedAt: "",
 } as GuestAccess;
 const link: WebLink = {
  access,
  features: () => ({ gram: false, push: false }),
  call: async <T>(method: string, params?: unknown) => handle(method, (params ?? {}) as Record<string, unknown>) as T,
  stream: () => { throw new Error("no streams"); },
 };
 const owner: OwnerLink = {
  machine: { hostItemID: "H-" + hostID, label, relay: "", hostID, nodePub: "", grantID: "grant-" + hostID, scope: "chat", expiresUnix: 0 },
  client: new GuestClient(link), signal: new AbortController().signal, scope: () => "chat", agents: () => agents, relist: () => {},
 };
 setLink(link, owner);
 return link;
}

// Bun has no localStorage: a Map-backed one for this file, which can refuse writes as a full one does.
const store = new Map<string, string>();
let refuseWrites = false;
/** Storage reads so far (the Saved list's). */
let reads = 0;
beforeAll(() => {
 Reflect.set(globalThis, "localStorage", {
  getItem: (k: string) => { reads++; return store.get(k) ?? null; },
  setItem: (k: string, v: string) => { if (refuseWrites) throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); store.set(k, v); },
  removeItem: (k: string) => void store.delete(k),
 });
});
afterAll(() => { Reflect.deleteProperty(globalThis, "localStorage"); });

afterEach(async () => {
 await gramDesk.gramSetVisible!(false);
 setLink(null);
 store.clear();
 refuseWrites = false;
});

async function opened() {
 await gramDesk.gramSetVisible!(true);
 await gramDesk.gramRefresh!();
 return gramDesk.gramState!();
}

test("the owner's Gram is the store as herdr lists it: read marks, claims, labels, and the agents it can write to", async () => {
 const asked: Record<string, unknown>[] = [];
 ownerLink((method, params) => {
  if (method !== "gram.list") throw new Error("unexpected " + method);
  asked.push(params);
  return list([
   row("m1", { read_by_owner: true }),
   row("m2", { from: "far/api", machine_label: "Far box" }),
   row("m3", { direction: "owner_to_agent", from: "owner", grabbed_by: "build" }),
  ], { unread_count: 7 });
 });
 const s = await opened();
 expect(asked.at(-1)).toEqual({ limit: 40 });
 expect(s.messages.map(m => [m.id, m.unread, m.senderName, m.machine, m.statusVerb ?? ""])).toEqual([
  ["m1", false, "docs", "dev", ""], ["m2", true, "Far box/api", "Far box", ""], ["m3", false, "owner", "", "Grabbed"],
 ]);
 // The store's count, not the window's.
 expect(s.unreadCount).toBe(7);
 // The federated sender's message shows, but the owner gate refuses a post to it: not offered.
 expect(s.agents.map(a => a.from)).toEqual(["docs", "build"]);
 // Not a guest's Gram.
 expect((await guestGramDesk.guestGramState!()).active).toBe(false);
});

test("an owner link starts Gram once, as the owner's: its first snapshot already offers the machine's agents", async () => {
 const first: string[][] = [];
 const off = events.gramChanged.on(s => { if (s.phase !== "idle" && first.length === 0) first.push(s.agents.map(a => a.from)); });
 try { ownerLink(() => list([])); } finally { off(); }
 expect(first).toEqual([["docs", "build"]]);
});

test("an owner's post goes to the chosen agent and shows at once; mark read sends the id", async () => {
 const calls: [string, Record<string, unknown>][] = [];
 ownerLink((method, params) => {
  calls.push([method, params]);
  if (method === "gram.list") return list([row("m1")]);
  if (method === "gram.post") return { type: "gram_sent", message: row("p1", { direction: "owner_to_agent", from: "owner", to: "build", text: params.text as string }) };
  if (method === "gram.mark_read") return { type: "ok" };
  throw new Error("unexpected " + method);
 });
 await opened();
 await gramDesk.gramPost!("ship it", ["build"], []);
 expect(calls.find(c => c[0] === "gram.post")?.[1]).toEqual({ text: "ship it", to: "build" });
 const s = await gramDesk.gramState!();
 expect(s.messages[0]).toMatchObject({ id: "p1", pending: true, to: "build", statusVerb: "Delivered" });
 await gramDesk.gramMarkRead!("m1");
 expect(calls.find(c => c[0] === "gram.mark_read")?.[1]).toEqual({ id: "m1" });
 expect((await gramDesk.gramState!()).messages.find(m => m.id === "m1")?.unread).toBe(false);
});

test("a refused delete keeps the row and says why; a later one removes it, its unread mark and that note", async () => {
 let refuse = true;
 ownerLink(method => {
  if (method === "gram.list") return list([row("m1"), row("m2")], { unread_count: 6 });
  if (method === "gram.delete") {
   if (refuse) throw new HerdrAPIError("owner_forbidden", "no", null);
   return { type: "ok" };
  }
  throw new Error("unexpected " + method);
 });
 await opened();
 await expect(gramDesk.gramDelete!("m1")).rejects.toBeInstanceOf(OwnerRefusedError);
 let s = await gramDesk.gramState!();
 expect(s.status).toBe("Couldn't delete: " + OWNER_REFUSED);
 expect(s.messages.map(m => m.id)).toEqual(["m1", "m2"]);
 refuse = false;
 await gramDesk.gramDelete!("m1");
 s = await gramDesk.gramState!();
 expect([s.messages.map(m => m.id), s.unreadCount]).toEqual([["m2"], 5]);
 // The refresh's own acknowledgement may still show; the refusal may not.
 expect(s.status ?? "").not.toContain("Couldn't delete");
});

test("a failed delete's banner is its own: a send's error shows over it and goes without it; a delete that lands clears it", async () => {
 let refuse = true, postFails = true;
 ownerLink((method, params) => {
  if (method === "gram.list") return list([row("m1"), row("m2")]);
  if (method === "gram.delete") { if (refuse) throw new HerdrAPIError("owner_forbidden", "no", null); return { type: "ok" }; }
  if (method === "gram.post") {
   if (postFails) throw new HerdrAPIError("bad_request", "no such agent", null);
   return { type: "gram_sent", message: row("p1", { direction: "owner_to_agent", from: "owner", to: "build", text: params.text as string }) };
  }
  throw new Error("unexpected " + method);
 });
 await opened();
 await expect(gramDesk.gramDelete!("m1")).rejects.toBeInstanceOf(OwnerRefusedError);
 await expect(gramDesk.gramPost!("ship it", ["build"], [])).rejects.toThrow();
 const sendError = (await gramDesk.gramState!()).status ?? "";
 expect([sendError === "", sendError.includes("Couldn't delete")]).toEqual([false, false]);
 postFails = false;
 await gramDesk.gramPost!("ship it", ["build"], []);
 expect((await gramDesk.gramState!()).status).toBe("Couldn't delete: " + OWNER_REFUSED);
 refuse = false;
 await gramDesk.gramDelete!("m2");
 expect((await gramDesk.gramState!()).status ?? "").not.toContain("Couldn't delete");
});

test("the owner's saved copies are one list on this browser, kept as the sender shows", async () => {
 // A copy without its machine (no owner copy) is not shown, nor kept.
 store.set("herdrup.gram.saved", JSON.stringify([{ id: "old", text: "", from: "docs", fromAgent: true, createdUnixMs: 1 }]));
 ownerLink(method => {
  if (method === "gram.list") return list([row("m2", { from: "far/api", machine_label: "Far box", created_unix_ms: 2000 }), row("m1")]);
  throw new Error("unexpected " + method);
 });
 await opened();
 await gramDesk.gramSetSaved!("m1", true);
 await gramDesk.gramSetSaved!("m2", true);
 const s = await gramDesk.gramState!();
 expect(s.saved.map(x => [x.id, x.from])).toEqual([["h\u001fm2", "Far box/api"], ["h\u001fm1", "docs"]]);
 expect(s.messages.filter(m => m.saved).map(m => m.id)).toEqual(["m2", "m1"]);
 await gramDesk.gramSetSaved!("m2", false);
 expect((await gramDesk.gramSaved!()).map(x => x.id)).toEqual(["h\u001fm1"]);
});

test("a saved file of another machine names that machine instead of asking the open one", async () => {
 const file = { name: "notes.txt", mime: "text/plain", size: 5, sha256: "" };
 ownerLink(method => {
  if (method === "gram.list") return list([row("m1", { file })]);
  throw new Error("unexpected " + method);
 }, "hA", "dev");
 await opened();
 await gramDesk.gramSetSaved!("m1", true);
 const askedB: string[] = [];
 ownerLink(method => {
  askedB.push(method);
  if (method === "gram.list") return list([row("m1", { text: "B's own m1" })]);
  throw new Error("unexpected " + method);
 }, "hB", "mac-mini");
 const s = await opened();
 // B's message of the same id is not the saved one.
 expect(s.messages.find(m => m.id === "m1")?.saved).toBe(false);
 expect(s.saved.map(x => x.id)).toEqual(["hA\u001fm1"]);
 // The Saved row's key names dev's copy: named, never asked of mac-mini.
 await expect(gramDesk.gramSaveFile!("hA\u001fm1")).rejects.toThrow("notes.txt is on dev. Open dev to get it.");
 expect((await gramDesk.gramState!()).status).toBe("notes.txt is on dev. Open dev to get it.");
 // A bare id is mac-mini's own m1, which has no file: dev's copy sharing the id is not it.
 await expect(gramDesk.gramSaveFile!("m1")).rejects.toThrow("that message has no file");
 expect(askedB).not.toContain("gram.get_file_chunk");
});

test("an older page's count and expired files reach the badge and the saved copies", async () => {
 const file = { name: "notes.txt", mime: "text/plain", size: 5, sha256: "" };
 // Saved while its file was still there (as an earlier page listed it).
 store.set("herdrup.gram.saved", JSON.stringify([{ id: "old", text: "", from: "docs", fromAgent: true, createdUnixMs: 1, file, hostID: "h", machine: "dev" }]));
 ownerLink((method, params) => {
  if (method !== "gram.list") throw new Error("unexpected " + method);
  if (params.before_id) return list([row("old", { expired_file: file })], { unread_count: 4 });
  return list([row("new", { read_by_owner: true })], { unread_count: 1, has_more: true });
 });
 await opened();
 expect(await gramDesk.gramLoadOlder!()).toBe(true);
 const s = await gramDesk.gramState!();
 expect(s.unreadCount).toBe(4);
 expect(s.saved[0]).toMatchObject({ id: "h\u001fold", expiredFile: { name: "notes.txt" } });
 expect(s.saved[0]?.file).toBeUndefined();
});

test("same-id saved copies of two machines: a Saved row's Open and Unsave act on its own machine's copy", async () => {
 const fileA = { name: "Alpha.txt", mime: "text/plain", size: 5, sha256: "" }, fileB = { name: "Beta.txt", mime: "text/plain", size: 4, sha256: "" };
 ownerLink(method => {
  if (method === "gram.list") return list([row("m1", { file: fileA })]);
  throw new Error("unexpected " + method);
 }, "hA", "Alpha");
 await opened();
 await gramDesk.gramSetSaved!("m1", true);
 const askedB: string[] = [];
 ownerLink((method, params) => {
  askedB.push(method + (params.id ? ":" + String(params.id) : ""));
  if (method === "gram.list") return list([row("m1", { file: fileB })]);
  throw new Error("unexpected " + method);
 }, "hB", "Beta");
 await opened();
 await gramDesk.gramSetSaved!("m1", true);
 expect((await gramDesk.gramSaved!()).map(s => [s.id, s.file?.name])).toEqual([["hA\u001fm1", "Alpha.txt"], ["hB\u001fm1", "Beta.txt"]]);
 // Alpha's row, though Beta's feed holds an m1 with a file of its own: named, never asked of Beta.
 await expect(gramDesk.gramOpenFile!("hA\u001fm1")).rejects.toThrow("Alpha.txt is on Alpha. Open Alpha to get it.");
 expect(askedB.filter(c => c.startsWith("gram.get_file"))).toEqual([]);
 await gramDesk.gramSetSaved!("hA\u001fm1", false);
 expect((await gramDesk.gramSaved!()).map(s => s.id)).toEqual(["hB\u001fm1"]);
});

test("an unchanged store keeps every page held across refreshes; a changed one replaces the head", async () => {
 const head = Array.from({ length: 40 }, (_, i) => row("n" + i, { read_by_owner: true }));
 const older = Array.from({ length: 40 }, (_, i) => row("o" + i, { read_by_owner: true }));
 let digest = "d1";
 const heads: Record<string, unknown>[] = [];
 ownerLink((method, params) => {
  if (method !== "gram.list") throw new Error("unexpected " + method);
  if (params.before_id) return list(older, { digest: "", store_id: "s1" });
  heads.push(params);
  if (params.if_unchanged_digest === digest) return { type: "gram_list_unchanged", digest, store_id: "s1" };
  return list(head, { digest, store_id: "s1", has_more: true });
 });
 await opened();
 expect(await gramDesk.gramLoadOlder!()).toBe(true);
 await gramDesk.gramRefresh!();
 let s = await gramDesk.gramState!();
 expect([heads.at(-1)?.if_unchanged_digest, s.messages.length]).toEqual(["d1", 80]);
 // The store changed: the head list (limit covering what is held) replaces it, as the desktop's.
 digest = "d2";
 await gramDesk.gramRefresh!();
 s = await gramDesk.gramState!();
 expect([heads.at(-1)?.limit, s.messages.length, s.hasMore]).toEqual([80, 40, true]);
});

test("an empty older page that ends the history still brings the store's count", async () => {
 ownerLink((method, params) => {
  if (method !== "gram.list") throw new Error("unexpected " + method);
  if (params.before_id) return list([], { unread_count: 0, has_more: false });
  return list([row("n1", { read_by_owner: true })], { unread_count: 1, has_more: true });
 });
 expect((await opened()).unreadCount).toBe(1);
 expect(await gramDesk.gramLoadOlder!()).toBe(false);
 const s = await gramDesk.gramState!();
 expect([s.unreadCount, s.hasMore]).toEqual([0, false]);
});

test("a full list sent before a delete and answered after it brings back neither the row nor its unread mark", async () => {
 const asked = Promise.withResolvers<void>(), late = Promise.withResolvers<unknown>();
 let hold = false, deleted = false;
 ownerLink((method, params) => {
  if (method === "gram.delete") { deleted = true; return { type: "ok" }; }
  if (method !== "gram.list") throw new Error("unexpected " + method);
  if (hold && !params.unread_only) { hold = false; asked.resolve(); return late.promise; }
  return list(deleted ? [row("m2")] : [row("m1"), row("m2")], { unread_count: deleted ? 1 : 2, store_id: "s1" });
 });
 expect((await opened()).unreadCount).toBe(2);
 hold = true;
 const inFlight = gramDesk.gramRefresh!();
 await asked.promise;
 await gramDesk.gramDelete!("m1");
 expect((await gramDesk.gramState!()).unreadCount).toBe(1);
 // The list herdr answered before it processed the delete.
 late.resolve(list([row("m1"), row("m2")], { unread_count: 2, store_id: "s1" }));
 await inFlight;
 const s = await gramDesk.gramState!();
 expect([s.messages.map(m => m.id), s.unreadCount]).toEqual([["m2"], 1]);
});

test("a post reply that comes after a list already has the post leaves the listed row as it is", async () => {
 const reply = Promise.withResolvers<unknown>(), posted = Promise.withResolvers<void>();
 const post = row("p1", { direction: "owner_to_agent", from: "owner", to: "build", text: "ship it" });
 let listed = false;
 ownerLink((method, params) => {
  if (method === "gram.post") { posted.resolve(); return reply.promise; }
  if (method !== "gram.list") throw new Error("unexpected " + method);
  if (params.if_unchanged_digest === "d2") return { type: "gram_list_unchanged", digest: "d2", store_id: "s1" };
  return listed ? list([post, row("m1")], { digest: "d2", store_id: "s1" }) : list([row("m1")], { digest: "d1", store_id: "s1" });
 });
 await opened();
 const sending = gramDesk.gramPost!("ship it", ["build"], []);
 await posted.promise;
 listed = true;
 await gramDesk.gramRefresh!();
 reply.resolve({ type: "gram_sent", message: post });
 await sending;
 // The unchanged refresh after it keeps what the list said.
 await gramDesk.gramRefresh!();
 const s = await gramDesk.gramState!();
 expect(s.messages.filter(m => m.id === "p1").map(m => m.pending)).toEqual([false]);
});

test("a deleted row stays hidden through a late unchanged answer", async () => {
 const asked = Promise.withResolvers<void>(), late = Promise.withResolvers<unknown>();
 let held = false, deleted = false;
 ownerLink((method, params) => {
  if (method === "gram.delete") { deleted = true; return { type: "ok" }; }
  if (method !== "gram.list") throw new Error("unexpected " + method);
  if (params.if_unchanged_digest !== undefined && !held) { held = true; asked.resolve(); return late.promise; }
  return list(deleted ? [row("m2")] : [row("m1"), row("m2")], { digest: deleted ? "d2" : "d1", store_id: "s1" });
 });
 await opened();
 const inFlight = gramDesk.gramRefresh!();
 await asked.promise;
 await gramDesk.gramDelete!("m1");
 late.resolve({ type: "gram_list_unchanged", digest: "d1", store_id: "s1" });
 await inFlight;
 expect((await gramDesk.gramState!()).messages.map(m => m.id)).toEqual(["m2"]);
});

test("one publication: a link subscriber already reads the owner view of the same link", () => {
 const seen: string[] = [];
 const off = onLinkChanged((link, owner) => { seen.push(`link ${link?.access.machineLabel ?? "-"} owner ${owner?.machine.label ?? "-"} view ${currentOwnerLink()?.machine.label ?? "-"}`); });
 try {
  ownerLink(() => list([]), "hA", "Alpha");
  setLink(null);
 } finally { off(); }
 expect(seen).toEqual(["link Alpha owner Alpha view Alpha", "link - owner - view -"]);
});

test("a Settings scope belongs to the owner link it was opened on", () => {
 ownerLink(() => list([]), "hA", "Alpha");
 const alpha = currentOwnerLink();
 openSettings("t1");
 expect(settingsLink("t1")).toBe(alpha!);
 expect(() => settingsLink("t2")).toThrow("Settings changed");
 ownerLink(() => list([]), "hB", "Beta");
 expect(() => settingsLink("t1")).toThrow("Settings changed");
});

test("a Settings scope goes with its link: back on the same link, the old scope is over", () => {
 const alpha = ownerLink(() => list([]), "hA", "Alpha");
 const alphaOwner = currentOwnerLink();
 openSettings("t1");
 ownerLink(() => list([]), "hB", "Beta");
 setLink(alpha, alphaOwner);
 expect(() => settingsLink("t1")).toThrow("Settings changed");
});

test("Desk's closeSettings closes the scope its token names, and leaves another's open", async () => {
 ownerLink(() => list([]), "hA", "Alpha");
 const desk = createGuestDesk({ identities: new MemoryIdentityStore(), grants: new MemoryGrantStore(), owner: new MemoryOwnerHint() });
 openSettings("t1");
 await desk.closeSettings("t2");
 expect(settingsScope("t1").signal.aborted).toBe(false);
 await desk.closeSettings("t1");
 expect(() => settingsScope("t1")).toThrow("Settings changed");
});

test("the Settings scope: open, resolve to its link and signal, close; the signal ends with it", () => {
 ownerLink(() => list([]), "hA", "Alpha");
 const alpha = currentOwnerLink()!;
 openSettings("t1");
 const one = settingsScope("t1");
 expect([one.link, one.signal.aborted]).toEqual([alpha, false]);
 closeSettings("t2");
 expect(settingsScope("t1").link).toBe(alpha);
 openSettings("t2");
 expect([one.signal.aborted, settingsScope("t2").signal.aborted]).toEqual([true, false]);
 expect(() => settingsScope("t1")).toThrow("Settings changed");
 const two = settingsScope("t2");
 closeSettings("t2");
 expect(two.signal.aborted).toBe(true);
 expect(() => settingsScope("t2")).toThrow("Settings changed");
 openSettings("t3");
 const three = settingsScope("t3");
 // Opening the open token again keeps its scope (and the signal Accounts may hold) live.
 openSettings("t3");
 expect(three.signal.aborted).toBe(false);
 expect(settingsScope("t3").signal).toBe(three.signal);
 ownerLink(() => list([]), "hB", "Beta");
 expect(three.signal.aborted).toBe(true);
});

/** Resolves with the first published Gram snapshot (from now on) that `wanted` holds for. */
function until(wanted: (s: GramSnapshot) => boolean) {
 const got = Promise.withResolvers<void>();
 const off = events.gramChanged.on(s => { if (wanted(s)) { off(); got.resolve(); } });
 return got.promise;
}

/** A guest link (sharing Gram) whose gram calls `handle` answers. */
function guestLink(handle: (method: string, params: Record<string, unknown>) => unknown) {
 setLink({
  access: { guestID: "g1", guestName: "visitor", machineLabel: "box", ownerName: "Owner", agentName: "docs", agentTarget: "t1", endpoint: { relay: "", hostID: "h", hostPublicKey: new Uint8Array(32) }, acceptedAt: "" } as GuestAccess,
  features: () => ({ gram: true, push: false }),
  call: async <T>(method: string, params?: unknown) => await handle(method, (params ?? {}) as Record<string, unknown>) as T,
  stream: () => { throw new Error("no streams"); },
 });
}

/** A guest projection's rows (newest first), read as `read` says. */
const guestRows = (ids: string[], read: Set<string>) => ids.map(id => ({ id, direction: "agent_to_owner", from: "docs", text: "hi " + id, created_unix_ms: 1000, read: read.has(id) }));

test("guest Read all over a refresh it overlaps marks all 22 with one list more than the marks need", async () => {
 const ids = Array.from({ length: 22 }, (_, i) => `u${String(i).padStart(2, "0")}`);
 const read = new Set<string>();
 const calls: string[] = [];
 let hold = false;
 const headAsked = Promise.withResolvers<void>(), firstMark = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
 const recoveryAsked = Promise.withResolvers<void>();
 guestLink(async (method, params) => {
  if (method === "gram.mark_read") { calls.push("mark"); firstMark.resolve(); for (const id of params.ids as string[]) read.add(id); return { type: "ok" }; }
  if (method !== "gram.list") throw new Error("unexpected " + method);
  // The unread walk asks 100 at a time; the head list 40.
  calls.push(params.limit === 100 ? "walk" : "head");
  if (hold && params.limit !== 100) { hold = false; headAsked.resolve(); await release.promise; }
  else if (params.limit !== 100 && calls.includes("mark")) recoveryAsked.resolve();
  return { messages: guestRows(ids, read), has_more: false };
 });
 await opened();
 calls.length = 0;
 hold = true;
 const listing = gramDesk.gramRefresh!();
 await headAsked.promise;
 const marking = gramDesk.gramMarkAllRead!();
 await firstMark.promise;
 release.resolve();
 await listing;
 await marking;
 const allRead = until(s => s.messages.length === 22 && s.messages.every(m => !m.unread));
 await recoveryAsked.promise;
 await allRead;
 // One recovery head list once the batch settled, none between its marks.
 expect([calls.filter(c => c === "mark").length, calls.filter(c => c === "walk").length, calls.filter(c => c === "head").length, read.size]).toEqual([22, 1, 2, 22]);
 const s = await gramDesk.gramState!();
 expect([s.unreadCount, s.status ?? ""]).toEqual([0, ""]);
});

test("a hidden guest Gram's badge walk discarded for a mark is walked again, not replaced by the head window", async () => {
 // The newest 40 hold one unread Gram (n00); five older ones are unread too.
 const ids = [...Array.from({ length: 40 }, (_, i) => `n${String(i).padStart(2, "0")}`), ...Array.from({ length: 5 }, (_, i) => `o${i}`)];
 const unread = new Set(["n00", "o0", "o1", "o2", "o3", "o4"]);
 const read = new Set(ids.filter(id => !unread.has(id)));
 const calls: string[] = [];
 const markAsked = Promise.withResolvers<void>(), markRelease = Promise.withResolvers<void>(), walkAsked = Promise.withResolvers<void>();
 let holdMark = false;
 guestLink(async (method, params) => {
  if (method === "gram.mark_read") {
   if (holdMark) { holdMark = false; markAsked.resolve(); await markRelease.promise; }
   for (const id of params.ids as string[]) read.add(id);
   return { type: "ok" };
  }
  if (method !== "gram.list") throw new Error("unexpected " + method);
  const limit = Number(params.limit);
  calls.push(limit === 100 ? "walk" : "head");
  if (limit === 100) walkAsked.resolve();
  return { messages: guestRows(ids.slice(0, limit), read), has_more: ids.length > limit };
 });
 await opened();
 holdMark = true;
 const marking = gramDesk.gramMarkRead!("n00");
 await markAsked.promise;
 calls.length = 0;
 // Gram is left while the mark is out: the hidden poll's walk overlaps it.
 await gramDesk.gramSetVisible!(false);
 await walkAsked.promise;
 const five = until(s => s.unreadCount === 5);
 markRelease.resolve();
 await marking;
 await five;
 expect(calls).toEqual(["walk", "walk"]);
 expect((await guestGramDesk.guestGramState!()).grants[0]?.gram.unreadCount).toBe(5);
});

test("an older page the inbox rejects (another store since) leaves a current Saved file as it is", async () => {
 const file = { name: "notes.txt", mime: "text/plain", size: 5, sha256: "" };
 const pageAsked = Promise.withResolvers<void>(), page = Promise.withResolvers<unknown>();
 let replaced = false;
 ownerLink((method, params) => {
  if (method !== "gram.list") throw new Error("unexpected " + method);
  if (params.before_id) { pageAsked.resolve(); return page.promise; }
  return replaced ? list([row("x", { file })], { store_id: "s2" }) : list([row("m1")], { has_more: true, store_id: "s1" });
 });
 await opened();
 const older = gramDesk.gramLoadOlder!();
 await pageAsked.promise;
 replaced = true;
 await gramDesk.gramRefresh!();
 await gramDesk.gramSetSaved!("x", true);
 // The old store's page lists an x whose file it expired.
 page.resolve(list([row("x", { expired_file: file })], { store_id: "s1" }));
 expect(await older).toBe(false);
 const s = await gramDesk.gramState!();
 expect([s.messages.map(m => m.id), s.saved[0]?.file?.name, s.saved[0]?.expiredFile]).toEqual([["x"], "notes.txt", undefined]);
});

/** An owner store of `ids` (newest first, all read), its digest its rows; head lists of 40 and
 *  older pages of 40 by before_id, "unchanged" to a digest that still matches. The first older page
 *  can be held, answering the store as it was when asked. */
function pagedOwnerStore(start: string[]) {
 let ids = [...start];
 const digest = () => "d-" + ids.join(",");
 const answerAt = (rows: string[], before?: unknown) => {
  const from = before ? rows.indexOf(String(before)) + 1 : 0;
  return list(rows.slice(from, from + 40).map(id => row(id, { read_by_owner: true })), { has_more: rows.length > from + 40, unread_count: 0, digest: "d-" + rows.join(","), store_id: "s1" });
 };
 let hold = false;
 const pageAsked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
 /** The held page answers as herdr does for a cursor it no longer has, when `refuse` says so. */
 let refuse = false;
 ownerLink(async (method, params) => {
  if (method !== "gram.list") throw new Error("unexpected " + method);
  if (params.before_id && hold) {
   hold = false;
   const asked = answerAt(ids, params.before_id);
   pageAsked.resolve();
   await release.promise;
   if (refuse && !ids.includes(String(params.before_id))) throw new HerdrAPIError("invalid_params", "before_id is not in the store", null);
   return asked;
  }
  if (!params.before_id && params.if_unchanged_digest === digest()) return { type: "gram_list_unchanged", digest: digest(), store_id: "s1" };
  return answerAt(ids, params.before_id);
 });
 return { set: (next: string[]) => { ids = next; }, hold: () => { hold = true; }, refuse: () => { refuse = true; }, pageAsked, release };
}

test("an older page from another state of the store than the shown head is dropped: a deleted Gram stays gone", async () => {
 const head = Array.from({ length: 40 }, (_, i) => `h${String(i).padStart(2, "0")}`);
 const host = pagedOwnerStore([...head, "o1", "x1"]);
 await opened();
 host.hold();
 const older = gramDesk.gramLoadOlder!();
 await host.pageAsked.promise;
 // x1 is deleted: the store's digest changes, its newest 40 and unread count don't.
 host.set([...head, "o1"]);
 await gramDesk.gramRefresh!();
 host.release.resolve();
 await older;
 const ids = async () => (await gramDesk.gramState!()).messages.map(m => m.id);
 expect((await ids()).slice(40)).toEqual(["o1"]);
 await gramDesk.gramRefresh!();
 await gramDesk.gramRefresh!();
 expect((await ids()).slice(40)).toEqual(["o1"]);
});

test("an older page dropped because a head list moved the cursor is asked again from the new cursor", async () => {
 const rows = Array.from({ length: 41 }, (_, i) => `r${String(i).padStart(2, "0")}`);
 const host = pagedOwnerStore(rows);
 await opened();
 host.hold();
 const older = gramDesk.gramLoadOlder!();
 await host.pageAsked.promise;
 // A new Gram arrives: the head moves, its last row (the cursor) with it.
 host.set(["n", ...rows]);
 await gramDesk.gramRefresh!();
 host.release.resolve();
 expect(await older).toBe(true);
 expect((await gramDesk.gramState!()).messages.map(m => m.id).slice(-2)).toEqual(["r39", "r40"]);
});

test("an older page from a store that changed since the shown head gets the head listed again, then the page", async () => {
 const head = Array.from({ length: 40 }, (_, i) => `h${String(i).padStart(2, "0")}`);
 const host = pagedOwnerStore([...head, "o1", "x1"]);
 await opened();
 // x1 is deleted after the head was listed: the page comes from the newer store.
 host.set([...head, "o1"]);
 expect(await gramDesk.gramLoadOlder!()).toBe(true);
 expect((await gramDesk.gramState!()).messages.map(m => m.id).slice(40)).toEqual(["o1"]);
});

test("an unchanged refresh reads no storage", async () => {
 const host = pagedOwnerStore(["m1", "m2"]);
 host.set(["m1", "m2"]);
 await opened();
 reads = 0;
 await gramDesk.gramRefresh!();
 expect(reads).toBe(0);
});

test("another tab's Saved write reaches this tab's next snapshot; other keys keep the copy", async () => {
 const host = pagedOwnerStore(["m1", "m2"]);
 host.set(["m1", "m2"]);
 await opened();
 await gramDesk.gramSetSaved!("m1", true);
 const storageEvent = (key: string | null) => dispatchEvent(Object.assign(new Event("storage"), { key }));
 // Another tab saves m2 (and keeps m1): only this tab's copy is stale until the event.
 const copy = JSON.parse(store.get("herdrup.gram.saved")!) as { id: string }[];
 store.set("herdrup.gram.saved", JSON.stringify([...copy, { ...copy[0], id: "m2" }]));
 reads = 0;
 storageEvent("herdrup.other");
 expect([(await gramDesk.gramState!()).saved.map(s => s.id), reads]).toEqual([["h\u001fm1"], 0]);
 storageEvent("herdrup.gram.saved");
 expect((await gramDesk.gramState!()).saved.map(s => s.id).sort()).toEqual(["h\u001fm1", "h\u001fm2"]);
 // The other tab removes both.
 store.set("herdrup.gram.saved", "[]");
 storageEvent("herdrup.gram.saved");
 expect((await gramDesk.gramState!()).saved).toEqual([]);
});

test("a hidden guest Gram's recovered head list doesn't overwrite the recovered walk's badge", async () => {
 const ids = [...Array.from({ length: 40 }, (_, i) => `n${String(i).padStart(2, "0")}`), ...Array.from({ length: 5 }, (_, i) => `o${i}`)];
 const read = new Set(ids.filter(id => !["n00", "o0", "o1", "o2", "o3", "o4"].includes(id)));
 const markAsked = Promise.withResolvers<void>(), markRelease = Promise.withResolvers<void>(), walkAsked = Promise.withResolvers<void>();
 const headHeld = Promise.withResolvers<void>(), headRelease = Promise.withResolvers<void>();
 let holdMark = false, holdHead = false;
 guestLink(async (method, params) => {
  if (method === "gram.mark_read") {
   if (holdMark) { holdMark = false; markAsked.resolve(); await markRelease.promise; }
   for (const id of params.ids as string[]) read.add(id);
   return { type: "ok" };
  }
  if (method !== "gram.list") throw new Error("unexpected " + method);
  const limit = Number(params.limit);
  if (limit === 100) walkAsked.resolve();
  else if (holdHead) { holdHead = false; headHeld.resolve(); await headRelease.promise; }
  return { messages: guestRows(ids.slice(0, limit), read), has_more: ids.length > limit };
 });
 await opened();
 holdMark = true;
 const marking = gramDesk.gramMarkRead!("n00");
 await markAsked.promise;
 // A refresh and the hidden poll's walk, both while the mark is out: both owe a list.
 await gramDesk.gramRefresh!();
 await gramDesk.gramSetVisible!(false);
 await walkAsked.promise;
 holdHead = true;
 const five = until(s => s.unreadCount === 5);
 markRelease.resolve();
 await marking;
 await five;
 await headHeld.promise;
 const headIn = until(() => true);
 headRelease.resolve();
 await headIn;
 expect((await gramDesk.gramState!()).unreadCount).toBe(5);
});

test("a paging request superseded by a head list is asked again, whether it answers rows or a cursor refusal", async () => {
 const rows = Array.from({ length: 41 }, (_, i) => `r${String(i).padStart(2, "0")}`);
 const host = pagedOwnerStore([...rows, "z"]);
 await opened();
 host.hold();
 host.refuse();
 const older = gramDesk.gramLoadOlder!();
 await host.pageAsked.promise;
 // The cursor (r39, the 40th row) is deleted: herdr refuses it, the head moves on to r40.
 host.set(rows.filter(r => r !== "r39").concat("z"));
 await gramDesk.gramRefresh!();
 host.release.resolve();
 expect(await older).toBe(true);
 const s = await gramDesk.gramState!();
 expect([s.messages.map(m => m.id).slice(-2), s.olderError ?? ""]).toEqual([["r40", "z"], ""]);
});

test("a refusal for the list still shown is the page's error", async () => {
 const rows = Array.from({ length: 41 }, (_, i) => `r${String(i).padStart(2, "0")}`);
 const host = pagedOwnerStore(rows);
 await opened();
 host.hold();
 host.refuse();
 const older = gramDesk.gramLoadOlder!();
 await host.pageAsked.promise;
 host.set(rows.filter(r => r !== "r39"));
 host.release.resolve();
 await expect(older).rejects.toThrow("before_id is not in the store");
 expect((await gramDesk.gramState!()).olderError).toBe("Couldn't load older messages.");
});

test("a guest post whose earlier head list fails still gets its own head list after it", async () => {
 const calls: string[] = [];
 const headAsked = Promise.withResolvers<void>(), headRelease = Promise.withResolvers<void>();
 const postAsked = Promise.withResolvers<void>();
 let holdHead = false, posted = false;
 guestLink(async method => {
  calls.push(method === "gram.post" ? "post" : method === "gram.list" ? "head" : method);
  if (method === "gram.post") { postAsked.resolve(); posted = true; return { message: { id: "p1" } }; }
  if (method !== "gram.list") throw new Error("unexpected " + method);
  if (holdHead) { holdHead = false; headAsked.resolve(); await headRelease.promise; throw new Error("relay dropped the list"); }
  return { messages: [...(posted ? [{ id: "p1", direction: "owner_to_agent", from: "visitor", text: "hi", created_unix_ms: 2000, read: true }] : []), ...guestRows(["m1"], new Set(["m1"]))], has_more: false };
 });
 await opened();
 calls.length = 0;
 holdHead = true;
 const listing = gramDesk.gramRefresh!();
 await headAsked.promise;
 const sending = gramDesk.gramPost!("hi", [], []);
 await postAsked.promise;
 // The post is in; the list asked before it fails.
 headRelease.resolve();
 await listing;
 await sending;
 expect(calls).toEqual(["head", "post", "head"]);
 expect((await gramDesk.gramState!()).messages.map(m => m.id)).toEqual(["p1", "m1"]);
});

test("a guest post's head list is one sent after every write settled, not one sent while a mark was still out", async () => {
 const calls: string[] = [];
 const markAsked = Promise.withResolvers<void>(), markRelease = Promise.withResolvers<void>();
 let holdMark = false;
 guestLink(async (method, params) => {
  calls.push(method === "gram.post" ? "post" : method === "gram.mark_read" ? "mark" : String(params.limit) === "100" ? "walk" : "head");
  if (method === "gram.post") return { message: { id: "p1" } };
  if (method === "gram.mark_read") { if (holdMark) { holdMark = false; markAsked.resolve(); await markRelease.promise; } return { type: "ok" }; }
  return { messages: guestRows(["m1"], new Set()), has_more: false };
 });
 await opened();
 calls.length = 0;
 holdMark = true;
 const marking = gramDesk.gramMarkRead!("m1");
 await markAsked.promise;
 let sent = false;
 const sending = gramDesk.gramPost!("hi", [], []).then(() => { sent = true; });
 // A refresh while the mark is still out: its head list is sent during a write.
 for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
 await gramDesk.gramRefresh!();
 for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
 expect([calls, sent]).toEqual([["mark", "post", "head"], false]);
 calls.length = 0;
 markRelease.resolve();
 await marking;
 await sending;
 expect(calls).toEqual(["head"]);
});

test("a guest post whose head list is discarded resolves only with the head list that replaces it", async () => {
 const calls: string[] = [];
 const headAsked = Promise.withResolvers<void>(), headRelease = Promise.withResolvers<void>();
 const markAsked = Promise.withResolvers<void>(), markRelease = Promise.withResolvers<void>();
 let holdHead = false, holdMark = false, posted = false;
 guestLink(async (method, params) => {
  calls.push(method === "gram.post" ? "post" : method === "gram.mark_read" ? "mark" : String(params.limit) === "100" ? "walk" : "head");
  if (method === "gram.post") { posted = true; holdHead = true; return { message: { id: "p1" } }; }
  if (method === "gram.mark_read") { if (holdMark) { holdMark = false; markAsked.resolve(); await markRelease.promise; } return { type: "ok" }; }
  const rows = { messages: [...(posted ? [{ id: "p1", direction: "owner_to_agent", from: "visitor", text: "hi", created_unix_ms: 2000, read: true }] : []), ...guestRows(["m1"], new Set())], has_more: false };
  if (holdHead) { holdHead = false; headAsked.resolve(); await headRelease.promise; }
  return rows;
 });
 await opened();
 calls.length = 0;
 let sent = false;
 const sending = gramDesk.gramPost!("hi", [], []).then(() => { sent = true; });
 // The post's own head list is out; a mark-read starts before it answers, so its answer is dropped.
 await headAsked.promise;
 holdMark = true;
 const marking = gramDesk.gramMarkRead!("m1");
 await markAsked.promise;
 headRelease.resolve();
 for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
 expect([calls, sent, (await gramDesk.gramState!()).messages.map(m => m.id)]).toEqual([["post", "head", "mark"], false, ["m1"]]);
 markRelease.resolve();
 await marking;
 await sending;
 expect([calls, (await gramDesk.gramState!()).messages.map(m => m.id)]).toEqual([["post", "head", "mark", "head"], ["p1", "m1"]]);
});

test("a guest post whose head list is discarded by a mark that already finished is told by the replacement head list", async () => {
 const calls: string[] = [];
 const headAsked = Promise.withResolvers<void>(), headRelease = Promise.withResolvers<void>();
 let holdHead = false, posted = false;
 guestLink(async (method, params) => {
  calls.push(method === "gram.post" ? "post" : method === "gram.mark_read" ? "mark" : String(params.limit) === "100" ? "walk" : "head");
  if (method === "gram.post") { posted = true; holdHead = true; return { message: { id: "p1" } }; }
  if (method === "gram.mark_read") return { type: "ok" };
  const rows = { messages: [...(posted ? [{ id: "p1", direction: "owner_to_agent", from: "visitor", text: "hi", created_unix_ms: 2000, read: true }] : []), ...guestRows(["m1"], new Set())], has_more: false };
  if (holdHead) { holdHead = false; headAsked.resolve(); await headRelease.promise; }
  return rows;
 });
 await opened();
 calls.length = 0;
 let sent = false;
 const sending = gramDesk.gramPost!("hi", [], []).then(() => { sent = true; });
 // The reviewer's order: the post's head list is held, a mark-read starts and finishes, then the
 // held answer comes back (dropped: the mark overlapped it) and its replacement goes out.
 await headAsked.promise;
 await gramDesk.gramMarkRead!("m1");
 headRelease.resolve();
 for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve));
 expect([calls, sent, (await gramDesk.gramState!()).messages.map(m => m.id)]).toEqual([["post", "head", "mark", "head"], true, ["p1", "m1"]]);
 await sending;
});

test("the link's end settles a guest post still waiting on its owed head list", async () => {
 const markAsked = Promise.withResolvers<void>();
 guestLink(async method => {
  if (method === "gram.post") return { message: { id: "p1" } };
  if (method === "gram.mark_read") { markAsked.resolve(); return await new Promise(() => {}); }
  return { messages: guestRows(["m1"], new Set()), has_more: false };
 });
 await opened();
 // A mark still out: the post's head list stays owed (none goes out during a write).
 void gramDesk.gramMarkRead!("m1").catch(() => undefined);
 await markAsked.promise;
 let settled = false;
 void gramDesk.gramPost!("hi", [], []).then(() => { settled = true; }, () => { settled = true; });
 for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
 expect(settled).toBe(false);
 setLink(null);
 for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
 expect(settled).toBe(true);
});

test("two documents saving at once both land: each change is made on what storage holds now", async () => {
 const shared = new Map<string, string>();
 const storage = () => ({ getItem: (k: string) => shared.get(k) ?? null, setItem: (k: string, v: string) => void shared.set(k, v) });
 // One holder at a time per name, as navigator.locks: the second waits for the first.
 const asked: string[] = [];
 let tail = Promise.resolve();
 const locks: Locks = { request: (name, callback) => { asked.push(name); const run = tail.then(callback); tail = run.then(() => undefined, () => undefined); return run; } };
 const a = new SavedStore("herdrup.gram.saved", storage, locks), b = new SavedStore("herdrup.gram.saved", storage, locks);
 expect([a.read(), b.read()]).toEqual([[], []]);
 const add = (id: string) => (current: unknown) => [...(current as { id: string }[]), { id }];
 await Promise.all([a.update(add("x")), b.update(add("y"))]);
 expect(JSON.parse(shared.get("herdrup.gram.saved")!)).toEqual([{ id: "x" }, { id: "y" }]);
 expect(asked).toEqual(["herdrup.gram.saved", "herdrup.gram.saved"]);
 // A's copy is what it wrote until B's storage event; then it reads both.
 a.drop();
 expect([a.read(), b.read()]).toEqual([[{ id: "x" }, { id: "y" }], [{ id: "x" }, { id: "y" }]]);
 // No change, no write; a refused write leaves storage and the copy as they were.
 expect(await a.update(() => null)).toBeNull();
 const refusing = new SavedStore("k", () => ({ getItem: () => "[1]", setItem: () => { throw new Error("full"); } }), null);
 expect([(await refusing.update(() => [2]))?.message, refusing.read()]).toEqual(["Couldn't update the saved messages: full", [1]]);
 // A refused lock is a change not stored, resolved (never thrown), with nothing written.
 const locked = new SavedStore("k2", storage, { request: () => Promise.reject(new DOMException("The operation is insecure.", "SecurityError")) });
 expect([(await locked.update(() => [1]))?.message, shared.has("k2")]).toEqual(["Couldn't update the saved messages: this browser refused the lock that keeps its tabs' changes apart", false]);
});

/** Runs f with navigator.locks as locks (the Gram's Saved store takes the browser's). */
async function withBrowserLocks(locks: Locks, f: () => Promise<void>) {
 Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
 try { await f(); } finally { Reflect.deleteProperty(navigator, "locks"); }
}

test("an expiry waiting for the Saved lock writes only what is still owed once it has the lock", async () => {
 const file = { name: "notes.txt", mime: "text/plain", size: 5, sha256: "" };
 store.set("herdrup.gram.saved", JSON.stringify([{ id: "x", text: "", from: "docs", fromAgent: true, createdUnixMs: 1, file, hostID: "h", machine: "dev" }]));
 const requested = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
 // Another tab holds the lock until held resolves.
 await withBrowserLocks({ request: async (_name, callback) => { requested.resolve(); await held.promise; return await callback(); } }, async () => {
  let live = false;
  ownerLink(method => {
   if (method !== "gram.list") throw new Error("unexpected " + method);
   return list([row("x", live ? { file } : { expired_file: file })], { digest: live ? "d2" : "d1", store_id: "s1" });
  });
  const opening = opened();
  await requested.promise;
  // A newer refresh shows the file live while the expiry still waits for the lock.
  live = true;
  await gramDesk.gramRefresh!();
  held.resolve();
  await opening;
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
  const s = await gramDesk.gramState!();
  expect([s.messages[0]?.file?.name, s.saved[0]?.file?.name, s.saved[0]?.expiredFile]).toEqual(["notes.txt", "notes.txt", undefined]);
  expect(JSON.parse(store.get("herdrup.gram.saved")!)[0].expiredFile).toBeUndefined();
 });
});

test("a refused Saved lock is a failed write: the list still loads, the banner says so, the expiry stays owed", async () => {
 const file = { name: "notes.txt", mime: "text/plain", size: 5, sha256: "" };
 store.set("herdrup.gram.saved", JSON.stringify([{ id: "x", text: "", from: "docs", fromAgent: true, createdUnixMs: 1, file, hostID: "h", machine: "dev" }]));
 let refuse = true;
 await withBrowserLocks({ request: async (_name, callback) => { if (refuse) throw new DOMException("The operation is insecure.", "SecurityError"); return await callback(); } }, async () => {
  ownerLink((method, params) => {
   if (method !== "gram.list") throw new Error("unexpected " + method);
   if (params.if_unchanged_digest === "d1") return { type: "gram_list_unchanged", digest: "d1", store_id: "s1" };
   return list([row("x", { expired_file: file })], { digest: "d1", store_id: "s1" });
  });
  let s = await opened();
  expect([s.status, s.refreshing, s.messages.map(m => m.id), s.saved[0]?.file?.name]).toEqual(["Couldn't update the saved messages: this browser refused the lock that keeps its tabs' changes apart", false, ["x"], "notes.txt"]);
  expect(JSON.parse(store.get("herdrup.gram.saved")!)[0].expiredFile).toBeUndefined();
  // The lock granted again: the next (unchanged) list stores the owed expiry.
  refuse = false;
  await gramDesk.gramRefresh!();
  s = await gramDesk.gramState!();
  expect([(s.status ?? "").includes("Couldn't update"), s.saved[0]?.expiredFile?.name]).toEqual([false, "notes.txt"]);
 });
});

test("a Save keeps what another document saved since this one read Saved", async () => {
 ownerLink(method => {
  if (method === "gram.list") return list([row("m1"), row("m2")]);
  throw new Error("unexpected " + method);
 });
 await opened();
 expect((await gramDesk.gramState!()).saved).toEqual([]);
 // Another document saves m2; its storage event hasn't arrived here yet.
 store.set("herdrup.gram.saved", JSON.stringify([{ id: "m2", text: "", from: "docs", fromAgent: true, createdUnixMs: 1000, hostID: "h", machine: "dev" }]));
 await gramDesk.gramSetSaved!("m1", true);
 expect((JSON.parse(store.get("herdrup.gram.saved")!) as { id: string }[]).map(s => s.id).sort()).toEqual(["m1", "m2"]);
 expect((await gramDesk.gramState!()).saved.map(s => s.id).sort()).toEqual(["h\u001fm1", "h\u001fm2"]);
});

test("a guest post over a refresh it discards lists once after it: head, post, head", async () => {
 const calls: string[] = [];
 const headAsked = Promise.withResolvers<void>(), headRelease = Promise.withResolvers<void>();
 const postAsked = Promise.withResolvers<void>(), postRelease = Promise.withResolvers<void>(), headAnswered = Promise.withResolvers<void>();
 let holdHead = false, posted = false;
 const after = Promise.withResolvers<void>();
 guestLink(async method => {
  calls.push(method === "gram.post" ? "post" : method === "gram.list" ? "head" : method);
  if (method === "gram.post") { postAsked.resolve(); await postRelease.promise; posted = true; return { message: { id: "p1" } }; }
  if (method !== "gram.list") throw new Error("unexpected " + method);
  if (holdHead) { holdHead = false; headAsked.resolve(); await headRelease.promise; headAnswered.resolve(); }
  else if (posted) after.resolve();
  return { messages: guestRows(["m1"], new Set(["m1"])), has_more: false };
 });
 await opened();
 calls.length = 0;
 holdHead = true;
 const listing = gramDesk.gramRefresh!();
 await headAsked.promise;
 const sending = gramDesk.gramPost!("hi", [], []);
 await postAsked.promise;
 headRelease.resolve();
 await listing;
 postRelease.resolve();
 await sending;
 await after.promise;
 // Let any head queued behind that one go out before counting (no wall-clock wait).
 for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve));
 expect(calls).toEqual(["head", "post", "head"]);
});

test("a pending post a head list sent after its acknowledgement doesn't list is gone, unchanged digest or not", async () => {
 const post = row("p1", { direction: "owner_to_agent", from: "owner", to: "build", text: "ship it" });
 let rows = [row("m1", { read_by_owner: true })];
 const digest = () => "d-" + rows.map(r => r.id).join(",");
 const postAsked = Promise.withResolvers<void>(), ack = Promise.withResolvers<void>();
 let acked = false;
 const afterAck = Promise.withResolvers<void>();
 ownerLink(async (method, params) => {
  if (method === "gram.post") { rows = [post, ...rows]; postAsked.resolve(); await ack.promise; acked = true; return { type: "gram_sent", message: post }; }
  if (method !== "gram.list") throw new Error("unexpected " + method);
  if (acked) afterAck.resolve();
  if (params.if_unchanged_digest === digest()) return { type: "gram_list_unchanged", digest: digest(), store_id: "s1" };
  return list(rows, { digest: digest(), store_id: "s1" });
 });
 await opened();
 const sending = gramDesk.gramPost!("ship it", ["build"], []);
 await postAsked.promise;
 // A list overlapping the post shows it (discarded), then another client deletes it: the store is
 // back to its digest from before the post.
 await gramDesk.gramRefresh!();
 rows = rows.filter(r => r.id !== "p1");
 const gone = until(s => !s.messages.some(m => m.id === "p1"));
 ack.resolve();
 await sending;
 await afterAck.promise;
 await gone;
 await gramDesk.gramRefresh!();
 expect((await gramDesk.gramState!()).messages.map(m => m.id)).toEqual(["m1"]);
});

test("Gram opened while the hidden badge list is out loads as soon as that list is back", async () => {
 const badgeAsked = Promise.withResolvers<void>(), badgeReply = Promise.withResolvers<unknown>(), headAsked = Promise.withResolvers<void>();
 ownerLink((method, params) => {
  if (method !== "gram.list") throw new Error("unexpected " + method);
  if (params.unread_only) { badgeAsked.resolve(); return badgeReply.promise; }
  headAsked.resolve();
  return list([row("m1")]);
 });
 await badgeAsked.promise;
 await gramDesk.gramSetVisible!(true);
 badgeReply.resolve(list([], { unread_count: 0 }));
 // Not the hidden tab's 15 s later: the head list goes out once the badge list is back.
 await headAsked.promise;
});

test("a guest's Gram has no delete", async () => {
 const calls: string[] = [];
 setLink({
  access: { guestID: "g1", guestName: "visitor", machineLabel: "box", ownerName: "Owner", agentName: "docs", agentTarget: "t1", endpoint: { relay: "", hostID: "h", hostPublicKey: new Uint8Array(32) }, acceptedAt: "" } as GuestAccess,
  features: () => ({ gram: true, push: false }),
  call: async <T>(method: string) => { calls.push(method); return (method === "gram.list" ? { messages: [], has_more: false } : { type: "ok" }) as T; },
  stream: () => { throw new Error("no streams"); },
 });
 await expect(gramDesk.gramDelete!("m1")).rejects.toThrow("only the owner deletes Grams");
 expect(calls).not.toContain("gram.delete");
});

test("a Save the browser can't store fails and says so in the banner; one that lands clears that", async () => {
 ownerLink(method => {
  if (method === "gram.list") return list([row("m1")]);
  throw new Error("unexpected " + method);
 });
 await opened();
 refuseWrites = true;
 await expect(gramDesk.gramSetSaved!("m1", true)).rejects.toThrow("Couldn't update the saved messages: The quota has been exceeded.");
 let s = await gramDesk.gramState!();
 expect([s.status, s.messages[0]?.saved]).toEqual(["Couldn't update the saved messages: The quota has been exceeded.", false]);
 refuseWrites = false;
 await gramDesk.gramSetSaved!("m1", true);
 s = await gramDesk.gramState!();
 // The refresh's own acknowledgement may still show; the Saved failure may not.
 expect([(s.status ?? "").includes("Couldn't update"), s.messages[0]?.saved]).toEqual([false, true]);
});

test("Saved storage the browser denies or lacks fails the Save and says so, as a refused write does", async () => {
 ownerLink(method => {
  if (method === "gram.list") return list([row("m1")]);
  throw new Error("unexpected " + method);
 });
 await opened();
 const kept: unknown = Reflect.get(globalThis, "localStorage");
 try {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("The operation is insecure.", "SecurityError"); } });
  await expect(gramDesk.gramSetSaved!("m1", true)).rejects.toThrow("Couldn't update the saved messages: The operation is insecure.");
  let s = await gramDesk.gramState!();
  expect([s.status, s.messages[0]?.saved]).toEqual(["Couldn't update the saved messages: The operation is insecure.", false]);
  Reflect.deleteProperty(globalThis, "localStorage");
  await expect(gramDesk.gramSetSaved!("m1", true)).rejects.toThrow("Couldn't update the saved messages: this browser keeps no storage for this page");
  s = await gramDesk.gramState!();
  expect([s.status, s.messages[0]?.saved]).toEqual(["Couldn't update the saved messages: this browser keeps no storage for this page", false]);
 } finally {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: kept });
 }
 expect(store.size).toBe(0);
});

test("an expiry Saved couldn't store is tried again with the next list, an unchanged one included", async () => {
 const file = { name: "notes.txt", mime: "text/plain", size: 5, sha256: "" };
 store.set("herdrup.gram.saved", JSON.stringify([{ id: "x", text: "", from: "docs", fromAgent: true, createdUnixMs: 1, file, hostID: "h", machine: "dev" }]));
 refuseWrites = true;
 let unchanged = 0;
 ownerLink((method, params) => {
  if (method !== "gram.list") throw new Error("unexpected " + method);
  if (params.if_unchanged_digest === "d1") { unchanged++; return { type: "gram_list_unchanged", digest: "d1", store_id: "s1" }; }
  return list([row("x", { expired_file: file })], { digest: "d1", store_id: "s1" });
 });
 await opened();
 for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
 let s = await gramDesk.gramState!();
 expect([s.status, s.saved[0]?.file?.name]).toEqual(["Couldn't update the saved messages: The quota has been exceeded.", "notes.txt"]);
 refuseWrites = false;
 await gramDesk.gramRefresh!();
 s = await gramDesk.gramState!();
 expect([unchanged, (s.status ?? "").includes("Couldn't update"), s.saved[0]?.file, s.saved[0]?.expiredFile?.name]).toEqual([1, false, undefined, "notes.txt"]);
 expect(JSON.parse(store.get("herdrup.gram.saved")!)[0]).toMatchObject({ id: "x", expiredFile: { name: "notes.txt" } });
 // Stored, it is no longer owed: the next unchanged list doesn't touch Saved.
 const before = reads;
 await gramDesk.gramRefresh!();
 expect([unchanged, reads - before]).toEqual([2, 0]);
});

test("a deferred expiry is dropped once a newer answer shows that message's file live", async () => {
 const file = { name: "notes.txt", mime: "text/plain", size: 5, sha256: "" };
 store.set("herdrup.gram.saved", JSON.stringify([{ id: "x", text: "", from: "docs", fromAgent: true, createdUnixMs: 1, file, hostID: "h", machine: "dev" }]));
 refuseWrites = true;
 let live = false;
 ownerLink(method => {
  if (method !== "gram.list") throw new Error("unexpected " + method);
  return list([row("x", live ? { file } : { expired_file: file })], { digest: live ? "d2" : "d1", store_id: "s1" });
 });
 await opened();
 for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
 expect((await gramDesk.gramState!()).status).toBe("Couldn't update the saved messages: The quota has been exceeded.");
 // A backup restored: storage takes writes again and the message lists its file live.
 refuseWrites = false;
 live = true;
 await gramDesk.gramRefresh!();
 const s = await gramDesk.gramState!();
 expect([s.messages[0]?.file?.name, s.saved[0]?.file?.name, s.saved[0]?.expiredFile]).toEqual(["notes.txt", "notes.txt", undefined]);
 expect(JSON.parse(store.get("herdrup.gram.saved")!)[0]).toMatchObject({ id: "x", file: { name: "notes.txt" } });
 expect(JSON.parse(store.get("herdrup.gram.saved")!)[0].expiredFile).toBeUndefined();
});

test("an older page that overlapped a write is dropped whole: no rows, no count, no Saved expiry", async () => {
 const file = { name: "notes.txt", mime: "text/plain", size: 5, sha256: "" };
 const pageAsked = Promise.withResolvers<void>(), page = Promise.withResolvers<unknown>();
 let read = false;
 store.set("herdrup.gram.saved", JSON.stringify([{ id: "o1", text: "", from: "docs", fromAgent: true, createdUnixMs: 1, file, hostID: "h", machine: "dev" }]));
 ownerLink((method, params) => {
  if (method === "gram.mark_read") { read = true; return { type: "ok" }; }
  if (method !== "gram.list") throw new Error("unexpected " + method);
  if (params.before_id) { pageAsked.resolve(); return page.promise; }
  return list([row("m1", { read_by_owner: read })], { unread_count: read ? 0 : 1, has_more: true, store_id: "s1" });
 });
 expect((await opened()).unreadCount).toBe(1);
 const older = gramDesk.gramLoadOlder!();
 await pageAsked.promise;
 await gramDesk.gramMarkRead!("m1");
 page.resolve(list([row("o1", { expired_file: file })], { unread_count: 7, store_id: "s1" }));
 expect(await older).toBe(false);
 const s = await gramDesk.gramState!();
 expect([s.messages.map(m => m.id), s.unreadCount, s.saved[0]?.file?.name]).toEqual([["m1"], 0, "notes.txt"]);
});

test("a Save publishes the Gram once", async () => {
 ownerLink(method => {
  if (method === "gram.list") return list([row("m1")]);
  throw new Error("unexpected " + method);
 });
 await opened();
 let published = 0;
 const off = events.gramChanged.on(() => { published++; });
 try { await gramDesk.gramSetSaved!("m1", true); } finally { off(); }
 expect(published).toBe(1);
});

/** A store of two unread Grams, m1 and m2, behind a scripted link (owner or guest), whose next head
 *  list and next mark-read can be held. A held list answers with the store as it was when asked
 *  ("ask") or as it is when released ("release"); a held mark-read commits when released. */
function overlapStore(mode: "owner" | "guest") {
 const read = new Set<string>();
 let holdList: "ask" | "release" | null = null, holdMark = false;
 const listAsked = Promise.withResolvers<void>(), listRelease = Promise.withResolvers<void>();
 /** The first head list asked after the held one was answered: the one a discard owes. */
 const fresh = Promise.withResolvers<void>();
 let answeredHeld = false;
 const markAsked = Promise.withResolvers<void>(), markRelease = Promise.withResolvers<void>();
 const snapshot = () => mode === "owner"
  ? list(["m1", "m2"].map(id => row(id, { read_by_owner: read.has(id) })), { unread_count: 2 - read.size })
  : { messages: ["m1", "m2"].map(id => ({ id, direction: "agent_to_owner", from: "docs", text: "hi " + id, created_unix_ms: 1000, read: read.has(id) })), has_more: false };
 const handle = async (method: string, params: Record<string, unknown>) => {
  if (method === "gram.mark_read") {
   if (holdMark) { holdMark = false; markAsked.resolve(); await markRelease.promise; }
   for (const id of mode === "owner" ? [params.id] : params.ids as unknown[]) read.add(String(id));
   return { type: "ok" };
  }
  if (method !== "gram.list") throw new Error("unexpected " + method);
  if (holdList && !params.unread_only) {
   const at = holdList, asked = snapshot();
   holdList = null;
   listAsked.resolve();
   await listRelease.promise;
   answeredHeld = true;
   return at === "ask" ? asked : snapshot();
  }
  if (answeredHeld && !params.unread_only) fresh.resolve();
  return snapshot();
 };
 if (mode === "owner") ownerLink(handle);
 else {
  setLink({
   access: { guestID: "g1", guestName: "visitor", machineLabel: "box", ownerName: "Owner", agentName: "docs", agentTarget: "t1", endpoint: { relay: "", hostID: "h", hostPublicKey: new Uint8Array(32) }, acceptedAt: "" } as GuestAccess,
   features: () => ({ gram: true, push: false }),
   call: async <T>(method: string, params?: unknown) => await handle(method, (params ?? {}) as Record<string, unknown>) as T,
   stream: () => { throw new Error("no streams"); },
  });
 }
 return { holdList: (at: "ask" | "release") => { holdList = at; }, holdMark: () => { holdMark = true; }, listAsked, listRelease, markAsked, markRelease, fresh };
}

const unreadOf = async () => {
 const s = await gramDesk.gramState!();
 return [s.messages.filter(m => m.unread).map(m => m.id), s.unreadCount];
};

for (const mode of ["owner", "guest"] as const) {
 test(`${mode}: a mark-read herdr commits before reading an earlier list counts once`, async () => {
  const host = overlapStore(mode);
  await opened();
  expect(await unreadOf()).toEqual([["m1", "m2"], 2]);
  host.holdList("release");
  const listing = gramDesk.gramRefresh!();
  await host.listAsked.promise;
  await gramDesk.gramMarkRead!("m1");
  // The list herdr read after committing the read: dropped, the read shows from its acknowledgement.
  host.listRelease.resolve();
  await listing;
  expect(await unreadOf()).toEqual([["m2"], 1]);
  // It owed a fresh list, which goes out on its own and agrees.
  await host.fresh.promise;
  await gramDesk.gramRefresh!();
  expect(await unreadOf()).toEqual([["m2"], 1]);
 });

 test(`${mode}: a list read before a later mark-read committed doesn't bring the read row back`, async () => {
  const host = overlapStore(mode);
  await opened();
  host.holdMark();
  const marking = gramDesk.gramMarkRead!("m1");
  await host.markAsked.promise;
  host.holdList("ask");
  const listing = gramDesk.gramRefresh!();
  await host.listAsked.promise;
  host.markRelease.resolve();
  await marking;
  host.listRelease.resolve();
  await listing;
  expect(await unreadOf()).toEqual([["m2"], 1]);
  await host.fresh.promise;
  await gramDesk.gramRefresh!();
  expect(await unreadOf()).toEqual([["m2"], 1]);
 });

 test(`${mode}: a list answered while a mark-read is still out is dropped, and a fresh one follows the mark`, async () => {
  const host = overlapStore(mode);
  await opened();
  host.holdMark();
  const marking = gramDesk.gramMarkRead!("m1");
  await host.markAsked.promise;
  host.holdList("ask");
  const listing = gramDesk.gramRefresh!();
  await host.listAsked.promise;
  host.listRelease.resolve();
  await listing;
  expect(await unreadOf()).toEqual([["m1", "m2"], 2]);
  // The list it owes waits for the mark, then goes out on its own.
  host.markRelease.resolve();
  await marking;
  await host.fresh.promise;
  await gramDesk.gramRefresh!();
  expect(await unreadOf()).toEqual([["m2"], 1]);
 });
}

// ---- Decisions ----

test("ownerAgents: the live roster's named, unarchived local agents, the ones that wrote first; never a removed or federated sender", () => {
 const feed = [ownerInfo(row("a", { from: "build" })), ownerInfo(row("r", { from: "removed" })), ownerInfo(row("b", { from: "far/api", machine_label: "Far box" })), ownerInfo(row("c", { from: "build" }))];
 expect(ownerAgents(feed, roster, "dev")).toEqual([{ from: "build", name: "build", machine: "dev" }, { from: "docs", name: "docs", machine: "dev" }]);
});

test("an owner's stored saved list keeps only copies that name their machine", () => {
 const ok = { id: "m1", text: "", from: "docs", fromAgent: true, createdUnixMs: 1, hostID: "h", machine: "dev" };
 expect(ownerSavedCopies([ok, { ...ok, id: "m2", hostID: undefined }, { ...ok, id: "m3", hostID: "" }, { ...ok, id: "m4", machine: undefined }, null, "x"])).toEqual([ok]);
 expect(ownerSavedCopies({ not: "a list" })).toEqual([]);
});

test("the store's unread count follows this device's reads and deletes until the next list", () => {
 const inbox = new Inbox();
 inbox.apply(ownerAnswer({ messages: [row("m1"), row("m2")], has_more: true, unread_count: 9 }));
 expect(inbox.unreadCount()).toBe(9);
 inbox.markRead("m1");
 inbox.markRead("m1");
 expect([inbox.unreadCount(), inbox.messages[0]?.readByOwner]).toEqual([8, true]);
 inbox.markRead("far");
 inbox.markRead("far");
 expect(inbox.unreadCount()).toBe(7);
 inbox.remove("m2");
 expect(inbox.unreadCount()).toBe(6);
 inbox.apply(ownerAnswer({ messages: [row("m1", { read_by_owner: true })], has_more: false, unread_count: 4 }));
 expect(inbox.unreadCount()).toBe(4);
 // A guest's list has no count: the window's.
 const guest = new Inbox();
 guest.apply({ messages: [ownerInfo(row("g1"))], hasMore: false });
 expect(guest.unreadCount()).toBe(1);
});

test("the ordering rule: a list answer comes in only when no write overlapped its request", () => {
 const table: [string, WriteMark, WriteMark, boolean][] = [
  ["no write at all", { inFlight: 0, started: 3 }, { inFlight: 0, started: 3 }, true],
  ["a write in flight when it was sent", { inFlight: 1, started: 3 }, { inFlight: 0, started: 3 }, false],
  ["a write started and settled meanwhile", { inFlight: 0, started: 3 }, { inFlight: 0, started: 4 }, false],
  ["a write started and still in flight", { inFlight: 0, started: 3 }, { inFlight: 1, started: 4 }, false],
  ["writes in flight throughout", { inFlight: 2, started: 5 }, { inFlight: 2, started: 5 }, false],
 ];
 for (const [what, sent, now, accept] of table) expect([what, acceptAnswer(sent, now)]).toEqual([what, accept]);
});

test("a discarded answer owes a list of its own kind: a head list or older page a head list, the unread walk the walk", () => {
 const none = { head: false, badge: false };
 const table: [string, Recovery, "head" | "page" | "badge", Recovery][] = [
  ["head", none, "head", { head: true, badge: false }],
  ["older page", none, "page", { head: true, badge: false }],
  ["unread walk", none, "badge", { head: false, badge: true }],
  ["walk after a head", { head: true, badge: false }, "badge", { head: true, badge: true }],
  ["head again", { head: true, badge: false }, "head", { head: true, badge: false }],
 ];
 for (const [what, owed, kind, out] of table) expect([what, owe(owed, kind)]).toEqual([what, out]);
});

test("saved copies: newest first, saved once per machine, an expired file kept as expired on its machine only", () => {
 const file = { name: "a.png", mime: "image/png", size: 3, sha256: "" };
 const a = { hostID: "hA", machine: "dev" }, b = { hostID: "hB", machine: "mac-mini" };
 const one = withSaved([], ownerInfo(row("m1", { created_unix_ms: 1, file })), a)!;
 const two = withSaved(one, ownerInfo(row("m2", { created_unix_ms: 2 })), a)!;
 expect(two.map(s => s.id)).toEqual(["m2", "m1"]);
 expect(withSaved(two, ownerInfo(row("m1")), a)).toBeNull();
 const both = withSaved(two, ownerInfo(row("m1", { created_unix_ms: 1, file })), b)!;
 expect(both.filter(s => s.id === "m1").map(s => s.machine)).toEqual(["dev", "mac-mini"]);
 const expired = expireSaved(both, [ownerInfo(row("m1", { expired_file: file }))], "hB")!;
 expect(expired.filter(s => s.id === "m1").map(s => [s.machine, !!s.file, !!s.expiredFile])).toEqual([["dev", true, false], ["mac-mini", false, true]]);
 expect(expireSaved(expired, [ownerInfo(row("m1", { expired_file: file }))], "hB")).toBeNull();
});

test("gramRow names a claimed post's grabber, a delivered one's addressee", () => {
 const post = (extra: Partial<OwnerGramMessage>) => gramRow(ownerInfo(row("x", { direction: "owner_to_agent", from: "owner", ...extra })), "dev", false, false);
 expect([post({ grabbed_by: "far/api", to: "docs" }).statusRest, post({ to: "docs" }).statusRest, post({}).statusVerb]).toEqual(["by api", "to docs", "Unclaimed"]);
});

test("a failed delete says herdr's message, else asks to try again", () => {
 expect([deleteNote(new HerdrAPIError("not_found", "no such message", null)), deleteNote(new OwnerRefusedError("gram.delete")), deleteNote(new Error("down"))])
  .toEqual(["Couldn't delete: no such message", "Couldn't delete: " + OWNER_REFUSED, "Couldn't delete. Try again."]);
});
