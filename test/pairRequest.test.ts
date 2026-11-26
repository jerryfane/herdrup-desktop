// Pair from another device (pair-v1), this computer as the new device: the sheet that chooses the
// way (n2), the request card while it waits and once it was opened (n3) or approved (n3b), the
// machines it saved (n4) and how it ended (n5). Drawn by src/pairing.ts on test/fakeDom.ts's
// document (Bun has no DOM); the host home (src/hosts.ts) places them.
import { afterEach, expect, test } from "bun:test";
import { FakeDocument, type FakeElement } from "./fakeDom";
import type { PairRequestMachine, PairRequestView, SyncedMachine } from "../src/mygo";
import { minutesLeft, nameList, notAddedLine, pairChoiceParts, pairLayout, pairReadDelay, pairRequestCard, pairResultSection, sameMachine, showPairChoice, thisDevice, untried } from "../src/pairing";

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
const glyphs = { icon: () => document.createElement("span"), chevron: () => document.createElement("span") };

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

test("n4: the saved machines open; one off this network says so with Use herdr pair; the rest say why", () => {
 const doc = page();
 const opened: string[] = [], qr: string[] = [];
 const synced: SyncedMachine[] = [{ id: "s1", host: "Pi.lan.", port: 22, user: "pi", key: true }];
 const list = view({ phase: "done", approver: "Jerry's iPhone", machines: [
  machine({ id: "jerry@studio.lan:22", reach: "online" }),
  machine({ id: "jerry@mini.lan:22", label: "mini", host: "mini.lan", reach: "unreachable" }),
  machine({ id: "jerry@old.lan:22", label: "old", host: "old.lan", reach: "refused", problem: "It didn't accept this device's key." }),
  machine({ id: "jerry@kept.lan:22", label: "kept", host: "kept.lan", result: "kept" }),
  machine({ label: "moved", host: "moved.lan", result: "pin_differs" }),
  machine({ label: "pi", host: "pi.lan", user: "pi", result: "failed", reason: "herdr is too old" }),
  machine({ label: "nas", host: "nas.lan", result: "failed", reason: "unreachable" }),
 ] });
 expect(pairLayout(list)).toEqual({ card: null, results: true });
 const box = holder(doc, pairResultSection(list, "this Mac", synced, glyphs, "<svg/>", { open: id => opened.push(id), qr: () => qr.push("qr") }));
 expect(box.querySelector("h2")!.text()).toBe("PAIRED BY JERRY'S IPHONE");
 const rows = box.all().filter(n => n.className.includes("host-home-paired-row"));
 const rowOf = (name: string) => rows.find(r => r.querySelector(".host-home-name")!.text() === name)!;
 // The failed machine the account lists says why on its own row there, not here.
 expect(rows.map(r => r.querySelector(".host-home-name")!.text())).toEqual(["studio", "mini", "old", "kept", "moved", "nas"]);
 expect(rowOf("studio").querySelector(".host-home-value")!.text()).toBe("Online");
 rowOf("studio").querySelector("button")!.click();
 expect(opened).toEqual(["jerry@studio.lan:22"]);
 const mini = rowOf("mini");
 expect(mini.querySelector(".host-home-address")!.text()).toBe("Join its network to connect");
 expect(mini.querySelector(".host-home-paired-body")!.className).toContain("host-home-row-off");
 buttonNamed(mini, "Use herdr pair")!.click();
 expect(qr).toEqual(["qr"]);
 expect(box.text()).toContain("mini is on another network. Join it from this Mac (same Wi-Fi or Tailscale), then open mini. Nothing to approve again.");
 expect(rowOf("old").querySelector(".host-home-address")!.text()).toBe("It didn't accept this device's key.");
 expect(rowOf("kept").querySelector(".host-home-address")!.text()).toBe("Already saved on this Mac, kept as it was");
 expect(rowOf("kept").querySelector(".host-home-paired-body")!.className).not.toContain("host-home-row-off");
 expect(rowOf("moved").querySelector(".host-home-address")!.text()).toBe("Not saved: this Mac knows another host key for it");
 expect(rowOf("moved").querySelector("button")).toBeNull();
 expect(rowOf("nas").querySelector(".host-home-address")!.text()).toBe("Jerry's iPhone couldn't add the key: unreachable");
 // The account's row for a failed machine: matched by user, host without case or dot, port.
 expect(sameMachine(synced[0]!, list.machines[5]!)).toBe(true);
 expect(notAddedLine(list, list.machines[5]!)).toBe("Jerry's iPhone couldn't add the key: herdr is too old");
 // A list with only an account-listed failure draws nothing.
 expect(pairResultSection(view({ phase: "done", machines: [list.machines[5]!] }), "this Mac", synced, glyphs, "", { open() {}, qr() {} })).toEqual([]);
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
