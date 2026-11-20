// The web guest's HerdrUp account sign-in (design #698 §2.3, §2.5). Sign-in is a top-level
// navigation to the account service, which comes back to guest.herdrup.app/web/?account=1 with the
// refresh token in an HttpOnly cookie on accounts.herdrup.app: the page never sees it. The page
// keeps only the 1-hour access token, in memory, and gets a new one with a credentialed POST
// /v1/auth/refresh. The service rotates the cookie on every refresh and revokes the session when a
// rotated-away token comes back, so refreshes are single-flight.

export const ACCOUNT_SERVICE = "https://accounts.herdrup.app";
/** The only origin the service's CORS lets carry the cookie: the old relay domain is another
 *  site, so it offers no sign-in. */
export const SIGN_IN_ORIGIN = "https://guest.herdrup.app";

export type Provider = "apple" | "google";

export function webSignInAvailable(origin: string): boolean {
 return origin === SIGN_IN_ORIGIN;
}

/** Where the page navigates (top level) to sign in. */
export function webSignInURL(provider: Provider, service = ACCOUNT_SERVICE): string {
 const q = new URLSearchParams({ provider, client: "web" });
 return `${service}/v1/auth/web/start?${q}`;
}

/** The page the service came back to, without its `account=1` marker, or null when this load is
 *  not the end of a sign-in. */
export function returnedFromSignIn(href: string): string | null {
 const url = new URL(href);
 if (url.searchParams.get("account") !== "1") return null;
 url.searchParams.delete("account");
 return url.toString();
}

export class SignedOutError extends Error {
 constructor() { super("Signed out"); this.name = "SignedOutError"; }
}
export class AccountServiceError extends Error {
 constructor(readonly status: number, readonly code: string) { super(`account service: ${status} ${code}`); this.name = "AccountServiceError"; }
}

export interface WebSession { accountID: string; displayHint?: string }

const ACCESS = /^a1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

/** One page's account session. `fetch` is the page's; tests pass a stub. */
export class WebAccount {
 private access = "";
 private accessUntil = 0;
 private session: WebSession | null = null;
 private flight: Promise<string> | null = null;

 constructor(private readonly fetcher: typeof fetch, private readonly service = ACCOUNT_SERVICE, private readonly now = Date.now) {}

 get current(): WebSession | null { return this.session; }

 /** A current access token, refreshing through the cookie when the one held is missing or within
  *  a minute of expiry. Concurrent callers share one refresh. Throws SignedOutError when the
  *  service has no session for this browser. */
 accessToken(): Promise<string> {
  if (this.access && this.now() < this.accessUntil) return Promise.resolve(this.access);
  this.flight ??= this.refresh().finally(() => { this.flight = null; });
  return this.flight;
 }

 private async refresh(): Promise<string> {
  const response = await this.fetcher(`${this.service}/v1/auth/refresh`, { method: "POST", credentials: "include", mode: "cors", cache: "no-store" });
  if (response.status === 401) { this.forget(); throw new SignedOutError(); }
  if (!response.ok) throw new AccountServiceError(response.status, await errorCode(response));
  const pair = await response.json() as { account_id?: unknown; access_token?: unknown; access_expires_in?: unknown; display_hint?: unknown };
  if (typeof pair.access_token !== "string" || !ACCESS.test(pair.access_token) || typeof pair.access_expires_in !== "number" || typeof pair.account_id !== "string") {
   throw new AccountServiceError(response.status, "malformed_session");
  }
  this.access = pair.access_token;
  this.accessUntil = this.now() + pair.access_expires_in * 1000 - 60_000;
  const hint = typeof pair.display_hint === "string" ? pair.display_hint : this.session?.displayHint;
  this.session = { accountID: pair.account_id, ...(hint ? { displayHint: hint } : {}) };
  return this.access;
 }

 /** Ends the session on the service (which clears the cookie) and here. */
 async signOut(): Promise<void> {
  let token = "";
  try { token = await this.accessToken(); } catch (error) { if (!(error instanceof SignedOutError)) { this.forget(); throw error; } }
  this.forget();
  if (!token) return;
  const response = await this.fetcher(`${this.service}/v1/auth/signout`, { method: "POST", credentials: "include", mode: "cors", headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok && response.status !== 401) throw new AccountServiceError(response.status, await errorCode(response));
 }

 private forget() { this.access = ""; this.accessUntil = 0; this.session = null; }
}

async function errorCode(response: Response): Promise<string> {
 try { const body = await response.json() as { error?: unknown }; return typeof body.error === "string" ? body.error : ""; } catch { return ""; }
}
