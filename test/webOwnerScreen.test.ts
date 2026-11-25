// The owner's screens in the browser (src/web/ownerScreen.ts), as parts of the desktop's host home
// (src/hostHome.ts): what each phase shows, decided by small functions; the approval and the
// approved machines drawn as host-home sections; the unsupported notice as noticeCard draws it; and
// the signed-out page (AccountWelcome with the guest's way). On test/fakeDom.ts's document.
import { afterEach, expect, test } from "bun:test";
import jsQR from "jsqr";
import { approvalParts, approvedByLabel, copyText, guideCode, guideSteps, IOS_APP_URL, machineAccess, machineRows, machineSection, noticeCard, ownerLayout, pageLink, thisBrowser, timeLeft, unsupportedNotice, type OwnerLayout } from "../src/web/ownerScreen";
import { hostHomeHeader } from "../src/hostHome";
import { AccountWelcome } from "../src/herdrupAccount";
import type { OwnerPhase } from "../src/web/ownerApproval";
import type { MachineStatus } from "../src/web/ownerProbe";
import type { OwnerRecord } from "../src/web/ownerStore";
import type { EnvelopeMachine, EnvelopeSkipped } from "../src/webguest/approve";
import { FakeDocument, type FakeElement } from "./fakeDom";

const UA = {
 ipadChrome: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1",
 iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
 macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15",
 androidChrome: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
 macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

test("which notice a browser gets: Safari on a Mac, iPhone, iPad (also Safari on iPad, which sends the Mac's agent), or the site-data reason", () => {
 expect(thisBrowser(UA.ipadChrome)).toEqual({ name: "Chrome on iOS", kind: "ipad" });
 expect(thisBrowser(UA.iphoneSafari).kind).toBe("iphone");
 expect(thisBrowser(UA.macSafari).kind).toBe("safari");
 expect(thisBrowser(UA.macSafari, 5).kind).toBe("ipad");
 expect(thisBrowser(UA.androidChrome).kind).toBe("other");
 expect(thisBrowser(UA.macChrome).kind).toBe("other");
 expect(thisBrowser(UA.androidChrome, 5).kind).toBe("other");
});

test("the notice's words: Safari is sent to another browser with the app's QR code; iPhone and iPad to the app; others get the site-data reason", () => {
 const safari = unsupportedNotice("safari");
 expect(safari.title).toBe("Open this page in Chrome, Edge or Firefox.");
 expect(safari.text).toContain("Safari can’t keep this page’s secure key");
 expect(safari.computer).toBeDefined();
 expect(safari.app?.href).toBe(IOS_APP_URL);
 for (const kind of ["iphone", "ipad"] as const) {
  const n = unsupportedNotice(kind);
  expect(n.title).toBe("HerdrUp on the web is for computers.");
  expect(n.text).toContain("the HerdrUp app reaches your machines directly");
  expect(n.app?.href).toBe(IOS_APP_URL);
  expect(n.computer).toBeUndefined();
 }
 expect(unsupportedNotice("iphone").eyebrow).toBe("On iPhone, use the app");
 expect(unsupportedNotice("ipad").eyebrow).toBe("On iPad, use the app");
 const other = unsupportedNotice("other");
 expect(other.title).toBe("This browser can't be approved");
 expect(other.text).toContain("site data");
 expect(other.text).not.toContain("Safari");
 expect(other.app).toBeUndefined();
});

test("the link to copy is this page's, without the visit's query or fragment", () => {
 expect(pageLink("https://guest.herdrup.app/web/?x=1#invite=secret")).toEqual({ href: "https://guest.herdrup.app/web/", shown: "guest.herdrup.app/web/" });
});

const LIVE: OwnerPhase[] = [{ kind: "starting" }, { kind: "waiting" }, { kind: "code", code: "4827", approver: "Mac", expiresAt: 0 }];
const ENDED: OwnerPhase[] = [{ kind: "denied" }, { kind: "expired" }, { kind: "failed", problem: "x" }, { kind: "elsewhere" }];

test("each phase has its screen, decided once: the approval until it ends, the list once approved, the notice when it can't be approved", () => {
 expect([...LIVE, ...ENDED].map(p => ownerLayout(p).view)).toEqual(Array(7).fill("guide"));
 const record = { v: 2, account: "a", devicePub: "B", approvers: [] } as OwnerRecord;
 expect(ownerLayout({ kind: "approved", record })).toEqual({ view: "list", record });
 expect(ownerLayout({ kind: "unsupported" })).toEqual({ view: "notice" });
 const code = ownerLayout(LIVE[2]);
 expect(code.view === "guide" && guideCode(code.phase)).toBe("4827");
 for (const p of [...LIVE.slice(0, 2), ...ENDED]) { const l = ownerLayout(p); expect(l.view === "guide" && guideCode(l.phase)).toBeNull(); }
});

test("the steps show only while a request is live; once it ended, the approval says to ask again instead", () => {
 for (const p of LIVE) { const l = ownerLayout(p); expect(l.view === "guide" && l.retry).toBeNull(); }
 for (const p of ENDED) {
  const l = ownerLayout(p);
  const retry = l.view === "guide" ? l.retry : null;
  expect(retry?.text).toMatch(/[Aa]sk again|[Tt]ry again/);
  expect(retry?.text).not.toContain("this page shows");
  // The words name the button they go with.
  expect(retry?.text.toLowerCase()).toContain(retry!.action.toLowerCase());
 }
});

test("a failure's retry words claim nothing about the failure, which may come after the approval", () => {
 const l = ownerLayout({ kind: "failed", problem: "HerdrUp approved this browser, but its list of machines didn't arrive or didn't open." });
 expect(l.view === "guide" && l.retry).toEqual({ action: "Try again", text: "Try again for a new code, then approve it in HerdrUp." });
});

test("another tab holding the request: the words promise no new code (that tab may finish the approval), and say what Try again does either way", () => {
 const l = ownerLayout({ kind: "elsewhere" });
 const retry = l.view === "guide" ? l.retry : null;
 expect(retry?.action).toBe("Try again");
 expect(retry?.text).not.toContain("new code");
 expect(retry?.text).toContain("close that tab");
});

test("Copy falls back to its manual selection when the clipboard refuses and when there is none", async () => {
 const calls: string[] = [];
 const done = () => calls.push("done"), failed = () => calls.push("failed");
 expect(() => copyText(undefined, "x", done, failed)).not.toThrow();
 expect(calls).toEqual(["failed"]);
 copyText({ writeText: () => Promise.reject(new Error("denied")) }, "x", done, failed);
 await Promise.resolve(); await Promise.resolve();
 expect(calls).toEqual(["failed", "failed"]);
 let written = "";
 copyText({ writeText: async t => { written = t; } }, "4827", done, failed);
 await Promise.resolve(); await Promise.resolve();
 expect([written, calls.at(-1)]).toEqual(["4827", "done"]);
});

test("the expiry counts down in minutes and seconds, a started second counting, and stops at 0:00", () => {
 expect(timeLeft(578_000, 0)).toBe("9:38");
 expect(timeLeft(61_000, 0)).toBe("1:01");
 expect(timeLeft(10_500, 10_000)).toBe("0:01");
 expect(timeLeft(5_000, 9_000)).toBe("0:00");
});

test("the three steps name the browser, and the code once there is one", () => {
 const steps = guideSteps("Chrome on macOS", "4827");
 expect(steps).toHaveLength(3);
 expect(steps[1].rest).toContain("Chrome on macOS");
 expect(steps[2].lead).toContain("4827");
 expect(guideSteps("Chrome on macOS", null)[2].lead).not.toMatch(/\d/);
});

const m = (label: string, hostID: string, scope: "chat" | "terminal", expiresUnix = 1_800_000_000): EnvelopeMachine => ({ hostItemID: "i-" + label, label, relay: "r", hostID, nodePub: "n", grantID: "g", scope, expiresUnix });
type Approver = OwnerRecord["approvers"][number];
const approver = (name: string, machines: EnvelopeMachine[], skipped: EnvelopeSkipped[] = []): Approver => ({ pub: "P-" + name, name, envelope: { seq: 1, issuedUnix: 1, approver: name, machines, skipped } });
const recordOf = (...approvers: Approver[]): OwnerRecord => ({ v: 2, account: "a", devicePub: "B", approvers });

test("each machine's status and whether it opens; a machine whose access ended can't be opened; skipped ones say why", () => {
 const record = recordOf(approver("Mac", [m("hetzner", "h1", "terminal"), m("old", "h2", "chat"), m("new", "h3", "chat")],
  [{ hostItemID: "n", label: "nas", reason: "needs_update", version: "0.8.2" }, { hostItemID: "w", label: "win", reason: "unsupported" }]));
 const statuses = new Map<string, MachineStatus>([["h1", { kind: "online", agents: 64 }], ["h2", { kind: "ended", message: "gone" }]]);
 const { rows, skipped } = machineRows(record, statuses);
 expect(rows.map(r => [r.machine.label, r.state, r.openable])).toEqual([["hetzner", "online", true], ["old", "ended", false], ["new", "checking", true]]);
 expect(skipped).toEqual([{ label: "nas", reason: "Needs a herdr update (herdr 0.8.2)" }, { label: "win", reason: "Doesn't support browser access" }]);
});

test("a machine's access, for Settings → Machines: who approved its latest grant, the desktop's access words, until when", () => {
 const record = recordOf(approver("Mac", [m("hetzner", "h1", "chat", 1_800_000_000)]), approver("iPhone", [m("hetzner", "h1", "terminal", 1_900_000_000), m("mini", "h2", "chat")]));
 expect(machineAccess(record, "h1")).toMatchObject({ approvedBy: "iPhone", access: "Chat and terminal" });
 expect(machineAccess(record, "h2")).toMatchObject({ approvedBy: "iPhone", access: "Chat only" });
 expect(machineAccess(record, "h1")?.until).not.toBe("");
 expect(machineAccess(record, "gone")).toBeNull();
});

test("one section names every approver in its label, each once", () => {
 expect(approvedByLabel(recordOf(approver("MarsMacbook", [])))).toBe("APPROVED BY MARSMACBOOK");
 expect(approvedByLabel(recordOf(approver("Mac", []), approver("iPhone", []), approver("Mac", [])))).toBe("APPROVED BY MAC, IPHONE");
});

// ---- the parts as drawn, on test/fakeDom.ts's document (Bun has no DOM) ----

/** The page's globals these parts reach: the document, its location, storage, and MyGo's events. */
const G = globalThis as { document?: unknown; location?: unknown; localStorage?: unknown; mygo?: unknown };
const saved = { document: G.document, location: G.location, localStorage: G.localStorage, mygo: G.mygo };
afterEach(() => { G.document = saved.document; G.location = saved.location; G.localStorage = saved.localStorage; G.mygo = saved.mygo; });
function fakePage() {
 const doc = new FakeDocument();
 G.document = doc;
 G.location = { href: "https://guest.herdrup.app/web/#k=1" };
 G.mygo = { on: () => () => {}, call: () => new Promise(() => {}) };
 return doc;
}
const all = (parts: HTMLElement[]) => (parts as unknown as FakeElement[]).flatMap(p => p.all());
const classes = (n: FakeElement) => n.className.split(" ");
const withClass = (nodes: FakeElement[], cls: string) => nodes.filter(n => classes(n).includes(cls));
const one = (nodes: FakeElement[], tag: string, cls?: string) => {
 const found = nodes.filter(n => n.tagName === tag && (cls === undefined || classes(n).includes(cls)));
 expect(found).toHaveLength(1);
 return found[0];
};
const buttonNamed = (nodes: FakeElement[], text: string) => nodes.find(n => n.tagName === "button" && n.text() === text);

/** What the desktop's host home has that the browser's must not (owner, 2026-11-25): SSH hosts and
 *  their menu, Add host, the pairing code, account-synced machines, shares and invites, the setup
 *  instructions, the way past the sign-in, and a Sign out of its own (Settings has it). */
function expectNoDesktopOnlyParts(nodes: FakeElement[]) {
 for (const cls of ["host-pair", "host-add", "host-invite", "host-empty", "host-home-synced", "host-owner-setup", "host-menu", "host-home-shared"])
  expect(withClass(nodes, cls).map(n => n.className)).toEqual([]);
 const text = nodes.map(n => n.text()).join("\n");
 for (const words of ["Sign out", "Set up without an account", "Add host", "Scan pairing code", "SSH", "SHARED WITH YOU", "FROM YOUR ACCOUNT"]) expect(text).not.toContain(words);
}

const BROWSER = thisBrowser(UA.macChrome);
function approval(phase: OwnerPhase) {
 fakePage();
 const done: string[] = [];
 const layout = ownerLayout(phase) as Extract<OwnerLayout, { view: "guide" }>;
 const parts = approvalParts(layout, BROWSER, { again: () => done.push("again"), guestInstead: () => done.push("guest") }, "<svg/>");
 return { nodes: all(parts), done };
}

test("a live request is one host-home section: what the page waits for, the code and the three steps as rows, then the guest's way", () => {
 for (const phase of LIVE) {
  const { nodes, done } = approval(phase);
  expect(one(nodes, "h2").textContent).toBe("APPROVE THIS BROWSER");
  expect(one(nodes, "div", "host-home-approval-status").getAttribute("role")).toBe("status");
  const steps = withClass(nodes, "host-home-step");
  expect(steps.map(s => classes(s).includes("host-home-row"))).toEqual([true, true, true]);
  expect(steps.map(s => withClass(s.all(), "host-home-icon")[0].text())).toEqual(["1", "2", "3"]);
  expect(nodes.some(n => n.tagName === "button" && n.text() === "Ask again")).toBe(false);
  buttonNamed(nodes, "Use a guest invitation instead")!.click();
  expect(done).toEqual(["guest"]);
  expectNoDesktopOnlyParts(nodes);
 }
});

test("the request shows one code: the phase's, in its digits (read out whole) and in the last step, with Copy code and its expiry", () => {
 const { nodes } = approval({ kind: "code", code: "4827", approver: "Mac", expiresAt: Date.now() + 90_000 });
 const digits = one(nodes, "div", "host-home-code");
 expect(digits.children.map(c => c.text()).join("")).toBe("4827");
 expect(digits.getAttribute("aria-label")).toBe("Code 4 8 2 7");
 expect(withClass(nodes, "host-home-step")[2].text()).toContain("Type 4827");
 expect(buttonNamed(nodes, "Copy code")).toBeDefined();
 expect(one(nodes, "span", "host-home-approval-expiry").text()).toMatch(/^Expires in 1:(29|30)$/);
 const before = approval({ kind: "waiting" }).nodes;
 expect(one(before, "div", "host-home-code").getAttribute("aria-hidden")).toBe("true");
 expect(buttonNamed(before, "Copy code")).toBeUndefined();
});

test("an ended request shows what happened and the way on, with no steps: its button asks again, and the guest's way stays but in another tab", () => {
 for (const phase of ENDED) {
  const { nodes, done } = approval(phase);
  const retry = (ownerLayout(phase) as Extract<OwnerLayout, { view: "guide" }>).retry!;
  expect(withClass(nodes, "host-home-step")).toEqual([]);
  expect(nodes.some(n => n.tagName === "p" && n.text() === retry.text)).toBe(true);
  buttonNamed(nodes, retry.action)!.click();
  const guest = buttonNamed(nodes, "Use a guest invitation instead");
  expect(guest === undefined).toBe(phase.kind === "elsewhere");
  guest?.click();
  expect(done).toEqual(phase.kind === "elsewhere" ? ["again"] : ["again", "guest"]);
  expectNoDesktopOnlyParts(nodes);
 }
 const failed = approval({ kind: "failed", problem: "The list didn't arrive." }).nodes;
 expect(failed.find(n => n.text() === "The list didn't arrive.")?.getAttribute("role")).toBe("alert");
});

const glyphs = { icon: () => (document.createElement("span") as unknown as HTMLElement), chevron: () => (document.createElement("span") as unknown as HTMLElement) };
function machines(record: OwnerRecord, statuses = new Map<string, MachineStatus>(), opening: string | null = null) {
 fakePage();
 const opened: string[] = [];
 const section = machineSection(record, statuses, glyphs, opening, "<svg/>", machine => opened.push(machine.hostID));
 const root = section.root as unknown as FakeElement;
 const rows = () => withClass(root.all(), "host-home-row");
 return { section, root, rows, opened };
}
const lines = (row: FakeElement) => withClass(row.all(), "host-home-lines")[0].children.map(c => c.text());
const value = (row: FakeElement) => withClass(row.all(), "host-home-value")[0];

test("the approved machines are one section labelled with every approver, a desktop row each: the name alone, the status in short words", () => {
 const record = recordOf(approver("MarsMacbook", [m("MarsMacbook", "h1", "terminal"), m("studio-linux", "h2", "chat")]), approver("iPhone", [m("Build box", "h3", "terminal")]));
 const { root, rows } = machines(record, new Map([["h1", { kind: "online", agents: 3 }], ["h2", { kind: "offline" }]]));
 expect(one(root.all(), "h2").textContent).toBe("APPROVED BY MARSMACBOOK, IPHONE");
 expect(rows().map(r => [r.tagName, lines(r), value(r).text()])).toEqual([
  ["button", ["MarsMacbook"], "Online"], ["button", ["studio-linux"], "Offline"], ["button", ["Build box"], "Checking…"]]);
 // No access or expiry on the row: Settings → Machines has them.
 expect(root.text()).not.toMatch(/Chat|until/i);
 expectNoDesktopOnlyParts(root.all());
});

test("picking a row opens its machine; a machine whose access ended is a disabled row; a skipped one is a dimmed row saying why, not a button", () => {
 const record = recordOf(approver("Mac", [m("hetzner", "h1", "terminal"), m("old", "h2", "chat")], [{ hostItemID: "p", label: "old-pi", reason: "needs_update", version: "0.9.2" }]));
 const { rows, opened } = machines(record, new Map([["h2", { kind: "ended", message: "gone" }]]));
 const [hetzner, old, pi] = rows();
 expect([hetzner.disabled, old.disabled, value(old).text()]).toEqual([false, true, "Access ended"]);
 hetzner.click(); old.click();
 expect(opened).toEqual(["h1"]);
 expect([pi.tagName, classes(pi).includes("host-home-row-off"), lines(pi)]).toEqual(["div", true, ["old-pi", "Needs a herdr update (herdr 0.9.2)"]]);
});

test("the machine being opened says Connecting… under its name, busy, with the spinner in the chevron's place", () => {
 const { rows } = machines(recordOf(approver("Mac", [m("hetzner", "h1", "terminal"), m("mini", "h2", "chat")])), new Map(), "h1");
 const [busy, other] = rows();
 expect([lines(busy), busy.getAttribute("aria-busy"), value(busy).hidden]).toEqual([["hetzner", "Connecting…"], "true", true]);
 expect([lines(other), other.getAttribute("aria-busy")]).toEqual([["mini"], null]);
});

test("a machine's new status shows in its row of the section it was drawn on, in place; another section is left as it is", () => {
 const first = machines(recordOf(approver("Mac", [m("hetzner", "h1", "chat")])));
 const row = first.rows()[0];
 const other = machines(recordOf(approver("Mac", [m("mini", "h2", "chat")])));
 first.section.showStatus("h1", { kind: "ended", message: "gone" });
 expect([first.rows()[0] === row, value(row).text(), row.disabled]).toEqual([true, "Access ended", true]);
 other.section.showStatus("h1", { kind: "online", agents: 1 });
 expect(value(other.rows()[0]).text()).toBe("Checking…");
 first.section.showStatus("h1", { kind: "online", agents: 1 });
 expect([value(row).text(), row.disabled]).toEqual(["Online", false]);
});

test("with no machine approved, the section says so instead of an empty card", () => {
 const { root, rows } = machines(recordOf(approver("Mac", [])));
 expect(rows()).toEqual([]);
 expect(one(root.all(), "p", "host-home-message").text()).toBe("No machines were approved for this browser.");
});

test("the header's avatar opens Settings → HerdrUp account (the only Sign out), and says the account's state", () => {
 fakePage();
 let opened = 0;
 const header = hostHomeHeader(async () => document.createElement("span"), () => { opened++; });
 const avatar = one((header.root as unknown as FakeElement).all(), "button", "host-home-account");
 expect(avatar.hidden).toBe(true);
 header.showAccount({ signedIn: true, displayHint: "jerry@example.com" }, true);
 expect([avatar.hidden, avatar.getAttribute("aria-label"), avatar.text()]).toEqual([false, "HerdrUp account, Signed in as jerry@example.com", "J"]);
 avatar.click();
 expect(opened).toBe(1);
});

// ---- noticeCard: the notice for a browser that can't be approved, as before ----

const drawUnsupported = (ua: string) => { fakePage(); return (noticeCard(thisBrowser(ua), () => {}) as unknown as FakeElement).all(); };

test("noticeCard draws the notice: a WebKit browser gets its heading, words and the App Store link, opened safely in a new tab", () => {
 const ipad = drawUnsupported(UA.ipadChrome);
 expect(one(ipad, "h1").textContent).toBe("HerdrUp on the web is for computers.");
 expect(one(ipad, "p", "web-owner-lead").textContent).toBe(unsupportedNotice("ipad").text);
 const link = one(ipad, "a");
 expect([link.href, link.target, link.rel]).toEqual([IOS_APP_URL, "_blank", "noopener"]);
 expect(ipad.some(n => n.className === "web-owner-qr")).toBe(false);

 const safari = drawUnsupported(UA.macSafari);
 expect(one(safari, "h1").textContent).toBe("Open this page in Chrome, Edge or Firefox.");
 expect(one(safari, "a").href).toBe(IOS_APP_URL);
 expect(one(safari, "span", "web-owner-qr-code").innerHTML).toContain("<svg");
 expect(one(safari, "input").value).toBe("guest.herdrup.app/web/");
 expect(one(safari, "button", "web-owner-primary").children.map(c => c.textContent)).toEqual(["Copy link"]);
});

test("noticeCard draws the notice: any other browser gets the site-data reason and no App Store link", () => {
 const android = drawUnsupported(UA.androidChrome);
 expect(one(android, "h1").textContent).toBe("This browser can't be approved");
 expect(one(android, "p", "web-owner-lead").textContent).toContain("site data");
 expect(android.filter(n => n.tagName === "a")).toEqual([]);
 expect(one(android, "button", "web-owner-link").textContent).toBe("Use a guest invitation instead");
});

test("the App Store QR code as drawn has the four-module quiet zone on every side and reads as the badge's own link", () => {
 const nodes = drawUnsupported(UA.macSafari);
 const svg = one(nodes, "span", "web-owner-qr-code").innerHTML;
 const [x, y, w, h] = svg.match(/viewBox="([^"]+)"/)![1].split(" ").map(Number);
 expect(w).toBe(h);
 const cells: number[][] = [];
 for (const [, col, row] of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) cells.push([Number(col) - x, Number(row) - y]);
 const [cols, rows] = [cells.map(c => c[0]), cells.map(c => c[1])];
 expect([Math.min(...cols), Math.min(...rows), w - 1 - Math.max(...cols), h - 1 - Math.max(...rows)]).toEqual([4, 4, 4, 4]);
 // The symbol as a camera sees it: 4 px a module, dark on white.
 const px = 4, side = w * px, image = new Uint8ClampedArray(side * side * 4).fill(255);
 for (const [c, r] of cells) for (let dy = 0; dy < px; dy++) for (let dx = 0; dx < px; dx++) image.fill(0, ((r * px + dy) * side + c * px + dx) * 4, ((r * px + dy) * side + c * px + dx) * 4 + 3);
 expect(jsQR(image, side, side)?.data).toBe(one(nodes, "a").href);
});

// ---- the signed-out page: the desktop's AccountWelcome, the guest's way its third button ----

test("signed out, the browser shows the desktop's sign-in with the guest's way in place of the setup without an account, which answers nothing for next time", () => {
 fakePage();
 const store = new Map<string, string>();
 G.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
 let done = 0, took = 0;
 const welcome = new AccountWelcome(() => { done++; }, { label: "Use a guest invitation instead", foot: "Got an invite link? Open it instead.", take: () => { took++; } });
 welcome.commit({ show: true, providers: ["apple", "google"] });
 const root = welcome.root as unknown as FakeElement;
 const nodes = root.all();
 expect(root.hidden).toBe(false);
 expect(nodes.filter(n => n.tagName === "button").map(n => n.text())).toEqual(["Continue with Apple", "Continue with Google", "Use a guest invitation instead"]);
 expect(one(nodes, "p", "account-welcome-foot").text()).toBe("Got an invite link? Open it instead.");
 expect(root.text()).not.toContain("Set up without an account");
 buttonNamed(nodes, "Use a guest invitation instead")!.click();
 // Nothing kept: the desktop's "seen" mark (finish) isn't set, so the next visit signs in again.
 expect([took, done, [...store.keys()]]).toEqual([1, 0, []]);
});
