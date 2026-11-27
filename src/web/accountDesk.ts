// desk_account.go, desk_account_devices.go and desk_account_sync.go's account methods for the
// browser: the same Desk methods over src/web/account.ts. The session lives in the account
// service's cookie, so it outlives the page (persistent) but only on guest.herdrup.app, the one
// origin its CORS serves.
//
// "This computer" is this browser: its device is its owner key (browserKey.ts ownerKey, the
// guest identity), enrolled as platform "web" under its browser name, the same enrolment the
// owner approval makes. Deleting the account (accountDeleteInfo, accountDelete) isn't here: the
// service serves /v1/account/delete/start and /v1/account/delete to the apps only (no CORS for
// this origin), and its confirming sign-in returns to herdrup://account, which a browser page
// can't receive. The account page then shows the desktop's "use the HerdrUp app" row.
import type { AccountDevices, AccountState, AccountSyncStatus } from "../mygo";
import type { StaticKey } from "../webguest/noise";
import type { IdentityStore } from "../webguest/identity";
import { AccountServiceError, returnedFromSignIn, SignedOutError, signInEndedProblem, WebAccount, webSignInAvailable, webSignInProviders, webSignInURL, type AccountDevice, type Provider } from "./account";
import { browserDeviceName } from "./browserIdentity";
import { ownerKey } from "./browserKey";
import { emit } from "./events";
import { browserLocks } from "./locks";
import { PageExit } from "./ownerSession";
import { createAccountSync, type SyncPlace } from "./prompts";

export interface AccountPage { origin: string; href: string; fetch: typeof fetch; navigate(url: string): void; replaceURL(url: string): void }

export function browserAccountPage(): AccountPage {
 return {
  origin: location.origin, href: location.href, fetch: globalThis.fetch.bind(globalThis),
  navigate: url => location.assign(url), replaceURL: url => history.replaceState(history.state, "", url),
 };
}

/** This browser as a device of the account, and where its sync keeps its state. */
export interface AccountHere extends SyncPlace {
 /** The browser's device key; null where it can't keep one (ownerKey). */
 key(): Promise<StaticKey | null>;
 /** Its name on the account's devices. */
 name: string;
}

/** How often a signed-in page syncs while open (desktop's machineSyncEvery). */
const SYNC_EVERY = 15 * 60_000;

export function browserAccountHere(identities: IdentityStore): AccountHere {
 return {
  key: () => ownerKey(identities), name: browserDeviceName(navigator.userAgent),
  storage: () => localStorage, locks: browserLocks(), background: true,
 };
}

/** The account page's DEVICES group from the service's list: this browser first, then oldest
 *  first; enrolment (why this browser isn't listed) only while it isn't. */
export function accountDevicesOf(list: AccountDevice[], enrolment: string): AccountDevices {
 const devices = list.map(d => ({ id: d.id, name: d.name, platform: d.platform, createdMs: d.created_ms, current: d.current === true }))
  .sort((a, b) => a.current !== b.current ? (a.current ? -1 : 1) : a.createdMs - b.createdMs);
 return devices.some(d => d.current) || !enrolment ? { devices } : { devices, enrolment };
}

const problemOf = (error: unknown) => error instanceof AccountServiceError && error.status >= 500
 ? "The account service is unavailable. Try again later." : "Couldn't reach the account service.";

/** The account's state as every read and event says it: the session, unless a sign-out was
 *  refused, which shows signed in (the cookie still is) with why, so Sign out is there to try
 *  again, until the attempt is over (WebAccount.signOutAttempt). A refused attempt's session is
 *  its own account's (another's ends it), so its hint stands in for a read-back that has none.
 *  problem (a sign-in's end) goes before the refusal's. */
function accountState(account: Pick<WebAccount, "current" | "signOutAttempt">, problem = ""): AccountState {
 const session = account.current, attempt = account.signOutAttempt;
 const refused = attempt?.phase === "refused" ? attempt : null;
 const s: AccountState = { signedIn: !!session || refused !== null, persistent: true };
 const hint = session?.displayHint ?? refused?.hint;
 if (hint) s.displayHint = hint;
 const why = problem || (refused ? `Couldn't sign out. ${problemOf(refused.error)}` : "");
 if (why) s.problem = why;
 return s;
}

/** The account Desk methods, whether this load ended a sign-in (`signInReturned`, the marker this
 *  call takes out of the address) for the page to open where the result shows, how it ended for a
 *  page that shows it itself (`signInEnded`: null when it didn't, problem null for a session, else
 *  the error in words, taken so the account page doesn't show it again), the page's one way out
 *  (`exit`, PageExit): every navigation away from this document goes through it, and `sync`, the
 *  account sync the saved prompts (prompts.ts) run after a change. */
export function createAccountDesk(page: AccountPage, here: AccountHere) {
 const account = new WebAccount(page.fetch);
 const exit = new PageExit(account);
 let live: Promise<Provider[]> | null = null;
 // A load that ends a sign-in: drop the marker from the address now, and say how it went once
 // the page asks (the error is shown once).
 const returned = returnedFromSignIn(page.href);
 if (returned) page.replaceURL(returned.clean);
 let pendingProblem = returned?.error ? signInEndedProblem(returned.error) : "";
 // Each finished sync round tells every view the account's state (desk_account_sync.go
 // AccountSyncNow's publishAccount): the account page reads SYNCED again from it.
 const sync = createAccountSync(account, here, () => emit("accountChanged", state()));
 const state = (problem = ""): AccountState => {
  const s = accountState(account, problem), session = account.current;
  if (session && sync.failed(session.accountID)) s.syncFailed = true;
  return s;
 };
 const takeProblem = () => { const p = pendingProblem; pendingProblem = ""; return p; };
 // One account state for every view: the account panel and the owner screen hear each change
 // (sign-in, sign-out and how it went, another account) when it happens, from the same event. A
 // session that begins syncs at once (the desktop's launch and sign-in), and then every 15 minutes.
 // The cookie can come back as another account's (a sign-in elsewhere in this browser): every view
 // hears the old session end first, as a desktop's switch shows it (sign-out, then sign-in), so
 // nothing it holds of the old account (Settings' devices, its This computer) stays.
 account.onSessionChange(change => {
  if ((change === "session" || change === "restored-other-account") && account.current) emit("accountChanged", { signedIn: false, persistent: true });
  emit("accountChanged", state());
  if (account.current) sync.soon();
 });
 if (here.background) setInterval(() => { if (account.current) sync.soon(); }, SYNC_EVERY);

 // Per account, the newest refusal to add this browser, so the page can say why it isn't listed;
 // a success clears it.
 const enrolFailed = new Map<string, string>();
 const noteEnrolment = (acct: string, code: string) => { if (code) enrolFailed.set(acct, code); else enrolFailed.delete(acct); };
 /** Adds this browser's key to account acct (a key already there binds this session to it); the
  *  device when it is now this session's, else null. A refusal is noted for the page. */
 const enrolThisDevice = async (acct: string, signal: AbortSignal): Promise<AccountDevice | null> => {
  const key = await here.key().catch(() => null);
  if (key === null) return null;
  let device: AccountDevice;
  try { device = await account.enrol(key, here.name, acct, signal); }
  catch (error) {
   if (error instanceof SignedOutError || (error instanceof AccountServiceError && error.code === "account_changed")) return null;
   noteEnrolment(acct, error instanceof AccountServiceError && error.code ? error.code : "unreachable");
   return null;
  }
  noteEnrolment(acct, "");
  return device;
 };
 const signedInAs = (): string => {
  const cur = account.current;
  if (cur === null) throw new SignedOutError();
  return cur.accountID;
 };
 const desk = {
  async accountProviders(): Promise<string[]> {
   if (!webSignInAvailable(page.origin)) return [];
   live ??= webSignInProviders(page.fetch).then(list => { if (list.length < 2) live = null; return list; }, error => { live = null; throw error; });
   return live;
  },
  async accountState(): Promise<AccountState> { return state(takeProblem()); },
  /** The session read again. A refused sign-out still shows (with its retry) when the read fails
   *  or comes back with its account; the read's own failure is the problem otherwise. */
  async accountCheck(): Promise<AccountState> {
   try { await account.check(); return state(takeProblem()); }
   catch (error) { return state(takeProblem() || (account.signOutAttempt?.phase === "refused" ? "" : problemOf(error))); }
  },
  /** A sign-in leaves the page: the person's choice, through the page's one exit (it waits for
   *  any sign-out being sent, and takes the place of any other way out chosen before it). Settles
   *  with the exit's run: a navigation the browser blocks rejects here, for the caller's error
   *  handler. */
  async accountSignIn(provider: string): Promise<void> {
   if (provider !== "apple" && provider !== "google") throw new Error(`unknown provider ${provider}`);
   const url = webSignInURL(provider as Provider);
   return exit.leave(() => page.navigate(url), true);
  },
  /** The session ends at once, and every view hears how the sign-out goes (onSessionChange). One
   *  the service didn't take leaves the cookie signed in: the state says so, with why, and Sign
   *  out tries again from the cookie alone; the session is read back meanwhile, in the background
   *  (its own account read back lets the owner screen go on). */
  async accountSignOut(): Promise<AccountState> {
   try { await account.signOut(); }
   catch { void account.check().catch(() => null); }
   return state();
  },
  async accountSyncStatus(): Promise<AccountSyncStatus> { return sync.status(); },
  /** A sync round now (the account page's "Sync now"); a round that finishes, well or not, tells
   *  the account's state (accountChanged). */
  async accountSyncNow(): Promise<void> { await sync.sync(); },
  /** The account's devices. When this browser isn't among them (its session isn't bound to a
   *  device yet) it is added first, as the desktop does, and listed as the service returned it. */
  async accountDevices(): Promise<AccountDevices> {
   const cur = account.current;
   if (cur === null) return { devices: [] };
   const acct = cur.accountID, signal = AbortSignal.timeout(20_000);
   let list = await account.devices(acct, signal);
   const added = !list.some(d => d.current) && !enrolFailed.has(acct) ? await enrolThisDevice(acct, signal) : null;
   if (added !== null) list = [...list.filter(d => d.id !== added.id), { ...added, current: true }];
   return accountDevicesOf(list, enrolFailed.get(acct) ?? "");
  },
  /** Adds this browser again (the page's "Try again"). */
  async accountEnrolAgain(): Promise<AccountDevices> {
   if (account.current) noteEnrolment(account.current.accountID, "");
   return desk.accountDevices();
  },
  async accountRenameDevice(id: string, name: string): Promise<void> {
   await account.renameDevice(id, name, signedInAs(), AbortSignal.timeout(20_000));
  },
  /** Removes device id. When it is this browser (the service's own list says so), its session
   *  ends on the service too, so it is signed out here as well (onSessionChange tells every view). */
  async accountRemoveDevice(id: string): Promise<void> {
   const acct = signedInAs(), signal = AbortSignal.timeout(20_000);
   const list = await account.devices(acct, signal);
   if (!list.some(d => d.id === id && d.current)) return account.removeDevice(id, acct, signal);
   await account.removeThisDevice(id, acct, signal);
  },
 };
 const signInEnded = () => returned === null ? null : { problem: returned.error === null ? null : takeProblem() };
 return { desk, signInReturned: returned !== null, signInEnded, account, exit, sync };
}
