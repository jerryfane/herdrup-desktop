// The browser Desk's herdr-backed Settings (settingsAccountsDesk.ts, guestsDesk.ts,
// serverUpdateDesk.ts) on an owner link: the desktop's Go logic (desk_settings*.go,
// desk_guest_invite.go, desk_updates.go) against a fake herdr behind the link's real engine client,
// and once over a real owner link to a relay host refusing the method (an older herdr).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { HerdrAPIError } from "../src/webguest/errors";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { untilAborted } from "../src/webguest/abort";
import type { EnvelopeMachine } from "../src/webguest/approve";
import type { StatementSource } from "../src/webguest/owner";
import { generateIdentity, MemoryIdentityStore, staticKey } from "../src/webguest/identity";
import { toB64url } from "../src/webguest/b64url";
import { GuestClient } from "../src/web/engine";
import type { WebLink } from "../src/web/link";
import { emit, events } from "../src/web/events";
import { currentOwnerLink, LINK_CHANGED, linkClosing, onLinkClosing, OWNER_REFUSED, ownerCall, OwnerRefusedError, setOwnerLink, setOwnerSettings, type OwnerLink } from "../src/web/ownerLink";
import { guestLink, GuestTransport } from "../src/webguest/transport";
import { transportLink } from "../src/web/link";
import type { GuestAccess } from "../src/mygo";
import { setView } from "../src/web/view";
import { createGuestDesk } from "../src/web/desk";
import { accountLabel } from "../src/listExtras";
import { MemoryGrantStore, MemoryOwnerHint } from "../src/web/storage";
import type { AgentInfo } from "../src/web/board";
import { accountCommand, accountLabels, accountMenuEntries, createSettingsAccountsDesk, loginRejected, loginURL, logoutStatus, startAccountLabels, type AccountInfo } from "../src/web/settingsAccountsDesk";
import { guestsDesk } from "../src/web/guestsDesk";
import { createServerUpdateDesk } from "../src/web/serverUpdateDesk";
import { updateOffer, type UpdateAttempt, type UpdateState } from "../src/serverUpdatePolicy";
import { updateSuggestion } from "../src/settingsUpdates";
import { sharesAgent } from "../src/shellModel";
import { startRelay, type HostSession } from "./webguestResponder";

type Call = { method: string; params: Record<string, unknown> };
type Handler = (method: string, params: Record<string, unknown>) => unknown;

const claude: AccountInfo = { id: "a1", kind: "claude", label: "work", config_dir: "/home/j/.claude-1", email: "old@x.io", active: true };
const pong = { type: "pong", version: "0.9.6", capabilities: { server_update: true, agent_groups: true, agent_avatar: true, agent_answer: true } };
const refused = () => new HerdrAPIError("owner_forbidden", "no", {});

/** An owner link whose herdr answers with handler (a thrown error is herdr's, a promise answers
 *  when it settles), after the defaults: ping, and accounts.list with accounts. Every call is
 *  recorded; once `host.dead` (its connection closed) none goes out, and a call whose signal ends
 *  first is dropped by the client as the transport drops it (herdr may still have acted on it).
 *  While `host.admission` is set, a call waits for it before it is sent, as the transport waits
 *  for the relay to admit a connection; one whose signal ends meanwhile is never sent. */
function ownerLink(handler: Handler = () => undefined, options: { scope?: string; agents?: AgentInfo[]; accounts?: AccountInfo[]; hostID?: string } = {}) {
 const calls: Call[] = [];
 const life = new AbortController();
 const host = { scope: options.scope ?? "terminal", dead: false, admission: null as Promise<void> | null };
 const web = {
  access: {}, features: () => ({}),
  async call(method: string, params?: unknown, signal?: AbortSignal, sendSignal?: AbortSignal) {
   // Unsent while admission is held: signal or sendSignal ends it (RequestOptions.sendSignal).
   const unsent = signal && sendSignal ? AbortSignal.any([signal, sendSignal]) : signal ?? sendSignal;
   if (host.admission) await (unsent ? untilAborted(host.admission, unsent) : host.admission);
   if (host.dead) throw new Error("The shared connection was closed.");
   if (unsent?.aborted) throw unsent.reason; // the transport sends nothing on an ended signal
   const p = (params ?? {}) as Record<string, unknown>;
   calls.push({ method, params: p });
   const reply = Promise.resolve(handler(method, p));
   const answer = await (signal ? untilAborted(reply, signal) : reply);
   if (answer !== undefined) return answer;
   if (method === "ping") return pong;
   if (method === "accounts.list") return { type: "accounts_list", accounts: options.accounts ?? [claude] };
   throw refused();
  },
  stream() { throw new Error("no streams"); },
 } as unknown as WebLink;
 const machine: EnvelopeMachine = { hostItemID: "H1", label: "dev2306", relay: "", hostID: options.hostID ?? "host-1", nodePub: "", grantID: "g1", scope: "terminal", expiresUnix: 1_800_000_000 };
 const link: OwnerLink = { machine, client: new GuestClient(web), signal: life.signal, scope: () => host.scope, agents: () => options.agents ?? [], relist() {} };
 setOwnerLink(link);
 setOwnerSettings("tok");
 return { link, calls, life, host, of: (method: string) => calls.filter((c) => c.method === method) };
}

/** desk.ts disconnect: the link's groups clean up, the link ends, its connection closes after the
 *  cleanup; then (connectOwner) the next link opens. */
async function switchFrom(from: ReturnType<typeof ownerLink>, next: () => ReturnType<typeof ownerLink>) {
 const closed = linkClosing(from.link);
 from.life.abort();
 await closed;
 from.host.dead = true;
 return next();
}

// The account labels run as web/mygo.ts starts them, for this file's tests only.
let stopLabels = () => {};
beforeEach(() => { stopLabels = startAccountLabels(); });
afterEach(() => { setOwnerLink(null); setView(null); stopLabels(); });

const ok = { type: "ok" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** p, or a rejection "still pending after n s" (a deadline that never fires fails, not hangs). */
function withinSeconds<T>(n: number, p: Promise<T>): Promise<T> {
 const late = Promise.withResolvers<T>();
 const timer = setTimeout(() => late.reject(new Error(`still pending after ${n} s`)), n * 1000);
 return Promise.race([p, late.promise]).finally(() => clearTimeout(timer));
}

// ---- Decisions ----

test("an account's label is its first registration's, as herdrup names it on a row, whatever its id", () => {
 expect({ ...accountLabels([{ ...claude }, { ...claude, label: "later" }, { ...claude, id: "a2", label: "home" }]) }).toEqual({ a1: "work", a2: "home" });
 // Ids that are Object.prototype's names are ids like any other (the row reads the copy the Desk hands out).
 const labels = { ...accountLabels(["constructor", "toString", "__proto__", "hasOwnProperty"].flatMap((id) => [{ ...claude, id, label: `Work ${id}` }, { ...claude, id, label: "later" }])) };
 expect(["constructor", "toString", "__proto__", "hasOwnProperty"].map((id) => accountLabel(id, labels))).toEqual(["Work constructor", "Work toString", "Work __proto__", "Work hasOwnProperty"]);
});

test("an account's menu: Swap only with agents of its kind and disabled while not ready; Log in/out only for a Claude account with a config directory", () => {
 expect(accountMenuEntries(claude, 0).map((e) => e.action)).toEqual(["login", "logout", "remove"]);
 expect(accountMenuEntries({ ...claude, readiness: { ready: false, detail: "expired" } }, 2)[0]).toEqual({ label: "Use for all claude agents", action: "swap", disabled: true });
 expect(accountMenuEntries({ ...claude, readiness: { ready: true } }, 2)[0]!.disabled).toBe(false);
 expect(accountMenuEntries({ ...claude, kind: "codex" }, 1).map((e) => e.action)).toEqual(["swap", "remove"]);
 expect(accountMenuEntries({ ...claude, config_dir: "" }, 0).map((e) => e.action)).toEqual(["remove"]);
});

test("the auth command is one of the fixed actions run under sh, the config directory one quoted word", () => {
 expect(accountCommand({ ...claude, config_dir: "/h/it's" }, "login")).toEqual({ line: `sh -c 'env -u CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR="$1" claude auth login --claudeai' sh '/h/it'\\''s'`, nonce: null });
 expect(accountCommand(claude, "setup-token").line).toBe(`sh -c 'env -u CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR="$1" claude setup-token' sh '/home/j/.claude-1'`);
 const logout = accountCommand(claude, "logout");
 expect(logout.nonce).toMatch(/^[0-9a-f]{8}$/);
 expect(logout.line).toBe(`sh -c 'env -u CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR="$1" claude auth logout; echo "herdrup-logout-${logout.nonce}-$?"' sh '/home/j/.claude-1'`);
 expect(accountCommand(claude, "logout").nonce).not.toBe(logout.nonce);
 expect(() => accountCommand({ ...claude, kind: "codex" }, "logout")).toThrow("in-app sign-in requires a Claude account with a config directory");
});

// The exact line each shell a pane may run gets (herdr starts the configured shell or $SHELL), run
// with a stand-in `claude` that prints the directory and arguments it got: every shell present here
// must run it the same, logout marker included. (zsh and fish are skipped where not installed.)
const shells = ["sh", "bash", "dash", "zsh", "fish"].filter((name) => Bun.which(name) !== null);
test(`the auth command runs the same in every pane shell present (${shells.join(", ")})`, () => {
 const bin = mkdtempSync(join(tmpdir(), "hd-auth-shells-"));
 try {
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf 'dir=[%s] args=[%s] token=[%s]\\n' "$CLAUDE_CONFIG_DIR" "$*" "\${CLAUDE_CODE_OAUTH_TOKEN-unset}"\n`);
  chmodSync(join(bin, "claude"), 0o755);
  // ' and \ (a pair of them too, and one before a quote: fish's escapes inside single quotes).
  const dir = `/h/o'brien \\\\ \\' "x" $HOME;*`;
  const { line, nonce } = accountCommand({ ...claude, config_dir: dir }, "logout");
  for (const shell of shells) {
   const run = Bun.spawnSync([shell, "-c", line], { env: { PATH: `${bin}:${process.env.PATH}`, CLAUDE_CODE_OAUTH_TOKEN: "leak", HOME: "/home/x" } });
   expect([shell, run.stdout.toString()]).toEqual([shell, `dir=[${dir}] args=[auth logout] token=[unset]\nherdrup-logout-${nonce}-0\n`]);
  }
 } finally { rmSync(bin, { recursive: true, force: true }); }
});

test("the sign-in link is the first https link printed, without trailing punctuation or credentials", () => {
 expect(loginURL("Visit http://a.io then https://claude.ai/oauth?code=1). Then")).toBe("https://claude.ai/oauth?code=1");
 expect(loginURL("go to https://user:pw@evil.io/x")).toBe("");
 expect(loginURL("no link yet")).toBe("");
});

test("success wording outweighs a rejection in the same text, which alone means the code failed", () => {
 expect(loginRejected("Invalid code. Try again")).toBe(true);
 expect(loginRejected("invalid code earlier… Login successful")).toBe(false);
 expect(loginRejected("Paste code here >")).toBe(false);
});

const attempt: UpdateAttempt = { attempt_id: "x", build_id: "b6", from: "0.9.5", to: "0.9.6", phase: "installing", bytes_done: 0, bytes_total: 0, restart_later: true };
const offered = (over: Partial<UpdateState> = {}): UpdateState => ({
 known: true, version: "0.9.5", capabilities: pong.capabilities, flow: "idle", code: "", message: "", restartLater: false, missing: [], forbidden: false,
 check: { running: { version: "0.9.5", build_id: "b5", commit_time: 1_800_000_000 }, latest: { version: "0.9.6", build_id: "b6", commit_time: 1_800_000_100, notes: "" }, update_available: true, mode: "live" },
 ...over,
});

test("an update is offered only when herdr can take it here and now", () => {
 expect(updateOffer(offered())).toBe(true);
 expect(updateOffer(offered({ forbidden: true }))).toBe(false);
 expect(updateOffer(offered({ check: { ...offered().check!, mode: "unsupported" } }))).toBe(false);
 // A host too old for this app is offered only a build new enough for it.
 const old = { ...offered().check!, latest: { version: "0.9.0", build_id: "b0", commit_time: 1 } };
 expect(updateOffer(offered({ capabilities: { server_update: true }, check: old }))).toBe(false);
 expect(updateOffer(offered({ check: old }))).toBe(true);
 // A download waiting for a restart holds the offer until it runs.
 expect(updateOffer(offered({ pending: { ...attempt, build_id: "b6", outcome: "downloaded_restart_required" } }))).toBe(false);
 expect(updateOffer(offered({ pending: { ...attempt, build_id: "b5", outcome: "downloaded_restart_required" } }))).toBe(true);
});

test("Share with someone: the desktop's own agents, a browser's only under a terminal-scope grant", () => {
 expect(sharesAgent(false, undefined, false)).toBe(true);
 expect(sharesAgent(true, undefined, false)).toBe(false);
 expect(sharesAgent(true, "terminal", true)).toBe(true);
 expect(sharesAgent(true, "chat", true)).toBe(false);
 // Before herdr says the scope, nothing to share.
 expect(sharesAgent(true, undefined, true)).toBe(false);
});

// ---- Accounts ----

test("the account labels on rows come from the link's accounts.list; a chat-scope link asks for none", async () => {
 const heard: Record<string, string>[] = [];
 const off = events.accountsChanged.on((a) => heard.push(a));
 const chat = ownerLink(undefined, { scope: "chat" });
 await tick();
 expect(chat.of("accounts.list")).toEqual([]);
 ownerLink(undefined, { accounts: [claude, { ...claude, id: "a2", label: "home" }] });
 await tick(); await tick();
 off();
 expect(heard.at(-1)).toEqual({ a1: "work", a2: "home" });
 expect(await createSettingsAccountsDesk().accounts()).toEqual({ a1: "work", a2: "home" });
});

test("swapping restarts every agent of the account's kind on it, one by one, and says how many moved", async () => {
 const agents: AgentInfo[] = [{ pane_id: "p1", agent: "claude" }, { pane_id: "p2", agent: "codex" }, { pane_id: "p3", agent: "claude" }];
 const host = ownerLink((method, params) => {
  if (method === "agent.restart" && params.target === "p3") throw new HerdrAPIError("agent_busy", "mid-turn", {});
  if (method === "agent.restart") return { type: "agent_info", agent: {} };
 }, { agents });
 const desk = createSettingsAccountsDesk();
 expect(await desk.swapSettingsAccount("tok", "a1")).toBe("Moved 1 of 2 claude agents to work. Last error: herdr: agent_busy: mid-turn");
 expect(host.of("agent.restart").map((c) => c.params)).toEqual([{ target: "p1", account: "a1" }, { target: "p3", account: "a1" }]);
});

test("an account that isn't ready restarts nothing", async () => {
 const host = ownerLink(undefined, { agents: [{ pane_id: "p1", agent: "claude" }], accounts: [{ ...claude, readiness: { ready: false, detail: "Token expired" } }] });
 await expect(createSettingsAccountsDesk().swapSettingsAccount("tok", "a1")).rejects.toThrow("Token expired");
 expect(host.of("agent.restart")).toEqual([]);
});

test("a Settings token other than the open scope's sends nothing", async () => {
 const host = ownerLink();
 await tick();
 const before = host.calls.length;
 await expect(createSettingsAccountsDesk().settingsAccounts("other")).rejects.toThrow("Settings changed");
 await expect(guestsDesk.settingsGuestMachine("other", "")).rejects.toThrow("Settings changed");
 await expect(createServerUpdateDesk().settingsServerUpdate("other", true)).rejects.toThrow("Settings changed");
 expect(host.calls.length).toBe(before);
});

/** The sign-in pane's screen, as pane.read reads it. */
function signInHost(screen: { text: string }, email: { now: string }) {
 return ownerLink((method) => {
  if (method === "pane.split") return { type: "pane_info", pane: { pane_id: "login-pane" } };
  if (method === "pane.send_text" || method === "pane.send_keys" || method === "pane.close") return ok;
  if (method === "pane.read") return { type: "pane_read", read: { text: screen.text } };
  if (method === "accounts.list") return { type: "accounts_list", accounts: [{ ...claude, email: email.now }] };
 });
}

test("Claude sign-in: a background pane runs claude auth login, its link shows, a code is typed in, and a changed email signs in", async () => {
 const screen = { text: "Starting…" }, email = { now: "old@x.io" };
 const host = signInHost(screen, email);
 let clock = 0;
 const desk = createSettingsAccountsDesk({ now: () => clock });
 expect(await desk.startAccountLogin("tok", "L1", "a1", false)).toEqual({ url: "", phase: "starting", message: "Getting a sign-in link…", email: "" });
 expect(host.of("pane.split")[0]!.params).toEqual({ direction: "down" });
 expect(host.of("pane.send_text")[0]!.params).toEqual({ pane_id: "login-pane", text: `sh -c 'env -u CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR="$1" claude auth login --claudeai' sh '/home/j/.claude-1'` });
 expect(host.of("pane.send_keys")[0]!.params).toEqual({ pane_id: "login-pane", keys: ["Enter"] });

 screen.text = "Invalid code from before\nOpen https://claude.ai/oauth/authorize?x=1 to sign in";
 expect(await desk.pollAccountLogin("tok", "L1")).toMatchObject({ url: "https://claude.ai/oauth/authorize?x=1", phase: "linkReady" });
 await expect(desk.submitAccountLogin("tok", "L1", "a\nb")).rejects.toThrow("paste one authorization code");
 await desk.submitAccountLogin("tok", "L1", " CODE ");
 expect(host.of("pane.send_text")[1]!.params).toEqual({ pane_id: "login-pane", text: "CODE" });
 // Rejection wording printed before the code was sent is not this code's.
 expect((await desk.pollAccountLogin("tok", "L1")).phase).toBe("submitting");
 screen.text += "\nInvalid code";
 expect((await desk.pollAccountLogin("tok", "L1")).phase).toBe("rejected");

 email.now = "new@x.io";
 expect(await desk.pollAccountLogin("tok", "L1")).toMatchObject({ phase: "signedIn", email: "new@x.io", message: "Signed in as new@x.io." });
 await desk.closeAccountLogin("tok", "L1");
 await tick();
 expect(host.of("pane.close").map((c) => c.params)).toEqual([{ pane_id: "login-pane" }]);
 await expect(desk.startAccountLogin("tok", "L1", "a1", false)).rejects.toThrow("sign-in was closed");
});

test("a submitted code nobody confirms within 45 s, or a sign-in over 10 minutes, is unconfirmed", async () => {
 const screen = { text: "https://claude.ai/x" }, email = { now: "old@x.io" };
 signInHost(screen, email);
 let clock = 0;
 const desk = createSettingsAccountsDesk({ now: () => clock });
 await desk.startAccountLogin("tok", "L1", "a1", true);
 await desk.pollAccountLogin("tok", "L1");
 await desk.submitAccountLogin("tok", "L1", "CODE");
 clock = 44_999;
 expect((await desk.pollAccountLogin("tok", "L1")).phase).toBe("submitting");
 clock = 45_000;
 expect((await desk.pollAccountLogin("tok", "L1")).phase).toBe("unconfirmed");
 await desk.startAccountLogin("tok", "L2", "a1", false);
 clock += 10 * 60_000 + 1;
 expect((await desk.pollAccountLogin("tok", "L2")).phase).toBe("unconfirmed");
});

test("a sign-in pane that can't be typed into is closed again", async () => {
 const host = ownerLink((method) => {
  if (method === "pane.split") return { type: "pane_info", pane: { pane_id: "lp" } };
  if (method === "pane.send_text") throw new HerdrAPIError("pane_gone", "gone", {});
  if (method === "pane.close") return ok;
 });
 await expect(createSettingsAccountsDesk().startAccountLogin("tok", "L1", "a1", false)).rejects.toThrow("pane_gone");
 await tick();
 expect(host.of("pane.close").map((c) => c.params)).toEqual([{ pane_id: "lp" }]);
});

test("closing Settings (its token already gone) still closes the sign-in pane", async () => {
 const host = signInHost({ text: "" }, { now: "old@x.io" });
 const desk = createSettingsAccountsDesk();
 await desk.startAccountLogin("tok", "L1", "a1", false);
 setOwnerSettings("");
 await desk.closeAccountLogin("tok", "L1");
 await tick();
 expect(host.of("pane.close")).toHaveLength(1);
});

/** What the auth pane shows: the sign-in link, and the end marker of every logout command sent
 *  (logoutStatus), as `claude auth logout; echo …` prints it once finished. */
function authScreen(calls: Call[], finished = true): string {
 const nonces = calls.filter((c) => c.method === "pane.send_text").flatMap((c) => [...String(c.params.text).matchAll(/herdrup-logout-(\w+)-\$\?/g)].map((m) => m[1]));
 return ["https://claude.ai/oauth/authorize?x=1", ...(finished ? nonces.map((n) => `herdrup-logout-${n}-0`) : [])].join("\n");
}

test("logging out runs claude auth logout in a pane that is closed afterwards, then lists again", async () => {
 const host: ReturnType<typeof ownerLink> = ownerLink((method) => {
  if (method === "pane.split") return { type: "pane_info", pane: { pane_id: "out" } };
  if (method === "pane.read") return { type: "pane_read", read: { text: authScreen(host.calls) } };
  if (method === "pane.send_text" || method === "pane.send_keys" || method === "pane.close") return ok;
 });
 const listed = JSON.parse(await createSettingsAccountsDesk({ logoutPollMs: 0 }).logoutSettingsAccount("tok", "a1"));
 await tick();
 expect(listed.accounts[0].id).toBe("a1");
 expect(host.of("pane.send_text")[0]!.params.text).toMatch(/^sh -c 'env -u CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR="\$1" claude auth logout; echo "herdrup-logout-\w+-\$\?"' sh '\/home\/j\/\.claude-1'$/);
 expect(host.of("pane.close").map((c) => c.params)).toEqual([{ pane_id: "out" }]);
});

// ---- Guests ----

test("Shared access keeps a failed activity log apart from the guest list", async () => {
 ownerLink((method) => {
  if (method === "guest.list") return { type: "guest_list", guests: [{ guest_id: "g1", name: "ana" }], invites: [] };
  if (method === "guest.audit") throw new HerdrAPIError("audit_unreadable", "log", {});
 });
 expect(JSON.parse(await guestsDesk.settingsGuestMachine("tok", ""))).toEqual({ listing: { guests: [{ guest_id: "g1", name: "ana" }], invites: [] }, entries: null, auditError: "herdr: audit_unreadable: log" });
});

test("a host without guests says so; one refusing the browser says that", async () => {
 ownerLink((method) => { if (method === "guest.list") throw new HerdrAPIError("unknown_method", "guest.list", {}); });
 expect(JSON.parse(await guestsDesk.settingsGuestMachine("tok", ""))).toMatchObject({ missingFeature: true, entries: null });
 const host = ownerLink();
 expect(JSON.parse(await guestsDesk.settingsGuestMachine("tok", ""))).toEqual({ error: OWNER_REFUSED, entries: null });
 expect(host.of("guest.audit")).toEqual([]);
});

test("guest changes go to this machine only: never a machine param, and another machine's are refused unsent", async () => {
 const host = ownerLink((method) => {
  if (method === "guest.update") return { type: "guest_updated" };
  if (method === "guest.revoke") return { type: "guest_revoked" };
 });
 await guestsDesk.setGuestGramSharing("tok", "", "g1", false);
 await guestsDesk.revokeGuestAccess("tok", "", "i1", true);
 await guestsDesk.revokeGuestAccess("tok", "", "g1", false);
 await expect(guestsDesk.revokeGuestAccess("tok", "box2", "g1", false)).rejects.toThrow("other machines");
 expect(host.calls.filter((c) => c.method.startsWith("guest.")).map((c) => [c.method, c.params])).toEqual([
  ["guest.update", { guest_id: "g1", share_gram: false }], ["guest.revoke", { invite_id: "i1" }], ["guest.revoke", { guest_id: "g1" }],
 ]);
});

test("an invite is for the open agent view's pane, on the link's machine", async () => {
 const created = { type: "guest_invite_created", invite: { invite_id: "i1" }, url: "https://herdrup.app/web/#x" };
 const host = ownerLink((method) => { if (method === "guest.invite.create") return created; });
 setView({ token: "view-1", paneID: "p7", signal: new AbortController().signal });
 expect(JSON.parse(await guestsDesk.createGuestInvite("view-1", " ana ", " Jerry ", true))).toEqual({ invite: { invite_id: "i1" }, url: "https://herdrup.app/web/#x" });
 expect(host.of("guest.invite.create")[0]!.params).toEqual({ target: "p7", machine_label: "dev2306", name: "ana", owner_name: "Jerry", share_gram: true });
 await expect(guestsDesk.createGuestInvite("view-2", "ana", "Jerry", false)).rejects.toThrow("agent view changed");
});

// ---- herdr update ----

test("an update the host refuses to the browser hides the card and says why", async () => {
 ownerLink((method) => { if (method === "server.update_check") throw refused(); });
 const desk = createServerUpdateDesk();
 await expect(desk.settingsServerUpdate("tok", true)).rejects.toBeInstanceOf(OwnerRefusedError);
 expect(JSON.parse(await desk.settingsServerUpdate("tok", false))).toMatchObject({ known: true, forbidden: true, code: "owner_forbidden", message: OWNER_REFUSED });
});

test("a confirmed update is applied for that build and followed until herdr says it finished", async () => {
 // The status reads in turn: the check's, the one before applying, then the follower's; the last stays.
 const statuses: unknown[] = [{ type: "update_status" }, { type: "update_status" },
  { type: "update_status", attempt: { attempt_id: "at1", build_id: "b6", phase: "downloading" } },
  { type: "update_status", attempt: { attempt_id: "at1", build_id: "b6", outcome: "updated" } }];
 const host = ownerLink((method) => {
  if (method === "server.update_check") return { type: "update_check", ...offered().check };
  if (method === "server.update_status") return statuses.length > 1 ? statuses.shift() : statuses[0];
  if (method === "server.update_apply") return { type: "update_apply", attempt_id: "at1" };
 });
 const paused = Promise.withResolvers<void>();
 const desk = createServerUpdateDesk({ pause: () => paused.promise });
 expect(JSON.parse(await desk.settingsServerUpdate("tok", true))).toMatchObject({ known: true, flow: "idle", check: { latest: { build_id: "b6" } } });
 await expect(desk.applySettingsServerUpdate("tok", "b5", false)).rejects.toThrow("the offered update changed");
 expect(host.of("server.update_apply")).toEqual([]);
 await desk.applySettingsServerUpdate("tok", "b6", false);
 expect(host.of("server.update_apply")[0]!.params).toEqual({ build_id: "b6", restart_later: false });
 await tick();
 expect(JSON.parse(await desk.settingsServerUpdate("tok", false))).toMatchObject({ flow: "running", attempt: { phase: "downloading" } });
 paused.resolve();
 for (let i = 0; i < 10; i++) await tick();
 expect(JSON.parse(await desk.settingsServerUpdate("tok", false))).toMatchObject({ flow: "finished", attempt: { outcome: "updated" } });
});

test("an apply herdr refuses is shown as refused, not followed", async () => {
 ownerLink((method) => {
  if (method === "server.update_check") return { type: "update_check", ...offered().check };
  if (method === "server.update_status") return { type: "update_status" };
  if (method === "server.update_apply") throw new HerdrAPIError("update_busy", "another update runs", {});
 });
 const desk = createServerUpdateDesk({ pause: () => new Promise(() => {}) });
 await desk.settingsServerUpdate("tok", true);
 await desk.applySettingsServerUpdate("tok", "b6", false);
 expect(JSON.parse(await desk.settingsServerUpdate("tok", false))).toMatchObject({ flow: "refused", code: "update_busy", message: "another update runs" });
 await expect(desk.recheckSettingsServerUpdate("tok", true)).rejects.toThrow("there is no lost update to follow");
});

// ---- One machine's operations stay on it (review round 2) ----

test("a call bound to a link that is no longer open is not sent to the open one", async () => {
 const alpha = ownerLink();
 const beta = ownerLink(() => ({ type: "ok" }), { hostID: "host-2" });
 await expect(ownerCall("pane.close", { pane_id: "p" }, "ok", { link: alpha.link })).rejects.toThrow(LINK_CHANGED);
 expect(beta.of("pane.close")).toEqual([]);
});

/** A host whose update_check waits for release, offering b6 over b5. */
function updateHost(hostID: string, gate: { wait: Promise<void> | null }, apply: () => unknown = () => ({ type: "update_apply", attempt_id: "at1" })) {
 return ownerLink(async (method) => {
  if (method === "server.update_check") { await gate.wait; return { type: "update_check", ...offered().check }; }
  if (method === "server.update_status") return { type: "update_status" };
  if (method === "server.update_apply") return apply();
 }, { hostID });
}

test("an update confirmed on one machine, queued behind a refresh, never applies on the machine switched to", async () => {
 const gate: { wait: Promise<void> | null } = { wait: null };
 const alpha = updateHost("host-a", gate);
 const desk = createServerUpdateDesk({ pause: () => new Promise(() => {}) });
 await desk.settingsServerUpdate("tok", true);
 const release = Promise.withResolvers<void>();
 gate.wait = release.promise;
 const refreshing = desk.settingsServerUpdate("tok", true).catch((error: Error) => error.message);
 const applying = desk.applySettingsServerUpdate("tok", "b6", false).catch((error: Error) => error.message);
 await tick();
 const beta = await switchFrom(alpha, () => updateHost("host-b", { wait: null }));
 release.resolve();
 await refreshing;
 expect(await applying).toMatch(/changed/);
 expect([alpha.of("server.update_apply"), beta.of("server.update_apply")]).toEqual([[], []]);
});

test("an update confirmed in a Settings scope that has since closed is not applied", async () => {
 const gate: { wait: Promise<void> | null } = { wait: null };
 const host = updateHost("host-a", gate);
 const desk = createServerUpdateDesk({ pause: () => new Promise(() => {}) });
 await desk.settingsServerUpdate("tok", true);
 const release = Promise.withResolvers<void>();
 gate.wait = release.promise;
 const refreshing = desk.settingsServerUpdate("tok", true);
 const applying = desk.applySettingsServerUpdate("tok", "b6", false).catch((error: Error) => error.message);
 await tick();
 setOwnerSettings("tok-2");
 release.resolve();
 await refreshing.catch(() => undefined);
 expect(await applying).toMatch(/Settings changed/);
 expect(host.of("server.update_apply")).toEqual([]);
 // Not a request on its behalf: the first refresh's status read only (the second was a Settings
 // call of the scope that closed: cancelled with it).
 expect(host.of("server.update_status")).toHaveLength(1);
});

test("Settings closing while an apply reads the status first stops it before it applies", async () => {
 const status = { held: null as Promise<void> | null };
 const host = ownerLink(async (method) => {
  if (method === "server.update_check") return { type: "update_check", ...offered().check };
  if (method === "server.update_status") { await status.held; return { type: "update_status" }; }
  if (method === "server.update_apply") return { type: "update_apply", attempt_id: "at1" };
 }, { hostID: "host-a" });
 const desk = createServerUpdateDesk({ pause: () => new Promise(() => {}) });
 await desk.settingsServerUpdate("tok", true);
 const release = Promise.withResolvers<void>();
 status.held = release.promise;
 const applying = desk.applySettingsServerUpdate("tok", "b6", false).catch((error: Error) => error.message);
 await tick();
 setOwnerSettings("tok-2");
 release.resolve();
 expect(await applying).toMatch(/Settings changed/);
 expect(host.of("server.update_apply")).toEqual([]);
});

test("herdr refusing the apply to this browser hides the card as a refused check does, without a retry", async () => {
 updateHost("host-a", { wait: null }, () => { throw refused(); });
 const desk = createServerUpdateDesk({ pause: () => new Promise(() => {}) });
 await desk.settingsServerUpdate("tok", true);
 await expect(desk.applySettingsServerUpdate("tok", "b6", false)).rejects.toBeInstanceOf(OwnerRefusedError);
 expect(JSON.parse(await desk.settingsServerUpdate("tok", false))).toMatchObject({ flow: "idle", forbidden: true, code: "owner_forbidden", message: OWNER_REFUSED });
});

test("the card offers exactly what the apply guard accepts", () => {
 const check = offered().check!;
 const states: UpdateState[] = [
  offered(), offered({ check: { ...check, mode: "unsupported" } }), offered({ check: { ...check, update_available: false } }),
  offered({ capabilities: { server_update: true }, check: { ...check, latest: { ...check.latest!, commit_time: 1 } } }),
  offered({ check: { ...check, latest: { ...check.latest!, commit_time: 1 } } }),
  offered({ pending: { ...attempt, build_id: "b6", outcome: "downloaded_restart_required" } }),
  offered({ pending: { ...attempt, build_id: "b5", outcome: "downloaded_restart_required" } }),
 ];
 expect(states.map((s) => (updateSuggestion(s, "dev")?.title ?? "").startsWith("Update herdr to"))).toEqual(states.map(updateOffer));
 expect(states.map(updateOffer)).toEqual([true, false, false, false, true, false, true]);
});

/** A host whose sign-in pane reads wait for release while `held`. */
function signInHostHeld(hostID: string, read: { held: Promise<void> | null }, panes: string[]) {
 return ownerLink(async (method) => {
  if (method === "pane.split") { const pane = `${hostID}-pane-${panes.length + 1}`; panes.push(pane); return { type: "pane_info", pane: { pane_id: pane } }; }
  if (method === "pane.send_text" || method === "pane.send_keys" || method === "pane.close") return ok;
  if (method === "pane.read") { await read.held; return { type: "pane_read", read: { text: "" } }; }
 }, { hostID });
}

test("a sign-in restarted during a machine switch opens no pane on the next machine, and the first machine's pane closes before its link does", async () => {
 const read: { held: Promise<void> | null } = { held: null };
 const alphaPanes: string[] = [], betaPanes: string[] = [];
 const alpha = signInHostHeld("alpha", read, alphaPanes);
 const desk = createSettingsAccountsDesk();
 await desk.startAccountLogin("tok", "L1", "a1", false);
 const release = Promise.withResolvers<void>();
 read.held = release.promise;
 const polling = desk.pollAccountLogin("tok", "L1").catch(() => undefined);
 const restarting = desk.startAccountLogin("tok", "L1", "a1", false).catch((error: Error) => error.message);
 await tick();
 const switching = switchFrom(alpha, () => signInHostHeld("beta", { held: null }, betaPanes));
 release.resolve();
 await switching; await polling;
 expect(await restarting).toBe(LINK_CHANGED);
 expect(betaPanes).toEqual([]);
 expect(alpha.of("pane.close").map((c) => c.params.pane_id)).toEqual(["alpha-pane-1"]);
});

test("a sign-in step queued in a Settings scope that has since ended opens no pane", async () => {
 const read: { held: Promise<void> | null } = { held: null };
 const panes: string[] = [];
 signInHostHeld("alpha", read, panes);
 const desk = createSettingsAccountsDesk();
 await desk.startAccountLogin("tok", "L1", "a1", false);
 const release = Promise.withResolvers<void>();
 read.held = release.promise;
 const polling = desk.pollAccountLogin("tok", "L1").catch(() => undefined);
 const restarting = desk.startAccountLogin("tok", "L2", "a1", false).catch((error: Error) => error.message);
 await tick();
 setOwnerSettings("tok-2");
 await desk.pollAccountLogin("tok-2", "L9").catch(() => undefined); // the new scope ends the old one
 release.resolve();
 await polling;
 expect(await restarting).toBe(LINK_CHANGED);
 expect(panes).toEqual(["alpha-pane-1"]);
});

test("a chat-only machine shows no account of the machine before it, and is asked for none until herdr admits a terminal scope", async () => {
 ownerLink();
 await tick(); await tick();
 expect(await createSettingsAccountsDesk().accounts()).toEqual({ a1: "work" });
 const heard: Record<string, string>[] = [];
 const off = events.accountsChanged.on((a) => heard.push(a));
 const beta = ownerLink(undefined, { hostID: "host-2", scope: "" });
 await tick();
 expect(heard).toEqual([{}]);
 expect(await createSettingsAccountsDesk().accounts()).toEqual({});
 beta.host.scope = "chat";
 emit("stateChanged", { phase: "connected", message: "", machine: "", herdr: "", live: true });
 await tick();
 expect(beta.of("accounts.list")).toEqual([]);
 beta.host.scope = "terminal";
 emit("stateChanged", { phase: "connected", message: "", machine: "", herdr: "", live: true });
 await tick(); await tick();
 off();
 expect(beta.of("accounts.list")).toHaveLength(1);
 expect(heard.at(-1)).toEqual({ a1: "work" });
});

// ---- Review round 3 ----

/** A host whose pane.split answers when `split` is released (herdr made the pane meanwhile). */
function splitHeldHost(hostID: string, split: { held: Promise<void> | null }) {
 return ownerLink(async (method) => {
  if (method === "pane.split") { await split.held; return { type: "pane_info", pane: { pane_id: `${hostID}-pane` } }; }
  if (method === "pane.send_text" || method === "pane.send_keys" || method === "pane.close") return ok;
 }, { hostID });
}

test("a machine switch while herdr answers a sign-in's pane.split still closes that pane on its machine, untyped", async () => {
 const release = Promise.withResolvers<void>();
 const alpha = splitHeldHost("alpha", { held: release.promise });
 const desk = createSettingsAccountsDesk();
 const starting = desk.startAccountLogin("tok", "L1", "a1", false).catch((error: Error) => error.message);
 await tick();
 expect(alpha.of("pane.split")).toHaveLength(1);
 const switching = switchFrom(alpha, () => ownerLink(undefined, { hostID: "beta" }));
 release.resolve();
 await switching;
 expect(await starting).toBe(LINK_CHANGED);
 expect(alpha.of("pane.close").map((c) => c.params.pane_id)).toEqual(["alpha-pane"]);
 expect(alpha.of("pane.send_text")).toEqual([]);
});

test("a machine switch while herdr answers a logout's pane.split still closes that pane on its machine, untyped", async () => {
 const release = Promise.withResolvers<void>();
 const alpha = splitHeldHost("alpha", { held: release.promise });
 const desk = createSettingsAccountsDesk({ logoutPollMs: 0 });
 const loggingOut = desk.logoutSettingsAccount("tok", "a1").catch((error: Error) => error.message);
 await tick();
 expect(alpha.of("pane.split")).toHaveLength(1);
 const switching = switchFrom(alpha, () => ownerLink(undefined, { hostID: "beta" }));
 release.resolve();
 await switching;
 expect(await loggingOut).toBe(LINK_CHANGED);
 expect(alpha.of("pane.close").map((c) => c.params.pane_id)).toEqual(["alpha-pane"]);
 expect(alpha.of("pane.send_text")).toEqual([]);
});

test("a swap stops restarting agents once its Settings scope closes", async () => {
 const first = Promise.withResolvers<void>();
 const host = ownerLink(async (method) => {
  if (method === "agent.restart") { await first.promise; return { type: "agent_info", agent: {} }; }
 }, { agents: [{ pane_id: "p1", agent: "claude" }, { pane_id: "p2", agent: "claude" }] });
 const swapping = createSettingsAccountsDesk().swapSettingsAccount("tok", "a1").catch((error: Error) => error.message);
 await tick(); await tick();
 expect(host.of("agent.restart")).toHaveLength(1);
 setOwnerSettings("");
 first.resolve();
 expect(await swapping).toMatch(/Settings changed/);
 expect(host.of("agent.restart").map((c) => c.params.target)).toEqual(["p1"]);
});

test("a link renewed under chat clears its account labels at once, and a read begun before is discarded", async () => {
 const held = { list: null as Promise<void> | null };
 const host = ownerLink(async (method) => { if (method === "accounts.list") { await held.list; return { type: "accounts_list", accounts: [claude] }; } });
 await tick(); await tick();
 expect(await createSettingsAccountsDesk().accounts()).toEqual({ a1: "work" });
 // A read under way (a Settings scope's, or the poll's next) when the renewal comes.
 const release = Promise.withResolvers<void>();
 held.list = release.promise;
 const heard: Record<string, string>[] = [];
 const off = events.accountsChanged.on((a) => heard.push(a));
 host.host.scope = "chat";
 emit("stateChanged", { phase: "connected", message: "", machine: "", herdr: "", live: true });
 expect(heard).toEqual([{}]);
 host.host.scope = "terminal";
 emit("stateChanged", { phase: "connected", message: "", machine: "", herdr: "", live: true });
 host.host.scope = "chat";
 emit("stateChanged", { phase: "connected", message: "", machine: "", herdr: "", live: true });
 release.resolve();
 await tick(); await tick();
 off();
 expect(await createSettingsAccountsDesk().accounts()).toEqual({});
});

test("herdr refusing the follower's status read is the update's one refusal, the update left to finish on the host", async () => {
 let reads = 0;
 updateHostWith("host-a", (method) => {
  if (method === "server.update_status") { reads++; if (reads > 2) throw refused(); return { type: "update_status" }; }
 });
 const desk = createServerUpdateDesk({ pause: () => Promise.resolve() });
 await desk.settingsServerUpdate("tok", true);
 await desk.applySettingsServerUpdate("tok", "b6", false);
 await tick(); await tick();
 expect(JSON.parse(await desk.settingsServerUpdate("tok", false))).toMatchObject({ flow: "lostTrack", forbidden: true, code: "owner_forbidden", message: OWNER_REFUSED });
});

/** updateHost's offer with handler first. */
function updateHostWith(hostID: string, handler: Handler) {
 return ownerLink((method, params) => {
  const answer = handler(method, params);
  if (answer !== undefined) return answer;
  if (method === "server.update_check") return { type: "update_check", ...offered().check };
  if (method === "server.update_apply") return { type: "update_apply", attempt_id: "at1" };
 }, { hostID });
}

// ---- Review round 4: the auth pane rule ----

/** A sign-in host: each pane.split answers when the next of `splits` is released (none: at once),
 *  pane.read when `read.held` is, pane.close when `close.held` is. */
function authHost(splits: Promise<void>[], read: { held: Promise<void> | null } = { held: null }, close: { held: Promise<void> | null } = { held: null }) {
 let made = 0;
 const calls = () => host.calls;
 const host: ReturnType<typeof ownerLink> = ownerLink(async (method) => {
  if (method === "pane.split") { const n = ++made; await splits[n - 1]; return { type: "pane_info", pane: { pane_id: `pane-${n}` } }; }
  if (method === "pane.read") { await read.held; return { type: "pane_read", read: { text: authScreen(calls()) } }; }
  if (method === "pane.close") { await close.held; return ok; }
  if (method === "pane.send_text" || method === "pane.send_keys") return ok;
 });
 return host;
}
const sentText = (host: ReturnType<typeof ownerLink>) => host.of("pane.send_text").map((c) => c.params.text);

test("a sign-in of a replaced Settings scope still has its pane closed when the link ends before its split answers", async () => {
 const first = Promise.withResolvers<void>();
 const alpha = authHost([first.promise]);
 const desk = createSettingsAccountsDesk();
 const starting = desk.startAccountLogin("tok", "L1", "a1", false).catch((error: Error) => error.message);
 await tick();
 setOwnerSettings("tok-2"); // Settings closed and opened again
 await desk.startAccountLogin("tok-2", "L2", "a1", false);
 const switching = switchFrom(alpha, () => ownerLink(undefined, { hostID: "beta" }));
 await tick();
 first.resolve();
 await switching;
 await starting;
 expect(alpha.of("pane.close").map((c) => c.params.pane_id).sort()).toEqual(["pane-1", "pane-2"]);
 expect(sentText(alpha)).toHaveLength(1); // the second sign-in's command only
});

test("closing the sign-in while herdr answers its split runs no login command, and closes the pane", async () => {
 const split = Promise.withResolvers<void>();
 const host = authHost([split.promise]);
 const desk = createSettingsAccountsDesk();
 const starting = desk.startAccountLogin("tok", "L1", "a1", false).catch((error: Error) => error.message);
 await tick();
 const closing = desk.closeAccountLogin("tok", "L1");
 split.resolve();
 await closing;
 expect(await starting).toBe("sign-in was closed");
 expect(sentText(host)).toEqual([]);
 expect(host.of("pane.send_keys")).toEqual([]);
 expect(host.of("pane.close").map((c) => c.params.pane_id)).toEqual(["pane-1"]);
});

test("closing the sign-in while the screen is read before the code goes sends no code nor Enter", async () => {
 const read: { held: Promise<void> | null } = { held: null };
 const host = authHost([], read);
 const desk = createSettingsAccountsDesk();
 await desk.startAccountLogin("tok", "L1", "a1", false);
 await desk.pollAccountLogin("tok", "L1");
 const release = Promise.withResolvers<void>();
 read.held = release.promise;
 const keysBefore = host.of("pane.send_keys").length;
 const submitting = desk.submitAccountLogin("tok", "L1", "CODE").catch((error: Error) => error.message);
 await tick();
 const closing = desk.closeAccountLogin("tok", "L1");
 release.resolve();
 await closing;
 expect(await submitting).toBe("sign-in was closed");
 expect(sentText(host)).not.toContain("CODE");
 expect(host.of("pane.send_keys")).toHaveLength(keysBefore);
 expect(host.of("pane.close").map((c) => c.params.pane_id)).toEqual(["pane-1"]);
});

test("closing the sign-in while herdr takes the code's text sends no Enter after it", async () => {
 const text: { held: Promise<void> | null } = { held: null };
 const host = ownerLink(async (method) => {
  if (method === "pane.split") return { type: "pane_info", pane: { pane_id: "pane-1" } };
  if (method === "pane.read") return { type: "pane_read", read: { text: "https://claude.ai/oauth/authorize?x=1" } };
  if (method === "pane.send_text") { await text.held; return ok; }
  if (method === "pane.send_keys" || method === "pane.close") return ok;
 });
 const desk = createSettingsAccountsDesk();
 await desk.startAccountLogin("tok", "L1", "a1", false);
 const release = Promise.withResolvers<void>();
 text.held = release.promise;
 const keysBefore = host.of("pane.send_keys").length;
 const submitting = desk.submitAccountLogin("tok", "L1", "CODE").catch((error: Error) => error.message);
 await tick();
 expect(host.of("pane.send_text").at(-1)?.params.text).toBe("CODE");
 const closing = desk.closeAccountLogin("tok", "L1");
 release.resolve();
 await closing;
 expect(await submitting).toBe("sign-in was closed");
 expect(host.of("pane.send_keys")).toHaveLength(keysBefore);
});

test("a logout's pane close still under way holds its link's connection open until it has run", async () => {
 const close = { held: null as Promise<void> | null };
 const release = Promise.withResolvers<void>();
 close.held = release.promise;
 const alpha = authHost([], { held: null }, close);
 await createSettingsAccountsDesk({ logoutPollMs: 0 }).logoutSettingsAccount("tok", "a1");
 let switched = false;
 const switching = switchFrom(alpha, () => ownerLink(undefined, { hostID: "beta" })).then(() => { switched = true; });
 await tick(); await tick();
 expect(switched).toBe(false);
 release.resolve();
 await switching;
 expect(alpha.of("pane.close")).toHaveLength(1);
});

test("a refusal the follower met is retired once a refresh lets the browser in again", async () => {
 let reads = 0, refuse = true;
 updateHostWith("host-a", (method) => {
  if (method === "server.update_status") { reads++; if (reads > 2 && refuse) throw refused(); return { type: "update_status" }; }
 });
 const desk = createServerUpdateDesk({ pause: () => Promise.resolve() });
 await desk.settingsServerUpdate("tok", true);
 await desk.applySettingsServerUpdate("tok", "b6", false);
 await tick(); await tick();
 refuse = false;
 expect(JSON.parse(await desk.settingsServerUpdate("tok", true))).toMatchObject({ forbidden: false, code: "", message: "" });
});

test("a refusal met by the follower is retired when its next status read is answered (Look again)", async () => {
 let reads = 0, refuse = true;
 updateHostWith("host-a", (method) => {
  if (method === "server.update_status") { reads++; if (reads > 2 && refuse) throw refused(); return { type: "update_status" }; }
 });
 const paused = Promise.withResolvers<void>();
 const desk = createServerUpdateDesk({ pause: () => reads > 3 ? paused.promise : Promise.resolve() });
 await desk.settingsServerUpdate("tok", true);
 await desk.applySettingsServerUpdate("tok", "b6", false);
 await tick(); await tick();
 refuse = false;
 await desk.recheckSettingsServerUpdate("tok", true);
 await tick(); await tick();
 expect(JSON.parse(await desk.settingsServerUpdate("tok", false))).toMatchObject({ forbidden: false, code: "", message: "" });
});

// ---- Review round 5: cancellation reaches the transport; closes in flight are teardown ----

test("closing the sign-in while its Enter waits for the relay to admit it sends no Enter", async () => {
 const admission = Promise.withResolvers<void>();
 const host: ReturnType<typeof ownerLink> = ownerLink((method, params) => {
  if (method === "pane.split") return { type: "pane_info", pane: { pane_id: "pane-1" } };
  if (method === "pane.read") return { type: "pane_read", read: { text: "https://claude.ai/oauth/authorize?x=1" } };
  // The code's text is taken; the next frame (Enter) waits for a connection.
  if (method === "pane.send_text") { if (params.text === "CODE") host.host.admission = admission.promise; return ok; }
  if (method === "pane.send_keys" || method === "pane.close") return ok;
 });
 const desk = createSettingsAccountsDesk();
 await desk.startAccountLogin("tok", "L1", "a1", false);
 await desk.pollAccountLogin("tok", "L1");
 const keysBefore = host.of("pane.send_keys").length;
 const submitting = desk.submitAccountLogin("tok", "L1", "CODE").catch((error: Error) => error.message);
 await tick(); await tick();
 expect(sentText(host)).toContain("CODE");
 const closing = desk.closeAccountLogin("tok", "L1");
 await tick();
 host.host.admission = null;
 admission.resolve();
 await closing;
 expect(await submitting).toBe("sign-in was closed");
 expect(host.of("pane.send_keys")).toHaveLength(keysBefore);
 expect(host.of("pane.close").map((c) => c.params.pane_id)).toEqual(["pane-1"]);
});

test("a closed sign-in's pane.close still waiting for the relay holds the disconnect until it is sent", async () => {
 const alpha = authHost([]);
 const desk = createSettingsAccountsDesk();
 await desk.startAccountLogin("tok", "L1", "a1", false);
 const admission = Promise.withResolvers<void>();
 alpha.host.admission = admission.promise;
 const closing = desk.closeAccountLogin("tok", "L1");
 await tick();
 let switched = false;
 const switching = switchFrom(alpha, () => ownerLink(undefined, { hostID: "beta" })).then(() => { switched = true; });
 await tick(); await tick();
 expect(switched).toBe(false);
 admission.resolve();
 await switching; await closing;
 expect(alpha.of("pane.close").map((c) => c.params.pane_id)).toEqual(["pane-1"]);
});

test("the logout's end is its own printed status, never the command line's echo", () => {
 expect(logoutStatus(`$ sh -c 'env -u CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR="$1" claude auth logout; echo "herdrup-logout-abc12345-$?"' sh '/h'`, "abc12345")).toBeNull();
 expect(logoutStatus("Logged out.\nherdrup-logout-abc12345-0\n$ ", "abc12345")).toBe(0);
 expect(logoutStatus("herdrup-logout-abc12345-1", "abc12345")).toBe(1);
 expect(logoutStatus("herdrup-logout-other000-0", "abc12345")).toBeNull();
});

test("a logout lists the accounts again only once the command has finished", async () => {
 let reads = 0;
 const host: ReturnType<typeof ownerLink> = ownerLink((method) => {
  if (method === "pane.split") return { type: "pane_info", pane: { pane_id: "out" } };
  if (method === "pane.read") return { type: "pane_read", read: { text: authScreen(host.calls, ++reads >= 3) } };
  if (method === "pane.send_text" || method === "pane.send_keys" || method === "pane.close") return ok;
 });
 await createSettingsAccountsDesk({ logoutPollMs: 0 }).logoutSettingsAccount("tok", "a1");
 expect(reads).toBe(3);
 const order = host.calls.map((c) => c.method);
 expect(order.lastIndexOf("accounts.list")).toBeGreaterThan(order.lastIndexOf("pane.read"));
});

test("a logout whose end never shows is reported unconfirmed, and a failed one as failed", async () => {
 let status: string | null = null;
 const host: ReturnType<typeof ownerLink> = ownerLink((method) => {
  if (method === "pane.split") return { type: "pane_info", pane: { pane_id: "out" } };
  if (method === "pane.read") {
   const nonce = String(host.of("pane.send_text").at(-1)?.params.text).match(/herdrup-logout-(\w+)-\$\?/)?.[1];
   return { type: "pane_read", read: { text: status === null ? "Logging out…" : `herdrup-logout-${nonce}-${status}` } };
  }
  if (method === "pane.send_text" || method === "pane.send_keys" || method === "pane.close") return ok;
 });
 // A short deadline here (the timing is the behaviour): 15 s in the app.
 const desk = createSettingsAccountsDesk({ logoutPollMs: 5, logoutTimeoutMs: 40 });
 await expect(desk.logoutSettingsAccount("tok", "a1")).rejects.toThrow("Couldn't confirm the logout");
 status = "1";
 await expect(desk.logoutSettingsAccount("tok", "a1")).rejects.toThrow("claude auth logout failed (exit status 1)");
 await tick();
 expect(host.of("pane.close")).toHaveLength(2);
});

// ---- Review round 6 ----

test("a logout whose first screen read stalls is unconfirmed at its deadline, and its pane still closes", async () => {
 const stalled = Promise.withResolvers<void>();
 const host = ownerLink(async (method) => {
  if (method === "pane.split") return { type: "pane_info", pane: { pane_id: "out" } };
  if (method === "pane.read") { await stalled.promise; return { type: "pane_read", read: { text: "" } }; }
  if (method === "pane.send_text" || method === "pane.send_keys" || method === "pane.close") return ok;
 });
 // A short deadline here (the timing is the behaviour): 15 s in the app, against a 60 s read.
 await expect(withinSeconds(2, createSettingsAccountsDesk({ logoutTimeoutMs: 40 }).logoutSettingsAccount("tok", "a1"))).rejects.toThrow("Couldn't confirm the logout");
 await tick();
 expect(host.of("pane.close").map((c) => c.params.pane_id)).toEqual(["out"]);
 stalled.resolve();
});

test("a swap whose restart waits for the relay when Settings closes sends no restart", async () => {
 const admission = Promise.withResolvers<void>();
 let armed = false;
 const host: ReturnType<typeof ownerLink> = ownerLink((method) => {
  // The swap's own account check goes through; every frame after it (the first restart) waits.
  if (method === "accounts.list" && armed) { armed = false; host.host.admission = admission.promise; }
  if (method === "agent.restart") return { type: "agent_info", agent: {} };
 }, { agents: [{ pane_id: "p1", agent: "claude" }, { pane_id: "p2", agent: "claude" }] });
 await tick(); await tick(); // the account labels' first read
 armed = true;
 const desk = createSettingsAccountsDesk();
 const swapping = desk.swapSettingsAccount("tok", "a1").catch((error: Error) => error.message);
 await tick(); await tick();
 expect(host.of("agent.restart")).toEqual([]);
 setOwnerSettings("");
 host.host.admission = null;
 admission.resolve();
 expect(await swapping).toMatch(/Settings changed/);
 expect(host.of("agent.restart")).toEqual([]);
});


// ---- Review round 7: every Settings write carries the Settings scope into the transport ----

type Desks = { accounts: ReturnType<typeof createSettingsAccountsDesk>; update: ReturnType<typeof createServerUpdateDesk> };
/** Each Settings write, how a page makes it, and the read just before it (if any) once which the
 *  write is the next frame. */
const writes: { method: string; run: (d: Desks) => Promise<unknown>; after?: string; setup?: (d: Desks) => Promise<unknown> }[] = [
 { method: "accounts.create", run: (d) => d.accounts.createSettingsAccount("tok", "claude", "home") },
 { method: "accounts.remove", run: (d) => d.accounts.removeSettingsAccount("tok", "a1") },
 { method: "agent.restart", run: (d) => d.accounts.swapSettingsAccount("tok", "a1"), after: "accounts.list" },
 { method: "guest.update", run: () => guestsDesk.setGuestGramSharing("tok", "", "g1", true) },
 { method: "guest.revoke", run: () => guestsDesk.revokeGuestAccess("tok", "", "g1", false) },
 { method: "server.update_apply", run: (d) => d.update.applySettingsServerUpdate("tok", "b6", false), after: "server.update_status", setup: (d) => d.update.settingsServerUpdate("tok", true) },
];
const answers: Record<string, object> = {
 "accounts.create": { type: "accounts_list", accounts: [claude] }, "accounts.remove": { type: "accounts_list", accounts: [] },
 "agent.restart": { type: "agent_info", agent: {} }, "guest.update": { type: "guest_updated" }, "guest.revoke": { type: "guest_revoked" },
 "server.update_check": { type: "update_check", ...offered().check }, "server.update_status": { type: "update_status" }, "server.update_apply": { type: "update_apply", attempt_id: "at1" },
};

for (const write of writes) {
 test(`${write.method} waiting for the relay to admit it when Settings closes is never sent`, async () => {
  const admission = Promise.withResolvers<void>();
  let arm: string | null = null;
  const host: ReturnType<typeof ownerLink> = ownerLink((method) => {
   if (method === arm) { arm = null; host.host.admission = admission.promise; } // the next frame waits
   return answers[method];
  }, { agents: [{ pane_id: "p1", agent: "claude" }] });
  await tick(); await tick(); // the account labels' first read
  const desks: Desks = { accounts: createSettingsAccountsDesk(), update: createServerUpdateDesk({ pause: () => new Promise(() => {}) }) };
  await write.setup?.(desks);
  arm = write.after ?? null;
  const running = write.run(desks).catch((error: Error) => error.message);
  if (write.after === undefined) host.host.admission = admission.promise;
  await tick(); await tick();
  expect(host.of(write.method)).toEqual([]);
  setOwnerSettings(""); // Settings closes; its write is still waiting for admission
  host.host.admission = null;
  admission.resolve();
  expect(await running).toMatch(/Settings changed/);
  await tick(); await tick();
  expect(host.of(write.method)).toEqual([]);
 });
}

test("closing the sign-in during its account lookup ends it at once, and no pane is made", async () => {
 const lookup = Promise.withResolvers<void>();
 let hold = false;
 const host = ownerLink(async (method) => {
  if (method === "accounts.list" && hold) { hold = false; await lookup.promise; return { type: "accounts_list", accounts: [claude] }; }
  if (method === "pane.split") return { type: "pane_info", pane: { pane_id: "pane-1" } };
  if (method === "pane.send_text" || method === "pane.send_keys" || method === "pane.close") return ok;
 });
 await tick(); await tick();
 hold = true;
 const desk = createSettingsAccountsDesk();
 const starting = desk.startAccountLogin("tok", "L1", "a1", false).catch((error: Error) => error.message);
 await tick();
 const closing = desk.closeAccountLogin("tok", "L1");
 // The lookup carries the dialog's lifetime: the sign-in ends without waiting for its answer.
 expect(await Promise.race([starting, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50))])).toBe("sign-in was closed");
 lookup.resolve();
 await closing; await tick();
 expect([host.of("pane.split"), host.of("pane.close")]).toEqual([[], []]);
});

test("a logout whose Enter is never acknowledged is unconfirmed at its deadline, and its pane still closes", async () => {
 const host: ReturnType<typeof ownerLink> = ownerLink(async (method) => {
  if (method === "pane.split") return { type: "pane_info", pane: { pane_id: "out" } };
  if (method === "pane.send_keys") return new Promise(() => {}); // herdr took Enter; its answer never comes
  if (method === "pane.read") return { type: "pane_read", read: { text: authScreen(host.calls) } };
  if (method === "pane.send_text" || method === "pane.close") return ok;
 });
 // A short deadline here (the timing is the behaviour): 15 s in the app.
 await expect(withinSeconds(2, createSettingsAccountsDesk({ logoutTimeoutMs: 40 }).logoutSettingsAccount("tok", "a1"))).rejects.toThrow("Couldn't confirm the logout");
 await tick();
 expect(host.of("pane.close").map((c) => c.params.pane_id)).toEqual(["out"]);
});

// ---- Review round 8 ----

/** A host whose frame after `after` (an accounts.list) waits for admission: a pane.split next. */
function admissionAfterList(admission: Promise<void>) {
 let armed = false;
 const host: ReturnType<typeof ownerLink> = ownerLink((method) => {
  if (method === "accounts.list" && armed) { armed = false; host.host.admission = admission; }
  if (method === "pane.split") return { type: "pane_info", pane: { pane_id: "pane-1" } };
  if (method === "pane.send_text" || method === "pane.send_keys" || method === "pane.close") return ok;
 });
 return { host, arm: () => { armed = true; } };
}

test("closing the sign-in while its pane.split waits for the relay makes no pane", async () => {
 const admission = Promise.withResolvers<void>();
 const { host, arm } = admissionAfterList(admission.promise);
 await tick(); await tick(); // the account labels' first read
 arm();
 const desk = createSettingsAccountsDesk();
 const starting = desk.startAccountLogin("tok", "L1", "a1", false).catch((error: Error) => error.message);
 await tick(); await tick();
 expect(host.of("pane.split")).toEqual([]);
 const closing = desk.closeAccountLogin("tok", "L1");
 host.host.admission = null;
 admission.resolve();
 await closing;
 expect(await starting).toBe("sign-in was closed");
 await tick();
 expect([host.of("pane.split"), host.of("pane.close")]).toEqual([[], []]);
});

test("closing Settings while a logout's pane.split waits for the relay makes no pane", async () => {
 const admission = Promise.withResolvers<void>();
 const { host, arm } = admissionAfterList(admission.promise);
 await tick(); await tick();
 arm();
 const logout = createSettingsAccountsDesk({ logoutPollMs: 0 }).logoutSettingsAccount("tok", "a1").catch((error: Error) => error.message);
 await tick(); await tick();
 expect(host.of("pane.split")).toEqual([]);
 setOwnerSettings("");
 host.host.admission = null;
 admission.resolve();
 expect(await logout).toMatch(/Settings changed/);
 await tick();
 expect([host.of("pane.split"), host.of("pane.close")]).toEqual([[], []]);
});

test("the machine's version ping waiting for the relay when Settings closes is never sent", async () => {
 const admission = Promise.withResolvers<void>();
 const host = ownerLink();
 await tick(); await tick();
 const identities = new MemoryIdentityStore();
 const desk = createGuestDesk({ identities, grants: new MemoryGrantStore(), owner: new MemoryOwnerHint() });
 const pingsBefore = host.of("ping").length;
 host.host.admission = admission.promise;
 const version = desk.settingsMachineVersion("tok").catch((error: Error) => error.message);
 await tick();
 setOwnerSettings("");
 host.host.admission = null;
 admission.resolve();
 expect(await version).toMatch(/Settings changed/);
 expect(host.of("ping")).toHaveLength(pingsBefore);
});

test("the update card's ping waiting for the relay when Settings closes is never sent", async () => {
 const admission = Promise.withResolvers<void>();
 const host = updateHostWith("host-a", () => undefined);
 await tick(); await tick();
 const pingsBefore = host.of("ping").length;
 host.host.admission = admission.promise;
 const reading = createServerUpdateDesk({ pause: () => new Promise(() => {}) }).settingsServerUpdate("tok", true).catch((error: Error) => error.message);
 await tick();
 setOwnerSettings("");
 host.host.admission = null;
 admission.resolve();
 expect(await reading).toMatch(/Settings changed/);
 expect(host.of("ping")).toHaveLength(pingsBefore);
});

test("an account whose id is constructor keeps its label on the rows", async () => {
 ownerLink(undefined, { accounts: [{ ...claude, id: "constructor", label: "Work" }, { ...claude, id: "constructor", label: "later" }] });
 await tick(); await tick();
 expect(accountLabel("constructor", await createSettingsAccountsDesk().accounts())).toBe("Work");
});

// The transport itself (round 8): sendSignal ends a request while it waits for a connection, never
// once its frame is out.
const accessOn = (relay: ReturnType<typeof startRelay>) => ({
 guestID: "grant-1", guestName: "visitor", machineLabel: "Machine", ownerName: "Owner", agentName: "Worker", agentTarget: "%42",
 endpoint: { relay: relay.url, hostID: relay.hostID, hostPublicKey: relay.hostPublic }, acceptedAt: new Date(),
});

test("a request's sendSignal ending while the relay holds its connection: nothing is sent", async () => {
 const admitted = Promise.withResolvers<void>();
 const lines: string[] = [];
 const relay = startRelay({
  async serve(_conn, handshake) {
   await admitted.promise; // the relay hasn't admitted the connection yet
   const session = (await handshake()).reply({ ok: true, guest_id: "grant-1", features: { multi_request: true } });
   for (;;) { const line = await session.readLine(); if (line === null) return; lines.push(line); }
  },
 });
 const transport = new GuestTransport(guestLink(accessOn(relay)), staticKey(await generateIdentity()));
 try {
  const unsent = new AbortController();
  // Through the page's link to the transport (link.ts transportLink), as the Desk's calls go.
  const calling = transportLink({} as GuestAccess, transport).call("pane.split", {}, undefined, unsent.signal).then(() => "answered", () => "ended");
  await new Promise((r) => setTimeout(r, 50));
  unsent.abort(new Error("Settings changed"));
  admitted.resolve();
  expect(await calling).toBe("ended");
  await new Promise((r) => setTimeout(r, 100));
  expect(lines).toEqual([]);
 } finally { transport.close(); relay.stop(); }
});

test("a request's sendSignal ending once its frame is out: its answer is still awaited", async () => {
 const got = Promise.withResolvers<void>();
 const answer = Promise.withResolvers<void>();
 const relay = startRelay({
  async serve(_conn, handshake) {
   const session = (await handshake()).reply({ ok: true, guest_id: "grant-1", features: { multi_request: true } });
   const line = await session.readLine();
   got.resolve();
   await answer.promise;
   session.write(JSON.stringify({ id: (JSON.parse(line!) as { id: string }).id, result: { type: "pane_info", pane: { pane_id: "made" } } }) + "\n");
  },
 });
 const transport = new GuestTransport(guestLink(accessOn(relay)), staticKey(await generateIdentity()));
 try {
  const unsent = new AbortController();
  const calling = transport.call("pane.split", {}, { sendSignal: unsent.signal });
  await got.promise;
  unsent.abort(new Error("Settings changed"));
  answer.resolve();
  expect(await calling).toEqual({ type: "pane_info", pane: { pane_id: "made" } });
 } finally { transport.close(); relay.stop(); }
});

// ---- Over a real owner link ----

test("over a real owner link, Settings' accounts come from herdr, and an older host's refusal is the owner refusal", async () => {
 let refuse = false;
 const relay = startRelay({
  async serve(_conn, handshake) {
   const h = await handshake();
   const session: HostSession = h.reply({ ok: true, mode: "owner", grant_id: "g1", scope: "terminal", expires_unix: 1_800_000_000, account: { deadline_unix: Math.floor(Date.now() / 1000) + 660 }, features: { owner: 2, multi_request: true } });
   for (;;) {
    const line = await session.readLine();
    if (line === null) return;
    const req = JSON.parse(line) as { id: string; method: string };
    const body = req.method === "agent.list" ? { result: { type: "agent_list", agents: [] } }
     : req.method === "accounts.list" && !refuse ? { result: { type: "accounts_list", accounts: [claude] } }
     : req.method === "pane.stream" ? { result: { type: "stream_started" } }
     : { error: { code: "owner_forbidden", message: "no" } };
    session.write(JSON.stringify({ id: req.id, ...body }) + "\n");
   }
  },
 });
 const identities = new MemoryIdentityStore();
 await identities.add(await generateIdentity());
 const desk = createGuestDesk({ identities, grants: new MemoryGrantStore(), owner: new MemoryOwnerHint(), webSocket: (url) => new WebSocket(url) });
 try {
  const statements: StatementSource = { get: async () => ({ jws: "jws", expMs: Date.now() + 600_000 }), drop() {} };
  const machine: EnvelopeMachine = { hostItemID: "H1", label: "dev2306", relay: relay.url, hostID: relay.hostID, nodePub: toB64url(relay.hostPublic), grantID: "g1", scope: "terminal", expiresUnix: 1_800_000_000 };
  const listed = Promise.withResolvers<void>();
  const off = events.boardChanged.on((b) => { if (b?.machineID === `owner:${relay.hostID}`) listed.resolve(); });
  await desk.connectOwner(machine, statements, "x", new AbortController().signal);
  await listed.promise; off();
  await desk.openSettings(`owner:${relay.hostID}`, "", "settings-1");
  const accounts = createSettingsAccountsDesk();
  expect(JSON.parse(await accounts.settingsAccounts("settings-1")).accounts[0].id).toBe("a1");
  refuse = true;
  await expect(accounts.settingsAccounts("settings-1")).rejects.toBeInstanceOf(OwnerRefusedError);
 } finally { desk.disconnectOwner(); relay.stop(); }
});

test("leaving an owner link closes its transport once, after its groups' cleanup", async () => {
 const relay = startRelay({
  async serve(_conn, handshake) {
   const h = await handshake();
   const session: HostSession = h.reply({ ok: true, mode: "owner", grant_id: "g1", scope: "terminal", expires_unix: 1_800_000_000, account: { deadline_unix: Math.floor(Date.now() / 1000) + 660 }, features: { owner: 2, multi_request: true } });
   for (;;) {
    const line = await session.readLine();
    if (line === null) return;
    const req = JSON.parse(line) as { id: string; method: string };
    session.write(JSON.stringify({ id: req.id, ...(req.method === "agent.list" ? { result: { type: "agent_list", agents: [] } } : { error: { code: "owner_forbidden", message: "no" } }) }) + "\n");
   }
  },
 });
 const close = GuestTransport.prototype.close;
 const closes: GuestTransport[] = [];
 GuestTransport.prototype.close = function (this: GuestTransport) { closes.push(this); return close.call(this); };
 const identities = new MemoryIdentityStore();
 await identities.add(await generateIdentity());
 const desk = createGuestDesk({ identities, grants: new MemoryGrantStore(), owner: new MemoryOwnerHint(), webSocket: (url) => new WebSocket(url) });
 try {
  const statements: StatementSource = { get: async () => ({ jws: "jws", expMs: Date.now() + 600_000 }), drop() {} };
  const machine: EnvelopeMachine = { hostItemID: "H1", label: "dev2306", relay: relay.url, hostID: relay.hostID, nodePub: toB64url(relay.hostPublic), grantID: "g1", scope: "terminal", expiresUnix: 1_800_000_000 };
  const listed = Promise.withResolvers<void>();
  const off = events.boardChanged.on((b) => { if (b?.machineID === `owner:${relay.hostID}`) listed.resolve(); });
  await desk.connectOwner(machine, statements, "x", new AbortController().signal);
  await listed.promise; off();
  const cleanup = Promise.withResolvers<void>();
  onLinkClosing(currentOwnerLink()!, () => cleanup.promise);
  desk.disconnectOwner();
  // runGuest ends with the link meanwhile; the connection waits for the cleanup all the same.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  expect(closes).toHaveLength(0);
  cleanup.resolve();
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  expect(closes).toHaveLength(1);
 } finally { GuestTransport.prototype.close = close; relay.stop(); }
});
