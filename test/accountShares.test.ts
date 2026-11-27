// Account-linked guest shares (#700, owner pick A): the shared invitation's keep choices
// (guestAccept.ts acceptChoices: plain, signed in, signed out), the notice after a share went into
// the account (notices.ts), SHARED WITH YOU's rows (sharedWithYou.ts: grants and synced shares by
// machine, openSyncedShare), the browser's start with the landing's bind=1 and provider (web/start.ts:
// a bind at once, a named sign-in with the invite kept in the tab, its resume) and the choice the
// page asks with (web/bindChoice.ts), and Leave share's words (guestHome.ts). The refusals come
// worded from Go (internal/guest/session.go). The app's Desk calls go to a fake mygo bridge;
// test/fakeDom.ts stands in for the DOM.
import { afterEach, expect, test } from "bun:test";
import { acceptChoices, showGuestAccept, type Keep } from "../src/guestAccept";
import { accountNote, addsDevice, sharedLine, sharedListStale, sharedMachines, sharedSection, syncedSharesNow } from "../src/sharedWithYou";
import { accountShareNotice, accountShareWords, showAccountShareNotice } from "../src/notices";
import { initHosts } from "../src/hosts";
import { combinedGuestMachines, initGuestHome, leaveWords } from "../src/guestHome";
import { errorText } from "../src/errors";
import { bindRequest, CHECK_FAILED, PENDING_BIND_KEY, pendingBindWaits, start, startAccount, takePendingBind, type Started, type StartAccount } from "../src/web/start";
import { WebAccount } from "../src/web/account";
import { showBindChoice, signInToBind, type BindPage } from "../src/web/bindChoice";
import { createAccountDesk } from "../src/web/accountDesk";
import { notInvite } from "../src/webguest/errors";
import { Desk, type Access, type Features, type SyncedShare } from "../src/mygo";
import { FakeDocument, type FakeElement } from "./fakeDom";

const G = globalThis as { document?: unknown; mygo?: unknown; ResizeObserver?: unknown; window?: unknown };
const saved = { document: G.document, mygo: G.mygo, ResizeObserver: G.ResizeObserver, window: G.window };
afterEach(() => { G.document = saved.document; G.mygo = saved.mygo; G.ResizeObserver = saved.ResizeObserver; G.window = saved.window; });

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

test("a sign-in that comes back without a session ends its attempt: the choices back, with why (a cancel says nothing), and a late session accepts nothing; a new choice starts anew", async () => {
 const { emit, calls } = bridge({ "Desk.AccountState": { signedIn: false }, "Desk.AccountProviders": ["apple", "google"], "Desk.AccountSignIn": undefined });
 const { made, redeemed, reported } = choices({ account: true });
 const { root, buttons: all } = await made;
 const waiting = () => shown(root).includes("Finish signing in in your browser.");
 named(root, "Continue with Apple").click();
 await settle();
 expect([waiting(), all.every(b => b.disabled)]).toEqual([true, true]);
 // The app's account link came back expired (desk_account.go queueAccountLink).
 emit("account:changed", { signedIn: false, problem: "The sign-in took too long. Sign in again." });
 expect([waiting(), all.map(b => b.disabled), reported.map(errorText)]).toEqual([false, [false, false, false], ["The sign-in took too long. Sign in again."]]);
 // A session after the attempt ended acts on nothing.
 emit("account:changed", { signedIn: true });
 expect(redeemed).toEqual([]);
 // Tried again, then cancelled: the choices again, nothing more to say; a late session, nothing.
 named(root, "Continue with Google").click();
 await settle();
 expect(all.every(b => b.disabled)).toBe(true);
 emit("account:changed", { signedIn: false, problem: "" });
 expect([waiting(), all.every(b => !b.disabled), reported.length]).toEqual([false, true, 1]);
 emit("account:changed", { signedIn: true, displayHint: "nike@example.com" });
 await settle();
 expect([redeemed, calls.filter(c => c[0] === "Desk.AcceptGuestInvitation"), waiting(), all.every(b => !b.disabled)]).toEqual([[], [], false, true]);
 // A new choice starts a new attempt, which accepts once its session comes.
 named(root, "Continue with Apple").click();
 await settle();
 expect([waiting(), all.every(b => b.disabled)]).toEqual([true, true]);
 emit("account:changed", { signedIn: true });
 emit("account:changed", { signedIn: true });
 expect(redeemed).toEqual([["account", "Continue with Apple"]]);
});

test("an ended attempt's start failing late changes nothing: the newer attempt keeps waiting", async () => {
 const rejects: ((e: Error) => void)[] = [];
 const { emit } = bridge({ "Desk.AccountState": { signedIn: false }, "Desk.AccountProviders": ["apple", "google"], "Desk.AccountSignIn": () => new Promise<void>((_, reject) => { rejects.push(reject); }) });
 let failed = 0;
 const reported: unknown[] = [], redeemed: string[] = [];
 const { root, buttons: all } = await acceptChoices({ account: true }, (_keep, pressed) => { redeemed.push(pressed.textContent ?? ""); }, f => reported.push(f), { failed: () => { failed++; } });
 named(root, "Continue with Apple").click();
 await settle();
 emit("account:changed", { signedIn: false, problem: "" });
 named(root, "Continue with Google").click();
 await settle();
 rejects[0]!(new Error("the first browser closed"));
 await settle();
 expect([shown(root).includes("Finish signing in in your browser."), all.every(b => b.disabled), reported, failed]).toEqual([true, true, [], 0]);
 rejects[1]!(new Error("the browser didn't open"));
 await settle();
 expect([shown(root).includes("Finish signing in in your browser."), all.every(b => !b.disabled), reported.map(errorText), failed]).toEqual([false, true, ["the browser didn't open"], 1]);
});

test("the sheet: a cancelled sign-in then a late session accepts nothing; the next choice's session accepts once, into the account", async () => {
 const { doc, emit, calls } = bridge({ "Desk.InspectGuestInvitation": { ...INVITE, account: true }, "Desk.AccountState": { signedIn: false }, "Desk.AccountProviders": ["apple"], "Desk.AccountSignIn": undefined,
  "Desk.AcceptGuestInvitation": standing("H1", "enyo", "hetzner", "confirmed") });
 showGuestAccept(async () => {}, () => {}, "herdrup://guest-invite#X");
 await settle();
 const sheet = doc.body.all().find(n => n.tagName === "dialog")!;
 const accepts = () => calls.filter(c => c[0] === "Desk.AcceptGuestInvitation");
 named(sheet, "Continue with Apple").click();
 await settle();
 emit("account:changed", { signedIn: false, problem: "" });
 emit("account:changed", { signedIn: true });
 await settle();
 expect([accepts(), shown(sheet).includes("Access accepted")]).toEqual([[], false]);
 named(sheet, "Continue with Apple").click();
 await settle();
 emit("account:changed", { signedIn: true });
 await settle();
 emit("account:changed", { signedIn: true });
 await settle();
 expect([accepts(), shown(sheet).includes("Access accepted")]).toEqual([[["Desk.AcceptGuestInvitation", "herdrup://guest-invite#X", "account"]], true]);
 sheet.close();
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

test("SHARED WITH YOU: one entry per machine from the grants held here and the account's shares, each share on it kept (g4, g5)", () => {
 const grants = [grant("H1", "g1", "enyo", "jerry", "hetzner", true)];
 const synced = [share("H1", "g1", "enyo", "jerry", "hetzner", true), share("H1", "g2", "orgstudio", "jerry", "hetzner", false), share("H2", "g3", "landing", "maya", "", false)];
 const rows = sharedMachines(grants, synced);
 expect(rows.map(r => [r.machine, sharedLine(r), r.grants, addsDevice(r)])).toEqual([
  ["hetzner", "enyo, orgstudio · shared by jerry", [{ agent: "enyo", open: { kind: "grant", id: "H1/g1" } }, { agent: "orgstudio", open: { kind: "synced", id: "H1/g2" } }], true],
  ["landing", "landing · shared by maya", [{ agent: "landing", open: { kind: "synced", id: "H2/g3" } }], true],
 ]);
 // hetzner's orgstudio adds this device too, though enyo is held here: both owners see it.
 expect(accountNote(rows)).toBe("From your HerdrUp account: nothing to accept here. The owner sees each device you open it on.");
 // Only the account has hetzner (g4): it opens with openSyncedShare.
 const remote = sharedMachines([], [share("H1", "g1", "enyo", "jerry", "hetzner", false)]);
 expect(remote.map(r => [r.machine, sharedLine(r), r.grants])).toEqual([["hetzner", "enyo · shared by jerry", [{ agent: "enyo", open: { kind: "synced", id: "H1/g1" } }]]]);
 // Two grants held here on one machine (the desktop's saved grants): both stay.
 const both = sharedMachines([grant("H1", "g1", "enyo", "jerry", "hetzner"), grant("H1", "g4", "enyo", "jerry", "hetzner")], []);
 expect(both.map(r => [sharedLine(r), r.grants.map(g => g.open)])).toEqual([["enyo · shared by jerry", [{ kind: "grant", id: "H1/g1" }, { kind: "grant", id: "H1/g4" }]]]);
 // A grant held here opens before a synced share of the same machine, whatever came first.
 const local = sharedMachines([], [share("H1", "g2", "orgstudio", "jerry", "hetzner", false), share("H1", "g1", "enyo", "jerry", "hetzner", true)]);
 expect(local[0]!.grants.map(g => g.open)).toEqual([{ kind: "grant", id: "H1/g1" }, { kind: "synced", id: "H1/g2" }]);
 expect(addsDevice(local[0]!)).toBe(true);
 expect(sharedMachines([], [])).toEqual([]);
 expect(accountNote(sharedMachines(grants, []))).toBeNull();
 expect(sharedLine({ agents: ["enyo"], owner: "" })).toBe("enyo");
});

// A machine renamed by its owner (herdr #519) relabels only the grant held here (guest store
// Relabel, web GrantStore.relabel); the account's item keeps the name it was written with. The
// row names the machine as the grant does, and the browser guest's list is drawn again when the
// open share's machine is named anew.
test("a machine renamed by its owner: the row names it as the grant held here does; the list redraws on the new name", () => {
 const relabeled = grant("H1", "g1", "enyo", "jerry", "Studio Mac", true);
 const rows = sharedMachines([relabeled], [share("H1", "g1", "enyo", "jerry", "hetzner", true), share("H1", "g2", "orgstudio", "jerry", "hetzner", false)]);
 expect(rows.map(r => [r.machine, r.grants.map(g => g.open.id)])).toEqual([["Studio Mac", ["H1/g1", "H1/g2"]]]);
 const on = (a: Access | null) => ({ guest: a === null ? undefined : { access: a, features: {} as Features, fingerprint: "" } });
 const before = grant("H1", "g1", "enyo", "jerry", "hetzner", true);
 expect(sharedListStale(on(before), on(relabeled))).toBe(true);
 expect(sharedListStale(on(before), on(grant("H1", "g2", "orgstudio", "jerry", "hetzner")))).toBe(true);
 expect(sharedListStale(on(null), on(before))).toBe(true);
 expect(sharedListStale(on(before), on({ ...before, agentName: "enyo 2" }))).toBe(false);
 expect(sharedListStale(on(before), on(before))).toBe(false);
});

test("the account's note shows while any row adds this device, even on a machine with a grant held here", () => {
 // A mixed machine: enyo held here, orgstudio only in the account.
 const mixed = sharedMachines([grant("H1", "g1", "enyo", "jerry", "hetzner", true)], [share("H1", "g1", "enyo", "jerry", "hetzner", true), share("H1", "g2", "orgstudio", "jerry", "hetzner", false)]);
 expect(accountNote(mixed)).toBe("From your HerdrUp account: nothing to accept here. jerry sees each device you open it on.");
 // Every share held here (as a grant, or the account's copy marked local): no note.
 const held = sharedMachines([grant("H1", "g1", "enyo", "jerry", "hetzner", true)], [share("H1", "g1", "enyo", "jerry", "hetzner", true), share("H1", "g4", "orgstudio", "jerry", "hetzner", true)]);
 expect(held[0]!.grants.map(g => g.open.kind)).toEqual(["grant", "grant"]);
 expect(accountNote(held)).toBeNull();
});

test("a machine with several shares: its row, then a row per share, each opening its own", async () => {
 const { calls } = bridge({ "Desk.OpenSyncedShare": undefined, "Desk.ConnectGuest": undefined });
 const symbol = async () => (G.document as FakeDocument).createElement("span") as unknown as HTMLElement;
 let opened = 0;
 const section = sharedSection(symbol, () => { opened++; }, () => {}, () => false);
 const root = section.root as unknown as FakeElement;
 const machines = sharedMachines([grant("H1", "g1", "enyo", "jerry", "hetzner")], [share("H1", "g2", "orgstudio", "jerry", "hetzner", false)]);
 expect(await section.draw(machines)).toBe(true);
 expect(shown(root)).toEqual(expect.arrayContaining(["SHARED WITH YOU", "hetzner", "shared by jerry", "enyo", "orgstudio"]));
 // The machine's row is a heading here, not a control; each share is its own button.
 expect(buttons(root).map(b => b.getAttribute("aria-label"))).toEqual(["enyo on hetzner", "orgstudio on hetzner"]);
 named(root, "orgstudio").click();
 await settle();
 named(root, "enyo").click();
 await settle();
 expect(calls).toEqual([["Desk.OpenSyncedShare", "H1/g2"], ["Desk.ConnectGuest", "H1/g1"]]);
 expect(opened).toBe(2);
});

test("a row the account brought opens with openSyncedShare; one held here connects its grant", async () => {
 const { calls } = bridge({ "Desk.OpenSyncedShare": undefined, "Desk.ConnectGuest": undefined });
 const symbol = async () => (G.document as FakeDocument).createElement("span") as unknown as HTMLElement;
 let opened = 0;
 const section = sharedSection(symbol, () => { opened++; }, () => {});
 const root = section.root as unknown as FakeElement;
 expect(root.hidden).toBe(true);
 const rows = sharedMachines([grant("H2", "g9", "landing", "maya", "mac-mini")], [share("H1", "g1", "enyo", "jerry", "hetzner", false)]);
 expect(await section.draw(rows)).toBe(true);
 expect(root.shown()).toBe(true);
 expect(shown(root)).toContain("SHARED WITH YOU");
 // One machine, one share: the machine's row is the control, the machine over its line.
 expect(buttons(root).map(b => [b.text(), b.disabled])).toEqual([["mac-minilanding · shared by maya", false], ["hetznerenyo · shared by jerry", false]]);
 expect(shown(root)).toContain("From your HerdrUp account: nothing to accept here. jerry sees each device you open it on.");
 named(root, "hetzner").click();
 await settle();
 named(root, "mac-mini").click();
 await settle();
 expect(calls).toEqual([["Desk.OpenSyncedShare", "H1/g1"], ["Desk.ConnectGuest", "H2/g9"]]);
 expect(opened).toBe(2);
 await section.draw([]);
 expect(root.hidden).toBe(true);
 // A newer draw takes over one still drawing: the older draws nothing and says so.
 const [older, newer] = await Promise.all([section.draw(rows), section.draw([])]);
 expect([older, newer, root.hidden, buttons(root).length]).toEqual([false, true, true, 0]);
});

// How a bound grant's account write stands (Access.accountShare, #596): accountBound says only
// that herdr bound the share; only "confirmed" may say it is in the account.
const QUOTA = "Your HerdrUp account holds as many shares as it can. Remove one from it, and this one is added at the next sync.";
const QUEUED = "Adding to your HerdrUp account at the next sync.";
const standing = (hostID: string, agentName: string, machineLabel: string, accountShare: string, accountShareProblem = ""): Access =>
 ({ ...grant(hostID, `g-${agentName}`, agentName, "jerry", machineLabel, true), accountShare, ...(accountShareProblem ? { accountShareProblem } : {}) });

test("accountShareWords: Added only when confirmed; queued; refused in the desk's own words; bound with none known, or plain, says nothing", () => {
 expect([standing("H", "enyo", "m", "confirmed"), standing("H", "enyo", "m", "queued"), standing("H", "enyo", "m", "refused", QUOTA), standing("H", "enyo", "m", ""), grant("H", "g", "enyo", "jerry", "m", true), grant("H", "g", "enyo", "jerry", "m")].map(accountShareWords))
  .toEqual(["Added to your HerdrUp account.", QUEUED, QUOTA, null, null, null]);
});

test("the accept sheet says how the account took the share: Added, and the g3 notice, only when confirmed; queued; refused with the desk's problem; a bound grant with none known claims nothing", async () => {
 const cases: [Access, string[], boolean][] = [[standing("H1", "enyo", "hetzner", "confirmed"), ["Added to your HerdrUp account."], true], [standing("H1", "enyo", "hetzner", "queued"), [QUEUED], false],
  [standing("H1", "enyo", "hetzner", "refused", QUOTA), [QUOTA], false], [standing("H1", "enyo", "hetzner", ""), [], false]];
 for (const [access, account, notice] of cases) {
  const { doc, calls } = bridge({ "Desk.InspectGuestInvitation": { ...INVITE, account: true }, "Desk.AccountState": { signedIn: true, persistent: true }, "Desk.AcceptGuestInvitation": access });
  showGuestAccept(async () => {}, () => {}, "herdrup://guest-invite#X");
  await settle();
  const sheet = doc.body.all().find(n => n.tagName === "dialog")!;
  named(sheet, "Add to my account").click();
  await settle();
  expect(calls).toContainEqual(["Desk.AcceptGuestInvitation", "herdrup://guest-invite#X", "account"]);
  const words = shown(sheet);
  expect([access.accountShare, words.includes("enyo is saved on this device."), words.filter(t => t.includes("HerdrUp account")), (doc.getElementById("notices")?.children ?? []).map(n => n.text())])
   .toEqual([access.accountShare, true, account, notice ? [`${accountShareNotice("enyo")}OK`] : []]);
  sheet.close();
 }
});

test("the accept sheet omits saved, added and Open when the accept's sync removed the grant", async () => {
 const access = standing("H1", "enyo", "hetzner", "removed");
 const { doc } = bridge({ "Desk.InspectGuestInvitation": { ...INVITE, account: true }, "Desk.AccountState": { signedIn: true, persistent: true }, "Desk.AcceptGuestInvitation": access });
 showGuestAccept(async () => {}, () => {}, "herdrup://guest-invite#X");
 await settle();
 const sheet = doc.body.all().find(n => n.tagName === "dialog")!;
 named(sheet, "Add to my account").click();
 await settle();
 const words = shown(sheet);
 expect(words).toContain("Share no longer available");
 expect(words.some(t => t.includes("is saved on this device"))).toBe(false);
 expect(words.some(t => t.includes("Added to your HerdrUp account"))).toBe(false);
 expect(buttons(sheet).some(b => b.text() === "Open shared agent")).toBe(false);
 expect((doc.getElementById("notices")?.children ?? []).length).toBe(0);
 sheet.close();
});

test("SHARED WITH YOU: a queued or refused account write shows muted on its grant's row, in the desk's words; confirmed or none known claims nothing", async () => {
 bridge({});
 const symbol = async () => (G.document as FakeDocument).createElement("span") as unknown as HTMLElement;
 const section = sharedSection(symbol, () => {}, () => {});
 const root = section.root as unknown as FakeElement;
 const grants = [standing("H1", "enyo", "hetzner", "confirmed"), standing("H2", "docs", "mac-mini", "queued"), standing("H3", "ops", "studio", "refused", QUOTA), standing("H4", "web", "nuc", ""),
  standing("H5", "a", "pi", "queued"), standing("H5", "b", "pi", "confirmed")];
 expect(await section.draw(sharedMachines(grants, []))).toBe(true);
 // Muted: the row's dim second-line ink, nothing else (no colour, no dot).
 const pending = root.all().filter(n => n.className.includes("host-shared-state"));
 expect(pending.map(n => [n.className, n.textContent])).toEqual([["host-home-address host-shared-state", QUEUED], ["host-home-address host-shared-state", QUOTA], ["host-home-address host-shared-state", QUEUED]]);
 expect([named(root, "mac-mini").text(), named(root, "studio").text()]).toEqual([`mac-minidocs · shared by jerry${QUEUED}`, `studioops · shared by jerry${QUOTA}`]);
 expect([named(root, "hetzner").text(), named(root, "nuc").text()]).toEqual(["hetznerenyo · shared by jerry", "nucweb · shared by jerry"]);
 expect(buttons(root).slice(-2).map(b => b.getAttribute("aria-label"))).toEqual([`a on pi. ${QUEUED}`, "b on pi"]);
 expect(shown(root).filter(t => t.startsWith("Added"))).toEqual([]);
});

test("SHARED WITH YOU reads the grants again on syncedShares:changed, so a share queued at accept shows its later state", async () => {
 let state = "queued";
 const { doc, calls, emit } = bridge({ "Desk.Machines": [], "Desk.SharedConnections": () => [standing("H1", "enyo", "hetzner", state, state === "refused" ? QUOTA : "")],
  "Desk.AccountState": { signedIn: true, persistent: true, displayHint: "nike@example.com" },
  "Desk.AccountProviders": [], "Desk.SyncedMachines": [], "Desk.SyncedShares": [], "Desk.HasGuestInvitationClipboardText": false });
 G.window = doc.defaultView;
 const container = doc.createElement("div"); doc.body.append(container);
 const symbol = async () => doc.createElement("span") as unknown as HTMLElement;
 initHosts(container as unknown as HTMLElement, doc.createElement("form") as unknown as HTMLFormElement, () => {}, symbol, "", () => {}, () => {});
 for (let i = 0; i < 3; i++) await settle();
 const pending = () => container.all().filter(n => n.className.includes("host-shared-state")).map(n => n.textContent);
 const reads = () => calls.filter(c => c[0] === "Desk.SharedConnections").length;
 expect(pending()).toEqual([QUEUED]);
 const before = reads();
 state = "confirmed";
 emit("syncedShares:changed", []);
 for (let i = 0; i < 3; i++) await settle();
 expect([reads(), pending(), named(container, "hetzner").text()]).toEqual([before + 1, [], "hetznerenyo · shared by jerry"]);
 state = "refused";
 emit("syncedShares:changed", []);
 for (let i = 0; i < 3; i++) await settle();
 expect(pending()).toEqual([QUOTA]);
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
/** What a start that put the share in the account says: the desk told the write's outcome. */
const IN_ACCOUNT = { agentName: "enyo", added: { outcome: "added" as const } };

/** start() against a desk that records each accept's text and keep; account is the start's own
 *  (startAccount over a WebAccount) or a fixed answer, counted. */
async function startWith(fragment: string, account: { signedIn: boolean; pending?: string | null; signIn?: { problem: string | null } | null } | StartAccount, bound = true, held: Access[] = []) {
 const keeps: string[] = [], connects: string[] = [];
 let asked = 0;
 const desk = {
  sharedConnections: async () => held,
  acceptGuestInvitation: async (text: string, keep: string) => {
   keeps.push(`${text} ${keep}`);
   const access = grant("H", "G", "enyo", "jerry", "hetzner", bound && keep === "account");
   return access.accountBound ? { ...access, added: IN_ACCOUNT.added } : access;
  },
  connectGuest: async (id: string) => { connects.push(id); },
 };
 const fixed = account;
 const started = await start(desk, fragment, "https://guest.herdrup.app", () => null, typeof fixed.signedIn === "function" ? fixed as StartAccount : {
  signedIn: async () => { asked++; return fixed.signedIn as boolean; }, pending: fixed.pending ?? null, signIn: fixed.signIn ?? null,
 });
 return { keeps, asked, started, connects };
}

/** This page's WebAccount, its memory empty (a new document), over a refresh that answers as given. */
function cookieAccount(refresh: () => Response | Promise<Response>) {
 const sent: string[] = [];
 const fetcher = async (url: string) => { sent.push(url); return await refresh(); };
 return { account: new WebAccount(fetcher as unknown as typeof fetch, undefined, undefined, null), sent };
}
const SESSION = () => Response.json({ account_id: "acct-1", access_token: `a1.${"s".repeat(22)}.${"1".padStart(43, "0")}`, access_expires_in: 3600 });

test("the start asks the cookie: a page whose memory knows no session yet binds at once, and on its sign-in's return", async () => {
 for (const [fragment, pending, signIn] of [["PAYLOAD&bind=1&provider=apple", null, null], ["PAYLOAD&bind=1", null, null], ["", "PAYLOAD", { problem: null }]] as const) {
  const { account, sent } = cookieAccount(SESSION);
  expect(account.current).toBeNull();
  const r = await startWith(fragment, startAccount(account, pending, signIn));
  expect(r).toEqual({ keeps: ["herdrup://guest-invite#PAYLOAD account"], asked: 0, connects: ["H/G"], started: { kind: "connected", id: "H/G", bound: IN_ACCOUNT } });
  expect(sent.map(u => u.endsWith("/v1/auth/refresh"))).toEqual([true]);
 }
});

test("a sign-out the service confirms signs in or asks; a check that fails asks with why, never this browser alone", async () => {
 const signedOut = () => cookieAccount(() => Response.json({ error: "session_revoked" }, { status: 401 })).account;
 expect((await startWith("PAYLOAD&bind=1&provider=apple", startAccount(signedOut(), null, null))).started).toEqual({ kind: "signIn", payload: "PAYLOAD", provider: "apple" });
 expect((await startWith("PAYLOAD&bind=1", startAccount(signedOut(), null, null))).started).toEqual({ kind: "bind", payload: "PAYLOAD", problem: "" });
 expect((await startWith("", startAccount(signedOut(), "PAYLOAD", { problem: null }))).started).toEqual({ kind: "bind", payload: "PAYLOAD", problem: "" });
 const failures = [() => Promise.reject(new TypeError("Failed to fetch")), () => Response.json({ error: "unavailable" }, { status: 503 })];
 for (const refresh of failures) {
  for (const [fragment, pending, signIn] of [["PAYLOAD&bind=1&provider=google", null, null], ["PAYLOAD&bind=1", null, null], ["", "PAYLOAD", { problem: null }]] as const) {
   const r = await startWith(fragment, startAccount(cookieAccount(refresh).account, pending, signIn));
   expect(r).toEqual({ keeps: [], asked: 0, connects: [], started: { kind: "bind", payload: "PAYLOAD", problem: CHECK_FAILED } });
  }
 }
});

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
 const bound = { keeps: ["herdrup://guest-invite#PAYLOAD account"], asked: 1, connects: ["H/G"], started: { kind: "connected", id: "H/G", bound: IN_ACCOUNT } };
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
 expect(await startWith("", { signedIn: true, pending, signIn: { problem: null } })).toEqual({ keeps: ["herdrup://guest-invite#PAYLOAD account"], asked: 1, connects: ["H/G"], started: { kind: "connected", id: "H/G", bound: IN_ACCOUNT } });
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

test("leaving a share in the account says it leaves every device; a plain one, this device", () => {
 const plain = leaveWords({ machineLabel: "hetzner", agentName: "enyo", ownerName: "jerry", accountBound: false });
 const thisDevice = { title: "Leave hetzner?", message: "enyo disappears from this device.", note: "You stop seeing enyo. To come back, jerry has to send a new invite." };
 expect(plain).toEqual(thisDevice);
 const bound = leaveWords({ machineLabel: "hetzner", agentName: "enyo", ownerName: "jerry", accountBound: true });
 expect(bound).toEqual({ title: "Leave hetzner on all your devices?", message: "enyo disappears from every device signed in to your HerdrUp account.", note: "You stop seeing enyo on all your devices. To come back, jerry has to send a new invite." });
});

test("a failed account bind with a saved grant surfaces the refusal instead of opening the previous share", async () => {
 const saved = grant("H0", "g0", "existing", "jerry", "old-mac", true);
 const connects: string[] = [];
 const desk = {
  sharedConnections: async () => [saved],
  acceptGuestInvitation: async () => { throw new Error("too_many_devices"); },
  connectGuest: async (id: string) => { connects.push(id); },
 };
 const out = await start(desk, "PAYLOAD&bind=1&provider=apple", "https://guest.herdrup.app", () => "jerry",
  { signedIn: async () => true, pending: null, signIn: null });
 expect(out).toEqual({ kind: "bind", payload: "PAYLOAD", problem: "too_many_devices" });
 expect(connects).toEqual([]);
});

test("the browser guest's Settings, where Leave deletes a bound share's item from the account, says it leaves every device", async () => {
 const { doc } = bridge({});
 const sidebar = doc.createElement("div"), detail = doc.createElement("div");
 doc.body.append(sidebar, detail);
 const home = initGuestHome(sidebar as unknown as HTMLElement, detail as unknown as HTMLElement, {
  symbol: async () => doc.createElement("span") as unknown as HTMLElement, rowAvatar: () => doc.createElement("span") as unknown as HTMLElement,
  placeInitials: async () => {}, spinner: "",
 }, { hosts() {}, open() {} }, { settings: true });
 const guest = { access: grant("H1", "g1", "enyo", "jerry", "hetzner", true), features: {} as Features, fingerprint: "AB:CD", availability: "" };
 home.update({ phase: "connecting", message: "", machine: "", herdr: "", live: false, guest }, null, "settings", true, null);
 await settle();
 expect(detail.all().find(n => n.className === "guest-settings-note guest-leave-note")?.textContent).toBe("You stop seeing enyo on all your devices. To come back, jerry has to send a new invite.");
});

test("combinedGuestMachines merges all shares on the active machine and keeps other machines below", () => {
 const active = grant("H1", "g2", "fleetup", "jerry", "dev2306", true);
 const shares = sharedMachines(
  [grant("H1", "g1", "jarvis", "jerry", "dev2306", true), active],
  [share("H2", "g3", "landing", "maya", "mac-mini", false)],
 );
 const combined = combinedGuestMachines(active, shares);
 expect(combined.map(m => [m.hostID, m.machine, m.owner, m.grants.map(g => [g.agent, g.open.id])])).toEqual([
  ["H1", "dev2306", "jerry", [["jarvis", "H1/g1"], ["fleetup", "H1/g2"]]],
  ["H2", "mac-mini", "maya", [["landing", "H2/g3"]]],
 ]);
 // Active share not yet in shares is still included, and its machine stays first.
 const otherActive = grant("H2", "g3", "landing", "maya", "Studio Mac", true);
 const reordered = combinedGuestMachines(otherActive, shares);
 expect(reordered.map(m => [m.hostID, m.machine])).toEqual([["H2", "Studio Mac"], ["H1", "dev2306"]]);
});

test("the guest sidebar lists all shared agents together by machine and switches on click", async () => {
 const { doc } = bridge({});
 const sidebar = doc.createElement("div"), detail = doc.createElement("div");
 doc.body.append(sidebar, detail);
 const switched: string[] = [];
 let failNext = false;
 const home = initGuestHome(sidebar as unknown as HTMLElement, detail as unknown as HTMLElement, {
  symbol: async () => doc.createElement("span") as unknown as HTMLElement,
  rowAvatar: () => doc.createElement("span") as unknown as HTMLElement,
  placeInitials: async () => {},
  spinner: "",
 }, {
  hosts() {},
  open() {},
  switchShare: async open => {
   switched.push(`${open.kind}:${open.id}`);
   if (failNext) throw new Error("relay offline");
  },
 }, { settings: false });
 const active = grant("H1", "g1", "jarvis", "jerry", "dev2306", true);
 const shares = sharedMachines(
  [active],
  [share("H1", "g2", "fleetup", "jerry", "dev2306", false), share("H2", "g3", "landing", "maya", "mac-mini", false)],
 );
 home.setShares(shares);
 const guest = { access: active, features: {} as Features, fingerprint: "AB:CD", availability: "" };
 const board = {
  machineID: "guest:H1/g1",
  session: "default",
  board: {
   total: 1, needsYou: 0, sections: [{ key: "idle", label: "Idle", agentCount: 1, rows: [{ id: "p1", name: "jarvis", agent: "omp", badge: "", preview: "" }] }], archived: [],
  },
 };
 home.update({ phase: "connected", message: "", machine: "dev2306", herdr: "", live: true, guest }, board as never, "agents", true, null);
 await settle();
 const text = shown(sidebar);
 expect(text).toContain("dev2306");
 expect(text).toContain("Shared by jerry · 2 agents");
 expect(text).toContain("jarvis");
 expect(text).toContain("fleetup");
 expect(text).toContain("mac-mini");
 expect(text).toContain("Shared by maya · 1 agent");
 expect(text).toContain("landing");
 const fleetupRow = sidebar.all().find(n => n.dataset?.shareId === "H1/g2")!;
 expect(fleetupRow).toBeDefined();
 fleetupRow.click();
 await settle();
 expect(switched).toEqual(["synced:H1/g2"]);
 failNext = true;
 const landingRow = sidebar.all().find(n => n.dataset?.shareId === "H2/g3")!;
 landingRow.click();
 await settle();
 expect(switched).toEqual(["synced:H1/g2", "synced:H2/g3"]);
 expect(sidebar.all().find(n => n.className === "guest-switch-error")?.textContent).toBe("relay offline");
});
