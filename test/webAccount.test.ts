// The web guest's account session (src/web/account.ts) against a stub of the account service's
// cookie flow (design #698 §2.3, §2.5): the refresh token lives in the service's HttpOnly cookie,
// so every call is credentialed and carries no token in its body, and refreshes are single-flight
// because a rotated-away cookie revokes the session.
import { expect, test } from "bun:test";
import { AccountServiceError, returnedFromSignIn, SignedOutError, WebAccount, webSignInAvailable, webSignInProviders, webSignInURL } from "../src/web/account";
import { x25519 } from "@noble/curves/ed25519.js";
import { fromB64url, toB64url } from "../src/webguest/b64url";
import { enrolProof } from "../src/webguest/enrol";
import { staticKey } from "../src/webguest/identity";
import { createAccountDesk } from "../src/web/accountDesk";

const access = (n: number) => `a1.${"s".repeat(22)}.${String(n).padStart(43, "0")}`;

/** The service: one cookie that rotates on each refresh; a spent cookie revokes the session.
 *  route answers the account calls (null: 404), given the Bearer token sent. */
function service(route: (url: string, init: RequestInit, bearer: string) => Response | Promise<Response> | null = () => null) {
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
   return Response.json({ account_id: "acct-1", access_token: access(n), access_expires_in: 3600, ...(n === 1 ? { display_hint: "jerry@example.com" } : {}) });
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

test("the web Desk's providers: a failed check rejects and the next one asks again; other origins get none", async () => {
 let down = true, asked = 0;
 const fetcher = (async () => { asked++; return down ? new Response("", { status: 503 }) : Response.json({ features: ["web_sign_in_apple"] }); }) as unknown as typeof fetch;
 const page = (origin: string) => ({ origin, href: `${origin}/web/`, fetch: fetcher, navigate() {}, replaceURL() {} });
 const { desk } = createAccountDesk(page("https://guest.herdrup.app"));
 await expect(desk.accountProviders()).rejects.toThrow();
 down = false;
 expect(await desk.accountProviders()).toEqual(["apple"]);
 const before = asked;
 expect(await createAccountDesk(page("https://guest.herdrup.themartian.app")).desk.accountProviders()).toEqual([]);
 expect(asked).toBe(before);
});

/** navigator.locks for tests: one holder per name, queued. */
function locks(): import("../src/web/account").AccountLocks {
 const tails = new Map<string, Promise<unknown>>();
 return {
  request<T>(name: string, run: () => Promise<T>): Promise<T> {
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
 const stuck = new WebAccount(service((url) => url.endsWith("/v1/browsers/self") ? Response.json({ error: "unauthorized" }, { status: 401 }) : null).fetcher);
 const error = await stuck.browserSelf().catch(e => e);
 expect(error).toBeInstanceOf(AccountServiceError);
 expect(error.status).toBe(401);
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
