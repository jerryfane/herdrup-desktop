import { expect, test } from "bun:test";
import { ServerUpdateSettings, updateSuggestion } from "../src/settingsUpdates";
import { Desk } from "../src/mygo";
import { NotSentError } from "../src/webguest/errors";

type State = NonNullable<Parameters<typeof updateSuggestion>[0]>;
const state = (fields: Partial<State>): State => ({
  known: true, version: "0.9.5", flow: "idle", code: "", message: "", forbidden: false, restartLater: false, missing: [], ...fields,
});

// The ping in herdrup's Settings reference fixtures: a herdr from before server_update.
test("a herdr that predates server_update asks for the one-time update", () => {
  expect(updateSuggestion(state({ capabilities: {} }), "Mac")).toEqual({
    title: "herdr needs a one-time update",
    subtitle: "This version can't update itself from the app.",
  });
});

// What fakeherdr -current serves: ServerRequirement.current met, nothing newer published.
test("a current herdr with no newer build suggests nothing", () => {
  const capabilities = { server_update: true, agent_groups: true, agent_avatar: true, agent_answer: true };
  const check = { running: { version: "0.9.5", commit_time: 1793108998 }, update_available: false, mode: "live" };
  expect(updateSuggestion(state({ capabilities, check }), "Mac")).toBeNull();
});

// The card with a minimal fake document (no DOM in these tests) and the Desk's update methods
// stubbed, installed for one case and put back after it (withCard).
class FakeElement {
  id = ""; className = ""; textContent = ""; type = ""; disabled = false; hidden = false;
  readonly dataset: Record<string, string> = {};
  onclick: (() => void) | null = null;
  readonly children: FakeElement[] = [];
  #onClose: (() => void)[] = [];
  constructor(readonly tagName: string) {}
  setAttribute() {}
  append(...nodes: FakeElement[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeElement[]) { this.children.splice(0, this.children.length, ...nodes); }
  remove() {}
  showModal() {}
  close() { for (const f of this.#onClose.splice(0)) f(); }
  addEventListener(type: string, f: () => void) { if (type === "close") this.#onClose.push(f); }
  find(id: string): FakeElement | null {
    for (const c of this.children) { if (c.id === id) return c; const deeper = c.find(id); if (deeper) return deeper; }
    return null;
  }
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const capabilities = { server_update: true, agent_groups: true, agent_avatar: true, agent_answer: true };
const check = { running: { version: "0.9.5", build_id: "b5", commit_time: 1_800_000_000 }, latest: { version: "0.9.6", build_id: "b6", commit_time: 1_800_000_100, notes: "" }, update_available: true, mode: "live" };
const offered = JSON.stringify(state({ capabilities, check }));

type Stubs = Pick<typeof Desk, "settingsServerUpdate" | "applySettingsServerUpdate" | "recheckSettingsServerUpdate">;
/** run with the fake document, a window whose timer (the card's 1 s re-read) runs only when the
 *  case calls reread, and the Desk's update methods as stubs says; all put back afterwards. */
async function withCard(stubs: Partial<Stubs>, run: (card: { root: FakeElement; body: FakeElement; reported: unknown[]; reread: () => Promise<void> }) => Promise<void>) {
  const saved = { document: Reflect.get(globalThis, "document"), window: Reflect.get(globalThis, "window"), read: Desk.settingsServerUpdate, apply: Desk.applySettingsServerUpdate, recheck: Desk.recheckSettingsServerUpdate };
  const body = new FakeElement("body");
  let due: (() => void) | null = null;
  try {
    Reflect.set(globalThis, "document", { createElement: (tag: string) => new FakeElement(tag), body });
    Reflect.set(globalThis, "window", { setTimeout: (f: () => void) => { due = f; return 0; } });
    Object.assign(Desk, stubs);
    const reported: unknown[] = [];
    const card = new ServerUpdateSettings(error => reported.push(error));
    card.setScope("tok", "dev");
    await settle();
    await run({ root: card.root as unknown as FakeElement, body, reported, reread: async () => { const f = due; due = null; f?.(); await settle(); } });
  } finally {
    Reflect.set(globalThis, "document", saved.document); Reflect.set(globalThis, "window", saved.window);
    Desk.settingsServerUpdate = saved.read; Desk.applySettingsServerUpdate = saved.apply; Desk.recheckSettingsServerUpdate = saved.recheck;
  }
}
const button = (root: FakeElement, id: string) => { const b = root.find(id)!; return [b.textContent, b.disabled]; };

test("from the confirmation to the apply's result the offer reads Updating…, disabled; an apply that never went out puts it back", async () => {
  const applying = Promise.withResolvers<void>();
  // The Desk's snapshot stays idle all along (web/serverUpdateDesk.ts: an apply out changes nothing in it).
  await withCard({ settingsServerUpdate: async () => offered, applySettingsServerUpdate: () => applying.promise }, async ({ root, body, reported }) => {
    expect(button(root, "server-update-apply")).toEqual(["Update herdr", false]);
    root.find("server-update-apply")!.onclick!();
    body.find("server-update-confirm-apply")!.onclick!();
    await settle();
    expect(button(root, "server-update-apply")).toEqual(["Updating…", true]);
    const unsent = new NotSentError(new Error("Settings changed"));
    applying.reject(unsent);
    await settle();
    expect([button(root, "server-update-apply"), reported]).toEqual([["Update herdr", false], [unsent]]);
  });
});

test("an apply that never went out, whose status read after it fails too, still puts the offer back from the snapshot the card had", async () => {
  let readable = true;
  const unreadable = new Error("Settings changed: open it again");
  await withCard({
    settingsServerUpdate: async () => { if (!readable) throw unreadable; return offered; },
    applySettingsServerUpdate: async () => { readable = false; throw new NotSentError(new Error("Settings changed")); },
  }, async ({ root, body, reported }) => {
    root.find("server-update-apply")!.onclick!();
    body.find("server-update-confirm-apply")!.onclick!();
    await settle();
    expect(button(root, "server-update-apply")).toEqual(["Update herdr", false]);
    expect(reported.at(-1)).toBe(unreadable);
  });
});

test("Try again disables the card's buttons while it runs, and only an apply reads Updating…", async () => {
  const refused = JSON.stringify(state({ capabilities, check, flow: "refused", code: "update_busy", message: "another update runs" }));
  let snapshot = refused;
  const rechecking = Promise.withResolvers<void>();
  await withCard({ settingsServerUpdate: async () => snapshot, recheckSettingsServerUpdate: () => rechecking.promise }, async ({ root, reread }) => {
    expect(button(root, "server-update-retry")).toEqual(["Try again", false]);
    root.find("server-update-retry")!.onclick!();
    await settle();
    expect(button(root, "server-update-retry")).toEqual(["Try again", true]);
    // The recheck has put the card back to the offer while its own answer is still out.
    snapshot = offered;
    await reread();
    expect(button(root, "server-update-apply")).toEqual(["Update herdr", true]);
    rechecking.resolve();
    await settle();
    expect(button(root, "server-update-apply")).toEqual(["Update herdr", false]);
  });
});
