// The web guest's account session (src/web/account.ts) against a stub of the account service's
// cookie flow (design #698 §2.3, §2.5): the refresh token lives in the service's HttpOnly cookie,
// so every call is credentialed and carries no token in its body, and refreshes are single-flight
// because a rotated-away cookie revokes the session.
import { expect, test } from "bun:test";
import { AccountServiceError, returnedFromSignIn, SignedOutError, WebAccount, webSignInAvailable, webSignInProviders, webSignInURL } from "../src/web/account";
import type { AccountState } from "../src/mygo";
import { x25519 } from "@noble/curves/ed25519.js";
import { fromB64url, toB64url } from "../src/webguest/b64url";
import { enrolProof } from "../src/webguest/enrol";
import { staticKey } from "../src/webguest/identity";
import { createAccountDesk } from "../src/web/accountDesk";
import { approvalRunning, followSession, OwnerWork, PageExit } from "../src/web/ownerSession";
import type { OwnerPhase } from "../src/web/ownerApproval";
import type { Locks } from "../src/web/locks";
import { statementCache } from "../src/web/statements";
import { runApproval } from "../src/web/ownerApproval";
import { MemoryOwnerStore } from "../src/web/ownerStore";
import { MemoryIdentityStore } from "../src/webguest/identity";

const access = (n: number) => `a1.${"s".repeat(22)}.${String(n).padStart(43, "0")}`;

/** The service: one cookie that rotates on each refresh; a spent cookie revokes the session.
 *  route answers the account calls (null: 404), given the Bearer token sent. */
function service(route: (url: string, init: RequestInit, bearer: string) => Response | Promise<Response> | null = () => null, accountOf: (n: number) => string = () => "acct-1") {
 let cookie = "c0", n = 0, revoked = false;
 const spent = new Set<string>();
 const calls: { url: string; init: RequestInit; cookie: string }[] = [];
 const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input);
  // The browser sends the cookie only on a credentialed request.
  const sent = init.credentials === "include" ? cookie : "";
  calls.push({ url, init, cookie: sent });
  await Promise.resolve();
  if (url.endsWith("/v1/auth/refresh")) {
   if (revoked || !sent || spent.has(sent)) { revoked = true; return Response.json({ error: "session_revoked" }, { status: 401 }); }
   spent.add(sent); n++; cookie = `c${n}`;
   return Response.json({ account_id: accountOf(n), access_token: access(n), access_expires_in: 3600, ...(n === 1 ? { display_hint: "jerry@example.com" } : {}) });
  }
  if (url.endsWith("/v1/auth/signout")) { revoked = true; return new Response(null, { status: 204 }); }
  const bearer = String((init.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^Bearer /, "");
  return await route(url, init, bearer) ?? Response.json({ error: "not_found" }, { status: 404 });
 }) as typeof fetch;
 return { fetcher, calls, revoke: () => { revoked = true; } };
}

test("sign-in is a top-level navigation offered only on guest.herdrup.app", () => {
 expect(webSignInURL("google")).toBe("https://accounts.herdrup.app/v1/auth/web/start?provider=google&client=web");
 expect([webSignInAvailable("https://guest.herdrup.app"), webSignInAvailable("https://guest.herdrup.themartian.app")]).toEqual([true, false]);
 expect(returnedFromSignIn("https://guest.herdrup.app/web/?account=1#x")).toEqual({ clean: "https://guest.herdrup.app/web/#x", error: null });
 expect(returnedFromSignIn("https://guest.herdrup.app/web/?account_error=flow_expired")).toEqual({ clean: "https://guest.herdrup.app/web/", error: "flow_expired" });
 expect(returnedFromSignIn("https://guest.herdrup.app/web/")).toBeNull();
});

test("refreshes are credentialed, carry no token, and concurrent callers share one", async () => {
 const s = service();
 const account = new WebAccount(s.fetcher);
 const tokens = await Promise.all(Array.from({ length: 8 }, () => account.accessToken()));
 expect(new Set(tokens).size).toBe(1);
 expect(s.calls.length).toBe(1);
 expect(s.calls[0]!.init).toMatchObject({ method: "POST", credentials: "include", mode: "cors" });
 expect(s.calls[0]!.init.body).toBeUndefined();
 expect(account.current).toEqual({ accountID: "acct-1", displayHint: "jerry@example.com" });
});

test("an expired access token refreshes once more; the display hint is kept", async () => {
 let now = 1_000_000;
 const s = service();
 const account = new WebAccount(s.fetcher, undefined, () => now);
 const first = await account.accessToken();
 now += 3_600_000;
 const second = await account.accessToken();
 expect(second).not.toBe(first);
 expect(s.calls.length).toBe(2);
 expect(account.current?.displayHint).toBe("jerry@example.com");
});

test("sign-out goes by the cookie, even with the access token expired; a refused cookie is signed out", async () => {
 let now = 1_000_000;
 const s = service();
 const account = new WebAccount(s.fetcher, undefined, () => now);
 expect(await account.check()).toEqual({ accountID: "acct-1", displayHint: "jerry@example.com" });
 now += 3_600_000;
 await account.signOut();
 const signout = s.calls.find(c => c.url.endsWith("/v1/auth/signout"))!;
 expect(signout.init).toMatchObject({ method: "POST", credentials: "include" });
 expect(signout.cookie).not.toBe("");
 expect(s.calls.filter(c => c.url.endsWith("/v1/auth/refresh")).length).toBe(1);
 expect(account.current).toBeNull();
 expect(await account.check()).toBeNull();
 await expect(account.accessToken()).rejects.toBeInstanceOf(SignedOutError);
});

test("each provider's button shows only once the service lists its web_sign_in_* flag", async () => {
 const health = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;
 expect(await webSignInProviders(health({ ok: true, version: "0.4.0" }))).toEqual([]);
 expect(await webSignInProviders(health({ ok: true, features: ["native_sign_in", "web_sign_in_google"] }))).toEqual(["google"]);
 expect(await webSignInProviders(health({ ok: true, features: ["web_sign_in_google", "web_sign_in_apple"] }))).toEqual(["apple", "google"]);
});

// herdrup #770-f3: unreachable is not "no sign-in", or a failed health check hides the panel.
test("a health check that fails rejects instead of listing no providers", async () => {
 const health = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;
 await expect(webSignInProviders(health({}, 503))).rejects.toThrow();
 await expect(webSignInProviders((async () => { throw new TypeError("offline"); }) as unknown as typeof fetch)).rejects.toThrow("offline");
 await expect(webSignInProviders((async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch)).rejects.toThrow();
});

/** No device key, no stored sync, no background sync: the sign-in methods alone. */
const quiet = { key: async () => null, name: "", storage: () => ({ getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 }), locks: null, background: false };

test("the web Desk's providers: a failed check rejects and the next one asks again; other origins get none", async () => {
 let down = true, asked = 0;
 const fetcher = (async () => { asked++; return down ? new Response("", { status: 503 }) : Response.json({ features: ["web_sign_in_apple"] }); }) as unknown as typeof fetch;
 const page = (origin: string) => ({ origin, href: `${origin}/web/`, fetch: fetcher, navigate() {}, replaceURL() {} });
 const { desk } = createAccountDesk(page("https://guest.herdrup.app"), quiet);
 await expect(desk.accountProviders()).rejects.toThrow();
 down = false;
 expect(await desk.accountProviders()).toEqual(["apple"]);
 const before = asked;
 expect(await createAccountDesk(page("https://guest.herdrup.themartian.app"), quiet).desk.accountProviders()).toEqual([]);
 expect(asked).toBe(before);
});

/** navigator.locks for tests: one holder per name, queued. */
function locks(): Locks {
 const tails = new Map<string, Promise<unknown>>();
 return {
  request<T>(name: string, ...args: [() => Promise<T>] | [{ signal?: AbortSignal }, () => Promise<T>]): Promise<T> {
   const run = args.length === 1 ? args[0] : args[1];
   const before = tails.get(name) ?? Promise.resolve();
   const result = before.then(run, run);
   tails.set(name, result.catch(() => undefined));
   return result;
  },
 };
}

test("two tabs sharing the cookie take turns refreshing, so neither presents a spent cookie", async () => {
 const s = service(), shared = locks();
 const tabA = new WebAccount(s.fetcher, undefined, Date.now, shared), tabB = new WebAccount(s.fetcher, undefined, Date.now, shared);
 const [a, b] = await Promise.all([tabA.check(), tabB.check()]);
 expect(a?.accountID).toBe("acct-1");
 expect(b?.accountID).toBe("acct-1");
 const sent = s.calls.filter(c => c.url.endsWith("/v1/auth/refresh")).map(c => c.cookie);
 expect(sent).toEqual(["c0", "c1"]);
});

test("a refresh that answers after sign-out does not bring the session back", async () => {
 let release!: () => void;
 const gate = new Promise<void>(r => { release = r; });
 const s = service();
 const slow = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).endsWith("/v1/auth/refresh")) await gate;
  return s.fetcher(input, init);
 }) as typeof fetch;
 const account = new WebAccount(slow, undefined, Date.now, locks());
 const pending = account.accessToken();
 await new Promise(r => setTimeout(r, 0)); // the refresh is on the wire
 const signedOut = account.signOut();
 release();
 await expect(pending).rejects.toBeInstanceOf(SignedOutError);
 await signedOut;
 expect(account.current).toBeNull();
 // Sign-out waited for the refresh, so it sent the rotated cookie.
 expect(s.calls.find(c => c.url.endsWith("/v1/auth/signout"))!.cookie).toBe("c1");
});

test("a refresh queued behind the lock when sign-out starts does not sign back in", async () => {
 const s = service(), shared = locks();
 let release!: () => void;
 const held = shared.request("herdrup-account-refresh", () => new Promise<void>(r => { release = r; })); // another tab
 await new Promise(r => setTimeout(r, 0)); // the other tab holds the lock
 const account = new WebAccount(s.fetcher, undefined, Date.now, shared);
 const pending = account.accessToken(); // queued behind the other tab
 const signedOut = account.signOut();   // queued behind the refresh
 release(); await held;
 await expect(pending).rejects.toBeInstanceOf(SignedOutError);
 await signedOut;
 expect(account.current).toBeNull();
});

test("account calls carry the access token; one the service refuses is refreshed and sent once more, not forever", async () => {
 const seen: string[] = [];
 const s = service((url, _init, bearer) => {
  if (!url.endsWith("/v1/browsers/self")) return null;
  seen.push(bearer);
  return bearer === access(2) ? Response.json({ envelopes: [] }) : Response.json({ error: "unauthorized" }, { status: 401 });
 });
 const account = new WebAccount(s.fetcher);
 expect(await account.browserSelf()).toEqual({ envelopes: [] });
 expect(seen).toEqual([access(1), access(2)]);
 let sends = 0;
 const stuck = new WebAccount(service((url) => { if (!url.endsWith("/v1/browsers/self")) return null; sends++; return Response.json({ error: "unauthorized" }, { status: 401 }); }).fetcher);
 const error = await stuck.browserSelf().catch(e => e);
 expect(error).toBeInstanceOf(AccountServiceError);
 expect(error.status).toBe(401);
 expect(sends).toBe(2);
});

test("enrolment proves the browser's key for this account's challenge and adds it as a web device; another account's challenge is refused", async () => {
 const secret = new Uint8Array(32).fill(5);
 const key = staticKey({ v: 1, kind: "raw", secret, publicKey: x25519.getPublicKey(secret) });
 const serverPub = toB64url(x25519.getPublicKey(new Uint8Array(32).fill(9)));
 let challengeAccount = "acct-1";
 const posted: Record<string, string>[] = [];
 const s = service(async (url, init) => {
  if (url.endsWith("/v1/devices/challenge")) return Response.json({ challenge_id: "chal-1", server_pub: serverPub, salt: toB64url(new Uint8Array(32).fill(3)), account_id: challengeAccount, expires_in: 60 });
  if (url.endsWith("/v1/devices")) { posted.push(JSON.parse(String(init.body))); return Response.json({ device: { id: "dev-1", name: "Chrome on macOS", platform: "web", device_pub: toB64url(key.publicKey), created_ms: 1 } }); }
  return null;
 });
 const account = new WebAccount(s.fetcher);
 await account.accessToken();
 expect((await account.enrol(key, "Chrome on macOS")).id).toBe("dev-1");
 const proof = await enrolProof(key, { challenge_id: "chal-1", server_pub: serverPub, salt: toB64url(new Uint8Array(32).fill(3)), account_id: "acct-1" });
 expect(posted).toEqual([{ challenge_id: "chal-1", device_pub: proof.devicePub, mac: proof.mac, name: "Chrome on macOS", platform: "web" }]);
 expect(fromB64url(posted[0]!.device_pub)).toEqual(key.publicKey);
 challengeAccount = "acct-2";
 await expect(account.enrol(key, "Chrome on macOS")).rejects.toMatchObject({ code: "account_changed" });
 expect(posted.length).toBe(1);
});

test("a call refused with 401 is not sent again once the refreshed session is another account's", async () => {
 const posted: string[] = [];
 const s = service((url, _init, bearer) => {
  if (!url.endsWith("/v1/approvals")) return null;
  posted.push(bearer);
  return Response.json({ error: "unauthorized" }, { status: 401 });
 }, n => n === 1 ? "acct-A" : "acct-B");
 const account = new WebAccount(s.fetcher);
 await expect(account.requestApproval(new Uint8Array(32))).rejects.toMatchObject({ code: "account_changed" });
 expect(posted).toEqual([access(1)]);
 // Bound up front: another account's session sends nothing.
 await expect(account.requestApproval(new Uint8Array(32), "acct-A")).rejects.toMatchObject({ code: "account_changed" });
 expect(posted).toEqual([access(1)]);
});

test("after the page's token expires and the cookie now holds another sign-in, no write goes out as that account", async () => {
 const secret = new Uint8Array(32).fill(5);
 const key = staticKey({ v: 1, kind: "raw", secret, publicKey: x25519.getPublicKey(secret) });
 for (const write of [(a: WebAccount) => a.requestApproval(new Uint8Array(32)), (a: WebAccount) => a.enrol(key, "Chrome on macOS")]) {
  let now = 1_000_000;
  const sent: string[] = [];
  const s = service((url, _init, bearer) => { if (url.endsWith("/v1/approvals") || url.includes("/v1/devices")) sent.push(`${url.slice(url.indexOf("/v1/"))} ${bearer}`); return Response.json({}); },
   n => n === 1 ? "acct-A" : "acct-B");
  const account = new WebAccount(s.fetcher, undefined, () => now);
  await account.accessToken(); // signed in as acct-A
  now += 3_600_000; // A's bearer expired; the cookie now refreshes to acct-B
  await expect(write(account)).rejects.toMatchObject({ code: "account_changed" });
  expect(sent).toEqual([]);
 }
});

test("an aborted call sends nothing more: not enrolment's second step, not the retry after a 401", async () => {
 const secret = new Uint8Array(32).fill(5);
 const key = staticKey({ v: 1, kind: "raw", secret, publicKey: x25519.getPublicKey(secret) });
 let stop = new AbortController();
 const sent: string[] = [];
 const s = service((url) => {
  const path = url.slice(url.indexOf("/v1/"));
  sent.push(path);
  // The caller leaves while the service answers.
  stop.abort(new Error("left"));
  if (path === "/v1/devices/challenge") return Response.json({ challenge_id: "c", server_pub: toB64url(x25519.getPublicKey(new Uint8Array(32).fill(9))), salt: toB64url(new Uint8Array(32).fill(3)), account_id: "acct-1" });
  if (path === "/v1/approvals") return Response.json({ error: "unauthorized" }, { status: 401 });
  return null;
 });
 const account = new WebAccount(s.fetcher);
 await expect(account.enrol(key, "x", undefined, stop.signal)).rejects.toThrow("left");
 expect(sent).toEqual(["/v1/devices/challenge"]);
 stop = new AbortController();
 sent.length = 0;
 await expect(account.requestApproval(new Uint8Array(32), undefined, stop.signal)).rejects.toThrow("left");
 expect(sent).toEqual(["/v1/approvals"]);
});

test("the page hears its session change when it happens: sign-out before its request completes, another account at its refresh, with no old hint", async () => {
 let now = 1_000_000;
 const signOutHeld = Promise.withResolvers<void>();
 const base = service(undefined, n => n === 1 ? "acct-A" : "acct-B");
 const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).endsWith("/v1/auth/signout")) await signOutHeld.promise;
  return base.fetcher(input, init);
 }) as typeof fetch;
 const account = new WebAccount(fetcher, undefined, () => now);
 const seen: (string | null)[] = [];
 account.onSessionChange(() => seen.push(account.current ? `${account.current.accountID}:${account.current.displayHint ?? ""}` : null));
 await account.accessToken();
 now += 3_600_000; // the cookie now refreshes to acct-B, which sends no display hint
 await account.accessToken();
 expect(seen).toEqual(["acct-A:jerry@example.com", "acct-B:"]);
 const out = account.signOut();
 expect(seen.at(-1)).toBeNull(); // told before the sign-out request completes
 signOutHeld.resolve();
 await out;
});

test("the web Desk publishes accountChanged the moment the session ends, and again how the sign-out went", async () => {
 const signOutHeld = Promise.withResolvers<void>();
 const s = service();
 const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).endsWith("/v1/auth/signout")) await signOutHeld.promise;
  return s.fetcher(input, init);
 }) as typeof fetch;
 const page = { origin: "https://guest.herdrup.app", href: "https://guest.herdrup.app/web/", fetch: fetcher, navigate() {}, replaceURL() {} };
 const { desk } = createAccountDesk(page, quiet);
 await desk.accountCheck();
 const { events } = await import("../src/web/events");
 const heard: boolean[] = [];
 const off = events.accountChanged.on(st => heard.push(st.signedIn));
 const out = desk.accountSignOut();
 expect(heard).toEqual([false]);
 signOutHeld.resolve();
 await out;
 // The sign-out went through: still signed out, now that it is over.
 expect(heard).toEqual([false, false]);
 off();
});

test("the session generation changes when the session ends and when a refresh brings another account", async () => {
 let now = 1_000_000;
 const s = service(undefined, n => n === 2 ? "acct-B" : "acct-A");
 const account = new WebAccount(s.fetcher, undefined, () => now);
 await account.accessToken();
 const a = account.generation;
 now += 3_600_000; await account.accessToken(); // B
 const b = account.generation;
 now += 3_600_000; await account.accessToken(); // A again
 const a2 = account.generation;
 expect(new Set([a, b, a2]).size).toBe(3);
 await account.signOut();
 expect(account.generation).not.toBe(a2);
});

test("a call already cancelled starts nothing, not even a refresh; one cancelled behind the refresh lock stops waiting", async () => {
 const secret = new Uint8Array(32).fill(5);
 const key = staticKey({ v: 1, kind: "raw", secret, publicKey: x25519.getPublicKey(secret) });
 const s = service();
 const gone = new AbortController(); gone.abort(new Error("left"));
 await expect(new WebAccount(s.fetcher).enrol(key, "x", undefined, gone.signal)).rejects.toThrow("left");
 expect(s.calls).toEqual([]);
 // Another tab holds the refresh lock: the cancelled caller doesn't wait for it.
 const held = Promise.withResolvers<void>();
 const locks = { request: async <T>(_n: string, run: () => Promise<T>) => { await held.promise; return run(); } };
 const queued = new AbortController();
 const pending = new WebAccount(s.fetcher, undefined, Date.now, locks).requestApproval(new Uint8Array(32), undefined, queued.signal);
 queued.abort(new Error("closed"));
 await expect(pending).rejects.toThrow("closed");
 held.resolve();
});

test("an abort while an error body is read is reported as the abort, not as the service's answer", async () => {
 const reading = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
 const stop = new AbortController();
 // The error response says when its body read starts, and finishes only after the abort.
 const blocked = { ok: false, status: 403, json: async () => { reading.resolve(); await gate.promise; return { error: "device_required" }; } } as unknown as Response;
 const s = service(url => url.endsWith("/v1/browsers/self") ? blocked : null);
 const pending = new WebAccount(s.fetcher).browserSelf(undefined, stop.signal);
 await reading.promise;
 stop.abort(new Error("left"));
 gate.resolve();
 await expect(pending).rejects.toThrow("left");
});

test("a refresh nobody waits for any more isn't sent, and a caller cancelled at sign-out starts none", async () => {
 const s = service();
 const refreshes = () => s.calls.filter(c => c.url.endsWith("/v1/auth/refresh")).length;
 // Queued behind another tab's lock, then abandoned: when the lock comes, nothing is sent.
 const held = Promise.withResolvers<void>();
 const locks = { request: async <T>(_n: string, run: () => Promise<T>) => { await held.promise; return run(); } };
 const queued = new AbortController();
 const pending = new WebAccount(s.fetcher, undefined, Date.now, locks).requestApproval(new Uint8Array(32), undefined, queued.signal);
 queued.abort(new Error("closed"));
 await expect(pending).rejects.toThrow("closed");
 held.resolve();
 await held.promise; await Promise.resolve(); await Promise.resolve();
 expect(refreshes()).toBe(0);
 // A warm token: the call is cancelled and the page signs out before it resumes; it doesn't
 // go round again for a new token.
 const account = new WebAccount(s.fetcher);
 await account.accessToken();
 const before = refreshes();
 const stop = new AbortController();
 const call = account.browserSelf(undefined, stop.signal);
 stop.abort(new Error("left"));
 void account.signOut();
 await expect(call).rejects.toThrow("left");
 expect(refreshes()).toBe(before);
});

/** A refresh lock another tab holds until release(), which starts the queued turns at once
 *  (as the browser may, right after an abort); turns settle as each one does. */
function heldLock() {
 const asked = Promise.withResolvers<void>();
 const queued: (() => void)[] = [];
 const turns: Promise<void>[] = [];
 let free = false;
 let afterRun: (() => void) | null = null;
 const locks = { request: <T>(_n: string, run: () => Promise<T>) => {
  asked.resolve();
  const turn = Promise.withResolvers<T>();
  const start = () => { const p = run(); const after = afterRun; afterRun = null; after?.(); p.then(turn.resolve, turn.reject); };
  if (free) start(); else queued.push(start);
  turns.push(turn.promise.then(() => {}, () => {}));
  return turn.promise;
 } };
 return { locks, turns, asked: asked.promise,
  release: () => { free = true; for (const start of queued.splice(0)) start(); },
  then: (f: () => void) => { afterRun = f; } };
}

test("a caller aborted just before the lock comes isn't counted: no refresh is sent for it", async () => {
 const s = service();
 const lock = heldLock();
 const stop = new AbortController();
 const pending = new WebAccount(s.fetcher, undefined, Date.now, lock.locks).accessToken(stop.signal);
 // The abort and the lock's turn come back to back, before the caller's wait has unwound.
 stop.abort(new Error("left"));
 lock.release();
 await expect(pending).rejects.toThrow("left");
 await Promise.all(lock.turns);
 expect(s.calls.filter(c => c.url.endsWith("/v1/auth/refresh")).length).toBe(0);
});

test("a caller that comes as an abandoned refresh is skipped gets its own refresh, not the skip", async () => {
 const s = service();
 const lock = heldLock();
 const account = new WebAccount(s.fetcher, undefined, Date.now, lock.locks);
 const stop = new AbortController();
 const abandoned = account.accessToken(stop.signal);
 stop.abort(new Error("left"));
 await expect(abandoned).rejects.toThrow("left");
 let late: Promise<string> | null = null;
 // Right after the lock's turn decided to skip, before that turn has settled.
 lock.then(() => { late = account.accessToken(); });
 lock.release();
 await Promise.all(lock.turns.slice(0, 1));
 expect(late).not.toBeNull();
 expect(await late!).toMatch(/./);
 expect(s.calls.filter(c => c.url.endsWith("/v1/auth/refresh")).length).toBe(1);
});

test("an approval stopped while its account lookup waits for the lock sends no refresh", async () => {
 const s = service();
 const lock = heldLock();
 const account = new WebAccount(s.fetcher, undefined, Date.now, lock.locks);
 const stop = new AbortController();
 const running = runApproval({ account, identities: new MemoryIdentityStore(), store: new MemoryOwnerStore(), deviceName: "x", sleep: async () => {}, now: () => 0, locks: null }, () => {}, stop.signal);
 await lock.asked; // the key is made first, then the account lookup queues for the lock
 stop.abort(new Error("left"));
 lock.release();
 await running;
 await Promise.all(lock.turns);
 expect(s.calls.filter(c => c.url.endsWith("/v1/auth/refresh")).length).toBe(0);
});

test("a statement lookup cancelled while its account lookup waits for the lock sends no refresh", async () => {
 const s = service();
 const lock = heldLock();
 const cache = statementCache(new WebAccount(s.fetcher, undefined, Date.now, lock.locks));
 const stop = new AbortController();
 const pending = cache.get("H", 120_000, stop.signal);
 await lock.asked;
 stop.abort(new Error("left"));
 lock.release();
 await expect(pending).rejects.toThrow("left");
 await Promise.all(lock.turns);
 expect(s.calls.length).toBe(0);
});

test("a statement lookup aborted as an already signed-in account answers reads and asks nothing", async () => {
 const s = service(url => url.endsWith("/v1/statements") ? Response.json({ statements: [{ host: "H", jws: "jws-1" }], exp: Math.floor(Date.now() / 1000) + 600 }) : null);
 const account = new WebAccount(s.fetcher);
 await account.accessToken();
 const cache = statementCache(account);
 const posts = () => s.calls.filter(c => c.url.endsWith("/v1/statements")).length;
 // Cold cache: aborted right after the call, before the lookup's continuation runs.
 const cold = new AbortController();
 const first = cache.get("H", 120_000, cold.signal);
 cold.abort(new Error("left"));
 await expect(first).rejects.toThrow("left");
 expect(posts()).toBe(0);
 // Warm cache: a held statement isn't handed to a caller that has gone.
 await cache.get("H", 120_000, new AbortController().signal);
 const warm = new AbortController();
 const second = cache.get("H", 120_000, warm.signal);
 warm.abort(new Error("left"));
 await expect(second).rejects.toThrow("left");
 expect(posts()).toBe(1);
});

test("a refresh queued for the lock before a sign-out isn't sent once the lock comes; its caller is signed out", async () => {
 const s = service();
 const lock = heldLock();
 const account = new WebAccount(s.fetcher, undefined, Date.now, lock.locks);
 const queued = account.accessToken();
 await lock.asked;
 const out = account.signOut();
 lock.release();
 await expect(queued).rejects.toBeInstanceOf(SignedOutError);
 await out;
 await Promise.all(lock.turns);
 expect(s.calls.map(c => c.url.split("/v1/")[1])).toEqual(["auth/signout"]);
});

test("a caller that comes while the refresh is being started joins it and gets the real token", async () => {
 const s = service();
 let account: WebAccount;
 let nested: Promise<string> | null = null;
 // The fetch is started synchronously (no lock): a call made from inside it joins the new refresh.
 const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
  if (nested === null && String(input).endsWith("/v1/auth/refresh")) nested = account.accessToken();
  return s.fetcher(input, init);
 }) as typeof fetch;
 account = new WebAccount(fetcher);
 const outer = await account.accessToken();
 expect(outer).toMatch(/./);
 expect(await nested!).toBe(outer);
 expect(s.calls.filter(c => c.url.endsWith("/v1/auth/refresh")).length).toBe(1);
});

test("a lock that throws while asked fails that refresh; the next caller asks again and isn't left waiting", async () => {
 const s = service();
 let asks = 0;
 const locks = { request: <T>(_n: string, run: () => Promise<T>): Promise<T> => {
  if (++asks === 1) throw new Error("lock broke");
  return run();
 } };
 const account = new WebAccount(s.fetcher, undefined, Date.now, locks);
 await expect(account.accessToken()).rejects.toThrow("lock broke");
 expect(await account.accessToken()).toMatch(/./);
 expect(asks).toBe(2);
});

test("an owner page leaves only once its sign-out was sent and taken; a refused one answers at once and Sign out works again from the cookie alone", async () => {
 const held = Promise.withResolvers<void>();
 let refuse = true, sent = 0, refreshDown = false, readBacks = 0;
 const s = service();
 const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/v1/auth/signout")) {
   sent++;
   await held.promise;
   if (refuse) return Response.json({ error: "unavailable" }, { status: 503 });
  }
  if (url.endsWith("/v1/auth/refresh") && refreshDown) { readBacks++; return Response.json({ error: "unavailable" }, { status: 503 }); }
  return s.fetcher(input, init);
 }) as typeof fetch;
 const { desk, account } = createAccountDesk({ origin: "https://guest.herdrup.app", href: "https://guest.herdrup.app/web/", fetch: fetcher, navigate() {}, replaceURL() {} }, quiet);
 await desk.accountCheck();
 const calls: string[] = [];
 followSession(account, { end: () => calls.push("end"), startOver: () => calls.push(`startOver after ${sent}`), restored: () => calls.push("restored") });
 // The session can't be read back after the refusal: the service refuses it (503).
 refreshDown = true;
 const { events } = await import("../src/web/events");
 const heard: string[] = [];
 const off = events.accountChanged.on(s => heard.push(`${s.signedIn} ${s.problem?.startsWith("Couldn't sign out.") ?? false}`));
 const out = desk.accountSignOut();
 // The owner link ends at once; the page waits for the request.
 expect(calls).toEqual(["end"]);
 held.resolve();
 const refused = await out;
 expect([refused.signedIn, refused.displayHint, refused.problem?.startsWith("Couldn't sign out.")]).toEqual([true, "jerry@example.com", true]);
 expect(calls).toEqual(["end"]);
 // Every view (not just the panel that asked) shows it signed in, with why and the retry.
 expect(heard.at(-1)).toBe("true true");
 off();
 // The read-back was refused: no session is known here.
 await account.signOutSettled();
 await desk.accountCheck();
 expect([readBacks > 0, account.current]).toEqual([true, null]);
 // Sign out again: sent from the cookie alone, and then the page leaves.
 refuse = false;
 expect((await desk.accountSignOut()).signedIn).toBe(false);
 expect([calls, account.signOutAttempt]).toEqual([["end", "end", "startOver after 2"], null]);
});

test("a sign-out retry goes out while the read-back still hasn't answered: an operation holding the lock lets it go after its bound", async () => {
 let stall = false, refuse = true;
 const posts: string[] = [];
 const s = service();
 const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/v1/auth/signout")) { posts.push(refuse ? "503" : "204"); if (refuse) return Response.json({ error: "unavailable" }, { status: 503 }); }
  if (url.endsWith("/v1/auth/refresh") && stall) return new Promise<Response>(() => {});
  return s.fetcher(input, init);
 }) as typeof fetch;
 // A real 50 ms bound: AbortSignal.timeout runs on the platform clock.
 const account = new WebAccount(fetcher, undefined, Date.now, locks(), 50);
 await account.check();
 await account.signOut().catch(() => {});
 // The read-back takes the lock and never answers.
 stall = true;
 let readBack = "pending";
 void account.check().then(() => { readBack = "answered"; }, error => { readBack = error.name; });
 await new Promise(r => setTimeout(r, 0)); // the read-back holds the lock
 refuse = false;
 await account.signOut();
 expect(posts).toEqual(["503", "204"]);
 expect([readBack, account.signOutAttempt]).toEqual(["TimeoutError", null]);
});

test("after a refused sign-out whose read-back fails too, every read says signed in with why and Sign out, until the service says there is no session", async () => {
 let refresh: "ok" | "503" | "401" = "ok";
 const s = service();
 const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/v1/auth/signout")) return Response.json({ error: "unavailable" }, { status: 503 });
  if (url.endsWith("/v1/auth/refresh") && refresh === "503") return Response.json({ error: "unavailable" }, { status: 503 });
  if (url.endsWith("/v1/auth/refresh") && refresh === "401") return Response.json({ error: "no_session" }, { status: 401 });
  return s.fetcher(input, init);
 }) as typeof fetch;
 const { desk, account } = createAccountDesk({ origin: "https://guest.herdrup.app", href: "https://guest.herdrup.app/web/", fetch: fetcher, navigate() {}, replaceURL() {} }, quiet);
 await desk.accountCheck();
 const changes: string[] = [];
 account.onSessionChange(change => changes.push(change));
 const calls: string[] = [];
 followSession(account, { end: () => calls.push("end"), startOver: () => calls.push("startOver"), restored: () => calls.push("restored") });
 refresh = "503";
 const said = (st: AccountState) => [st.signedIn, st.displayHint, st.problem];
 const refused = [true, "jerry@example.com", "Couldn't sign out. The account service is unavailable. Try again later."];
 expect(said(await desk.accountSignOut())).toEqual(refused);
 // Reading again (the Settings page reopened) keeps the refusal and its retry.
 expect(said(await desk.accountState())).toEqual(refused);
 expect(said(await desk.accountCheck())).toEqual(refused);
 // The service says there is no session: the attempt is over, signed out.
 refresh = "401";
 expect(said(await desk.accountCheck())).toEqual([false, undefined, undefined]);
 expect([account.signOutAttempt, changes]).toEqual([null, ["sign-out-sending", "sign-out-refused", "no-session"]]);
 // ... and the owner page, ended at the sign-out's start, starts over then.
 expect(calls).toEqual(["end", "startOver"]);
});

test("nothing leaves the page while a sign-out is being sent; the page's one exit takes the latest choice, and only its mark is written", async () => {
 const held = Promise.withResolvers<void>();
 const s = service();
 let posts = 0;
 const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).endsWith("/v1/auth/signout")) { posts++; await held.promise; return Response.json({ error: "unavailable" }, { status: 503 }); }
  return s.fetcher(input, init);
 }) as typeof fetch;
 const exits: string[] = [];
 const { desk, exit } = createAccountDesk({ origin: "https://guest.herdrup.app", href: "https://guest.herdrup.app/web/", fetch: fetcher, navigate: url => exits.push(`navigate ${new URL(url).pathname}`), replaceURL() {} }, quiet);
 await desk.accountCheck();
 const out = desk.accountSignOut();
 // Another view's Sign out while the request is out: the same attempt, no second request.
 const again = desk.accountSignOut();
 // The guest page chosen, then a provider's sign-in: the sign-in, the later choice, is the way out.
 exit.leave(() => { exits.push("guest mark", "reload"); }, true);
 const signingIn = desk.accountSignIn("apple"); // settles once the page has left (after the sign-out)
 await new Promise(r => setTimeout(r, 0)); // every step the sign-out's answer doesn't hold
 expect(exits).toEqual([]);
 held.resolve();
 await Promise.all([out, again, signingIn]);
 await new Promise(r => setTimeout(r, 0));
 expect([exits, posts]).toEqual([["navigate /v1/auth/web/start"], 1]);
});

test("a sign-in whose navigation the browser blocks rejects with that error, for the page's error handler", async () => {
 const s = service();
 const blocked = new DOMException("navigation blocked", "SecurityError");
 const { desk } = createAccountDesk({ origin: "https://guest.herdrup.app", href: "https://guest.herdrup.app/web/", fetch: s.fetcher, navigate: () => { throw blocked; }, replaceURL() {} }, quiet);
 await desk.accountCheck();
 expect(await desk.accountSignIn("google").then(() => "left", (error: unknown) => error)).toBe(blocked);
});

test("a retry with no session known signs out the account the refused attempt was for: another account read back after it starts over", async () => {
 const s = service(undefined, n => n >= 2 ? "acct-B" : "acct-A");
 const fetcher = (async (input: string | URL | Request, init?: RequestInit) =>
  String(input).endsWith("/v1/auth/signout") ? Response.json({ error: "unavailable" }, { status: 503 }) : s.fetcher(input, init)) as typeof fetch;
 const account = new WebAccount(fetcher, undefined, Date.now, null);
 await account.check();
 const calls: string[] = [];
 followSession(account, { end: () => calls.push("end"), startOver: () => calls.push("startOver"), restored: () => calls.push("restored") });
 await account.signOut().catch(() => {});
 await account.signOut().catch(() => {});
 expect(account.signOutAttempt?.account).toBe("acct-A");
 await account.check();
 expect([account.current?.accountID, calls, account.signOutAttempt]).toEqual(["acct-B", ["end", "end", "end", "startOver"], null]);
});

test("after a refused sign-out the same account read back goes on (restored); another account later starts the page over, with nothing of the refusal", async () => {
 const s = service(undefined, n => n >= 3 ? "acct-B" : "acct-A");
 // Tokens that are due at once: every read is a refresh, the third one Beta's.
 const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/v1/auth/signout")) return Response.json({ error: "unavailable" }, { status: 503 });
  const response = await s.fetcher(input, init);
  return url.endsWith("/v1/auth/refresh") && response.ok ? Response.json({ ...await response.json() as object, access_expires_in: 60 }) : response;
 }) as typeof fetch;
 const { desk, account } = createAccountDesk({ origin: "https://guest.herdrup.app", href: "https://guest.herdrup.app/web/", fetch: fetcher, navigate() {}, replaceURL() {} }, quiet);
 await account.check();
 const calls: string[] = [];
 followSession(account, { end: () => calls.push("end"), startOver: () => calls.push("startOver"), restored: () => calls.push("restored") });
 const { events } = await import("../src/web/events");
 const heard: string[] = [];
 const off = events.accountChanged.on(st => heard.push(`${st.displayHint ?? "-"} ${st.problem ?? "-"}`));
 await account.signOut().catch(() => {});
 // Tried again before the session was read back (none known here): still that account's sign-out.
 await account.signOut().catch(() => {});
 expect(calls).toEqual(["end", "end"]);
 await account.check();
 // Alpha's own read back: still the refusal (signed in, with why and Sign out), with its hint.
 expect([account.current?.accountID, calls, account.signOutAttempt?.phase, heard.at(-1)]).toEqual(["acct-A", ["end", "end", "restored"], "refused", "jerry@example.com Couldn't sign out. The account service is unavailable. Try again later."]);
 await account.check();
 expect([account.current?.accountID, calls, account.signOutAttempt]).toEqual(["acct-B", ["end", "end", "restored", "end", "startOver"], null]);
 // Beta's session is told without Alpha's refusal, by the event and by a read.
 expect(heard.at(-1)).toBe("- -");
 const read = await desk.accountCheck();
 expect([read.signedIn, read.problem]).toEqual([true, undefined]);
 off();
});

test("without Web Locks a page's refresh still waits for its sign-out: one asked while it is sent reads back after the refusal (restored), not as a new session", async () => {
 const held = Promise.withResolvers<void>();
 const order: string[] = [];
 const s = service();
 const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/v1/auth/signout")) { order.push("signout sent"); await held.promise; order.push("signout 503"); return Response.json({ error: "unavailable" }, { status: 503 }); }
  if (url.endsWith("/v1/auth/refresh")) order.push("refresh sent");
  return s.fetcher(input, init);
 }) as typeof fetch;
 const account = new WebAccount(fetcher, undefined, Date.now, null);
 await account.check();
 const calls: string[] = [];
 followSession(account, { end: () => calls.push("end"), startOver: () => calls.push("startOver"), restored: () => calls.push("restored") });
 const out = account.signOut().catch(() => {});
 const read = account.accessToken();
 await new Promise(r => setTimeout(r, 0)); // everything the sign-out's answer doesn't hold
 expect(order).toEqual(["refresh sent", "signout sent"]);
 held.resolve();
 await out; await read;
 expect(order).toEqual(["refresh sent", "signout sent", "signout 503", "refresh sent"]);
 expect([calls, account.signOutAttempt?.phase]).toEqual([["end", "restored"], "refused"]);
});

test("an owner page's work stops at a sign-out's start and nothing new starts until its account is restored; the record of what ran is written once", () => {
 const work = new OwnerWork<string>();
 const first = work.signal!;
 work.end(() => ({ approval: false, listRefresh: true, probes: true, link: "alpha" }));
 expect([first.aborted, work.signal]).toEqual([true, null]);
 // A second refusal's sign-out, with nothing running: what the first stopped stays.
 work.end(() => ({ approval: false, listRefresh: false, probes: false, link: null }));
 expect(work.resume()).toEqual({ approval: false, listRefresh: true, probes: true, link: "alpha" });
 const next = work.signal!;
 expect([next.aborted, next === first]).toEqual([false, false]);
 // Restored again while it runs: nothing to start, the same session.
 expect([work.resume(), work.signal]).toEqual([null, next]);
});

test("an approval runs while it asks, waits or shows its code; one that ended stays as it ended", () => {
 const kinds: [OwnerPhase["kind"], boolean][] = [["starting", true], ["waiting", true], ["code", true],
  ["approved", false], ["denied", false], ["expired", false], ["failed", false], ["elsewhere", false], ["unsupported", false]];
 expect(kinds.map(([kind]) => [kind, approvalRunning(kind)])).toEqual(kinds);
});

test("a page has one way out: the person's choice takes the place of the default reload, never a second one", async () => {
 const held = Promise.withResolvers<void>();
 let sending = true;
 const account = { signOutSettled: async () => { if (sending) await held.promise; }, signOutAttempt: null };
 const exits: string[] = [];
 const page = new PageExit(account);
 page.leave(() => { exits.push("reload"); });
 page.leave(() => { exits.push("guest"); }, true);
 // The default after a choice doesn't replace it.
 page.leave(() => { exits.push("reload again"); });
 sending = false;
 held.resolve();
 await new Promise(r => setTimeout(r, 0));
 expect(exits).toEqual(["guest"]);
 // Once left, the page doesn't leave again.
 page.leave(() => { exits.push("late"); }, true);
 await new Promise(r => setTimeout(r, 0));
 expect(exits).toEqual(["guest"]);
});

test("an exit that finds it can't leave lets a later one go", async () => {
 const exits: string[] = [];
 const page = new PageExit({ signOutSettled: async () => {}, signOutAttempt: null });
 page.leave(() => { exits.push("stayed"); return "stayed"; });
 await new Promise(r => setTimeout(r, 0));
 page.leave(() => { exits.push("sign-in"); }, true);
 await new Promise(r => setTimeout(r, 0));
 expect(exits).toEqual(["stayed", "sign-in"]);
});

test("an exit that leaves again from inside itself queues nothing: the page leaves once", async () => {
 const exits: string[] = [];
 const page = new PageExit({ signOutSettled: async () => {}, signOutAttempt: null });
 page.leave(() => { exits.push("first"); page.leave(() => { exits.push("second"); }, true); });
 await new Promise(r => setTimeout(r, 0));
 expect(exits).toEqual(["first"]);
});

test("an exit that fails lets a later one go, and its error isn't hidden", async () => {
 const exits: string[] = [];
 const page = new PageExit({ signOutSettled: async () => {}, signOutAttempt: null });
 const failed = page.leave(() => { exits.push("failed"); throw new DOMException("navigation blocked", "SecurityError"); });
 expect(await failed.then(() => "ran", (e: Error) => e.name)).toBe("SecurityError");
 await page.leave(() => { exits.push("next"); }, true);
 expect(exits).toEqual(["failed", "next"]);
});

test("a page leaving and a sign-out started in the same turn: the sign-out is sent, and the page leaves once it settled", async () => {
 const held = Promise.withResolvers<void>();
 const order: string[] = [];
 const s = service();
 const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).endsWith("/v1/auth/signout")) { order.push("signout sent"); await held.promise; order.push("signout answered"); }
  return s.fetcher(input, init);
 }) as typeof fetch;
 const account = new WebAccount(fetcher, undefined, Date.now, null);
 await account.check();
 const page = new PageExit(account);
 page.leave(() => { order.push("left"); });
 const out = account.signOut();
 await new Promise(r => setTimeout(r, 0));
 expect(order).toEqual(["signout sent"]);
 held.resolve();
 await out;
 await new Promise(r => setTimeout(r, 0));
 expect(order).toEqual(["signout sent", "signout answered", "left"]);
});

test("a view that reads the account as soon as it hears the sign-out start reads after the request: a taken sign-out ends signed out", async () => {
 const order: string[] = [];
 const s = service();
 const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  order.push(new URL(String(input)).pathname);
  return s.fetcher(input, init);
 }) as typeof fetch;
 const { desk } = createAccountDesk({ origin: "https://guest.herdrup.app", href: "https://guest.herdrup.app/web/", fetch: fetcher, navigate() {}, replaceURL() {} }, quiet);
 await desk.accountCheck();
 const { events } = await import("../src/web/events");
 const reads: Promise<AccountState>[] = [];
 const off = events.accountChanged.on(() => { if (reads.length === 0) reads.push(desk.accountCheck()); });
 const out = await desk.accountSignOut();
 off();
 const read = await reads[0]!;
 expect([order, out.signedIn, read.signedIn]).toEqual([["/v1/auth/refresh", "/v1/auth/signout", "/v1/auth/refresh"], false, false]);
});

test("an owner page loaded before its session is known (the last load found it signed in) goes on when it comes; another account later starts over", async () => {
 const s = service(undefined, n => n >= 2 ? "acct-B" : "acct-A");
 // Tokens due at once: every read is a refresh, the second one Beta's.
 const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  const response = await s.fetcher(input, init);
  return String(input).endsWith("/v1/auth/refresh") && response.ok ? Response.json({ ...await response.json() as object, access_expires_in: 60 }) : response;
 }) as typeof fetch;
 const account = new WebAccount(fetcher, undefined, Date.now, null);
 const calls: string[] = [];
 const changes: string[] = [];
 account.onSessionChange(change => changes.push(change));
 followSession(account, { end: () => calls.push("end"), startOver: () => calls.push("startOver"), restored: () => calls.push("restored") });
 await account.check();
 expect([account.current?.accountID, calls, changes]).toEqual(["acct-A", [], ["signed-in"]]);
 await account.check();
 expect([account.current?.accountID, calls, changes]).toEqual(["acct-B", ["end", "startOver"], ["signed-in", "session"]]);
});

test("a refresh whose answer's body never comes lets the lock go at its bound: another tab's sign-out reaches the service, and the request is cancelled", async () => {
 const shared = locks();
 const sent: string[] = [];
 let refreshSignal: AbortSignal | undefined;
 const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname;
  sent.push(path);
  if (path === "/v1/auth/signout") return new Response(null, { status: 204 });
  // Headers 200 at once; the body is held open (and this stub ignores the abort, as a body
  // already being read may).
  refreshSignal = init?.signal ?? undefined;
  return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "Content-Type": "application/json" } });
 }) as typeof fetch;
 // A real 50 ms bound: AbortSignal.timeout runs on the platform clock.
 const tabA = new WebAccount(fetcher, undefined, Date.now, shared, 50);
 const tabB = new WebAccount(fetcher, undefined, Date.now, shared, 50);
 const reading = tabA.check().then(() => "answered", (error: Error) => error.name);
 await new Promise(r => setTimeout(r, 0)); // tab A's refresh holds the lock, reading its body
 await tabB.signOut();
 expect([sent, await reading, refreshSignal?.aborted]).toEqual([["/v1/auth/refresh", "/v1/auth/signout"], "TimeoutError", true]);
});

test("a refresh that answers after its bound changes nothing: a later refresh's session stays", async () => {
 const body = Promise.withResolvers<string>();
 let refreshes = 0;
 const session = (account: string, n: number) => JSON.stringify({ account_id: account, access_token: access(n), access_expires_in: 60 });
 const fetcher = (async () => {
  refreshes++;
  // The first answer's body comes only later, whatever the abort (the stub ignores it).
  if (refreshes === 1) return new Response(new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode(await body.promise)); c.close(); } }), { status: 200 });
  return new Response(session("acct-B", 2), { status: 200 });
 }) as typeof fetch;
 // A real 50 ms bound: AbortSignal.timeout runs on the platform clock.
 const account = new WebAccount(fetcher, undefined, Date.now, null, 50);
 expect(await account.check().catch((e: Error) => e.name)).toBe("TimeoutError");
 expect((await account.check())?.accountID).toBe("acct-B");
 body.resolve(session("acct-A", 1));
 await new Promise(r => setTimeout(r, 10));
 expect(account.current?.accountID).toBe("acct-B");
});

test("a refresh whose 401 comes after its bound changes nothing: a later refresh's session stays", async () => {
 const late = Promise.withResolvers<Response>();
 let refreshes = 0;
 const fetcher = (async () => {
  refreshes++;
  // The first answer comes only later, whatever the abort (the stub ignores it).
  if (refreshes === 1) return late.promise;
  return Response.json({ account_id: "acct-B", access_token: access(2), access_expires_in: 3600 });
 }) as typeof fetch;
 // A real 50 ms bound: AbortSignal.timeout runs on the platform clock.
 const account = new WebAccount(fetcher, undefined, Date.now, null, 50);
 expect(await account.check().catch((e: Error) => e.name)).toBe("TimeoutError");
 expect((await account.check())?.accountID).toBe("acct-B");
 late.resolve(Response.json({ error: "no_session" }, { status: 401 }));
 await new Promise(r => setTimeout(r, 10));
 expect(account.current?.accountID).toBe("acct-B");
});

test("a page handed a session the service no longer has hears so (no-session) and starts over", async () => {
 const fetcher = (async () => Response.json({ error: "no_session" }, { status: 401 })) as typeof fetch;
 const account = new WebAccount(fetcher, undefined, Date.now, null);
 const changes: string[] = [], calls: string[] = [];
 account.onSessionChange(change => changes.push(change));
 followSession(account, { end: () => calls.push("end"), startOver: () => calls.push("startOver"), restored: () => calls.push("restored") });
 expect(await account.check()).toBeNull();
 expect([changes, calls]).toEqual([["no-session"], ["startOver"]]);
});

test("the cookie coming back as another account's: every view hears the old session end before the new one's state", async () => {
 const s = service(undefined, n => n >= 2 ? "acct-B" : "acct-A");
 // Tokens due at once: every read is a refresh, the second one Beta's.
 const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  const response = await s.fetcher(input, init);
  return String(input).endsWith("/v1/auth/refresh") && response.ok ? Response.json({ ...await response.json() as object, access_expires_in: 60 }) : response;
 }) as typeof fetch;
 const { desk } = createAccountDesk({ origin: "https://guest.herdrup.app", href: "https://guest.herdrup.app/web/", fetch: fetcher, navigate() {}, replaceURL() {} }, quiet);
 await desk.accountCheck();
 const { events } = await import("../src/web/events");
 const heard: boolean[] = [];
 const off = events.accountChanged.on(s => heard.push(s.signedIn));
 await desk.accountCheck();
 off();
 expect(heard).toEqual([false, true]);
});
