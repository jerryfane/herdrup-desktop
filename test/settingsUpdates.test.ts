import { afterAll, expect, test } from "bun:test";
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

// The card with a minimal fake document (no DOM in these tests) and the Desk's two update methods
// stubbed; the app's own Desk is put back afterwards.
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
const body = new FakeElement("body");
const saved = { document: Reflect.get(globalThis, "document"), window: Reflect.get(globalThis, "window"), read: Desk.settingsServerUpdate, apply: Desk.applySettingsServerUpdate };
Reflect.set(globalThis, "document", { createElement: (tag: string) => new FakeElement(tag), body });
Reflect.set(globalThis, "window", { setTimeout: () => 0 }); // the card's 1 s re-read: never, here
afterAll(() => {
  Reflect.set(globalThis, "document", saved.document); Reflect.set(globalThis, "window", saved.window);
  Desk.settingsServerUpdate = saved.read; Desk.applySettingsServerUpdate = saved.apply;
});
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("from the confirmation to the apply's result the offer reads Updating…, disabled; an apply that never went out puts it back", async () => {
  const capabilities = { server_update: true, agent_groups: true, agent_avatar: true, agent_answer: true };
  const check = { running: { version: "0.9.5", build_id: "b5", commit_time: 1_800_000_000 }, latest: { version: "0.9.6", build_id: "b6", commit_time: 1_800_000_100, notes: "" }, update_available: true, mode: "live" };
  // The Desk's snapshot stays idle all along (web/serverUpdateDesk.ts: an apply out changes nothing in it).
  Desk.settingsServerUpdate = async () => JSON.stringify(state({ capabilities, check }));
  const applying = Promise.withResolvers<void>();
  Desk.applySettingsServerUpdate = () => applying.promise;
  const reported: unknown[] = [];
  const card = new ServerUpdateSettings(error => reported.push(error));
  const root = card.root as unknown as FakeElement;
  card.setScope("tok", "dev");
  await settle();
  const offer = () => { const b = root.find("server-update-apply")!; return [b.textContent, b.disabled]; };
  expect(offer()).toEqual(["Update herdr", false]);
  root.find("server-update-apply")!.onclick!();
  body.find("server-update-confirm-apply")!.onclick!();
  await settle();
  expect(offer()).toEqual(["Updating…", true]);
  const unsent = new NotSentError(new Error("Settings changed"));
  applying.reject(unsent);
  await settle();
  expect([offer(), reported]).toEqual([["Update herdr", false], [unsent]]);
});
