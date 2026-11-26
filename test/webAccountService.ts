// Test-only: a fake account service (AccountService sync.ts, devices.ts, auth refresh) and a
// browser's localStorage, for the web account tests (webAccountSync.test.ts, webShares.test.ts).
import { x25519 } from "@noble/curves/ed25519.js";
import type { AccountDevice, SyncChange, SyncItem } from "../src/web/account";
import { toB64url } from "../src/webguest/b64url";

const access = (n: number) => `a1.${"s".repeat(22)}.${String(n).padStart(43, "0")}`;

/** The most prompts an account holds (sync.ts COLLECTION_CAPS.prompts). */
export const PROMPTS_CAP = 500;

/** localStorage for one browser; writes counts setItem calls per key. With a quota (UTF-16 code
 *  units, as browsers count), a write past it throws QuotaExceededError and stores nothing, as
 *  does a write to a key refuses names (a storage near its quota for that one write). */
export function memory(quota = Infinity) {
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

/** The account service: one account's sync items and devices, and a session per browser (with
 *  accountsApart, each account its own sync items). */
export function worker() {
 const items = new Map<string, SyncItem>();
 /** With accountsApart, the sync items of each account other than "acct" (whose are items). */
 const others = new Map<string, Map<string, SyncItem>>();
 const devices: AccountDevice[] = [];
 const sessions = new Map<string, { device: string | null; ended: boolean; account: string }>();
 /** The sync items a session reads and writes: its account's (the one it last refreshed into). */
 const itemsOf = (s: { account: string }) => {
  if (!w.accountsApart || s.account === "acct") return items;
  let mine = others.get(s.account);
  if (mine === undefined) others.set(s.account, mine = new Map());
  return mine;
 };
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
  /** Each account keeps its own sync items (sharesIn); otherwise every session reads and writes
   *  one account's, whichever account it is signed in to. */
  accountsApart: false,
  /** The ids of the live shares the account holds. */
  sharesIn(acct: string): string[] { return [...itemsOf({ account: acct }).values()].filter(it => it.collection === "shares" && !it.deleted).map(it => it.id); },
  /** The next push is applied, and its answer lost (a 503 instead). */
  losePush: false,
  /** GET /v1/sync answers nothing until its request is aborted. */
  stallPull: false,
  /** The next GET /v1/sync is answered 503 (the service unavailable). */
  failPull: false,
  /** The next 410 to a GET /v1/sync comes with its status line, and a body that never ends
   *  until its request is aborted. */
  stallResetBody: false,
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
  seedShare(id: string, body: object) { w.rev++; items.set(id, { collection: "shares", id, rev: w.rev, updated_ms: w.serverNow, deleted: false, body }); },
  /** The account's history starts over, as after a restored database. */
  reset() { items.clear(); w.rev = 0; w.floor = 0; },
  livePrompts(): Record<string, string> {
   return Object.fromEntries([...items.values()].filter(it => it.collection === "prompts" && !it.deleted).map(it => [it.id, JSON.stringify(it.body)]));
  },
  devices,
  addDevice(name: string, created: number) { devices.push({ id: `dev${devices.length}`.padEnd(22, "x"), name, platform: "macos", device_pub: `pub-${name}`, created_ms: created }); },
  /** The page fetch of one browser, with its own session. */
  fetcher(session: string): typeof fetch {
   sessions.set(session, { device: null, ended: false, account: w.accountId });
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
     n++; s.account = w.accountId;
     return Response.json({ account_id: w.accountId, access_token: access(n), access_expires_in: 3600 });
    }
    if (s.ended) return Response.json({ error: "invalid_token" }, { status: 401 });
    if (url.pathname === "/v1/sync" && method === "GET") {
     const pulled = w.onPull; w.onPull = null; pulled?.();
     if (w.holdPull) { const gate = w.holdPull; w.holdPull = null; await gate; }
     if (w.failPull) { w.failPull = false; return Response.json({ error: "unavailable" }, { status: 503 }); }
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
     if (complete > w.rev || complete < w.floor) {
      if (w.stallResetBody) {
       w.stallResetBody = false;
       const body = new ReadableStream<Uint8Array>({ start(c) { init.signal!.addEventListener("abort", () => c.error(init.signal!.reason)); } });
       return new Response(body, { status: 410, headers: { "Content-Type": "application/json" } });
      }
      return Response.json({ error: "reset_required" }, { status: 410 });
     }
     // now_ms is read before the rows (themartianapp/herdrup#826): nothing the page holds was
     // written after it.
     const told = now();
     const changes = [...itemsOf(s).values()].filter(it => it.rev > position).sort((a, b) => a.rev - b.rev);
     const page = changes.slice(0, w.pageSize), more = changes.length > page.length;
     return Response.json({ rev: w.rev, changes: page, more, ...(more ? { cursor: `${page.at(-1)!.rev}.${base}` } : {}), ...told });
    }
    if (url.pathname === "/v1/sync" && method === "POST") return push(String(init.body), body.changes as SyncChange[], body.not_after as number | undefined, init.signal ?? undefined, itemsOf(s));
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
 function apply(changes: SyncChange[], store = items): { applied: object[]; conflicts: object[] } | null {
  const next = new Map(store);
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
  store.clear();
  for (const [id, it] of next) store.set(id, it);
  w.rev = rev;
  const applied: object[] = [], conflicts: object[] = [];
  for (const c of changes) {
   const row = store.get(c.id);
   const holds = (row === undefined || row.deleted) === !!c.deleted && (c.deleted || JSON.stringify(row!.body) === JSON.stringify(c.body));
   if (holds) applied.push({ collection: c.collection, id: c.id, rev: row?.rev ?? 0 });
   else conflicts.push({ collection: c.collection, id: c.id, server: row ?? null });
  }
  return { applied, conflicts };
 }
 // sync.ts: a push over 100 changes or 256 KiB is refused whole, as is one holding an item it
 // won't keep or one past a cap (apply).
 function push(raw: string, changes: SyncChange[], notAfter: number | undefined, signal?: AbortSignal, store = items): Response | Promise<Response> {
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
   if (c.body === undefined || c.collection !== "prompts") continue;
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
  const answer = apply(changes, store);
  if (answer === null) return refusal(403, "quota");
  w.pushes++;
  const after = w.afterPush; w.afterPush = null; after?.();
  if (w.losePush) { w.losePush = false; return Response.json({ error: "unavailable" }, { status: 503 }); }
  return Response.json({ rev: w.rev, ...answer, ...now() });
 }
 return w;
}

export type Worker = ReturnType<typeof worker>;
