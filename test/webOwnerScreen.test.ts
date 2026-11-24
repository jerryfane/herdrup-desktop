// The owner's screen in the browser (src/web/ownerScreen.ts): what each phase shows, decided by
// small functions, and the unsupported notice as ownerCard draws it, on a minimal fake document.
import { afterEach, expect, test } from "bun:test";
import jsQR from "jsqr";
import { arrives, copyText, guideCode, guideSteps, IOS_APP_URL, machineRows, ownerCard, ownerLayout, pageLink, thisBrowser, timeLeft, unsupportedNotice } from "../src/web/ownerScreen";
import type { OwnerPhase } from "../src/web/ownerApproval";
import type { MachineStatus } from "../src/web/ownerProbe";
import type { OwnerRecord } from "../src/web/ownerStore";

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

test("each phase has its screen, decided once: the guide until it ends, the list once approved, the notice when it can't be approved", () => {
 expect([...LIVE, ...ENDED].map(p => ownerLayout(p).view)).toEqual(Array(7).fill("guide"));
 const record = { v: 2, account: "a", devicePub: "B", approvers: [] } as OwnerRecord;
 expect(ownerLayout({ kind: "approved", record })).toEqual({ view: "list", record });
 expect(ownerLayout({ kind: "unsupported" })).toEqual({ view: "notice" });
 const code = ownerLayout(LIVE[2]);
 expect(code.view === "guide" && guideCode(code.phase)).toBe("4827");
 for (const p of [...LIVE.slice(0, 2), ...ENDED]) { const l = ownerLayout(p); expect(l.view === "guide" && guideCode(l.phase)).toBeNull(); }
});

test("the guide's steps show only while a request is live; once it ended, the guide says to ask again instead", () => {
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
 expect(l.view === "guide" && l.retry).toEqual({ action: "Try again", text: "Another tab is approving this browser. Finish there, then choose Try again here, or close that tab and choose Try again to start over." });
});

test("the guide shows one code: the phase's, in the left side's digits and in the drawing's boxes", () => {
 const nodes = draw({ kind: "code", code: "4827", approver: "Mac", expiresAt: Date.now() + 60_000 }, UA.macChrome).all();
 const left = one(nodes, "div", "web-owner-code").children.map(c => (c as FakeElement).text()).join("");
 const drawn = one(nodes, "span", "wod-boxes").children.map(c => (c as FakeElement).text()).join("");
 expect([left, drawn]).toEqual(["4827", "4827"]);
});

test("the rows rise in only on the way from the code to the list, not on a redraw or a list kept from before", () => {
 expect(arrives("code", "approved")).toBe(true);
 expect(arrives("approved", "approved")).toBe(false);
 expect(arrives(null, "approved")).toBe(false);
 expect(arrives("starting", "approved")).toBe(false);
 expect(arrives("waiting", "code")).toBe(false);
});

test("the list's entrance is web.css's: the card says how long ago the list arrived, also once it is over", () => {
 const at = performance.now() - 5_000;
 const arrived = draw({ kind: "approved", record: oneMachine }, UA.macChrome, undefined, at);
 expect(arrived.className.split(" ")).toContain("web-owner-arrive");
 expect(Number.parseFloat(arrived.style.props.get("--arrive-elapsed")!)).toBeGreaterThanOrEqual(5_000);
 const still = draw({ kind: "approved", record: oneMachine }, UA.macChrome);
 expect([still.className.split(" ").includes("web-owner-arrive"), still.style.props.has("--arrive-elapsed")]).toEqual([false, false]);
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

test("the guide's steps follow the switch and name the browser and the code once there is one", () => {
 const computer = guideSteps("computer", "Chrome on macOS", "4827");
 expect(computer.map(s => s.lead)).toEqual(["Open HerdrUp", "Approve a browser?", "Type 4827"]);
 expect(computer[0].rest).toContain("Mac or PC");
 expect(computer[1].rest).toContain("Chrome on macOS");
 expect(computer[2].rest).toContain("click Approve");
 const phone = guideSteps("phone", "Chrome on macOS", null);
 expect(phone[0].rest).toContain("iPhone or iPad");
 expect(phone[2].lead).toBe("Type the code");
 expect(phone[2].rest).toContain("tap Approve");
});

test("Pick a machine: each machine's status, access and until; a machine that ended can't be opened; skipped ones say why", () => {
 const m = (label: string, hostID: string, scope: "chat" | "terminal") => ({ hostItemID: "i-" + label, label, relay: "r", hostID, nodePub: "n", grantID: "g", scope, expiresUnix: 1_800_000_000 });
 const record: OwnerRecord = { v: 2, account: "a", devicePub: "B", approvers: [{ pub: "A", name: "Mac", envelope: { seq: 1, issuedUnix: 1, approver: "x",
  machines: [m("hetzner", "h1", "terminal"), m("old", "h2", "chat"), m("new", "h3", "chat")],
  skipped: [{ hostItemID: "n", label: "nas", reason: "needs_update", version: "0.8.2" }, { hostItemID: "w", label: "win", reason: "unsupported" }] } }] };
 const statuses = new Map<string, MachineStatus>([["h1", { kind: "online", agents: 64 }], ["h2", { kind: "ended", message: "gone" }]]);
 const { rows, skipped } = machineRows(record, statuses);
 expect(rows.map(r => [r.machine.label, r.status, r.state, r.openable])).toEqual([
  ["hetzner", "Online · 64 agents", "online", true], ["old", "Not approved on this machine any more", "ended", false], ["new", "Checking…", "checking", true]]);
 expect(rows[0].access).toStartWith("Chat and terminal · until ");
 expect(rows[1].access).toStartWith("Chat · until ");
 expect(skipped).toEqual([{ label: "nas", reason: "Needs a herdr update (herdr 0.8.2)" }, { label: "win", reason: "Doesn't support browser access" }]);
});

// ---- ownerCard's drawing, on a fake document (Bun has no DOM) ----

/** The few DOM calls the screen makes: createElement, createTextNode, className, textContent,
 *  setAttribute, append, replaceChildren, addEventListener, style, dataset and plain properties. */
class FakeText {
 constructor(public data: string) {}
 all(): FakeElement[] { return []; }
 get textContent() { return this.data; }
}
class FakeElement {
 className = ""; textContent = ""; innerHTML = ""; href = ""; target = ""; rel = ""; value = ""; readOnly = false; type = "";
 name = ""; checked = false; disabled = false; isConnected = true;
 readonly children: (FakeElement | FakeText)[] = [];
 readonly attributes = new Map<string, string>();
 readonly dataset: Record<string, string> = {};
 readonly listeners = new Map<string, () => void>();
 readonly style = { props: new Map<string, string>(), setProperty(name: string, value: string) { this.props.set(name, value); } };
 readonly classList = { add: (c: string) => { this.className += ` ${c}`; } };
 constructor(readonly tagName: string) {}
 setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
 append(...nodes: (FakeElement | FakeText)[]) { this.children.push(...nodes); }
 replaceChildren(...nodes: (FakeElement | FakeText)[]) { this.children.splice(0, this.children.length, ...nodes); }
 addEventListener(type: string, run: () => void) { this.listeners.set(type, run); }
 all(): FakeElement[] { return [this, ...this.children.flatMap(c => c.all())]; }
 text(): string { return this.textContent + this.children.map(c => c instanceof FakeText ? c.data : c.text()).join(""); }
}
const saved = { document: (globalThis as { document?: unknown }).document, location: (globalThis as { location?: unknown }).location };
afterEach(() => {
 (globalThis as { document?: unknown }).document = saved.document;
 (globalThis as { location?: unknown }).location = saved.location;
});
function card(phase: OwnerPhase, ua: string, statuses?: Map<string, MachineStatus>, arrivedAt?: number) {
 (globalThis as { document?: unknown }).document = { createElement: (tag: string) => new FakeElement(tag), createTextNode: (data: string) => new FakeText(data) };
 (globalThis as { location?: unknown }).location = { href: "https://guest.herdrup.app/web/#k=1" };
 const drawn = ownerCard(phase, thisBrowser(ua), { again() {}, guestInstead() {}, open() {} }, "", statuses, arrivedAt ?? null);
 return { root: drawn.root as unknown as FakeElement, showStatus: drawn.showStatus };
}
const draw = (phase: OwnerPhase, ua: string, statuses?: Map<string, MachineStatus>, arrivedAt?: number) => card(phase, ua, statuses, arrivedAt).root;
const drawUnsupported = (ua: string) => draw({ kind: "unsupported" }, ua).all();
const one = (nodes: FakeElement[], tag: string, cls?: string) => {
 const found = nodes.filter(n => n.tagName === tag && (cls === undefined || n.className.split(" ").includes(cls)));
 expect(found).toHaveLength(1);
 return found[0];
};

test("ownerCard draws the notice: a WebKit browser gets its heading, words and the App Store link, opened safely in a new tab", () => {
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

test("ownerCard draws the notice: any other browser gets the site-data reason and no App Store link", () => {
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

test("the platform switch is radios kept in place: choosing iPhone or iPad draws only the drawing and the steps again", () => {
 const card = draw({ kind: "waiting" }, UA.macChrome);
 const radios = card.all().filter(n => n.tagName === "input");
 expect(radios.map(r => [r.type, r.name, r.value, r.checked])).toEqual([["radio", "web-owner-platform", "computer", true], ["radio", "web-owner-platform", "phone", false]]);
 expect(one(card.all(), "ol", "web-owner-steps").text()).toContain("Mac or PC");
 const pick = (i: number) => { radios.forEach((r, j) => { r.checked = i === j; }); radios[i].listeners.get("change")!(); };
 pick(1);
 const after = card.all();
 const inputs = after.filter(n => n.tagName === "input");
 expect(inputs.length === radios.length && inputs.every((r, i) => r === radios[i])).toBe(true);
 expect(one(after, "ol", "web-owner-steps").text()).toContain("iPhone or iPad");
 expect(one(after, "div", "web-owner-drawing-phone")).toBeDefined();
 pick(0);
});

test("an ended request's guide keeps its layout but shows what to do instead of the steps, beside the same button", () => {
 for (const [phase, action] of [[{ kind: "expired" }, "Ask again"], [{ kind: "failed", problem: "x" }, "Try again"], [{ kind: "elsewhere" }, "Try again"]] as const) {
  const nodes = draw(phase, UA.macChrome).all();
  expect(nodes.some(n => n.className === "web-owner-steps")).toBe(false);
  expect(one(nodes, "p", "web-owner-howto-ended").textContent).toContain(action);
  expect(one(nodes, "button", "web-owner-primary").text()).toBe(action);
  // One sentence says what the button does: no other paragraph repeats its words.
  expect(nodes.filter(n => n.tagName === "p" && n.text().toLowerCase().includes(action.toLowerCase())).map(n => n.className)).toEqual(["web-owner-howto-ended"]);
  expect(nodes.some(n => n.text().includes("No request was made"))).toBe(false);
 }
});

test("the drawing's numbered markers show only beside the steps they point to", () => {
 const markers = (phase: OwnerPhase) => draw(phase, UA.macChrome).all().filter(n => n.className.startsWith("wod-marker")).map(n => n.textContent);
 expect(markers({ kind: "waiting" })).toEqual(["1", "2", "3"]);
 expect(markers({ kind: "code", code: "4827", approver: "Mac", expiresAt: Date.now() + 60_000 })).toEqual(["1", "2", "3"]);
 for (const p of ENDED) expect(markers(p)).toEqual([]);
});

const machine = (hostID: string, label: string) => ({ hostItemID: "i-" + hostID, label, relay: "r", hostID, nodePub: "n", grantID: "g", scope: "chat" as const, expiresUnix: 1_800_000_000 });
const listOf = (...machines: ReturnType<typeof machine>[]): OwnerRecord => ({ v: 2, account: "a", devicePub: "B", approvers: [{ pub: "A", name: "Mac", envelope: { seq: 1, issuedUnix: 1, approver: "x", machines, skipped: [] } }] });
const oneMachine = listOf(machine("h1", "hetzner"));

test("a machine's new status shows in its row of the card it was drawn on, in place; other cards are left as they are", () => {
 const first = card({ kind: "approved", record: oneMachine }, UA.macChrome);
 const status = one(first.root.all(), "span", "web-owner-status");
 expect(status.text()).toBe("Checking…");
 // Another card drawn meanwhile (a list without that machine, or the guide) takes nothing from it.
 const other = card({ kind: "approved", record: listOf(machine("h2", "mini")) }, UA.macChrome);
 const otherRows = () => other.root.all().filter(n => n.className === "web-owner-status").map(n => [n.dataset.state, n.text()]);
 const before = otherRows();
 const guide = card({ kind: "waiting" }, UA.macChrome);
 expect(guide.showStatus).toBeUndefined();
 first.showStatus!("h1", { kind: "ended", message: "gone" });
 expect([status.dataset.state, status.text(), one(first.root.all(), "button", "web-owner-action").disabled]).toEqual(["ended", "Not approved on this machine any more", true]);
 other.showStatus!("h1", { kind: "online", agents: 1 });
 expect(otherRows()).toEqual(before);
 expect(status.text()).toBe("Not approved on this machine any more");
});
