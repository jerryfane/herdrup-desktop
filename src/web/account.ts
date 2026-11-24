// The web guest's HerdrUp account sign-in (design #698 §2.3, §2.5). Sign-in is a top-level
// navigation to the account service, which comes back to guest.herdrup.app/web/?account=1 with the
// refresh token in an HttpOnly cookie on accounts.herdrup.app: the page never sees it. The page
// keeps only the 1-hour access token, in memory, and gets a new one with a credentialed POST
// /v1/auth/refresh. The service rotates the cookie on every refresh and revokes the session when a
// rotated-away token comes back, so refreshes are single-flight.

import { untilAborted } from "../webguest/abort";
import { toB64url } from "../webguest/b64url";
import { enrolProof, type EnrolChallenge } from "../webguest/enrol";
import type { StaticKey } from "../webguest/noise";
import { browserLocks, type Locks } from "./locks";

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
/** One refresh and the callers waiting for it. */
interface Flight { waiting: number; done: Promise<string> }

/** A refresh nobody waited for any more by the time the lock came: not sent. */
class RefreshUnwanted extends Error {
 constructor() { super("refresh no longer wanted"); this.name = "RefreshUnwanted"; }
}
export class AccountServiceError extends Error {
 constructor(readonly status: number, readonly code: string) { super(`account service: ${status} ${code}`); this.name = "AccountServiceError"; }
}

/** How long an operation holding the refresh lock (a refresh, a sign-out) may take: one the
 *  service doesn't answer by then is cancelled and lets the lock go, so whatever waits for the
 *  lock (a sign-out retry, another tab's refresh) is never stranded behind a silent request. */
export const LOCKED_REQUEST_MS = 10_000;

/** A sign-out this page asked for, from its start until it is over: `sending` while its request
 *  is out, `refused` once the service didn't take it (error says why). A refused attempt stays
 *  (the cookie is still signed in, and Sign out sends again) until a sign-out goes through, the
 *  service answers that there is no session, or another account's session comes back. account
 *  and hint are whom it signs out: the session's when it started, else the attempt's before it (a
 *  retry after the session couldn't be read back), else null (none was known here). */
export type SignOutAttempt = { account: string | null; hint?: string }
 & ({ phase: "sending"; sent: Promise<void> } | { phase: "refused"; error: unknown });

/** What onSessionChange tells, once current and signOutAttempt already say it:
 *  - "signed-in": the page's first session (none was known here), with no sign-out attempt around;
 *  - "session": the session ended (the service has none) or became another account's, with no
 *    sign-out attempt around;
 *  - "sign-out-sending": a sign-out started, and this page's session ended with it;
 *  - "signed-out": the service took the sign-out (the attempt is over);
 *  - "sign-out-refused": it didn't (the attempt stays, refused);
 *  - "restored": a refused attempt's own account was read back (the attempt stays refused);
 *  - "no-session": the service answered that there is no session, after a refusal (the attempt
 *    is over) or with no session known here (a page loaded for one the service no longer has);
 *  - "restored-other-account": another account's session came back after a refusal: the attempt
 *    is over, and nothing of it (its error) goes with the new session. */
export type SessionChange = "signed-in" | "session" | "sign-out-sending" | "signed-out" | "sign-out-refused" | "restored" | "no-session" | "restored-other-account";

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

/** Every tab shares the refresh cookie, so its rotations take turns across tabs (locks.ts): a
 *  second refresh with a cookie another tab just rotated away would revoke the session. */
const REFRESH_LOCK = "herdrup-account-refresh";

/** One page's account session. `fetch` is the page's; tests pass a stub. */
export class WebAccount {
 private access = "";
 private accessUntil = 0;
 private session: WebSession | null = null;
 private flight: Flight | null = null;
 /** Counts sign-outs: a refresh commits only into the session it started from. */
 private epoch = 0;
 #attempt: SignOutAttempt | null = null;
 /** The end of this page's last exclusive operation: the next one starts after it. */
 private turn: Promise<unknown> = Promise.resolve();

 constructor(private readonly fetcher: typeof fetch, private readonly service = ACCOUNT_SERVICE, private readonly now = Date.now,
  private readonly locks: Locks | null = browserLocks(), private readonly lockedMs = LOCKED_REQUEST_MS) {}

 get current(): WebSession | null { return this.session; }
 /** Changes whenever this page's session ends (sign-out, a refresh the service refused) or a
  *  refresh brings another account's: anything issued for an earlier session, even for the same
  *  account, isn't this one's. */
 get generation(): number { return this.sessionGeneration; }
 private sessionGeneration = 0;

 /** A current access token, refreshing through the cookie when the one held is missing or within
  *  a minute of expiry. Callers in this page share one refresh, and tabs take turns (the lock).
  *  Throws SignedOutError when the service has no session for this browser. A caller whose
  *  signal aborts stops waiting at once; a refresh still queued for the lock is skipped when no
  *  caller waits for it any more, and one already sent finishes. */
 accessToken(signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (this.access && this.now() < this.accessUntil) return Promise.resolve(this.access);
  const joining = this.flight;
  // A new flight is published with its real result already pending: a caller that comes while
  // the lock or the fetch is being started (even from inside them) joins that, not a stand-in.
  const result = joining === null ? Promise.withResolvers<string>() : null;
  const flight: Flight = joining ?? { waiting: 0, done: result!.promise };
  // Counted on its own flight before the refresh is queued (without a lock it starts at once). A
  // caller stops counting the moment its signal aborts, so the lock's turn sees only live callers
  // of that refresh, not of a newer one.
  flight.waiting++;
  let counted = true;
  const leave = () => { if (counted) { counted = false; flight.waiting--; } };
  signal?.addEventListener("abort", leave, { once: true });
  if (joining === null) {
   // The epoch now, not when the lock is granted: a sign-out while this waits for the lock
   // (another tab's refresh, or the sign-out itself) makes it stale, and it isn't sent.
   const epoch = this.epoch;
   flight.done = result!.promise.finally(() => { if (this.flight === flight) this.flight = null; });
   this.flight = flight;
   this.exclusive(signal => {
    if (flight.waiting > 0 && epoch === this.epoch) return this.refresh(epoch, signal);
    // Skipped: a caller that comes now queues its own refresh instead of joining this one.
    if (this.flight === flight) this.flight = null;
    return Promise.reject(epoch === this.epoch ? new RefreshUnwanted() : new SignedOutError());
   }).then(result!.resolve, result!.reject);
  }
  return (signal ? untilAborted(flight.done, signal) : flight.done).finally(() => { signal?.removeEventListener("abort", leave); leave(); });
 }

 /** The session the cookie holds now, or null when there is none: a refresh. Other errors throw. */
 async check(): Promise<WebSession | null> {
  try { await this.accessToken(); return this.session; }
  catch (error) { if (error instanceof SignedOutError) return null; throw error; }
 }

 /** run in this page's turn and under the tab lock (when there is one), for at most lockedMs:
  *  then its signal aborts (its request is cancelled), the lock goes and the call fails with the
  *  timeout, so a silent request never strands what waits (a sign-out retry behind a read-back).
  *  The page's own turns keep its refreshes and sign-outs one at a time even where the browser has
  *  no Web Locks; the lock does it across tabs. A lock or run that throws while being started
  *  still reports through the returned promise. */
 private exclusive<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const bounded = () => { const signal = AbortSignal.timeout(this.lockedMs); return untilAborted(run(signal), signal); };
  const locked = () => this.locks ? this.locks.request(REFRESH_LOCK, bounded) : bounded();
  const result = this.turn.then(locked);
  this.turn = result.catch(() => undefined);
  return result;
 }

 /** One refresh, in the lock's turn. signal ends with the turn (its bound): an answer that comes
  *  after it (a body that kept coming though the request was cancelled) is that expired turn's,
  *  and changes nothing here, neither a 401 nor a session. */
 private async refresh(epoch: number, signal: AbortSignal): Promise<string> {
  // Another tab may have refreshed while this one waited for the lock: the browser sends the
  // cookie as it is now, so this rotation follows that one.
  const response = await this.fetcher(`${this.service}/v1/auth/refresh`, { method: "POST", credentials: "include", mode: "cors", cache: "no-store", signal });
  signal.throwIfAborted();
  if (epoch !== this.epoch) throw new SignedOutError();
  if (response.status === 401) { this.noSession(); throw new SignedOutError(); }
  if (!response.ok) throw new AccountServiceError(response.status, await errorCode(response));
  const pair = await response.json() as { account_id?: unknown; access_token?: unknown; access_expires_in?: unknown; display_hint?: unknown };
  signal.throwIfAborted();
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
   this.notify(this.arrived(pair.account_id, before));
  }
  return this.access;
 }

 /** A session for account came in: the page's first (none was known: "signed-in"), another
  *  account's, or, next to a refused sign-out, its own account read back (the attempt stays; one
  *  that knew no account takes this one) or another's (the attempt is over). */
 private arrived(account: string, before: string | undefined): SessionChange {
  const attempt = this.#attempt;
  if (attempt?.phase !== "refused") return before === undefined ? "signed-in" : "session";
  if (attempt.account === null || attempt.account === account) { this.#attempt = { ...attempt, account }; return "restored"; }
  this.#attempt = null;
  return "restored-other-account";
 }

 /** The service has no session for this browser: a refused sign-out is over with it ("no-session",
  *  as when none was known here either: a page loaded for a session the service no longer has). */
 private noSession() {
  const refused = this.#attempt?.phase === "refused";
  if (refused) this.#attempt = null;
  this.forget(refused || this.session === null ? "no-session" : "session");
 }

 /** Ends the session by its cookie, which the service clears; it answers 204 even with no
  *  session, so this works after the access token expired, and with no session known here. It
  *  takes the refresh lock, so the cookie it sends is the newest, and a refresh still out commits
  *  nothing; a refresh that holds the lock without an answer lets it go after lockedMs, so a retry
  *  is never stranded behind a silent read-back. The attempt (signOutAttempt) is the one record of
  *  how it goes, published as it changes (onSessionChange): sending, then signed out or refused.
  *  A Sign out while one is being sent waits for that one. */
 signOut(): Promise<void> {
  if (this.#attempt?.phase === "sending") return this.#attempt.sent;
  const before = this.#attempt;
  const sent = Promise.withResolvers<void>();
  // Its outcome is the attempt's to tell; a caller that doesn't wait for it leaves nothing unhandled.
  sent.promise.catch(() => {});
  const hint = this.session ? this.session.displayHint : before?.hint;
  const whom = { account: this.session?.accountID ?? before?.account ?? null, ...(hint ? { hint } : {}) };
  this.#attempt = { ...whom, phase: "sending", sent: sent.promise };
  // The sign-out takes its turn before anyone hears of it: a refresh someone asks for on hearing
  // the session end (below) goes after the request, not ahead of it. The request itself starts
  // once its turn comes, after this.
  const request = this.exclusive(async signal => {
   const response = await this.fetcher(`${this.service}/v1/auth/signout`, { method: "POST", credentials: "include", mode: "cors", signal });
   if (!response.ok) throw new AccountServiceError(response.status, await errorCode(response));
  });
  this.forget("sign-out-sending");
  request.then(() => {
   this.#attempt = null;
   this.notify("signed-out");
   sent.resolve();
  }, (error: unknown) => {
   this.#attempt = { ...whom, phase: "refused", error };
   this.notify("sign-out-refused");
   sent.reject(error);
  });
  return sent.promise;
 }
 /** The sign-out attempt now, null when none is around (signOut). */
 get signOutAttempt(): SignOutAttempt | null { return this.#attempt; }
 /** Resolves once no sign-out is being sent: the page leaves (reloads, navigates) only then, as
  *  leaving would cancel the request and the cookie would stay signed in. */
 async signOutSettled(): Promise<void> {
  while (this.#attempt?.phase === "sending") await this.#attempt.sent.catch(() => {});
 }

 /** A token and the account it is for, read together: a refresh sets both at once. */
 private async credential(signal?: AbortSignal): Promise<{ token: string; account: string }> {
  for (;;) {
   // A cancelled caller doesn't go round again: no new refresh starts for it.
   const token = await this.accessToken(signal);
   if (this.access === token && this.session !== null) return { token, account: this.session.accountID };
  }
 }

 /** The account this page signed in to, before any refresh (the cookie may hold another sign-in
  *  by now; calls bound to it then refuse); the first refresh's when there is none yet. An
  *  operation spanning calls binds to it. */
 async currentAccount(signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (this.session) return this.session.accountID;
  // A cancelled caller stops waiting; the refresh goes on for whoever else needs it.
  return (await this.credential(signal)).account;
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
   const { token, account: now } = await this.credential(signal);
   // Aborted while the token was handed over: the caller's abort, not an account check.
   signal?.throwIfAborted();
   if (bound !== undefined && now !== bound) throw new AccountServiceError(409, "account_changed");
   bound = now;
   const response = await this.fetcher(`${this.service}${path}`, {
    method, mode: "cors", cache: "no-store", ...(signal ? { signal } : {}),
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
   });
   if (response.status === 401 && attempt === 0) { if (this.access === token) { this.access = ""; this.accessUntil = 0; } continue; }
   if (!response.ok) {
    const code = await errorCode(response);
    // An abort while the error body was read is the caller's, not the service's answer.
    signal?.throwIfAborted();
    throw new AccountServiceError(response.status, code);
   }
   return await response.json() as T;
  }
 }

 /** Adds this browser to the account as a device with key (the guest identity), or binds this
  *  session to it when the account already has it. The challenge is single-use and lives 60 s,
  *  so both calls run together, as account (default: the current one). Refusals:
  *  device_in_other_account, session_has_device (409), too_many_devices (403), account_changed. */
 async enrol(key: StaticKey, name: string, account?: string, signal?: AbortSignal): Promise<AccountDevice> {
  const acct = account ?? await this.currentAccount(signal);
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

 /** Calls changed whenever this page's session or sign-out attempt changes, at the moment it does
  *  (a sign-out tells at once, before its request completes), with what changed. Returns what
  *  stops it. */
 onSessionChange(changed: (change: SessionChange) => void): () => void {
  this.listeners.add(changed);
  return () => { this.listeners.delete(changed); };
 }
 private listeners = new Set<(change: SessionChange) => void>();
 private notify(change: SessionChange) { for (const changed of [...this.listeners]) changed(change); }

 /** The session ends here; change says why. A plain end ("session") is told only when there was
  *  a session to end; a sign-out's always is. */
 private forget(change: SessionChange) {
  const had = this.session !== null;
  this.epoch++; this.sessionGeneration++; this.access = ""; this.accessUntil = 0; this.session = null; this.flight = null;
  if (had || change !== "session") this.notify(change);
 }
}

async function errorCode(response: Response): Promise<string> {
 try { const body = await response.json() as { error?: unknown }; return typeof body.error === "string" ? body.error : ""; } catch { return ""; }
}
