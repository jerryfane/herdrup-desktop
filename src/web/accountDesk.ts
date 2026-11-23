// desk_account.go for the browser guest: the same Desk methods over src/web/account.ts. The session
// lives in the account service's cookie, so it outlives the page (persistent) but only on
// guest.herdrup.app, the one origin its CORS serves.
import type { AccountState } from "../mygo";
import { AccountServiceError, returnedFromSignIn, signInEndedProblem, WebAccount, webSignInAvailable, webSignInProviders, webSignInURL, type Provider } from "./account";
import { emit } from "./events";

export interface AccountPage { origin: string; href: string; fetch: typeof fetch; navigate(url: string): void; replaceURL(url: string): void }

export function browserAccountPage(): AccountPage {
 return {
  origin: location.origin, href: location.href, fetch: globalThis.fetch.bind(globalThis),
  navigate: url => location.assign(url), replaceURL: url => history.replaceState(history.state, "", url),
 };
}

const problemOf = (error: unknown) => error instanceof AccountServiceError && error.status >= 500
 ? "The account service is unavailable. Try again later." : "Couldn't reach the account service.";

/** The account Desk methods, and whether this load ended a sign-in (`signInReturned`, the marker
 *  this call takes out of the address) for the page to open where the result shows. */
export function createAccountDesk(page: AccountPage) {
 const account = new WebAccount(page.fetch);
 let live: Promise<Provider[]> | null = null;
 // A load that ends a sign-in: drop the marker from the address now, and say how it went once
 // the page asks (the error is shown once).
 const returned = returnedFromSignIn(page.href);
 if (returned) page.replaceURL(returned.clean);
 let pendingProblem = returned?.error ? signInEndedProblem(returned.error) : "";
 const state = (problem = ""): AccountState => {
  const session = account.current;
  const s: AccountState = { signedIn: !!session, persistent: true };
  if (session?.displayHint) s.displayHint = session.displayHint;
  if (problem) s.problem = problem;
  return s;
 };
 const takeProblem = () => { const p = pendingProblem; pendingProblem = ""; return p; };
 // One session state for every view: the account panel and the owner screen hear each change
 // (sign-in, sign-out, another account) when it happens, from the same event.
 account.onSessionChange(() => emit("accountChanged", state()));
 const desk = {
  async accountProviders(): Promise<string[]> {
   if (!webSignInAvailable(page.origin)) return [];
   live ??= webSignInProviders(page.fetch).then(list => { if (list.length < 2) live = null; return list; }, error => { live = null; throw error; });
   return live;
  },
  async accountState(): Promise<AccountState> { return state(takeProblem()); },
  async accountCheck(): Promise<AccountState> {
   try { await account.check(); return state(takeProblem()); }
   catch (error) { return state(takeProblem() || problemOf(error)); }
  },
  async accountSignIn(provider: string): Promise<void> {
   if (provider !== "apple" && provider !== "google") throw new Error(`unknown provider ${provider}`);
   page.navigate(webSignInURL(provider as Provider));
  },
  /** The session ends at once (onSessionChange publishes it); the result, with any problem
   *  sending the sign-out, goes back to the panel that asked. */
  async accountSignOut(): Promise<AccountState> {
   let problem = "";
   try { await account.signOut(); } catch (error) { problem = problemOf(error); }
   return state(problem);
  },
 };
 return { desk, signInReturned: returned !== null, account };
}
