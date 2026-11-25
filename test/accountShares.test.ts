// Account-linked guest shares (#700, owner pick A): the shared invitation's keep choices
// (guestAccept.ts acceptChoices: plain, signed in, signed out), the notice after a share went into
// the account (notices.ts), SHARED WITH YOU's rows (sharedWithYou.ts: grants and synced shares by
// machine, openSyncedShare), the browser's start with the landing's bind=1 and provider (web/start.ts:
// a bind at once, a named sign-in with the invite kept in the tab, its resume) and the choice the
// page asks with (web/bindChoice.ts), and Leave share's words (guestHome.ts). The refusals come
// worded from Go (internal/guest/session.go). The app's Desk calls go to a fake mygo bridge;
// test/fakeDom.ts stands in for the DOM.
import { afterEach, expect, test } from "bun:test";
import { acceptChoices, type Keep } from "../src/guestAccept";
import { accountNote, sharedLine, sharedMachines, sharedSection, syncedSharesNow } from "../src/sharedWithYou";
import { accountShareNotice, showAccountShareNotice } from "../src/notices";
import { leaveWords } from "../src/guestHome";
import { errorText } from "../src/errors";
import { bindRequest, PENDING_BIND_KEY, pendingBindWaits, start, takePendingBind, type Started } from "../src/web/start";
import { showBindChoice, signInToBind, type BindPage } from "../src/web/bindChoice";
import { createAccountDesk } from "../src/web/accountDesk";
import { notInvite } from "../src/webguest/errors";
import { Desk, type Access, type SyncedShare } from "../src/mygo";
import { FakeDocument, type FakeElement } from "./fakeDom";

const G = globalThis as { document?: unknown; mygo?: unknown; ResizeObserver?: unknown };
const saved = { document: G.document, mygo: G.mygo, ResizeObserver: G.ResizeObserver };
afterEach(() => { G.document = saved.document; G.mygo = saved.mygo; G.ResizeObserver = saved.ResizeObserver; });

/** A fake document and bridge: answers by Desk method, records calls, and emits Go events. */
function bridge(answers: Record<string, unknown>) {
 const doc = new FakeDocument();
 G.document = doc;
 G.ResizeObserver = class { observe() {} };
 const calls: unknown[][] = [];
 const listeners = new Map<string, Set<(payload: unknown) => void>>();
 G.mygo = {
  on: (name: string, l: (payload: unknown) => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(l); return () => listeners.get(name)?.delete(l); },
  call: async (method: string, ...args: unknown[]) => {
   calls.push([method, ...args]);
   const answer = answers[method];
   if (answer instanceof Error) throw answer;
   return typeof answer === "function" ? answer(...args) : answer;
  },
 };
 const emit = (name: string, payload: unknown) => { for (const l of listeners.get(name) ?? []) l(payload); };
 return { doc, calls, emit };
}
/** Lets the fake bridge's answers and what awaits them run: promise jobs only, no clock. */
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const buttons = (root: unknown) => (root as FakeElement).all().filter(n => n.tagName === "button");
const named = (root: unknown, text: string) => buttons(root).find(b => b.text().includes(text))!;
const shown = (root: unknown) => (root as FakeElement).all().filter(n => n.shown()).map(n => n.textContent).filter(Boolean);

function choices(invite: { account: boolean }) {
 const redeemed: [Keep, string][] = [];
 const reported: unknown[] = [];
 return { redeemed, reported, made: acceptChoices(invite, (keep, pressed) => { redeemed.push([keep, pressed.textContent || (pressed as unknown as FakeElement).text()]); }, f => reported.push(f)) };
}

test("a plain invite keeps today's Accept, which keeps the share on this device", async () => {
 const { calls } = bridge({});
 const { made, redeemed } = choices({ account: false });
 const { root } = await made;
 expect(buttons(root).map(b => b.textContent)).toEqual(["Accept"]);
 named(root, "Accept").click();
 expect(redeemed).toEqual([["device", "Accept"]]);
 // No account question asked.
 expect(calls).toEqual([]);
});

test("signed in (g2): who is signed in, then Only this device or Add to my account, both capsules", async () => {
 bridge({ "Desk.AccountState": { signedIn: true, displayHint: "nike@example.com" } });
 const { made, redeemed } = choices({ account: true });
 const { root } = await made;
 expect(shown(root)).toContain("Signed in as nike@example.com");
 expect(buttons(root).map(b => b.textContent)).toEqual(["Only this device", "Add to my account"]);
 expect(named(root, "Add to my account").className).toContain("button-filled");
 expect(named(root, "Only this device").className).toContain("button-secondary");
 named(root, "Add to my account").click();
 named(root, "Only this device").click();
 expect(redeemed).toEqual([["account", "Add to my account"], ["device", "Only this device"]]);
});

test("signed out (g1): sign in with a provider, then the share goes in the account; or Only this device", async () => {
 const { calls, emit } = bridge({ "Desk.AccountState": { signedIn: false }, "Desk.AccountProviders": ["apple", "google"], "Desk.AccountSignIn": undefined });
 const { made, redeemed } = choices({ account: true });
 const { root, buttons: all } = await made;
 expect(shown(root)).toContain("Keep it on all your devices");
 expect(buttons(root).map(b => b.text())).toEqual(["Continue with Apple", "Continue with Google", "Only this device"]);
 named(root, "Continue with Google").click();
 await settle();
 expect(calls).toContainEqual(["Desk.AccountSignIn", "google"]);
 expect(shown(root)).toContain("Finish signing in in your browser.");
 expect(all.every(b => b.disabled)).toBe(true);
 emit("account:changed", { signedIn: false });
 expect(redeemed).toEqual([]);
 emit("account:changed", { signedIn: true, displayHint: "nike@example.com" });
 expect(redeemed).toEqual([["account", "Continue with Google"]]);
 // Signed in once: a later account change accepts nothing more.
 emit("account:changed", { signedIn: true });
 expect(redeemed.length).toBe(1);

 const other = choices({ account: true });
 const second = await other.made;
 named(second.root, "Only this device").click();
 expect(other.redeemed).toEqual([["device", "Only this device"]]);
});

test("signed out with no sign-in offered: the plain Accept", async () => {
 bridge({ "Desk.AccountState": { signedIn: false }, "Desk.AccountProviders": [] });
 const { made } = choices({ account: true });
 expect(buttons((await made).root).map(b => b.textContent)).toEqual(["Accept"]);
});

test("a failed sign-in reports and gives the choices back; closing the sheet stops the wait", async () => {
 const { emit } = bridge({ "Desk.AccountState": { signedIn: false }, "Desk.AccountProviders": ["apple"], "Desk.AccountSignIn": new Error("the browser didn't open") });
 const { made, redeemed, reported } = choices({ account: true });
 const { root, buttons: all, dispose } = await made;
 named(root, "Continue with Apple").click();
 await settle();
 expect(reported.map(errorText)).toEqual(["the browser didn't open"]);
 expect(all.every(b => !b.disabled)).toBe(true);
 emit("account:changed", { signedIn: true });
 expect(redeemed).toEqual([]);
 dispose();
});

test("g3: after a share went into the account, one quiet line with OK among the window's notices", () => {
 const { doc } = bridge({});
 const notice = showAccountShareNotice("enyo") as unknown as FakeElement;
 expect(notice.parent?.id).toBe("notices");
 expect(notice.text()).toBe("enyo is in your HerdrUp account. Sign in on your other devices to open it there.OK");
 expect(accountShareNotice("enyo")).toBe("enyo is in your HerdrUp account. Sign in on your other devices to open it there.");
 const ok = named(notice, "OK");
 expect(ok.className).toBe("button-secondary button-compact");
 // A second replaces the first; OK takes it away.
 const again = showAccountShareNotice("landing") as unknown as FakeElement;
 expect(notice.parent).toBeNull();
 named(again, "OK").click();
 expect(doc.getElementById("notices")!.children).toEqual([]);
});

const grant = (hostID: string, guestID: string, agentName: string, ownerName: string, machineLabel: string, accountBound = false): Access => ({
 guestID, guestName: "nike", machineLabel, ownerName, agentName, agentTarget: "t1", acceptedAt: "2026-11-25T00:00:00Z", accountBound,
 endpoint: { relay: "https://guest.herdrup.app", hostID, hostPublicKey: "" },
});
const share = (hostID: string, guestID: string, agentName: string, ownerName: string, machineLabel: string, local: boolean): SyncedShare => ({
 id: `${hostID}/${guestID}`, relay: "https://guest.herdrup.app", hostID, nodePub: "", guestID, agentName, ownerName, machineLabel, shareGram: false, local,
});

test("SHARED WITH YOU: one row per machine from the grants held here and the account's shares (g4, g5)", () => {
 const grants = [grant("H1", "g1", "enyo", "jerry", "hetzner", true)];
 const synced = [share("H1", "g1", "enyo", "jerry", "hetzner", true), share("H1", "g2", "orgstudio", "jerry", "hetzner", false), share("H2", "g3", "landing", "maya", "", false)];
 const rows = sharedMachines(grants, synced);
 expect(rows.map(r => [r.machine, sharedLine(r), r.open, r.fromAccount])).toEqual([
  ["hetzner", "enyo, orgstudio · shared by jerry", { kind: "grant", id: "H1/g1" }, false],
  ["landing", "landing · shared by maya", { kind: "synced", id: "H2/g3" }, true],
 ]);
 expect(accountNote(rows)).toBe("From your HerdrUp account: nothing to accept here. maya sees each device you open it on.");
 // Only the account has hetzner (g4): it opens with openSyncedShare.
 const remote = sharedMachines([], [share("H1", "g1", "enyo", "jerry", "hetzner", false)]);
 expect(remote.map(r => [r.machine, sharedLine(r), r.open])).toEqual([["hetzner", "enyo · shared by jerry", { kind: "synced", id: "H1/g1" }]]);
 expect(sharedMachines([], [])).toEqual([]);
 expect(accountNote(sharedMachines(grants, []))).toBeNull();
 expect(sharedLine({ agents: ["enyo"], owner: "" })).toBe("enyo");
});

test("a row the account brought opens with openSyncedShare; one held here connects its grant", async () => {
 const { calls } = bridge({ "Desk.OpenSyncedShare": undefined, "Desk.ConnectGuest": undefined });
 const symbol = async () => (G.document as FakeDocument).createElement("span") as unknown as HTMLElement;
 let opened = 0;
 const section = sharedSection(symbol, () => { opened++; }, () => {});
 const root = section.root as unknown as FakeElement;
 expect(root.hidden).toBe(true);
 const rows = sharedMachines([grant("H2", "g9", "landing", "maya", "mac-mini")], [share("H1", "g1", "enyo", "jerry", "hetzner", false)]);
 expect(await section.draw(rows)).toBe(2);
 expect(root.shown()).toBe(true);
 expect(shown(root)).toContain("From your HerdrUp account: nothing to accept here. jerry sees each device you open it on.");
 named(root, "hetzner").click();
 await settle();
 named(root, "mac-mini").click();
 await settle();
 expect(calls).toEqual([["Desk.OpenSyncedShare", "H1/g1"], ["Desk.ConnectGuest", "H2/g9"]]);
 expect(opened).toBe(2);
 await section.draw([]);
 expect(root.hidden).toBe(true);
});

test("the account's shares are asked for only when signed in; a list that can't be read is none", async () => {
 const { calls } = bridge({ "Desk.SyncedShares": [share("H1", "g1", "enyo", "jerry", "hetzner", false)] });
 expect(await syncedSharesNow(false)).toEqual([]);
 expect((await syncedSharesNow(true)).map(s => s.id)).toEqual(["H1/g1"]);
 expect(calls).toEqual([["Desk.SyncedShares"]]);
 bridge({ "Desk.SyncedShares": new Error("offline") });
 expect(await syncedSharesNow(true)).toEqual([]);
});

test("the landing's fragment: <payload>, then bind=1, then provider=apple|google; any other shape is refused", () => {
 expect(bindRequest("PAYLOAD")).toEqual({ payload: "PAYLOAD", bind: false, provider: null });
 expect(bindRequest("PAYLOAD&bind=1")).toEqual({ payload: "PAYLOAD", bind: true, provider: null });
 expect(bindRequest("PAYLOAD&bind=1&provider=apple")).toEqual({ payload: "PAYLOAD", bind: true, provider: "apple" });
 expect(bindRequest("PAYLOAD&bind=1&provider=google")).toEqual({ payload: "PAYLOAD", bind: true, provider: "google" });
 expect(bindRequest("")).toEqual({ payload: "", bind: false, provider: null });
 for (const refused of ["PAYLOAD&bind=1&provider=github", "PAYLOAD&bind=2", "PAYLOAD&bind=10", "PAYLOAD&keep=1", "PAYLOAD&provider=apple",
  "PAYLOAD&bind=1&bind=1", "PAYLOAD&bind=1&provider=apple&provider=google", "PAYLOAD&bind=1&provider=apple&x=1", "PAYLOAD&provider=apple&bind=1",
  "PAYLOAD&bind=1&provider=", "PAYLOAD&", "&bind=1"]) expect(bindRequest(refused)).toBeNull();
});

/** This tab's sessionStorage. */
function tabStorage(entries: [string, string][] = []) {
 const items = new Map(entries);
 return { items, storage: { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); }, removeItem: (k: string) => { items.delete(k); } } };
}
const KEPT: [string, string] = [PENDING_BIND_KEY, JSON.stringify({ payload: "PAYLOAD", bind: true })];

/** start() against a desk that records each accept's text and keep. */
async function startWith(fragment: string, account: { signedIn: boolean; pending?: string | null; signIn?: { problem: string | null } | null }, bound = true, held: Access[] = []) {
 const keeps: string[] = [], connects: string[] = [];
 let asked = 0;
 const desk = {
  sharedConnections: async () => held,
  acceptGuestInvitation: async (text: string, keep: string) => { keeps.push(`${text} ${keep}`); return grant("H", "G", "enyo", "jerry", "hetzner", bound && keep === "account"); },
  connectGuest: async (id: string) => { connects.push(id); },
 };
 const started = await start(desk, fragment, "https://guest.herdrup.app", () => null, {
  signedIn: async () => { asked++; return account.signedIn; }, pending: account.pending ?? null, signIn: account.signIn ?? null,
 });
 return { keeps, asked, started, connects };
}

test("only the payload reaches the invite decoder; a fragment of another shape is refused as a malformed invite", async () => {
 expect((await startWith("PAYLOAD&bind=1&provider=apple", { signedIn: true })).keeps).toEqual(["herdrup://guest-invite#PAYLOAD account"]);
 expect((await startWith("PAYLOAD", { signedIn: true })).keeps).toEqual(["herdrup://guest-invite#PAYLOAD device"]);
 const refused = await startWith("PAYLOAD&bind=1&provider=github", { signedIn: false });
 expect(refused).toEqual({ keeps: [], asked: 0, connects: [], started: { kind: "welcome", welcome: { owner: null, error: errorText(notInvite()) } } });
 // With a share held here, the refused link opens it, as a failed redemption does.
 const held = await startWith("PAYLOAD&bind=2", { signedIn: true }, true, [grant("H", "G0", "enyo", "jerry", "hetzner")]);
 expect(held).toEqual({ keeps: [], asked: 0, connects: ["H/G0"], started: { kind: "connected", id: "H/G0" } });
});

test("signed in, bind=1 binds at once, whatever provider the landing named; a plain link stays on this browser", async () => {
 const bound = { keeps: ["herdrup://guest-invite#PAYLOAD account"], asked: 1, connects: ["H/G"], started: { kind: "connected", id: "H/G", inAccount: "enyo" } };
 expect(await startWith("PAYLOAD&bind=1", { signedIn: true })).toEqual(bound);
 expect(await startWith("PAYLOAD&bind=1&provider=google", { signedIn: true })).toEqual(bound);
 expect(await startWith("PAYLOAD", { signedIn: true })).toEqual({ keeps: ["herdrup://guest-invite#PAYLOAD device"], asked: 0, connects: ["H/G"], started: { kind: "connected", id: "H/G" } });
 // Asked for the account but not bound by the machine: no notice.
 expect((await startWith("PAYLOAD&bind=1", { signedIn: true }, false)).started).toEqual({ kind: "connected", id: "H/G" });
});

test("signed out, bind=1 never falls back to this browser: a named provider signs in, else the page asks", async () => {
 expect(await startWith("PAYLOAD&bind=1&provider=apple", { signedIn: false })).toEqual({ keeps: [], asked: 1, connects: [], started: { kind: "signIn", payload: "PAYLOAD", provider: "apple" } });
 expect(await startWith("PAYLOAD&bind=1", { signedIn: false })).toEqual({ keeps: [], asked: 1, connects: [], started: { kind: "bind", payload: "PAYLOAD", problem: "" } });
});

/** The page the bind choice draws on: what it showed, and how it ended. */
function bindPage(tab = tabStorage()) {
 const log: string[] = [], done: Started[] = [];
 let card: FakeElement | null = null;
 const page: BindPage = {
  origin: "https://guest.herdrup.app", storage: () => tab.storage, owner: () => null,
  show: c => { card = c as unknown as FakeElement; log.push("show"); }, opening: () => { log.push("opening"); }, done: s => { done.push(s); },
 };
 return { tab, page, log, done, card: () => card! };
}
const INVITE = { machineLabel: "hetzner", ownerName: "jerry", agentName: "enyo", guestName: "nike", expires: "2026-12-01T00:00:00Z", fingerprint: "AB:CD", account: false };

test("a named provider keeps the invite in this tab and starts that sign-in with no screen", async () => {
 const { calls } = bridge({ "Desk.AccountProviders": ["apple", "google"], "Desk.AccountSignIn": undefined });
 const p = bindPage();
 await signInToBind("PAYLOAD", "google", p.page);
 expect(calls).toEqual([["Desk.AccountProviders"], ["Desk.AccountSignIn", "google"]]);
 expect(p.log).toEqual([]);
 expect([...p.tab.items]).toEqual([KEPT]);
});

test("a named sign-in that can't start lets the invite go and asks, with why", async () => {
 const { calls } = bridge({ "Desk.AccountProviders": ["apple", "google"], "Desk.AccountSignIn": new Error("Sign-in isn't available right now."),
  "Desk.InspectGuestInvitation": INVITE, "Desk.AccountState": { signedIn: false } });
 const p = bindPage();
 await signInToBind("PAYLOAD", "apple", p.page);
 expect(p.tab.items.size).toBe(0);
 expect(p.log).toEqual(["show"]);
 expect(shown(p.card())).toContain("Sign-in isn't available right now.");
 expect(calls).toContainEqual(["Desk.InspectGuestInvitation", "herdrup://guest-invite#PAYLOAD"]);
});

test("back from the sign-in with a session: the kept invite is taken (the key gone) and goes in the account", async () => {
 const tab = tabStorage([KEPT]);
 // Boot gives this load the guest page (boot.ts: a kept invite counts as the fragment).
 expect(pendingBindWaits(() => tab.storage)).toBe(true);
 const pending = takePendingBind(() => tab.storage);
 expect(pendingBindWaits(() => tab.storage)).toBe(false);
 expect(pending).toBe("PAYLOAD");
 expect(tab.items.size).toBe(0);
 expect(takePendingBind(() => tab.storage)).toBeNull();
 expect(await startWith("", { signedIn: true, pending, signIn: { problem: null } })).toEqual({ keeps: ["herdrup://guest-invite#PAYLOAD account"], asked: 1, connects: ["H/G"], started: { kind: "connected", id: "H/G", inAccount: "enyo" } });
 // Back from the provider without an answer: asked again, nothing accepted.
 expect(await startWith("", { signedIn: false, pending, signIn: null })).toEqual({ keeps: [], asked: 0, connects: [], started: { kind: "bind", payload: "PAYLOAD", problem: "" } });
 // A load with no invite kept: the plain start.
 expect((await startWith("", { signedIn: true, pending: null, signIn: { problem: null } })).started).toEqual({ kind: "welcome", welcome: { owner: null } });
});

test("a sign-in that ended with an error: the key cleared, the choice again with the error in words", async () => {
 const tab = tabStorage([KEPT]);
 const pending = takePendingBind(() => tab.storage);
 expect(tab.items.size).toBe(0);
 const problem = "The sign-in took too long. Sign in again.";
 const { started } = await startWith("", { signedIn: false, pending, signIn: { problem } });
 expect(started).toEqual({ kind: "bind", payload: "PAYLOAD", problem });

 bridge({ "Desk.InspectGuestInvitation": INVITE, "Desk.AccountState": { signedIn: false }, "Desk.AccountProviders": ["apple", "google"] });
 const p = bindPage(tab);
 await showBindChoice("PAYLOAD", problem, p.page);
 expect(shown(p.card())).toContain("jerry shared enyo with you");
 expect(shown(p.card())).toContain(problem);
 expect(buttons(p.card()).map(b => b.text())).toEqual(["Continue with Apple", "Continue with Google", "Only this device"]);
 expect(tab.items.size).toBe(0);
});

test("the web account says how the sign-in ended once: the page that shows it takes it", async () => {
 const fail = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
 const here = { key: async () => null, name: "", storage: () => ({ getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 }), locks: null, background: false };
 const replaced: string[] = [];
 const page = (href: string) => ({ origin: "https://guest.herdrup.app", href, fetch: fail, navigate() {}, replaceURL: (url: string) => { replaced.push(url); } });
 const failed = createAccountDesk(page("https://guest.herdrup.app/web/?account_error=flow_expired"), here);
 expect(replaced).toEqual(["https://guest.herdrup.app/web/"]);
 expect(failed.signInEnded()).toEqual({ problem: "The sign-in took too long. Sign in again." });
 expect((await failed.desk.accountState()).problem).toBeUndefined();
 expect(createAccountDesk(page("https://guest.herdrup.app/web/?account=1"), here).signInEnded()).toEqual({ problem: null });
 expect(createAccountDesk(page("https://guest.herdrup.app/web/"), here).signInEnded()).toBeNull();
});

test("Only this device accepts on this browser and clears the kept invite; a provider keeps it and signs in", async () => {
 const { calls } = bridge({ "Desk.InspectGuestInvitation": INVITE, "Desk.AccountState": { signedIn: false }, "Desk.AccountProviders": ["apple", "google"],
  "Desk.AcceptGuestInvitation": grant("H", "G", "enyo", "jerry", "hetzner"), "Desk.ConnectGuest": undefined, "Desk.AccountSignIn": undefined });
 const p = bindPage(tabStorage([KEPT]));
 await showBindChoice("PAYLOAD", "", p.page);
 named(p.card(), "Only this device").click();
 await settle();
 expect(p.tab.items.size).toBe(0);
 expect(calls).toContainEqual(["Desk.AcceptGuestInvitation", "herdrup://guest-invite#PAYLOAD", "device"]);
 expect(p.log).toEqual(["show", "opening"]);
 expect(p.done).toEqual([{ kind: "connected", id: "H/G" }]);

 const q = bindPage();
 await showBindChoice("PAYLOAD", "", q.page);
 named(q.card(), "Continue with Apple").click();
 await settle();
 expect([...q.tab.items]).toEqual([KEPT]);
 expect(calls).toContainEqual(["Desk.AccountSignIn", "apple"]);
});

test("a choice's sign-in that fails to start lets the kept invite go and says why", async () => {
 bridge({ "Desk.InspectGuestInvitation": INVITE, "Desk.AccountState": { signedIn: false }, "Desk.AccountProviders": ["apple"], "Desk.AccountSignIn": new Error("Sign-in isn't available right now.") });
 const p = bindPage();
 await showBindChoice("PAYLOAD", "", p.page);
 named(p.card(), "Continue with Apple").click();
 await settle();
 expect(p.tab.items.size).toBe(0);
 expect(shown(p.card())).toContain("Sign-in isn't available right now.");
});

test("leaving a share in the account says it leaves every device; a plain share, this device", () => {
 const plain = leaveWords({ machineLabel: "hetzner", agentName: "enyo", ownerName: "jerry", accountBound: false });
 expect(plain).toEqual({ title: "Leave hetzner?", message: "enyo disappears from this device.", note: "You stop seeing enyo. To come back, jerry has to send a new invite." });
 const bound = leaveWords({ machineLabel: "hetzner", agentName: "enyo", ownerName: "jerry", accountBound: true });
 expect(bound).toEqual({ title: "Leave hetzner on all your devices?", message: "enyo disappears from every device signed in to your HerdrUp account.", note: "You stop seeing enyo on all your devices. To come back, jerry has to send a new invite." });
});
