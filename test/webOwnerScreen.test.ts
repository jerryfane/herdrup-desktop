// The owner's screen in the browser (src/web/ownerScreen.ts): what each phase shows, decided by
// small functions, and the unsupported notice as ownerCard draws it, on a minimal fake document.
import { afterEach, expect, test } from "bun:test";
import qrcode from "qrcode-generator";
import { appStoreQR, arrives, guideSteps, IOS_APP_URL, machineRows, ownerCard, ownerView, pageLink, thisBrowser, timeLeft, unsupportedNotice } from "../src/web/ownerScreen";
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

test("the QR code is the App Store link's, module for module", () => {
 const qr = appStoreQR();
 const code = qrcode(0, "M"); code.addData(IOS_APP_URL); code.make();
 let path = "";
 for (let row = 0; row < code.getModuleCount(); row++) for (let col = 0; col < code.getModuleCount(); col++) if (code.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
 expect(qr).toEqual({ url: IOS_APP_URL, size: code.getModuleCount(), path });
});

test("the link to copy is this page's, without the visit's query or fragment", () => {
 expect(pageLink("https://guest.herdrup.app/web/?x=1#invite=secret")).toEqual({ href: "https://guest.herdrup.app/web/", shown: "guest.herdrup.app/web/" });
});

test("each phase has its screen: the guide until it ends, the list once approved, the notice when it can't be approved", () => {
 expect((["starting", "waiting", "code", "denied", "expired", "failed", "elsewhere"] as const).map(ownerView)).toEqual(Array(7).fill("guide"));
 expect(ownerView("approved")).toBe("list");
 expect(ownerView("unsupported")).toBe("notice");
});

test("the rows rise in only on the way from the code to the list, not on a redraw or a list kept from before", () => {
 expect(arrives("code", "approved")).toBe(true);
 expect(arrives("approved", "approved")).toBe(false);
 expect(arrives(null, "approved")).toBe(false);
 expect(arrives("starting", "approved")).toBe(false);
 expect(arrives("waiting", "code")).toBe(false);
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

// ---- The unsupported notice as ownerCard draws it, on a fake document (Bun has no DOM) ----

/** The few DOM calls the notice makes: createElement, className, textContent, setAttribute,
 *  append, addEventListener, and plain properties (href, target, rel, innerHTML, value). */
class FakeElement {
 className = ""; textContent = ""; innerHTML = ""; href = ""; target = ""; rel = ""; value = ""; readOnly = false; type = "";
 readonly children: FakeElement[] = [];
 readonly attributes = new Map<string, string>();
 constructor(readonly tagName: string) {}
 setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
 append(...nodes: FakeElement[]) { this.children.push(...nodes); }
 addEventListener() {}
 all(): FakeElement[] { return [this, ...this.children.flatMap(c => c.all())]; }
}
const saved = { document: (globalThis as { document?: unknown }).document, location: (globalThis as { location?: unknown }).location };
afterEach(() => {
 (globalThis as { document?: unknown }).document = saved.document;
 (globalThis as { location?: unknown }).location = saved.location;
});
function drawUnsupported(ua: string): FakeElement[] {
 (globalThis as { document?: unknown }).document = { createElement: (tag: string) => new FakeElement(tag) };
 (globalThis as { location?: unknown }).location = { href: "https://guest.herdrup.app/web/#k=1" };
 const card = ownerCard({ kind: "unsupported" }, thisBrowser(ua), { again() {}, guestInstead() {}, open() {} }, "") as unknown as FakeElement;
 return card.all();
}
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
 expect(one(safari, "span", "web-owner-qr-code").innerHTML).toContain(appStoreQR().path);
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
