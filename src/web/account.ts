// The web guest's HerdrUp account sign-in (design #698 §2.3, §2.5). Sign-in is a top-level
// navigation to the account service, which comes back to guest.herdrup.app/web/?account=1 with the
// refresh token in an HttpOnly cookie on accounts.herdrup.app: the page never sees it. The page
// keeps only the 1-hour access token, in memory, and gets a new one with a credentialed POST
// /v1/auth/refresh. The service rotates the cookie on every refresh and revokes the session when a
// rotated-away token comes back, so refreshes are single-flight.

import { toB64url } from "../webguest/b64url";
import { enrolProof, type EnrolChallenge } from "../webguest/enrol";
import type { StaticKey } from "../webguest/noise";

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

/** How this page load ended a sign-in, or null when it did not: the service comes back with
 *  `account=1` (a session in the cookie) or `account_error=<code>` (AccountService web.ts back()).
 *  `clean` is the page's URL without the marker, for history.replaceState. */
export function returnedFromSignIn(href: string): { clean: string; error: string | null } | null {
 const url = new URL(href);
 const ok = url.searchParams.get("account") === "1", error = url.searchParams.get("account_error");
 if (!ok && error === null) return null;
 url.searchParams.delete("account"); url.searchParams.delete("account_error");
 return { clean: url.toString(), error: ok ? null : (error ?? "").slice(0, 64) };
}

/** The service's reason a sign-in ended without a session, in the app's words (desk_account.go
 *  signInEndedProblem); "" for a cancel. */
export function signInEndedProblem(code: string): string {
 switch (code) {
  case "cancelled": return "";
  case "flow_expired": return "The sign-in took too long. Sign in again.";
  case "browser_mismatch": return "The sign-in finished in a different browser than it started in. Sign in again.";
  case "provider_not_configured": return "This way of signing in isn't available yet.";
 }
 return "The sign-in didn't go through. Sign in again.";
}

/** The providers the service can sign in with on the web now, Apple first: its /v1/health
 *  web_sign_in_apple / web_sign_in_google flags (desktop's WebSignInProviders). A health check
 *  that fails (no answer, not 200, not JSON) rejects: unreachable is not "offers no sign-in". */
export async function webSignInProviders(fetcher: typeof fetch, service = ACCOUNT_SERVICE): Promise<Provider[]> {
 const response = await fetcher(`${service}/v1/health`, { cache: "no-store" });
 if (!response.ok) throw new AccountServiceError(response.status, "health");
 const health = await response.json() as { features?: unknown };
 const features = Array.isArray(health.features) ? health.features : [];
 return (["apple", "google"] as const).filter(p => features.includes(`web_sign_in_${p}`));
}

export class SignedOutError extends Error {
 constructor() { super("Signed out"); this.name = "SignedOutError"; }
}
export class AccountServiceError extends Error {
 constructor(readonly status: number, readonly code: string) { super(`account service: ${status} ${code}`); this.name = "AccountServiceError"; }
}

export interface WebSession { accountID: string; displayHint?: string }

/** A device of the account as the service lists it (AccountService devices.ts). */
export interface AccountDevice { id: string; name: string; platform: string; device_pub: string; created_ms: number; current?: boolean }

/** GET /v1/approvals/<id> (approve-v1). The approver and nonce_t appear once a trusted device
 *  claimed the request; outcome_stored once the service holds its outcome. */
export interface ApprovalStatus {
 state: "waiting" | "claimed" | "revealed" | "denied" | "approved" | "expired";
 expires_in: number;
 approver?: { device_pub: string; name: string };
 nonce_t?: string;
 outcome_stored?: boolean;
}

/** GET /v1/browsers/self: the access the service shows (a display cache, never authority) and
 *  the sealed machine lists, one per approver. */
export interface BrowserSelf {
 access?: { state: "waiting" | "approved" | "expired"; scope?: string; expires_ms?: number };
 envelopes: { approver_pub: string; seq: number; sealed: string }[];
}

const ACCESS = /^a1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

/** One page's account session. `fetch` is the page's; tests pass a stub. */
/** The Web Locks API (navigator.locks): one holder per name across this origin's tabs. */
export interface AccountLocks { request<T>(name: string, callback: () => Promise<T>): Promise<T> }
/** Every tab shares the refresh cookie, so its rotations take turns across tabs: a second
 *  refresh with a cookie another tab just rotated away would revoke the session. */
const REFRESH_LOCK = "herdrup-account-refresh";

const browserLocks = (): AccountLocks | null => (globalThis.navigator as { locks?: AccountLocks } | undefined)?.locks ?? null;

/** One page's account session. `fetch` is the page's; tests pass a stub. */
export class WebAccount {
 private access = "";
 private accessUntil = 0;
 private session: WebSession | null = null;
 private flight: Promise<string> | null = null;
 /** Counts sign-outs: a refresh commits only into the session it started from. */
 private epoch = 0;

 constructor(private readonly fetcher: typeof fetch, private readonly service = ACCOUNT_SERVICE, private readonly now = Date.now,
  private readonly locks: AccountLocks | null = browserLocks()) {}

 get current(): WebSession | null { return this.session; }
 /** Changes whenever this page's session ends (sign-out, a refresh the service refused) or a
  *  refresh brings another account's: anything issued for an earlier session, even for the same
  *  account, isn't this one's. */
 get generation(): number { return this.sessionGeneration; }
 private sessionGeneration = 0;

 /** A current access token, refreshing through the cookie when the one held is missing or within
  *  a minute of expiry. Callers in this page share one refresh, and tabs take turns (the lock).
  *  Throws SignedOutError when the service has no session for this browser. */
 accessToken(): Promise<string> {
  if (this.access && this.now() < this.accessUntil) return Promise.resolve(this.access);
  if (!this.flight) {
   // The epoch now, not when the lock is granted: a sign-out while this waits for the lock
   // (another tab's refresh, or the sign-out itself) makes its answer stale.
   const epoch = this.epoch;
   const flight: Promise<string> = this.exclusive(() => this.refresh(epoch)).finally(() => { if (this.flight === flight) this.flight = null; });
   this.flight = flight;
  }
  return this.flight;
 }

 /** The session the cookie holds now, or null when there is none: a refresh. Other errors throw. */
 async check(): Promise<WebSession | null> {
  try { await this.accessToken(); return this.session; }
  catch (error) { if (error instanceof SignedOutError) return null; throw error; }
 }

 private exclusive<T>(run: () => Promise<T>): Promise<T> {
  return this.locks ? this.locks.request(REFRESH_LOCK, run) : run();
 }

 private async refresh(epoch: number): Promise<string> {
  // Another tab may have refreshed while this one waited for the lock: the browser sends the
  // cookie as it is now, so this rotation follows that one.
  const response = await this.fetcher(`${this.service}/v1/auth/refresh`, { method: "POST", credentials: "include", mode: "cors", cache: "no-store" });
  if (epoch !== this.epoch) throw new SignedOutError();
  if (response.status === 401) { this.forget(); throw new SignedOutError(); }
  if (!response.ok) throw new AccountServiceError(response.status, await errorCode(response));
  const pair = await response.json() as { account_id?: unknown; access_token?: unknown; access_expires_in?: unknown; display_hint?: unknown };
  if (epoch !== this.epoch) throw new SignedOutError();
  if (typeof pair.access_token !== "string" || !ACCESS.test(pair.access_token) || typeof pair.access_expires_in !== "number" || typeof pair.account_id !== "string") {
   throw new AccountServiceError(response.status, "malformed_session");
  }
  this.access = pair.access_token;
  this.accessUntil = this.now() + pair.access_expires_in * 1000 - 60_000;
  const before = this.session?.accountID;
  // The last hint only for the same account: another account's session never shows it.
  const hint = typeof pair.display_hint === "string" ? pair.display_hint : before === pair.account_id ? this.session?.displayHint : undefined;
  this.session = { accountID: pair.account_id, ...(hint ? { displayHint: hint } : {}) };
  if (before !== pair.account_id) {
   if (before !== undefined) this.sessionGeneration++;
   this.notify();
  }
  return this.access;
 }

 /** Ends the session by its cookie, which the service clears; it answers 204 even with no
  *  session, so this works after the access token expired. It takes the refresh lock, so the
  *  cookie it sends is the newest, and a refresh still out commits nothing. */
 async signOut(): Promise<void> {
  this.forget();
  const response = await this.exclusive(() => this.fetcher(`${this.service}/v1/auth/signout`, { method: "POST", credentials: "include", mode: "cors" }));
  if (!response.ok) throw new AccountServiceError(response.status, await errorCode(response));
 }

 /** A token and the account it is for, read together: a refresh sets both at once. */
 private async credential(): Promise<{ token: string; account: string }> {
  for (;;) {
   const token = await this.accessToken();
   if (this.access === token && this.session !== null) return { token, account: this.session.accountID };
  }
 }

 /** The account this page signed in to, before any refresh (the cookie may hold another sign-in
  *  by now; calls bound to it then refuse); the first refresh's when there is none yet. An
  *  operation spanning calls binds to it. */
 async currentAccount(): Promise<string> {
  return this.session?.accountID ?? (await this.credential()).account;
 }

 /** One call to the service as this session: the access token as Bearer, and once more with a
  *  fresh token when the service says the one sent is no longer good (401). The call is bound to
  *  account, else to the account this page already signed in to, before any refresh; only with
  *  none yet does the first token's account bind it. A token for another account (the cookie now
  *  holds another sign-in) is refused before anything is sent, so a write never goes there.
  *  signal, when it aborts, stops the call: nothing is sent once it has, not even the retry, and a
  *  request in flight is cancelled. Errors are AccountServiceError with the service's code,
  *  SignedOutError, or the abort's reason. */
 private async authed<T>(method: string, path: string, body?: unknown, account?: string, signal?: AbortSignal): Promise<T> {
  let bound = account ?? this.session?.accountID;
  for (let attempt = 0; ; attempt++) {
   signal?.throwIfAborted();
   const { token, account: now } = await this.credential();
   signal?.throwIfAborted();
   if (bound !== undefined && now !== bound) throw new AccountServiceError(409, "account_changed");
   bound = now;
   const response = await this.fetcher(`${this.service}${path}`, {
    method, mode: "cors", cache: "no-store", ...(signal ? { signal } : {}),
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
   });
   if (response.status === 401 && attempt === 0) { if (this.access === token) { this.access = ""; this.accessUntil = 0; } continue; }
   if (!response.ok) throw new AccountServiceError(response.status, await errorCode(response));
   return await response.json() as T;
  }
 }

 /** Adds this browser to the account as a device with key (the guest identity), or binds this
  *  session to it when the account already has it. The challenge is single-use and lives 60 s,
  *  so both calls run together, as account (default: the current one). Refusals:
  *  device_in_other_account, session_has_device (409), too_many_devices (403), account_changed. */
 async enrol(key: StaticKey, name: string, account?: string, signal?: AbortSignal): Promise<AccountDevice> {
  const acct = account ?? await this.currentAccount();
  const ch = await this.authed<EnrolChallenge>("POST", "/v1/devices/challenge", undefined, acct, signal);
  if (ch.account_id !== acct) throw new AccountServiceError(409, "account_changed");
  const { devicePub, mac } = await enrolProof(key, ch);
  const out = await this.authed<{ device: AccountDevice }>("POST", "/v1/devices", { challenge_id: ch.challenge_id, device_pub: devicePub, mac, name, platform: "web" }, acct, signal);
  return out.device;
 }

 /** Asks the account's trusted devices to approve this browser (approve-v1 step 1); replaces
  *  any request this browser has open. account binds the call (see authed). */
 requestApproval(commit: Uint8Array, account?: string, signal?: AbortSignal): Promise<{ id: string; expires_in: number }> {
  return this.authed("POST", "/v1/approvals", { commit: toB64url(commit) }, account, signal);
 }

 approvalState(id: string, account?: string, signal?: AbortSignal): Promise<ApprovalStatus> {
  return this.authed("GET", `/v1/approvals/${encodeURIComponent(id)}`, undefined, account, signal);
 }

 /** Reveals nonce_b (step 3), once the request is claimed and nonce_t is held. */
 async reveal(id: string, nonceB: Uint8Array, account?: string, signal?: AbortSignal): Promise<void> {
  await this.authed("POST", `/v1/approvals/${encodeURIComponent(id)}/reveal`, { nonce_b: toB64url(nonceB) }, account, signal);
 }

 /** This browser's access as the service shows it, and the sealed machine lists it holds. */
 browserSelf(account?: string, signal?: AbortSignal): Promise<BrowserSelf> {
  return this.authed("GET", "/v1/browsers/self", undefined, account, signal);
 }

 /** This device's statements for hosts (relay host ids): what an owner hello carries. */
 statements(hosts: string[], account?: string, signal?: AbortSignal): Promise<{ statements: { host: string; jws: string }[]; exp: number }> {
  return this.authed("POST", "/v1/statements", { hosts }, account, signal);
 }

 /** Calls changed whenever this page's session starts, ends or becomes another account's, at the
  *  moment it does (a sign-out tells at once, before its request completes). Returns what stops it. */
 onSessionChange(changed: () => void): () => void {
  this.listeners.add(changed);
  return () => { this.listeners.delete(changed); };
 }
 private listeners = new Set<() => void>();
 private notify() { for (const changed of this.listeners) changed(); }

 private forget() {
  const had = this.session !== null;
  this.epoch++; this.sessionGeneration++; this.access = ""; this.accessUntil = 0; this.session = null; this.flight = null;
  if (had) this.notify();
 }
}

async function errorCode(response: Response): Promise<string> {
 try { const body = await response.json() as { error?: unknown }; return typeof body.error === "string" ? body.error : ""; } catch { return ""; }
}
