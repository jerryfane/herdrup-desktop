// Pair from another device (pair-v1), this computer as the new device: the sheet that chooses the
// way (n2), the request card while it waits and once it was opened (n3) or approved (n3b), the
// machines it saved (n4) and how it ended (n5). Drawn by src/pairing.ts on test/fakeDom.ts's
// document (Bun has no DOM); the host home (src/hosts.ts) places them.
import { afterEach, expect, test } from "bun:test";
import { FakeDocument, type FakeElement } from "./fakeDom";
import type { Machine, PairOpenTarget, PairRequestMachine, PairRequestView, SavedMachine, SyncedMachine } from "../src/mygo";
import { isOpenTarget, machineWrites, minutesLeft, nameList, notAddedLine, pairChoiceParts, pairFailuresAfter, pairLayout, pairNextStep, pairProblemNote, pairReadDelay, pairRequestCard, pairResultSection, pairResultTarget, pairRowChanged, showPairChoice, thisDevice, untried } from "../src/pairing";

const G = globalThis as { document?: unknown };
const saved = G.document;
afterEach(() => { G.document = saved; });
function page() { const doc = new FakeDocument(); G.document = doc; return doc; }
const asFake = (node: unknown) => node as FakeElement;
const buttons = (root: FakeElement) => root.querySelectorAll("button");
const buttonNamed = (root: FakeElement, text: string) => buttons(root).find(b => b.text() === text);
const holder = (doc: FakeDocument, parts: HTMLElement[]) => { const box = doc.createElement("div"); box.append(...parts.map(asFake)); doc.body.append(box); return box; };

const view = (over: Partial<PairRequestView> = {}): PairRequestView => ({ id: "r1", phase: "waiting", expiresIn: 600, device: "Jerry's MacBook Pro", machines: [], retryOpen: false, ...over });
const machine = (over: Partial<PairRequestMachine> = {}): PairRequestMachine => ({ label: "studio", host: "studio.lan", port: 22, user: "jerry", result: "saved", ...over });
const savedAs = (id: string, localId: string): SavedMachine => {
 const [, user, host, port] = /^(.*)@(.*):(\d+)$/.exec(id)!;
 return { id, nickname: "", host: host!, port: Number(port), user: user!, keyPath: "", session: "", localId, active: false };
};
const glyphs = { machine: () => document.createElement("span"), chevron: () => document.createElement("span") };

test("this computer names itself by its platform", () => {
 expect(thisDevice("MacIntel")).toBe("this Mac");
 expect(thisDevice("Win32")).toBe("this PC");
 expect(thisDevice("Linux x86_64")).toBe("this computer");
 expect(nameList(["studio"])).toBe("studio");
 expect(nameList(["studio", "mini"])).toBe("studio and mini");
 expect(nameList(["a", "b", "c"])).toBe("a, b and c");
 expect(minutesLeft(600)).toBe("10:00");
 expect(minutesLeft(61.2)).toBe("1:02");
 expect(minutesLeft(-3)).toBe("0:00");
});

test("a request is read every 2 s its first minute, then every 5 s, and no more once it ended", () => {
 expect(pairReadDelay(view(), 10_000, 0)).toBe(2000);
 expect(pairReadDelay(view({ phase: "claimed" }), 70_000, 0)).toBe(5000);
 expect(pairReadDelay(view({ phase: "approved" }), 300_000, 0)).toBe(2000);
 expect(pairReadDelay(view({ phase: "done", retryOpen: true }), 300_000, 0)).toBe(5000);
 expect(pairReadDelay(view({ phase: "done", retryOpen: false }), 300_000, 0)).toBeNull();
 for (const phase of ["denied", "expired", "failed"]) expect(pairReadDelay(view({ phase }), 0, 0)).toBeNull();
 // Failed reads wait longer, to 30 s.
 expect(pairReadDelay(view(), 10_000, 1)).toBe(4000);
 expect(pairReadDelay(view(), 70_000, 9)).toBe(30_000);
});

test("n2: the sheet offers another device's approval first, herdr pair second", () => {
 const doc = page();
 const picked: string[] = [];
 const sheet = asFake(showPairChoice({ count: 2, password: true, here: "this Mac", approve: () => picked.push("approve"), qr: () => picked.push("qr") }, null));
 expect(sheet.open).toBe(true);
 expect(sheet.className).toContain("pairing-sheet");
 expect(sheet.querySelector("h2")!.text()).toBe("Pair this device");
 const text = sheet.text();
 expect(text).toContain("This Mac has 2 machines from your account, but no key for them yet. Choose how to add one.");
 expect(text).toContain("Your iPhone, iPad or Mac adds this Mac's key to the machines you tick. Nothing to type on the machines.");
 expect(text).toContain("On each machine run herdr pair, then scan the code it prints.");
 expect(text).toContain("Machines that log in with a password switch to a key on this Mac.");
 const approve = buttonNamed(sheet, "Approve from another device")!, qr = buttonNamed(sheet, "Use herdr pair (QR)")!;
 // Owner rules: capsules, the first way filled, the second secondary.
 expect(approve.className).toContain("button-filled");
 expect(qr.className).toContain("button-secondary");
 expect(buttons(sheet).indexOf(approve)).toBeLessThan(buttons(sheet).indexOf(qr));
 approve.click();
 expect(picked).toEqual(["approve"]);
 expect(sheet.open).toBe(false);
 expect(doc.body.contains(sheet)).toBe(false);
 // Cancel closes it with nothing chosen; herdr pair is the scanner.
 const again = asFake(showPairChoice({ count: 1, password: false, here: "this Mac", approve: () => picked.push("approve"), qr: () => picked.push("qr") }, null));
 expect(again.text()).toContain("This Mac has 1 machine from your account");
 expect(again.text()).not.toContain("password");
 buttonNamed(again, "Cancel")!.click();
 expect(picked).toEqual(["approve"]);
 const third = asFake(showPairChoice({ count: 1, password: false, here: "this Mac", approve: () => picked.push("approve"), qr: () => picked.push("qr") }, null));
 buttonNamed(third, "Use herdr pair (QR)")!.click();
 expect(picked).toEqual(["approve", "qr"]);
 // The parts alone carry the QR glyph in front of the words.
 const icon = doc.createElement("span");
 const parts = pairChoiceParts({ count: 1, password: false, here: "this PC", approve() {}, qr() {} }, icon as unknown as HTMLElement, () => {}).map(asFake);
 const qrButton = parts.find(p => p.text() === "Use herdr pair (QR)")!;
 expect(qrButton.children[0]).toBe(icon);
 expect(parts[0]!.text()).toStartWith("This PC has 1 machine");
});

test("n3: the request waits with dots, then shows the code once the other device opened it", () => {
 const doc = page();
 const calls: string[] = [];
 const actions = { cancel: () => calls.push("cancel"), again: () => calls.push("again"), qr: () => calls.push("qr") };
 const waiting = holder(doc, pairRequestCard(view(), "this Mac", "jerry@example.com", "<svg/>", Date.now() + 598_000, actions));
 const text = waiting.text();
 expect(waiting.querySelector("h2")!.text()).toBe("PAIR THIS MAC");
 expect(waiting.querySelector(".host-home-approval-status")!.text()).toBe("Waiting for your other device");
 expect(text).toContain("Approve on your iPhone, iPad or Mac");
 expect(waiting.querySelector(".host-home-code")!.className).toContain("host-home-code-none");
 expect(waiting.querySelector(".host-home-approval-expiry")!.text()).toMatch(/^Expires in(9:5\d|9:58)$/);
 expect(text).toContain("On your iPhone, iPad or Mac, signed in as jerry@example.com.");
 expect(text).toContain("Pair Jerry's MacBook Pro?");
 expect(text).toContain("Opens by itself and names this Mac.");
 expect(text).toContain("Then tick the machines and Approve.");
 expect(text).toContain("This Mac made its own key. Your machines accept it only after you approve it.");
 const cancel = buttonNamed(waiting, "Cancel")!;
 expect(cancel.className).toContain("button-secondary");
 cancel.click();
 expect(calls).toEqual(["cancel"]);

 const claimed = holder(doc, pairRequestCard(view({ phase: "claimed", approver: "Jerry's iPhone", code: "4831" }), "this Mac", "jerry@example.com", "<svg/>", Date.now() + 300_000, actions));
 expect(claimed.querySelector(".host-home-approval-status")!.text()).toBe("Opened on Jerry's iPhone");
 expect(claimed.text()).toContain("HerdrUp there asks to pair Jerry's MacBook Pro. Type these 4 digits there.");
 const code = claimed.querySelector(".host-home-code")!;
 expect(code.className).toBe("host-home-code");
 expect(code.children.map(c => c.text())).toEqual(["4", "8", "3", "1"]);
 expect(code.getAttribute("aria-label")).toBe("Code 4 8 3 1");
 expect(claimed.text()).toContain("Type 4831");
 expect(pairLayout(view({ phase: "claimed", code: "4831" }))).toEqual({ card: "claimed", results: false });
});

test("n3b: approved, the card says where and what it connects to, without Cancel", () => {
 const doc = page();
 const actions = { cancel() {}, again() {}, qr() {} };
 const adding = holder(doc, pairRequestCard(view({ phase: "approved", approver: "Jerry's iPhone", code: "4831" }), "this Mac", "", "<svg/>", 0, actions));
 expect(adding.querySelector(".host-home-approval-status")!.text()).toBe("Jerry's iPhone is adding the key…");
 expect(adding.querySelector("h3")!.text()).toBe("Approved on Jerry's iPhone");
 expect(buttonNamed(adding, "Cancel")).toBeUndefined();
 const list = view({ phase: "done", approver: "Jerry's iPhone", code: "4831", machines: [machine({ id: "a" }), machine({ id: "b", label: "mini", host: "mini.lan" }), machine({ label: "nas", result: "failed", reason: "no herdr" })] });
 expect(untried(list)).toBe(true);
 expect(pairLayout(list)).toEqual({ card: "approved", results: false });
 const connecting = holder(doc, pairRequestCard(list, "this Mac", "", "<svg/>", 0, actions));
 expect(connecting.querySelector(".host-home-approval-status")!.text()).toBe("Connecting to studio and mini…");
 expect(connecting.text()).toContain("This Mac's key is on studio and mini.");
});

test("n4: the saved machines open with their menu; one off this network says so with Use herdr pair; the rest say why", () => {
 const doc = page();
 const opened: PairOpenTarget[] = [], qr: string[] = [], menus: string[] = [];
 const synced: SyncedMachine[] = [{ id: "s1", host: "pi.lan", port: 22, user: "pi", key: true }];
 const list = view({ phase: "done", approver: "Jerry's iPhone", machines: [
  machine({ id: "jerry@studio.lan:22", profileId: "p-studio", reach: "online" }),
  machine({ id: "jerry@mini.lan:22", profileId: "p-mini", label: "mini", host: "mini.lan", reach: "unreachable" }),
  machine({ id: "jerry@old.lan:22", profileId: "p-old", label: "old", host: "old.lan", reach: "refused", problem: "It didn't accept this device's key." }),
  machine({ id: "jerry@kept.lan:22", profileId: "p-kept", label: "kept", host: "kept.lan", result: "kept" }),
  machine({ id: "jerry@gone.lan:22", profileId: "p-gone", label: "gone", host: "gone.lan", reach: "removed" }),
  machine({ id: "jerry@deleted.lan:22", profileId: "p-deleted", label: "deleted", host: "deleted.lan", reach: "online" }),
  machine({ label: "moved", host: "moved.lan", result: "pin_differs" }),
  machine({ label: "pi", host: "pi.lan", user: "pi", result: "failed", reason: "herdr is too old", syncedId: "s1" }),
  machine({ label: "nas", host: "nas.lan", result: "failed", reason: "unreachable" }),
  machine({ id: "jerry@edited.lan:22", profileId: "p-edited", label: "edited", host: "edited.lan", reach: "online" }),
  machine({ id: "jerry@retyped.lan:22", profileId: "p-retyped", label: "retyped", host: "retyped.lan", reach: "changed" }),
 ] });
 // edited and retyped were edited since to another port (Go settled retyped as changed); gone and
 // deleted were removed, and deleted's address saved again as another profile.
 const saved = [savedAs("jerry@studio.lan:22", "p-studio"), savedAs("jerry@mini.lan:22", "p-mini"), savedAs("jerry@old.lan:22", "p-old"),
  savedAs("jerry@kept.lan:22", "p-kept"), savedAs("jerry@gone.lan:22", "p-gone-again"), savedAs("jerry@deleted.lan:22", ""),
  savedAs("jerry@edited.lan:2222", "p-edited"), savedAs("jerry@retyped.lan:2200", "p-retyped")];
 const actions = { open: (t: PairOpenTarget) => opened.push(t), qr: () => qr.push("qr"), menu: (t: PairOpenTarget, x: number, y: number) => menus.push(`${t.id} ${t.profileId} ${x},${y}`) };
 expect(pairLayout(list)).toEqual({ card: null, results: true });
 // The SAVED rows that step aside (hosts.ts): only the profiles a result row opens.
 expect(list.machines.flatMap(m => pairResultTarget(m, saved) ?? [])).toEqual(["jerry@studio.lan:22", "jerry@mini.lan:22", "jerry@old.lan:22", "jerry@kept.lan:22"]);
 const box = holder(doc, pairResultSection(list, "this Mac", synced, saved, glyphs, "<svg/>", actions));
 expect(box.querySelector("h2")!.text()).toBe("PAIRED BY JERRY'S IPHONE");
 const rows = box.all().filter(n => n.className.includes("host-home-paired-row"));
 const rowOf = (name: string) => rows.find(r => r.querySelector(".host-home-name")!.text() === name)!;
 // The failed machine the account lists (by its record's id) says why on its own row there.
 expect(rows.map(r => r.querySelector(".host-home-name")!.text())).toEqual(["studio", "mini", "old", "kept", "gone", "deleted", "moved", "nas", "edited", "retyped"]);
 expect(rowOf("studio").querySelector(".host-home-value")!.text()).toBe("Online");
 const studio = rowOf("studio").querySelector("button")!;
 studio.click();
 // It opens the profile it drew (its id, profile id and address), which Go checks again.
 const studioTarget = { id: "jerry@studio.lan:22", profileId: "p-studio", user: "jerry", host: "studio.lan", port: 22 };
 expect(opened).toEqual([studioTarget]);
 // The saved host's menu (Edit, Delete), as its SAVED row has it: right click, or the menu key.
 (studio.oncontextmenu as unknown as (e: object) => void)({ preventDefault() {}, clientX: 5, clientY: 7 });
 (studio.onkeydown as unknown as (e: object) => void)({ key: "ContextMenu", shiftKey: false, preventDefault() {} });
 expect(menus).toEqual(["jerry@studio.lan:22 p-studio 5,7", "jerry@studio.lan:22 p-studio 20,0"]);
 // The page finds the row's profile only while it is still that one.
 expect(saved.filter(s => isOpenTarget(s, studioTarget)).map(s => s.id)).toEqual(["jerry@studio.lan:22"]);
 expect(isOpenTarget(savedAs("jerry@studio.lan:22", "p-studio-again"), studioTarget)).toBe(false);
 expect(isOpenTarget(savedAs("jerry@studio.lan:22", "p-studio"), { ...studioTarget, port: 2222 })).toBe(false);
 const mini = rowOf("mini");
 expect(mini.querySelector(".host-home-address")!.text()).toBe("Join its network to connect");
 expect(mini.querySelector(".host-home-paired-body")!.className).toContain("host-home-row-off");
 buttonNamed(mini, "Use herdr pair")!.click();
 expect(qr).toEqual(["qr"]);
 expect(box.text()).toContain("mini is on another network. Join it from this Mac (same Wi-Fi or Tailscale), then open mini. Nothing to approve again.");
 expect(rowOf("old").querySelector(".host-home-address")!.text()).toBe("It didn't accept this device's key.");
 expect(rowOf("kept").querySelector(".host-home-address")!.text()).toBe("Already saved on this Mac, kept as it was");
 expect(rowOf("kept").querySelector(".host-home-paired-body")!.className).not.toContain("host-home-row-off");
 // Removed here since (Go settled it, or the page's list no longer has it): no row to open.
 for (const name of ["gone", "deleted"]) {
  expect(rowOf(name).querySelector(".host-home-address")!.text()).toBe("No longer saved on this Mac");
  expect(rowOf(name).querySelector("button")).toBeNull();
 }
 // Edited here since to another address: not the machine approved, so no row to open either.
 for (const name of ["edited", "retyped"]) {
  expect(rowOf(name).querySelector(".host-home-address")!.text()).toBe("Changed on this Mac since it was saved");
  expect(rowOf(name).querySelector("button")).toBeNull();
 }
 expect(rowOf("moved").querySelector(".host-home-address")!.text()).toBe("Not saved: this Mac knows another host key for it");
 expect(rowOf("moved").querySelector("button")).toBeNull();
 expect(rowOf("nas").querySelector(".host-home-address")!.text()).toBe("Jerry's iPhone couldn't add the key: unreachable");
 expect(notAddedLine(list, list.machines[7]!)).toBe("Jerry's iPhone couldn't add the key: herdr is too old");
 // A list with only an account-listed failure draws no rows; its problem is the request's note.
 expect(pairResultSection(view({ phase: "done", machines: [list.machines[7]!] }), "this Mac", synced, saved, glyphs, "", actions)).toEqual([]);
 const tampered = view({ phase: "done", machines: [list.machines[7]!], problem: "A later machine list was tampered with on its way, so this device saved none of it." });
 expect(pairResultSection(tampered, "this Mac", synced, saved, glyphs, "", actions)).toEqual([]);
 expect(pairProblemNote(tampered)!.textContent).toBe("A later machine list was tampered with on its way, so this device saved none of it.");
});

test("the request's problem shows without a card even when the list had no machines", () => {
 page();
 // A first list that was empty: done, no rows to draw, and the problem final.
 const empty = view({ phase: "done", approver: "Jerry's iPhone", machines: [], problem: "Jerry's iPhone sent no machines." });
 expect(pairLayout(empty)).toEqual({ card: null, results: false });
 const note = pairProblemNote(empty)!;
 expect(note.textContent).toBe("Jerry's iPhone sent no machines.");
 expect(note.getAttribute("role")).toBe("status");
 expect(pairProblemNote(view({ phase: "done", machines: [] }))).toBeNull();
 // A card says its own problem: no second note.
 expect(pairProblemNote(view({ phase: "approved", saveFailed: true, problem: "This device couldn't save those machines (disk full). Trying again." }))).toBeNull();
 expect(pairProblemNote(view({ phase: "failed", problem: "The approved list didn't open on this Mac." }))).toBeNull();
});

test("Edit and Delete from a result row's menu go through Go's check of the row's profile; from SAVED, as before", async () => {
 const calls: string[] = [];
 let still = true;
 const desk = {
  saveMachine: async (m: Machine, replacing: string) => { calls.push(`save ${m.nickname} over ${replacing}`); },
  removeMachine: async (id: string) => { calls.push(`remove ${id}`); },
  savePairedMachine: async (m: Machine, t: PairOpenTarget) => { calls.push(`save ${m.nickname} over ${t.id} if ${t.profileId}`); return still; },
  removePairedMachine: async (t: PairOpenTarget) => { calls.push(`remove ${t.id} if ${t.profileId}`); return still; },
 };
 const target = { id: "jerry@studio.lan:22", profileId: "p-studio", user: "jerry", host: "studio.lan", port: 22 };
 const edited: Machine = { nickname: "Studio", host: "studio.lan", port: 22, user: "jerry", keyPath: "/k", session: "" };
 await machineWrites(target, desk).save(edited, "jerry@studio.lan:22");
 await machineWrites(target, desk).remove("jerry@studio.lan:22");
 await machineWrites(null, desk).save(edited, "jerry@studio.lan:22");
 await machineWrites(null, desk).remove("jerry@studio.lan:22");
 expect(calls).toEqual([
  "save Studio over jerry@studio.lan:22 if p-studio", "remove jerry@studio.lan:22 if p-studio",
  "save Studio over jerry@studio.lan:22", "remove jerry@studio.lan:22",
 ]);
 // The profile was replaced at the same address since the row was drawn: Go changes nothing, and
 // the page says it changed.
 still = false;
 await expect(machineWrites(target, desk).save(edited, "jerry@studio.lan:22")).rejects.toThrow(pairRowChanged);
 await expect(machineWrites(target, desk).remove("jerry@studio.lan:22")).rejects.toThrow(pairRowChanged);
});

test("the page tries saved machines, then reads, never at once, and stops once settled", () => {
 const tried = view({ phase: "done", retryOpen: true, machines: [machine({ id: "a", reach: "online" })] });
 expect(pairNextStep(view({ phase: "done", retryOpen: true, machines: [machine({ id: "a" })] }), 0, 0)).toEqual({ connect: true, wait: 1000 });
 expect(pairNextStep(view({ phase: "done", machines: [machine({ id: "a" })] }), 0, 9)).toEqual({ connect: true, wait: 30_000 });
 // A machine Go settled as removed is not tried again.
 expect(pairNextStep(view({ phase: "done", retryOpen: false, machines: [machine({ id: "a", reach: "removed" })] }), 0, 0)).toBeNull();
 expect(pairNextStep(tried, 0, 0)).toEqual({ connect: false, wait: 5000 });
 for (const v of [view(), view({ phase: "approved" }), tried]) expect(pairNextStep(v, 0, 0)!.wait).toBeGreaterThan(0);
});

test("a list that couldn't be saved yet shows on the card while it is read again, backing off", () => {
 const doc = page();
 const failing = view({ phase: "approved", approver: "Jerry's iPhone", code: "4831", saveFailed: true, problem: "This device couldn't save those machines (disk full). Trying again." });
 const card = holder(doc, pairRequestCard(failing, "this Mac", "", "<svg/>", 0, { cancel() {}, again() {}, qr() {} }));
 expect(card.querySelector("h3")!.text()).toBe("Approved on Jerry's iPhone");
 expect(card.all().find(n => n.getAttribute("role") === "alert")!.text()).toBe("This device couldn't save those machines (disk full). Trying again.");
 // Each such read counts as a failed one: the reads back off to 30 s, and one that saved resets it.
 let failures = 0;
 const waits: number[] = [];
 for (let i = 0; i < 6; i++) { failures = pairFailuresAfter(failing, failures); waits.push(pairNextStep(failing, 0, failures)!.wait); }
 expect(waits).toEqual([4000, 8000, 16_000, 30_000, 30_000, 30_000]);
 expect(pairFailuresAfter(view({ phase: "done", retryOpen: true }), failures)).toBe(0);
});

test("n5: denied, expired or failed, the card offers Ask again and herdr pair", () => {
 const doc = page();
 const calls: string[] = [];
 const actions = { cancel: () => calls.push("cancel"), again: () => calls.push("again"), qr: () => calls.push("qr") };
 const denied = holder(doc, pairRequestCard(view({ phase: "denied", approver: "Jerry's iPhone" }), "this Mac", "", "", 0, actions));
 expect(denied.querySelector("h3")!.text()).toBe("Not approved");
 expect(denied.text()).toContain("Jerry's iPhone didn't approve this Mac.");
 expect(denied.text()).toContain("Ask again for a new code, or pair with herdr pair instead.");
 expect(buttonNamed(denied, "Cancel")).toBeUndefined();
 const again = buttonNamed(denied, "Ask again")!;
 expect(again.className).toContain("button-filled");
 again.click();
 buttonNamed(denied, "Use herdr pair (QR)")!.click();
 expect(calls).toEqual(["again", "qr"]);
 const expired = holder(doc, pairRequestCard(view({ phase: "expired" }), "this Mac", "", "", 0, actions));
 expect(expired.querySelector("h3")!.text()).toBe("The request expired");
 expect(expired.text()).toContain("No device approved this Mac in 10 minutes.");
 const failed = holder(doc, pairRequestCard(view({ phase: "failed", problem: "The approved list didn't open on this Mac." }), "this Mac", "", "", 0, actions));
 const problem = failed.all().find(n => n.getAttribute("role") === "alert")!;
 expect(problem.text()).toBe("The approved list didn't open on this Mac.");
 for (const phase of ["denied", "expired", "failed"]) expect(pairLayout(view({ phase }))).toEqual({ card: "ended", results: false });
});
