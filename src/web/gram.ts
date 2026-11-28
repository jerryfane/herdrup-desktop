// Gram and the composers' attachments in the browser: the guest paths of desk_gram.go,
// desk_guest_gram.go, desk_gram_compose.go, desk_gram_files.go, desk_clipboard.go and
// desk_interaction_compose.go over the current WebLink, and on an owner link (ownerLink.ts) the
// owner's paths of the same files: the whole store, every agent to write to, delete. Every guest
// request is its own relay connect, so the poll keeps Go's cadence (desk_guest.go guestStatusPoll:
// the list, the chat and Gram share the relay's 30 connects a minute).

import { grantKey } from "../grantKey";
import type { Desk as GoDesk, GramAgent, GramFile, GramMessage, GramSnapshot, GuestGramSnapshot, GuestGramState, SavedGram } from "../mygo";
import type { Access as TransportAccess } from "../webguest/transport";
import { emit } from "./events";
import { fileForPath, forgetFile, pickFiles, registerFiles } from "./files";
import { currentLink, onLinkChanged, type WebLink } from "./link";
import { agentView, sharedAgents, type GuestView } from "./view";
import {
 type Attachment, apiCode, Composer, displaySize, ERR_SENDING, MAX_FILE_BYTES, safeFileName, SendError, skipNote, toBase64, uploadBlob,
} from "./gramCompose";
import { sleep } from "../webguest/abort";
import { BLOB_SAVE_MAX_BYTES, type FileChunk, FileTooLarge, imageMime, openPlan, PREVIEW_MAX_BYTES, readChunks, savePlan, TEXT_PREVIEW_MAX_BYTES } from "./gramFiles";
import { acceptAnswer, AGENT_TO_OWNER, badgeCount, type GramInfo, GRAM_MAX_REFRESH_LIMIT, GRAM_PAGE_SIZE, guestGramPage, type GuestGramPage, Inbox, isUnread, owe, ownerAnswer, ownerInfo, type OwnerGramList, type OwnerGramMessage, projectGuestPage, type Recovery, type WireFile, type WriteMark } from "./gramInbox";
import { agentName } from "../gramText";
import { expireSaved, ownerAgents, ownerSavedCopies, type OwnerSavedGram, senderMachine, senderName, withSaved } from "./gramOwner";
import { ownerCall, OwnerRefusedError, type OwnerLink } from "./ownerLink";
import { SavedStore } from "./gramSaved";
import { HerdrAPIError } from "../webguest/errors";
import { paneAttachmentPrompt } from "../chatAttachments";

/** The owner's Saved list's storage key (one list, every machine); a guest's is per grant. */
const OWNER_SAVED_KEY = "herdrup.gram.saved";

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
 /** The owner link link belongs to: the owner's Gram; null for a guest's. */
 owner: OwnerLink | null;
 life: AbortController;
 inbox: Inbox;
 /** The owner's posts acknowledged but not yet in an accepted head list (gramInbox.ts). */
 pending: GramInfo[];
 phase: string;
 unavailable: string;
 refreshAck: string; refreshNote: string;
 /** Each action's failure, its own (setNote), kept in the order they happened: the newest shows in
  *  the banner, and each clears only its own (a send's next try, a delete or Saved write that
  *  lands, the next Read all), so an old one never hides a newer failure. */
 notes: Map<NoteKind, string>;
 /** This Gram's Saved list in storage (gramSaved.ts): its key is the owner's list or the grant's. */
 saved: SavedStore;
 /** By message id, rows whose expired files Saved hasn't stored yet (a refused write): tried again
  *  with the next list, unchanged or not, until stored or a newer answer shows the file live. */
 expiryOwed: Map<string, GramInfo>;
 ackToken: number;
 failures: number;
 loading: boolean; refreshQueued: boolean; refreshing: boolean;
 loadingOlder: boolean; olderError: string; pageBusy: boolean;
 markingAll: boolean; markingRead: Set<string>;
 /** This device's Gram writes (gramInbox.ts acceptAnswer), and what discarded list answers owe
  *  once none is in flight. */
 writes: WriteMark; owed: Recovery;
 /** The owed head list's waiters (a guest post's): they belong to the debt, not to a request. The
  *  head list that takes the debt (sent after the writes settled) tells them once it is answered;
  *  one discarded puts them back; the Gram's end (reset) tells whatever is left. */
 headWaiters: (() => void)[];
 badge: number;
 /** Accepted answers that set the badge from a count of the WHOLE store, so far; an unread-only
  *  walk asked before one of them is older than that count and is dropped. The rule: an answer
  *  counts here iff its count covers the whole store: an owner's head list or page (herdr's own
  *  count), or a guest head list that reached the store's end (has_more false). A guest head list
  *  cut short (has_more true) covers only its newest rows, so it never supersedes the walk. */
 counted: number;
 visible: boolean;
 wake: (() => void) | null;
 composer: Composer | null;
 lastUpload: Map<string, { state: string; fraction: number }>;
 images: Map<string, Promise<string>>;
 imageSlots: number;
}

function fresh(link: WebLink | null, visible: boolean, owner: OwnerLink | null = null): State {
 return {
  link, owner, life: new AbortController(), inbox: new Inbox(), pending: [], phase: link ? "loading" : "idle", unavailable: "",
  notes: new Map(), refreshAck: "", refreshNote: "",
  saved: new SavedStore(owner ? OWNER_SAVED_KEY : "herdrup.gram.saved." + (link?.access.guestID ?? ""), () => typeof localStorage === "undefined" ? null : localStorage), expiryOwed: new Map(),
  ackToken: 0, failures: 0,
  loading: false, refreshQueued: false, refreshing: false, loadingOlder: false, olderError: "", pageBusy: false,
  markingAll: false, markingRead: new Set(), writes: { inFlight: 0, started: 0 }, owed: { head: false, badge: false }, headWaiters: [], badge: 0, counted: 0, visible, wake: null, composer: null,
  lastUpload: new Map(), images: new Map(), imageSlots: 2,
 };
}

let g: State = fresh(null, false);

/** Multi-grant browser guest Gram source (wired by src/web/mygo.ts from desk.ts): provides all
 *  held grants in this browser and opens lightweight background links for sibling grants so Guest
 *  Gram aggregates every shared agent (matching desktop's app/desk_guest_gram_hub.go). */
export interface GuestGrantSource {
 listGrants(): Promise<TransportAccess[]>;
 openGrant(grant: TransportAccess): Promise<{ link: WebLink; close(): void }>;
 onChange(f: () => void): () => void;
}
interface HubEntry {
 id: string;
 state: State;
 link: WebLink;
 agentName: string;
 ready: boolean;
 gram: boolean;
 error: string;
 close: () => void;
}
let guestSource: GuestGrantSource | null = null;
let guestSourceOff: (() => void) | null = null;
const guestHub = new Map<string, HubEntry>();
let guestOrder: string[] = [];
let guestRecipient = "";
let hubSyncVersion = 0;

export function setGuestGramSource(source: GuestGrantSource | null): void {
 guestSourceOff?.();
 guestSourceOff = null;
 guestSource = source;
 if (source) guestSourceOff = source.onChange(() => { if (g.link && !g.owner) void syncGuestHub(); });
 if (g.link && !g.owner) void syncGuestHub();
}

function isLive(state: State): boolean {
 if (state === g) return true;
 for (const entry of guestHub.values()) if (entry.state === state) return true;
 return false;
}

function hubEntryFor(state: State): HubEntry | null {
 for (const entry of guestHub.values()) if (entry.state === state) return entry;
 return null;
}

function agentNameFor(state: State, link: WebLink): string {
 if (state === g) return sharedAgentName() || link.access.agentName;
 const entry = hubEntryFor(state);
 return (entry?.agentName || link.access.agentName).trim();
}

function closeHubEntry(entry: HubEntry) {
 entry.state.life.abort(new Error(NOT_CONNECTED));
 for (const w of entry.state.headWaiters.splice(0)) w();
 for (const p of entry.state.composer?.paths() ?? []) forgetFile(p);
 entry.state.composer?.close();
 entry.close();
}

function clearGuestHub() {
 hubSyncVersion++;
 for (const entry of guestHub.values()) closeHubEntry(entry);
 guestHub.clear();
 guestOrder = [];
 guestRecipient = "";
}

async function discoverAndWatch(entry: HubEntry) {
 const signal = entry.state.life.signal;
 try {
  const result = await entry.link.call<{ agents?: { name?: string; terminal_id?: string; pane_id?: string }[] }>("agent.list", {}, signal);
  if (guestHub.get(entry.id) !== entry || signal.aborted) return;
  const target = entry.link.access.agentTarget;
  const agents = Array.isArray(result?.agents) ? result.agents : [];
  const matched = agents.find(a => a.terminal_id === target || a.pane_id === target) ?? agents[0];
  if (matched?.name && matched.name.trim() !== "") entry.agentName = matched.name.trim();
  entry.ready = true;
  entry.error = "";
  entry.gram = entry.link.features().gram;
  publish();
  if (entry.gram) void watch(entry.state, entry.link);
 } catch (error) {
  if (guestHub.get(entry.id) !== entry || signal.aborted) return;
  entry.ready = true;
  entry.error = error instanceof Error ? error.message : String(error);
  publish();
 }
}

async function syncGuestHub() {
 const source = guestSource;
 const activeLink = g.owner ? null : g.link;
 if (!source || !activeLink) return;
 const at = ++hubSyncVersion;
 const activeID = grantKey(activeLink.access);
 let grants: TransportAccess[];
 try { grants = await source.listGrants(); } catch { return; }
 if (at !== hubSyncVersion || g.owner || g.link !== activeLink) return;
 const wanted = new Set<string>();
 const order: string[] = [];
 for (const grant of grants) {
  const id = grantKey(grant);
  if (wanted.has(id)) continue;
  wanted.add(id);
  order.push(id);
 }
 if (!wanted.has(activeID)) order.unshift(activeID);
 guestOrder = order;
 for (const [id, entry] of [...guestHub.entries()]) {
  if (id === activeID || !wanted.has(id)) {
   guestHub.delete(id);
   closeHubEntry(entry);
  }
 }
 if (guestRecipient !== "" && guestRecipient !== activeID && !wanted.has(guestRecipient)) guestRecipient = "";
 const toOpen = grants.filter(grant => {
  const id = grantKey(grant);
  return id !== activeID && !guestHub.has(id);
 });
 publish();
 await Promise.all(toOpen.map(async grant => {
  const id = grantKey(grant);
  let opened: { link: WebLink; close(): void };
  try { opened = await source.openGrant(grant); } catch { return; }
  if (at !== hubSyncVersion || g.owner || g.link !== activeLink || guestHub.has(id)) {
   opened.close();
   return;
  }
  const state = fresh(opened.link, g.visible, null);
  state.composer = newComposer(state);
  const entry: HubEntry = {
   id, state, link: opened.link, agentName: grant.agentName,
   ready: false, gram: false, error: "", close: opened.close,
  };
  guestHub.set(id, entry);
  publish();
  void discoverAndWatch(entry);
 }));
}

/** The link when state shares Gram (an owner's always does); else rejects as gramEngine does. */
function gramLinkFor(state: State = g): WebLink {
 const link = state.link;
 if (!link) throw new Error(NOT_CONNECTED);
 if (!state.owner && !link.features().gram) throw new Error(NOT_SHARED);
 return link;
}

/** Resolves which grant's State owns a message/file key ("<grant>\x1f<id>"); falls back to g. */
function stateForKey(key: string): State {
 if (!g.owner && key.includes(SEP)) {
  const grantID = key.slice(0, key.indexOf(SEP));
  if (g.link && grantKey(g.link.access) === grantID) return g;
  const entry = guestHub.get(grantID);
  if (entry) return entry.state;
 }
 return g;
}

/** Resolves the State the guest Gram composer currently posts to (guestRecipient, else active/first). */
function recipientState(): State {
 if (g.owner || !g.link) return g;
 const activeID = grantKey(g.link.access);
 if (guestRecipient === activeID) return g;
 if (guestRecipient !== "") {
  const entry = guestHub.get(guestRecipient);
  if (entry?.gram) return entry.state;
 }
 if (g.link.features().gram) return g;
 for (const id of guestOrder) {
  const entry = guestHub.get(id);
  if (entry?.gram) return entry.state;
 }
 return g;
}

/** All live guest States matching the optional grants filter (every Gram-sharing grant when empty). */
function guestTargetStates(grants?: readonly string[]): State[] {
 if (g.owner || !g.link) return [];
 const activeID = grantKey(g.link.access);
 const filter = grants && grants.length > 0 ? new Set(grants) : null;
 const out: State[] = [];
 const seen = new Set<string>();
 const consider = (id: string, state: State, gram: boolean) => {
  if (seen.has(id) || !gram || (filter && !filter.has(id))) return;
  seen.add(id);
  out.push(state);
 };
 for (const id of guestOrder) {
  if (id === activeID) consider(id, g, g.link.features().gram);
  else {
   const entry = guestHub.get(id);
   if (entry) consider(id, entry.state, entry.gram);
  }
 }
 consider(activeID, g, g.link.features().gram);
 for (const [id, entry] of guestHub) consider(id, entry.state, entry.gram);
 return out;
}

/** gramAnswer: the owner's gram.list as it is (gramstore.FromList), a guest's through its projection
 *  (desk_guest_gram.go). An owner's unread-only list is one call, as Go's; its head list is
 *  conditional on the held digest (gram_list_unchanged keeps every page held). */
async function gramAnswer(state: State, link: WebLink, limit: number, unreadOnly: boolean, before?: string) {
 const signal = state.life.signal;
 if (state.owner) {
  const params: Record<string, unknown> = unreadOnly ? { unread_only: true } : { limit };
  if (before) params.before_id = before;
  const digest = state.inbox.conditionalDigest();
  if (!unreadOnly && !before && digest !== "") params.if_unchanged_digest = digest;
  return { answer: ownerAnswer(await link.call<OwnerGramList>("gram.list", params, signal)), error: undefined };
 }
 const list = (n: number, cursor?: string) => link.call<GuestGramPage>("gram.list", cursor ? { limit: n, before_id: cursor } : { limit: n }, signal);
 const { page, error } = await guestGramPage(list, limit, unreadOnly, before);
 if (error !== undefined && page.messages.length === 0) throw error;
 return { answer: projectGuestPage(page, agentNameFor(state, link), unreadOnly), error };
}

// ---- Snapshot ----

function gramFile(f: WireFile | undefined): GramFile | undefined {
 if (!f) return undefined;
 const mime = f.mime || "application/octet-stream", image = mime.toLowerCase().startsWith("image/");
 return { name: f.name, mime, size: f.size, sizeLabel: displaySize(f.size), isImage: image, preview: image && f.size <= PREVIEW_MAX_BYTES };
}

/** gramRow (desk_gram.go:516-548). A guest's message has no claim nor machine label, so its sender
 *  reads as from and its machine as from's alias or local. */
export function gramRow(m: GramInfo, local: string, saved: boolean, pending: boolean): GramMessage {
 const fromAgent = m.direction === AGENT_TO_OWNER;
 const r: GramMessage = {
  id: m.id, fromAgent, from: m.from, name: agentName(m.from), senderName: senderName(m), machine: "", text: m.text,
  createdUnixMs: m.createdUnixMs, unread: isUnread(m), saved, pending,
 };
 if (m.file) { r.file = gramFile(m.file); r.attachmentPreview = m.file.name; }
 else if (m.expiredFile) { r.expiredFile = gramFile(m.expiredFile); r.attachmentPreview = m.expiredFile.name + " (expired)"; }
 if (m.to) r.to = m.to;
 if (m.grabbedBy) r.grabbedBy = m.grabbedBy;
 if (fromAgent) {
  r.machine = senderMachine(m) || local;
  return r;
 }
 if (r.grabbedBy) { r.statusVerb = "Grabbed"; r.statusRest = "by " + agentName(r.grabbedBy); }
 else if (r.to) { r.statusVerb = "Delivered"; r.statusRest = "to " + agentName(r.to); }
 else { r.statusVerb = "Unclaimed"; r.statusRest = "in the shared queue"; }
 return r;
}

/** visibleLocked: your posts not yet listed, then the list (which leaves out deleted messages). */
function visible(state: State = g): GramInfo[] {
 const ids = new Set(state.pending.map(m => m.id));
 return [...state.pending, ...state.inbox.messages.filter(m => !ids.has(m.id))];
}

function snapshot(state: State = g): GramSnapshot {
 const saved = savedView(state);
 const pendingIDs = new Set(state.pending.map(m => m.id));
 const local = state.link?.access.machineLabel ?? "";
 const s: GramSnapshot = {
  phase: state.phase || "idle", messages: [], unreadCount: state.badge, hasMore: state.inbox.hasMore, loadingOlder: state.loadingOlder,
  refreshing: state.refreshing, markingAllRead: state.markingAll, agents: [], saved: saved.shown, localMachine: local,
  attachments: [], sending: false, sendProgress: 0, sendProgressShown: false, draftPosted: 0, visible: state.visible,
 };
 if (state.unavailable) s.unavailable = state.unavailable;
 if (state.olderError) s.olderError = state.olderError;
 const status = banner(state);
 if (status) s.status = status;
 const feed = visible(state);
 for (const m of feed) s.messages.push(gramRow(m, local, saved.ids.has(m.id), pendingIDs.has(m.id)));
 if (state.owner) s.agents = ownerAgents(feed, state.owner.agents(), local);
 else {
  const seen = new Set<string>();
  for (const row of s.messages) {
   if (row.fromAgent && !seen.has(row.from)) { seen.add(row.from); s.agents.push({ from: row.from, name: row.name, machine: row.machine } satisfies GramAgent); }
  }
 }
 if (state.composer) {
  const c = state.composer.snapshot();
  s.sending = c.sending; s.draftPosted = c.draftPosted;
  s.sendProgress = c.progress ?? 0; s.sendProgressShown = c.progress !== null;
  s.attachments = c.chips;
 }
 return s;
}

function publish() {
 const s = snapshot(g);
 emit("gramChanged", s);
 emit("guestGramChanged", guestSnapshot(s));
}

// ---- The guest's one Gram (#697, desk_guest_gram_hub.go) over all held browser grants ----

const SEP = "\u001f";
/** A message id the page knows ("<grant>\x1f<id>") as this grant's own. */
function own(id: string): string { return id.includes(SEP) ? id.slice(id.indexOf(SEP) + 1) : id; }
/** A message's id as the page knows it in the guest's Gram ("<grant>\x1f<id>"); the owner's as it is. */
function shownID(id: string, state: State = g): string { return state.link && !state.owner ? grantKey(state.link.access) + SEP + id : id; }
/** A key the page passed, as download events name it: a prefixed key as it is, a bare id shownID. */
function shownKey(key: string, state: State = g): string { return key.includes(SEP) ? key : shownID(key, state); }
/** The machine an owner's key names (a Saved row's "<hostID>\x1f<id>"); null for a feed row's. */
function keyHost(key: string): string | null { return g.owner && key.includes(SEP) ? key.slice(0, key.indexOf(SEP)) : null; }
/** An owner's saved copy's key on the page: its machine with its id. */
function savedRowKey(s: OwnerSavedGram): string { return s.hostID + SEP + s.id; }

function prefixGuestSnap(s: GramSnapshot, id: string): GramSnapshot {
 const prefix = id + SEP;
 return { ...s, messages: s.messages.map(m => ({ ...m, id: prefix + m.id })) };
}

function guestSnapshot(activeSnap: GramSnapshot = snapshot(g)): GuestGramSnapshot {
 const link = g.owner ? null : g.link;
 if (!link) return { active: false, grants: [], recipient: "", saved: activeSnap.saved };
 const activeID = grantKey(link.access);
 const grants: GuestGramState[] = [];
 const savedAll: SavedGram[] = [];
 const seen = new Set<string>();
 const addActive = () => {
  if (seen.has(activeID)) return;
  seen.add(activeID);
  const access = link.access;
  const gram = link.features().gram;
  grants.push({
   grant: { id: activeID, agent: sharedAgentName() || access.agentName, owner: access.ownerName, machine: access.machineLabel, terminal: access.agentTarget, gram, ready: true },
   gram: prefixGuestSnap(activeSnap, activeID),
  });
  savedAll.push(...activeSnap.saved);
 };
 const addEntry = (entry: HubEntry) => {
  if (seen.has(entry.id)) return;
  seen.add(entry.id);
  const access = entry.link.access;
  const snap = snapshot(entry.state);
  grants.push({
   grant: {
    id: entry.id, agent: entry.agentName || access.agentName, owner: access.ownerName,
    machine: access.machineLabel, terminal: access.agentTarget, gram: entry.gram, ready: entry.ready,
    ...(entry.error ? { error: entry.error } : {}),
   },
   gram: prefixGuestSnap(snap, entry.id),
  });
  savedAll.push(...snap.saved);
 };
 for (const id of guestOrder) {
  if (id === activeID) addActive();
  else {
   const entry = guestHub.get(id);
   if (entry) addEntry(entry);
  }
 }
 addActive();
 for (const entry of guestHub.values()) addEntry(entry);
 savedAll.sort((a, b) => (b.createdUnixMs ?? 0) - (a.createdUnixMs ?? 0));
 const recipientEntry = grants.find(item => item.grant.id === guestRecipient && item.grant.gram)
  ?? grants.find(item => item.grant.id === activeID && item.grant.gram)
  ?? grants.find(item => item.grant.gram);
 return {
  active: true,
  recipient: recipientEntry?.grant.id ?? "",
  saved: savedAll,
  grants,
 };
}

/** The Desk calls the guest's one Gram makes (desk_guest_gram_hub.go) across all held grants. */
export const guestGramDesk: Partial<DeskFns> = {
 guestGramState: async () => guestSnapshot(),
 async guestGramSetVisible(shown: boolean) {
  await setVisibleOn(g, shown);
  for (const entry of guestHub.values()) await setVisibleOn(entry.state, shown);
 },
 async guestGramSetRecipient(grant: string) {
  if (!g.link || g.owner) throw new Error(NOT_CONNECTED);
  const activeID = grantKey(g.link.access);
  if (grant === activeID) {
   if (!g.link.features().gram) throw new Error("This shared agent doesn't share Gram");
   guestRecipient = grant;
   publish();
   return;
  }
  const entry = guestHub.get(grant);
  if (!entry || !entry.gram) throw new Error("This shared agent doesn't share Gram");
  guestRecipient = grant;
  publish();
 },
 async guestGramLoadOlder(grants: string[]) {
  const targets = guestTargetStates(grants);
  if (targets.length === 0) return false;
  let grew = false;
  for (const state of targets) {
   if (await loadOlderOn(state)) grew = true;
  }
  return grew;
 },
 async guestGramRefresh(grants?: string[]) {
  const targets = guestTargetStates(grants);
  await Promise.all(targets.map(state => refresh(state, gramLinkFor(state))));
 },
 async guestGramMarkAllRead(grants?: string[]) {
  const targets = guestTargetStates(grants);
  await Promise.all(targets.map(state => markAllReadOn(state)));
 },
};

/** The actions whose failure the banner says (State.notes). */
type NoteKind = "send" | "delete" | "saved" | "markAll";
/** The banner's text: the newest action failure (State.notes), else the refresh's word. */
const banner = (state: State) => [...state.notes.values()].at(-1) ?? [state.refreshAck, state.refreshNote].find(t => t !== "");
/** Sets kind's note, the newest now ("" clears it); true when that changed the banner (the caller
 *  publishes then): the same text moved to newest can change which note shows. */
function setNote(state: State, kind: NoteKind, text: string): boolean {
 const before = banner(state);
 state.notes.delete(kind);
 if (text !== "") state.notes.set(kind, text);
 return banner(state) !== before;
}
function note(text: string, state: State = g) { if (setNote(state, "send", text)) publish(); }

function ack(text: string, expiring: boolean, state: State = g) {
 state.refreshAck = text;
 if (!text || !expiring) return;
 const token = ++state.ackToken;
 setTimeout(() => { if (isLive(state) && state.ackToken === token && state.refreshAck === text) { state.refreshAck = ""; publish(); } }, GRAM_ACK_MS);
}

// ---- Loads ----

/** A head load's outcome; "discarded": its answer overlapped a write (acceptAnswer). */
type Outcome = "unchanged" | "updated" | "failed" | "discarded";

/** gramLoadLocked: one head load covering what is held, entered with loading set. */
async function loadHead(state: State, link: WebLink): Promise<Outcome> {
 if (state.inbox.hasLoaded && state.phase === "loading") state.phase = "loaded";
 if (!state.inbox.hasLoaded && visible(state).length === 0) state.phase = "loading";
 const limit = Math.min(Math.max(GRAM_PAGE_SIZE, state.inbox.messages.length), GRAM_MAX_REFRESH_LIMIT);
 publish();
 const sent = { ...state.writes };
 // A head list sent with no write in flight is the one an owed head list waits for: it takes the
 // debt (and the posts waiting on it) whether a recovery or anything else started it.
 const debt = state.writes.inFlight === 0 && state.owed.head ? takeOwedHead(state) : [];
 try { return await headAnswer(state, link, limit, sent, debt); }
 finally {
  // What the debt still holds was answered (or failed, or the Gram ended): those posts settle.
  for (const w of debt.splice(0)) w();
  // A head that failed or was dropped leaves an owed one owed: recover looks again.
  queueMicrotask(() => recover(state));
 }
}

/** The owed head list as taken by a head list being sent: no longer owed, its waiters returned. */
function takeOwedHead(state: State): (() => void)[] {
 state.owed = { ...state.owed, head: false };
 return state.headWaiters.splice(0);
}

/** A head list sent at `sent`, holding `debt` (the owed head list's waiters, if it took them), and
 *  what its answer does. */
async function headAnswer(state: State, link: WebLink, limit: number, sent: WriteMark, debt: (() => void)[]): Promise<Outcome> {
 let answer, error: unknown;
 try { ({ answer } = await gramAnswer(state, link, limit, false)); } catch (e) { error = e ?? new Error("Gram list failed"); }
 if (!isLive(state)) return "unchanged";
 // Discarded (it overlapped a write): it owes a head list again, and the debt it took goes back
 // with its waiters now, before its slot is released or a replacement can start; whichever head
 // list next takes the debt takes them.
 const discarded = answer !== undefined && !acceptAnswer(sent, state.writes);
 if (discarded) {
  state.owed = owe(state.owed, "head");
  state.headWaiters.unshift(...debt.splice(0));
 }
 state.loading = false;
 const queued = state.refreshQueued;
 state.refreshQueued = false;
 if (queued) queueMicrotask(() => void refresh(state, link));
 if (discarded) { queueMicrotask(() => recover(state)); publish(); return "discarded"; }
 if (!answer) {
  state.failures++;
  const empty = visible(state).length === 0, unavailable = apiCode(error) === "gram_unavailable";
  if (unavailable && empty) { state.phase = "unavailable"; state.unavailable = NOT_DEPLOYED; }
  else if (unavailable) state.refreshNote = UNAVAILABLE_NOW;
  else if (empty) { state.phase = "unavailable"; state.unavailable = NOT_DEPLOYED_OR_LOST; }
  else state.refreshNote = REFRESH_FAILED;
  publish();
  return "failed";
 }
 const changed = state.inbox.apply(answer);
 state.phase = "loaded"; state.unavailable = ""; state.refreshNote = ""; state.failures = 0;
 // Accepted, it was sent with no write in flight and none started since: after every post's
 // acknowledgement. The posts it lists show as listed; one it doesn't was deleted elsewhere.
 state.pending = [];
 if (headWritesBadge(state)) {
  state.badge = state.inbox.unreadCount();
  if (state.owner || !answer.hasMore) state.counted++;
 }
 publish();
 // Its expired files reach Saved after the list is in (Saved changes take their lock).
 await expireOwnerSaved(state, answer.messages);
 return changed ? "updated" : "unchanged";
}

async function load(state: State, link: WebLink) {
 if (state.loading) return;
 state.loading = true;
 await loadHead(state, link);
}

/** gramRefresh: never dropped; a tap during a load runs after it. */
async function refresh(state: State, link: WebLink) {
 if (!isLive(state)) return;
 if (state.loading) { state.refreshQueued = true; ack("Refreshing…", false, state); publish(); return; }
 state.loading = true; state.refreshing = true;
 const outcome = await loadHead(state, link);
 if (!isLive(state)) return;
 state.refreshing = false;
 ack(outcome === "unchanged" ? "Up to date" : outcome === "updated" ? "Refreshed" : "", true, state);
 publish();
}

/** gramBadge: an unread-only list while Gram does not show; the owner's counts the whole store. A
 *  guest's walk counts only once its last page said has_more false: one that stopped short (a page
 *  that failed, an empty page or a cursor that didn't advance while has_more was still true)
 *  publishes nothing and the badge stays as it is. */
async function badge(state: State, link: WebLink) {
 const sent = { ...state.writes }, counted = state.counted;
 let answer;
 try { ({ answer } = await gramAnswer(state, link, 0, true)); } catch { return; }
 if (!state.owner && answer.hasMore) return;
 if (!isLive(state) || !accepted(state, sent, "badge")) return;
 // A head list or page accepted since this was asked set a newer count.
 if (state.counted !== counted) return;
 const n = badgeCount(answer);
 if (state.badge === n) return;
 state.badge = n;
 publish();
}

/** A write (mark-read, delete, post), in flight while herdr has it: list answers overlapping it are
 *  discarded (acceptAnswer). A batch (Read all) wraps its writes in one, so it stays in flight from
 *  its first call to its last. Once none is in flight, what the discards owe goes out (recover). */
async function writing<T>(state: State, write: () => Promise<T>): Promise<T> {
 state.writes.inFlight++; state.writes.started++;
 try { return await write(); }
 finally {
  state.writes.inFlight--;
  queueMicrotask(() => recover(state));
 }
}

/** Whether a list answer of `kind` whose request was sent at `sent` comes in (acceptAnswer). A
 *  discarded one owes the same kind of list (owe): now, or once the writes in flight settle. */
function accepted(state: State, sent: WriteMark, kind: "head" | "page" | "badge"): boolean {
 if (acceptAnswer(sent, state.writes)) return true;
 state.owed = owe(state.owed, kind);
 queueMicrotask(() => recover(state));
 return false;
}

/** Whether the held list's count may be the badge (gramInbox.ts): the owner's always (its lists
 *  carry the store's count); a guest's only while Gram shows, the hidden tab's badge being the
 *  unread walk's alone. */
const headWritesBadge = (state: State) => state.owner !== null || state.visible;

/** Once no write is in flight, the lists the discards owe go out, each once. An owed head list
 *  stays owed until a head list starts after the writes (loadHead takes it); one already out when
 *  they settled was sent during them, so recover looks again when it is done. */
function recover(state: State) {
 const link = state.link;
 if (!isLive(state) || !link || state.writes.inFlight > 0) return;
 if (state.owed.head && !state.loading) void load(state, link);
 if (state.owed.badge) { state.owed = { ...state.owed, badge: false }; void badge(state, link); }
}

/** Whether state's link shares Gram: an owner's always, a guest's as its grant says. */
const shares = (state: State, link: WebLink) => state.owner !== null || link.features().gram;

/** watchGram: polls while the link shares Gram; stops (checking only the features the link's other
 *  calls refresh) while it does not, so a share-gram switch turned off costs no connects. A change
 *  in sharing publishes on its own (the Gram tab comes and goes with it), whatever the unread count:
 *  an empty inbox's badge read publishes nothing. */
async function watch(state: State, link: WebLink) {
 let sharing = false;
 while (isLive(state) && !state.life.signal.aborted) {
  let wait = GRAM_POLL_BADGE_MS;
  if (shares(state, link)) {
   if (state.visible) {
    await load(state, link);
    wait = state.failures > 0 ? GRAM_POLL_FAILING_MS : GRAM_POLL_VISIBLE_MS;
   } else {
    await badge(state, link);
    // Gram opened while that list was out (its wake wasn't set yet): load it now, not a hidden
    // tab's interval later.
    if (isLive(state) && state.visible) continue;
   }
  } else if (state.phase !== "idle") {
   state.phase = "idle"; state.unavailable = "";
   state.composer?.pause();
   publish();
  }
  if (isLive(state) && shares(state, link) !== sharing) {
   sharing = shares(state, link);
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
  const link = gramLinkFor(state);
  progress(0, a.size);
  return uploadBlob((method, params, s) => link.call(method, params, s), a.blob, signal, sent => progress(sent, a.size));
 }, id => { void state.link?.call("gram.upload.discard", { upload_id: id }).catch(() => undefined); }, path => composerChanged(state, path));
 return c;
}

/** gramComposerChanged: the upload event at most once a percent, the snapshot on a state change. */
function composerChanged(state: State, path: string) {
 if (!isLive(state) || !state.composer) return;
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

function gramComposer(state: State = recipientState()): Composer {
 gramLinkFor(state);
 if (!state.composer) throw new Error(NOT_CONNECTED);
 return state.composer;
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
    const reply = await writing(g, () => link.call<{ message?: { id?: string } }>("gram.post", {
     text: "Attachment from " + link.access.guestName + ".", to: recipient, file: { upload_id: a.uploadID, name: a.name, mime: a.mime },
    }, signal));
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

/** A saved copy's file on a machine other than the open one: its message can only come from there,
 *  so the message names that machine instead of asking this one for another's id. */
class ElsewhereFile extends Error {}

/** The file of the message a page key names. An owner's Saved row key carries its copy's machine
 *  ("<hostID>\x1f<id>", savedRowKey): that copy is the one meant, whatever the open feed holds under the
 *  same id (herdr ids are not unique across machines), and a copy of another machine names it. A
 *  bare key is the open machine's message (its feed row, else its saved copy), never another
 *  machine's copy that happens to share the id. */
function fileMeta(key: string, state: State = stateForKey(key)): WireFile {
 const id = own(key);
 if (!state.owner) {
  const f = visible(state).find(v => v.id === id)?.file ?? guestSavedList(state).find(s => s.id === id)?.file;
  if (!f) throw new Error("that message has no file");
  return f as WireFile;
 }
 const open = state.owner.machine.hostID, host = keyHost(key) ?? open;
 if (host === open) {
  const m = visible(state).find(v => v.id === id);
  if (m?.file) return m.file;
 }
 const copy = ownerSavedList(state).find(s => s.id === id && s.hostID === host && s.file);
 if (!copy) throw new Error("that message has no file");
 if (host !== open) throw new ElsewhereFile(`${copy.file!.name} is on ${copy.machine}. Open ${copy.machine} to get it.`);
 return copy.file as WireFile;
}

/** The whole file in memory, with download events (gramDownload, under the key the page asked
 *  with); a file over maxSize (a preview's cap) stops at the first chunk with FileTooLarge.
 *  `first`: offset 0, already read. */
async function fetchBlob(link: WebLink, key: string, size: number, signal?: AbortSignal, maxSize?: number, first?: FileChunk, state: State = stateForKey(key)): Promise<Blob> {
 const parts: Uint8Array<ArrayBuffer>[] = [];
 const progress = (done: number, st: string) => emit("gramDownload", { id: shownKey(key, state), done, size, state: st, label: displaySize(Math.min(done, size)) + " of " + displaySize(size) });
 const read = chunkOf(link, own(key), signal);
 progress(0, "downloading");
 try {
  const { mime } = await readChunks(offset => offset === 0 && first ? Promise.resolve(first) : read(offset), size, p => { parts.push(p); }, done => progress(done, "downloading"), signal, maxSize);
  progress(size, "done");
  return new Blob(parts, { type: mime });
 } catch (error) { progress(size, "failed"); throw error; }
}

/** gramFileError. */
function fileError(verb: string, error: unknown): string {
 if (error instanceof ElsewhereFile) return error.message;
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
 *  BLOB_SAVE_MAX_BYTES (refused before anything downloads). Failures go to Gram's banner. */
async function saveFile(key: string, saveMaxBytes = BLOB_SAVE_MAX_BYTES) {
 const state = stateForKey(key);
 let f: WireFile;
 try { f = fileMeta(key, state); } catch (error) { note(fileError("save", error), state); throw error; }
 try { await writeFile(gramLinkFor(state), key, f, saveMaxBytes, state); }
 catch (error) { note(error instanceof SaveRefused ? error.message : fileError("save", error), state); throw error; }
}

/** A save the browser can't do (savePlan "too-large"); its message is the note. */
class SaveRefused extends Error {}

/** The save itself, reporting nothing: its callers say where a failure shows. */
async function writeFile(link: WebLink, key: string, f: WireFile, saveMaxBytes = BLOB_SAVE_MAX_BYTES, state: State = stateForKey(key)) {
 // File System Access is not in TypeScript's DOM library yet.
 const picker = Reflect.get(globalThis, "showSaveFilePicker") as SaveFilePicker | undefined;
 const plan = savePlan(f.size, !!picker, saveMaxBytes);
 if (plan.kind === "too-large") throw new SaveRefused(plan.note);
 if (plan.kind === "blob") { downloadBlob(await fetchBlob(link, key, f.size, state.life.signal, undefined, undefined, state), f.name); return; }
 let handle;
 // The picker opens in Downloads, as the desktop's save dialog does.
 try { handle = await picker!({ suggestedName: safeFileName(f.name), startIn: "downloads" }); }
 catch (error) { if (error instanceof DOMException && error.name === "AbortError") return; throw error; }
 const out = await handle.createWritable();
 const progress = (done: number, st: string) => emit("gramDownload", { id: shownKey(key, state), done, size: f.size, state: st, label: displaySize(Math.min(done, f.size)) + " of " + displaySize(f.size) });
 try {
  progress(0, "downloading");
  await readChunks(chunkOf(link, own(key), state.life.signal), f.size, p => out.write(p), done => progress(done, "downloading"), state.life.signal);
  await out.close();
  progress(f.size, "done");
 } catch (error) { progress(f.size, "failed"); await out.abort().catch(() => undefined); throw error; }
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

// ---- Saved Grams (per guest, in this browser; the owner's one list, as the desktop's
// saved-grams.json, on every machine, each copy naming its machine) ----

/** The stored Saved list as this document renders it: decoded once per Gram (Go's Saved loads
 *  once), read again after another document's change (the storage event) and replaced by this
 *  one's own (gramSaved.ts). */
function storedSaved(state: State = g): unknown { return state.link ? state.saved.read() : []; }
/** The owner's copies, each with its machine (ownerSavedCopies drops any without); [] for a guest. */
function ownerSavedList(state: State = g): OwnerSavedGram[] { return state.owner ? ownerSavedCopies(storedSaved(state)) : []; }
/** The guest's own list, in SavedGram's format; [] for the owner. */
function guestSavedList(state: State = g): SavedGram[] {
 const stored = state.owner ? [] : storedSaved(state);
 return Array.isArray(stored) ? stored as SavedGram[] : [];
}
/** Changes the saved list as storage holds it now (another document may have changed it since
 *  this one read it), under the Saved lock (gramSaved.ts): mutate gets that list, null for no
 *  change. A refused write (quota, private mode) is said in the banner, as Go's alertSaved, and
 *  returned; one that lands clears that note. bannerChanged: whether that changed the banner. The
 *  caller publishes. */
async function updateSaved(state: State, mutate: (current: unknown) => unknown): Promise<{ failed: Error | null; bannerChanged: boolean }> {
 const failed = await state.saved.update(mutate);
 return { failed, bannerChanged: setNote(state, "saved", failed?.message ?? "") };
}
/** Saved.ExpireFiles for an owner's list answer (a head load or an older page), with what an
 *  earlier one couldn't store; nothing to do, and Saved not read, when none has an expired file. */
async function expireOwnerSaved(state: State, messages: readonly GramInfo[]) {
 const owner = state.owner;
 if (!owner || g !== state) return;
 // One pending expiry per message, as its newest accepted answer has it: an expired file is owed
 // until Saved stores it; a live one (a backup restored) cancels what was owed.
 for (const m of messages) {
  if (m.expiredFile) state.expiryOwed.set(m.id, m);
  else if (m.file) state.expiryOwed.delete(m.id);
 }
 if (state.expiryOwed.size === 0) return;
 let moved = false, due: GramInfo[] = [];
 const { failed, bannerChanged } = await updateSaved(state, current => {
  // This Gram's link ended while it waited for the lock: what it owed is obsolete (the next link
  // lists the store afresh, a file live again included), so nothing is written.
  if (g !== state) return null;
  // Read under the lock, right before the write: a newer answer that came while this waited for
  // the lock (another tab holding it) has already dropped what it showed live.
  due = [...state.expiryOwed.values()];
  const next = expireSaved(ownerSavedCopies(current), due, owner.machine.hostID);
  moved = next !== null;
  return next;
 });
 // Stored: no longer owed, unless a newer answer replaced the row meanwhile. Not stored (the lock
 // or storage refused): still owed, so the next list tries again (an unchanged one included).
 if (!failed) for (const m of due) if (state.expiryOwed.get(m.id) === m) state.expiryOwed.delete(m.id);
 if ((moved || bannerChanged) && g === state) publish();
}
/** The saved list as the page knows it, decoded once: ids as its messages' and download events'
 *  ("<grant>\x1f<id>", shownID), so a Saved row's transfer state is the one its downloads report
 *  (herdrup #723); the browser keeps them by the grant's own ids, and the calls that take one read
 *  it back with own(). An owner's copy is keyed by its machine and id (savedRowKey), as ids repeat
 *  across machines, and marks a feed row saved only on the machine it was saved from. */
function savedView(state: State = g): { ids: Set<string>; shown: SavedGram[] } {
 if (!state.owner) {
  const list = guestSavedList(state);
  return { ids: new Set(list.map(s => s.id)), shown: list.map(s => ({ ...s, id: shownID(s.id, state) })) };
 }
 const host = state.owner.machine.hostID, list = ownerSavedList(state);
 return {
  ids: new Set(list.filter(s => s.hostID === host).map(s => s.id)),
  shown: list.map(s => {
   const { hostID: _host, machine: _machine, ...shown } = s;
   return { ...shown, id: savedRowKey(s) };
  }),
 };
}

// ---- Desk ----

/** A new link starts a new Gram: a guest's, or the owner's when the link comes with its owner
 *  context (desk.ts publishes both together). */
function reset(link: WebLink | null, owner: OwnerLink | null = null) {
 clearGuestHub();
 g.life.abort(new Error(NOT_CONNECTED));
 // The link's end settles the posts still waiting on an owed head list (none will be sent).
 for (const w of g.headWaiters.splice(0)) w();
 for (const p of g.composer?.paths() ?? []) forgetFile(p);
 g.composer?.close();
 for (const token of [...panes.keys()]) closePaneComposer(token);
 g = fresh(link, g.visible, owner);
 if (link) {
  g.composer = newComposer(g);
  void watch(g, link);
  if (!owner) void syncGuestHub();
 }
 publish();
}
onLinkChanged(reset);
// Another document of this browser changed Saved (or cleared storage): this one's copy goes, and
// the next snapshot reads the stored list again. A document's own writes don't fire the event.
if (typeof addEventListener === "function") {
 addEventListener("storage", (event: StorageEvent) => {
  let dropped = false;
  if (g.link && (event.key === null || event.key === g.saved.key)) { g.saved.drop(); dropped = true; }
  for (const entry of guestHub.values()) {
   if (event.key === null || event.key === entry.state.saved.key) { entry.state.saved.drop(); dropped = true; }
  }
  if (dropped) publish();
 });
}

async function setVisibleOn(state: State, shown: boolean) {
 if (state.visible === shown) return;
 state.visible = shown;
 publish();
 if (shown) state.composer?.resume(); else state.composer?.pause();
 state.wake?.();
}

async function loadOlderOn(state: State): Promise<boolean> {
 const link = gramLinkFor(state);
 while (state.pageBusy) await sleep(WAIT_STEP_MS, state.life.signal);
 state.pageBusy = true; state.loadingOlder = true; state.olderError = "";
 publish();
 try {
  for (let round = 0; round < 2; round++) {
   for (let i = 0; i < WAIT_STEPS && state.loading; i++) await sleep(WAIT_STEP_MS, state.life.signal);
   const cursor = state.inbox.nextCursor(), generation = state.inbox.generation;
   if (!cursor) return false;
   const sent = { ...state.writes };
   let answer;
   try { ({ answer } = await gramAnswer(state, link, GRAM_PAGE_SIZE, false, cursor)); }
   catch (error) {
    if (isLive(state) && !state.life.signal.aborted && state.inbox.generation !== generation) continue;
    if (isLive(state) && !state.life.signal.aborted) state.olderError = OLDER_FAILED;
    throw error;
   }
   if (!isLive(state)) return false;
   if (!accepted(state, sent, "page")) return false;
   const taken = state.inbox.appendPage(answer, generation);
   if (taken === "rejected") {
    if (state.inbox.generation === generation && !state.loading) { state.loading = true; await loadHead(state, link); }
    if (!isLive(state)) return false;
    continue;
   }
   if (state.owner) { state.badge = state.inbox.unreadCount(); state.counted++; }
   await expireOwnerSaved(state, answer.messages);
   if (taken === "grew") return true;
   if (state.inbox.generation === generation) return false;
  }
  return false;
 } finally {
  state.pageBusy = false;
  if (isLive(state)) { state.loadingOlder = false; publish(); }
 }
}

async function markAllReadOn(state: State) {
 const link = gramLinkFor(state);
 if (state.markingAll) return;
 state.markingAll = true; setNote(state, "markAll", "");
 publish();
 try {
  let pending: string[] = [], listError: unknown;
  try {
   const { answer, error } = await gramAnswer(state, link, 0, true);
   pending = answer.messages.filter(isUnread).map(m => m.id);
   listError = error;
  } catch (error) { listError = error ?? new Error("list failed"); }
  if (listError !== undefined) for (const m of state.inbox.messages) if (isUnread(m) && !pending.includes(m.id)) pending.push(m.id);
  let attempted = 0, failed = 0, marked = 0;
  await writing(state, async () => {
   for (let pass = 0; pass < 2 && pending.length; pass++) {
    const inFlight: string[] = [];
    for (const id of pending) {
     if (!isLive(state)) throw new Error(NOT_CONNECTED);
     if (state.markingRead.has(id)) { inFlight.push(id); continue; }
     const held = state.inbox.messages.find(m => m.id === id);
     if (held && !isUnread(held)) continue;
     state.markingRead.add(id);
     attempted++;
     try { await link.call("gram.mark_read", state.owner ? { id } : { ids: [id] }, state.life.signal); state.inbox.markRead(id); marked++; }
     catch { failed++; }
     finally { state.markingRead.delete(id); }
    }
    pending = inFlight;
   }
  });
  if (!isLive(state)) throw new Error(NOT_CONNECTED);
  if (listError === undefined) { if (headWritesBadge(state)) state.badge = state.inbox.unreadCount(); }
  else {
   state.badge = Math.max(state.badge - marked, state.inbox.unreadCount());
   setNote(state, "markAll", "Couldn't list every unread message. Some may still be unread.");
  }
  if (failed > 0) setNote(state, "markAll", ((state.notes.get("markAll") ?? "") + ` ${failed} of ${attempted} could not be marked read.`).trim());
 } finally {
  if (isLive(state)) { state.markingAll = false; publish(); }
 }
}

/** GramDelete's banner: herdr's message (or the owner refusal's sentence), else a retry hint. */
const DELETE_FAILED = "Couldn't delete";
export function deleteNote(error: unknown): string {
 if (error instanceof HerdrAPIError) return DELETE_FAILED + ": " + error.apiMessage;
 if (error instanceof OwnerRefusedError) return DELETE_FAILED + ": " + error.message;
 return DELETE_FAILED + ". Try again.";
}

export const gramDesk: Partial<DeskFns> = {
 gramState: async () => snapshot(g),

 async gramSetVisible(shown: boolean) { await setVisibleOn(g, shown); },

 async gramRefresh() { const link = gramLinkFor(g); await refresh(g, link); },

 /** GramLoadOlder: the page older than everything held; one asked again when a head load replaced
  *  the list meanwhile. */
 async gramLoadOlder() { return loadOlderOn(g); },

 /** GramMarkRead: the local copy flips only after herdr confirms. */
 async gramMarkRead(key: string) {
  const id = own(key);
  const state = stateForKey(key);
  const link = gramLinkFor(state);
  const m = visible(state).find(v => v.id === id);
  if (!m || !isUnread(m) || state.markingRead.has(id)) return;
  state.markingRead.add(id);
  // gramRead: the owner marks by id, a guest by its ids (desk_guest_gram.go:144-153).
  try { await writing(state, () => link.call("gram.mark_read", state.owner ? { id } : { ids: [id] }, state.life.signal)); }
  finally { state.markingRead.delete(id); }
  if (!isLive(state)) return;
  state.inbox.markRead(id);
  if (headWritesBadge(state)) state.badge = state.inbox.unreadCount();
  publish();
 },

 /** GramMarkAllRead (desk_gram.go:877-972): ids from an unread-only list, each its own mark, in two
  *  passes; failures are counted in the banner. */
 async gramMarkAllRead() { await markAllReadOn(g); },

 async gramPickFiles() {
  const state = recipientState();
  const c = gramComposer(state);
  const files = await pickFiles(true);
  if (!files.length) return [];
  const { staged, note: text } = stage(c, registerFiles(files));
  note(text, state);
  return staged;
 },

 async gramAttachFiles(paths: string[]) {
  const state = recipientState();
  const { staged, note: text } = stage(gramComposer(state), paths);
  note(text, state);
  return staged;
 },

 async gramPasteClipboard() {
  const state = recipientState();
  const c = gramComposer(state);
  const files = await clipboardFiles();
  if (!files.length) return false;
  note(stage(c, registerFiles(files)).note, state);
  return true;
 },

 async gramCancelAttachment(path: string) { gramComposer(recipientState()).remove(path); },

 async gramRetryAttachment(path: string) { gramComposer(recipientState()).retry(path); },

 /** GramPost: each attached file its own Gram, the text on the first. The owner's goes to `to` (or
  *  the shared queue) and shows at once until a list has it; a guest's goes to the shared agent and
  *  the list is refreshed after it instead. */
 async gramPost(text: string, to: string[], attachments: string[]) {
  if (to.length > 1) throw new Error("a Gram goes to one agent or to the shared queue");
  const state = recipientState();
  const c = gramComposer(state);
  const body = text.trim();
  const { staged, note: skipped } = stage(c, attachments);
  if (skipped) { note(skipped, state); throw new Error(skipped); }
  if (!body && !staged.length) return;
  setNote(state, "send", "");
  publish();
  try {
   await c.send(body, staged, async (caption, a, signal) => {
    const link = gramLinkFor(state);
    const recipient = state.owner ? to[0] ?? "" : agentNameFor(state, link);
    if (!state.owner && !recipient) throw new Error("The shared agent is not available for Gram");
    const params: Record<string, unknown> = { text: caption };
    if (recipient) params.to = recipient;
    if (a) params.file = { upload_id: a.uploadID, name: a.name, mime: a.mime };
    let listed: Promise<void> | null = null;
    const reply = await writing(state, async () => {
     const r = await link.call<{ message?: OwnerGramMessage }>("gram.post", params, signal);
     // The post's own acknowledgement shows it (pending) until an accepted head list, which is
     // sent after the post settled (gramInbox.ts acceptAnswer), so after this acknowledgement.
     const posted = r?.message;
     if (state.owner && posted?.id && isLive(state) && !state.inbox.messages.some(m => m.id === posted.id)) {
      state.pending = [ownerInfo(posted), ...state.pending.filter(m => m.id !== posted.id)];
      publish();
     }
     // A guest's post is listed after it, as at base, by one head list: owed here while the post
     // is still in flight, so the first head list sent after it settles (recovery's) is that one
     // and also covers any list the post discarded. The post resolves once that list is done.
     if (!state.owner && isLive(state)) {
      state.owed = owe(state.owed, "head");
      const done = Promise.withResolvers<void>();
      state.headWaiters.push(done.resolve);
      listed = done.promise;
     }
     return r;
    });
    const id = reply?.message?.id;
    if (!id) throw new Error("The shared agent did not confirm the posted Gram");
    if (a) forgetFile(a.path);
    if (listed) await listed;
    return id;
   }, state.life.signal);
  } catch (error) {
   if (error instanceof SendError && isLive(state)) note(error.note, state);
   throw error;
  }
 },

 /** GramDelete, the owner's only (a guest's Gram offers no Delete): the message goes for good; its
  *  row goes at once and stays gone until a list agrees. A failure says why in the banner. herdr's
  *  owner gate refuses gram.delete to browsers so far (OwnerRefusedError, its sentence after
  *  "Couldn't delete: "). The call goes on the owner link this Gram started with. */
 async gramDelete(key: string) {
  const state = g, owner = state.owner;
  if (!owner) throw new Error("only the owner deletes Grams");
  const id = own(key);
  let error: unknown;
  try { await writing(state, () => ownerCall("gram.delete", { id }, "ok", { signal: state.life.signal, link: owner })); }
  catch (e) { error = e ?? new Error("gram.delete failed"); }
  if (!isLive(state)) { if (error !== undefined) throw error; return; }
  if (error !== undefined) {
   setNote(state, "delete", deleteNote(error));
   publish();
   throw error;
  }
  state.inbox.remove(id);
  state.pending = state.pending.filter(m => m.id !== id);
  state.images.delete(id);
  // The row goes with its unread mark, and an earlier failed delete's banner with it.
  state.badge = state.inbox.unreadCount();
  setNote(state, "delete", "");
  publish();
 },

 /** GramImage: a picture of at most 8 MiB as a data: URL, two fetched at a time. */
 async gramImage(key: string) {
  const state = stateForKey(key);
  const link = gramLinkFor(state);
  const f = fileMeta(key, state);
  if (!f.mime.toLowerCase().startsWith("image/") || f.size > PREVIEW_MAX_BYTES) throw new Error(`${f.name} has no preview`);
  let image = state.images.get(key);
  if (!image) {
   image = (async () => {
    while (state.imageSlots === 0) await sleep(WAIT_STEP_MS, state.life.signal);
    state.imageSlots--;
    try {
     let blob: Blob;
     // A file listed with an unknown size (0) is checked on its real size, from the first chunk.
     try { blob = await fetchBlob(link, key, f.size, state.life.signal, PREVIEW_MAX_BYTES, undefined, state); }
     catch (error) { throw error instanceof FileTooLarge ? new Error(`${f.name} has no preview`) : error; }
     const bytes = new Uint8Array(await blob.arrayBuffer());
     return "data:" + imageMime(blob.type.startsWith("image/") ? blob.type : f.mime) + ";base64," + toBase64(bytes);
    } finally { state.imageSlots++; }
   })();
   state.images.set(key, image);
   image.catch(() => state.images.delete(key));
  }
  return image;
 },

 async gramSaveFile(key: string) { await saveFile(key); },

 /** GramOpenFile: a picture or plain text previews in the page; anything else is saved. */
 async gramOpenFile(key: string) {
  const state = stateForKey(key);
  const link = gramLinkFor(state);
  let f: WireFile;
  try { f = fileMeta(key, state); } catch (error) { note(fileError("open", error), state); throw error; }
  const kind = openPlan(f.name, f.mime, f.size);
  if (kind === "save") { await saveFile(key); return; }
  try { preview(await fetchBlob(link, key, f.size, state.life.signal, kind === "image" ? PREVIEW_MAX_BYTES : TEXT_PREVIEW_MAX_BYTES, undefined, state), kind, f.name); }
  catch (error) {
   note(error instanceof FileTooLarge ? "Couldn't open the file: it is too large to preview here. Save it instead." : fileError("open", error), state);
   throw error;
  }
 },

 /** GramOpenAttachment: a Chat attachment opened as gramOpenFile opens a Gram file, whether or not
  *  Gram has loaded its message. Its errors go back to the chat only, never Gram's banner. */
 async gramOpenAttachment(key: string) {
  const state = stateForKey(key);
  const link = gramLinkFor(state);
  let f: WireFile | null = null, first: FileChunk | undefined;
  try { f = fileMeta(key, state); } catch { /* not in the loaded feed: herdr's first chunk says what it is */ }
  if (!f) {
   first = await chunkOf(link, own(key), state.life.signal)(0);
   f = { name: first.name, mime: first.mime, size: first.size, sha256: first.sha256 };
  }
  const kind = openPlan(f.name, f.mime, f.size);
  if (kind === "save") {
   if (!first) { await writeFile(link, key, f, BLOB_SAVE_MAX_BYTES, state); return; }
   // The click's user activation may have run out while that chunk came: a save picker would be
   // refused, so the file downloads in memory instead, which needs none.
   if (f.size > BLOB_SAVE_MAX_BYTES) throw new Error(`this browser can't save files over ${Math.round(BLOB_SAVE_MAX_BYTES / 1e6)} MB from Chat`);
   downloadBlob(await fetchBlob(link, key, f.size, state.life.signal, undefined, first, state), f.name);
   return;
  }
  try { preview(await fetchBlob(link, key, f.size, state.life.signal, kind === "image" ? PREVIEW_MAX_BYTES : TEXT_PREVIEW_MAX_BYTES, first, state), kind, f.name); }
  catch (error) { throw error instanceof FileTooLarge ? new Error("it is too large to preview here") : error; }
 },

 async gramCopyText(text: string) { await navigator.clipboard.writeText(text); },

 async gramSaved() { return g.owner ? savedView(g).shown : guestSnapshot().saved; },

 /** GramSetSaved: a copy on this browser, or forgotten. The owner's is gramstore.Saved's (the sender
  *  as shown, newest first); a guest's the grant's own list. Made on the list storage holds now
  *  (another tab's change kept), under the Saved lock. */
 async gramSetSaved(key: string, saved: boolean) {
  const id = own(key), state = stateForKey(key), m = saved ? visible(state).find(v => v.id === id) : undefined;
  if (saved && !m) throw new Error(state.owner ? `no gram message "${id}"` : "that message is not loaded");
  let failed: Error | null;
  if (state.owner) {
   const source = { hostID: state.owner.machine.hostID, machine: state.owner.machine.label };
   // A Saved row's key names its copy's machine; a feed row's is the open machine's message.
   const host = keyHost(key) ?? source.hostID;
   ({ failed } = await updateSaved(state, current => {
    const list = ownerSavedCopies(current);
    return m ? withSaved(list, m, source) : list.filter(s => !(s.id === id && s.hostID === host));
   }));
  } else {
   ({ failed } = await updateSaved(state, current => {
    const list = (Array.isArray(current) ? current as SavedGram[] : []).filter(s => s.id !== id);
    if (m) list.unshift({ id, text: m.text, from: m.from, fromAgent: m.direction === AGENT_TO_OWNER, createdUnixMs: m.createdUnixMs,
     ...(m.file ? { file: { name: m.file.name, mime: m.file.mime, size: m.file.size } } : {}) } as SavedGram);
    return list;
   }));
  }
  if (isLive(state)) publish();
  if (failed) throw failed;
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
