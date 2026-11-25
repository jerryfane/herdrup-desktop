// Account-linked guest shares (#700, owner pick A): the shared invitation's keep choices
// (guestAccept.ts acceptChoices: plain, signed in, signed out), the notice after a share went into
// the account (notices.ts), SHARED WITH YOU's rows (sharedWithYou.ts: grants and synced shares by
// machine, openSyncedShare), the browser's start with the landing's bind=1 (web/start.ts) and Leave
// share's words (guestHome.ts). The refusals come worded from Go (internal/guest/session.go). The
// app's Desk calls go to a fake mygo bridge; test/fakeDom.ts stands in for the DOM.
import { afterEach, expect, test } from "bun:test";
import { acceptChoices, type Keep } from "../src/guestAccept";
import { accountNote, sharedLine, sharedMachines, sharedSection, syncedSharesNow } from "../src/sharedWithYou";
import { accountShareNotice, showAccountShareNotice } from "../src/notices";
import { leaveWords } from "../src/guestHome";
import { errorText } from "../src/errors";
import { bindRequest, start } from "../src/web/start";
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

test("the browser keeps a share in the account only for the landing's bind=1 while signed in", async () => {
 expect(bindRequest("PAYLOAD&bind=1")).toEqual({ payload: "PAYLOAD", bind: true });
 expect(bindRequest("PAYLOAD")).toEqual({ payload: "PAYLOAD", bind: false });
 const run = async (fragment: string, signedIn: boolean, bound: boolean) => {
  const keeps: string[] = [], asked: boolean[] = [];
  const desk = {
   sharedConnections: async () => [],
   acceptGuestInvitation: async (text: string, keep: string) => { keeps.push(`${text} ${keep}`); return grant("H", "G", "enyo", "jerry", "hetzner", bound && keep === "account"); },
   connectGuest: async () => {},
  };
  const started = await start(desk, fragment, "https://guest.herdrup.app", () => null, async () => { asked.push(true); return signedIn; });
  return { keeps, asked: asked.length, started };
 };
 expect(await run("PAYLOAD&bind=1", true, true)).toEqual({ keeps: ["herdrup://guest-invite#PAYLOAD account"], asked: 1, started: { kind: "connected", id: "H/G", inAccount: "enyo" } });
 expect(await run("PAYLOAD&bind=1", false, true)).toEqual({ keeps: ["herdrup://guest-invite#PAYLOAD device"], asked: 1, started: { kind: "connected", id: "H/G" } });
 expect(await run("PAYLOAD", true, true)).toEqual({ keeps: ["herdrup://guest-invite#PAYLOAD device"], asked: 0, started: { kind: "connected", id: "H/G" } });
 // Asked for the account but not bound by the machine: no notice.
 expect((await run("PAYLOAD&bind=1", true, false)).started).toEqual({ kind: "connected", id: "H/G" });
});

test("leaving a share in the account says it leaves every device; a plain share, this device", () => {
 const plain = leaveWords({ machineLabel: "hetzner", agentName: "enyo", ownerName: "jerry", accountBound: false });
 expect(plain).toEqual({ title: "Leave hetzner?", message: "enyo disappears from this device.", note: "You stop seeing enyo. To come back, jerry has to send a new invite." });
 const bound = leaveWords({ machineLabel: "hetzner", agentName: "enyo", ownerName: "jerry", accountBound: true });
 expect(bound).toEqual({ title: "Leave hetzner on all your devices?", message: "enyo disappears from every device signed in to your HerdrUp account.", note: "You stop seeing enyo on all your devices. To come back, jerry has to send a new invite." });
});
