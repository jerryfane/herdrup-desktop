// A pane's composer text across closes and reopens of its composer and reloads of the page
// (interaction.ts, the browser's and the desktop's): the draft being edited and, apart from it,
// the newest write that didn't go out, or may not have (unsent), never joined to the draft. The
// pair is one stored record per pane, this page's own: the desktop's one renderer keeps it in
// localStorage (it outlives the app), a browser tab in sessionStorage (it outlives a reload of the
// tab, and no other tab shares it: two tabs on one pane have a draft each, as two windows would).
// The page keeps one current record per pane: every change is applied to it and stored at once; a
// change storage refuses (quota, privacy mode, storage denied) stays in the current record, which
// the next write stores (dirty). A send's click and dispatch are taken only once storage took them.
// Each record carries a revision, a new random id with every write (an empty record is kept, its
// revision with it): a page whose record's revision isn't the stored one (another page of the tab
// wrote it meanwhile; this page back from the back/forward cache) reads it again before it changes
// it, and never writes its older snapshot over it.
//
// A send (DraftSend) keeps its text stored, apart from the draft, from its click until its
// outcome is known. At the click the text becomes a reservation, so edits typed after the click
// are the draft. Its dispatch (DraftSend.dispatch) marks it sending, makes the Desk call, and
// settles it: the Desk answering takes it out; the Desk refusing it (definitely not sent) brings
// the text back, as the draft when that is empty, else as the unsent line (Not sent, Restore).
//
// A page going away (pagehide) marks each of its reservations that never reached dispatch
// abandoned, in the page at once and then in storage: it will never dispatch it, even when
// storage refused the mark. A page that opens a composer and finds a reservation not
// its own brings it back, unless that send's Web Lock (herdrup.send.<id>, held by the sending page
// through its dispatch) is held: then it is a live send of another tab (the original of a
// duplicated tab), left alone while that lasts: the open composer waits for the lock (one
// request per such send, given up when the composer closes), and once it is free brings the
// reservation back if it is still there. Abandoned, it comes back as definitely not sent; any
// other (sending, or without that word: a duplicated tab's copy, a crash, a refused write) as the
// line "Might have been sent", with Restore, never as the draft. A page back from the
// back/forward cache brings its own abandoned reservations back as not sent too: they stay
// undispatched, so a copy that read them as not sent stays right.
//
// An older page's draft (localStorage herdrup.prompt.<target>, from before these records): the
// desktop (one renderer) moves it into the record when it first reads the pane, and removes it
// with the first write storage takes (or a later one, while removal fails). The browser, whose
// tabs share localStorage, never moves, claims or removes it by itself: a composer shows it as a
// read-only line ("Older draft"), to copy or dismiss (which removes the key only while it still
// holds the text shown; a newer text there is shown instead); it is never the draft and has no
// way to be sent. Every tab on the pane shows the same line, drawn again when another tab
// changes it (the storage event).

import { browserLocks, type AbortableLocks } from "./web/locks";
import { webGuest } from "./platform";

/** Where a record is kept (localStorage, sessionStorage). */
export interface DraftStore {
 getItem(key: string): string | null;
 setItem(key: string, value: string): void;
 removeItem(key: string): void;
}

/** A text a write didn't deliver (maybe: or may have, its outcome unknown), and whether it took
 *  the place of an older one. */
export interface Unsent { text: string; replaced: boolean; maybe: boolean }

/** A send's text from its click until its outcome, the send's id (its send lock's name), whether
 *  its dispatch has begun (sending: it may have been delivered), and whether its own page, going
 *  away before the dispatch, gave it up (abandoned: it never dispatches). */
interface Reserved { readonly text: string; readonly id: string; readonly sending: boolean; readonly abandoned: boolean }

/** A pane's composer texts, and the record's revision: a new random id with every write, compared
 *  only for equality, so a document holding another one (the same tab's page back from the
 *  back/forward cache) reads the record again before it writes, and never writes its older
 *  snapshot over it. "": no record yet. */
interface PaneRecord { readonly draft: string; readonly unsent: Unsent | null; readonly reserved: readonly Reserved[]; readonly rev: string }

/** A change, applied to a pane's current record. */
type Change =
 | { kind: "draft"; text: string }
 /** Restore: the unsent text and the draft swap; nothing goes. */
 | { kind: "restore" }
 /** The click: text leaves the draft for a reservation (id), only while the draft still is text. */
 | { kind: "reserve"; text: string; id: string }
 /** The dispatch: reservation id is sending, only while it is still there, not sending and not
  *  abandoned. */
 | { kind: "consume"; id: string }
 /** The Desk took the write: reservation id goes. */
 | { kind: "written"; id: string }
 /** Reservation id definitely didn't go out (this page's own, never dispatched, refused by the
  *  Desk or not marked sending; or abandoned by its page): its text comes back as the draft when
  *  that is empty, else as the unsent line. */
 | { kind: "unsent"; id: string }
 /** Another page's reservation id, its send lock free: abandoned, it comes back as definitely not
  *  sent ("unsent"); any other, as text that may have been sent, never the draft. */
 | { kind: "recover"; id: string }
 /** Reservations ids (this page's own, never sending: ComposerDrafts) are given up: abandoned. */
 | { kind: "abandon"; ids: readonly string[] };

/** What a click came to: reserved (the text is this send's reservation), gone (the draft was no
 *  longer that text), or refused (storage refused it: the draft keeps the text). */
export type ReserveOutcome = "reserved" | "gone" | "refused";

/** What a dispatch came to: sent (the Desk answered value), or not dispatched: gone (no
 *  reservation to dispatch: refused at the click, dispatched, cancelled or abandoned already) or
 *  refused (storage refused to mark it sending: its text came back). */
export type Dispatched<T> = { sent: true; value: T } | { sent: false; outcome: "gone" | "refused" };

const newID = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");

/** text back in record, as a write that didn't go out: still the draft, it stays there; else into
 *  an empty draft, else the unsent text in place of an older one. */
function back(record: PaneRecord, text: string): PaneRecord {
 return record.draft === text ? record : record.draft === "" ? { ...record, draft: text } : { ...record, unsent: unsent(record, text, false) };
}

/** The unsent item text in place of record's. */
function unsent(record: PaneRecord, text: string, maybe: boolean): Unsent {
 return { text, replaced: record.unsent !== null && record.unsent.text !== text, maybe };
}

/** record without reservation id, and that reservation (undefined when it is gone). */
function without(record: PaneRecord, id: string): [PaneRecord, Reserved | undefined] {
 const reserved = record.reserved.find((r) => r.id === id);
 return [reserved === undefined ? record : { ...record, reserved: record.reserved.filter((r) => r !== reserved) }, reserved];
}

/** change applied to record: the next record, and for a reserve or consume whether it found what
 *  it needed (claimed) — one decision for both. */
function step(record: PaneRecord, change: Change): { record: PaneRecord; claimed?: boolean } {
 switch (change.kind) {
  case "draft": return { record: { ...record, draft: change.text } };
  case "restore": return { record: record.unsent === null ? record : { ...record, draft: record.unsent.text, unsent: record.draft === "" ? null : { text: record.draft, replaced: false, maybe: false } } };
  case "reserve": {
   const claimed = record.draft === change.text;
   return { record: claimed ? { ...record, draft: "", reserved: [...record.reserved, { text: change.text, id: change.id, sending: false, abandoned: false }] } : record, claimed };
  }
  case "consume": {
   const claimed = record.reserved.some((r) => r.id === change.id && !r.sending && !r.abandoned);
   return { record: claimed ? { ...record, reserved: record.reserved.map((r) => r.id === change.id ? { ...r, sending: true } : r) } : record, claimed };
  }
  case "written": return { record: without(record, change.id)[0] };
  case "unsent": {
   const [rest, reserved] = without(record, change.id);
   return { record: reserved === undefined ? record : back(rest, reserved.text) };
  }
  case "recover": {
   const [rest, reserved] = without(record, change.id);
   if (reserved === undefined) return { record };
   return { record: reserved.abandoned ? back(rest, reserved.text) : { ...rest, unsent: unsent(rest, reserved.text, true) } };
  }
  case "abandon": return { record: { ...record, reserved: record.reserved.map((r) => change.ids.includes(r.id) ? { ...r, abandoned: true } : r) } };
 }
}

/** An open composer as its pane's draft sees it. */
export interface ComposerView {
 /** Shows text in the field; the pane's draft already holds it. */
 showField(text: string): void;
 /** The unsent line changed: it is drawn again. */
 unsentChanged(): void;
 /** The older page's draft may have changed (another tab wrote or removed it): drawn again. */
 olderChanged(): void;
}

/** What Dismiss came to: removed (the key held the text shown), changed (it holds another text
 *  now, or none: nothing removed, the line is drawn again), or refused (storage refused). */
export type DismissOutcome = "removed" | "changed" | "refused";

/** One pane's state in this page: its current record, whether storage lacks some of it (dirty),
 *  the composer open on it and that composer's waits for other tabs' send locks (watch, given up
 *  when it closes), and the desktop's older draft moved in and still to be removed (legacy). */
interface PaneState { current: PaneRecord; dirty: boolean; view: ComposerView | null; watch: AbortController | null; legacy: string | null }

const KEY = "herdrup.composer.v1.", LEGACY_KEY = "herdrup.prompt.", SEND_LOCK = "herdrup.send.";
const EMPTY: PaneRecord = { draft: "", unsent: null, reserved: [], rev: "" };

/** The composer drafts of one page: records in store; an older page's drafts in legacy, moved
 *  into the records when read (move, desktop) or only shown, read-only (show, browser); send
 *  locks in locks. Each storage getter may throw (storage denied): that is a refusal, like a
 *  write's. composerDrafts is this page's. */
export class ComposerDrafts {
 readonly #panes = new Map<string, PaneState>();
 /** This page's own reservations, by send id: never another page's to bring back. Each tells its
  *  send when the page gave it up for good (pageRestored). */
 readonly #own = new Map<string, () => void>();

 constructor(private readonly store: () => DraftStore | null, private readonly legacy: () => DraftStore | null = store, private readonly carry: "move" | "show" = "move", private readonly locks: () => AbortableLocks | null = browserLocks) {}

 /** target's pane (its target as JSON). */
 pane(target: string): PaneDraft { return new PaneDraft(this, target); }

 state(target: string): PaneState {
  let state = this.#panes.get(target);
  if (state !== undefined) return state;
  let raw: string | null = null, old: string | null = null;
  try { raw = this.store()?.getItem(KEY + target) ?? null; } catch { /* storage denied */ }
  try { if (this.carry === "move") old = this.legacy()?.getItem(LEGACY_KEY + target) ?? null; } catch { /* storage denied */ }
  // A record wins over an older page's draft; either way that draft is still to be removed.
  const moved = raw === null && old !== null;
  state = { current: raw !== null ? parse(raw) : moved ? { ...EMPTY, draft: old! } : EMPTY, dirty: moved, view: null, watch: null, legacy: old };
  this.#panes.set(target, state);
  if (moved) this.flush(target);
  return state;
 }

 /** Stores record as target's under a new revision: the record stored, or null when storage
  *  refused it. An empty record is stored too, never removed: its revision tells a page holding
  *  an older one that the record changed. Once stored, the desktop removes its older draft (while
  *  it still holds the text that was there). */
 #store(target: string, state: PaneState, record: PaneRecord): PaneRecord | null {
  const next = { ...record, rev: newID() };
  try {
   const store = this.store();
   if (store === null) return null;
   store.setItem(KEY + target, JSON.stringify(next));
  } catch { return null; }
  this.#dropLegacy(target, state);
  return next;
 }

 /** Another document wrote target's record since this one read it (its revision differs: the
  *  same tab's other page, this page back from the back/forward cache, another window): the stored
  *  record replaces the current one, a change storage refused before included, and the open
  *  composer shows it. Whether it was replaced. */
 #refresh(target: string, state: PaneState): boolean {
  let raw: string | null;
  try { raw = this.store()?.getItem(KEY + target) ?? null; } catch { return false; }
  const stored = raw === null ? EMPTY : parse(raw);
  if (stored.rev === state.current.rev) return false;
  const before = state.current;
  state.current = stored;
  state.dirty = false;
  this.#show(state, before);
  return true;
 }

 /** The desktop's older draft moved in is removed (while it still holds that text; gone, or
  *  holding another, there is nothing to remove); removal failing, a later write tries again. */
 #dropLegacy(target: string, state: PaneState) {
  if (state.legacy === null) return;
  try {
   if (this.legacy()?.getItem(LEGACY_KEY + target) === state.legacy) this.legacy()?.removeItem(LEGACY_KEY + target);
   state.legacy = null;
  } catch { /* removed at a later write */ }
 }

 /** The older page's draft for target (browser: shown read-only, "Older draft"): null when there
  *  is none or storage denies reading it. The desktop moved it into the record already. */
 older(target: string): string | null {
  if (this.carry === "move") return null;
  try { return this.legacy()?.getItem(LEGACY_KEY + target) ?? null; } catch { return null; }
 }

 /** Dismiss on the older draft shown (browser): its key removed only while it still holds
  *  exactly that text; another text there (a newer one the user hasn't seen) stays. */
 dismissOlder(target: string, shown: string): DismissOutcome {
  try {
   const legacy = this.legacy();
   if (legacy === null || legacy.getItem(LEGACY_KEY + target) !== shown) return "changed";
   legacy.removeItem(LEGACY_KEY + target);
   return "removed";
  } catch { return "refused"; }
 }

 /** Another tab changed localStorage (the storage event; key null: cleared): a composer whose
  *  older draft that may be draws it again. */
 storageChanged(key: string | null) {
  for (const [target, state] of this.#panes) if (key === null || key === LEGACY_KEY + target) state.view?.olderChanged();
 }

 /** change applied to target's current record, read again first when another document wrote it
  *  (#refresh), and stored. Taken: always (kept, dirty, when storage refused it) or only once
  *  stored. The open composer shows what changed (show). stored: whether storage took it;
  *  claimed: the reserve's or consume's own finding. */
 commit(target: string, change: Change, taken: "always" | "stored", show: boolean): { stored: boolean; claimed: boolean } {
  const state = this.state(target);
  this.#refresh(target, state);
  const before = state.current;
  const { record, claimed } = step(before, change);
  const stored = this.#store(target, state, record);
  if (stored !== null || taken === "always") {
   state.current = stored ?? record;
   state.dirty = stored === null;
   if (show) this.#show(state, before);
  }
  return { stored: stored !== null, claimed: claimed === true };
 }

 /** Stores target's current record when storage lacks some of it: whether storage has it all. A
  *  newer record another document wrote meanwhile replaces it instead (#refresh). */
 flush(target: string): boolean {
  const state = this.state(target);
  if (!state.dirty || this.#refresh(target, state)) return true;
  const stored = this.#store(target, state, state.current);
  if (stored === null) return false;
  state.current = stored;
  state.dirty = false;
  return true;
 }

 /** view opened on target: each stored reservation not this page's own is asked about: its send
  *  lock free, it comes back (recover); held, it is another tab's live send, and the view waits
  *  for the lock, one request per reservation, given up when the view closes; then it brings it
  *  back if it is still there, while this view's watch is still the pane's. */
 opened(target: string, view: ComposerView) {
  const state = this.state(target);
  this.#refresh(target, state);
  state.view = view;
  state.watch?.abort();
  const watch = state.watch = new AbortController();
  for (const { id } of state.current.reserved) {
   if (this.#own.has(id)) continue;
   void this.#sendEnded(id, watch.signal).then((ended) => {
    if (ended && state.watch === watch) this.commit(target, { kind: "recover", id }, "always", true);
   });
  }
 }

 /** view closed on target: its waits for send locks are given up. */
 closed(target: string, view: ComposerView) {
  const state = this.state(target);
  if (state.view !== view) return;
  state.view = null;
  state.watch?.abort();
  state.watch = null;
 }

 /** Whether send id's lock is free: at once, or once its holder (another tab's dispatch) lets it
  *  go while signal holds (false when it aborts first). Without Web Locks (none, or refused) it
  *  is free. Granted, the lock is let go at once: only its holder's end was waited for. The
  *  recover that follows finds the reservation only if it is still there. */
 async #sendEnded(id: string, signal: AbortSignal): Promise<boolean> {
  const locks = this.locks();
  if (locks === null) return true;
  try { return await locks.request(SEND_LOCK + id, { signal }, async () => true); } catch { return !signal.aborted; }
 }

 /** Send id's lock, held from held (granted, or refused: then unheld) until end. */
 lock(id: string): { held: Promise<void>; end: () => void } {
  const locks = this.locks(), held = Promise.withResolvers<void>(), ended = Promise.withResolvers<void>();
  if (locks === null) held.resolve();
  else void locks.request(SEND_LOCK + id, () => { held.resolve(); return ended.promise; }).catch(() => held.resolve());
  return { held: held.promise, end: () => ended.resolve() };
 }

 /** Send id is this page's own, gaveUp telling it when its page gave it up for good; null: no
  *  longer. */
 own(id: string, gaveUp: (() => void) | null) { if (gaveUp) this.#own.set(id, gaveUp); else this.#own.delete(id); }

 /** The page goes away (pagehide): each of its own reservations that never reached dispatch is
  *  given up (abandoned) in this page at once, then in storage. Storage refusing the mark, the
  *  page still never dispatches them (consume refuses them in its current record); a page without
  *  the mark brings them back as may have been sent. */
 pageHidden() {
  for (const [target, state] of this.#panes) {
   const ids = state.current.reserved.filter((r) => this.#own.has(r.id) && !r.sending && !r.abandoned).map((r) => r.id);
   if (ids.length > 0) this.commit(target, { kind: "abandon", ids }, "always", false);
  }
 }

 /** The page came back from the back/forward cache (pageshow, persisted): each pane's record is
  *  read again first (the same tab's other page may have written it meanwhile), and what this page
  *  gave up comes back as not sent (the draft, or Not sent with Restore) if that record still has
  *  it; either way its send is told (DraftSend.gaveUp). */
 pageRestored() {
  for (const [target, state] of this.#panes) {
   const gaveUp = state.current.reserved.filter((r) => r.abandoned && this.#own.has(r.id)).map((r) => r.id);
   this.#refresh(target, state);
   for (const id of gaveUp) {
    if (state.current.reserved.some((r) => r.id === id)) this.commit(target, { kind: "unsent", id }, "always", true);
    this.#own.get(id)?.();
   }
  }
 }

 /** The open composer shows what changed from before. */
 #show(state: PaneState, before: PaneRecord) {
  const now = state.current;
  if (now.draft !== before.draft) state.view?.showField(now.draft);
  const a = now.unsent, b = before.unsent;
  if (a?.text !== b?.text || a?.replaced !== b?.replaced || a?.maybe !== b?.maybe) state.view?.unsentChanged();
 }
}

/** A stored record; one that isn't a record is no texts. */
function parse(raw: string): PaneRecord {
 try {
  const value = JSON.parse(raw) as { draft?: unknown; unsent?: { text?: unknown; replaced?: unknown; maybe?: unknown } | null; reserved?: unknown; rev?: unknown };
  const u = value.unsent;
  const unsent = u && typeof u.text === "string" && u.text !== "" ? { text: u.text, replaced: u.replaced === true, maybe: u.maybe === true } : null;
  const reserved = Array.isArray(value.reserved) ? (value.reserved as { text?: unknown; id?: unknown; sending?: unknown; abandoned?: unknown }[]).flatMap((r) => typeof r?.text === "string" && typeof r.id === "string" ? [{ text: r.text, id: r.id, sending: r.sending === true, abandoned: r.abandoned === true }] : []) : [];
  return { draft: typeof value.draft === "string" ? value.draft : "", unsent, reserved, rev: typeof value.rev === "string" ? value.rev : "" };
 } catch { return EMPTY; }
}

/** One pane's composer texts in a page (ComposerDrafts.pane). */
export class PaneDraft {
 constructor(private readonly drafts: ComposerDrafts, private readonly target: string) {}

 draft(): string { return this.drafts.state(this.target).current.draft; }
 unsent(): Unsent | null { return this.drafts.state(this.target).current.unsent; }

 /** view is the pane's open composer until detach (which gives up its waits for send locks). */
 attach(view: ComposerView) { this.drafts.opened(this.target, view); }
 detach(view: ComposerView) { this.drafts.closed(this.target, view); }

 /** An edit: text is the draft now (the field changed). Unchanged and stored, nothing is written.
  *  False when storage refused it (the page keeps it, and the next write stores it). */
 saveDraft(text: string): boolean {
  if (this.draft() === text) return this.drafts.flush(this.target);
  return this.drafts.commit(this.target, { kind: "draft", text }, "always", false).stored;
 }

 /** Stores what storage still lacks (the composer closing): false when storage refused it. */
 flush(): boolean { return this.drafts.flush(this.target); }

 /** The click of a send of text (DraftSend): its outcome is known at once; the open composer
  *  shows the draft without it (the field clears). */
 reserve(text: string): DraftSend { return new DraftSend(this.drafts, this.target, text); }

 /** The older page's draft (browser, ComposerDrafts.older): read-only, never sent. */
 older(): string | null { return this.drafts.older(this.target); }

 /** Dismiss on the older draft shown (ComposerDrafts.dismissOlder). */
 dismissOlder(shown: string): DismissOutcome { return this.drafts.dismissOlder(this.target, shown); }

 /** Restore: the unsent text and the draft swap; nothing goes. False when storage refused it. */
 restore(): boolean { return this.drafts.commit(this.target, { kind: "restore" }, "always", true).stored; }
}

/** A send of the draft's text, from its click (PaneDraft.reserve) until its one dispatch or its
 *  cancel. */
export class DraftSend {
 readonly #id = newID();
 #state: "reserved" | "dispatching" | "over";
 readonly #gaveUp = Promise.withResolvers<void>();
 /** The click's outcome, known at once. */
 readonly outcome: ReserveOutcome;
 /** Settles when the send is over undispatched because its page gave it up (back from the
  *  back/forward cache): its text is back, and nothing waits for its dispatch any more. */
 readonly gaveUp = this.#gaveUp.promise;

 constructor(private readonly drafts: ComposerDrafts, private readonly target: string, text: string) {
  const { stored, claimed } = drafts.commit(target, { kind: "reserve", text, id: this.#id }, "stored", true);
  this.outcome = !stored ? "refused" : claimed ? "reserved" : "gone";
  this.#state = this.outcome === "reserved" ? "reserved" : "over";
  if (this.#state === "reserved") drafts.own(this.#id, () => {
   if (this.#state !== "reserved") return;
   this.#state = "over";
   drafts.own(this.#id, null);
   this.#gaveUp.resolve();
  });
 }

 /** The one dispatch, nothing else left to wait for: it takes the send's lock (a duplicated tab
  *  then leaves the send alone), marks it sending, runs the Desk call with the reservation's text,
  *  and settles it: the Desk answering, the reservation goes; run rejecting (the Desk refused it,
  *  or it never went out), its text comes back and run's error is thrown. Storage refusing the
  *  mark, run isn't called and the text comes back. A send its page gave up (abandoned) never
  *  dispatches: its text comes back. Another dispatch, or one after a cancel, does nothing. */
 async dispatch<T>(run: (text: string) => Promise<T>): Promise<Dispatched<T>> {
  if (this.#state !== "reserved") return { sent: false, outcome: "gone" };
  this.#state = "dispatching";
  const lock = this.drafts.lock(this.#id);
  try {
   await lock.held;
   const consumed = this.drafts.commit(this.target, { kind: "consume", id: this.#id }, "stored", false);
   const reserved = this.drafts.state(this.target).current.reserved.find((r) => r.id === this.#id);
   if (!consumed.stored || !consumed.claimed || reserved === undefined) {
    this.#unsent();
    return { sent: false, outcome: consumed.stored ? "gone" : "refused" };
   }
   let value: T;
   try { value = await run(reserved.text); } catch (error) { this.#unsent(); throw error; }
   this.drafts.commit(this.target, { kind: "written", id: this.#id }, "always", false);
   return { sent: true, value };
  } finally {
   lock.end();
   this.#state = "over";
   this.drafts.own(this.#id, null);
  }
 }

 /** Never dispatched (the composer closed, or the send stopped before its dispatch): the text
  *  comes back. Nothing once a dispatch began or the send is over. */
 cancel() {
  if (this.#state !== "reserved") return;
  this.#state = "over";
  this.#unsent();
  this.drafts.own(this.#id, null);
 }

 #unsent() { this.drafts.commit(this.target, { kind: "unsent", id: this.#id }, "always", true); }
}

/** One of this page's storages (localStorage, sessionStorage), read when used: the getter itself
 *  may throw (storage denied), which the drafts take as a refusal. */
const storage = (kind: "localStorage" | "sessionStorage") => () => globalThis[kind] ?? null;

/** This page's composer drafts: the desktop's in localStorage, an older page's moved in; a browser
 *  tab's in its sessionStorage, an older page's (localStorage) only shown, read-only. */
export const composerDrafts = new ComposerDrafts(storage(webGuest ? "sessionStorage" : "localStorage"), storage("localStorage"), webGuest ? "show" : "move");
if (typeof globalThis.addEventListener === "function") {
 globalThis.addEventListener("pagehide", () => composerDrafts.pageHidden());
 globalThis.addEventListener("pageshow", (event) => { if ((event as PageTransitionEvent).persisted) composerDrafts.pageRestored(); });
 globalThis.addEventListener("storage", (event) => composerDrafts.storageChanged((event as StorageEvent).key));
}

/** The unsent line's words. */
export function unsentLine(unsent: Unsent): string {
 return (unsent.maybe ? `Might have been sent: ${unsent.text}` : `Not sent: ${unsent.text}`) + (unsent.replaced ? " (an earlier unsent text was dropped)" : "");
}
