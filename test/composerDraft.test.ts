// The composer's draft and unsent text by pane (src/composerDraft.ts, which interaction.ts's
// composer keeps its text in), driven through the composer's own transitions: edits, a send's
// click (reserve), its one dispatch (DraftSend.dispatch, with the Desk call it runs) or cancel,
// Restore, a close (flush), and the page going away (pagehide) or coming back from the
// back/forward cache. A page is a ComposerDrafts over its storage; a reload is a new one over the
// same storage, a duplicated browser tab a new one over a copy of it.
import { expect, test } from "bun:test";
import { ComposerDrafts, unsentLine, type ComposerView, type Dispatched, type DraftStore } from "../src/composerDraft";
import type { AbortableLocks } from "../src/web/locks";

/** Storage over a Map; refuse makes every write throw (a full quota), blocked the writes it picks. */
const memory = (from?: Map<string, string>) => {
 const kept = new Map(from);
 const s = { kept, refuse: false, blocked: (_key: string, _op: "set" | "remove") => false, writes: 0 } as DraftStore & { kept: Map<string, string>; refuse: boolean; blocked: (key: string, op: "set" | "remove") => boolean; writes: number };
 s.getItem = (k) => kept.get(k) ?? null;
 s.setItem = (k, v) => { s.writes++; if (s.refuse || s.blocked(k, "set")) throw new DOMException("quota", "QuotaExceededError"); kept.set(k, v); };
 s.removeItem = (k) => { s.writes++; if (s.refuse || s.blocked(k, "remove")) throw new DOMException("quota", "QuotaExceededError"); kept.delete(k); };
 return s;
};

/** This origin's Web Locks: one holder per name, other requests waiting their turn (a waiting one
 *  with a signal leaves when it aborts). tab() is one page's: close() drops what it holds, as a
 *  reload or a closed tab does. */
function lockManager() {
 const holders = new Map<string, { page: number; release: () => void }>();
 const queues = new Map<string, (() => void)[]>();
 let pages = 0;
 return {
  held: (name: string) => holders.has(name),
  /** Requests waiting, over every name. */
  waiting: () => [...queues.values()].reduce((n, q) => n + q.length, 0),
  tab() {
   const page = ++pages;
   const grant = (name: string, signal?: AbortSignal) => new Promise<() => void>((granted, refused) => {
    const take = () => {
     let done = false;
     const release = () => { if (done) return; done = true; holders.delete(name); queues.get(name)?.shift()?.(); };
     holders.set(name, { page, release });
     granted(release);
    };
    // As the Web Locks API: a signal aborted already rejects at once.
    if (signal?.aborted) return refused(signal.reason);
    if (!holders.has(name)) return take();
    queues.set(name, [...(queues.get(name) ?? []), take]);
    signal?.addEventListener("abort", () => {
     const left = (queues.get(name) ?? []).filter((t) => t !== take);
     if (left.length > 0) queues.set(name, left); else queues.delete(name);
     refused(signal.reason);
    }, { once: true });
   });
   const locks = {
    request: async (name: string, a: unknown, b?: unknown) => {
     const [options, granted] = (typeof a === "function" ? [{}, a] : [a, b]) as [{ signal?: AbortSignal }, () => Promise<unknown>];
     const release = await grant(name, options.signal);
     try { return await granted(); } finally { release(); }
    },
   } as unknown as AbortableLocks;
   return { locks, close: () => { for (const h of [...holders.values()]) if (h.page === page) h.release(); } };
  },
 };
}

/** A page over store: records and an older page's drafts (moved in, as the desktop does) alike,
 *  unless legacy is given; carry "show" only shows the older drafts, as a browser tab does. */
const page = (store: DraftStore, locks: AbortableLocks | null = null, legacy: DraftStore = store, carry: "move" | "show" = "move") => new ComposerDrafts(() => store, () => legacy, carry, () => locks);

/** A composer open on target's pane in drafts' page: typing is an edit, as the field's input is. */
function composer(drafts: ComposerDrafts, target: string) {
 const draft = drafts.pane(target);
 let field = "", redrawn = 0, olderRedrawn = 0;
 const view: ComposerView = { showField: (text) => { field = text; }, unsentChanged: () => { redrawn++; }, olderChanged: () => { olderRedrawn++; } };
 draft.attach(view);
 field = draft.draft();
 return {
  draft, view,
  type(text: string) { field = text; return draft.saveDraft(text); },
  get field() { return field; },
  get line() { const u = draft.unsent(); return u === null ? null : unsentLine(u); },
  get redrawn() { return redrawn; },
  get olderRedrawn() { return olderRedrawn; },
  async close() { const stored = await draft.flush(); draft.detach(view); return stored; },
 };
}
type Composer = ReturnType<typeof composer>;

/** The field's text sent and its Desk call out (not answered yet): reply settles that call. */
async function dispatched(c: Composer, text: string) {
 await c.type(text);
 const send = c.draft.reserve(text);
 expect(send.outcome).toBe("reserved");
 const reply = Promise.withResolvers<string>(), called = Promise.withResolvers<void>();
 const outcome: Promise<Dispatched<string>> = send.dispatch(() => { called.resolve(); return reply.promise; });
 await called.promise;
 return { send, reply, outcome };
}

/** text sent with newer typed after the click, the Desk refusing it: newer is the draft, text the
 *  unsent line. */
async function refused(c: Composer, text: string, newer: string) {
 const { reply, outcome } = await dispatched(c, text);
 await c.type(newer);
 reply.reject(new Error("herdr: pane_not_found"));
 await expect(outcome).rejects.toThrow("pane_not_found");
}

/** Every change queued so far has settled (lock requests and what they bring back are promise
 *  turns, which run before the next event-loop turn). */
const settled = () => new Promise<void>((done) => setImmediate(done));

let pane = 0;
const target = () => JSON.stringify({ machineID: "owner:h", session: "", paneID: `p${++pane}` });
const keyOf = (t: string) => "herdrup.composer.v1." + t;
/** The stored record, its unsent item's id left out (it is random). */
const storedOf = (store: ReturnType<typeof memory>, t: string) => {
 const value = JSON.parse(store.kept.get(keyOf(t)) ?? "null") as { draft: string; unsent: { text: string; replaced: boolean; maybe: boolean } | null } | null;
 return value === null ? null : { draft: value.draft, unsent: value.unsent && { text: value.unsent.text, replaced: value.unsent.replaced, maybe: value.unsent.maybe } };
};
/** The texts of the sends stored for t, with their state. */
const reservedOf = (store: ReturnType<typeof memory>, t: string) => ((JSON.parse(store.kept.get(keyOf(t)) ?? "null") as { reserved?: { text: string; sending: boolean; abandoned: boolean }[] } | null)?.reserved ?? [])
 .map((r) => `${r.text}${r.sending ? " (sending)" : ""}${r.abandoned ? " (abandoned)" : ""}`);

test("an edit is the draft, stored; unchanged and stored, nothing is written again", async () => {
 const store = memory(), t = target();
 const a = composer(page(store), t);
 expect(await a.type("make check")).toBe(true);
 expect(storedOf(store, t)).toEqual({ draft: "make check", unsent: null });
 const writes = store.writes;
 expect(await a.type("make check")).toBe(true);
 expect(await a.close()).toBe(true);
 expect(store.writes).toBe(writes);
 expect(composer(page(store), t).field).toBe("make check");
});

test("a send's text is stored apart from the draft from its click until the Desk took it; edits after the click are the draft", async () => {
 const store = memory(), t = target();
 const a = composer(page(store), t);
 await a.type("make deploy");
 const send = a.draft.reserve("make deploy");
 expect([send.outcome, a.field]).toEqual(["reserved", ""]); // the click clears the field (ComposerView.showField)
 expect(await a.type("make lint")).toBe(true);
 expect([storedOf(store, t), reservedOf(store, t)]).toEqual([{ draft: "make lint", unsent: null }, ["make deploy"]]);
 const reply = Promise.withResolvers<string>(), called = Promise.withResolvers<void>();
 const outcome = send.dispatch(() => { called.resolve(); return reply.promise; });
 await called.promise;
 expect(reservedOf(store, t)).toEqual(["make deploy (sending)"]);
 reply.resolve('{"delivery":"written"}');
 expect(await outcome).toEqual({ sent: true, value: '{"delivery":"written"}' });
 expect([storedOf(store, t), reservedOf(store, t), a.line]).toEqual([{ draft: "make lint", unsent: null }, [], null]);
});

test("a dispatch the Desk refused (definitely not sent) comes back as the draft, or as Not sent beside a newer edit", async () => {
 const store = memory(), t = target();
 const a = composer(page(store), t);
 const { reply, outcome } = await dispatched(a, "make deploy");
 reply.reject(new Error("refused"));
 await expect(outcome).rejects.toThrow("refused");
 expect([a.field, a.line]).toEqual(["make deploy", null]);
 await refused(a, "make deploy", "make lint");
 expect([a.field, a.line, reservedOf(store, t)]).toEqual(["make lint", "Not sent: make deploy", []]);
 expect(storedOf(store, t)).toEqual({ draft: "make lint", unsent: { text: "make deploy", replaced: false, maybe: false } });
});

test("a newer text that didn't go out takes the unsent line's place, saying an older one was dropped", async () => {
 const store = memory(), t = target();
 const a = composer(page(store), t);
 await refused(a, "make lint", "make check");
 await refused(a, "make check", "make test");
 expect([a.field, a.line]).toEqual(["make test", "Not sent: make check (an earlier unsent text was dropped)"]);
});

test("Restore swaps the unsent text and the draft in one write; refused, the page still shows both, once each", async () => {
 const store = memory(), t = target();
 const a = composer(page(store), t);
 await refused(a, "make lint", "make check");
 const writes = store.writes;
 expect(await a.draft.restore()).toBe(true);
 expect(store.writes - writes).toBe(1);
 expect([a.field, a.line]).toEqual(["make lint", "Not sent: make check"]);
 store.refuse = true;
 expect(await a.draft.restore()).toBe(false);
 expect([a.field, a.line]).toEqual(["make check", "Not sent: make lint"]);
 store.refuse = false;
 expect(await a.close()).toBe(true);
 expect(storedOf(store, t)).toEqual({ draft: "make check", unsent: { text: "make lint", replaced: false, maybe: false } });
});

test("a composer reopened shows the texts as stored; an edit that storage refused is kept, reported, and stored at the close", async () => {
 const store = memory(), t = target(), drafts = page(store);
 const a = composer(drafts, t);
 await refused(a, "make lint", "make check");
 await a.close();
 const b = composer(drafts, t);
 expect([b.field, b.line]).toEqual(["make check", "Not sent: make lint"]);
 store.refuse = true;
 expect(await b.type("make check --all")).toBe(false);
 expect(b.field).toBe("make check --all");
 store.refuse = false;
 expect(await b.close()).toBe(true);
 expect(composer(page(store), t).field).toBe("make check --all");
});

test("two tabs keep a draft each: one's edit and send never show in the other", async () => {
 const t = target();
 const one = memory(), two = memory();
 const a = composer(page(one), t), b = composer(page(two), t);
 await a.type("make deploy");
 await b.type("make lint");
 expect(a.draft.reserve("make deploy").outcome).toBe("reserved");
 expect([composer(page(two), t).field, storedOf(two, t)]).toEqual(["make lint", { draft: "make lint", unsent: null }]);
});

// A reload: the page going away (pagehide) says which of its sends never reached dispatch; its
// locks go with it; a new page reads its storage.
test("a reload with a send never dispatched brings its text back on the page's word: the draft, or Not sent beside a newer one", async () => {
 const store = memory(), t = target(), locks = lockManager(), first = locks.tab();
 const drafts = page(store, first.locks);
 const a = composer(drafts, t);
 await a.type("make deploy");
 expect(a.draft.reserve("make deploy").outcome).toBe("reserved");
 drafts.pageHidden();
 expect(reservedOf(store, t)).toEqual(["make deploy (abandoned)"]);
 first.close();
 const reloaded = composer(page(store, locks.tab().locks), t);
 await settled();
 expect([reloaded.field, reloaded.line, reservedOf(store, t)]).toEqual(["make deploy", null, []]);
 const second = locks.tab(), again = page(store, second.locks);
 const b = composer(again, t);
 expect(b.draft.reserve("make deploy").outcome).toBe("reserved");
 await b.type("make lint");
 again.pageHidden();
 second.close();
 const third = composer(page(store, locks.tab().locks), t);
 await settled();
 expect([third.field, third.line]).toEqual(["make lint", "Not sent: make deploy"]);
});

test("a send found without its page's word that it never went out (a crash, a refused pagehide write) may have been sent: never the draft", async () => {
 for (const leave of ["crash", "pagehide refused"] as const) {
  const store = memory(), t = target(), locks = lockManager(), first = locks.tab();
  const drafts = page(store, first.locks);
  const a = composer(drafts, t);
  await a.type("make deploy");
  expect(a.draft.reserve("make deploy").outcome).toBe("reserved");
  if (leave === "pagehide refused") { store.refuse = true; drafts.pageHidden(); store.refuse = false; }
  first.close();
  const reloaded = composer(page(store, locks.tab().locks), t);
  await settled();
  expect([reloaded.field, reloaded.line, reservedOf(store, t)]).toEqual(["", "Might have been sent: make deploy", []]);
 }
});

// A duplicated browser tab starts with a copy of the tab's storage. The reviewer's sequence: the
// copy made while the original's send is reserved, opened only after the original dispatched and
// the Desk took it.
test("a duplicated tab's copy of a send shows as may have been sent, and is left alone while the original dispatches it", async () => {
 const store = memory(), t = target(), locks = lockManager(), original = locks.tab();
 const a = composer(page(store, original.locks), t);
 await a.type("make deploy");
 const send = a.draft.reserve("make deploy");
 const copy = memory(store.kept);
 const reply = Promise.withResolvers<string>(), called = Promise.withResolvers<void>();
 const outcome = send.dispatch(() => { called.resolve(); return reply.promise; });
 await called.promise;
 // Opened while the original's dispatch holds the send's lock: left alone.
 const during = composer(page(memory(copy.kept), locks.tab().locks), t);
 await settled();
 expect([during.field, during.line]).toEqual(["", null]);
 reply.resolve("{}");
 expect((await outcome).sent).toBe(true);
 // Opened after the Desk took it: the copy's send may have been sent, never the draft.
 const d = composer(page(copy, locks.tab().locks), t);
 await settled();
 expect([d.field, d.line, reservedOf(copy, t)]).toEqual(["", "Might have been sent: make deploy", []]);
});

// The reviewer's reload sequence: the dispatch is out (its ChatPrompt held before admission, no
// outcome) when the page reloads.
test("a reload while the dispatch is out shows the text as may have been sent, never as the draft; Restore makes it the draft", async () => {
 const store = memory(), t = target(), locks = lockManager(), first = locks.tab();
 const drafts = page(store, first.locks);
 const a = composer(drafts, t);
 await dispatched(a, "echo not admitted");
 drafts.pageHidden(); // sending: not this page's to call unsent
 first.close();
 const reloaded = composer(page(store, locks.tab().locks), t);
 await settled();
 expect([reloaded.field, reloaded.line, reservedOf(store, t)]).toEqual(["", "Might have been sent: echo not admitted", []]);
 await reloaded.draft.restore();
 expect([reloaded.field, reloaded.line]).toEqual(["echo not admitted", null]);
});

test("a dispatch the Desk took leaves nothing for a reload; one whose taking storage refused reads as may have been sent after it", async () => {
 const store = memory(), t = target(), locks = lockManager(), first = locks.tab();
 const a = composer(page(store, first.locks), t);
 const took = await dispatched(a, "make deploy");
 took.reply.resolve("{}");
 expect((await took.outcome).sent).toBe(true);
 const second = locks.tab(), drafts = page(store, second.locks);
 const b = composer(drafts, t);
 const lost = await dispatched(b, "make lint");
 store.refuse = true;
 lost.reply.resolve("{}");
 expect((await lost.outcome).sent).toBe(true);
 expect(b.line).toBe(null); // the page knows it went out
 drafts.pageHidden();
 second.close();
 store.refuse = false;
 const reloaded = composer(page(store, locks.tab().locks), t);
 await settled();
 expect([reloaded.field, reloaded.line]).toEqual(["", "Might have been sent: make lint"]);
});

// The reviewer's sequence: the page goes into the back/forward cache with a send queued (marked
// abandoned), a duplicated tab reads it as not sent, and the page comes back.
test("a send its page gave up never dispatches: back from the back/forward cache, the page shows it as not sent, as a copy does", async () => {
 const store = memory(), t = target(), locks = lockManager(), drafts = page(store, locks.tab().locks);
 const a = composer(drafts, t);
 await a.type("make deploy");
 const send = a.draft.reserve("make deploy");
 await a.type("make lint");
 let gaveUp = false;
 void send.gaveUp.then(() => { gaveUp = true; });
 drafts.pageHidden();
 await settled();
 expect(gaveUp).toBe(false); // hidden only: the page may come back
 expect(reservedOf(store, t)).toEqual(["make deploy (abandoned)"]);
 const d = composer(page(memory(store.kept), locks.tab().locks), t);
 await settled();
 expect([d.field, d.line]).toEqual(["make lint", "Not sent: make deploy"]);
 drafts.pageRestored();
 expect([a.field, a.line, reservedOf(store, t)]).toEqual(["make lint", "Not sent: make deploy", []]);
 await settled();
 expect(gaveUp).toBe(true); // the renderer waiting for the send's turn is told at once
 let called = false;
 expect(await send.dispatch(async () => { called = true; return "{}"; })).toEqual({ sent: false, outcome: "gone" });
 expect(called).toBe(false);
});

test("a dispatch whose send was given up meanwhile (the page went away while it waited) calls nothing, and its text comes back", async () => {
 const store = memory(), t = target(), drafts = page(store);
 const a = composer(drafts, t);
 await a.type("make deploy");
 const send = a.draft.reserve("make deploy");
 drafts.pageHidden();
 let called = false;
 expect(await send.dispatch(async () => { called = true; return "{}"; })).toEqual({ sent: false, outcome: "gone" });
 expect([called, a.field, reservedOf(store, t)]).toEqual([false, "make deploy", []]);
});

test("storage refusing the pagehide's mark, the page gives the send up all the same: back, its text is back and the composer free, and the earlier key's answer dispatches nothing", async () => {
 const store = memory(), t = target(), drafts = page(store);
 const a = composer(drafts, t);
 await a.type("make deploy");
 const send = a.draft.reserve("make deploy");
 let gaveUp = false;
 void send.gaveUp.then(() => { gaveUp = true; });
 store.refuse = true;
 drafts.pageHidden();
 expect(reservedOf(store, t)).toEqual(["make deploy"]); // storage lacks the mark
 // A page without the mark (a duplicated tab) can't tell: may have been sent.
 const d = composer(page(memory(store.kept)), t);
 await settled();
 expect([d.field, d.line]).toEqual(["", "Might have been sent: make deploy"]);
 drafts.pageRestored();
 await settled();
 expect([gaveUp, a.field]).toEqual([true, "make deploy"]);
 // The earlier key answered: the send it waited for is over.
 store.refuse = false;
 let called = false;
 expect(await send.dispatch(async () => { called = true; return "{}"; })).toEqual({ sent: false, outcome: "gone" });
 expect([called, a.field, a.line]).toEqual([false, "make deploy", null]);
});

// The reviewer's sequence: a send reserved in one document, the tab goes to another same-origin
// document (same sessionStorage), the draft is recovered and edited there, then Back.
test("back from the back/forward cache, a page reads its record again: a newer draft another page of the tab wrote is kept, and its given-up send is already back", async () => {
 const store = memory(), t = target();
 const first = page(store);
 const a = composer(first, t);
 await a.type("make deploy");
 const send = a.draft.reserve("make deploy");
 let gaveUp = false;
 void send.gaveUp.then(() => { gaveUp = true; });
 first.pageHidden();
 // The other document: the abandoned send comes back as the draft, and is edited.
 const b = composer(page(store), t);
 await settled();
 expect(b.field).toBe("make deploy");
 expect(b.type("make deploy --now")).toBe(true);
 // Back: the first page's snapshot (the reservation) is stale; the newer record wins.
 first.pageRestored();
 await settled();
 expect([a.field, a.line, storedOf(store, t), reservedOf(store, t), gaveUp]).toEqual(["make deploy --now", null, { draft: "make deploy --now", unsent: null }, [], true]);
 expect((await send.dispatch(async () => "{}")).sent).toBe(false);
});

// The reviewer's sequence: the other page sends the recovered text (the Desk takes it: the record
// is empty) and edits three times; a counting revision would come back round to the first page's.
test("back from the back/forward cache after the other page sent the recovered text and edited on, its newer draft stays: nothing is restored", async () => {
 const store = memory(), t = target();
 const first = page(store);
 const a = composer(first, t);
 await a.type("make deploy");
 const send = a.draft.reserve("make deploy");
 let gaveUp = false;
 void send.gaveUp.then(() => { gaveUp = true; });
 first.pageHidden();
 const b = composer(page(store), t);
 await settled();
 expect(b.field).toBe("make deploy");
 expect((await b.draft.reserve("make deploy").dispatch(async () => "{}")).sent).toBe(true);
 for (const text of ["m", "ma", "make lint"]) expect(b.type(text)).toBe(true);
 first.pageRestored();
 await settled();
 expect([a.field, a.line, storedOf(store, t), reservedOf(store, t), gaveUp]).toEqual(["make lint", null, { draft: "make lint", unsent: null }, [], true]);
});

test("a write starts from the record as stored: another document's newer record is read again, never overwritten with an older snapshot", async () => {
 const store = memory(), t = target();
 const a = composer(page(store), t);
 await a.type("make deploy");
 // The tab's other document: a send the Desk refused leaves Not sent beside a newer draft.
 const b = composer(page(store), t);
 await b.type("make lint");
 const send = b.draft.reserve("make lint");
 await b.type("make test");
 await send.dispatch(async () => { throw new Error("refused"); }).catch(() => {});
 expect([b.field, b.line]).toEqual(["make test", "Not sent: make lint"]);
 // The first page, holding its older snapshot, edits: the edit goes onto the newer record, whose
 // unsent line stays, and the page shows it.
 expect(a.type("make check")).toBe(true);
 expect([storedOf(store, t), a.line]).toEqual([{ draft: "make check", unsent: { text: "make lint", replaced: false, maybe: false } }, "Not sent: make lint"]);
});

test("back from the back/forward cache with nothing given up, a page shows the record as the tab's other page left it", async () => {
 const store = memory(), t = target();
 const first = page(store);
 const a = composer(first, t);
 await a.type("make deploy");
 first.pageHidden();
 const b = composer(page(store), t);
 expect(b.type("make deploy --now")).toBe(true);
 first.pageRestored();
 expect(a.field).toBe("make deploy --now");
});

test("storage denied (its getter throws) refuses like a full one: an edit is kept in the page and reported at once, a click is refused", () => {
 const t = target(), denied = () => { throw new DOMException("denied", "SecurityError"); };
 const drafts = new ComposerDrafts(denied, denied, "move", () => null);
 const a = composer(drafts, t);
 expect(a.field).toBe("");
 expect(a.type("make check")).toBe(false); // in the same turn
 expect(a.draft.draft()).toBe("make check");
 expect(a.draft.reserve("make check").outcome).toBe("refused");
 expect([a.draft.draft(), a.draft.flush()]).toEqual(["make check", false]);
});

test("a reservation storage refuses is refused at the click: the text stays the draft, and nothing is dispatched", async () => {
 const store = memory(), t = target();
 const a = composer(page(store), t);
 await a.type("clicked text");
 store.refuse = true;
 const send = a.draft.reserve("clicked text");
 expect([send.outcome, a.field, a.line]).toEqual(["refused", "clicked text", null]);
 let called = false;
 expect(await send.dispatch(async () => { called = true; return "{}"; })).toEqual({ sent: false, outcome: "gone" });
 expect(called).toBe(false);
 store.refuse = false;
 expect(await a.close()).toBe(true);
 expect([storedOf(store, t), reservedOf(store, t)]).toEqual([{ draft: "clicked text", unsent: null }, []]);
});

test("text Restore brought back while storage refuses, then a refused send of it: it stays the draft", async () => {
 const store = memory(), t = target();
 const a = composer(page(store), t);
 await refused(a, "restored text", "older draft");
 store.refuse = true;
 expect(await a.draft.restore()).toBe(false);
 expect(a.field).toBe("restored text");
 expect(a.draft.reserve("restored text").outcome).toBe("refused");
 expect([a.field, a.line]).toEqual(["restored text", "Not sent: older draft"]);
 store.refuse = false;
 expect(await a.close()).toBe(true);
 const reopened = composer(page(store), t);
 expect([reopened.field, reopened.line]).toEqual(["restored text", "Not sent: older draft"]);
});

test("a send has one dispatch: a cancel brings its text back and nothing dispatches after; a cancel or second dispatch while it is out does nothing", async () => {
 const store = memory(), t = target(), locks = lockManager();
 const a = composer(page(store, locks.tab().locks), t);
 await a.type("make deploy");
 const cancelled = a.draft.reserve("make deploy");
 await a.type("make lint");
 cancelled.cancel();
 expect([a.field, a.line, reservedOf(store, t)]).toEqual(["make lint", "Not sent: make deploy", []]);
 let called = 0;
 expect(await cancelled.dispatch(async () => { called++; return "{}"; })).toEqual({ sent: false, outcome: "gone" });
 const { send, reply, outcome } = await dispatched(a, "make test");
 send.cancel();
 expect(await send.dispatch(async () => { called++; return "{}"; })).toEqual({ sent: false, outcome: "gone" });
 expect([called, reservedOf(store, t)]).toEqual([0, ["make test (sending)"]]);
 const copied = memory(store.kept);
 composer(page(copied, locks.tab().locks), t);
 await settled();
 expect(reservedOf(copied, t)).toEqual(["make test (sending)"]); // the dispatch still holds the send's lock
 reply.resolve("{}");
 expect((await outcome).sent).toBe(true);
 expect(reservedOf(store, t)).toEqual([]);
});

test("a dispatch waits for its send lock before it marks the send sending and calls the Desk", async () => {
 const store = memory(), t = target(), granted = Promise.withResolvers<void>(), tab = lockManager().tab();
 const slow = { request: async (name: string, a: unknown, b?: unknown) => {
  if (typeof a === "function") await granted.promise;
  return (tab.locks.request as (n: string, a: unknown, b?: unknown) => Promise<unknown>)(name, a, b);
 } } as unknown as AbortableLocks;
 const a = composer(page(store, slow), t);
 await a.type("make deploy");
 const send = a.draft.reserve("make deploy");
 let called = false;
 const outcome = send.dispatch(async () => { called = true; return "{}"; });
 expect(await a.type("make lint")).toBe(true); // an edit meanwhile is stored at once
 await settled();
 expect([called, reservedOf(store, t), storedOf(store, t)]).toEqual([false, ["make deploy"], { draft: "make lint", unsent: null }]);
 granted.resolve();
 expect(await outcome).toEqual({ sent: true, value: "{}" });
 expect([called, reservedOf(store, t)]).toEqual([true, []]);
});

test("a dispatch storage refuses to mark sending calls nothing, and its text comes back", async () => {
 const store = memory(), t = target();
 const a = composer(page(store), t);
 await a.type("make deploy");
 const send = a.draft.reserve("make deploy");
 store.refuse = true;
 let called = false;
 expect(await send.dispatch(async () => { called = true; return "{}"; })).toEqual({ sent: false, outcome: "refused" });
 expect([called, a.field]).toEqual([false, "make deploy"]);
});

test("a page's own send is never its own to bring back; without Web Locks a reload brings it back on the page's word", async () => {
 const store = memory(), t = target(), drafts = page(store);
 const a = composer(drafts, t);
 await a.type("make deploy");
 expect(a.draft.reserve("make deploy").outcome).toBe("reserved");
 await a.close();
 const again = composer(drafts, t);
 await settled();
 expect([again.field, reservedOf(store, t)]).toEqual(["", ["make deploy"]]);
 drafts.pageHidden();
 const reloaded = composer(page(store), t);
 await settled();
 expect(reloaded.field).toBe("make deploy");
});

test("the desktop moves an older page's draft into the record and removes it with its first write, whatever it reads like", async () => {
 for (const old of ['{"v":1}', '{"v":1,"draft":"literal"}', "make check"]) {
  const store = memory(), t = target();
  store.kept.set("herdrup.prompt." + t, old);
  const a = composer(page(store), t);
  expect(a.field).toBe(old);
  expect([storedOf(store, t), store.kept.has("herdrup.prompt." + t)]).toEqual([{ draft: old, unsent: null }, false]);
 }
});

test("the desktop removes an older draft with the first write storage takes, and tries its removal again while it fails", async () => {
 const store = memory(), t = target();
 store.kept.set("herdrup.prompt." + t, "make deploy");
 store.refuse = true;
 const a = composer(page(store), t);
 expect([a.field, store.kept.has("herdrup.prompt." + t)]).toEqual(["make deploy", true]);
 store.refuse = false;
 store.blocked = (key, op) => op === "remove" && key.startsWith("herdrup.prompt.");
 expect(await a.type("make deploy --dry")).toBe(true);
 expect([storedOf(store, t), store.kept.has("herdrup.prompt." + t)]).toEqual([{ draft: "make deploy --dry", unsent: null }, true]);
 store.blocked = () => false;
 expect(await a.type("make deploy --now")).toBe(true);
 expect(store.kept.has("herdrup.prompt." + t)).toBe(false);
});

test("an emptied record is kept, not removed, while an older draft is still there to come back in its place", async () => {
 const store = memory(), t = target();
 store.kept.set("herdrup.prompt." + t, "make deploy");
 store.blocked = (key, op) => op === "remove" && key.startsWith("herdrup.prompt.");
 const a = composer(page(store), t);
 expect(await a.type("")).toBe(true);
 expect([storedOf(store, t), composer(page(store), t).field]).toEqual([{ draft: "", unsent: null }, ""]);
});

/** A browser tab: its own sessionStorage, the origin's localStorage (older drafts), its locks. */
const tab = (local: DraftStore, locks: AbortableLocks | null, session = memory()) => ({ session, drafts: page(session, locks, local, "show") });

test("a browser tab shows an older page's draft read-only, whole, and never moves it: the draft stays empty, the key stays, nothing is stored", async () => {
 const local = memory(), t = target(), key = "herdrup.prompt." + t;
 local.kept.set(key, "make deploy\n  --dry");
 const { session, drafts } = tab(local, lockManager().tab().locks);
 const a = composer(drafts, t);
 await settled();
 expect([a.field, a.line, a.draft.older(), local.kept.get(key), storedOf(session, t)]).toEqual(["", null, "make deploy\n  --dry", "make deploy\n  --dry", null]);
 expect(await a.type("make lint")).toBe(true);
 expect([a.draft.older(), local.kept.has(key)]).toEqual(["make deploy\n  --dry", true]);
});

test("nothing in the older draft's path reserves or dispatches it: a click on its text finds no such draft", async () => {
 const local = memory(), t = target();
 local.kept.set("herdrup.prompt." + t, "make deploy");
 const a = composer(tab(local, null).drafts, t);
 await settled();
 const send = a.draft.reserve("make deploy");
 let called = false;
 expect([send.outcome, await send.dispatch(async () => { called = true; return "{}"; })]).toEqual(["gone", { sent: false, outcome: "gone" }]);
 expect([called, a.field, a.draft.older()]).toEqual([false, "", "make deploy"]);
});

test("Dismiss removes the older draft's key while it holds the text shown; storage refusing, the key and the line stay", async () => {
 const local = memory(), t = target(), key = "herdrup.prompt." + t;
 local.kept.set(key, "make deploy");
 const a = composer(tab(local, null).drafts, t);
 local.blocked = (_key, op) => op === "remove";
 expect([a.draft.dismissOlder("make deploy"), a.draft.older()]).toEqual(["refused", "make deploy"]);
 local.blocked = () => false;
 expect([a.draft.dismissOlder("make deploy"), a.draft.older(), local.kept.has(key)]).toEqual(["removed", null, false]);
});

test("Dismiss in one tab after another wrote a newer older draft there removes nothing: the line shows the newer text, and the storage event redraws it", async () => {
 const local = memory(), t = target(), key = "herdrup.prompt." + t;
 local.kept.set(key, "make deploy");
 const drafts = tab(local, null).drafts;
 const a = composer(drafts, t);
 const shown = a.draft.older()!;
 // Another tab (an older page still open) writes its newer draft: this tab hears of it.
 local.kept.set(key, "make deploy --now");
 drafts.storageChanged(key);
 drafts.storageChanged("herdrup.web.terminals");
 expect(a.olderRedrawn).toBe(1);
 // Dismiss of the text this tab showed before it redrew: the newer one stays.
 expect([a.draft.dismissOlder(shown), a.draft.older(), local.kept.get(key)]).toEqual(["changed", "make deploy --now", "make deploy --now"]);
 expect(a.draft.dismissOlder("make deploy --now")).toBe("removed");
 drafts.storageChanged(null);
 expect([a.olderRedrawn, a.draft.older()]).toEqual([2, null]);
});

test("every tab on the pane, a duplicated one too, shows the same older draft, and none can send it", async () => {
 const local = memory(), locks = lockManager(), t = target();
 local.kept.set("herdrup.prompt." + t, "make deploy");
 const first = tab(local, locks.tab().locks);
 const a = composer(first.drafts, t);
 await a.type("make lint");
 const clone = composer(tab(local, locks.tab().locks, memory(first.session.kept)).drafts, t);
 const other = composer(tab(local, locks.tab().locks).drafts, t);
 await settled();
 expect([a.draft.older(), clone.draft.older(), other.draft.older()]).toEqual(["make deploy", "make deploy", "make deploy"]);
 expect([clone.field, other.field]).toEqual(["make lint", ""]);
 expect([clone.draft.reserve("make deploy").outcome, other.draft.reserve("make deploy").outcome]).toEqual(["gone", "gone"]);
});

test("the desktop shows no older-draft line: it moved the draft into the record", () => {
 const store = memory(), t = target();
 store.kept.set("herdrup.prompt." + t, "make deploy");
 const a = composer(page(store), t);
 expect([a.field, a.draft.older()]).toEqual(["make deploy", null]);
});

test("a dispatch runs with its reservation's text, not the draft typed after the click", async () => {
 const store = memory(), t = target();
 const a = composer(page(store), t);
 await a.type("make deploy");
 const send = a.draft.reserve("make deploy");
 await a.type("make lint");
 const sent: string[] = [];
 expect((await send.dispatch(async (text) => { sent.push(text); return "{}"; })).sent).toBe(true);
 expect([sent, a.field]).toEqual([["make deploy"], "make lint"]);
});

test("an open copy waits for the original's send lock: once the dispatch ends, the copy's send shows as may have been sent", async () => {
 const store = memory(), t = target(), locks = lockManager(), original = locks.tab();
 const a = composer(page(store, original.locks), t);
 const { reply, outcome } = await dispatched(a, "make deploy");
 const copy = memory(store.kept);
 const during = composer(page(copy, locks.tab().locks), t);
 await settled();
 expect([during.field, during.line, locks.waiting()]).toEqual(["", null, 1]);
 reply.resolve("{}");
 expect((await outcome).sent).toBe(true);
 await settled();
 expect([during.field, during.line, reservedOf(copy, t), locks.waiting()]).toEqual(["", "Might have been sent: make deploy", [], 0]);
});

test("a copy closed while the original dispatches gives its wait up: nothing changes in it when the dispatch ends", async () => {
 const store = memory(), t = target(), locks = lockManager(), original = locks.tab();
 const a = composer(page(store, original.locks), t);
 const { reply, outcome } = await dispatched(a, "make deploy");
 const copy = memory(store.kept);
 const during = composer(page(copy, locks.tab().locks), t);
 await settled();
 expect(locks.waiting()).toBe(1);
 await during.close();
 await settled();
 expect(locks.waiting()).toBe(0);
 reply.resolve("{}");
 await outcome;
 await settled();
 expect([during.line, reservedOf(copy, t)]).toEqual([null, ["make deploy (sending)"]]);
});

test("a copy's composer closed and opened again in the same turn still waits for the original's send, and shows it once the dispatch ends", async () => {
 const store = memory(), t = target(), locks = lockManager(), original = locks.tab();
 const a = composer(page(store, original.locks), t);
 const { reply, outcome } = await dispatched(a, "make deploy");
 const copy = memory(store.kept);
 const during = composer(page(copy, locks.tab().locks), t);
 during.draft.detach(during.view);
 during.draft.attach(during.view);
 await settled();
 expect([during.line, locks.waiting()]).toEqual([null, 1]);
 reply.resolve("{}");
 await outcome;
 await settled();
 expect([during.line, reservedOf(copy, t), locks.waiting()]).toEqual(["Might have been sent: make deploy", [], 0]);
});

test("a wait granted just as its composer closed brings nothing back: only an open composer's wait recovers", async () => {
 const store = memory(), t = target(), locks = lockManager(), original = locks.tab();
 const a = composer(page(store, original.locks), t);
 const { reply, outcome } = await dispatched(a, "make deploy");
 const copy = memory(store.kept);
 // The copy's locks: the wait is granted, and the composer closes before the wait's answer comes
 // back.
 let closeOnGrant = () => {};
 const granting = { request: async (_name: string, _options: unknown, granted: () => Promise<unknown>) => {
  const value = await granted();
  closeOnGrant();
  return value;
 } } as unknown as AbortableLocks;
 const during = composer(page(copy, granting), t);
 closeOnGrant = () => during.draft.detach(during.view);
 await settled();
 expect([during.line, reservedOf(copy, t)]).toEqual([null, ["make deploy (sending)"]]);
 reply.resolve("{}");
 await outcome;
});
