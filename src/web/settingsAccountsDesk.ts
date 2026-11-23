// The owner link machine's agent accounts (Claude, Codex, Kimi) in Settings → Accounts
// (desk_settings.go) and the account labels on agent rows (desk_sessions.go accounts), over herdr's
// accounts.* methods. herdr serves them to an owner's browser under a terminal-scope grant only
// (herdr#510); Settings shows the page then (settings.ts). Claude's in-app sign-in runs `claude auth
// login` in a background pane as Go does: pane.split, pane.send_text / send_keys, pane.read and
// pane.close, all in the terminal scope's gate. Every Settings call goes through settingsCall: on
// the link its operation began on, cancelled with its Settings scope, so a machine switch or a
// closed Settings never sends a write, and a queued step checks its scope again first; a pane made
// on a link is closed on that link before its connection closes (ownerLink.ts onLinkClosing).

import type { AccountLoginState, Desk as GoDesk } from "../mygo";
import { errorText } from "../errors";
import { sleep } from "../webguest/abort";
import { HerdrAPIError } from "../webguest/errors";
import { ErrUnsupported, untagged } from "./engine";
import { emit, events } from "./events";
import { showMenu, type MenuEntry } from "./menu";
import { currentOwnerLink, LINK_CHANGED, onLinkClosing, onOwnerLinkChanged, ownerCall, OwnerRefusedError, settingsCall, settingsLink, settingsScope, type OwnerLink, type SettingsScope } from "./ownerLink";

type DeskFns = typeof GoDesk;

/** herdrapi.AccountInfo: the fields the page's groups read; the JSON Settings gets is herdr's as sent. */
export interface AccountInfo {
 id: string;
 kind: string;
 label: string;
 config_dir: string;
 email?: string | null;
 /** false once the subscription is exhausted. */
 active: boolean;
 readiness?: { ready: boolean; detail?: string | null } | null;
}
interface AccountsList { accounts: AccountInfo[] }

/** desk_sessions.go sessionPoll: the account labels are read again this often. */
export const ACCOUNTS_POLL_MS = 15_000;
/** desk_settings.go: the 10 minutes a sign-in may take, the 45 s a submitted code may. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;
export const SUBMIT_TIMEOUT_MS = 45_000;
/** The logout's confirmation: the screen is read every LOGOUT_POLL_MS for the command's end, all
 *  of it within LOGOUT_TIMEOUT_MS (one deadline, a stalled read included). (desk_settings.go waits
 *  a fixed 2.5 s instead.) */
export const LOGOUT_POLL_MS = 500;
export const LOGOUT_TIMEOUT_MS = 15_000;
const LOGOUT_UNCONFIRMED = "Couldn't confirm the logout. Check Accounts — it may not have finished.";

// ---- Account labels (desk_sessions.go setAccounts) ----

/** desk_sessions.go accountLabels: each account's label by id, the first one of an id winning. A
 *  dictionary without a prototype, so every id herdr may send (constructor, __proto__, toString…)
 *  is a key like any other. */
export function accountLabels(accounts: readonly AccountInfo[]): Record<string, string> {
 const out: Record<string, string> = Object.create(null);
 for (const a of accounts) if (!Object.hasOwn(out, a.id)) out[a.id] = a.label;
 return out;
}

let labels: Record<string, string> = Object.create(null);
/** Advances whenever the labels' scope ends (another link, or the link no longer terminal): a read
 *  begun before is discarded, and its poll stops. */
let roster = 0;

function setLabels(list: readonly AccountInfo[]) {
 const next = accountLabels(list);
 const same = Object.keys(next).length === Object.keys(labels).length && Object.entries(next).every(([id, label]) => labels[id] === label);
 if (same) return;
 labels = next;
 emit("accountsChanged", { ...next });
}
function clearLabels() {
 roster++;
 setLabels([]);
}

/** desk_sessions.go watchSessions' accounts.list, for one owner link while its terminal scope lasts
 *  (roster at). A refusal clears the labels and the poll goes on at its pace (herdr may admit the
 *  browser again on the same link); a host without the method (an older herdr) is asked no more. */
async function watchAccounts(link: OwnerLink, at: number): Promise<void> {
 while (roster === at && currentOwnerLink() === link && !link.signal.aborted) {
  try {
   const list = (await ownerCall<AccountsList>("accounts.list", {}, "accounts_list", { signal: link.signal, link })).accounts ?? [];
   if (roster === at) setLabels(list);
  } catch (error) {
   const refused = error instanceof OwnerRefusedError || error instanceof ErrUnsupported;
   if (refused && roster === at) setLabels([]);
   if (error instanceof ErrUnsupported) return;
  }
  try { await sleep(ACCOUNTS_POLL_MS, link.signal); } catch { return; }
 }
}

/** The labels of link while it is the open one, following its scope as the state it publishes says
 *  it: polled while herdr admits it under a terminal-scope grant (its scope is "" until the first
 *  answer), cleared at once when a renewal admits it under chat. Returns the unsubscribe. */
function followLink(link: OwnerLink): () => void {
 let polling = false;
 const follow = () => {
  if (currentOwnerLink() !== link || link.signal.aborted) { off(); return; }
  const terminal = link.scope() === "terminal";
  if (terminal && !polling) { polling = true; void watchAccounts(link, roster); }
  else if (!terminal && polling) { polling = false; clearLabels(); }
 };
 const off = events.stateChanged.on(follow);
 link.signal.addEventListener("abort", off, { once: true });
 follow();
 return off;
}

/** Starts the account labels of the open owner link, and of each next one (another link's labels
 *  clear at once); web/mygo.ts starts them once. Returns the stop. */
export function startAccountLabels(): () => void {
 let offLink: (() => void) | null = null;
 const follow = (link: OwnerLink | null) => {
  offLink?.();
  clearLabels();
  offLink = link === null ? null : followLink(link);
 };
 const offChanged = onOwnerLinkChanged(follow);
 follow(currentOwnerLink());
 return () => { offChanged(); offLink?.(); offLink = null; clearLabels(); };
}

// ---- Settings → Accounts (desk_settings.go) ----

/** desk_settings.go SettingsAccountMenu's items for an account with agentCount agents of its kind:
 *  Swap (disabled while the account isn't ready), Log in / Log out for a Claude account with a
 *  config directory, Remove. */
export function accountMenuEntries(account: AccountInfo, agentCount: number): (MenuEntry & { action: string })[] {
 const items: (MenuEntry & { action: string })[] = [];
 if (agentCount > 0) items.push({ label: `Use for all ${account.kind} agents`, action: "swap", disabled: !!account.readiness && !account.readiness.ready });
 if (account.kind === "claude" && account.config_dir !== "") items.push({ label: "Log in", action: "login" }, { label: "Log out", action: "logout" });
 items.push({ label: "Remove account", action: "remove" });
 return items;
}

/** A word every shell a pane may run (sh, bash, zsh, fish) reads as exactly text: single-quoted,
 *  with each ' and \ written outside the quotes as \' and \\ (fish reads \' and \\ inside single
 *  quotes as escapes; sh doesn't, so neither may appear inside them). */
export function shellWord(text: string): string {
 return "'" + text.replace(/['\\]/g, (c) => `'\\${c}'`) + "'";
}

/** The account commands the app runs in a pane, and claude's arguments for each. */
export type AccountAction = "login" | "setup-token" | "logout";
const CLAUDE_ARGS: Record<AccountAction, string> = { login: "auth login --claudeai", "setup-token": "setup-token", logout: "auth logout" };

/** desk_settings.go accountCommand, run under sh whatever the pane's shell (herdr starts the
 *  configured shell or $SHELL, fish included): `sh -c '<script>' sh <config dir>`. The script is
 *  built here only, from fixed parts: `claude <action's arguments>` under the account's config
 *  directory ("$1"), then for a logout a line `herdrup-logout-<nonce>-<exit status>` (logoutStatus)
 *  with a nonce made here (8 hex digits). It has no ' nor \, so its single quotes read the same in
 *  every shell; the directory is one shellWord argument. */
export function accountCommand(account: AccountInfo, action: AccountAction): { line: string; nonce: string | null } {
 if (account.kind !== "claude" || account.config_dir === "") throw new Error("in-app sign-in requires a Claude account with a config directory");
 const nonce = action === "logout" ? crypto.randomUUID().slice(0, 8) : null;
 const marker = nonce === null ? "" : `; echo "herdrup-logout-${nonce}-$?"`;
 return { line: `sh -c 'env -u CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR="$1" claude ${CLAUDE_ARGS[action]}${marker}' sh ${shellWord(account.config_dir)}`, nonce };
}

const urlPattern = /https:\/\/[^\t\n\f\r <>"\x1b]+/;

/** desk_settings.go PollAccountLogin: the first https link the sign-in printed, or "". */
export function loginURL(text: string): string {
 const candidate = (text.match(urlPattern)?.[0] ?? "").replace(/[).,;\]]+$/, "");
 try {
  const url = new URL(candidate);
  return url.protocol === "https:" && url.host !== "" && url.username === "" && url.password === "" ? candidate : "";
 } catch { return ""; }
}

/** desk_settings.go loginRejected. Success wording suppresses old rejection text but never proves
 *  sign-in: only a changed account identity does. */
export function loginRejected(text: string): boolean {
 const lower = text.toLowerCase();
 if (["logged in", "login successful", "successfully logged in", "authentication successful"].some((p) => lower.includes(p))) return false;
 return ["invalid code", "invalid authorization code", "invalid token", "expired code", "code expired", "token expired", "session expired", "authentication failed", "login failed", "try again"].some((p) => lower.includes(p));
}

interface Login {
 id: string; pane: string; account: string; baselineEmail: string; submitBaseline: string;
 started: number; submitted: number; state: AccountLoginState;
}

/** desk_settings.go settingsSession: one Settings scope's sign-in pane on its link, and the lock its
 *  sign-in steps take turns on (view.mu). settings: its calls' scope (settingsCall). dialogs: each
 *  sign-in's one liveness record, a controller aborted when its dialog closes (made then if its
 *  first step hasn't run) or the scope ends. closes: the pane.close calls in flight. ending: once
 *  it ended, its last step and every close; its link cleanup stays registered until then. */
interface Scope {
 token: string; link: OwnerLink; settings: SettingsScope; login: Login | null; queue: Promise<unknown>; ended: boolean;
 dialogs: Map<string, AbortController>; closes: Set<Promise<unknown>>; ending: Promise<unknown> | null; offClosing: () => void;
}

export interface AccountsDeskOptions {
 now?: () => number;
 /** The logout's screen reads: LOGOUT_POLL_MS apart within LOGOUT_TIMEOUT_MS, unless a test passes its own. */
 logoutPollMs?: number;
 logoutTimeoutMs?: number;
}

/** pane.close on link itself, which may no longer be the open one (closeLogin: cleanup never goes to
 *  another machine), within 5 s. Not a Settings call: it goes whether or not Settings is open. */
function closePane(link: OwnerLink, pane: string): Promise<unknown> {
 return link.client.call("pane.close", { pane_id: pane }, "ok", "", AbortSignal.timeout(5000)).catch(() => undefined);
}

/** How long a pane.split already sent may take to answer, whatever happens to its link: the pane it
 *  made is then closed on that link (the link waits for that cleanup, ownerLink.ts linkClosing). */
export const SPLIT_WAIT_MS = 5000;

/** BackgroundPane: a pane split off the focused one, not focused, in scope (on its link, while it is
 *  the open one). Until its frame is handed to the socket it is a Settings call like any other:
 *  cancelled with the scope and with unsent (a sign-in dialog's lifetime), so a split still waiting
 *  for the relay's admission when they end is never sent (RequestOptions.sendSignal). Once sent,
 *  its answer is awaited past them and past the link's end (SPLIT_WAIT_MS): herdr may have made the
 *  pane, and only its id lets the caller close it. Callers check that the operation is still live
 *  right before it. */
async function backgroundPane(scope: SettingsScope, unsent?: AbortSignal): Promise<string> {
 const link = scope.link;
 if (currentOwnerLink() !== link) throw new Error(LINK_CHANGED);
 const sendSignal = unsent ? AbortSignal.any([scope.signal, unsent]) : scope.signal;
 try {
  return untagged<{ pane: { pane_id: string } }>(await link.client.call("pane.split", { direction: "down" }, "pane_info", "", AbortSignal.timeout(SPLIT_WAIT_MS), sendSignal)).pane.pane_id;
 } catch (error) {
  throw error instanceof HerdrAPIError && error.code === "owner_forbidden" ? new OwnerRefusedError("pane.split") : error;
 }
}

// The auth pane rule (sign-in and logout). A send to the pane (the command, the code, Enter) goes
// only right after `live` passed, and `live` is asked again after every await: it throws once the
// dialog or its Settings scope or its link has ended. That is necessary, not sufficient: a send
// can wait in the transport (for a connection) after `live` passed, so each one is a Settings call
// (settingsCall: the scope's cancellation) carrying the dialog's cancellation too, and a frame not
// yet sent when either ends is dropped. A sign-in's reads take the dialog's lifetime as well, and
// the pane is split only while the dialog is live; the split itself is dropped unsent with the
// scope and the dialog, and only once sent is its answer awaited past them. The pane's cleanup
// (pane.close on its own link) is registered with the link before the split is sent and stays
// registered until it has run, across a Settings scope being replaced; every pane.close in flight
// is part of its scope's teardown until it settles. A disconnect waits for all of them
// (ownerLink.ts linkClosing, within its bound). The cleanup never depends on `live` nor on that
// cancellation.

/** text then Enter into pane, each sent only while live() passes, as Settings calls in scope with
 *  signal (the dialog's cancellation, or the logout's deadline): unsent once either ends. */
async function sendLine(scope: SettingsScope, pane: string, text: string, live: () => void, signal: AbortSignal): Promise<void> {
 live();
 await settingsCall(scope, "pane.send_text", { pane_id: pane, text }, "ok", { signal });
 live();
 await settingsCall(scope, "pane.send_keys", { pane_id: pane, keys: ["Enter"] }, "ok", { signal });
}

/** The exit status the logout's line printed after `claude auth logout` (`herdrup-logout-<nonce>-<status>`),
 *  or null while it hasn't finished. The command line itself shows `$?` where the status goes, so
 *  its echo never matches. */
export function logoutStatus(text: string, nonce: string): number | null {
 const found = text.match(new RegExp(`herdrup-logout-${nonce}-(\\d+)`));
 return found ? Number(found[1]) : null;
}

export function createSettingsAccountsDesk(options: AccountsDeskOptions = {}) {
 const now = options.now ?? Date.now;
 const logoutPollMs = options.logoutPollMs ?? LOGOUT_POLL_MS;
 const logoutTimeoutMs = options.logoutTimeoutMs ?? LOGOUT_TIMEOUT_MS;
 let scope: Scope | null = null;

 /** The pane closes on its link; the close stays in its scope's teardown until it settles. */
 function closeLogin(s: Scope): Promise<unknown> {
  const login = s.login;
  if (login === null) return Promise.resolve();
  s.login = null;
  const closing = closePane(s.link, login.pane);
  s.closes.add(closing);
  void closing.finally(() => s.closes.delete(closing));
  return closing;
 }
 /** The scope ends (another Settings, or its link): its sign-ins' sends are dropped, the step under
  *  way finishes, then its pane closes on its link; its link cleanup stays registered until that
  *  and every close in flight (a dialog's) have settled, so a disconnect meanwhile waits for them. */
 function endScope(s: Scope): Promise<unknown> {
  s.ended = true;
  for (const dialog of s.dialogs.values()) dialog.abort(new Error(LINK_CHANGED));
  return s.ending ??= s.queue.then(() => closeLogin(s)).then(() => Promise.allSettled([...s.closes])).finally(() => s.offClosing());
 }
 /** A sign-in dialog's cancellation and its one liveness record (aborted by closeAccountLogin or the
  *  scope's end): what its reads and sends carry, besides the Settings scope's. */
 function dialog(s: Scope, loginID: string): AbortSignal {
  let controller = s.dialogs.get(loginID);
  if (controller === undefined) s.dialogs.set(loginID, controller = new AbortController());
  return controller.signal;
 }
 /** A sign-in's scope live (the auth pane rule): still Settings' on the open link. Its dialog's
  *  closure travels in the dialog signal every one of its calls carries, the split's included. */
 function signInLive(s: Scope) {
  if (s.ended || currentOwnerLink() !== s.link || settingsLink(s.token) !== s.link) throw new Error(LINK_CHANGED);
 }
 onOwnerLinkChanged(() => { if (scope !== null) { void endScope(scope); scope = null; } });

 /** The scope token names; a newer Settings scope ends the last one's sign-in, as OpenSettings does. */
 function scopeOf(token: string): Scope {
  const settings = settingsScope(token), link = settings.link;
  if (scope?.token === token && scope.link === link) return scope;
  if (scope !== null) void endScope(scope);
  const s: Scope = { token, link, settings, login: null, queue: Promise.resolve(), ended: false, dialogs: new Map(), closes: new Set(), ending: null, offClosing: () => {} };
  s.offClosing = onLinkClosing(link, () => endScope(s));
  return scope = s;
 }
 /** One sign-in step after the last: it starts only while its scope is open on its link. */
 function serial<T>(s: Scope, f: () => Promise<T>): Promise<T> {
  const run = s.queue.then(() => {
   if (s.ended || settingsLink(s.token) !== s.link) throw new Error(LINK_CHANGED);
   return f();
  });
  s.queue = run.catch(() => undefined);
  return run;
 }

 async function findAccount(on: SettingsScope, id: string, signal?: AbortSignal): Promise<AccountInfo> {
  const { accounts } = await settingsCall<AccountsList>(on, "accounts.list", {}, "accounts_list", { signal });
  const account = (accounts ?? []).find((a) => a.id === id);
  if (account === undefined) throw new Error("account is no longer registered");
  return account;
 }
 const accountsJSON = async (on: SettingsScope, method: string, params: unknown) => JSON.stringify(await settingsCall<AccountsList>(on, method, params, "accounts_list"));
 const readText = async (on: SettingsScope, pane: string, signal?: AbortSignal) => (await settingsCall<{ read: { text: string } }>(on, "pane.read", { pane_id: pane, source: "recent_unwrapped", format: "text" }, "pane_read", { signal })).read.text;
 /** The agents of kind on the Settings scope's link (link.agents). */
 const agentsOf = (link: OwnerLink, kind: string) => link.agents().filter((a) => a.agent === kind);

 return {
  async accounts(): Promise<Record<string, string>> { return { ...labels }; },

  async settingsAccounts(token: string): Promise<string> {
   return accountsJSON(settingsScope(token), "accounts.list", {});
  },

  async createSettingsAccount(token: string, kind: string, label: string): Promise<string> {
   const on = settingsScope(token);
   label = label.trim();
   if (label === "" || !["claude", "codex", "kimi"].includes(kind)) throw new Error("choose an account kind and label");
   return accountsJSON(on, "accounts.create", { kind, label });
  },

  async removeSettingsAccount(token: string, id: string): Promise<string> {
   return accountsJSON(settingsScope(token), "accounts.remove", { id });
  },

  /** SwapSettingsAccount: checks the account again (a listed one is no proof it can resume an
   *  agent), then restarts every agent of its kind on it, one by one, while its Settings scope
   *  lasts (Go's view.ctx): one closed or replaced sends no further restart, nor one still waiting
   *  for the relay. */
  async swapSettingsAccount(token: string, id: string): Promise<string> {
   const on = settingsScope(token), link = on.link;
   const account = await findAccount(on, id);
   if (account.readiness && !account.readiness.ready) throw new Error(account.readiness.detail || "account is not ready to resume agents");
   const targets = currentOwnerLink() === link ? agentsOf(link, account.kind).map((a) => a.pane_id ?? "") : [];
   let moved = 0, last: unknown = null;
   for (const pane of targets) {
    if (settingsLink(token) !== link) throw new Error(LINK_CHANGED);
    try {
     await settingsCall(on, "agent.restart", { target: pane, account: id }, "agent_info");
     moved++;
    } catch (error) { settingsLink(token); last = error; } // Settings closed meanwhile: stop, as Go's ctx
   }
   return `Moved ${moved} of ${targets.length} ${account.kind} agents to ${account.label}.` + (last !== null ? " Last error: " + errorText(last) : "");
  },

  /** SettingsAccountMenu: the account's menu; a choice is only an intent the page confirms. */
  async settingsAccountMenu(token: string, id: string, accountID: string): Promise<void> {
   const on = settingsScope(token), link = on.link;
   const account = await findAccount(on, accountID);
   if (settingsLink(token) !== link) throw new Error(LINK_CHANGED);
   const agentCount = agentsOf(link, account.kind).length;
   const entries = accountMenuEntries(account, agentCount);
   void showMenu(entries).then((item) => {
    const action = item?.action;
    if (action !== undefined) emit("settingsAccountMenu", { token, id, action, agentCount });
   });
  },

  async startAccountLogin(token: string, loginID: string, id: string, setupToken: boolean): Promise<AccountLoginState> {
   const s = scopeOf(token);
   return serial(s, async () => {
    if (loginID === "" || loginID.length > 128 || dialog(s, loginID).aborted) throw new Error("sign-in was closed");
    await closeLogin(s);
    const account = await findAccount(s.settings, id, dialog(s, loginID));
    const { line } = accountCommand(account, setupToken ? "setup-token" : "login");
    // Closed (or Settings or the link gone) during the lookup: no pane is made.
    signInLive(s);
    const pane = await backgroundPane(s.settings, dialog(s, loginID));
    const login: Login = {
     id: loginID, pane, account: id, baselineEmail: account.email ?? "", submitBaseline: "", started: now(), submitted: 0,
     state: { url: "", phase: "starting", message: "Getting a sign-in link…", email: "" },
    };
    s.login = login;
    // The dialog, scope or link may have ended while herdr answered the split: the pane then
    // closes untyped (the auth pane rule).
    try { await sendLine(s.settings, pane, line, () => signInLive(s), dialog(s, loginID)); } catch (error) { await closeLogin(s); throw error; }
    return { ...login.state };
   });
  },

  async pollAccountLogin(token: string, loginID: string): Promise<AccountLoginState> {
   const s = scopeOf(token);
   return serial(s, async () => {
    const login = s.login;
    if (login === null || login.id !== loginID) throw new Error("sign-in is no longer open");
    const state = login.state;
    if (state.phase === "signedIn") return { ...state };
    if (now() - login.started > LOGIN_TIMEOUT_MS) {
     state.phase = "unconfirmed";
     state.message = "Couldn't confirm the sign-in. Check Accounts — it may have worked.";
     return { ...state };
    }
    const account = await findAccount(s.settings, login.account, dialog(s, loginID));
    const email = (account.email ?? "").trim();
    if (email !== "" && email !== login.baselineEmail.trim()) {
     state.phase = "signedIn";
     state.email = account.email!;
     state.message = `Signed in as ${account.email}.`;
     return { ...state };
    }
    const text = await readText(s.settings, login.pane, dialog(s, loginID));
    if (state.url === "") {
     const url = loginURL(text);
     if (url !== "") {
      state.url = url;
      if (state.phase === "starting") {
       state.phase = "linkReady";
       state.message = "Open the link, approve, then paste the code below.";
      }
     }
    }
    if (state.phase === "submitting") {
     const fresh = text.startsWith(login.submitBaseline) ? text.slice(login.submitBaseline.length) : text;
     if (loginRejected(fresh)) {
      state.phase = "rejected";
      state.message = "That code didn't work — check it and try again.";
     } else if (now() - login.submitted >= SUBMIT_TIMEOUT_MS) {
      state.phase = "unconfirmed";
      state.message = "Couldn't confirm the sign-in. Check Accounts — it may have worked.";
     }
    }
    return { ...state };
   });
  },

  async submitAccountLogin(token: string, loginID: string, code: string): Promise<void> {
   const s = scopeOf(token);
   return serial(s, async () => {
    const login = s.login;
    if (login === null || login.id !== loginID) throw new Error("sign-in is no longer open");
    code = code.trim();
    if (code === "" || /[\r\n\0\x1b]/.test(code)) throw new Error("paste one authorization code");
    if (login.state.phase === "submitting" || login.state.phase === "signedIn") throw new Error("a sign-in is already in progress");
    login.submitBaseline = await readText(s.settings, login.pane, dialog(s, loginID));
    // Closed while the screen was read: no code goes (the auth pane rule).
    await sendLine(s.settings, login.pane, code, () => { signInLive(s); if (s.login !== login) throw new Error("sign-in is no longer open"); }, dialog(s, loginID));
    login.submitted = now();
    login.state.phase = "submitting";
    login.state.message = "Signing you in…";
   });
  },

  /** CloseAccountLogin: the page closed its sign-in. It also comes when Settings itself closes
   *  (its token already gone), so the scope's own token is enough to close the pane, on its link. */
  async closeAccountLogin(token: string, loginID: string): Promise<void> {
   const s = scope;
   if (s === null || s.token !== token) return;
   // Its controller is made here if its first step hasn't run yet; its reads and sends not yet out
   // are dropped, and no step of it starts again.
   dialog(s, loginID);
   s.dialogs.get(loginID)!.abort(new Error("sign-in was closed"));
   await s.queue;
   if (s.login?.id === loginID) await closeLogin(s);
  },

  /** LogoutSettingsAccount: `claude auth logout` in a background pane, closed afterwards on its
   *  link whatever happens (before that link's connection closes, if it ends first); the accounts as
   *  listed once the command has finished. It prints a marker with its exit status after it, read
   *  back from the pane; one deadline (LOGOUT_TIMEOUT_MS) covers sending the command and reading
   *  its result, and without the marker by then the logout is reported unconfirmed. */
  async logoutSettingsAccount(token: string, id: string): Promise<string> {
   const on = settingsScope(token), link = on.link;
   const account = await findAccount(on, id);
   const { line, nonce } = accountCommand(account, "logout");
   // The cleanup is registered before the split: a link ending while herdr answers it still
   // closes the pane it made, on that link.
   let pane: Promise<string> | null = null, closed: Promise<unknown> | null = null;
   const close = () => closed ??= (pane ?? Promise.reject(new Error("no pane"))).then((made) => closePane(link, made), () => undefined);
   const offClosing = onLinkClosing(link, close);
   try {
    pane = backgroundPane(on);
    const made = await pane;
    // One deadline from the command's submission to its result, a stalled acknowledgement or read
    // included; Settings closing (settingsCall) ends it too.
    const deadline = AbortSignal.timeout(logoutTimeoutMs);
    try {
     // The link or Settings ended while herdr answered the split: the pane closes (finally), untyped.
     await sendLine(on, made, line, () => { if (link.signal.aborted || currentOwnerLink() !== link || settingsLink(token) !== link) throw new Error(LINK_CHANGED); }, deadline);
     for (;;) {
      const status = logoutStatus(await readText(on, made, deadline), nonce!);
      if (status !== null) {
       if (status !== 0) throw new Error(`claude auth logout failed (exit status ${status}). Check Accounts.`);
       break;
      }
      await sleep(logoutPollMs, AbortSignal.any([on.signal, deadline]));
     }
    } catch (error) {
     throw deadline.aborted && !on.signal.aborted ? new Error(LOGOUT_UNCONFIRMED) : error;
    }
    return await accountsJSON(on, "accounts.list", {});
   } finally {
    // Unregistered once the close has run, not before: a disconnect meanwhile waits for it.
    void close().finally(offClosing);
   }
  },
 } satisfies Partial<DeskFns>;
}
