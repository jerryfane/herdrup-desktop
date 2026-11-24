// The browser's account devices and saved-prompt sync (src/web/accountDesk.ts, src/web/prompts.ts),
// the ports of desk_account_devices.go and desk_account_sync.go, against a fake account service:
// its sync (GET/POST /v1/sync, as AccountService sync.ts) and devices (devices.ts), one session
// per browser. The prompt cases are app/desk_account_sync_test.go's.
import { expect, setSystemTime, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import type { SavedPrompt } from "../src/mygo";
import { WebAccount, type AccountDevice, type SyncChange, type SyncItem } from "../src/web/account";
import { accountDevicesOf, createAccountDesk } from "../src/web/accountDesk";
import { events } from "../src/web/events";
import type { AbortableLocks } from "../src/web/locks";
import { ACCOUNT_SYNC_KEY, batches, createAccountSync, deadlineOf, matchLanding, SAVED_PROMPTS_KEY, sentHash, settleSends, validPrompt, type PromptAttempt } from "../src/web/prompts";
import { toB64url } from "../src/webguest/b64url";
import { staticKey } from "../src/webguest/identity";

const access = (n: number) => `a1.${"s".repeat(22)}.${String(n).padStart(43, "0")}`;

/** The most prompts an account holds (sync.ts COLLECTION_CAPS.prompts). */
const PROMPTS_CAP = 500;

/** localStorage for one browser; writes counts setItem calls per key. With a quota (UTF-16 code
 *  units, as browsers count), a write past it throws QuotaExceededError and stores nothing, as
 *  does a write to a key refuses names (a storage near its quota for that one write). */
function memory(quota = Infinity) {
 const items = new Map<string, string>(), writes = new Map<string, number>();
 const store = {
  writes, quota, refuses: null as ((key: string) => boolean) | null,
  /** What the storage holds now, in the units the quota counts. */
  used: () => [...items].reduce((n, [k, v]) => n + k.length + v.length, 0),
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => {
   const used = [...items].reduce((n, [k, v]) => n + (k === key ? 0 : k.length + v.length), 0);
   if (used + key.length + value.length > store.quota || store.refuses?.(key)) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
   items.set(key, value); writes.set(key, (writes.get(key) ?? 0) + 1);
  },
  removeItem: (key: string) => { items.delete(key); },
  key: (i: number) => [...items.keys()][i] ?? null,
  get length() { return items.size; },
 };
 return store;
}
/** The sync state in a browser's one record (prompts.ts Stored). */
const syncOf = (storage: Pick<Storage, "getItem">) => JSON.parse(storage.getItem(SAVED_PROMPTS_KEY)!).sync;
/** A prompt's sends still open: in the record and not marked refused (a marker not folded yet). */
const openSends = (storage: ReturnType<typeof memory>, id: string): string[] =>
 ((syncOf(storage).promptAttempts?.[id] ?? []) as PromptAttempt[]).flatMap(e => e.open).filter(s => storage.getItem(`herdrup.sync.send.${id}.${s}`)?.[0] !== "r");
/** The send markers in storage (prompts.ts: herdrup.sync.send.<prompt>.<send>), with their values. */
const markers = (storage: ReturnType<typeof memory>) => Array.from({ length: storage.length }, (_, i) => storage.key(i)!).filter(k => k.startsWith("herdrup.sync.send.")).map(k => [k, storage.getItem(k)] as const);

/** The account service: one account's sync items and devices, and a session per browser. */
function worker() {
 const items = new Map<string, SyncItem>();
 const devices: AccountDevice[] = [];
 const sessions = new Map<string, { device: string | null; ended: boolean }>();
 const w = {
  rev: 0, pushes: 0, failPush: false, maxDevices: 20, onPush: null as (() => void) | null,
  /** Runs before each push is applied, every time (onPush: the next one only). */
  everyPush: null as (() => void) | null,
  /** The revision below which a pull may have missed a pruned tombstone (sync.ts sync_floor). */
  floor: 0,
  /** Tombstones at or below rev go and the floor rises to it (sync.ts:357-362, :432-443). */
  prune(rev: number) { w.floor = Math.max(w.floor, rev); for (const [id, it] of items) if (it.deleted && it.rev <= w.floor) items.delete(id); },
  /** The account's live items, every collection (sync.ts MAX_ACCOUNT_ITEMS). */
  maxItems: 2000,
  /** The account a refresh signs the cookie in to (another sign-in changes it). */
  accountId: "acct",
  /** Items per sync page (sync.ts: 500); a page with more names the next by cursor `<lastRev>.<base>`. */
  pageSize: 500, onNextPage: null as (() => void) | null,
  /** The next push is applied, and its answer lost (a 503 instead). */
  losePush: false,
  /** GET /v1/sync answers nothing until its request is aborted. */
  stallPull: false,
  /** The next push is answered 401 (its token no longer good: nothing written); onUnauthorized
   *  runs then, before the browser refreshes and tries again. */
  pushUnauthorized: false, onUnauthorized: null as (() => void) | null,
  /** The service's clock (ms), told as now_ms in every sync answer unless omitNow (a service
   *  without themartianapp/herdrup#826); a push it is past the not_after of is refused (409
   *  expired), counted in expired. */
  serverNow: Date.UTC(2026, 10, 24, 12), omitNow: false, expired: 0,
  /** The next push refused (401, 403 or 413) answers its status line and then never ends its body
   *  (stallErrorBody), or ends it cut short (truncateErrorBody). */
  stallErrorBody: false, truncateErrorBody: false,
  /** Runs once, as the next refusal (401, 403 or 413) is answered. */
  onRefusal: null as (() => void) | null,
  /** Runs once, as the next GET /v1/sync comes in; holdPull then keeps that GET until it resolves. */
  onPull: null as (() => void) | null, holdPull: null as Promise<void> | null,
  /** The next refresh is answered 503 (the service unavailable). */
  refreshUnavailable: false,
  /** The next refresh is answered 200 with a body that starts and never ends (its read waits
   *  until the browser gives the refresh up). */
  holdRefreshBody: false,
  /** Sign-outs received (POST /v1/auth/signout), and when (Date.now()) the last came. */
  signOuts: 0, signedOutAt: 0,
  /** Pushes refused for their size (413 too_large), and the size limit (sync.ts:42, 256 KiB; a
   *  test lowers it to make a push the browser sized refused anyway). */
  tooLarge: 0, bodyLimit: 256 * 1024,
  /** The bodies of every push received (the sent changes), in order, and each one's not_after. */
  pushed: [] as SyncChange[][], notAfters: [] as (number | undefined)[],
  /** The account's storage quota in prompt-body bytes (0: none); a push past it is refused whole. */
  quotaBytes: 0,
  /** Device challenges and enrolment POSTs answered; a challenge waits for challengeGate. */
  challenges: 0, enrolments: 0, challengeGate: null as Promise<void> | null,
  /** GET /v1/devices fails (503) for a session bound to a device. */
  listFailsBound: false,
  /** POST /v1/sync requests answered, taken or not; with rateLimit, more than that many in one
   *  window (newWindow starts the next minute) get 429, as the service's 30 a minute. */
  posts: 0, rateLimit: 0, windowPosts: 0,
  newWindow() { w.windowPosts = 0; },
  /** Runs once, after the next push is applied and before it is answered. */
  afterPush: null as (() => void) | null,
  /** The next push is a late one: kept unapplied (held, oldest first) and never answered, so the
   *  browser gives it up at its deadline; landHeld lands the oldest now, unless the service is
   *  past its not_after then (refused, as a late request would be). */
  holdNextPush: false,
  landHeld() {
   const late = held.shift()!;
   if (late.notAfter !== undefined && w.serverNow > late.notAfter) { w.expired++; return; }
   apply(late.changes);
  },
  /** What the account holds as its quota counts it: every live item's body, prompts and machines. */
  usedBytes: () => [...stored().values()].reduce((n, body) => n + body.length, 0),
  seedPrompt(id: string, body: object) { w.rev++; items.set(id, { collection: "prompts", id, rev: w.rev, updated_ms: w.serverNow, deleted: false, body }); },
  seedTombstone(id: string, collection = "prompts") { w.rev++; items.set(id, { collection, id, rev: w.rev, updated_ms: w.serverNow, deleted: true, body: null }); },
  seedHost(id: string, body: object) { w.rev++; items.set(id, { collection: "hosts", id, rev: w.rev, updated_ms: w.serverNow, deleted: false, body }); },
  /** The account's history starts over, as after a restored database. */
  reset() { items.clear(); w.rev = 0; w.floor = 0; },
  livePrompts(): Record<string, string> {
   return Object.fromEntries([...items.values()].filter(it => it.collection === "prompts" && !it.deleted).map(it => [it.id, JSON.stringify(it.body)]));
  },
  devices,
  addDevice(name: string, created: number) { devices.push({ id: `dev${devices.length}`.padEnd(22, "x"), name, platform: "macos", device_pub: `pub-${name}`, created_ms: created }); },
  /** The page fetch of one browser, with its own session. */
  fetcher(session: string): typeof fetch {
   sessions.set(session, { device: null, ended: false });
   let n = 0;
   const answer = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    // As fetch: a request whose signal already aborted isn't sent.
    init.signal?.throwIfAborted();
    const url = new URL(String(input)), method = init.method ?? "GET", s = sessions.get(session)!;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.pathname === "/v1/auth/signout") { w.signOuts++; w.signedOutAt = Date.now(); return new Response(null, { status: 204 }); }
    if (url.pathname === "/v1/auth/refresh") {
     if (w.holdRefreshBody) {
      w.holdRefreshBody = false;
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(`{"account_id":"${w.accountId}",`)); } });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
     }
     if (s.ended) return Response.json({ error: "session_revoked" }, { status: 401 });
     if (w.refreshUnavailable) { w.refreshUnavailable = false; return Response.json({ error: "unavailable" }, { status: 503 }); }
     n++; return Response.json({ account_id: w.accountId, access_token: access(n), access_expires_in: 3600 });
    }
    if (s.ended) return Response.json({ error: "invalid_token" }, { status: 401 });
    if (url.pathname === "/v1/sync" && method === "GET") {
     const pulled = w.onPull; w.onPull = null; pulled?.();
     if (w.holdPull) { const gate = w.holdPull; w.holdPull = null; await gate; }
     if (w.stallPull) {
      const stalled = Promise.withResolvers<Response>();
      init.signal!.addEventListener("abort", () => stalled.reject(init.signal!.reason));
      return stalled.promise;
     }
     const cursor = url.searchParams.get("cursor");
     if (cursor !== null) { const hook = w.onNextPage; w.onNextPage = null; hook?.(); }
     const position = Number(cursor !== null ? cursor.split(".")[0] : url.searchParams.get("since"));
     // sync.ts:333-335: the copy is complete up to max(position, base), base being the account's
     // revision when a full pull began; past the account's revision (another history) or below
     // the floor (a pruned tombstone may be missed), start over.
     const base = cursor !== null ? Number(cursor.split(".")[1]) : position === 0 ? w.rev : position;
     const complete = Math.max(position, base);
     if (complete > w.rev || complete < w.floor) return Response.json({ error: "reset_required" }, { status: 410 });
     // now_ms is read before the rows (themartianapp/herdrup#826): nothing the page holds was
     // written after it.
     const told = now();
     const changes = [...items.values()].filter(it => it.rev > position).sort((a, b) => a.rev - b.rev);
     const page = changes.slice(0, w.pageSize), more = changes.length > page.length;
     return Response.json({ rev: w.rev, changes: page, more, ...(more ? { cursor: `${page.at(-1)!.rev}.${base}` } : {}), ...told });
    }
    if (url.pathname === "/v1/sync" && method === "POST") return push(String(init.body), body.changes as SyncChange[], body.not_after as number | undefined, init.signal ?? undefined);
    if (url.pathname === "/v1/devices/challenge") {
     w.challenges++;
     await w.challengeGate;
     return Response.json({ challenge_id: "c".repeat(22), server_pub: toB64url(x25519.getPublicKey(x25519.utils.randomSecretKey())), salt: toB64url(new Uint8Array(32).fill(1)), account_id: "acct", expires_in: 60 });
    }
    if (url.pathname === "/v1/devices" && method === "POST") {
     w.enrolments++;
     let device = devices.find(d => d.device_pub === body.device_pub);
     if (device === undefined && devices.length >= w.maxDevices) return Response.json({ error: "too_many_devices" }, { status: 403 });
     device ??= devices[devices.push({ id: `web${devices.length}`.padEnd(22, "x"), name: String(body.name), platform: String(body.platform), device_pub: String(body.device_pub), created_ms: 100 + devices.length }) - 1]!;
     s.device = device.id;
     return Response.json({ device }, { status: 201 });
    }
    if (url.pathname === "/v1/devices" && s.device !== null && w.listFailsBound) return Response.json({ error: "unavailable" }, { status: 503 });
    if (url.pathname === "/v1/devices") return Response.json({ devices: devices.map(d => ({ ...d, current: d.id === s.device })) });
    const id = /^\/v1\/devices\/(.+)$/.exec(url.pathname)?.[1];
    const i = devices.findIndex(d => d.id === id);
    if (i < 0) return Response.json({ error: "not_found" }, { status: 404 });
    if (method === "PATCH") { devices[i]!.name = String(body.name); return Response.json({ device: devices[i] }); }
    devices.splice(i, 1);
    for (const other of sessions.values()) if (other.device === id) other.ended = true;
    return new Response(null, { status: 204 });
   };
   return answer as typeof fetch;
  },
 };
 const held: { changes: SyncChange[]; notAfter?: number }[] = [];
 /** now_ms for an answer: the service's clock, or nothing (omitNow). */
 const now = () => w.omitNow ? {} : { now_ms: w.serverNow };
 /** A refusal: its status, and its error body, or one that never ends (stallErrorBody) or is cut
  *  short (truncateErrorBody). */
 const refusal = (status: number, error: string): Response => {
  const refusing = w.onRefusal; w.onRefusal = null; refusing?.();
  const stall = w.stallErrorBody, truncate = w.truncateErrorBody;
  if (!stall && !truncate) return Response.json({ error }, { status });
  w.stallErrorBody = false; w.truncateErrorBody = false;
  return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(`{"error":`)); if (truncate) c.close(); } }), { status, headers: { "Content-Type": "application/json" } });
 };
 /** The account's storage as quota counts it: every live item's body, prompts and machines. */
 const stored = () => new Map([...items.values()].filter(it => !it.deleted).map(it => [it.id, JSON.stringify(it.body)]));
 /** Writes changes as sync.ts does: one with base_rev only while the item is still at that
  *  revision (0: no such item), a delete only of an item held, an unchanged one not again. Then the
  *  account's caps (500 prompts, maxItems live items, quotaBytes of bodies): a push past one is
  *  refused whole (null). Otherwise the answer: each change applied when the account now holds
  *  what it asked for, else a conflict with the account's copy. */
 function apply(changes: SyncChange[]): { applied: object[]; conflicts: object[] } | null {
  const next = new Map(items);
  let rev = w.rev;
  for (const c of changes) {
   const was = next.get(c.id);
   if (c.base_rev !== undefined && c.base_rev !== (was?.rev ?? 0)) continue;
   if (c.deleted ? was === undefined || was.deleted : was !== undefined && !was.deleted && JSON.stringify(was.body) === JSON.stringify(c.body)) continue;
   rev++;
   next.set(c.id, { collection: c.collection, id: c.id, rev, updated_ms: w.serverNow, deleted: !!c.deleted, body: c.deleted ? null : c.body });
  }
  const live = [...next.values()].filter(it => !it.deleted);
  const bytes = live.reduce((n, it) => n + JSON.stringify(it.body).length, 0);
  if (live.filter(it => it.collection === "prompts").length > PROMPTS_CAP || live.length > w.maxItems || (w.quotaBytes > 0 && bytes > w.quotaBytes)) return null;
  items.clear();
  for (const [id, it] of next) items.set(id, it);
  w.rev = rev;
  const applied: object[] = [], conflicts: object[] = [];
  for (const c of changes) {
   const row = items.get(c.id);
   const holds = (row === undefined || row.deleted) === !!c.deleted && (c.deleted || JSON.stringify(row!.body) === JSON.stringify(c.body));
   if (holds) applied.push({ collection: c.collection, id: c.id, rev: row?.rev ?? 0 });
   else conflicts.push({ collection: c.collection, id: c.id, server: row ?? null });
  }
  return { applied, conflicts };
 }
 // sync.ts: a push over 100 changes or 256 KiB is refused whole, as is one holding an item it
 // won't keep or one past a cap (apply).
 function push(raw: string, changes: SyncChange[], notAfter: number | undefined, signal?: AbortSignal): Response | Promise<Response> {
  w.posts++;
  w.pushed.push(changes); w.notAfters.push(notAfter);
  if (w.pushUnauthorized) { w.pushUnauthorized = false; w.onUnauthorized?.(); return refusal(401, "invalid_token"); }
  if (w.rateLimit > 0 && ++w.windowPosts > w.rateLimit) return Response.json({ error: "rate_limited" }, { status: 429 });
  // sync.ts:42, :367-371: a body over MAX_SYNC_BODY_BYTES (256 KiB) or over 100 changes is 413.
  if (new TextEncoder().encode(raw).byteLength > w.bodyLimit || changes.length > 100) { w.tooLarge++; return refusal(413, "too_large"); }
  if (w.failPush) return Response.json({ error: "unavailable" }, { status: 503 });
  const hook = w.onPush; w.onPush = null; hook?.();
  w.everyPush?.();
  for (const c of changes) {
   if (c.body === undefined) continue;
   const b = c.body as { title?: string; text?: string };
   if (!b.text || new TextEncoder().encode(b.text).byteLength > 8192 || [...b.title ?? ""].length > 128) return Response.json({ error: "invalid_item" }, { status: 400 });
   if (new TextEncoder().encode(JSON.stringify(c.body)).byteLength > 16 * 1024) return Response.json({ error: "too_large" }, { status: 413 });
  }
  if (w.holdNextPush) {
   w.holdNextPush = false; held.push({ changes, notAfter });
   const given = Promise.withResolvers<Response>();
   signal?.addEventListener("abort", () => given.reject(signal.reason));
   return given.promise;
  }
  // themartianapp/herdrup#826: not_after is checked inside the write, at the moment it applies (a
  // held one too: landHeld), so one past it writes nothing.
  if (notAfter !== undefined && w.serverNow > notAfter) { w.expired++; return Response.json({ error: "expired" }, { status: 409 }); }
  const answer = apply(changes);
  if (answer === null) return refusal(403, "quota");
  w.pushes++;
  const after = w.afterPush; w.afterPush = null; after?.();
  if (w.losePush) { w.losePush = false; return Response.json({ error: "unavailable" }, { status: 503 }); }
  return Response.json({ rev: w.rev, ...answer, ...now() });
 }
 return w;
}

type Worker = ReturnType<typeof worker>;
let sessions = 0;

/** A signed-in browser of the account: its account and prompt Desk methods over its own storage.
 *  where sets how its syncs take turns with other tabs (none by default) and how long one may take. */
async function browser(w: Worker, storage = memory(), where: { locks?: AbortableLocks; roundMs?: number } = {}) {
 const secret = x25519.utils.randomSecretKey();
 const key = staticKey({ v: 1, kind: "raw", secret, publicKey: x25519.getPublicKey(secret) });
 const page = { origin: "https://guest.herdrup.app", href: "https://guest.herdrup.app/web/", fetch: w.fetcher(`s${++sessions}`), navigate() {}, replaceURL() {} };
 const made = createAccountDesk(page, { key: async () => key, name: "Chrome on macOS", storage: () => storage, locks: where.locks ?? null, background: false, roundMs: where.roundMs });
 await made.desk.accountCheck();
 return { ...made.desk, ...made.sync.prompts, sync: made.sync, account: made.account, key, storage };
}
type Browser = Awaited<ReturnType<typeof browser>>;

async function syncEach(...list: Browser[]) { for (const b of list) await b.accountSyncNow(); }
async function save(b: Browser, id: string, nickname: string, text: string): Promise<SavedPrompt> {
 const list = await b.savePrompt({ id, nickname, text });
 return id ? list.find(p => p.id === id)! : list.at(-1)!;
}
const byID = async (b: Browser) => Object.fromEntries((await b.savedPrompts()).map(p => [p.id, p]));

test("prompts saved in two browsers reach both; an edit on one reaches the other, and so does a delete", async () => {
 const w = worker();
 const [mac, linux] = [await browser(w), await browser(w)];
 const a = await save(mac, "", "standup", "What did you do?");
 const b = await save(linux, "", "", "Run the tests\nthen push");
 await syncEach(mac, linux, mac);
 for (const d of [mac, linux]) expect(await byID(d)).toEqual({ [a.id]: a, [b.id]: b });
 expect(Object.keys(w.livePrompts()).length).toBe(2);

 const edited = await save(mac, a.id, "Standup", "What did you do yesterday?");
 await syncEach(mac, linux);
 expect((await byID(linux))[a.id]).toEqual(edited);

 await linux.deletePrompt(b.id);
 await syncEach(linux, mac);
 expect(await byID(mac)).toEqual({ [a.id]: edited });
 expect(w.livePrompts()[b.id]).toBeUndefined();
 expect(syncOf(linux.storage).promptDeletes).toEqual([]);
});

test("signing in with prompts keeps the account's too, after this browser's; an old tombstone takes nothing", async () => {
 const w = worker();
 const phone = "00000000-0000-4000-8000-000000000001", phone2 = "00000000-0000-4000-8000-000000000002", old = "00000000-0000-4000-8000-000000000003";
 w.seedTombstone(old);
 w.seedPrompt(phone2, { text: "second", order: 1 });
 w.seedPrompt(phone, { title: "From the phone", text: "hello", order: 0 });
 const storage = memory();
 // A state from before prompts synced: its mirror is past the prompts' revisions.
 storage.setItem(ACCOUNT_SYNC_KEY, JSON.stringify({ accountId: "acct", mirror: { rev: 3, hosts: [], prompts: [] } }));
 const mac = await browser(w, storage);
 const [kept] = await mac.importSavedPrompts([{ id: old, nickname: "", text: "from localStorage" }]);
 const own = await save(mac, "", "desk", "from the desktop");
 await syncEach(mac);
 expect(await mac.savedPrompts()).toEqual([kept!, own, { id: phone, nickname: "From the phone", text: "hello" }, { id: phone2, nickname: "", text: "second" }]);
 expect(w.livePrompts()[own.id]).toBe(`{"title":"desk","text":"from the desktop","order":3}`);
 const linux = await browser(w);
 await syncEach(linux);
 const theirs = await byID(linux);
 expect([Object.keys(theirs).length, theirs[own.id], theirs[old]]).toEqual([4, own, kept!]);
});

test("a prompt travels as title (none when empty), text and order; an edit keeps the account's order", async () => {
 const w = worker();
 const [mac, linux] = [await browser(w), await browser(w)];
 const daily = await save(mac, "", "  daily  ", "line one\n\tline two");
 const bare = await save(mac, "", "", "no title");
 await syncEach(mac);
 expect([w.livePrompts()[daily.id], w.livePrompts()[bare.id]]).toEqual([`{"title":"daily","text":"line one\\n\\tline two","order":0}`, `{"text":"no title","order":1}`]);
 await syncEach(linux);
 await save(linux, bare.id, "titled", "no title, edited");
 await syncEach(linux);
 expect(w.livePrompts()[bare.id]).toBe(`{"title":"titled","text":"no title, edited","order":1}`);
});

test("a prompt the service would refuse isn't sent and leaves the round failed; one past the account's cap is refused and stays here", async () => {
 const w = worker();
 const mac = await browser(w);
 const long = await save(mac, "", "", "x".repeat(8193));
 const quotes = await save(mac, "", "", "x" + `"`.repeat(8191));
 const good = await save(mac, "", "", "fits");
 await expect(mac.accountSyncNow()).rejects.toThrow("too long");
 expect([Object.keys(w.livePrompts()), (await mac.accountSyncStatus()).lastSyncedMs, (await mac.accountState()).syncFailed]).toEqual([[good.id], 0, true]);
 expect(Object.keys(await byID(mac))).toEqual([long.id, quotes.id, good.id]);
 await mac.deletePrompt(long.id); await mac.deletePrompt(quotes.id);
 for (let i = 0; i < PROMPTS_CAP - 1; i++) w.seedPrompt(`00000000-0000-4000-9000-${String(i).padStart(12, "0")}`, { text: "seeded" });
 const over = await save(mac, "", "", "one too many");
 await expect(mac.accountSyncNow()).rejects.toThrow("quota");
 expect([Object.keys(w.livePrompts()).length, over.id in w.livePrompts(), over.id in await byID(mac)]).toEqual([PROMPTS_CAP, false, true]);
});

test("a prompt deleted elsewhere goes here too, unless it was edited here since: then the edit is pushed back", async () => {
 const w = worker();
 const [mac, linux] = [await browser(w), await browser(w)];
 const kept = await save(mac, "", "", "keep me");
 const gone = await save(mac, "", "", "drop me");
 await syncEach(mac, linux);
 await linux.deletePrompt(kept.id); await linux.deletePrompt(gone.id);
 await syncEach(linux);
 const edited = await save(mac, kept.id, "", "keep me, edited");
 await syncEach(mac);
 expect(await byID(mac)).toEqual({ [kept.id]: edited });
 expect(w.livePrompts()[kept.id]).toContain("keep me, edited");
});

test("forty 8 KB prompts go in as many pushes as the service's byte limit needs", async () => {
 const w = worker();
 const mac = await browser(w);
 for (let i = 0; i < 40; i++) await save(mac, "", "", String(i).padStart(2, "0") + "x".repeat(8000));
 await syncEach(mac);
 expect([Object.keys(w.livePrompts()).length, w.pushes >= 2]).toEqual([40, true]);
});

test("a prompt deleted while its first upload is on the way is deleted in the account by the next sync", async () => {
 const w = worker();
 const [mac, linux] = [await browser(w), await browser(w)];
 const p = await save(mac, "", "", "short-lived");
 w.onPush = () => { void mac.deletePrompt(p.id); };
 await syncEach(mac, mac, linux);
 expect([await mac.savedPrompts(), w.livePrompts()[p.id], await linux.savedPrompts()]).toEqual([[], undefined, []]);
});

test("the account page's status is the account's at the newest good sync; a failed one needs attention and leaves it", async () => {
 const w = worker();
 w.seedHost("10000000-0000-4000-8000-000000000001", { host: "pi", username: "root", auth_kind: "key" });
 const mac = await browser(w);
 expect(await mac.accountSyncStatus()).toEqual({ lastSyncedMs: 0, machines: 0, prompts: 0 });
 const first = await save(mac, "", "", "one");
 await save(mac, "", "", "two");
 const start = Date.now();
 await mac.accountSyncNow();
 // A delete not yet synced: the status is still the account's.
 await mac.deletePrompt(first.id);
 const before = await mac.accountSyncStatus();
 expect([before.machines, before.prompts, before.lastSyncedMs >= start]).toEqual([1, 2, true]);

 w.seedPrompt("00000000-0000-4000-8000-000000000001", { text: "from the phone" });
 w.failPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow("503");
 expect([await mac.accountSyncStatus(), (await mac.accountState()).syncFailed]).toEqual([before, true]);
 w.failPush = false;
 await mac.accountSyncNow();
 expect((await mac.accountState()).syncFailed).toBeUndefined();
});

test("an account that answers reset_required is pulled whole again: what it no longer holds goes here too", async () => {
 const w = worker();
 const mac = await browser(w);
 const a = await save(mac, "", "", "from before");
 await save(mac, "", "", "also from before");
 await syncEach(mac);
 // The account's history starts over (restored): it holds another prompt, at a lower revision.
 const other = "00000000-0000-4000-8000-0000000000aa";
 w.reset();
 w.seedPrompt(other, { title: "Restored", text: "after the restore", order: 0 });
 await syncEach(mac);
 expect(await mac.savedPrompts()).toEqual([{ id: other, nickname: "Restored", text: "after the restore" }]);
 expect(a.id in w.livePrompts()).toBe(false);
});

test("devices: this browser first, then oldest first; why it isn't listed only while it isn't", () => {
 const d = (id: string, created: number, current = false): AccountDevice => ({ id, name: id, platform: "web", device_pub: id, created_ms: created, current });
 expect(accountDevicesOf([d("b", 2), d("a", 1), d("me", 3, true)], "too_many_devices")).toEqual({ devices: [
  { id: "me", name: "me", platform: "web", createdMs: 3, current: true },
  { id: "a", name: "a", platform: "web", createdMs: 1, current: false },
  { id: "b", name: "b", platform: "web", createdMs: 2, current: false },
 ] });
 expect(accountDevicesOf([d("a", 1)], "too_many_devices").enrolment).toBe("too_many_devices");
});

test("a browser not yet among the devices is added when they're listed; a refusal says why until Try again", async () => {
 const w = worker();
 w.addDevice("Jerry's MacBook Pro", 1);
 w.maxDevices = 1;
 const chrome = await browser(w);
 expect(await chrome.accountDevices()).toEqual({ devices: [{ id: w.devices[0]!.id, name: "Jerry's MacBook Pro", platform: "macos", createdMs: 1, current: false }], enrolment: "too_many_devices" });
 w.maxDevices = 20;
 // Not asked again on its own: the refusal stands until Try again.
 expect((await chrome.accountDevices()).enrolment).toBe("too_many_devices");
 const again = await chrome.accountEnrolAgain();
 expect(again.enrolment).toBeUndefined();
 expect(again.devices.map(d => [d.name, d.platform, d.current])).toEqual([["Chrome on macOS", "web", true], ["Jerry's MacBook Pro", "macos", false]]);
});

test("rename sends the name as the service keeps it; removing another device leaves this session, removing this browser ends it", async () => {
 const w = worker();
 w.addDevice("Old laptop", 1);
 const chrome = await browser(w);
 const [me, laptop] = (await chrome.accountDevices()).devices;
 await chrome.accountRenameDevice(laptop!.id, "  Spare\u0007 laptop ");
 expect(w.devices.find(d => d.id === laptop!.id)!.name).toBe("Spare laptop");
 await expect(chrome.accountRenameDevice(laptop!.id, " \u0007 ")).rejects.toThrow("400 bad_request");
 await chrome.accountRemoveDevice(laptop!.id);
 expect([w.devices.length, (await chrome.accountState()).signedIn]).toEqual([1, true]);
 await chrome.accountRemoveDevice(me!.id);
 expect([w.devices.length, (await chrome.accountState()).signedIn]).toEqual([0, false]);
 await expect(chrome.accountRenameDevice(me!.id, "x")).rejects.toThrow("Signed out");
});

test("the push limits and the service's prompt checks, as the browser applies them before sending", () => {
 const change = (i: number, size: number): SyncChange => ({ collection: "prompts", id: String(i), body: { text: "x".repeat(size) } });
 expect(batches(Array.from({ length: 101 }, (_, i) => change(i, 1))).map(b => b.length)).toEqual([100, 1]);
 expect(batches(Array.from({ length: 40 }, (_, i) => change(i, 8000))).map(b => b.length)).toEqual([32, 8]);
 expect([validPrompt({ text: "ok", title: "t".repeat(128) }), validPrompt({ text: "ok", title: "t".repeat(129) })]).toEqual([true, false]);
 expect([validPrompt({ text: "tab\tand\nlines" }), validPrompt({ text: "bell\u0007" }), validPrompt({ text: "" }), validPrompt({ text: "lone \ud800" })]).toEqual([true, false, false, false]);
 expect([validPrompt({ text: "é".repeat(4096) }), validPrompt({ text: "é".repeat(4097) })]).toEqual([true, false]);
});

test("a prompt live on one pull page and deleted before the next is not brought back", async () => {
 const w = worker();
 const gone = "00000000-0000-4000-8000-000000000001";
 w.seedPrompt(gone, { text: "deleted while pulled", order: 0 });
 w.seedPrompt("00000000-0000-4000-8000-000000000002", { text: "two", order: 1 });
 w.seedPrompt("00000000-0000-4000-8000-000000000003", { text: "three", order: 2 });
 w.pageSize = 2;
 // Another device deletes it between this browser's first page and its second.
 w.onNextPage = () => w.seedTombstone(gone);
 const mac = await browser(w);
 await syncEach(mac, mac);
 expect([gone in await byID(mac), gone in w.livePrompts(), Object.keys(await byID(mac)).length]).toEqual([false, false, 2]);
});

test("a delete from another device that arrives with this browser's readback is not uploaded again", async () => {
 const w = worker();
 const [mac, linux] = [await browser(w), await browser(w)];
 const p = await save(mac, "", "", "deleted on linux");
 await syncEach(mac, linux);
 await save(mac, "", "", "new on mac");
 // Linux's delete lands while mac pushes its new prompt: mac reads it back with its own write.
 w.onPush = () => w.seedTombstone(p.id);
 await syncEach(mac, mac);
 expect([p.id in await byID(mac), p.id in w.livePrompts(), Object.keys(w.livePrompts()).length]).toEqual([false, false, 1]);
});

test("an edit saved after an upload whose answer was lost is kept, and reaches the account", async () => {
 const w = worker();
 const mac = await browser(w);
 const p = await save(mac, "", "", "v1");
 w.losePush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow("503");
 expect(JSON.parse(w.livePrompts()[p.id]!).text).toBe("v1");
 const v2 = await save(mac, p.id, "", "v2");
 await syncEach(mac);
 expect([(await byID(mac))[p.id], JSON.parse(w.livePrompts()[p.id]!).text]).toEqual([v2, "v2"]);
});

test("a new prompt after one at the largest order the service takes syncs without an order", async () => {
 const w = worker();
 w.seedPrompt("00000000-0000-4000-8000-000000000001", { text: "last", order: 2 ** 53 - 1 });
 const mac = await browser(w);
 const p = await save(mac, "", "", "new");
 await syncEach(mac);
 expect(w.livePrompts()[p.id]).toBe(`{"text":"new"}`);
});

/** navigator.locks for tabs of one browser: one holder per name at a time, in order; a request
 *  whose signal aborts before its turn leaves the queue, unless late: then the abort is heard only
 *  once the lock is granted (a grant and an abort that race), and the callback runs. idle resolves
 *  once no lock is held or waited for (every callback granted so far has settled). */
function lockQueue(late = false) {
 const waiting: { name: string; signal?: AbortSignal; start(): void }[] = [];
 const held = new Set<string>(), idlers: (() => void)[] = [], watchers: (() => void)[] = [];
 const quiet = () => { if (held.size === 0 && waiting.length === 0) for (const done of idlers.splice(0)) done(); };
 const next = () => {
  for (const turn of waiting.filter(t => !held.has(t.name))) {
   if (held.has(turn.name)) continue;
   waiting.splice(waiting.indexOf(turn), 1);
   held.add(turn.name); turn.start();
  }
 };
 const locks: AbortableLocks = {
  request<T>(name: string, ...args: [() => Promise<T>] | [{ signal?: AbortSignal }, () => Promise<T>]): Promise<T> {
   const [options, callback]: [{ signal?: AbortSignal }, () => Promise<T>] = args.length === 1 ? [{}, args[0]] : args;
   const done = Promise.withResolvers<T>();
   const turn = {
    name, ...options,
    start() { callback().then(done.resolve, done.reject).finally(() => { held.delete(name); next(); quiet(); }); },
   };
   if (!late) options.signal?.addEventListener("abort", () => {
    const i = waiting.indexOf(turn);
    if (i >= 0) { waiting.splice(i, 1); done.reject(options.signal!.reason); quiet(); }
   });
   waiting.push(turn); next();
   for (const watch of [...watchers]) watch();
   return done.promise;
  },
 };
 const idle = () => new Promise<void>(done => { idlers.push(done); quiet(); });
 /** Resolves once at least n requests for name wait for it at the same time. */
 const queued = (name: string, n: number) => new Promise<void>(done => {
  const watch = () => { if (waiting.filter(t => t.name === name).length >= n) { watchers.splice(watchers.indexOf(watch), 1); done(); } };
  watchers.push(watch); watch();
 });
 return { locks, waiting, held, idle, queued };
}

test("a sync whose request stalls ends by the round's deadline, and frees the turn", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 100 });
 w.stallPull = true;
 const start = Date.now();
 await expect(mac.accountSyncNow()).rejects.toThrow();
 expect(Date.now() - start).toBeLessThan(2000);
 w.stallPull = false;
 await mac.accountSyncNow();
});

test("a sync waiting for its turn leaves when its own signal aborts, in this tab and in another", async () => {
 const w = worker();
 const { locks, waiting } = lockQueue();
 const [tab1, tab2] = [await browser(w, memory(), { locks, roundMs: 1500 }), await browser(w, memory(), { locks })];
 w.stallPull = true;
 const holding = tab1.sync.sync();
 holding.catch(() => {});
 for (const waiter of [tab2, tab1]) {
  const start = Date.now();
  await expect(waiter.sync.sync(AbortSignal.timeout(100))).rejects.toThrow();
  expect([Date.now() - start < 1000, waiting.length]).toEqual([true, 0]);
 }
 await expect(holding).rejects.toThrow();
});

test("prompts a restored account no longer holds go here too, when the restore shows during the readback", async () => {
 const w = worker();
 const mac = await browser(w);
 const [a, b] = [await save(mac, "", "", "a"), await save(mac, "", "", "b")];
 await syncEach(mac);
 const c = await save(mac, "", "", "c");
 // The account's history starts over (a restore without a or b) while mac pushes c: its readback
 // gets reset_required and pulls the restored account whole.
 w.onPush = () => w.reset();
 await syncEach(mac, mac);
 expect([Object.keys(await byID(mac)), Object.keys(w.livePrompts())]).toEqual([[c.id], [c.id]]);
 expect([a.id in w.livePrompts(), b.id in w.livePrompts()]).toEqual([false, false]);
});

test("a revert saved after two uploads whose answers were lost is kept, and reaches the account", async () => {
 const w = worker();
 const mac = await browser(w);
 const p = await save(mac, "", "", "v1");
 w.losePush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow("503");
 await save(mac, p.id, "", "v2");
 w.losePush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow("503");
 expect(JSON.parse(w.livePrompts()[p.id]!).text).toBe("v2");
 const reverted = await save(mac, p.id, "", "v1");
 await syncEach(mac);
 expect([(await byID(mac))[p.id], JSON.parse(w.livePrompts()[p.id]!).text]).toEqual([reverted, "v1"]);
});

test("a prompt past the account's quota stays here; a deletion and a prompt that fits still go", async () => {
 const w = worker();
 const mac = await browser(w);
 await save(mac, "", "", "kept");
 const k = await save(mac, "", "", "k");
 await syncEach(mac);
 w.quotaBytes = w.usedBytes() + 81;
 await mac.deletePrompt(k.id);
 const draft = await save(mac, "", "", "d".repeat(500));
 const small = await save(mac, "", "", "small");
 for (let round = 0; round < 2; round++) {
  await expect(mac.accountSyncNow()).rejects.toThrow("quota");
  expect([k.id in w.livePrompts(), small.id in w.livePrompts(), draft.id in w.livePrompts(), draft.id in await byID(mac)]).toEqual([false, true, false, true]);
  expect([syncOf(mac.storage).promptDeletes, (await mac.accountState()).syncFailed]).toEqual([[], true]);
 }
});

test("a browser added to the account is listed even when the list can't be read again", async () => {
 const w = worker();
 const chrome = await browser(w);
 w.listFailsBound = true;
 const listed = await chrome.accountDevices();
 expect([listed.devices.map(d => [d.name, d.platform, d.current]), listed.enrolment]).toEqual([[["Chrome on macOS", "web", true]], undefined]);
});

test("Settings and the owner screen adding the same browser at once share one enrolment", async () => {
 const w = worker();
 const chrome = await browser(w);
 const gate = Promise.withResolvers<void>(), joined = Promise.withResolvers<void>();
 w.challengeGate = gate.promise;
 // Settings' enrolment is the second call: it joins the first one's flight synchronously.
 const enrol = chrome.account.enrol.bind(chrome.account);
 let calls = 0;
 chrome.account.enrol = (...args: Parameters<typeof enrol>) => { const made = enrol(...args); if (++calls === 2) joined.resolve(); return made; };
 const owner = chrome.account.enrol(chrome.key, "Chrome on macOS", "acct");
 const settings = chrome.accountDevices();
 // The owner screen's challenge is held until Settings has come for its own enrolment.
 await joined.promise;
 gate.resolve();
 const [device, listed] = await Promise.all([owner, settings]);
 expect([w.challenges, w.enrolments, listed.devices.map(d => [d.id, d.current])]).toEqual([1, 1, [[device.id, true]]]);
});

test("each finished sync round tells the account's state; none claims the machine list changed", async () => {
 const w = worker();
 const mac = await browser(w);
 const heard: string[] = [];
 const offs = [events.accountChanged.on(s => heard.push(`account ${s.syncFailed ?? false}`)), events.syncedMachinesChanged.on(() => heard.push("machines"))];
 await save(mac, "", "", "one");
 await mac.accountSyncNow();
 w.failPush = true;
 await save(mac, "", "", "two");
 await expect(mac.accountSyncNow()).rejects.toThrow("503");
 for (const off of offs) off();
 expect(heard).toEqual(["account false", "account true"]);
});

test("a prompt deleted here that a restored history still holds is deleted there again", async () => {
 const w = worker();
 const mac = await browser(w);
 const a = await save(mac, "", "", "a");
 await save(mac, "", "", "b");
 await syncEach(mac);
 const body = JSON.parse(w.livePrompts()[a.id]!) as object;
 await mac.deletePrompt(a.id);
 // The service takes the delete, then its history is restored to one that still holds a: that
 // round isn't complete, and the next deletes a there again.
 w.afterPush = () => { w.reset(); w.seedPrompt(a.id, body); };
 await expect(mac.accountSyncNow()).rejects.toThrow("back after the account was restored");
 w.afterPush = null;
 await syncEach(mac);
 expect([a.id in await byID(mac), a.id in w.livePrompts()]).toEqual([false, false]);
});

test("a prompt that fits gets in past 29 that don't, within the service's 30 pushes a minute", async () => {
 const w = worker();
 const mac = await browser(w);
 await save(mac, "", "", "kept");
 await syncEach(mac);
 w.quotaBytes = w.usedBytes() + 81;
 w.rateLimit = 30;
 const drafts: SavedPrompt[] = [];
 for (let i = 0; i < 29; i++) drafts.push(await save(mac, "", "", String(i).padStart(2, "0") + "d".repeat(498)));
 const small = await save(mac, "", "", "small");
 // Each round has a fresh minute; the one that runs out starts the next where it stopped.
 let rounds = 0;
 while (!(small.id in w.livePrompts()) && rounds < 3) {
  w.newWindow(); rounds++;
  await expect(mac.sync.sync()).rejects.toThrow();
 }
 expect([small.id in w.livePrompts(), rounds <= 2, drafts.some(d => d.id in w.livePrompts())]).toEqual([true, true, false]);
 expect(Object.keys(await byID(mac)).length).toBe(31);
});

test("one prompt past the quota is sent once a round, never again within it, and nothing of it is kept to land", async () => {
 const w = worker();
 const mac = await browser(w);
 await save(mac, "", "", "kept");
 await syncEach(mac);
 w.quotaBytes = w.usedBytes() + 10;
 w.rateLimit = 30;
 const big = await save(mac, "", "", "b".repeat(100));
 const before = w.posts;
 for (let round = 0; round < 2; round++) { w.newWindow(); await expect(mac.sync.sync()).rejects.toThrow("quota"); }
 expect([w.posts - before, big.id in await byID(mac), big.id in w.livePrompts()]).toEqual([2, true, false]);
 // A refusal wrote nothing: no write of it is kept as one that may land late.
 expect(syncOf(mac.storage).promptAttempts).toEqual({});
});

test("at the account's 2,000 items a new prompt waits, and a larger edit of a held one still goes", async () => {
 const w = worker();
 for (let i = 0; i < 1999; i++) w.seedHost(`10000000-0000-4000-8000-${String(i).padStart(12, "0")}`, { host: `h${i}`, username: "root" });
 const mac = await browser(w);
 const held = await save(mac, "", "", "held");
 await syncEach(mac);
 const fresh = await save(mac, "", "", "new");
 await expect(mac.sync.sync()).rejects.toThrow("quota");
 const edited = await save(mac, held.id, "", "held, and now much longer than the prompt that doesn't fit");
 await expect(mac.sync.sync()).rejects.toThrow("quota");
 expect([JSON.parse(w.livePrompts()[held.id]!).text, fresh.id in w.livePrompts(), (await byID(mac))[fresh.id]?.text]).toEqual([edited.text, false, "new"]);
});

test("a machine deleted elsewhere frees room: the next sync sends the prompt that now fits", async () => {
 const w = worker();
 const machine = "10000000-0000-4000-8000-000000000001";
 w.seedHost(machine, { host: "pi.example.com", username: "root", nickname: "x".repeat(200) });
 const mac = await browser(w);
 await save(mac, "", "", "kept");
 await syncEach(mac);
 w.quotaBytes = w.usedBytes() + 10;
 const big = await save(mac, "", "", "b".repeat(100));
 await expect(mac.sync.sync()).rejects.toThrow("quota");
 w.seedTombstone(machine, "hosts");
 await mac.sync.sync();
 expect(big.id in w.livePrompts()).toBe(true);
});

test("a late v1 can't overwrite a v2 committed since, acknowledged or only pulled", async () => {
 for (const lostAnswer of [false, true]) {
  const w = worker();
  const mac = await browser(w, memory(), { roundMs: 300 });
  const p = await save(mac, "", "", "v1");
  // The service receives v1 and keeps it past the browser's deadline.
  w.holdNextPush = true;
  await expect(mac.accountSyncNow()).rejects.toThrow();
  const v2 = await save(mac, p.id, "", "v2");
  w.losePush = lostAnswer;
  if (lostAnswer) await expect(mac.accountSyncNow()).rejects.toThrow("503"); else await mac.accountSyncNow();
  w.landHeld();
  expect(JSON.parse(w.livePrompts()[p.id]!).text).toBe("v2");
  await syncEach(mac);
  expect([(await byID(mac))[p.id], JSON.parse(w.livePrompts()[p.id]!).text]).toEqual([v2, "v2"]);
 }
});

test("a late first upload doesn't overwrite a newer saved edit (#384)", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const p = await save(mac, "", "", "v1");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 const v2 = await save(mac, p.id, "", "v2");
 w.failPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow("503");
 w.failPush = false;
 w.landHeld();
 expect(JSON.parse(w.livePrompts()[p.id]!).text).toBe("v1");
 await syncEach(mac);
 expect([(await byID(mac))[p.id], JSON.parse(w.livePrompts()[p.id]!).text]).toEqual([v2, "v2"]);
});

test("of two late uploads the newer can't land over the older; a revert saved meanwhile stays", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const p = await save(mac, "", "", "v1");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 await save(mac, p.id, "", "v2");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 w.landHeld();
 const reverted = await save(mac, p.id, "", "v1");
 await syncEach(mac);
 w.landHeld();
 await syncEach(mac);
 expect([(await byID(mac))[p.id], JSON.parse(w.livePrompts()[p.id]!).text]).toEqual([reverted, "v1"]);
});

test("a late create doesn't overwrite the same prompt another device created meanwhile", async () => {
 const w = worker();
 const [mac, linux] = [await browser(w, memory(), { roundMs: 300 }), await browser(w)];
 const p = await save(mac, "", "", "from the mac");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 const theirs = await save(linux, p.id, "", "from linux");
 await syncEach(linux);
 w.landHeld();
 await syncEach(mac);
 expect([JSON.parse(w.livePrompts()[p.id]!).text, (await byID(mac))[p.id]]).toEqual(["from linux", theirs]);
});

test("an edit pushed while another device's lands first comes back as a conflict and goes again at once", async () => {
 const w = worker();
 const [mac, linux] = [await browser(w), await browser(w)];
 const p = await save(mac, "", "", "shared");
 await syncEach(mac, linux);
 const mine = await save(mac, p.id, "", "mac's edit");
 // linux's edit lands between mac's pull and its push.
 w.onPush = () => w.seedPrompt(p.id, { text: "linux's edit", order: 0 });
 await mac.accountSyncNow();
 expect(JSON.parse(w.livePrompts()[p.id]!).text).toBe("mac's edit");
 await syncEach(mac);
 expect([(await byID(mac))[p.id], JSON.parse(w.livePrompts()[p.id]!).text]).toEqual([mine, "mac's edit"]);
});

test("removing this browser tells every view it signed out, once", async () => {
 const w = worker();
 const chrome = await browser(w);
 const [me] = (await chrome.accountDevices()).devices;
 const heard: boolean[] = [];
 const off = events.accountChanged.on(s => heard.push(s.signedIn));
 await chrome.accountRemoveDevice(me!.id);
 off();
 expect(heard).toEqual([false]);
});

// ---- Round 6 (the reviewer's sequences) ----

test("an edit pending against a tombstone that was pruned meanwhile goes on the next Sync now", async () => {
 const w = worker();
 const [mac, linux] = [await browser(w), await browser(w)];
 const p = await save(mac, "", "", "shared");
 await syncEach(mac, linux);
 await linux.deletePrompt(p.id);
 await syncEach(linux);
 const edited = await save(mac, p.id, "", "edited after linux deleted it");
 // mac pulls the tombstone, keeps its edit and is out of pushes (sync.ts SYNC_WRITE_LIMIT, 30 a
 // minute: auth.ts:184-189) before it sends it.
 w.rateLimit = 1; w.windowPosts = 1;
 await expect(mac.accountSyncNow()).rejects.toThrow("429");
 // The tombstone is pruned and the floor rises to it (sync.ts:357-362): mac, already past it,
 // pulls nothing (sync.ts:335 holds), and the account holds no row for the prompt.
 w.prune(w.rev);
 w.rateLimit = 0;
 await mac.accountSyncNow();
 expect([JSON.parse(w.livePrompts()[p.id]!).text, (await byID(mac))[p.id]]).toEqual([edited.text, edited]);
});

test("a revert saved while an older edit's upload was out survives that upload landing during another", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 const reverted = await save(mac, p.id, "", "v0");
 await save(mac, "", "", "unrelated");
 // v1 lands while the unrelated prompt is being uploaded; this round reads it back.
 w.onPush = () => w.landHeld();
 await syncEach(mac);
 expect(JSON.parse(w.livePrompts()[p.id]!).text).toBe("v1");
 await syncEach(mac);
 expect([(await byID(mac))[p.id], JSON.parse(w.livePrompts()[p.id]!).text]).toEqual([reverted, "v0"]);
});

test("a prompt deleted here while its first upload was out stays deleted when that upload lands late", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const p = await save(mac, "", "", "short-lived");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 await mac.deletePrompt(p.id);
 // The account holds no row yet: a delete of none writes nothing (sync.ts:352) and is answered
 // as applied (sync.ts:423-424), so it can't stop the create; the delete waits for it (the round
 // isn't complete meanwhile).
 await expect(mac.accountSyncNow()).rejects.toThrow("deleted prompt waits");
 w.landHeld();
 await syncEach(mac);
 expect([p.id in await byID(mac), p.id in w.livePrompts()]).toEqual([false, false]);
});

test("a draft that doesn't fit the account doesn't hold the last prompt slot from one that does", async () => {
 const w = worker();
 for (let i = 0; i < PROMPTS_CAP - 1; i++) w.seedPrompt(`00000000-0000-4000-9000-${String(i).padStart(12, "0")}`, { text: "seeded" });
 const mac = await browser(w);
 await syncEach(mac);
 w.quotaBytes = w.usedBytes() + 81;
 const draft = await save(mac, "", "", "d".repeat(500));
 const fits = await save(mac, "", "", "fits");
 await expect(mac.accountSyncNow()).rejects.toThrow("quota");
 expect([fits.id in w.livePrompts(), draft.id in w.livePrompts(), draft.id in await byID(mac)]).toEqual([true, false, true]);
});

test("a write the account refuses for a newer copy on every pass leaves the round failed, SYNCED as it was", async () => {
 const w = worker();
 const [mac, linux] = [await browser(w), await browser(w)];
 const p = await save(mac, "", "", "shared");
 await syncEach(mac, linux);
 const before = await mac.accountSyncStatus();
 await save(mac, p.id, "", "mac's edit");
 // Another device edits it between each of mac's pulls and pushes.
 let n = 0;
 w.everyPush = () => w.seedPrompt(p.id, { text: `linux's edit ${++n}`, order: 0 });
 await expect(mac.accountSyncNow()).rejects.toThrow("kept changing");
 w.everyPush = null;
 expect([await mac.accountSyncStatus(), (await mac.accountState()).syncFailed]).toEqual([before, true]);
});

test("a delete-only push and an empty acknowledgement don't rewrite the sync state", async () => {
 const w = worker();
 const storage = memory();
 const mac = await browser(w, storage);
 const p = await save(mac, "", "", "to delete");
 await syncEach(mac);
 await mac.deletePrompt(p.id);
 const before = storage.writes.get(SAVED_PROMPTS_KEY) ?? 0;
 await syncEach(mac);
 // The merge's record, then the readback's: nothing between (no write recorded, no baseline).
 expect([(storage.writes.get(SAVED_PROMPTS_KEY) ?? 0) - before, p.id in w.livePrompts()]).toEqual([2, false]);
});

test("a refused retry of a write leaves the older identical request in flight, so a revert saved meanwhile stays", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 // The first upload of v1 is received and kept past the deadline.
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 // Its retry, the same write on the same base, is refused: out of pushes (auth.ts:184-189).
 w.rateLimit = 1; w.windowPosts = 1;
 await expect(mac.accountSyncNow()).rejects.toThrow("429");
 w.rateLimit = 0;
 const reverted = await save(mac, p.id, "", "v0");
 // The older request lands after all.
 w.landHeld();
 expect(JSON.parse(w.livePrompts()[p.id]!).text).toBe("v1");
 await syncEach(mac);
 expect([(await byID(mac))[p.id], JSON.parse(w.livePrompts()[p.id]!).text]).toEqual([reverted, "v0"]);
});

test("a first create that meets another device's create of the same id keeps an edit saved meanwhile", async () => {
 const w = worker();
 const mac = await browser(w);
 const p = await save(mac, "", "", "v1");
 let newer!: Promise<SavedPrompt[]>;
 // While the POST is on its way, another device creates the same id and v2 is saved here.
 w.onPush = () => { w.seedPrompt(p.id, { text: "from linux", order: 0 }); newer = mac.savePrompt({ id: p.id, nickname: "", text: "v2" }); };
 await mac.accountSyncNow();
 await newer;
 await syncEach(mac);
 expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["v2", "v2"]);
});

test("a first create that meets another device's create of the same id takes theirs when nothing changed here", async () => {
 const w = worker();
 const mac = await browser(w);
 const p = await save(mac, "", "", "from the mac");
 w.onPush = () => w.seedPrompt(p.id, { text: "from linux", order: 0 });
 await mac.accountSyncNow();
 expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["from linux", "from linux"]);
});

test("a push refused for quota whose halves all land once another device frees room finishes well", async () => {
 const w = worker();
 const machine = "10000000-0000-4000-8000-000000000001";
 w.seedHost(machine, { host: "pi.example.com", username: "root", nickname: "x".repeat(400) });
 const mac = await browser(w);
 await syncEach(mac);
 w.quotaBytes = w.usedBytes() + 150;
 await save(mac, "", "", "a".repeat(100));
 await save(mac, "", "", "b".repeat(100));
 // The two together don't fit; before the halves go, another device deletes its machine.
 let pushes = 0;
 w.everyPush = () => { if (++pushes === 2) w.seedTombstone(machine, "hosts"); };
 await mac.accountSyncNow();
 w.everyPush = null;
 expect([Object.keys(w.livePrompts()).length, (await mac.accountState()).syncFailed]).toEqual([2, undefined]);
});

// ---- #390 round 2, the web side ----

test("a new prompt deleted here between the merge and its first upload isn't sent, and stays deleted", async () => {
 const w = worker();
 const mac = await browser(w);
 // 33 prompts of 8 KB: two pushes (32, then 1) under the 256 KiB push limit (sync.ts:42).
 for (let i = 0; i < 32; i++) await save(mac, "", "", String(i).padStart(2, "0") + "x".repeat(8000));
 const last = await save(mac, "", "", "32" + "x".repeat(8000));
 // Deleted while the first push is on its way: it has no row, baseline or attempt yet.
 w.onPush = () => { void mac.deletePrompt(last.id); };
 await syncEach(mac, mac);
 expect([Object.keys(w.livePrompts()).length, last.id in w.livePrompts(), last.id in await byID(mac)]).toEqual([32, false, false]);
});

test("a refused upload equal to another device's later edit isn't taken for this browser's write", async () => {
 const w = worker();
 const mac = await browser(w);
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 // While v1 is on its way: another device edits the prompt (so v1 is refused, a conflict) and
 // this browser reverts to v0; then, before the retry pulls, the other device saves v1 itself.
 w.onPush = () => { w.seedPrompt(p.id, { text: "linux's edit", order: 0 }); void mac.savePrompt({ id: p.id, nickname: "", text: "v0" }); };
 w.afterPush = () => w.seedPrompt(p.id, { text: "v1", order: 0 });
 await mac.accountSyncNow();
 await syncEach(mac);
 expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["v1", "v1"]);
});

test("a round whose session becomes another account's between passes is dropped, writing nothing for it", async () => {
 const storage = memory();
 const w = worker();
 const mac = await browser(w, storage);
 const p = await save(mac, "", "", "shared");
 await syncEach(mac);
 await save(mac, p.id, "", "mac's edit");
 // The push conflicts, and meanwhile this browser signs out and in as another account.
 w.onPush = () => {
  w.seedPrompt(p.id, { text: "linux's edit", order: 0 });
  w.accountId = "acct-b";
  void mac.account.signOut().catch(() => {}).then(() => mac.account.check());
 };
 const posts = w.posts;
 await mac.accountSyncNow();
 await mac.account.check();
 expect([mac.account.current?.accountID, syncOf(storage).accountId, w.posts - posts]).toEqual(["acct-b", "acct", 1]);
});

test("tombstone revisions are kept only for prompts that can still be written against them", async () => {
 const w = worker();
 const [mac, linux] = [await browser(w), await browser(w)];
 await syncEach(mac);
 // Another device makes a prompt and deletes it before this browser ever holds it.
 const brief = await save(linux, "", "", "brief");
 await syncEach(linux);
 await linux.deletePrompt(brief.id);
 await syncEach(linux, mac);
 expect(syncOf(mac.storage).mirror.gone).toEqual({});
});

// ---- #359 round 6 review ----

test("nine rounds of ambiguous failures don't fill the browser's storage, and the next sync goes", async () => {
 const w = worker();
 // 30 prompts of 8,000 characters in a 1.5 MiB storage: a record keeping each send's text
 // would pass it within a few rounds of 503s.
 const storage = memory(1.5 * 1024 * 1024);
 const mac = await browser(w, storage);
 for (let i = 0; i < 30; i++) await save(mac, "", "", String(i).padStart(2, "0") + "x".repeat(7998));
 w.failPush = true;
 for (let round = 0; round < 9; round++) await expect(mac.accountSyncNow()).rejects.toThrow("503");
 // The record holds hashes, ids and their deadlines, not prompts: about a kilobyte a prompt
 // (eight ids at most), against 240 KB of prompt text.
 expect(JSON.stringify(syncOf(storage).promptAttempts).length).toBeLessThan(32 * 1024);
 w.failPush = false;
 const before = w.posts;
 await mac.accountSyncNow();
 expect([w.posts - before >= 1, Object.keys(w.livePrompts()).length]).toEqual([true, 30]);
});

test("a new prompt whose generated order alone would make it too large goes without one", async () => {
 const w = worker();
 const mac = await browser(w);
 // {"text":"x\"…\""} of 8,187 bytes of text is exactly 16 KiB (sync.ts MAX_ITEM_BYTES, :44).
 const p = await save(mac, "", "", "x" + `"`.repeat(8186));
 await mac.accountSyncNow();
 expect(JSON.parse(w.livePrompts()[p.id]!)).toEqual({ text: "x" + `"`.repeat(8186) });
});

// ---- #359 round 8 (and #390 round 3 on the web) ----

test("sending an earlier draft again makes it the newest send: a conflict with another device's create takes theirs", async () => {
 const w = worker();
 const mac = await browser(w);
 const p = await save(mac, "", "", "draft A");
 w.failPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow("503");
 await save(mac, p.id, "", "draft B");
 await expect(mac.accountSyncNow()).rejects.toThrow("503");
 w.failPush = false;
 await save(mac, p.id, "", "draft A");
 // Another device creates the same id before this POST commits: it conflicts.
 w.onPush = () => w.seedPrompt(p.id, { text: "from linux", order: 0 });
 await mac.accountSyncNow();
 expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["from linux", "from linux"]);
});

test("forty edits whose uploads all fail ambiguously keep at most two contents of the prompt; the last edit lands once they expire", async () => {
 const w = worker();
 const storage = memory();
 const mac = await browser(w, storage);
 const p = await save(mac, "", "", "v0");
 w.failPush = true;
 for (let i = 1; i <= 40; i++) {
  await save(mac, p.id, "", `v${i}`);
  // Two contents are sent (503); from then on the edit waits, and no stale content goes again.
  await expect(mac.accountSyncNow()).rejects.toThrow(i <= 2 ? "503" : "waits for earlier uploads");
  expect(syncOf(storage).promptAttempts[p.id].length).toBeLessThanOrEqual(2);
 }
 expect(w.pushed.length).toBe(2);
 w.failPush = false;
 // The service's clock passes those uploads' not_after: they didn't land and won't.
 w.serverNow += 121_000;
 await mac.accountSyncNow();
 expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["v40", "v40"]);
});

test("fifteen rounds of ambiguous uploads of 30 prompts' new versions stay within 64 KiB of storage, and the newest lands once they expire", async () => {
 const w = worker();
 const storage = memory();
 const mac = await browser(w, storage);
 const ids: string[] = [];
 for (let i = 0; i < 30; i++) ids.push((await save(mac, "", "", `prompt ${i} v0 ` + "x".repeat(200))).id);
 storage.quota = storage.used() + 64 * 1024;
 w.failPush = true;
 for (let round = 1; round <= 15; round++) {
  for (const [i, id] of ids.entries()) await save(mac, id, "", `prompt ${i} v${round} ` + "x".repeat(200));
  await expect(mac.accountSyncNow()).rejects.toThrow();
 }
 w.failPush = false;
 w.serverNow += 121_000;
 await mac.accountSyncNow();
 const live = w.livePrompts();
 expect(ids.every((id, i) => JSON.parse(live[id]!).text === `prompt ${i} v15 ` + "x".repeat(200))).toBe(true);
});

test("an answer settles a prompt's other open sends only when the prompt moved off their base", () => {
 const entries = [{ base: 3, hash: "a", open: ["a1"] }, { base: 3, hash: "b", open: ["b1", "b2"] }];
 // An identical write applied at the base keeps its revision (sync.ts:16, :355): only its send.
 expect(settleSends(entries, "b2", 3, { applied: 3 })).toEqual([{ base: 3, hash: "a", open: ["a1"] }, { base: 3, hash: "b", open: ["b1"] }]);
 // Applied at a new revision: none at that base can land any more.
 expect(settleSends(entries, "b2", 3, { applied: 4 })).toEqual([]);
 // A conflict, or a refusal, settles only its own send: a conflict's row that is one of these
 // landing is recorded from the answer apart (recordLandings).
 expect([settleSends(entries, "a1", 3, "conflict"), settleSends(entries, "a1", 3, "refused")]).toEqual([[{ base: 3, hash: "b", open: ["b1", "b2"] }], [{ base: 3, hash: "b", open: ["b1", "b2"] }]]);
});

test("a restore that brings a prompt back to an upload's base leaves it open, and its late landing is recognised", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 // v1 is received and kept past the deadline; the person reverts to v0 meanwhile.
 await save(mac, p.id, "", "v1");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 await save(mac, p.id, "", "v0");
 // Another device adds a machine, which this browser pulls (its revision is past the prompt's).
 w.seedHost("10000000-0000-4000-8000-000000000001", { host: "pi", username: "root" });
 await syncEach(mac);
 // The account is restored to a history where the prompt is v0 at its first revision again
 // (this browser's next pull is answered 410 and pulls it whole).
 w.reset();
 w.seedPrompt(p.id, { text: "v0", order: 0 });
 await syncEach(mac);
 // The held v1 lands now, on that revision.
 w.landHeld();
 expect(JSON.parse(w.livePrompts()[p.id]!).text).toBe("v1");
 await syncEach(mac);
 expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["v0", "v0"]);
});

test("an older restored copy equal to an upload that never landed isn't taken for it", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const id = "00000000-0000-4000-8000-000000000001";
 w.seedPrompt(id, { text: "v1", order: 0 });
 w.seedPrompt(id, { text: "v0", order: 0 });
 await syncEach(mac);
 // v1 is sent and never lands; the person reverts to v0.
 await save(mac, id, "", "v1");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 await save(mac, id, "", "v0");
 // A backup from before is restored: the prompt is v1 there, at a lower revision.
 w.reset();
 w.seedPrompt(id, { text: "v1", order: 0 });
 await syncEach(mac);
 expect([(await byID(mac))[id]!.text, JSON.parse(w.livePrompts()[id]!).text]).toEqual(["v1", "v1"]);
});

test("a prompt deleted while a 401 is answered and credentials refresh isn't uploaded by the retry", async () => {
 const w = worker();
 const mac = await browser(w);
 const p = await save(mac, "", "", "draft");
 w.pushUnauthorized = true;
 w.onUnauthorized = () => { void mac.deletePrompt(p.id); };
 await mac.accountSyncNow();
 await syncEach(mac);
 expect([p.id in w.livePrompts(), p.id in await byID(mac), w.pushed.length]).toEqual([false, false, 1]);
 // The 401 wrote nothing: no send is kept that could land, and no delete waits for one.
 const state = syncOf(mac.storage);
 expect([state.promptAttempts, state.promptDeletes]).toEqual([{}, []]);
});

test("an edit whose order alone would make it too large goes without one", async () => {
 const w = worker();
 const mac = await browser(w);
 const p = await save(mac, "", "", "short");
 await syncEach(mac);
 // {"text":"x\"…\""} of 8,187 bytes of text is exactly 16 KiB (sync.ts MAX_ITEM_BYTES, :44).
 const big = "x" + `"`.repeat(8186);
 await save(mac, p.id, "", big);
 await mac.accountSyncNow();
 expect(JSON.parse(w.livePrompts()[p.id]!)).toEqual({ text: big });
});

test("the one landing match: only an open send other than the refused one, past its base and written by its deadline, and then only the same body", () => {
 const body = { text: "v1", order: 0 }, row = { id: "p", rev: 5, body, updated_ms: 1_000 };
 const entry = (base: number, open: string[], deadlines?: Record<string, number>, hash = sentHash(body)): PromptAttempt => ({ base, hash, open, ...(deadlines ? { deadlines } : {}) });
 const found = entry(3, ["s1"]);
 expect([
  matchLanding(row, []),
  matchLanding(row, [entry(5, ["s1"])]),
  matchLanding(row, [entry(3, ["s1"])], "s1"),
  matchLanding(row, [entry(3, ["s1"], undefined, sentHash({ text: "v1", order: 7 }))]),
  matchLanding(row, [entry(3, ["s1"], { s1: 999 })]),
  matchLanding(row, [entry(3, ["s1"], { s1: 1_000 })]) !== undefined,
  matchLanding({ id: "p", rev: 5, body }, [entry(3, ["s1"], { s1: 999 })]) !== undefined,
  matchLanding(row, [found]),
 ]).toEqual([undefined, undefined, undefined, undefined, undefined, true, true, found]);
});

// ---- #359 round 9 ----

test("at the variant cap large stale contents aren't sent again: no 413, an unrelated prompt lands, and the short edits once the old uploads expire", async () => {
 const w = worker();
 const mac = await browser(w);
 const ids: string[] = [];
 for (let i = 0; i < 31; i++) ids.push((await save(mac, "", "", `v1 ${i}`)).id);
 w.failPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow("503");
 // Second versions sized so their one push is within 60 bytes of the service's 256 KiB (sync.ts
 // :42): quotes are two bytes of JSON each, as the push sends them.
 const change = (i: number, text: string) => JSON.stringify({ collection: "prompts", id: ids[i], body: { text, order: i }, base_rev: 0 }).length;
 const fixed = ids.reduce((n, _, i) => n + change(i, ""), `{"changes":[],"not_after":${w.serverNow + 120_000}}`.length + ids.length - 1);
 const extra = 256 * 1024 - 60 - fixed;
 const v2 = (i: number) => { const n = Math.floor(extra / ids.length) + (i < extra % ids.length ? 1 : 0); return `"`.repeat(Math.floor(n / 2)) + "x".repeat(n % 2); };
 for (const [i, id] of ids.entries()) await save(mac, id, "", v2(i));
 await expect(mac.accountSyncNow()).rejects.toThrow("503");
 w.failPush = false;
 // Shorter versions, and one unrelated prompt: at the cap the short ones wait (no stale large
 // body goes again, which with the unrelated one would be past the limit); the unrelated one goes.
 for (const [i, id] of ids.entries()) await save(mac, id, "", `short ${i}`);
 const other = await save(mac, "", "", "an unrelated prompt, of more than sixty bytes once it is a change in a push");
 await expect(mac.accountSyncNow()).rejects.toThrow("waits for earlier uploads");
 expect([w.tooLarge, other.id in w.livePrompts()]).toEqual([0, true]);
 w.serverNow += 121_000;
 await mac.accountSyncNow();
 const live = w.livePrompts();
 expect([w.tooLarge, ids.every((id, i) => JSON.parse(live[id]!).text === `short ${i}`)]).toEqual([0, true]);
});

test("a push of several writes refused for its size is halved, all of it landing; a lone write refused so stays here", async () => {
 const w = worker();
 const mac = await browser(w);
 // Ten prompts of about 1 KB each: one push as the browser sizes it, which a service with a
 // 4 KiB limit refuses (413) whole.
 const ids: string[] = [];
 for (let i = 0; i < 10; i++) ids.push((await save(mac, "", "", `${i} ` + "x".repeat(1000))).id);
 w.bodyLimit = 4 * 1024;
 await mac.accountSyncNow();
 expect([Object.keys(w.livePrompts()).length, w.tooLarge >= 1, (await mac.accountState()).syncFailed]).toEqual([10, true, undefined]);
 // One write larger than the limit alone: refused, kept here, and the round fails.
 const lone = await save(mac, "", "", "y".repeat(5000));
 await expect(mac.accountSyncNow()).rejects.toThrow("413");
 expect([lone.id in w.livePrompts(), lone.id in await byID(mac)]).toEqual([false, true]);
});

test("a 401 whose refresh then fails retires its sends: another device's identical edit isn't taken for this browser's", async () => {
 const w = worker();
 const mac = await browser(w);
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 // The push is refused (401), and the refresh before its retry fails (503).
 w.pushUnauthorized = true; w.refreshUnavailable = true;
 await expect(mac.accountSyncNow()).rejects.toThrow("503");
 await save(mac, p.id, "", "v0");
 // Another device saves v1 itself.
 w.seedPrompt(p.id, { text: "v1", order: 0 });
 await syncEach(mac);
 expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["v1", "v1"]);
});

test("a state from before, with send ids and sequences in it, still syncs", async () => {
 const w = worker();
 const storage = memory();
 const mac = await browser(w, storage);
 const p = await save(mac, "", "", "v1");
 w.failPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow("503");
 w.failPush = false;
 // The fields the record once kept and nothing reads.
 const state = syncOf(storage);
 state.promptsSendSeq = 7;
 for (const send of Object.values(state.promptsLastSent) as Record<string, unknown>[]) Object.assign(send, { seq: 7, sendId: "old" });
 storage.setItem(SAVED_PROMPTS_KEY, JSON.stringify({ ...JSON.parse(storage.getItem(SAVED_PROMPTS_KEY)!), sync: state }));
 await mac.accountSyncNow();
 expect(JSON.parse(w.livePrompts()[p.id]!).text).toBe("v1");
});

// ---- #390 round 4 on the web ----

test("a conflict with an older upload of this browser that landed meanwhile keeps the saved newer edit", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const p = await save(mac, "", "", "v1");
 // v1 is received and kept past the deadline; v2 is saved.
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 const v2 = await save(mac, p.id, "", "v2");
 // After this round's pull, before its v2 is applied, the held v1 lands: v2 conflicts with it.
 w.onPush = () => w.landHeld();
 await mac.accountSyncNow();
 expect([(await byID(mac))[p.id], JSON.parse(w.livePrompts()[p.id]!).text]).toEqual([v2, "v2"]);
});

/** A prompt whose two large edits were sent and never answered (503), then a small edit saved: the
 *  reviewer's #390 r4 sequence. */
async function twoLargeUnanswered(w: Worker) {
 const mac = await browser(w);
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 w.failPush = true;
 for (const v of ["L1", "L2"]) {
  await save(mac, p.id, "", v + "x".repeat(4000));
  await expect(mac.accountSyncNow()).rejects.toThrow("503");
 }
 w.failPush = false;
 const small = await save(mac, p.id, "", "small");
 const posts = w.posts;
 return { mac, p, small, posts };
}

test("held uploads the service gets past their not_after are refused, and settle once a pull is past it: a smaller edit then goes", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 // Two large edits, each received and kept past the browser's deadline: the cap is reached.
 for (const v of ["L1", "L2"]) {
  await save(mac, p.id, "", v + "x".repeat(4000));
  w.holdNextPush = true;
  await expect(mac.accountSyncNow()).rejects.toThrow();
 }
 await save(mac, p.id, "", "small");
 await expect(mac.accountSyncNow()).rejects.toThrow("waits for earlier uploads");
 // The service reaches the held pushes only past their not_after: refused, nothing written.
 w.serverNow += 121_000;
 w.landHeld(); w.landHeld();
 expect([w.expired, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual([2, "v0"]);
 await mac.accountSyncNow();
 expect(JSON.parse(w.livePrompts()[p.id]!).text).toBe("small");
});

test("a pull whose now_ms isn't past the uploads' not_after settles nothing", async () => {
 const w = worker();
 const { mac, posts } = await twoLargeUnanswered(w);
 w.serverNow += 120_000;
 await expect(mac.accountSyncNow()).rejects.toThrow("waits for earlier uploads");
 expect(w.posts).toBe(posts);
});

test("a device clock ahead or behind changes nothing: only the service's now_ms counts", async () => {
 const w = worker();
 const { mac, p, posts } = await twoLargeUnanswered(w);
 // The device's clock a day past the uploads' not_after, then a day before the service's clock.
 for (const at of [w.serverNow + 24 * 3600_000, w.serverNow - 24 * 3600_000]) {
  setSystemTime(new Date(at));
  try { await expect(mac.accountSyncNow()).rejects.toThrow("waits for earlier uploads"); }
  finally { setSystemTime(); }
 }
 expect(w.posts).toBe(posts);
 w.serverNow += 121_000;
 await mac.accountSyncNow();
 expect(JSON.parse(w.livePrompts()[p.id]!).text).toBe("small");
});

test("without now_ms from the service nothing settles by time, and the round stays incomplete", async () => {
 const w = worker();
 w.omitNow = true;
 const { mac, posts } = await twoLargeUnanswered(w);
 w.serverNow += 24 * 3600_000;
 for (let i = 0; i < 2; i++) await expect(mac.accountSyncNow()).rejects.toThrow("waits for earlier uploads");
 expect([w.posts, w.expired, (await mac.accountState()).syncFailed]).toEqual([posts, 0, true]);
});

// ---- Rebase onto #356 ----

test("a refresh whose body never ends: the sync's deadline frees the round, and a sign-out still reaches the service once the refresh's turn is up", async () => {
 const w = worker();
 // The refresh deadline (LOCKED_REQUEST_MS, 10 s) shortened as WebAccount allows; the same code.
 const lockedMs = 1500;
 let clock = Date.now();
 const account = new WebAccount(w.fetcher("held"), undefined, () => clock, null, lockedMs);
 await account.check();
 const sync = createAccountSync(account, { storage: () => memory(), locks: null, background: false, roundMs: 100 }, () => {});
 await sync.sync();
 // The access token expires; the refresh that renews it is answered, and its body never ends.
 clock += 2 * 3600_000;
 w.holdRefreshBody = true;
 const start = Date.now();
 await expect(sync.sync()).rejects.toThrow();
 expect(Date.now() - start).toBeLessThan(lockedMs);
 // The sign-out waits for the refresh's turn, which ends lockedMs after it began, not for its body.
 await account.signOut();
 expect([w.signOuts, w.signedOutAt - start < lockedMs + 1000]).toEqual([1, true]);
});

test("a save and a round's merge read and write the saved prompts under the storage lock: neither lands while another tab holds it", async () => {
 const w = worker();
 const { locks, queued } = lockQueue();
 const storage = memory();
 const mac = await browser(w, storage, { locks });
 const p = await save(mac, "", "", "v0");
 await mac.accountSyncNow();
 const posts = w.posts;
 // Another tab is between its read and its write of the saved prompts.
 const release = Promise.withResolvers<void>();
 const other = locks.request(SAVED_PROMPTS_KEY, () => release.promise);
 const saving = save(mac, p.id, "", "v1"), syncing = mac.accountSyncNow();
 // Both wait: the save, and the round's merge once its pull is in.
 await queued(SAVED_PROMPTS_KEY, 2);
 expect([(JSON.parse(storage.getItem(SAVED_PROMPTS_KEY)!) as { prompts: SavedPrompt[] }).prompts[0]!.text, w.posts]).toEqual(["v0", posts]);
 release.resolve();
 await other; await saving; await syncing;
 expect(JSON.parse(w.livePrompts()[p.id]!).text).toBe("v1");
});

// ---- #359 round 10 and #390 round 5 ----

test("a size refusal whose body never ends retires its sends on the status line: the upload isn't left open", async () => {
 const w = worker();
 const storage = memory();
 const mac = await browser(w, storage, { roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1 " + "x".repeat(5000));
 // 413 on the status line, then an error body that stalls until the round's deadline.
 w.bodyLimit = 4 * 1024; w.stallErrorBody = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 expect(openSends(storage, p.id)).toEqual([]);
});

test("a push of deletes alone refused for its size is halved too: every tombstone lands", async () => {
 const w = worker();
 const mac = await browser(w);
 const ids: string[] = [];
 for (let i = 0; i < 60; i++) ids.push((await save(mac, "", "", `prompt ${i}`)).id);
 await syncEach(mac);
 for (const id of ids) await mac.deletePrompt(id);
 // 60 deletes make one push of about 5.9 KB; this service takes 4 KiB at most.
 w.bodyLimit = 4 * 1024;
 await mac.accountSyncNow();
 expect([Object.keys(w.livePrompts()).length, w.tooLarge >= 1]).toEqual([0, true]);
});

test("a push cancelled while it is being made sends nothing and leaves no upload open", async () => {
 const w = worker();
 const storage = memory();
 const stop = new AbortController();
 // The cancel comes while the push waits for the storage lock (its second take of the round:
 // the merge's is the first), as another tab holding it would make it wait.
 let takes = 0;
 const runs: Promise<unknown>[] = [];
 const locks = { request: (name: string, ...args: unknown[]) => {
  const run = args.at(-1) as () => Promise<unknown>;
  if (name === SAVED_PROMPTS_KEY && ++takes === 2) stop.abort(new Error("left"));
  const ran = run();
  runs.push(ran);
  return ran;
 } } as unknown as AbortableLocks;
 const mac = await browser(w, storage, { locks });
 const p = await save(mac, "", "", "v1");
 takes = 0;
 const posts = w.posts;
 await expect(mac.sync.sync(stop.signal)).rejects.toThrow("left");
 // Every storage step the round took has settled.
 await Promise.allSettled(runs);
 expect([w.posts, syncOf(storage).promptAttempts?.[p.id]]).toEqual([posts, undefined]);
});

test("a conflict whose row is this browser's earlier upload landing records it at once: a revert saved meanwhile survives another device's later edit", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 await save(mac, p.id, "", "v2");
 // While v2 is in flight the held v1 lands, and this browser saves a revert to v0; v2 then
 // conflicts with v1, and another device writes v3 before the next pull.
 w.onPush = () => { w.landHeld(); void mac.savePrompt({ id: p.id, nickname: "", text: "v0" }); };
 w.afterPush = () => w.seedPrompt(p.id, { text: "v3", order: 0 });
 await mac.accountSyncNow();
 expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["v0", "v0"]);
});

// ---- #390 round 6 on the web ----

test("a size refusal whose error body is cut short still splits by its status: all of it lands", async () => {
 const w = worker();
 const mac = await browser(w);
 for (let i = 0; i < 10; i++) await save(mac, "", "", `${i} ` + "x".repeat(1000));
 w.bodyLimit = 4 * 1024; w.truncateErrorBody = true;
 await mac.accountSyncNow();
 expect([Object.keys(w.livePrompts()).length, w.tooLarge >= 2]).toEqual([10, true]);
});

test("a 403 whose error body is cut short isn't taken for the quota: the round fails without a split", async () => {
 const w = worker();
 const mac = await browser(w);
 await save(mac, "", "", "seed");
 await syncEach(mac);
 for (let i = 0; i < 2; i++) await save(mac, "", "", `${i} ` + "x".repeat(1000));
 w.quotaBytes = w.usedBytes() + 100; w.truncateErrorBody = true;
 const posts = w.posts;
 await expect(mac.accountSyncNow()).rejects.toThrow("403");
 expect(w.posts - posts).toBe(1);
});

test("another device's same text at another place, met by this browser's refused upload, isn't taken for it: a revert saved meanwhile doesn't overwrite it", async () => {
 const w = worker();
 const mac = await browser(w);
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 // While this browser's v1 (order 0) is on its way, another device saves v1 at order 7, and
 // this browser reverts to v0. (The same body at the same place the service answers as applied:
 // sync.ts holds what was asked.)
 w.onPush = () => { w.seedPrompt(p.id, { text: "v1", order: 7 }); void mac.savePrompt({ id: p.id, nickname: "", text: "v0" }); };
 await mac.accountSyncNow();
 expect([(await byID(mac))[p.id]!.text, w.livePrompts()[p.id]]).toEqual(["v1", `{"text":"v1","order":7}`]);
});

test("a quota refusal splits what the request carried, not the part planned: a prompt changed meanwhile isn't sent again", async () => {
 const w = worker();
 const storage = memory();
 // The second storage step of the round is the push's prepare: B is edited here just before it.
 let takes = 0, edit: (() => void) | null = null;
 const locks = { request: (name: string, ...args: unknown[]) => {
  const run = args.at(-1) as () => Promise<unknown>;
  if (name === SAVED_PROMPTS_KEY && ++takes === 2) edit?.();
  return run();
 } } as unknown as AbortableLocks;
 const mac = await browser(w, storage, { locks });
 const [a, b] = [await save(mac, "", "", "a0"), await save(mac, "", "", "b0")];
 await syncEach(mac);
 await save(mac, a.id, "", "a1 " + "x".repeat(2000));
 await save(mac, b.id, "", "b1");
 w.quotaBytes = w.usedBytes() + 100;
 edit = () => {
  const stored = JSON.parse(storage.getItem(SAVED_PROMPTS_KEY)!) as { prompts: SavedPrompt[] };
  stored.prompts.find(q => q.id === b.id)!.text = "b2";
  storage.setItem(SAVED_PROMPTS_KEY, JSON.stringify(stored));
 };
 takes = 0;
 const posts = w.posts;
 await expect(mac.accountSyncNow()).rejects.toThrow("403");
 // [a1] alone went and was refused; it isn't sent again as a half of the planned [a1, b1].
 expect([w.posts - posts, w.pushed.at(-1)!.map(c => c.id)]).toEqual([1, [a.id]]);
});

test("a refused retry doesn't extend an older send's deadline: the entry keeps the deadline of its open sends only", async () => {
 const w = worker();
 const storage = memory();
 const mac = await browser(w, storage);
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 const start = w.serverNow;
 w.failPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow("503");
 w.failPush = false;
 // A minute later the same content goes again and is refused (429): its later deadline leaves with it.
 w.serverNow += 60_000; w.rateLimit = 1; w.windowPosts = 1;
 await expect(mac.accountSyncNow()).rejects.toThrow("429");
 const entry = (syncOf(storage).promptAttempts[p.id] as PromptAttempt[])[0]!;
 expect([entry.open.length, Object.keys(entry.deadlines ?? {}).length, deadlineOf(entry)]).toEqual([1, 1, start + 120_000]);
});

test("sends trimmed past the cap of open ids keep their deadlines folded: one that went without not_after keeps the entry from expiring", async () => {
 const w = worker();
 const storage = memory();
 const mac = await browser(w, storage);
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 w.failPush = true;
 // The first send goes without not_after (no now_ms yet), eight more with one: the first is trimmed.
 w.omitNow = true;
 const fresh = await browser(w, storage);
 await expect(fresh.accountSyncNow()).rejects.toThrow("503");
 w.omitNow = false;
 for (let i = 0; i < 8; i++) await expect(fresh.accountSyncNow()).rejects.toThrow("503");
 const entry = (syncOf(storage).promptAttempts[p.id] as PromptAttempt[])[0]!;
 expect([entry.open.length, entry.deadlines?.[""], deadlineOf(entry)]).toEqual([8, 0, 0]);
 // A day later on the service's clock the entry is still held (not consumed and started over):
 // the send it went again joins it, which keeps eight ids and the fold.
 w.serverNow += 24 * 3600_000;
 await expect(fresh.accountSyncNow()).rejects.toThrow("503");
 const after = (syncOf(storage).promptAttempts[p.id] as PromptAttempt[])[0]!;
 expect([after.open.length, after.deadlines?.[""]]).toEqual([8, 0]);
});

// ---- #359 round 10's review ----

test("a sign-out begun while a push waits for the storage lock sends nothing: the push's sends retire and the round is dropped", async () => {
 const w = worker();
 const storage = memory();
 // The second storage step of the round is the push's prepare: the sign-out starts just before it.
 let takes = 0, signOut: (() => void) | null = null;
 const locks = { request: (name: string, ...args: unknown[]) => {
  const run = args.at(-1) as () => Promise<unknown>;
  if (name === SAVED_PROMPTS_KEY && ++takes === 2) signOut?.();
  return run();
 } } as unknown as AbortableLocks;
 const mac = await browser(w, storage, { locks });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 signOut = () => { void mac.account.signOut(); };
 takes = 0;
 const posts = w.posts;
 await mac.accountSyncNow().catch(() => {});
 expect([w.posts, openSends(storage, p.id), JSON.parse(w.livePrompts()[p.id]!).text]).toEqual([posts, [], "v0"]);
});

test("a round past its deadline lets the round lock go though it waits for the storage lock, and applies nothing later", async () => {
 const w = worker();
 const { locks, idle } = lockQueue();
 const storage = memory();
 const tab1 = await browser(w, storage, { locks, roundMs: 300 });
 const p = await save(tab1, "", "", "v0");
 // Another tab is between its read and its write of the saved prompts.
 const release = Promise.withResolvers<void>();
 const other = locks.request(SAVED_PROMPTS_KEY, () => release.promise);
 await expect(tab1.sync.sync()).rejects.toThrow();
 // Another tab gets the round lock: the timed-out round let it go.
 await locks.request("herdrup-account-sync", async () => {});
 release.resolve();
 await other;
 await idle();
 expect([p.id in w.livePrompts(), (await tab1.accountSyncStatus()).lastSyncedMs]).toEqual([false, 0]);
});

test("the saved prompts and the sync state are one write: one storage refuses leaves both as they were, and one that takes the merge's leaves them agreed", async () => {
 // Every write refused: the record stays exactly as it was; a later edit here then goes.
 {
  const w = worker();
  const storage = memory();
  const mac = await browser(w, storage);
  const p = await save(mac, "", "", "v0");
  await syncEach(mac);
  w.seedPrompt(p.id, { text: "v1", order: 0 });
  const before = storage.getItem(SAVED_PROMPTS_KEY);
  storage.refuses = () => true;
  await expect(mac.accountSyncNow()).rejects.toThrow("quota");
  expect(storage.getItem(SAVED_PROMPTS_KEY)).toBe(before);
  storage.refuses = null;
  await save(mac, p.id, "", "mine");
  await mac.accountSyncNow();
  expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["mine", "mine"]);
 }
 // The merge's write taken and every write after it refused: what it wrote is agreed, not an
 // edit here, so another device's later v2 is taken here.
 {
  const w = worker();
  const storage = memory();
  const mac = await browser(w, storage);
  const p = await save(mac, "", "", "v0");
  await syncEach(mac);
  w.seedPrompt(p.id, { text: "v1", order: 0 });
  let allowed = 1;
  storage.refuses = () => allowed-- <= 0;
  await expect(mac.accountSyncNow()).rejects.toThrow("quota");
  storage.refuses = null;
  w.seedPrompt(p.id, { text: "v2", order: 0 });
  await mac.accountSyncNow();
  expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["v2", "v2"]);
 }
});

test("a sync state from before, under its own key, is taken into the one record, and its key goes after the first write", async () => {
 const w = worker();
 const storage = memory();
 const mac = await browser(w, storage);
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 // The state as an older build kept it: on its own key, the record without it.
 const record = JSON.parse(storage.getItem(SAVED_PROMPTS_KEY)!);
 storage.setItem(ACCOUNT_SYNC_KEY, JSON.stringify(record.sync));
 delete record.sync;
 storage.setItem(SAVED_PROMPTS_KEY, JSON.stringify(record));
 // An edit here (its first write takes the old state in, and the old key goes), then another
 // device's v1: the edit is one against the agreed v0 the old state held, so it goes.
 await save(mac, p.id, "", "mine");
 expect(storage.getItem(ACCOUNT_SYNC_KEY)).toBeNull();
 w.seedPrompt(p.id, { text: "v1", order: 0 });
 await mac.accountSyncNow();
 expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text, syncOf(storage).promptBaseline[p.id].text]).toEqual(["mine", "mine", "mine"]);
});

test("an upload landing that a readback shows is recorded then: a revert saved meanwhile survives another device's later edit", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 await save(mac, p.id, "", "v0");
 // An unrelated push: the held v1 lands while it is on its way, so its readback shows v1.
 await save(mac, "", "", "unrelated");
 w.onPush = () => w.landHeld();
 await mac.accountSyncNow();
 // Another device saves v3; the revert to v0 here is still this browser's edit.
 w.seedPrompt(p.id, { text: "v3", order: 0 });
 await mac.accountSyncNow();
 expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["v0", "v0"]);
});

test("pushes are sized with their deadline: 32 changes of exactly 256 KiB alone are split before not_after is added", () => {
 const change = (i: number, text: string): SyncChange => ({ collection: "prompts", id: `p${String(i).padStart(2, "0")}`, body: { text }, base_rev: 0 });
 const bare = JSON.stringify({ changes: Array.from({ length: 32 }, (_, i) => change(i, "")) }).length, pad = 256 * 1024 - bare;
 const changes = Array.from({ length: 32 }, (_, i) => change(i, "x".repeat(Math.floor(pad / 32) + (i < pad % 32 ? 1 : 0))));
 expect(JSON.stringify({ changes }).length).toBe(256 * 1024);
 expect(batches(changes).every(part => JSON.stringify({ changes: part, not_after: Date.UTC(2026, 10, 24, 12) + 120_000 }).length <= 256 * 1024)).toBe(true);
});

test("a round past its deadline that gets the storage lock after all applies nothing: the merge is checked against the deadline inside", async () => {
 const w = worker();
 // The storage lock is granted to the round's wait though its deadline passed (late).
 const { locks, idle } = lockQueue(true);
 const storage = memory();
 const tab1 = await browser(w, storage, { locks, roundMs: 300 });
 const p = await save(tab1, "", "", "v0");
 w.seedPrompt("00000000-0000-4000-8000-0000000000aa", { text: "from elsewhere", order: 5 });
 const release = Promise.withResolvers<void>();
 const other = locks.request(SAVED_PROMPTS_KEY, () => release.promise);
 await expect(tab1.sync.sync()).rejects.toThrow();
 release.resolve();
 await other;
 await idle();
 expect([(await tab1.savedPrompts()).map(q => q.text), p.id in w.livePrompts()]).toEqual([["v0"], false]);
});

// ---- #359 round 11 and #390 round 7 ----

test("a page that shows an upload landing records it before a later page folds another device's write over it", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 await save(mac, p.id, "", "v0");
 // v1 lands; an unrelated prompt after it; one row a page. Between the pages, another device
 // writes v3.
 w.landHeld();
 w.seedPrompt("00000000-0000-4000-8000-0000000000bb", { text: "unrelated", order: 9 });
 w.pageSize = 1;
 w.onNextPage = () => w.seedPrompt(p.id, { text: "v3", order: 0 });
 await mac.accountSyncNow();
 expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["v0", "v0"]);
});

test("a round whose session is replaced, even by the same account's, sends nothing more", async () => {
 const w = worker();
 const mac = await browser(w);
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 // The round's GET is held; meanwhile this browser signs out and in again (a new session).
 const gate = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>();
 w.onPull = () => reached.resolve();
 w.holdPull = gate.promise;
 const posts = w.posts;
 const round = mac.accountSyncNow().catch(() => {});
 await reached.promise;
 await mac.account.signOut();
 await mac.account.check();
 gate.resolve();
 await round;
 expect([w.posts, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual([posts, "v0"]);
});

test("a round cancelled while it waits for another tab's storage lock after a refusal lets the round lock go; the refusal is written at once", async () => {
 const w = worker();
 const { locks } = lockQueue();
 const storage = memory();
 const mac = await browser(w, storage, { locks, roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1 " + "x".repeat(5000));
 // The push is refused (413); as it is, another tab holds the storage lock.
 const release = Promise.withResolvers<void>();
 let other: Promise<unknown> = Promise.resolve();
 w.bodyLimit = 4 * 1024;
 w.onRefusal = () => { other = locks.request(SAVED_PROMPTS_KEY, () => release.promise); };
 await expect(mac.accountSyncNow()).rejects.toThrow();
 // Another tab gets the round lock; the refusal is already in storage, with no lock taken.
 await locks.request("herdrup-account-sync", async () => {});
 expect(markers(storage).map(([, v]) => v![0])).toEqual(["r"]);
 release.resolve();
 await other;
 // The next round folds it: the send it then makes (503) is the only one open.
 w.bodyLimit = 256 * 1024; w.failPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow("503");
 expect((syncOf(storage).promptAttempts[p.id] as PromptAttempt[]).map(e => e.open.length)).toEqual([1]);
});

test("a row another device wrote after an upload's deadline isn't that upload: a revert saved meanwhile doesn't overwrite it", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 await save(mac, p.id, "", "v0");
 // The held v1 reaches the service past its not_after (refused); 5 s later another device saves
 // the same body.
 w.serverNow += 121_000;
 w.landHeld();
 w.serverNow += 5_000;
 w.seedPrompt(p.id, { text: "v1", order: 0 });
 await mac.accountSyncNow();
 expect([w.expired, (await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual([1, "v1", "v1"]);
});

test("a round cancelled while its readback waits for the storage lock doesn't apply it or advance the last sync", async () => {
 const w = worker();
 const { locks, idle } = lockQueue();
 const storage = memory();
 const mac = await browser(w, storage, { locks, roundMs: 300 });
 await save(mac, "", "", "v0");
 // After the push lands, the readback's GET finds another tab holding the storage lock.
 const release = Promise.withResolvers<void>();
 let other: Promise<unknown> = Promise.resolve();
 w.onPush = () => { w.onPull = () => { other = locks.request(SAVED_PROMPTS_KEY, () => release.promise); }; };
 await expect(mac.accountSyncNow()).rejects.toThrow();
 release.resolve();
 await other;
 await idle();
 expect((await mac.accountSyncStatus()).lastSyncedMs).toBe(0);
});

// ---- #359 round 12 ----

test("a landing a page showed before the next page's reset is dropped with that history: the restored prompt is taken, nothing pushed over it", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 await save(mac, p.id, "", "v0");
 // v1 lands, then an unrelated prompt; one row a page. Before the second page the account is
 // restored to an older history holding the prompt as "restored": that cursor gets 410.
 w.landHeld();
 w.seedPrompt("00000000-0000-4000-8000-0000000000cc", { text: "unrelated", order: 9 });
 w.pageSize = 1;
 w.onNextPage = () => { w.reset(); w.seedPrompt(p.id, { text: "restored", order: 0 }); };
 const posts = w.posts;
 await mac.accountSyncNow();
 expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text, w.posts - posts]).toEqual(["restored", "restored", 0]);
});

/** Two tabs of one browser (one storage, one set of locks); tab A's upload of v1 is taken, but its
 *  acknowledgement can't be written before A's round is cancelled (another tab holds the storage
 *  lock then): A owes it. */
async function deferredAck() {
 const w = worker();
 const { locks } = lockQueue();
 const storage = memory();
 const tabA = await browser(w, storage, { locks, roundMs: 300 }), tabB = await browser(w, storage, { locks });
 const p = await save(tabA, "", "", "v0");
 await syncEach(tabA);
 await save(tabA, p.id, "", "v1");
 const release = Promise.withResolvers<void>();
 let other: Promise<unknown> = Promise.resolve();
 w.afterPush = () => { other = locks.request(SAVED_PROMPTS_KEY, () => release.promise); };
 await expect(tabA.accountSyncNow()).rejects.toThrow();
 release.resolve();
 await other;
 return { w, tabA, tabB, p };
}

test("an acknowledgement owed past cancel is written by the next round, before another device's later edit is merged", async () => {
 const { w, tabA, p } = await deferredAck();
 w.seedPrompt(p.id, { text: "v2", order: 0 });
 await tabA.accountSyncNow();
 expect([(await byID(tabA))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["v2", "v2"]);
});

test("an acknowledgement owed past cancel never takes a baseline back: another tab reconciled the upload and went on", async () => {
 const { w, tabA, tabB, p } = await deferredAck();
 // Tab B takes A's v1 for landed, then another device's v2; then another device writes v3.
 await tabB.accountSyncNow();
 w.seedPrompt(p.id, { text: "v2", order: 0 });
 await tabB.accountSyncNow();
 w.seedPrompt(p.id, { text: "v3", order: 0 });
 // A's owed v1 acknowledgement: its send isn't open any more, and the mirror is past it.
 await tabA.accountSyncNow();
 expect([(await byID(tabA))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["v3", "v3"]);
});

test("a refusal cancelled before the record had it still stops another tab taking another device's same body for this upload", async () => {
 const w = worker();
 const { locks } = lockQueue();
 const storage = memory();
 const tabA = await browser(w, storage, { locks, roundMs: 300 }), tabB = await browser(w, storage, { locks });
 const big = "v1 " + "x".repeat(5000);
 const p = await save(tabA, "", "", "v0");
 await syncEach(tabA);
 await save(tabA, p.id, "", big);
 // A's push is refused (413) while another tab holds the storage lock; A's round is cancelled.
 const release = Promise.withResolvers<void>();
 let other: Promise<unknown> = Promise.resolve();
 w.bodyLimit = 4 * 1024;
 w.onRefusal = () => { other = locks.request(SAVED_PROMPTS_KEY, () => release.promise); };
 await expect(tabA.accountSyncNow()).rejects.toThrow();
 release.resolve();
 await other;
 w.bodyLimit = 256 * 1024;
 // A reverts to v0; another device saves the same body A's refused push held.
 await save(tabA, p.id, "", "v0");
 w.seedPrompt(p.id, { text: big, order: 0 });
 await tabB.accountSyncNow();
 expect([(await byID(tabB))[p.id]!.text === big, JSON.parse(w.livePrompts()[p.id]!).text === big]).toEqual([true, true]);
});

// ---- #390 round 8 on the web ----

test("a refusal whose writes all fail is kept until one succeeds: another device's same body isn't taken for that upload", async () => {
 const w = worker();
 const storage = memory();
 const mac = await browser(w, storage);
 const big = "v1 " + "x".repeat(5000);
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", big);
 // The push is refused (413) while storage refuses every write: neither the refusal's own key
 // nor the record takes it.
 w.bodyLimit = 4 * 1024;
 w.onRefusal = () => { storage.refuses = () => true; };
 await expect(mac.accountSyncNow()).rejects.toThrow();
 storage.refuses = null; w.bodyLimit = 256 * 1024;
 // A revert here; another device saves the refused body. The next round writes the refusal first.
 await save(mac, p.id, "", "v0");
 w.seedPrompt(p.id, { text: big, order: 0 });
 await mac.accountSyncNow();
 expect([(await byID(mac))[p.id]!.text === big, JSON.parse(w.livePrompts()[p.id]!).text === big]).toEqual([true, true]);
});

test("the first row past an upload's base decides it: a later row with the same body, after another device's edit, isn't that upload", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 // v1 is held and never lands; this browser reverts to v0.
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 await save(mac, p.id, "", "v0");
 // Another device saves v2, then (after an unrelated prompt; one row a page) the body v1 was.
 w.seedPrompt(p.id, { text: "v2", order: 0 });
 w.seedPrompt("00000000-0000-4000-8000-0000000000dd", { text: "unrelated", order: 9 });
 w.pageSize = 1;
 w.onNextPage = () => w.seedPrompt(p.id, { text: "v1", order: 0 });
 await mac.accountSyncNow();
 expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["v1", "v1"]);
});

test("a round of a session that was replaced, even by the same account's, doesn't mark the new session's sync failed", async () => {
 const w = worker();
 const mac = await browser(w);
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 // While the push is answered (its answer lost: 503), this browser signs out; then in again.
 w.losePush = true;
 w.afterPush = () => { void mac.account.signOut(); };
 await mac.accountSyncNow().catch(() => {});
 await mac.account.check();
 expect((await mac.accountState()).syncFailed).toBeUndefined();
});

// ---- #359 round 13 ----

test("a cancel after the push's sends were journaled, before it is sent, retires them: another device's same body later isn't taken for it", async () => {
 const w = worker();
 const storage = memory();
 const stop = new AbortController();
 // The cancel comes right after the push's storage step committed (its second of the round).
 let takes = 0, armed = false;
 const runs: Promise<unknown>[] = [];
 const locks = { request: (name: string, ...args: unknown[]) => {
  const run = args.at(-1) as () => Promise<unknown>;
  let ran = run();
  if (armed && name === SAVED_PROMPTS_KEY && ++takes === 2) ran = ran.then(value => { stop.abort(new Error("left")); return value; });
  runs.push(ran);
  return ran;
 } } as unknown as AbortableLocks;
 const mac = await browser(w, storage, { locks });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 armed = true;
 const posts = w.posts;
 await expect(mac.sync.sync(stop.signal)).rejects.toThrow("left");
 await Promise.allSettled(runs);
 expect([w.posts - posts, openSends(storage, p.id)]).toEqual([0, []]);
 // A revert here; another device saves the body that push held.
 await save(mac, p.id, "", "v0");
 w.seedPrompt(p.id, { text: "v1", order: 0 });
 await mac.accountSyncNow();
 expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["v1", "v1"]);
});

test("a push answered with one write taken and one conflict, cancelled while its settlement waits, keeps both: the conflict's send isn't taken later", async () => {
 const w = worker();
 const { locks } = lockQueue();
 const storage = memory();
 const mac = await browser(w, storage, { locks, roundMs: 300 });
 const p = await save(mac, "", "", "p0"), q = await save(mac, "", "", "q0");
 await syncEach(mac);
 await save(mac, p.id, "", "p1");
 await save(mac, q.id, "", "q1");
 // Another device writes q while the push is on its way (q1 conflicts, p1 is taken); as the
 // answer comes, another tab holds the storage lock, and the round is cancelled.
 const release = Promise.withResolvers<void>();
 let other: Promise<unknown> = Promise.resolve();
 w.onPush = () => w.seedPrompt(q.id, { text: "q-other", order: 1 });
 w.afterPush = () => { other = locks.request(SAVED_PROMPTS_KEY, () => release.promise); };
 await expect(mac.accountSyncNow()).rejects.toThrow();
 release.resolve();
 await other;
 const sentQ = w.pushed.at(-1)!.find(c => c.id === q.id)!.body as object;
 // A revert of q here; another device saves the body this browser's refused q1 had.
 await save(mac, q.id, "", "q0");
 w.seedPrompt(q.id, sentQ);
 await mac.accountSyncNow();
 expect([(await byID(mac))[q.id]!.text, JSON.parse(w.livePrompts()[q.id]!).text]).toEqual(["q1", "q1"]);
});

test("a send whose marker storage refuses isn't sent, and nothing of it is left open", async () => {
 const w = worker();
 const storage = memory();
 const mac = await browser(w, storage);
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 // The store is full for any new key: the send's marker can't be written.
 storage.refuses = key => key.startsWith("herdrup.sync.send.");
 const posts = w.posts;
 await expect(mac.accountSyncNow()).rejects.toThrow("quota");
 expect([w.posts - posts, openSends(storage, p.id), markers(storage)]).toEqual([0, [], []]);
});

test("a refusal at a full store overwrites its reserved marker in place: another tab doesn't take another device's same body for that upload", async () => {
 const w = worker();
 const { locks } = lockQueue();
 const storage = memory();
 const tabA = await browser(w, storage, { locks, roundMs: 300 }), tabB = await browser(w, storage, { locks });
 const big = "v1 " + "x".repeat(5000);
 const p = await save(tabA, "", "", "v0");
 await syncEach(tabA);
 await save(tabA, p.id, "", big);
 // A's push is refused (413) when the store is full and another tab holds the storage lock.
 const release = Promise.withResolvers<void>();
 let other: Promise<unknown> = Promise.resolve();
 w.bodyLimit = 4 * 1024;
 w.onRefusal = () => { storage.quota = storage.used(); other = locks.request(SAVED_PROMPTS_KEY, () => release.promise); };
 await expect(tabA.accountSyncNow()).rejects.toThrow();
 expect(markers(storage).map(([, v]) => v![0])).toEqual(["r"]);
 release.resolve();
 await other;
 storage.quota = Infinity; w.bodyLimit = 256 * 1024;
 await save(tabA, p.id, "", "v0");
 w.seedPrompt(p.id, { text: big, order: 0 });
 await tabB.accountSyncNow();
 expect([(await byID(tabB))[p.id]!.text === big, JSON.parse(w.livePrompts()[p.id]!).text === big]).toEqual([true, true]);
});

test("an open send's reserved marker survives another tab's merge, and goes once the send settles", async () => {
 const w = worker();
 const storage = memory();
 const tabA = await browser(w, storage), tabB = await browser(w, storage);
 const p = await save(tabA, "", "", "v0");
 await syncEach(tabA);
 await save(tabA, p.id, "", "v1");
 w.failPush = true;
 await expect(tabA.accountSyncNow()).rejects.toThrow("503");
 // B's round (its push fails too) merges with A's send still open: its "o" stays.
 await expect(tabB.accountSyncNow()).rejects.toThrow("503");
 expect(markers(storage).map(([, v]) => v![0])).toEqual(["o", "o"]);
 w.failPush = false;
 await tabB.accountSyncNow();
 expect(markers(storage)).toEqual([]);
});

test("a push carries not_after while the newest answer told now_ms, and goes without it once one didn't", async () => {
 const w = worker();
 const mac = await browser(w);
 const p = await save(mac, "", "", "v0");
 await mac.accountSyncNow();
 expect(typeof w.notAfters.at(-1)).toBe("number");
 w.omitNow = true;
 await save(mac, p.id, "", "v1");
 await mac.accountSyncNow();
 expect(w.notAfters.at(-1)).toBeUndefined();
});

// ---- #359 round 14 ----

test("a conflict is marked refused as its answer is read: another tab doesn't take another device's same body for that send, though the settlement waits", async () => {
 const w = worker();
 const { locks } = lockQueue();
 const storage = memory();
 const tabA = await browser(w, storage, { locks, roundMs: 300 }), tabB = await browser(w, storage, { locks });
 const p = await save(tabA, "", "", "p0"), q = await save(tabA, "", "", "q0");
 await syncEach(tabA);
 await save(tabA, p.id, "", "p1");
 await save(tabA, q.id, "", "q1");
 const release = Promise.withResolvers<void>();
 let other: Promise<unknown> = Promise.resolve();
 w.onPush = () => w.seedPrompt(q.id, { text: "q-other", order: 1 });
 w.afterPush = () => { other = locks.request(SAVED_PROMPTS_KEY, () => release.promise); };
 await expect(tabA.accountSyncNow()).rejects.toThrow();
 release.resolve();
 await other;
 const sentQ = w.pushed.at(-1)!.find(c => c.id === q.id)!.body as object;
 await save(tabA, q.id, "", "q0");
 w.seedPrompt(q.id, sentQ);
 // Tab B, not A: A's settlement is still only in A's memory.
 await tabB.accountSyncNow();
 expect([(await byID(tabB))[q.id]!.text, JSON.parse(w.livePrompts()[q.id]!).text]).toEqual(["q1", "q1"]);
});

test("a settlement owed from before a restore settles only its own send: another tab's newer upload isn't retired by its old row", async () => {
 const w = worker();
 const { locks } = lockQueue();
 const storage = memory();
 const tabA = await browser(w, storage, { locks, roundMs: 300 }), tabB = await browser(w, storage, { locks });
 const p = await save(tabA, "", "", "v0");
 await syncEach(tabA);
 // A's push of a1 conflicts with another device's x; its settlement waits for another tab, and A
 // is cancelled.
 await save(tabA, p.id, "", "a1");
 const release = Promise.withResolvers<void>();
 let other: Promise<unknown> = Promise.resolve();
 w.onPush = () => w.seedPrompt(p.id, { text: "x", order: 0 });
 w.afterPush = () => { other = locks.request(SAVED_PROMPTS_KEY, () => release.promise); };
 await expect(tabA.accountSyncNow()).rejects.toThrow();
 release.resolve();
 await other;
 // A reverts; tab B syncs (it takes x, and the account moves on with another prompt).
 await save(tabA, p.id, "", "v0");
 w.onPush = null; w.afterPush = null;
 w.seedPrompt("00000000-0000-4000-8000-0000000000ee", { text: "unrelated", order: 9 });
 await tabB.accountSyncNow();
 // The account is restored to an older history holding v0 (B's next pull gets 410). Tab B pulls
 // it and sends v2 (it lands, its answer is lost), and reverts to v0 while v2 is on its way.
 w.reset(); w.seedPrompt(p.id, { text: "v0", order: 0 });
 await tabB.accountSyncNow();
 expect((await byID(tabB))[p.id]!.text).toBe("v0");
 await save(tabB, p.id, "", "v2");
 let reverting: Promise<unknown> = Promise.resolve();
 w.losePush = true;
 w.afterPush = () => { reverting = tabB.savePrompt({ id: p.id, nickname: "", text: "v0" }); };
 await expect(tabB.accountSyncNow()).rejects.toThrow("503");
 await reverting;
 // A pays its old settlement first: B's v2 send is still B's, so v2 is that landing, and the
 // revert to v0 goes.
 await tabA.accountSyncNow();
 expect([(await byID(tabA))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["v0", "v0"]);
});

test("a delete kept for an upload that may still land leaves the round incomplete until it goes", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 await syncEach(mac);
 // A new prompt's create is received and kept past the deadline; it is deleted here meanwhile.
 const q = await save(mac, "", "", "brief");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 await mac.deletePrompt(q.id);
 const before = (await mac.accountSyncStatus()).lastSyncedMs;
 await expect(mac.accountSyncNow()).rejects.toThrow("deleted prompt waits");
 expect((await mac.accountSyncStatus()).lastSyncedMs).toBe(before);
 // The create lands; the delete goes, and the round finishes.
 w.landHeld();
 await mac.accountSyncNow();
 expect(q.id in w.livePrompts()).toBe(false);
});

// ---- #390 round 15 on the web ----

test("a reload between an upload's answer and its settlement keeps what landed: a revert saved after it beats another device's later edit", async () => {
 const w = worker();
 const { locks } = lockQueue();
 const storage = memory();
 const mac = await browser(w, storage, { locks, roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 // v1 is taken; as the answer comes another tab holds the storage lock, and the page is gone
 // before its settlement is written (a new page on the same storage).
 const release = Promise.withResolvers<void>();
 let other: Promise<unknown> = Promise.resolve();
 w.afterPush = () => { other = locks.request(SAVED_PROMPTS_KEY, () => release.promise); };
 await expect(mac.accountSyncNow()).rejects.toThrow();
 expect(markers(storage).map(([, v]) => v![0])).toEqual(["a"]);
 release.resolve();
 await other;
 const reloaded = await browser(w, storage, { locks });
 // A revert here; then another device edits.
 await save(reloaded, p.id, "", "v0");
 w.seedPrompt(p.id, { text: "v2", order: 0 });
 await reloaded.accountSyncNow();
 expect([(await byID(reloaded))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text, markers(storage)]).toEqual(["v0", "v0", []]);
});

test("an acceptance kept from before a restore only retires its send: what it wrote is no part of the restored account", async () => {
 const w = worker();
 const { locks } = lockQueue();
 const storage = memory();
 const mac = await browser(w, storage, { locks, roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 const release = Promise.withResolvers<void>();
 let other: Promise<unknown> = Promise.resolve();
 w.afterPush = () => { other = locks.request(SAVED_PROMPTS_KEY, () => release.promise); };
 await expect(mac.accountSyncNow()).rejects.toThrow();
 // While the page is gone, another tab's pull found the account restored (a new history).
 const record = JSON.parse(storage.getItem(SAVED_PROMPTS_KEY)!) as { sync: { history?: number } };
 record.sync.history = (record.sync.history ?? 0) + 1;
 storage.setItem(SAVED_PROMPTS_KEY, JSON.stringify(record));
 release.resolve();
 await other;
 const reloaded = await browser(w, storage, { locks });
 await save(reloaded, p.id, "", "v0");
 w.seedPrompt(p.id, { text: "v2", order: 0 });
 await reloaded.accountSyncNow();
 // v0 is what this browser last agreed in that history: the other device's v2 is newer.
 expect([(await byID(reloaded))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text, openSends(storage, p.id), markers(storage)]).toEqual(["v2", "v2", [], []]);
});

test("what a conflict's row showed is dropped when the readback finds the account restored: the restored prompt isn't judged against it", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 w.seedPrompt("00000000-0000-4000-8000-0000000000ff", { text: "unrelated", order: 9 });
 await syncEach(mac);
 // v1 is held; then v2 is sent, and lands its conflict on the held v1 as it lands (that row shows
 // the held send landing) while v1 is saved here again; as the answer comes, the account is
 // restored to an older backup.
 await save(mac, p.id, "", "v1");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 await save(mac, p.id, "", "v2");
 let saving: Promise<unknown> = Promise.resolve();
 w.onPush = () => { w.onPush = null; w.landHeld(); saving = save(mac, p.id, "", "v1"); };
 w.afterPush = () => { w.afterPush = null; w.reset(); w.seedPrompt(p.id, { text: "restored", order: 0 }); };
 await mac.accountSyncNow().catch(() => {});
 await saving;
 await mac.accountSyncNow();
 // v1 landing was never agreed in the restored history: v1 is this browser's edit, and goes.
 expect([(await byID(mac))[p.id]!.text, JSON.parse(w.livePrompts()[p.id]!).text]).toEqual(["v1", "v1"]);
});

test("a draft held at the variant cap doesn't pin the rate-limit cursor: the round after resumes from the write that can go", async () => {
 const w = worker();
 w.omitNow = true;
 const storage = memory();
 const mac = await browser(w, storage);
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 w.failPush = true;
 for (const v of ["L1", "L2"]) {
  await save(mac, p.id, "", v);
  await expect(mac.accountSyncNow()).rejects.toThrow("503");
 }
 w.failPush = false;
 // p's newest edit is held at the cap; an unrelated new prompt comes after it; the push is out of
 // requests (429).
 await save(mac, p.id, "", "L3");
 const q = await save(mac, "", "", "unrelated");
 w.rateLimit = 1; w.windowPosts = 1;
 await expect(mac.accountSyncNow()).rejects.toThrow("429");
 expect(syncOf(storage).promptsTurn).toBe(q.id);
});

test("a readback that finds a deleted prompt back after a restore leaves the round incomplete; the next deletes it again", async () => {
 const w = worker();
 const mac = await browser(w);
 const p = await save(mac, "", "", "v0");
 w.seedPrompt("00000000-0000-4000-8000-0000000000fe", { text: "unrelated", order: 9 });
 await syncEach(mac);
 const before = (await mac.accountSyncStatus()).lastSyncedMs;
 await mac.deletePrompt(p.id);
 // As the delete is taken, the account is restored to a backup that holds p.
 w.afterPush = () => { w.reset(); w.seedPrompt(p.id, { text: "v0", order: 0 }); };
 await expect(mac.accountSyncNow()).rejects.toThrow("back after the account was restored");
 expect((await mac.accountSyncStatus()).lastSyncedMs).toBe(before);
 await mac.accountSyncNow();
 expect(p.id in w.livePrompts()).toBe(false);
});

// ---- #432 post-merge review (#439-#443) ----

/** v0 synced, then v1 taken by the account while another tab holds the storage lock: the page is
 *  gone (its round cancelled) before the answer's settlement is written, with the acceptance in
 *  its marker only. full, if set, fills the storage as the answer comes. Returns a new page on the
 *  same storage. */
async function acceptedThenReloaded(w: Worker, storage: ReturnType<typeof memory>, full = false) {
 const { locks } = lockQueue();
 const mac = await browser(w, storage, { locks, roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 // Another prompt, so a restore to a backup with p alone is behind this browser's mirror (410).
 await save(mac, "", "", "other");
 await syncEach(mac);
 await save(mac, p.id, "", "v1");
 const release = Promise.withResolvers<void>();
 let other: Promise<unknown> = Promise.resolve();
 w.afterPush = () => {
  if (full) storage.quota = storage.used();
  other = locks.request(SAVED_PROMPTS_KEY, () => release.promise);
 };
 await expect(mac.accountSyncNow()).rejects.toThrow();
 expect(markers(storage).map(([, v]) => v![0])).toEqual(["a"]);
 storage.quota = Infinity;
 release.resolve();
 await other;
 return { p, reloaded: await browser(w, storage, { locks }) };
}
const liveText = (w: Worker, id: string) => (JSON.parse(w.livePrompts()[id]!) as { text: string }).text;

test("#439: an acceptance recovered after a reload stays the agreement while the revert it makes an edit is out of pushes", async () => {
 const w = worker(), storage = memory();
 const { p, reloaded } = await acceptedThenReloaded(w, storage);
 await save(reloaded, p.id, "", "v0");
 w.seedPrompt(p.id, { text: "v2", order: 0 });
 // The revert's push is answered 429; the next minute it goes.
 w.rateLimit = 1; w.windowPosts = 1;
 await expect(reloaded.accountSyncNow()).rejects.toThrow("429");
 w.newWindow();
 await reloaded.accountSyncNow();
 expect([(await byID(reloaded))[p.id]!.text, liveText(w, p.id), syncOf(storage).promptBaselineHash?.[p.id]]).toEqual(["v0", "v0", undefined]);
});

test("#440: the first pull to find the account restored makes an acceptance kept from before it agree nothing: the restored prompt stays", async () => {
 const w = worker(), storage = memory();
 const { p, reloaded } = await acceptedThenReloaded(w, storage);
 // Back at v0, what was agreed before v1; then the account is restored to a backup holding p.
 await save(reloaded, p.id, "", "v0");
 w.reset();
 w.seedPrompt(p.id, { text: "restored", order: 0 });
 const posts = w.posts;
 await reloaded.accountSyncNow();
 expect([(await byID(reloaded))[p.id]!.text, liveText(w, p.id), w.posts - posts, openSends(storage, p.id), markers(storage)]).toEqual(["restored", "restored", 0, [], []]);
});

test("#441: an acceptance is recorded though the storage is full by the time it is answered", async () => {
 const w = worker(), storage = memory();
 const { p, reloaded } = await acceptedThenReloaded(w, storage, true);
 await save(reloaded, p.id, "", "v0");
 w.seedPrompt(p.id, { text: "v2", order: 0 });
 await reloaded.accountSyncNow();
 expect([(await byID(reloaded))[p.id]!.text, liveText(w, p.id), markers(storage)]).toEqual(["v0", "v0", []]);
});

test("#442: a conflict showing an earlier upload landed still counts after its readback timed out", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 const p = await save(mac, "", "", "v0");
 await syncEach(mac);
 // v1 is held; then v2 is sent, and the held v1 lands just before it: the conflict's row is v1,
 // the held send landing. A revert to v0 is saved here and another device writes v3; the
 // readback doesn't come back within the round.
 await save(mac, p.id, "", "v1");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 await save(mac, p.id, "", "v2");
 let saving: Promise<unknown> = Promise.resolve();
 const gate = Promise.withResolvers<void>();
 w.onPush = () => w.landHeld();
 w.afterPush = () => {
  saving = save(mac, p.id, "", "v0");
  w.seedPrompt(p.id, { text: "v3", order: 0 });
  w.holdPull = gate.promise;
 };
 await expect(mac.accountSyncNow()).rejects.toThrow("timed out");
 gate.resolve();
 await saving;
 // v1 was agreed: v0 is an edit here, and goes over v3.
 await mac.accountSyncNow();
 expect([(await byID(mac))[p.id]!.text, liveText(w, p.id)]).toEqual(["v0", "v0"]);
});

test("#443: a readback from revision 0 that the service didn't restart keeps the conflict's evidence", async () => {
 const w = worker();
 const mac = await browser(w, memory(), { roundMs: 300 });
 await syncEach(mac);
 // An empty account. v1, the first prompt, is held; v2 is saved and sent, and the held v1 lands
 // just before it: the conflict's row is v1. Meanwhile v1 is saved here again, and another
 // device writes v3.
 const p = await save(mac, "", "", "v1");
 w.holdNextPush = true;
 await expect(mac.accountSyncNow()).rejects.toThrow();
 await save(mac, p.id, "", "v2");
 let saving: Promise<unknown> = Promise.resolve();
 w.onPush = () => { w.landHeld(); saving = save(mac, p.id, "", "v1"); };
 w.afterPush = () => w.seedPrompt(p.id, { text: "v3", order: 0 });
 await mac.accountSyncNow().catch(() => {});
 await saving;
 await mac.accountSyncNow();
 // v1 is what was agreed: v3, newer, is taken.
 expect([(await byID(mac))[p.id]!.text, liveText(w, p.id)]).toEqual(["v3", "v3"]);
});

// ---- #390 review of e8debfe, on the web ----

test("an acceptance that comes to light only after a restore makes the copy it wrote no edit: the restored row stays", async () => {
 const w = worker(), storage = memory();
 const { p, reloaded } = await acceptedThenReloaded(w, storage);
 // v1, accepted, is still saved here; the account is restored to a backup holding v0 (the
 // first pull gets 410).
 w.reset();
 w.seedPrompt(p.id, { text: "v0", order: 0 });
 const posts = w.posts;
 await reloaded.accountSyncNow();
 expect([(await byID(reloaded))[p.id]!.text, liveText(w, p.id), w.posts - posts, openSends(storage, p.id), markers(storage)]).toEqual(["v0", "v0", 0, [], []]);
});

test("a conflict's tombstone from a history a restore replaced doesn't delete a draft", async () => {
 const w = worker();
 const mac = await browser(w);
 const a = await save(mac, "", "", "a");
 await save(mac, "", "", "b");
 await syncEach(mac);
 const body = JSON.parse(w.livePrompts()[a.id]!) as object;
 // The draft's first upload meets a tombstone of its id; the account is then restored to a
 // backup without it (the readback gets 410).
 const d = await save(mac, "", "", "draft");
 w.onPush = () => w.seedTombstone(d.id);
 w.afterPush = () => { w.reset(); w.seedPrompt(a.id, body); };
 await mac.accountSyncNow().catch(() => {});
 await mac.accountSyncNow();
 expect([(await byID(mac))[d.id]?.text, liveText(w, d.id)]).toEqual(["draft", "draft"]);
});
