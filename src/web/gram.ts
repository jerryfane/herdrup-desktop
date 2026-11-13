// Gram and the composers' attachments for the browser guest: the guest paths of desk_gram.go,
// desk_guest_gram.go, desk_gram_compose.go, desk_gram_files.go, desk_clipboard.go and
// desk_interaction_compose.go over the current WebLink. Every request is its own relay connect, so
// the poll keeps Go's cadence (desk_guest.go guestStatusPoll: the list, the chat and Gram share the
// relay's 30 connects a minute).

import type { Desk as GoDesk, GramAgent, GramFile, GramMessage, GramSnapshot, SavedGram } from "../mygo";
import { emit } from "./events";
import { fileForPath, forgetFile, pickFiles, registerFiles } from "./files";
import { currentLink, onLinkChanged, type WebLink } from "./link";
import { agentView, sharedAgents, type GuestView } from "./view";
import {
 type Attachment, apiCode, Composer, displaySize, ERR_SENDING, MAX_FILE_BYTES, safeFileName, SendError, skipNote, sleep, toBase64, uploadBlob,
} from "./gramCompose";
import { BLOB_SAVE_MAX_BYTES, type FileChunk, FileTooLarge, imageMime, openPlan, PREVIEW_MAX_BYTES, readChunks, savePlan, TEXT_PREVIEW_MAX_BYTES } from "./gramFiles";
import { AGENT_TO_OWNER, type GramInfo, GRAM_MAX_REFRESH_LIMIT, GRAM_PAGE_SIZE, guestGramPage, type GuestGramPage, Inbox, isUnread, projectGuestPage, type WireFile } from "./gramInbox";
import { HerdrAPIError } from "../webguest/errors";
import { paneAttachmentPrompt } from "../chatAttachments";

/** desk_gram.go:31-39: every 6 s while Gram shows, 30 s after a failure, the badge every 15 s. */
export const GRAM_POLL_VISIBLE_MS = 6_000;
export const GRAM_POLL_FAILING_MS = 30_000;
export const GRAM_POLL_BADGE_MS = 15_000;
const GRAM_ACK_MS = 3_000;
const WAIT_STEP_MS = 100, WAIT_STEPS = 20;

const UNAVAILABLE_NOW = "Gram is unavailable right now.";
const REFRESH_FAILED = "Refresh failed. Showing the last loaded messages.";
const NOT_DEPLOYED = "Gram isn't available on this server yet.";
const NOT_DEPLOYED_OR_LOST = "Gram isn't available on this server yet, or the messages couldn't load.";
const OLDER_FAILED = "Couldn't load older messages.";
const NOT_SHARED = "Gram is not enabled for this shared agent";
const NOT_CONNECTED = "not connected";

type DeskFns = typeof GoDesk;

// ---- State (desk_gram.go gramDesk) ----

interface State {
 link: WebLink | null;
 life: AbortController;
 inbox: Inbox;
 pending: GramInfo[];
 phase: string;
 unavailable: string;
 sendError: string; markAllNote: string; refreshAck: string; refreshNote: string;
 ackToken: number;
 failures: number;
 loading: boolean; refreshQueued: boolean; refreshing: boolean;
 loadingOlder: boolean; olderError: string; pageBusy: boolean;
 markingAll: boolean; markingRead: Set<string>;
 badge: number;
 visible: boolean;
 wake: (() => void) | null;
 composer: Composer | null;
 lastUpload: Map<string, { state: string; fraction: number }>;
 images: Map<string, Promise<string>>;
 imageSlots: number;
}

function fresh(link: WebLink | null, visible: boolean): State {
 return {
  link, life: new AbortController(), inbox: new Inbox(), pending: [], phase: link ? "loading" : "idle", unavailable: "",
  sendError: "", markAllNote: "", refreshAck: "", refreshNote: "", ackToken: 0, failures: 0,
  loading: false, refreshQueued: false, refreshing: false, loadingOlder: false, olderError: "", pageBusy: false,
  markingAll: false, markingRead: new Set(), badge: 0, visible, wake: null, composer: null,
  lastUpload: new Map(), images: new Map(), imageSlots: 2,
 };
}

let g: State = fresh(null, false);

/** The link when it shares Gram; else rejects as gramEngine does. */
function gramLink(): WebLink {
 const link = g.link;
 if (!link) throw new Error(NOT_CONNECTED);
 if (!link.features().gram) throw new Error(NOT_SHARED);
 return link;
}

/** gramstore.Answer for a guest list (desk_guest_gram.go gramAnswer). */
async function gramAnswer(link: WebLink, limit: number, unreadOnly: boolean, before?: string, signal?: AbortSignal) {
 const list = (n: number, cursor?: string) => link.call<GuestGramPage>("gram.list", cursor ? { limit: n, before_id: cursor } : { limit: n }, signal);
 const { page, error } = await guestGramPage(list, limit, unreadOnly, before);
 if (error !== undefined && page.messages.length === 0) throw error;
 return { answer: projectGuestPage(page, sharedAgentName() || link.access.agentName, unreadOnly), error };
}

// ---- Snapshot ----

function gramFile(f: WireFile | undefined): GramFile | undefined {
 if (!f) return undefined;
 const mime = f.mime || "application/octet-stream", image = mime.toLowerCase().startsWith("image/");
 return { name: f.name, mime, size: f.size, sizeLabel: displaySize(f.size), isImage: image, preview: image && f.size <= PREVIEW_MAX_BYTES };
}

/** The bare agent name of a routing name (gramstore.AgentName). */
export function agentName(raw: string): string {
 const i = raw.lastIndexOf("/");
 return i < 0 || i === raw.length - 1 ? raw : raw.slice(i + 1);
}

/** gramRow (desk_gram.go:402-434) for a guest's message: no claims, no federation labels. */
export function gramRow(m: GramInfo, local: string, saved: boolean, pending: boolean): GramMessage {
 const fromAgent = m.direction === AGENT_TO_OWNER;
 const r: GramMessage = {
  id: m.id, fromAgent, from: m.from, name: agentName(m.from), senderName: m.from, machine: "", text: m.text,
  createdUnixMs: m.createdUnixMs, unread: isUnread(m), saved, pending,
 };
 if (m.file) { r.file = gramFile(m.file); r.attachmentPreview = m.file.name; }
 else if (m.expiredFile) { r.expiredFile = gramFile(m.expiredFile); r.attachmentPreview = m.expiredFile.name + " (expired)"; }
 if (m.to) r.to = m.to;
 if (fromAgent) {
  const slash = m.from.indexOf("/");
  r.machine = slash > 0 ? m.from.slice(0, slash) : local;
  return r;
 }
 if (r.to) { r.statusVerb = "Delivered"; r.statusRest = "to " + agentName(r.to); }
 else { r.statusVerb = "Unclaimed"; r.statusRest = "in the shared queue"; }
 return r;
}

/** visibleLocked: your posts not yet listed, then the list. */
function visible(): GramInfo[] {
 const ids = new Set(g.pending.map(m => m.id));
 return [...g.pending, ...g.inbox.messages.filter(m => !ids.has(m.id))];
}

function snapshot(): GramSnapshot {
 const savedIDs = new Set(savedList().map(s => s.id));
 const pendingIDs = new Set(g.pending.map(m => m.id));
 const local = g.link?.access.machineLabel ?? "";
 const s: GramSnapshot = {
  phase: g.phase || "idle", messages: [], unreadCount: g.badge, hasMore: g.inbox.hasMore, loadingOlder: g.loadingOlder,
  refreshing: g.refreshing, markingAllRead: g.markingAll, agents: [], saved: savedList(), localMachine: local,
  attachments: [], sending: false, sendProgress: 0, sendProgressShown: false, draftPosted: 0, visible: g.visible,
 };
 if (g.unavailable) s.unavailable = g.unavailable;
 if (g.olderError) s.olderError = g.olderError;
 const status = [g.sendError, g.markAllNote, g.refreshAck, g.refreshNote].find(t => t !== "");
 if (status) s.status = status;
 const seen = new Set<string>();
 for (const m of visible()) {
  const row = gramRow(m, local, savedIDs.has(m.id), pendingIDs.has(m.id));
  s.messages.push(row);
  if (row.fromAgent && !seen.has(m.from)) { seen.add(m.from); s.agents.push({ from: m.from, name: row.name, machine: row.machine } satisfies GramAgent); }
 }
 if (g.composer) {
  const c = g.composer.snapshot();
  s.sending = c.sending; s.draftPosted = c.draftPosted;
  s.sendProgress = c.progress ?? 0; s.sendProgressShown = c.progress !== null;
  s.attachments = c.chips;
 }
 return s;
}

function publish() { emit("gramChanged", snapshot()); }

function note(text: string) { g.sendError = text; publish(); }

function ack(text: string, expiring: boolean) {
 g.refreshAck = text;
 if (!text || !expiring) return;
 const token = ++g.ackToken, state = g;
 setTimeout(() => { if (g === state && g.ackToken === token && g.refreshAck === text) { g.refreshAck = ""; publish(); } }, GRAM_ACK_MS);
}

// ---- Loads ----

type Outcome = "unchanged" | "updated" | "failed";

/** gramLoadLocked: one head load covering what is held, entered with loading set. */
async function loadHead(state: State, link: WebLink): Promise<Outcome> {
 if (state.inbox.hasLoaded && state.phase === "loading") state.phase = "loaded";
 if (!state.inbox.hasLoaded && visible().length === 0) state.phase = "loading";
 const asked = state.inbox.readStamp;
 const limit = Math.min(Math.max(GRAM_PAGE_SIZE, state.inbox.messages.length), GRAM_MAX_REFRESH_LIMIT);
 publish();
 let answer, error: unknown;
 try { ({ answer } = await gramAnswer(link, limit, false, undefined, state.life.signal)); } catch (e) { error = e ?? new Error("Gram list failed"); }
 if (g !== state) return "unchanged";
 state.loading = false;
 const queued = state.refreshQueued;
 state.refreshQueued = false;
 if (queued) queueMicrotask(() => void refresh(state, link));
 if (!answer) {
  state.failures++;
  const empty = visible().length === 0, unavailable = apiCode(error) === "gram_unavailable";
  if (unavailable && empty) { state.phase = "unavailable"; state.unavailable = NOT_DEPLOYED; }
  else if (unavailable) state.refreshNote = UNAVAILABLE_NOW;
  else if (empty) { state.phase = "unavailable"; state.unavailable = NOT_DEPLOYED_OR_LOST; }
  else state.refreshNote = REFRESH_FAILED;
  publish();
  return "failed";
 }
 const changed = state.inbox.apply(answer, asked);
 state.phase = "loaded"; state.unavailable = ""; state.refreshNote = ""; state.failures = 0;
 state.badge = state.inbox.unreadCount();
 const listed = new Set(state.inbox.messages.map(m => m.id));
 state.pending = state.pending.filter(m => !listed.has(m.id));
 publish();
 return changed ? "updated" : "unchanged";
}

async function load(state: State, link: WebLink) {
 if (state.loading) return;
 state.loading = true;
 await loadHead(state, link);
}

/** gramRefresh: never dropped; a tap during a load runs after it. */
async function refresh(state: State, link: WebLink) {
 if (g !== state) return;
 if (state.loading) { state.refreshQueued = true; ack("Refreshing…", false); publish(); return; }
 state.loading = true; state.refreshing = true;
 const outcome = await loadHead(state, link);
 if (g !== state) return;
 state.refreshing = false;
 ack(outcome === "unchanged" ? "Up to date" : outcome === "updated" ? "Refreshed" : "", true);
 publish();
}

/** gramBadge: an unread-only list while Gram does not show. */
async function badge(state: State, link: WebLink) {
 let answer;
 try { ({ answer } = await gramAnswer(link, 0, true, undefined, state.life.signal)); } catch { return; }
 if (g !== state || state.badge === answer.messages.length) return;
 state.badge = answer.messages.length;
 publish();
}

/** watchGram: polls while the link shares Gram; stops (checking only the features the link's other
 *  calls refresh) while it does not, so a share-gram switch turned off costs no connects. */
async function watch(state: State, link: WebLink) {
 while (g === state && !state.life.signal.aborted) {
  let wait = GRAM_POLL_BADGE_MS;
  if (link.features().gram) {
   if (state.visible) {
    await load(state, link);
    wait = state.failures > 0 ? GRAM_POLL_FAILING_MS : GRAM_POLL_VISIBLE_MS;
   } else await badge(state, link);
  } else if (state.phase !== "idle") {
   state.phase = "idle"; state.unavailable = "";
   state.composer?.pause();
   publish();
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  state.wake = resolve;
  const timer = setTimeout(resolve, wait);
  state.life.signal.addEventListener("abort", () => resolve(), { once: true });
  await promise;
  clearTimeout(timer);
  state.wake = null;
 }
}

// ---- Composer ----

function newComposer(state: State): Composer {
 const c = new Composer((a, progress, signal) => {
  const link = gramLink();
  progress(0, a.size);
  return uploadBlob((method, params, s) => link.call(method, params, s), a.blob, signal, sent => progress(sent, a.size));
 }, id => { void state.link?.call("gram.upload.discard", { upload_id: id }).catch(() => undefined); }, path => composerChanged(state, path));
 return c;
}

/** gramComposerChanged: the upload event at most once a percent, the snapshot on a state change. */
function composerChanged(state: State, path: string) {
 if (g !== state || !state.composer) return;
 if (path === "") { publish(); return; }
 const chip = state.composer.chip(path);
 const ev = chip ? { path, fraction: chip.fraction, state: chip.state, label: chip.label } : { path, fraction: 0, state: "removed", label: "" };
 const last = state.lastUpload.get(path);
 if (last && last.state === ev.state && ev.fraction < 1 && ev.fraction - last.fraction < 0.01) return;
 if (ev.state === "removed") { state.lastUpload.delete(path); forgetFile(path); } else state.lastUpload.set(path, ev);
 emit("gramUpload", ev);
 if (!last || last.state !== ev.state) publish();
}

/** gramStage: the browser files of paths not attached yet, each 1 byte to 100 MiB, at most 10. */
export function stage(c: Composer, paths: string[]): { staged: string[]; note: string } {
 let room = c.room(), capped = 0;
 const staged: string[] = [], bad: string[] = [], add: Attachment[] = [];
 for (const p of paths) {
  if (c.has(p)) { staged.push(p); continue; }
  // A pick that does not stage is released at once: only staged files keep their File.
  if (add.length >= room) { capped++; forgetFile(p); continue; }
  const file = fileForPath(p);
  if (!file || file.size <= 0 || file.size > MAX_FILE_BYTES) { bad.push(file?.name ?? p.slice(p.indexOf("/") + 1)); forgetFile(p); continue; }
  const name = safeFileName(file.name);
  const mime = (file.type.split(";")[0] ?? "").trim().toLowerCase() || "application/octet-stream";
  add.push({ path: p, name, mime, isImage: mime.startsWith("image/"), size: file.size, blob: file });
  staged.push(p);
 }
 room = 0;
 c.add(add);
 return { staged, note: skipNote(bad, capped) };
}

function gramComposer(): Composer {
 gramLink();
 if (!g.composer) throw new Error(NOT_CONNECTED);
 return g.composer;
}

/** Files the last trusted paste carried, taken before the composer's own paste listener runs. */
let pasted: { files: File[]; at: number } | null = null;
if (typeof document !== "undefined") {
 document.addEventListener("paste", event => {
  const files = [...(event.clipboardData?.files ?? [])];
  pasted = event.isTrusted && files.length ? { files, at: Date.now() } : null;
 }, { capture: true });
}

/** desk_clipboard.go pasteClipboard: the files of the paste in progress, else the clipboard's images
 *  where the browser lets the page read them. */
async function clipboardFiles(): Promise<File[]> {
 const recent = pasted && Date.now() - pasted.at < 2_000 ? pasted.files : null;
 pasted = null;
 if (recent) return recent;
 if (!navigator.clipboard?.read) return [];
 const items = await navigator.clipboard.read().catch(() => []);
 const out: File[] = [];
 for (const item of items) {
  const type = item.types.find(t => t.startsWith("image/"));
  if (!type) continue;
  const blob = await item.getType(type);
  out.push(new File([blob], "Pasted image." + (type.split("/")[1] ?? "png").replace(/[^a-z0-9]/g, ""), { type }));
 }
 return out;
}

// ---- Pane composers (desk_interaction_compose.go) ----

/** The shared agent's listed name, as gramAnswer and GramPost take it from link.agents. */
function sharedAgentName(): string {
 return sharedAgents().find(a => a.name && a.name.trim() !== "")?.name ?? "";
}

/** paneRecipient (desk_guest.go:301-322) for a guest: the listed agent of the view's pane. */
function paneRecipient(v: GuestView): { link: WebLink; recipient: string } {
 const link = currentLink();
 if (!link || v.signal.aborted) throw new Error("agent view changed; request was not sent");
 if (!link.features().gram) throw new Error("The owner has not shared this agent's Gram or attachments");
 const agent = sharedAgents().find(a => a.pane_id === v.paneID && a.name && a.name.trim() !== "");
 if (!agent?.name) throw new Error("The shared agent is not available for attachments");
 return { link, recipient: agent.name };
}

const panes = new Map<string, Composer>();

/** newPaneComposer: the view's composer, closed with the view. */
function paneComposer(v: GuestView): Composer {
 let c = panes.get(v.token);
 if (!c) {
  const token = v.token;
  c = new Composer((a, progress, signal) => {
   const { link } = paneRecipient(v);
   progress(0, a.size);
   return uploadBlob((method, params, s) => link.call(method, params, s), a.blob, signal, sent => progress(sent, a.size));
  }, id => { void currentLink()?.call("gram.upload.discard", { upload_id: id }).catch(() => undefined); }, () => publishPane(token, ""));
  panes.set(token, c);
  v.signal.addEventListener("abort", () => closePaneComposer(token), { once: true });
 }
 return c;
}

function publishPane(token: string, note: string) {
 const c = panes.get(token);
 if (c) emit("paneAttachments", { token, files: c.snapshot().chips, note });
}

function closePaneComposer(token: string) {
 const c = panes.get(token);
 if (!c) return;
 panes.delete(token);
 for (const p of c.paths()) forgetFile(p);
 c.close();
}

/** ChatPrompt's attachments branch (desk_interaction.go:356-396): null when token's composer holds
 *  nothing. Otherwise each staged file is posted to the pane's agent as "Attachment from <guest>.",
 *  then submit sends paneAttachmentPrompt; the files leave once submit resolves, and its result is
 *  the receipt. */
export function panePromptAttachments(token: string, text: string, submit: (prompt: string) => Promise<string>): Promise<string> | null {
 const v = agentView(token);
 const c = panes.get(token);
 if (!c || c.paths().length === 0) return null;
 return (async () => {
  paneRecipient(v);
  let receipt = "";
  const paths = c.paths();
  try {
   await c.sendPrompt(paths, async (_text, a, signal) => {
    if (!a) throw new Error("no attachment to post");
    const { link, recipient } = paneRecipient(v);
    const reply = await link.call<{ message?: { id?: string } }>("gram.post", {
     text: "Attachment from " + link.access.guestName + ".", to: recipient, file: { upload_id: a.uploadID, name: a.name, mime: a.mime },
    }, signal);
    const id = reply?.message?.id;
    if (!id) throw new Error("The shared agent did not confirm the posted Gram");
    return id;
   }, async files => { receipt = await submit(paneAttachmentPrompt(text, files)); return true; }, v.signal);
  } finally {
   // The files the send consumed leave the composer; their Files go with them.
   const held = c.paths();
   for (const p of paths) if (!held.includes(p)) forgetFile(p);
   publishPane(token, "");
  }
  return receipt;
 })();
}


// ---- Downloads ----

const chunkOf = (link: WebLink, id: string, signal?: AbortSignal) => (offset: number) => link.call<FileChunk>("gram.get_file_chunk", { id, offset }, signal);

function fileMeta(id: string): WireFile {
 const m = visible().find(v => v.id === id);
 const f = m?.file ?? savedList().find(s => s.id === id)?.file;
 if (!f) throw new Error("that message has no file");
 return f as WireFile;
}

/** The whole file in memory, with download events (gramDownload); a file over maxSize (a preview's
 *  cap) stops at the first chunk with FileTooLarge. */
async function fetchBlob(link: WebLink, id: string, size: number, signal?: AbortSignal, maxSize?: number): Promise<Blob> {
 const parts: Uint8Array<ArrayBuffer>[] = [];
 const progress = (done: number, state: string) => emit("gramDownload", { id, done, size, state, label: displaySize(Math.min(done, size)) + " of " + displaySize(size) });
 progress(0, "downloading");
 try {
  const { mime } = await readChunks(chunkOf(link, id, signal), size, p => { parts.push(p); }, done => progress(done, "downloading"), signal, maxSize);
  progress(size, "done");
  return new Blob(parts, { type: mime });
 } catch (error) { progress(size, "failed"); throw error; }
}

/** gramFileError. */
function fileError(verb: string, error: unknown): string {
 return error instanceof HerdrAPIError ? `Couldn't ${verb} the file: ${error.apiMessage}` : `Couldn't ${verb} the file.`;
}

/** Saves a blob through an <a download>, revoking its URL after the click. */
function downloadBlob(blob: Blob, name: string) {
 const url = URL.createObjectURL(blob);
 const a = document.createElement("a");
 a.href = url; a.download = safeFileName(name); a.rel = "noopener";
 document.body.append(a);
 a.click();
 a.remove();
 setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

type SaveFilePicker = (options: { suggestedName: string; startIn?: "downloads" }) => Promise<{ createWritable(): Promise<{ write(data: Uint8Array<ArrayBuffer>): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }>;

/** gramSaveFile: streamed into a file the person picks where the browser can, else in memory up to
 *  BLOB_SAVE_MAX_BYTES (refused before anything downloads). */
async function saveFile(id: string, saveMaxBytes = BLOB_SAVE_MAX_BYTES) {
 const link = gramLink();
 let f: WireFile;
 try { f = fileMeta(id); } catch (error) { note(fileError("save", error)); throw error; }
 // File System Access is not in TypeScript's DOM library yet.
 const picker = Reflect.get(globalThis, "showSaveFilePicker") as SaveFilePicker | undefined;
 const plan = savePlan(f.size, !!picker, saveMaxBytes);
 if (plan.kind === "too-large") { note(plan.note); throw new Error(plan.note); }
 try {
  if (plan.kind === "blob") { downloadBlob(await fetchBlob(link, id, f.size, g.life.signal), f.name); return; }
  let handle;
  // The picker opens in Downloads, as the desktop's save dialog does.
  try { handle = await picker!({ suggestedName: safeFileName(f.name), startIn: "downloads" }); }
  catch (error) { if (error instanceof DOMException && error.name === "AbortError") return; throw error; }
  const out = await handle.createWritable();
  const progress = (done: number, state: string) => emit("gramDownload", { id, done, size: f.size, state, label: displaySize(Math.min(done, f.size)) + " of " + displaySize(f.size) });
  try {
   progress(0, "downloading");
   await readChunks(chunkOf(link, id, g.life.signal), f.size, p => out.write(p), done => progress(done, "downloading"), g.life.signal);
   await out.close();
   progress(f.size, "done");
  } catch (error) { progress(f.size, "failed"); await out.abort().catch(() => undefined); throw error; }
 } catch (error) { note(fileError("save", error)); throw error; }
}

/** An in-page preview: a picture or plain text, never run; Escape or a click closes it. */
function preview(blob: Blob, kind: "image" | "text", name: string) {
 const dialog = document.createElement("dialog");
 dialog.setAttribute("aria-label", name);
 dialog.style.cssText = "max-width:90vw;max-height:90vh;padding:var(--space-stack-medium);background:var(--color-surface-raised);color:var(--color-text);border:1px solid var(--color-hairline)";
 const url = kind === "image" ? URL.createObjectURL(blob) : "";
 const done = () => { if (url) URL.revokeObjectURL(url); dialog.remove(); };
 if (kind === "image") {
  const img = document.createElement("img");
  img.alt = name; img.src = url;
  img.style.cssText = "max-width:85vw;max-height:80vh;display:block";
  dialog.append(img);
 } else {
  const pre = document.createElement("pre");
  pre.style.cssText = "white-space:pre-wrap;max-height:80vh;overflow:auto;margin:0";
  void blob.text().then(t => { pre.textContent = t; });
  dialog.append(pre);
 }
 dialog.addEventListener("close", done, { once: true });
 dialog.addEventListener("click", () => dialog.close());
 document.body.append(dialog);
 dialog.showModal();
}

// ---- Saved Grams (per guest, in this browser) ----

const savedKey = () => "herdrup.gram.saved." + (g.link?.access.guestID ?? "");
function savedList(): SavedGram[] {
 if (!g.link || typeof localStorage === "undefined") return [];
 try { return JSON.parse(localStorage.getItem(savedKey()) ?? "[]") as SavedGram[]; } catch { return []; }
}

// ---- Desk ----

function reset(link: WebLink | null) {
 g.life.abort(new Error(NOT_CONNECTED));
 for (const p of g.composer?.paths() ?? []) forgetFile(p);
 g.composer?.close();
 for (const token of [...panes.keys()]) closePaneComposer(token);
 g = fresh(link, g.visible);
 if (link) { g.composer = newComposer(g); void watch(g, link); }
 publish();
}
onLinkChanged(reset);

export const gramDesk: Partial<DeskFns> = {
 gramState: async () => snapshot(),

 async gramSetVisible(shown: boolean) {
  if (g.visible === shown) return;
  g.visible = shown;
  publish();
  if (shown) g.composer?.resume(); else g.composer?.pause();
  g.wake?.();
 },

 async gramRefresh() { const link = gramLink(); await refresh(g, link); },

 /** GramLoadOlder: the page older than everything held; one asked again when a head load replaced
  *  the list meanwhile. */
 async gramLoadOlder() {
  const link = gramLink(), state = g;
  while (state.pageBusy) await sleep(WAIT_STEP_MS, state.life.signal);
  state.pageBusy = true; state.loadingOlder = true; state.olderError = "";
  publish();
  try {
   for (let round = 0; round < 2; round++) {
    for (let i = 0; i < WAIT_STEPS && state.loading; i++) await sleep(WAIT_STEP_MS, state.life.signal);
    const cursor = state.inbox.nextCursor(), generation = state.inbox.generation, asked = state.inbox.readStamp;
    if (!cursor) return false;
    let answer;
    try { ({ answer } = await gramAnswer(link, GRAM_PAGE_SIZE, false, cursor, state.life.signal)); }
    catch (error) { if (g === state && !state.life.signal.aborted) state.olderError = OLDER_FAILED; throw error; }
    if (g !== state) return false;
    if (state.inbox.appendPage(answer, generation, asked)) return true;
    if (state.inbox.generation === generation) return false;
   }
   return false;
  } finally {
   state.pageBusy = false;
   if (g === state) { state.loadingOlder = false; publish(); }
  }
 },

 /** GramMarkRead: the local copy flips only after herdr confirms. */
 async gramMarkRead(id: string) {
  const link = gramLink(), state = g;
  const m = visible().find(v => v.id === id);
  if (!m || !isUnread(m) || state.markingRead.has(id)) return;
  state.markingRead.add(id);
  try { await link.call("gram.mark_read", { ids: [id] }, state.life.signal); }
  finally { state.markingRead.delete(id); }
  if (g !== state) return;
  state.inbox.markRead(id);
  state.badge = state.inbox.unreadCount();
  publish();
 },

 /** GramMarkAllRead (desk_gram.go:877-972): ids from an unread-only list, each its own mark, in two
  *  passes; failures are counted in the banner. */
 async gramMarkAllRead() {
  const link = gramLink(), state = g;
  if (state.markingAll) return;
  state.markingAll = true; state.markAllNote = "";
  publish();
  try {
   let pending: string[] = [], listError: unknown;
   try {
    const { answer, error } = await gramAnswer(link, 0, true, undefined, state.life.signal);
    pending = answer.messages.filter(isUnread).map(m => m.id);
    listError = error;
   } catch (error) { listError = error ?? new Error("list failed"); }
   if (listError !== undefined) for (const m of state.inbox.messages) if (isUnread(m) && !pending.includes(m.id)) pending.push(m.id);
   let attempted = 0, failed = 0, marked = 0;
   for (let pass = 0; pass < 2 && pending.length; pass++) {
    const inFlight: string[] = [];
    for (const id of pending) {
     if (g !== state) throw new Error(NOT_CONNECTED);
     if (state.markingRead.has(id)) { inFlight.push(id); continue; }
     const held = state.inbox.messages.find(m => m.id === id);
     if (held && !isUnread(held)) continue;
     state.markingRead.add(id);
     attempted++;
     try { await link.call("gram.mark_read", { ids: [id] }, state.life.signal); state.inbox.markRead(id); marked++; }
     catch { failed++; }
     finally { state.markingRead.delete(id); }
    }
    pending = inFlight;
   }
   if (g !== state) throw new Error(NOT_CONNECTED);
   if (listError === undefined) state.badge = state.inbox.unreadCount();
   else {
    state.badge = Math.max(state.badge - marked, state.inbox.unreadCount());
    state.markAllNote = "Couldn't list every unread message. Some may still be unread.";
   }
   if (failed > 0) state.markAllNote = (state.markAllNote + ` ${failed} of ${attempted} could not be marked read.`).trim();
  } finally {
   if (g === state) { state.markingAll = false; publish(); }
  }
 },

 async gramPickFiles() {
  const c = gramComposer();
  const files = await pickFiles(true);
  if (!files.length) return [];
  const { staged, note: text } = stage(c, registerFiles(files));
  note(text);
  return staged;
 },

 async gramAttachFiles(paths: string[]) {
  const { staged, note: text } = stage(gramComposer(), paths);
  note(text);
  return staged;
 },

 async gramPasteClipboard() {
  const c = gramComposer();
  const files = await clipboardFiles();
  if (!files.length) return false;
  note(stage(c, registerFiles(files)).note);
  return true;
 },

 async gramCancelAttachment(path: string) { gramComposer().remove(path); },

 async gramRetryAttachment(path: string) { gramComposer().retry(path); },

 /** GramPost's guest path: each attached file its own Gram to the shared agent, the text on the
  *  first; the list is refreshed after each post instead of synthesizing the message. */
 async gramPost(text: string, to: string[], attachments: string[]) {
  if (to.length > 1) throw new Error("a Gram goes to one agent or to the shared queue");
  const c = gramComposer(), state = g;
  const body = text.trim();
  const { staged, note: skipped } = stage(c, attachments);
  if (skipped) { note(skipped); throw new Error(skipped); }
  if (!body && !staged.length) return;
  state.sendError = "";
  publish();
  try {
   await c.send(body, staged, async (caption, a, signal) => {
    const link = gramLink();
    const recipient = sharedAgentName().trim() || link.access.agentName.trim();
    if (!recipient) throw new Error("The shared agent is not available for Gram");
    const params: Record<string, unknown> = { text: caption, to: recipient };
    if (a) params.file = { upload_id: a.uploadID, name: a.name, mime: a.mime };
    const reply = await link.call<{ message?: { id?: string } }>("gram.post", params, signal);
    const id = reply?.message?.id;
    if (!id) throw new Error("The shared agent did not confirm the posted Gram");
    if (a) forgetFile(a.path);
    await refresh(state, link);
    return id;
   }, state.life.signal);
  } catch (error) {
   if (error instanceof SendError && g === state) note(error.note);
   throw error;
  }
 },

 /** GramImage: a picture of at most 8 MiB as a data: URL, two fetched at a time. */
 async gramImage(id: string) {
  const link = gramLink(), state = g;
  const f = fileMeta(id);
  if (!f.mime.toLowerCase().startsWith("image/") || f.size > PREVIEW_MAX_BYTES) throw new Error(`${f.name} has no preview`);
  let image = state.images.get(id);
  if (!image) {
   image = (async () => {
    while (state.imageSlots === 0) await sleep(WAIT_STEP_MS, state.life.signal);
    state.imageSlots--;
    try {
     let blob: Blob;
     // A file listed with an unknown size (0) is checked on its real size, from the first chunk.
     try { blob = await fetchBlob(link, id, f.size, state.life.signal, PREVIEW_MAX_BYTES); }
     catch (error) { throw error instanceof FileTooLarge ? new Error(`${f.name} has no preview`) : error; }
     const bytes = new Uint8Array(await blob.arrayBuffer());
     return "data:" + imageMime(blob.type.startsWith("image/") ? blob.type : f.mime) + ";base64," + toBase64(bytes);
    } finally { state.imageSlots++; }
   })();
   state.images.set(id, image);
   image.catch(() => state.images.delete(id));
  }
  return image;
 },

 async gramSaveFile(id: string) { await saveFile(id); },

 /** GramOpenFile: a picture or plain text previews in the page; anything else is saved. */
 async gramOpenFile(id: string) {
  const link = gramLink();
  let f: WireFile;
  try { f = fileMeta(id); } catch (error) { note(fileError("open", error)); throw error; }
  const kind = openPlan(f.name, f.mime, f.size);
  if (kind === "save") { await saveFile(id); return; }
  try { preview(await fetchBlob(link, id, f.size, g.life.signal, kind === "image" ? PREVIEW_MAX_BYTES : TEXT_PREVIEW_MAX_BYTES), kind, f.name); }
  catch (error) {
   note(error instanceof FileTooLarge ? "Couldn't open the file: it is too large to preview here. Save it instead." : fileError("open", error));
   throw error;
  }
 },

 async gramCopyText(text: string) { await navigator.clipboard.writeText(text); },

 async gramSaved() { return savedList(); },

 async gramSetSaved(id: string, saved: boolean) {
  const list = savedList().filter(s => s.id !== id);
  if (saved) {
   const m = visible().find(v => v.id === id);
   if (!m) throw new Error("that message is not loaded");
   list.unshift({ id, text: m.text, from: m.from, fromAgent: m.direction === AGENT_TO_OWNER, createdUnixMs: m.createdUnixMs,
    ...(m.file ? { file: { name: m.file.name, mime: m.file.mime, size: m.file.size } } : {}) } as SavedGram);
  }
  localStorage.setItem(savedKey(), JSON.stringify(list));
  publish();
 },

 async panePickFiles(token: string) {
  const v = agentView(token);
  paneRecipient(v);
  const c = paneComposer(v);
  if (c.snapshot().sending) throw new Error(ERR_SENDING);
  const files = await pickFiles(true);
  agentView(token);
  if (!files.length) return;
  publishPane(token, stage(c, registerFiles(files)).note);
 },

 async paneAttachFiles(token: string, paths: string[]) {
  const v = agentView(token);
  paneRecipient(v);
  const c = paneComposer(v);
  if (c.snapshot().sending) throw new Error(ERR_SENDING);
  publishPane(token, stage(c, paths).note);
 },

 async panePasteClipboard(token: string) {
  const v = agentView(token);
  paneRecipient(v);
  const c = paneComposer(v);
  if (c.snapshot().sending) throw new Error(ERR_SENDING);
  const files = await clipboardFiles();
  if (!files.length) return false;
  publishPane(token, stage(c, registerFiles(files)).note);
  return true;
 },

 async paneRemoveAttachment(token: string, path: string) {
  const c = paneComposer(agentView(token));
  c.remove(path);
  forgetFile(path);
 },

 async paneRetryAttachment(token: string, path: string) { paneComposer(agentView(token)).retry(path); },
};

/** For tests: the save path with another in-memory cap. */
export const testing = { saveFile, stage, snapshot, reset };
