// The HerdrUp account in the apps (design #698 §2.3, accounts step 5 PR A): the Settings page
// "HerdrUp account" and, on desktop, the first-launch sign-in (owner pick 1B). Shown only once the
// account service lists web sign-in (Desk.accountAvailable). The session itself is Go's
// (desk_account.go) on desktop and the account service's cookie in the web guest
// (src/web/accountDesk.ts).
import "./herdrupAccount.css";
import { Desk, events } from "./mygo";
import type { AccountState } from "./mygo";
import { errorText } from "./errors";

export const ACCOUNT_TITLE = "HerdrUp account";
/** The first-launch sign-in was answered (any choice): it never comes back. */
const WELCOME_SEEN = "account.welcomeSeen";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
 const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node;
}

// Provider marks: Apple's in the ink colour; Google's "G" in its own colours, which its sign-in
// branding requires (content, not decoration).
const APPLE_MARK = '<svg viewBox="0 0 17 20" width="15" height="18" aria-hidden="true"><path fill="currentColor" d="M14.06 10.62c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.18-1.73-1.35-.14-2.64.8-3.33.8-.69 0-1.74-.78-2.87-.76-1.47.02-2.83.86-3.59 2.17-1.54 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.24 2.73 2.2 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.4 1.2-2.46-.03-.01-2.3-.88-2.32-3.5zM11.88 4.16c.6-.73 1-1.74.89-2.75-.86.04-1.9.57-2.52 1.3-.55.64-1.04 1.67-.91 2.66.96.07 1.94-.49 2.54-1.21z"/></svg>';
const GOOGLE_MARK = '<svg viewBox="0 0 18 18" width="17" height="17" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';

/** "Continue with Apple" and "Continue with Google", for the providers the service offers. */
function providerButtons(providers: readonly string[], pick: (provider: "apple" | "google") => void): HTMLButtonElement[] {
 const apple = el("button", "account-provider account-provider-apple"); apple.type = "button";
 apple.innerHTML = APPLE_MARK; apple.append(el("span", "", "Continue with Apple")); apple.onclick = () => pick("apple");
 const google = el("button", "account-provider account-provider-google"); google.type = "button";
 google.innerHTML = GOOGLE_MARK; google.append(el("span", "", "Continue with Google")); google.onclick = () => pick("google");
 return [...(providers.includes("apple") ? [apple] : []), ...(providers.includes("google") ? [google] : [])];
}

/** Starts a sign-in; on desktop the browser comes back on herdrup://account# (Go publishes
 *  accountChanged), in the web guest the page itself navigates away. */
async function startSignIn(provider: "apple" | "google"): Promise<void> { await Desk.accountSignIn(provider); }

/** The Settings page "HerdrUp account": sign in, who is signed in, sign out. */
export class HerdrUpAccountPanel {
 readonly root = el("div", "account-panel");
 available = false;
 private providers: string[] = [];
 private state: AccountState | null = null;
 private waiting = false;
 private busy = false;

 constructor(private readonly changed: () => void) {
  events.accountChanged.on(s => { this.waiting = false; this.state = s; this.draw(); this.changed(); });
 }

 /** The index row's value. */
 summary(): string { return this.state?.signedIn ? "Signed in" : "Not signed in"; }

 /** Whether the service offers sign-in, and the session as the app holds it; `check` asks the
  *  service too (a removed device shows signed out). */
 async refresh(check = false): Promise<void> {
  try {
   this.providers = await Desk.accountProviders();
   this.available = this.providers.length > 0;
   if (this.available) this.state = check ? await Desk.accountCheck() : await Desk.accountState();
  } catch (error) { this.state = { signedIn: false, persistent: true, problem: errorText(error) }; }
  this.draw(); this.changed();
 }

 private draw() {
  const s = this.state;
  const nodes: HTMLElement[] = [];
  if (s?.signedIn) {
   const who = el("div", "account-who");
   who.append(el("strong", "", "Signed in"), el("span", "account-hint", s.displayHint ? `as ${s.displayHint}` : "with Apple or Google"));
   const signOut = el("button", "account-sign-out", "Sign out"); signOut.type = "button"; signOut.disabled = this.busy;
   signOut.onclick = () => {
    this.busy = true; this.draw();
    void Desk.accountSignOut().then(next => { this.state = next; }, error => { this.state = { signedIn: false, persistent: true, problem: errorText(error) }; })
     .finally(() => { this.busy = false; this.draw(); this.changed(); });
   };
   nodes.push(who, signOut);
  } else {
   nodes.push(el("p", "account-lead", "Sign in to your HerdrUp account."));
   const buttons = el("div", "account-providers");
   buttons.append(...providerButtons(this.providers, provider => {
    this.waiting = true; this.draw();
    void startSignIn(provider).catch(error => { this.waiting = false; this.state = { ...(this.state ?? { signedIn: false, persistent: true }), problem: errorText(error) }; this.draw(); });
   }));
   nodes.push(buttons);
   if (this.waiting) nodes.push(el("p", "account-note", "Finish signing in in your browser."));
  }
  if (s?.problem) { const line = el("p", "account-note account-problem", s.problem); line.setAttribute("role", "status"); nodes.push(line); }
  if (s && !s.persistent) nodes.push(el("p", "account-note", "This computer has no credential store, so you'll sign in again each time herdrup starts."));
  nodes.push(el("p", "account-note", "Keys and pairing secrets stay on this device."));
  this.root.replaceChildren(...nodes);
 }
}

/** Desktop's first-launch sign-in (1B): before the host home on a first launch, answered once. */
export class AccountWelcome {
 readonly root = el("section", "account-welcome");
 private waiting = false;
 private providers: string[] = [];
 private shownFor = false;

 constructor(private readonly done: () => void) {
  this.root.hidden = true;
  this.root.setAttribute("aria-label", "Sign in");
  events.accountChanged.on(s => { if (s.signedIn && !this.root.hidden) this.finish(); else if (!this.root.hidden) this.draw(s.problem ?? ""); });
 }

 private static seen(): boolean { try { return localStorage.getItem(WELCOME_SEEN) === "1"; } catch { return true; } }

 /** Shows the sign-in when this is a first launch (nothing saved or shared), the service offers
  *  sign-in and nobody is signed in. Returns whether it shows. */
 async update(firstLaunch: boolean): Promise<boolean> {
  if (!firstLaunch || AccountWelcome.seen()) { this.root.hidden = true; return false; }
  if (!this.shownFor) {
   this.providers = await Desk.accountProviders().catch(() => []);
   const state = this.providers.length ? await Desk.accountState().catch(() => null) : null;
   if (!this.providers.length || !state || state.signedIn || AccountWelcome.seen()) { this.root.hidden = true; return false; }
   this.shownFor = true;
   this.draw("");
  }
  this.root.hidden = false;
  return true;
 }

 private finish() {
  try { localStorage.setItem(WELCOME_SEEN, "1"); } catch { /* shown again next launch */ }
  this.root.hidden = true; this.done();
 }

 private draw(problem: string) {
  const mark = el("img", "account-welcome-mark"); mark.src = "/herdrup/app-logo.png"; mark.alt = "";
  const top = el("div", "account-welcome-top");
  top.append(mark, el("h1", "", "HerdrUp"), el("p", "account-welcome-lead", "Sign in to your HerdrUp account."));
  const actions = el("div", "account-welcome-actions");
  actions.append(...providerButtons(this.providers, provider => {
   this.waiting = true; this.draw("");
   void startSignIn(provider).catch(error => { this.waiting = false; this.draw(errorText(error)); });
  }));
  const skip = el("button", "account-welcome-skip", "Set up without an account"); skip.type = "button";
  skip.onclick = () => this.finish();
  actions.append(skip);
  if (this.waiting) actions.append(el("p", "account-note", "Finish signing in in your browser."));
  if (problem) { const line = el("p", "account-note account-problem", problem); line.setAttribute("role", "status"); actions.append(line); }
  const foot = el("p", "account-welcome-foot", "Keys and pairing secrets stay on this computer. You can sign in later in Settings.");
  this.root.replaceChildren(top, actions, foot);
 }
}
