// Settings → Shared access (src/settingsGuests.ts), shared by the desktop and the web owner: a
// current herdr's guests by person (o1), a person's page (o2) and its Remove confirmation (o3),
// and an older herdr's guests, which name no person, one row each. A minimal fake document stands
// in for the DOM, and the Desk's guest methods are stubbed; both are installed for one case and
// put back after it (withPage).
import { expect, test } from "bun:test";
import { GuestSettings, sharePeople, type Guest } from "../src/settingsGuests";
import { Desk } from "../src/mygo";

class FakeElement {
  id = ""; className = ""; type = ""; disabled = false; hidden = false; checked = false; value = ""; placeholder = ""; autocomplete = "";
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> & { setProperty?: (k: string, v: string) => void } = {};
  onclick: ((e: { stopPropagation(): void }) => void) | null = null;
  onchange: (() => void) | null = null; oninput: (() => void) | null = null; onkeydown: (() => void) | null = null;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  readonly attributes = new Map<string, string>();
  #text = "";
  #listeners = new Map<string, (() => void)[]>();
  readonly classList = { add: (c: string) => { this.className += ` ${c}`; }, contains: (c: string) => this.className.split(" ").includes(c) };
  constructor(readonly tagName: string) {}
  get textContent(): string { return this.#text + this.children.map(c => c.textContent).join(""); }
  set textContent(text: string) { this.#text = text; this.children = []; }
  get firstChild() { return this.children[0] ?? null; }
  setAttribute(k: string, v: string) { this.attributes.set(k, v); }
  getAttribute(k: string) { return this.attributes.get(k) ?? null; }
  append(...nodes: (FakeElement | string)[]) { for (const n of nodes) { const node = typeof n === "string" ? text(n) : n; node.remove(); node.parent = this; this.children.push(node); } }
  prepend(...nodes: FakeElement[]) { for (const n of nodes.reverse()) { n.remove(); n.parent = this; this.children.unshift(n); } }
  replaceChildren(...nodes: FakeElement[]) { for (const c of this.children) c.parent = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
  focus() {}
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
  showModal() {}
  close() { const fs = this.#listeners.get("close") ?? []; this.#listeners.delete("close"); for (const f of fs) f(); }
  addEventListener(type: string, f: () => void) { this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), f]); }
  removeEventListener() {}
  querySelector(selector: string): FakeElement | null { return this.all().find(e => e.classList.contains(selector.slice(1))) ?? null; }
  /** Every element under this one, depth first. */
  all(): FakeElement[] { return this.children.flatMap(c => [c, ...c.all()]); }
  /** The elements under this one whose own class has cls. */
  having(cls: string): FakeElement[] { return this.all().filter(e => e.classList.contains(cls)); }
  /** The button under this one whose text (or aria-label) is label. */
  button(label: string): FakeElement {
    const found = this.all().find(e => e.tagName === "button" && (e.textContent === label || e.getAttribute("aria-label") === label));
    if (!found) throw new Error(`no button ${label} in: ${this.textContent}`);
    return found;
  }
}
function text(value: string) { const node = new FakeElement("#text"); node.textContent = value; return node; }
const click = (button: FakeElement) => button.onclick!({ stopPropagation() {} });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

type Calls = { method: string; args: unknown[] }[];
/** run with the fake document and window, and the Desk's guest methods answering listing for
 *  machine "" (anything else: no guests), each listing after answers.settingsGuestMachine (default:
 *  at once); every write is recorded, then answered as answers says (default: done). Put back
 *  afterwards. */
type Answer = (...args: unknown[]) => Promise<void>;
async function withPage(listing: { guests: Guest[]; entries?: unknown[] }, run: (page: { card: GuestSettings; root: FakeElement; body: FakeElement; calls: Calls; titles: (string | null)[]; summary: string[]; reported: unknown[] }) => Promise<void>, answers: Record<string, Answer> = {}) {
  const names = ["settingsGuestMachine", "revokeGuestPerson", "removeGuestDevice", "revokeGuestAccess", "setGuestGramSharing"] as const;
  const saved = { document: Reflect.get(globalThis, "document"), localStorage: Reflect.get(globalThis, "localStorage"), innerWidth: Reflect.get(globalThis, "innerWidth"), innerHeight: Reflect.get(globalThis, "innerHeight"),
    addEventListener: Reflect.get(globalThis, "addEventListener"), removeEventListener: Reflect.get(globalThis, "removeEventListener"), desk: Object.fromEntries(names.map(n => [n, Desk[n]])) };
  const body = new FakeElement("body"), calls: Calls = [];
  try {
    Reflect.set(globalThis, "document", { createElement: (tag: string) => new FakeElement(tag), createTextNode: text, body, querySelector: (s: string) => body.querySelector(s), addEventListener() {}, removeEventListener() {} });
    Reflect.set(globalThis, "localStorage", { getItem: () => null, setItem() {} });
    Reflect.set(globalThis, "innerWidth", 1440); Reflect.set(globalThis, "innerHeight", 900);
    Reflect.set(globalThis, "addEventListener", () => {}); Reflect.set(globalThis, "removeEventListener", () => {});
    const record = (method: string) => async (...args: unknown[]) => { calls.push({ method, args }); await answers[method]?.(...args); };
    Object.assign(Desk, {
      settingsGuestMachine: async (token: string, machine: string) => {
        await answers.settingsGuestMachine?.(token, machine);
        return JSON.stringify(machine === "" ? { listing: { guests: listing.guests, invites: [] }, entries: listing.entries ?? [] } : { listing: { guests: [], invites: [] }, entries: [] });
      },
      revokeGuestPerson: record("revokeGuestPerson"), removeGuestDevice: record("removeGuestDevice"), revokeGuestAccess: record("revokeGuestAccess"), setGuestGramSharing: record("setGuestGramSharing"),
    });
    const titles: (string | null)[] = [], summary: string[] = [], reported: unknown[] = [];
    const glyph = (name: string) => { const g = new FakeElement("span"); g.className = "glyph"; g.dataset.symbol = name; return g as unknown as HTMLElement; };
    const card = new GuestSettings(error => { reported.push(error); }, value => summary.push(value), glyph, title => titles.push(title));
    card.setMachines("hetzner", [], []);
    card.setScope("tok");
    await settle();
    await run({ card, root: card.root as unknown as FakeElement, body, calls, titles, summary, reported });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (k !== "desk") Reflect.set(globalThis, k, v);
    Object.assign(Desk, saved.desk);
  }
}

const now = Date.now();
const nike = (id: string, agent: string, created: number): Guest => ({
  guest_id: id, name: "Nike", grant: { terminal_id: "t-" + agent, agent_name: agent }, created_ms: now - created, last_seen_ms: now - 30_000,
  fingerprint: "SHA256:phone", device: "iPhone", revoked: false, share_gram: agent === "enyo", person: "acct-nike", account_bound: true,
  devices: [
    { fingerprint: "SHA256:mac", device: "MacBook", added_ms: now - 500_000, last_seen_ms: now - 7_200_000, removed: false },
    { fingerprint: "SHA256:web", device: "Chrome on macOS", added_ms: now - 400_000, last_seen_ms: now - 86_400_000, removed: false },
  ],
});
const sam: Guest = { guest_id: "sam-1", name: "sam", grant: { terminal_id: "t-enyo", agent_name: "enyo" }, created_ms: now - 900_000, last_seen_ms: now - 7_200_000, fingerprint: "SHA256:sam", device: "iPhone", revoked: false, person: "SHA256:sam", account_bound: false, devices: [] };
const current = { guests: [nike("nike-1", "enyo", 800_000), nike("nike-2", "orgstudio", 700_000), sam], entries: [{ event: "device_added", guest_id: "nike-1", name: "Nike", pane: "t-enyo", ts_ms: now - 60_000, fingerprint: "SHA256:web", text: "Chrome on macOS" }] };
const rowText = (row: FakeElement) => row.having("settings-row-lines")[0]!.children.map(c => c.textContent);

test("a person is one row per machine, whatever their shares and devices; a plain share says only this device (o1)", async () => {
  await withPage(current, async ({ root, summary }) => {
    const rows = root.having("settings-guest-open");
    expect(rows.map(rowText)).toEqual([
      ["Nike", "enyo, orgstudio on hetzner", "HerdrUp account · iPhone, MacBook, Chrome on macOS", "active now"],
      ["sam", "enyo on hetzner", "Only this device · iPhone", "2 h ago"],
    ]);
    expect(summary.at(-1)).toBe("2 people");
    expect(root.having("settings-guest-log").map(r => r.textContent)).toEqual([expect.stringContaining("Nike added a device")]);
    expect(root.having("settings-guest-log")[0]!.textContent).toContain("Chrome on macOS");
  });
});

test("a person's page lists their agents and devices; Remove asks first, then revokes the person on that machine (o2, o3)", async () => {
  await withPage(current, async ({ root, body, calls, titles }) => {
    click(root.having("settings-guest-open")[0]!);
    expect(titles.at(-1)).toBe("Nike");
    const [agents, devices] = root.having("settings-group");
    expect(agents!.having("settings-row-label").map(e => e.textContent).filter(t => t !== "Share Gram")).toEqual(["enyo", "orgstudio"]);
    expect(devices!.having("settings-row-label").map(e => e.textContent)).toEqual(["iPhone", "MacBook", "Chrome on macOS"]);
    expect(devices!.having("settings-guest-more")).toHaveLength(3);
    click(root.button("Remove Nike"));
    const dialog = body.having("settings-guest-confirm")[0]!;
    expect(dialog.textContent).toContain("enyo, orgstudio");
    expect(dialog.textContent).toContain("iPhone, MacBook, Chrome on macOS");
    expect(calls).toEqual([]);
    click(dialog.button("Remove Nike"));
    await settle();
    expect(calls).toEqual([{ method: "revokeGuestPerson", args: ["tok", "", "acct-nike"] }]);
  });
});

test("removing a device takes it off every share of the person that has it; removing an agent revokes that share", async () => {
  await withPage(current, async ({ root, body, calls }) => {
    click(root.having("settings-guest-open")[0]!);
    click(root.button("Manage MacBook"));
    click(body.having("account-device-menu")[0]!.button("Remove"));
    click(body.having("settings-guest-confirm")[0]!.button("Remove device"));
    await settle();
    expect(calls).toEqual([{ method: "removeGuestDevice", args: ["tok", "", "nike-1", "SHA256:mac"] }, { method: "removeGuestDevice", args: ["tok", "", "nike-2", "SHA256:mac"] }]);
    calls.length = 0;
    click(root.button("Remove orgstudio from Nike"));
    click(body.having("settings-guest-confirm")[0]!.button("Remove"));
    await settle();
    expect(calls).toEqual([{ method: "revokeGuestAccess", args: ["tok", "", "nike-2", false] }]);
    // Back to the list.
    click(root.button("Back to Shared access"));
  });
});

// #524 review P2: one share that can't be updated (revoked meanwhile elsewhere, or any refusal)
// doesn't keep the device on the others.
test("removing a device tries every share of the person, and says which ones couldn't be updated", async () => {
  await withPage(current, async ({ root, body, calls, reported }) => {
    click(root.having("settings-guest-open")[0]!);
    click(root.button("Manage MacBook"));
    click(body.having("account-device-menu")[0]!.button("Remove"));
    click(body.having("settings-guest-confirm")[0]!.button("Remove device"));
    await settle();
    expect(calls.map(c => c.args[2])).toEqual(["nike-1", "nike-2"]);
    expect(reported.map(e => (e as Error).message)).toEqual(["Couldn't remove from enyo: herdr: guest_busy: try again"]);
  }, { removeGuestDevice: async (...args) => { if (args[2] === "nike-1") throw new Error("herdr: guest_busy: try again"); } });
});

// #524 review P3: a removal batch sends on the Settings scope it began in, and no more once it ends.
test("a device removal begun in one Settings scope sends nothing once that scope has ended", async () => {
  const held = Promise.withResolvers<void>();
  await withPage(current, async ({ card, root, body, calls }) => {
    click(root.having("settings-guest-open")[0]!);
    click(root.button("Manage MacBook"));
    click(body.having("account-device-menu")[0]!.button("Remove"));
    click(body.having("settings-guest-confirm")[0]!.button("Remove device"));
    await settle();
    card.setScope("tok2"); // Settings closed and opened again while the first removal is out
    held.resolve();
    await settle();
    expect(calls.filter(c => c.method === "removeGuestDevice")).toEqual([{ method: "removeGuestDevice", args: ["tok", "", "nike-1", "SHA256:mac"] }]);
  }, { removeGuestDevice: () => held.promise });
});

/** A listing hold: from arm() on, the next listing of machine "" waits for release (started says it
 *  has begun). */
function listingHold() {
  let armed = false, gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  return {
    arm: () => { armed = true; gate = Promise.withResolvers<void>(); },
    release: () => gate.resolve(),
    started: started.promise,
    answer: async (_token: unknown, machine: unknown) => { if (!armed || machine !== "") return; armed = false; started.resolve(); await gate.promise; },
  };
}
/** Turns Nike's first Share Gram switch, which writes and then lists the shares again. */
function switchGram(root: FakeElement) {
  const share = root.all().find(e => e.tagName === "input" && e.getAttribute("aria-label") === "Share Gram with Nike")!;
  share.checked = !share.checked; share.onchange!();
}

// #524/#529 post-merge P3: a menu opened while a refresh's listing is out goes with the rows it was
// opened on when that listing lands; the page then offers the device on the shares it shows now.
test("a device menu opened while the listing is out closes when it lands, and a new one removes the device from the shares shown now", async () => {
  const listing = { guests: [...current.guests] }, hold = listingHold();
  await withPage(listing, async ({ root, body, calls }) => {
    click(root.having("settings-guest-open")[0]!);
    hold.arm(); switchGram(root);
    await hold.started; await settle();
    click(root.button("Manage MacBook"));
    expect(body.having("account-device-menu")).toHaveLength(1);
    // The listing finds a third share of Nike's with the MacBook.
    listing.guests.push(nike("nike-3", "landing", 600_000));
    hold.release();
    await settle();
    expect(body.having("account-device-menu")).toEqual([]);
    click(root.button("Manage MacBook"));
    click(body.having("account-device-menu")[0]!.button("Remove"));
    click(body.having("settings-guest-confirm")[0]!.button("Remove device"));
    await settle();
    expect(calls.filter(c => c.method === "removeGuestDevice").map(c => c.args[2])).toEqual(["nike-1", "nike-2", "nike-3"]);
  }, { settingsGuestMachine: (token, machine) => hold.answer(token, machine) });
});

// #529 post-merge P3: a removal asked for before a listing lands is confirmed after it: it goes to
// the shares listed when confirmed.
test("a device removal confirmed after a listing showed another share of the person removes it there too", async () => {
  const listing = { guests: [...current.guests] }, hold = listingHold();
  await withPage(listing, async ({ root, body, calls }) => {
    click(root.having("settings-guest-open")[0]!);
    click(root.button("Manage MacBook"));
    click(body.having("account-device-menu")[0]!.button("Remove"));
    hold.arm(); switchGram(root);
    await hold.started;
    listing.guests.push(nike("nike-3", "landing", 600_000));
    hold.release();
    await settle();
    click(body.having("settings-guest-confirm")[0]!.button("Remove device"));
    await settle();
    expect(calls.filter(c => c.method === "removeGuestDevice").map(c => c.args[2])).toEqual(["nike-1", "nike-2", "nike-3"]);
  }, { settingsGuestMachine: (token, machine) => hold.answer(token, machine) });
});

test("a device menu already open when a refresh starts closes then, before the listing lands", async () => {
  const hold = listingHold();
  await withPage({ guests: [...current.guests] }, async ({ root, body }) => {
    click(root.having("settings-guest-open")[0]!);
    click(root.button("Manage MacBook"));
    hold.arm(); switchGram(root);
    await hold.started;
    expect(body.having("account-device-menu")).toEqual([]);
    hold.release(); await settle();
  }, { settingsGuestMachine: (token, machine) => hold.answer(token, machine) });
});

test("a device on one of the person's shares only is removed from that share only", async () => {
  const guests = current.guests.map(g => g.guest_id === "nike-2" ? { ...g, devices: g.devices!.filter(d => d.fingerprint !== "SHA256:mac") } : g);
  await withPage({ guests }, async ({ root, body, calls }) => {
    click(root.having("settings-guest-open")[0]!);
    click(root.button("Manage MacBook"));
    click(body.having("account-device-menu")[0]!.button("Remove"));
    click(body.having("settings-guest-confirm")[0]!.button("Remove device"));
    await settle();
    expect(calls.map(c => [c.method, c.args[2]])).toEqual([["removeGuestDevice", "nike-1"]]);
  });
});

test("this page's device menu closes alone: another view's menu stays", async () => {
  await withPage(current, async ({ root, body }) => {
    const accountMenu = new FakeElement("div"); accountMenu.className = "account-device-menu"; body.append(accountMenu);
    click(root.having("settings-guest-open")[0]!);
    click(root.button("Manage MacBook"));
    expect(body.having("account-device-menu")).toHaveLength(2);
    click(root.button("Back to Shared access"));
    expect(body.having("account-device-menu")).toEqual([accountMenu]);
  });
});

test("a removed device's audit row names it by fingerprint; share activity isn't put on one device", async () => {
  const removedMac = current.guests.map(g => g.guest_id === "nike-1" ? { ...g, devices: g.devices!.map(d => d.fingerprint === "SHA256:mac" ? { ...d, removed: true } : d) } : g);
  const entries = [{ event: "device_removed", guest_id: "nike-1", name: "Nike", pane: "t-enyo", ts_ms: now - 60_000, fingerprint: "SHA256:mac" }];
  await withPage({ guests: removedMac, entries }, async ({ root }) => {
    expect(root.having("settings-guest-log-body").map(e => e.textContent)).toEqual(["MacBook"]);
    click(root.having("settings-guest-open")[0]!);
    expect(root.having("settings-guest-page-identity")[0]!.having("settings-guest-presence")[0]!.textContent).toBe("Active now");
    expect(rowText(root.having("settings-guest-device")[0]!)).toEqual(["iPhone", `added ${new Date(now - 800_000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`]);
  });
});

test("a plain share's page has its one device and no device menu", async () => {
  await withPage(current, async ({ root }) => {
    click(root.having("settings-guest-open")[1]!);
    expect(root.having("settings-guest-device").map(rowText)).toEqual([["iPhone", "added " + new Date(sam.created_ms!).toLocaleDateString("en-GB", { day: "numeric", month: "short" })]]);
    expect(root.having("settings-guest-more")).toEqual([]);
  });
});

test("an older herdr's guests, which name no person, keep a row each with Revoke", async () => {
  const older = current.guests.map(({ person: _p, account_bound: _a, devices: _d, ...guest }) => guest);
  await withPage({ guests: older }, async ({ root, body, calls }) => {
    expect(root.having("settings-guest-open")).toEqual([]);
    expect(root.having("settings-guest-person").map(r => r.having("settings-row-label")[0]!.textContent)).toEqual(["Nike", "Nike", "sam"]);
    click(root.button("Revoke sam"));
    click(body.having("settings-guest-confirm")[0]!.button("Revoke"));
    await settle();
    expect(calls).toEqual([{ method: "revokeGuestAccess", args: ["tok", "", "sam-1", false] }]);
  });
});

test("a person's devices are the ones their shares admit now: removed ones go, the accepting one included", () => {
  const removedPhone: Guest = { ...nike("nike-1", "enyo", 800_000), devices: [...nike("x", "y", 0).devices!, { fingerprint: "SHA256:phone", device: "iPhone", added_ms: 0, removed: true }] };
  const { people, ungrouped } = sharePeople([removedPhone, { ...nike("nike-2", "orgstudio", 700_000), devices: [] }, { ...sam, revoked: true }]);
  expect(ungrouped).toEqual([]);
  expect(people.map(p => [p.id, p.name, p.accountBound, p.devices.map(d => [d.name, d.guests])])).toEqual([
    ["acct-nike", "Nike", true, [["iPhone", ["nike-2"]], ["MacBook", ["nike-1"]], ["Chrome on macOS", ["nike-1"]]]],
  ]);
});
