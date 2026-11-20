// The web guest's account session (src/web/account.ts) against a stub of the account service's
// cookie flow (design #698 §2.3, §2.5): the refresh token lives in the service's HttpOnly cookie,
// so every call is credentialed and carries no token in its body, and refreshes are single-flight
// because a rotated-away cookie revokes the session.
import { expect, test } from "bun:test";
import { returnedFromSignIn, SignedOutError, WebAccount, webSignInAvailable, webSignInURL } from "../src/web/account";

const access = (n: number) => `a1.${"s".repeat(22)}.${String(n).padStart(43, "0")}`;

/** The service: one cookie that rotates on each refresh; a spent cookie revokes the session. */
function service() {
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
  return Response.json({ error: "not_found" }, { status: 404 });
 }) as typeof fetch;
 return { fetcher, calls, revoke: () => { revoked = true; } };
}

test("sign-in is a top-level navigation offered only on guest.herdrup.app", () => {
 expect(webSignInURL("google")).toBe("https://accounts.herdrup.app/v1/auth/web/start?provider=google&client=web");
 expect([webSignInAvailable("https://guest.herdrup.app"), webSignInAvailable("https://guest.herdrup.themartian.app")]).toEqual([true, false]);
 expect(returnedFromSignIn("https://guest.herdrup.app/web/?account=1#x")).toBe("https://guest.herdrup.app/web/#x");
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

test("a refused cookie signs out; sign-out ends the session with the bearer token", async () => {
 const s = service();
 const account = new WebAccount(s.fetcher);
 await account.accessToken();
 await account.signOut();
 const signout = s.calls.find(c => c.url.endsWith("/v1/auth/signout"))!;
 expect(signout.init).toMatchObject({ method: "POST", credentials: "include" });
 expect((signout.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${access(1)}`);
 expect(account.current).toBeNull();
 await expect(account.accessToken()).rejects.toBeInstanceOf(SignedOutError);
});
