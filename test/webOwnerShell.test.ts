// The web owner's shell: what the desktop shell decides differently in the browser (shellModel.ts,
// the desktop's answers unchanged), which page a load runs (bootChoice.ts), and an owner link's
// folders (groups.ts).
import { expect, test } from "bun:test";
import { boardAfter, boardOf, connectionChanged, deskOffers, ownerWrites, shareShown, shellParts } from "../src/shellModel";
import { bootMarks, choosePage, loadPage, signedInBefore } from "../src/web/bootChoice";
import { GROUPS_REFRESH_MS, OwnerGroups } from "../src/web/groups";
import { machineLists } from "../src/web/storage";
import { withStorageLock, type Locks } from "../src/web/locks";
import { ErrUnsupported } from "../src/web/engine";
import { HerdrAPIError } from "../src/webguest/errors";
import type { ConnState } from "../src/mygo";

const owner = (scope?: string): Pick<ConnState, "guest"> => ({
 guest: { access: { guestID: "g1", guestName: "", machineLabel: "dev", ownerName: "", agentName: "", agentTarget: "", endpoint: { relay: "", hostID: "h", hostPublic: "" }, acceptedAt: "" }, features: { gram: true, push: false, multi_request: true }, fingerprint: "", ...(scope ? { ownerScope: scope } : {}) },
});

test("the desktop keeps every desktop-only part; the browser has none", () => {
 expect(shellParts(false)).toEqual({ sessionPills: true, appUpdates: true, starAsk: true, usageCount: true, federation: true });
 expect(shellParts(true)).toEqual({ sessionPills: false, appUpdates: false, starAsk: false, usageCount: false, federation: false });
});

test("a guest share shows the guest home on desktop and browser; a browser owner link stays in the owner shell", () => {
 expect(shareShown(owner(), false)).toBe(true);
 expect(shareShown(owner(), true)).toBe(true);
 expect(shareShown({}, false)).toBe(false);
 expect(shareShown({}, true)).toBe(false);
 expect(shareShown(owner("terminal"), true)).toBe(false);
 expect(shareShown(owner("chat"), true)).toBe(false);
});

test("writes: always on the desktop, only a terminal-scope link in the browser", () => {
 expect(ownerWrites({}, false)).toBe(true);
 expect(ownerWrites(owner("chat"), false)).toBe(true);
 expect(ownerWrites(owner("terminal"), true)).toBe(true);
 expect(ownerWrites(owner("chat"), true)).toBe(false);
 expect(ownerWrites(owner(), true)).toBe(false);
});

const facts = (f: Partial<{ fragment: boolean; guestInstead: boolean; signedInFound: boolean; grant: boolean | Error; signedIn: boolean | Error }>) => {
 const asked: string[] = [];
 const read = (name: string, v: boolean | Error | undefined) => async () => { asked.push(name); if (v instanceof Error) throw v; return v ?? false; };
 return { asked, facts: { fragment: f.fragment ?? false, guestInstead: f.guestInstead ?? false, signedInFound: f.signedInFound ?? false, grant: read("grant", f.grant), signedIn: read("signedIn", f.signedIn) } };
};

test("an invite in the address or a kept grant is the guest's page, without asking the account service", async () => {
 const invite = facts({ fragment: true, signedIn: true });
 expect(await choosePage(invite.facts)).toBe("guest");
 expect(invite.asked).toEqual([]);
 const kept = facts({ grant: true, signedIn: true });
 expect(await choosePage(kept.facts)).toBe("guest");
 expect(kept.asked).toEqual(["grant"]);
});

test("a signed-in browser without a grant gets the owner's shell, unless it asked for the guest page", async () => {
 expect(await choosePage(facts({ signedIn: true }).facts)).toBe("owner");
 expect(await choosePage(facts({ signedIn: false }).facts)).toBe("guest");
 expect(await choosePage(facts({ signedIn: true, guestInstead: true }).facts)).toBe("guest");
});

test("a fact that can't be read counts as absent", async () => {
 expect(await choosePage(facts({ grant: new Error("idb"), signedIn: true }).facts)).toBe("owner");
 expect(await choosePage(facts({ signedIn: new Error("offline") }).facts)).toBe("guest");
});

function session() {
 const data = new Map<string, string>();
 return () => ({ getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } });
}

test("the page's code didn't load: one automatic reload per attempt, however long each try took", () => {
 const store = session();
 // Each load of the same attempt reads the marks afresh (a reload is a new page).
 expect(bootMarks(store).afterLoadFailure()).toBe("reload");
 expect(bootMarks(store).afterLoadFailure()).toBe("explain");
 expect(bootMarks(store).afterLoadFailure()).toBe("explain");
 // The card's Reload is a new attempt: it may reload once again.
 bootMarks(store).newAttempt();
 expect(bootMarks(store).afterLoadFailure()).toBe("reload");
 // A load that succeeds ends the attempt.
 bootMarks(store).loaded("owner");
 expect(bootMarks(store).afterLoadFailure()).toBe("reload");
 // No storage: no mark to keep, so no automatic reload (it could loop).
 const none = () => { throw new Error("SecurityError"); };
 expect(bootMarks(none).afterLoadFailure()).toBe("explain");
});

test("the guest's way, once chosen, survives the recovery reload and is spent only when the guest page loaded", () => {
 const store = session();
 bootMarks(store).chooseGuest();
 // The guest page's code didn't load: the reload keeps the choice.
 expect(bootMarks(store).afterLoadFailure()).toBe("reload");
 expect(bootMarks(store).guestInstead()).toBe(true);
 bootMarks(store).loaded("owner");
 expect(bootMarks(store).guestInstead()).toBe(true);
 bootMarks(store).loaded("guest");
 expect(bootMarks(store).guestInstead()).toBe(false);
});

/** Loads of /web/ in one tab, as boot.ts runs them (loadPage), until one ends without a reload.
 *  The account lookup answers signed in only after the wait (ACCOUNT_LOOKUP_MS) gave up, as a slow
 *  service's 200 at 7 s does; ownerCode says whether the owner page's code loads on each try. The
 *  guest page, once loaded, hears that sign-in and reloads only with the owner's way kept
 *  (web/main.ts). Each load is "page" / "page (asked)" / "page 404". */
async function loadsOf(store: ReturnType<typeof session>, ownerCode: (tries: number) => boolean) {
 const loads: string[] = [];
 let ownerTries = 0, end = "";
 for (let n = 0; n < 6 && end === ""; n++) {
  const marks = bootMarks(store);
  const lookup = Promise.withResolvers<boolean>();
  const waited = Promise.withResolvers<void>();
  let asked = false, chosen: "guest" | "owner" = "guest", failed = false;
  const outcome = loadPage(marks, {
   fragment: false, guestInstead: false, grant: async () => false,
   signedIn: () => { asked = true; return signedInBefore(lookup.promise, waited.promise); },
  }, async page => {
   chosen = page;
   if (page === "owner" && !ownerCode(++ownerTries)) { failed = true; throw new Error("404 owner chunk"); }
  }, () => {});
  waited.resolve();
  const result = await outcome;
  loads.push(`${chosen}${asked ? " (asked)" : ""}${failed ? " 404" : ""}`);
  lookup.resolve(true);
  if (result === "explain") end = "error card";
  else if (result === "loaded") end = chosen === "guest" && marks.keepSignedInFound() ? "" : `${chosen} page`;
 }
 return { loads, end };
}

test("a lookup that answers signed in after the wait loads the owner's page next, without asking again: no reload loop", async () => {
 const store = session();
 expect(await loadsOf(store, () => true)).toEqual({ loads: ["guest (asked)", "owner"], end: "owner page" });
 // The owner's way is spent once its page loaded: a later load asks again.
 expect(bootMarks(store).signedInFound()).toBe(false);
 // Without storage for the mark the guest page stays (a reload would ask again, and could loop).
 expect(bootMarks(() => { throw new Error("SecurityError"); }).keepSignedInFound()).toBe(false);
});

test("the owner page's code that doesn't load keeps the owner's way through the recovery reload: the error card after one retry", async () => {
 const store = session();
 expect(await loadsOf(store, () => false)).toEqual({ loads: ["guest (asked)", "owner 404", "owner 404"], end: "error card" });
 // Nothing loaded: the way stays for the card's Reload (a new attempt to the same page).
 bootMarks(store).newAttempt();
 expect(await loadsOf(store, () => true)).toEqual({ loads: ["owner"], end: "owner page" });
 expect([bootMarks(store).signedInFound(), bootMarks(store).afterLoadFailure()]).toEqual([false, "reload"]);
});

test("the owner page's code missing once, then there: the owner page on the recovery reload", async () => {
 const store = session();
 expect(await loadsOf(store, (tries) => tries > 1)).toEqual({ loads: ["guest (asked)", "owner 404", "owner"], end: "owner page" });
 expect([bootMarks(store).signedInFound(), bootMarks(store).afterLoadFailure()]).toEqual([false, "reload"]);
});

test("the person taking the guest's way drops the owner's way and the recovery guard", () => {
 const store = session();
 bootMarks(store).keepSignedInFound();
 expect(bootMarks(store).afterLoadFailure()).toBe("reload");
 bootMarks(store).chooseGuest();
 expect([bootMarks(store).signedInFound(), bootMarks(store).guestInstead(), bootMarks(store).afterLoadFailure()]).toEqual([false, true, "reload"]);
});

function memory() {
 const data = new Map<string, string>();
 return () => ({ getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } });
}
const doc = (revision: number, name = "Build") => ({ type: "agent_groups", revision, stars: ["a"], folders: [{ id: "f1", name, order: 0, members: ["a"] }] });

const signal = new AbortController().signal;
function groupsWith(answers: (() => unknown)[], storage = memory()) {
 let clock = 1_000_000, changes = 0;
 const calls: string[] = [];
 const client = { async call(method: string, _p: unknown, tag: string, capability: string) { calls.push(`${method} ${tag} ${capability}`); const a = answers.shift()!(); if (a instanceof Error) throw a; return a; } };
 const open = machineLists("open", storage);
 const g = new OwnerGroups(client as never, "host-1", signal, () => { changes++; }, () => clock, open);
 return { g, calls, open, tick: (ms: number) => { clock += ms; }, changes: () => changes };
}

test("folders show once agent.groups.get answers, read again at most once a minute", async () => {
 const s = groupsWith([() => doc(1), () => doc(2, "Renamed")]);
 expect(s.g.view().groups).toBeNull();
 await s.g.refresh();
 expect(s.calls).toEqual(["agent.groups.get agent_groups agent_groups"]);
 expect(s.g.view().groups?.folders?.[0]?.name).toBe("Build");
 expect(s.changes()).toBe(1);
 s.tick(GROUPS_REFRESH_MS - 1);
 await s.g.refresh();
 expect(s.calls.length).toBe(1);
 s.tick(1);
 await s.g.refresh();
 expect(s.g.view().groups?.folders?.[0]?.name).toBe("Renamed");
 expect(s.changes()).toBe(2);
});

test("an older revision, or the same document, changes nothing", async () => {
 const s = groupsWith([() => doc(5), () => doc(4, "Old"), () => doc(5)]);
 await s.g.refresh();
 await s.g.refresh(true);
 expect(s.g.view().groups?.revision).toBe(5);
 await s.g.refresh(true);
 expect(s.changes()).toBe(1);
});

test("a host without folders, or refusing the owner's browser, shows the plain list; a hiccup keeps them", async () => {
 for (const off of [new ErrUnsupported("agent.groups.get", "agent_groups", "0.9"), new HerdrAPIError("owner_forbidden", "no", null)]) {
  const s = groupsWith([() => doc(1), () => off, () => doc(2)]);
  await s.g.refresh();
  await s.g.refresh(true);
  expect(s.g.view().groups).toBeNull();
  await s.g.refresh(true);
  expect(s.calls.length).toBe(2);
 }
 const s = groupsWith([() => doc(1), () => new Error("socket closed")]);
 await s.g.refresh();
 await s.g.refresh(true);
 expect(s.g.view().groups?.revision).toBe(1);
});

test("open folders are this browser's, per machine", () => {
 const storage = memory();
 const s = groupsWith([], storage);
 s.g.setOpen("f1", true);
 s.g.setOpen("f2", true);
 s.g.setOpen("f1", false);
 expect(s.g.view().open).toEqual({ f2: true });
 expect(JSON.parse(storage().getItem("open")!)).toEqual({ "host-1": ["f2"] });
 expect(s.changes()).toBe(3);
 const other = new OwnerGroups({ call: async () => doc(1) }, "host-2", signal, () => {}, Date.now, machineLists("open", storage));
 expect(other.view().open).toEqual({});
});

test("another machine (or share) is another connection: the board on screen is the last one's", () => {
 const on = (hostID: string, guestID = "g1"): Pick<ConnState, "guest"> => { const s = owner("chat"); s.guest!.access = { ...s.guest!.access, guestID, endpoint: { ...s.guest!.access.endpoint, hostID } }; return s; };
 expect(connectionChanged(on("alpha"), on("beta"))).toBe(true);
 expect(connectionChanged(on("alpha", "g1"), on("alpha", "g2"))).toBe(true);
 expect(connectionChanged({}, on("beta"))).toBe(true);
 // The same link published again (connected, a new scope, an error) keeps its board.
 expect(connectionChanged(on("alpha"), { guest: { ...on("alpha").guest!, ownerScope: "terminal" } })).toBe(false);
 expect(connectionChanged({}, {})).toBe(false);
});

test("a switch drops only the previous connection's board: the web's (#349) and the desktop's, whose saved machine publishes its cached board first", () => {
 const on = (hostID: string, guestID = "g1"): Pick<ConnState, "guest"> => { const s = owner("chat"); s.guest!.access = { ...s.guest!.access, guestID, endpoint: { ...s.guest!.access.endpoint, hostID } }; return s; };
 const ssh: Pick<ConnState, "guest"> = {};
 const board = (machineID: string) => ({ machineID });
 // #349, the web owner: Alpha's board is on screen when Beta's link says it's connecting.
 expect(boardAfter(on("alpha"), on("beta"), board("owner:alpha"))).toBeNull();
 // A share left for a saved machine: its board goes.
 expect(boardAfter(on("h1", "g7"), ssh, board("guest:h1/g7"))).toBeNull();
 // The desktop's order: the saved machine's cached board came before "connecting": it stays.
 const cached = board("machine-alpha");
 expect(boardAfter(on("h1", "g7"), ssh, cached)).toBe(cached);
 // ... as a share's first list that came before its state does, leaving a saved machine.
 const share = board("guest:h1/g7");
 expect(boardAfter(ssh, on("h1", "g7"), share)).toBe(share);
 expect(boardAfter(ssh, on("h1", "g7"), board("machine-alpha"))).toBeNull();
 // The same connection published again keeps its board.
 const own = board("owner:alpha");
 expect(boardAfter(on("alpha"), { guest: { ...on("alpha").guest!, ownerScope: "terminal" } }, own)).toBe(own);
 expect([boardOf(on("h1", "g7"), board("guest:h1/g7")), boardOf(on("h1", "g7"), board("guest:h1/g8")), boardOf(ssh, board("owner:h1"))]).toEqual([true, false, false]);
});

test("the account lookup is bounded: a stalled service, or the guest's way taken, is not signed in", async () => {
 const never = new Promise<boolean>(() => {});
 expect(await signedInBefore(Promise.resolve(true), never)).toBe(true);
 expect(await signedInBefore(Promise.reject(new Error("offline")), never)).toBe(false);
 expect(await signedInBefore(never, Promise.resolve())).toBe(false);
 const guest = Promise.withResolvers<void>();
 const chosen = signedInBefore(never, never, guest.promise);
 guest.resolve();
 expect(await chosen).toBe(false);
});

/** A tab's storage over shared: full makes its writes fail (quota). */
function tabOver(shared: ReturnType<typeof memory>) {
 const tab = { full: false, storage: () => ({ getItem: (k: string) => shared().getItem(k), setItem: (k: string, v: string) => { if (tab.full) throw new Error("QuotaExceededError"); shared().setItem(k, v); } }) };
 return tab;
}

test("a preference storage refuses still holds for this page", () => {
 const lists = machineLists("open", () => ({ getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } }));
 const s = new OwnerGroups({ call: async () => ({}) }, "h", signal, () => {}, Date.now, lists);
 s.setOpen("f1", true);
 s.setOpen("f2", true);
 s.setOpen("f1", false);
 expect(s.view().open).toEqual({ f2: true });
});

test("two tabs opening folders keep each other's", () => {
 const shared = memory();
 const alpha = new OwnerGroups({ call: async () => ({}) }, "alpha", signal, () => {}, Date.now, machineLists("open", shared));
 const beta = new OwnerGroups({ call: async () => ({}) }, "beta", signal, () => {}, Date.now, machineLists("open", shared));
 alpha.setOpen("A1", true);
 beta.setOpen("B1", true);
 alpha.setOpen("A2", true);
 expect(JSON.parse(shared().getItem("open")!)).toEqual({ alpha: ["A1", "A2"], beta: ["B1"] });
 expect(beta.view().open).toEqual({ B1: true });
});

test("with writes refused, opening a folder on another machine keeps this page's earlier opening", () => {
 const shared = memory();
 const tab = tabOver(shared);
 const lists = machineLists("open", tab.storage);
 const alpha = new OwnerGroups({ call: async () => ({}) }, "alpha", signal, () => {}, Date.now, lists);
 const beta = new OwnerGroups({ call: async () => ({}) }, "beta", signal, () => {}, Date.now, lists);
 tab.full = true;
 alpha.setOpen("A1", true);
 beta.setOpen("B1", true);
 expect([alpha.view().open, beta.view().open]).toEqual([{ A1: true }, { B1: true }]);
 // Storage takes writes again: both changes go in with the next one.
 tab.full = false;
 beta.setOpen("B2", true);
 expect(JSON.parse(shared().getItem("open")!)).toEqual({ alpha: ["A1"], beta: ["B1", "B2"] });
});

test("a recovered write keeps what another tab saved on the same machine while this one was over quota", () => {
 const shared = memory();
 const first = tabOver(shared);
 const mine = new OwnerGroups({ call: async () => ({}) }, "alpha", signal, () => {}, Date.now, machineLists("open", first.storage));
 const other = new OwnerGroups({ call: async () => ({}) }, "alpha", signal, () => {}, Date.now, machineLists("open", shared));
 mine.setOpen("A1", true);
 first.full = true;
 mine.setOpen("A2", true); // refused: pending on this page
 other.setOpen("A3", true); // the other tab's writes go through
 other.setOpen("A1", false);
 first.full = false;
 mine.setOpen("A4", true);
 // Only this page's own changes (A2, A4) went over what storage held.
 expect(JSON.parse(shared().getItem("open")!)).toEqual({ alpha: ["A3", "A2", "A4"] });
 expect(mine.view().open).toEqual({ A3: true, A2: true, A4: true });
 // Written: nothing pending stays to undo the other tab's later changes.
 other.setOpen("A2", false);
 expect(mine.view().open).toEqual({ A3: true, A4: true });
});

test("a page whose write was refused writes back only its own change over another machine's later save", () => {
 const shared = memory();
 const tab = tabOver(shared);
 const alpha = new OwnerGroups({ call: async () => ({}) }, "alpha", signal, () => {}, Date.now, machineLists("open", tab.storage));
 const beta = new OwnerGroups({ call: async () => ({}) }, "beta", signal, () => {}, Date.now, machineLists("open", shared));
 alpha.setOpen("A1", true);
 tab.full = true;
 alpha.setOpen("A2", true);
 beta.setOpen("B1", true);
 tab.full = false;
 alpha.setOpen("A3", true);
 expect(JSON.parse(shared().getItem("open")!)).toEqual({ alpha: ["A1", "A2", "A3"], beta: ["B1"] });
});

test("storage that can't be read isn't written over: the change waits for a write that can read it", () => {
 const shared = memory();
 shared().setItem("open", JSON.stringify({ beta: ["B1"] }));
 let unreadable = true;
 const lists = machineLists("open", () => ({ getItem: (k: string) => { if (unreadable) throw new Error("SecurityError"); return shared().getItem(k); }, setItem: (k: string, v: string) => { shared().setItem(k, v); } }));
 lists.set("alpha", "A1", true);
 expect([lists.get("alpha"), JSON.parse(shared().getItem("open")!)]).toEqual([["A1"], { beta: ["B1"] }]);
 unreadable = false;
 lists.set("alpha", "A2", true);
 expect(JSON.parse(shared().getItem("open")!)).toEqual({ beta: ["B1"], alpha: ["A1", "A2"] });
});

test("pending changes apply to the stored list as one set: an item already listed keeps its place, a closed one goes", () => {
 const shared = memory();
 shared().setItem("open", JSON.stringify({ alpha: ["A1", "A2", "A3"] }));
 const tab = tabOver(shared);
 const lists = machineLists("open", tab.storage);
 tab.full = true;
 lists.set("alpha", "A1", true);
 lists.set("alpha", "A2", false);
 lists.set("alpha", "A4", true);
 expect(lists.get("alpha")).toEqual(["A1", "A3", "A4"]);
 tab.full = false;
 lists.set("alpha", "A1", true);
 expect(JSON.parse(shared().getItem("open")!)).toEqual({ alpha: ["A1", "A3", "A4"] });
});

test("two tabs whose writes overlap keep each other's: the key's lock holds the other tab's write until this one has read and written", async () => {
 const shared = memory();
 /** navigator.locks for both tabs: one holder per name, queued. */
 const tails = new Map<string, Promise<unknown>>();
 const locks: Locks = { request<T>(name: string, run: () => Promise<T>): Promise<T> { const result = (tails.get(name) ?? Promise.resolve()).then(run, run); tails.set(name, result.catch(() => undefined)); return result; } };
 const beta = machineLists("open", shared, locks);
 let betaWrote: Promise<void> | null = null;
 // Beta saves B1 just after Alpha has read the record, before Alpha writes.
 const alphaTab = () => ({
  getItem: (k: string) => { const v = shared().getItem(k); betaWrote ??= beta.set("beta", "B1", true); return v; },
  setItem: (k: string, v: string) => { shared().setItem(k, v); },
 });
 const alpha = machineLists("open", alphaTab, locks);
 await alpha.set("alpha", "A1", true);
 await betaWrote;
 expect(JSON.parse(shared().getItem("open")!)).toEqual({ alpha: ["A1"], beta: ["B1"] });
});

test("a lock the browser refuses is a write not made: set settles, the change holds for this page and goes in with the next write", async () => {
 const shared = memory();
 let refuse = true;
 const locks: Locks = { request<T>(_name: string, run: () => Promise<T>): Promise<T> { return refuse ? Promise.reject(new DOMException("denied", "SecurityError")) : run(); } };
 const lists = machineLists("open", shared, locks);
 await lists.set("alpha", "A1", true);
 expect([lists.get("alpha"), shared().getItem("open")]).toEqual([["A1"], null]);
 refuse = false;
 await lists.set("alpha", "A2", true);
 expect(JSON.parse(shared().getItem("open")!)).toEqual({ alpha: ["A1", "A2"] });
});

test("the storage lock: true once update ran, false only when the lock was refused (update didn't run); an update that throws rejects with or without Web Locks", async () => {
 const granted: Locks = { request: <T>(_name: string, run: () => Promise<T>) => run() };
 const refused: Locks = { request: () => Promise.reject(new DOMException("denied", "SecurityError")) };
 let runs = 0;
 const update = () => { runs++; };
 const fails = () => { throw new Error("quota"); };
 expect([await withStorageLock("k", update, granted), await withStorageLock("k", update, null), await withStorageLock("k", update, refused), runs]).toEqual([true, true, false, 2]);
 expect(await withStorageLock("k", fails, granted).catch((e: Error) => e.message)).toBe("quota");
 expect(await withStorageLock("k", fails, null).catch((e: Error) => e.message)).toBe("quota");
});

test("deskOffers asks a Desk given first, and every method named must be on it", () => {
 const desk = { accountSyncNow: async () => {}, accountDevices: async () => ({ devices: [] }) };
 expect([deskOffers(desk, "accountSyncNow", "accountDevices"), deskOffers(desk, "accountSyncNow", "accountDeleteInfo"), deskOffers({}, "accountSyncNow")]).toEqual([true, false, false]);
});

test("a stored record not of id lists by machine is unreadable: set settles, the edit stays pending, nothing is written over it", async () => {
 const granted: Locks = { request: <T>(_name: string, run: () => Promise<T>) => run() };
 for (const bad of ['{"alpha":{}}', '{"alpha":[1]}', "[]", "7"]) {
  const shared = memory();
  shared().setItem("open", bad);
  const lists = machineLists("open", shared, granted);
  await lists.set("alpha", "A1", true);
  expect([bad, lists.get("alpha"), shared().getItem("open")]).toEqual([bad, ["A1"], bad]);
 }
});

test("one machine's damaged entry doesn't hide another machine's saved list; writes still leave the record as it is", async () => {
 const granted: Locks = { request: <T>(_name: string, run: () => Promise<T>) => run() };
 const bad = JSON.stringify({ alpha: [1], beta: ["muted-pane"] });
 const shared = memory();
 shared().setItem("muted", bad);
 const lists = machineLists("muted", shared, granted);
 expect([lists.get("beta"), lists.get("alpha"), lists.get("gamma")]).toEqual([["muted-pane"], [], []]);
 await lists.set("beta", "p2", true);
 expect([lists.get("beta"), shared().getItem("muted")]).toEqual([["muted-pane", "p2"], bad]);
});
