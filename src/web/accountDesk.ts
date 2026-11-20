// desk_account.go for the browser guest: the same Desk methods over src/web/account.ts. The session
// lives in the account service's cookie, so it outlives the page (persistent) but only on
// guest.herdrup.app, the one origin its CORS serves.
import type { AccountState } from "../mygo";
import { AccountServiceError, returnedFromSignIn, signInEndedProblem, WebAccount, webSignInAvailable, webSignInLive, webSignInURL, type Provider } from "./account";
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

export function createAccountDesk(page: AccountPage) {
 const account = new WebAccount(page.fetch);
 let live: Promise<boolean> | null = null;
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
 return {
  async accountAvailable(): Promise<boolean> {
   if (!webSignInAvailable(page.origin)) return false;
   live ??= webSignInLive(page.fetch).then(yes => { if (!yes) live = null; return yes; });
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
  async accountSignOut(): Promise<AccountState> {
   let problem = "";
   try { await account.signOut(); } catch (error) { problem = problemOf(error); }
   const s = state(problem);
   emit("accountChanged", s);
   return s;
  },
 };
}
