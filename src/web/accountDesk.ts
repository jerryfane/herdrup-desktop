// desk_account.go for the browser guest: the same Desk methods over src/web/account.ts. The session
// lives in the account service's cookie, so it outlives the page (persistent) but only on
// guest.herdrup.app, the one origin its CORS serves.
import type { AccountState } from "../mygo";
import { AccountServiceError, returnedFromSignIn, signInEndedProblem, WebAccount, webSignInAvailable, webSignInProviders, webSignInURL, type Provider } from "./account";
import { emit } from "./events";
import { PageExit } from "./ownerSession";

export interface AccountPage { origin: string; href: string; fetch: typeof fetch; navigate(url: string): void; replaceURL(url: string): void }

export function browserAccountPage(): AccountPage {
 return {
  origin: location.origin, href: location.href, fetch: globalThis.fetch.bind(globalThis),
  navigate: url => location.assign(url), replaceURL: url => history.replaceState(history.state, "", url),
 };
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
 *  call takes out of the address) for the page to open where the result shows, and the page's
 *  one way out (`exit`, PageExit): every navigation away from this document goes through it. */
export function createAccountDesk(page: AccountPage) {
 const account = new WebAccount(page.fetch);
 const exit = new PageExit(account);
 let live: Promise<Provider[]> | null = null;
 // A load that ends a sign-in: drop the marker from the address now, and say how it went once
 // the page asks (the error is shown once).
 const returned = returnedFromSignIn(page.href);
 if (returned) page.replaceURL(returned.clean);
 let pendingProblem = returned?.error ? signInEndedProblem(returned.error) : "";
 const state = (problem = "") => accountState(account, problem);
 const takeProblem = () => { const p = pendingProblem; pendingProblem = ""; return p; };
 // One account state for every view: the account panel and the owner screen hear each change
 // (sign-in, sign-out and how it went, another account) when it happens, from the same event.
 account.onSessionChange(() => emit("accountChanged", state()));
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
   *  any sign-out being sent, and takes the place of any other way out chosen before it). */
  async accountSignIn(provider: string): Promise<void> {
   if (provider !== "apple" && provider !== "google") throw new Error(`unknown provider ${provider}`);
   const url = webSignInURL(provider as Provider);
   exit.leave(() => page.navigate(url), true);
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
 };
 return { desk, signInReturned: returned !== null, account, exit };
}
