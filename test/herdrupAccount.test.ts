// The account page (src/herdrupAccount.ts) with a bridge of its own, as the browser's Desk is: no
// account deletion, and every other method rejecting (src/web/mygo.ts). A minimal fake document
// stands in for the DOM; the app's own bridge is never replaced.
import { afterAll, expect, test } from "bun:test";
import { HerdrUpAccountPanel, type AccountBridge } from "../src/herdrupAccount";
import type { AccountState } from "../src/mygo";

class FakeElement {
 className = ""; textContent = ""; innerHTML = ""; type = ""; disabled = false; hidden = false;
 onclick: (() => void) | null = null;
 readonly children: FakeElement[] = [];
 readonly classList = {
  add: (c: string) => { this.className += ` ${c}`; },
  toggle: (c: string, on: boolean) => { const set = new Set(this.className.split(" ").filter(Boolean)); if (on) set.add(c); else set.delete(c); this.className = [...set].join(" "); },
 };
 constructor(readonly tagName: string) {}
 setAttribute() {}
 append(...nodes: FakeElement[]) { this.children.push(...nodes); }
 replaceChildren(...nodes: FakeElement[]) { this.children.splice(0, this.children.length, ...nodes); }
 remove() {}
 querySelector(selector: string): FakeElement | null {
  const cls = selector.slice(1);
  for (const c of this.children) { if (c.className.split(" ").includes(cls)) return c; const deeper = c.querySelector(selector); if (deeper) return deeper; }
  return null;
 }
 text(): string { return this.textContent + this.children.map(c => c.text()).join(""); }
}
const savedDocument: unknown = Reflect.get(globalThis, "document");
Reflect.set(globalThis, "document", { createElement: (tag: string) => new FakeElement(tag) });
afterAll(() => { Reflect.set(globalThis, "document", savedDocument); });

/** The browser's account methods over a session that a check signs in, with the calls counted;
 *  any other method rejects as the browser's Desk does. The check publishes accountChanged as it
 *  resolves, as accountDesk.ts's onSessionChange does. */
function browserBridge() {
 const calls: string[] = [], responses: Promise<unknown>[] = [];
 const listeners = new Map<string, Set<(payload: unknown) => void>>();
 const event = (name: string) => ({ on: (listener: (payload: unknown) => void) => { (listeners.get(name) ?? listeners.set(name, new Set()).get(name)!).add(listener); return () => listeners.get(name)!.delete(listener); } });
 const signedIn: AccountState = { signedIn: true, persistent: true };
 const methods: Record<string, () => Promise<unknown>> = {
  accountProviders: async () => ["apple"],
  accountState: async () => signedIn,
  accountCheck: async () => { for (const l of listeners.get("accountChanged") ?? []) l(signedIn); return signedIn; },
  accountSyncStatus: async () => ({ lastSyncedMs: 0, machines: 0, prompts: 0 }),
  accountSyncNow: async () => {},
  accountDevices: async () => ({ devices: [] }),
  accountEnrolAgain: async () => ({ devices: [] }),
  accountRenameDevice: async () => {},
  accountRemoveDevice: async () => {},
 };
 const desk = new Proxy(methods, {
  has: (target, key) => key in target,
  get: (target, key) => {
   calls.push(String(key));
   const method = typeof key === "string" && key in target ? target[key]! : () => Promise.reject(new Error("Not available in the browser"));
   // Each answer is kept, so a test can wait for every one the panel asked for (settled).
   return () => { const answer = method(); responses.push(answer); return answer; };
  },
 });
 const events = new Proxy({}, { get: (_, name) => event(String(name)) });
 // A test double for the generated Desk and events: only the methods the panel calls exist.
 const bridge = { desk, events } as unknown as AccountBridge;
 /** Publishes name, as the page's events do. */
 const emit = (name: string, payload?: unknown) => { for (const l of listeners.get(name) ?? []) l(payload); };
 return { bridge, calls, methods, emit, settled: () => settled(responses) };
}

/** Waits for every bridge answer the panel asked for, and for what it does with each: until a
 *  task turn (after which no promise the panel chained on them is left pending) asks for no more. */
async function settled(responses: Promise<unknown>[]) {
 for (let seen = -1; seen !== responses.length;) {
  seen = responses.length;
  await Promise.allSettled(responses);
  await new Promise(done => setTimeout(done, 0));
 }
}

/** The Sync now row's subtitle: the node after its label, null when the row has none. */
function syncLine(node: FakeElement): FakeElement | null {
 if (node.className.includes("settings-row-lines") && node.children[0]?.textContent === "Sync now") return node.children[1] ?? null;
 for (const c of node.children) { const found = syncLine(c); if (found) return found; }
 return null;
}

test("without account deletion in the Desk, the details load doesn't ask for it; Delete account points to the app", async () => {
 const { bridge, calls, settled } = browserBridge();
 const panel = new HerdrUpAccountPanel(() => {}, () => new FakeElement("span") as unknown as HTMLElement, bridge);
 await panel.refresh(true);
 await settled();
 const root = panel.root as unknown as FakeElement;
 expect([calls.includes("accountDeleteInfo"), root.text().includes("To delete your account, use the HerdrUp app on iPhone or iPad.")]).toEqual([false, true]);
});

test("an initial check that signs in loads the devices once, and reads SYNCED once", async () => {
 const { bridge, calls, settled } = browserBridge();
 const panel = new HerdrUpAccountPanel(() => {}, () => new FakeElement("span") as unknown as HTMLElement, bridge);
 await panel.refresh(true);
 await settled();
 expect([calls.filter(c => c === "accountDevices").length, calls.filter(c => c === "accountSyncStatus").length]).toEqual([1, 1]);
});

test("SYNCED's line under Sync now is one node, kept: a sync status that comes later fills it in place", async () => {
 const { bridge, methods, emit, settled } = browserBridge();
 const panel = new HerdrUpAccountPanel(() => {}, () => new FakeElement("span") as unknown as HTMLElement, bridge);
 await panel.refresh(true);
 await settled();
 const root = panel.root as unknown as FakeElement;
 const line = syncLine(root)!;
 expect([line.hidden, line.textContent]).toEqual([true, ""]);
 // A round finishes: the same node shows when it did.
 methods.accountSyncStatus = async () => ({ lastSyncedMs: Date.UTC(2026, 10, 24, 12), machines: 1, prompts: 2 });
 emit("syncedMachinesChanged");
 await settled();
 expect([syncLine(root) === line, line.hidden, line.textContent.startsWith("Last synced")]).toEqual([true, false, true]);
});

test("an older SYNCED answer that comes after a newer one changes nothing: counts and the failure line go together", async () => {
 const { bridge, methods, emit, settled } = browserBridge();
 const panel = new HerdrUpAccountPanel(() => {}, () => new FakeElement("span") as unknown as HTMLElement, bridge);
 await panel.refresh(true);
 await settled();
 const root = panel.root as unknown as FakeElement;
 // The first read (a failed round) is answered last; the second (one that finished well) first.
 const late = Promise.withResolvers<AccountState>();
 methods.accountState = () => late.promise;
 methods.accountSyncStatus = async () => ({ lastSyncedMs: 0, machines: 0, prompts: 0 });
 emit("syncedMachinesChanged");
 methods.accountState = async () => ({ signedIn: true, persistent: true });
 methods.accountSyncStatus = async () => ({ lastSyncedMs: Date.UTC(2026, 10, 24, 12), machines: 1, prompts: 2 });
 emit("syncedMachinesChanged");
 late.resolve({ signedIn: true, persistent: true, syncFailed: true });
 await settled();
 expect(syncLine(root)!.textContent.startsWith("Last synced")).toBe(true);
});

test("a session that ends and another that begins reloads the devices, and the old account's answer is dropped", async () => {
 const { bridge, calls, methods, emit, settled } = browserBridge();
 const panel = new HerdrUpAccountPanel(() => {}, () => new FakeElement("span") as unknown as HTMLElement, bridge);
 await panel.refresh(true);
 await settled();
 const root = panel.root as unknown as FakeElement;
 // A's devices are still on their way when the session becomes B's.
 const late = Promise.withResolvers<unknown>();
 methods.accountDevices = () => late.promise;
 emit("accountChanged", { signedIn: false, persistent: true });
 methods.accountDevices = async () => ({ devices: [{ id: "b".repeat(22), name: "Browser B", platform: "web", createdMs: 1, current: true }] });
 emit("accountChanged", { signedIn: true, persistent: true, displayHint: "b@example.com" });
 late.resolve({ devices: [{ id: "a".repeat(22), name: "Browser A", platform: "web", createdMs: 1, current: true }] });
 await settled();
 expect([calls.filter(c => c === "accountDevices").length >= 2, root.text().includes("Browser B"), root.text().includes("Browser A")]).toEqual([true, true, false]);
});

test("Try again's late answer for the account before is dropped once another session began", async () => {
 const { bridge, methods, emit, settled } = browserBridge();
 methods.accountDevices = async () => ({ devices: [], enrolment: "too_many_devices" });
 const panel = new HerdrUpAccountPanel(() => {}, () => new FakeElement("span") as unknown as HTMLElement, bridge);
 await panel.refresh(true);
 await settled();
 const root = panel.root as unknown as FakeElement;
 /** The button whose text includes text. */
 const button = (node: FakeElement, text: string): FakeElement | null => {
  if (node.tagName === "button" && node.text().includes(text)) return node;
  for (const c of node.children) { const found = button(c, text); if (found) return found; }
  return null;
 };
 // Try again for account A: its answer is held. The session becomes B's meanwhile.
 const late = Promise.withResolvers<unknown>();
 methods.accountEnrolAgain = () => late.promise;
 button(root, "Try again")!.onclick!();
 emit("accountChanged", { signedIn: false, persistent: true });
 const bDevices = Promise.withResolvers<unknown>();
 methods.accountDevices = () => bDevices.promise;
 emit("accountChanged", { signedIn: true, persistent: true, displayHint: "b@example.com" });
 // B's devices are in and shown; only then does A's held answer come.
 bDevices.resolve({ devices: [{ id: "b".repeat(22), name: "Browser B", platform: "web", createdMs: 1, current: true }] });
 await bDevices.promise;
 await new Promise(done => setTimeout(done, 0));
 late.resolve({ devices: [{ id: "a".repeat(22), name: "Browser A", platform: "web", createdMs: 1, current: true }] });
 await settled();
 expect([root.text().includes("Browser B"), root.text().includes("Browser A")]).toEqual([true, false]);
});

test("setReturnProblem stays visible across signed-out refreshes and clears once signed in", async () => {
 const { bridge, methods, emit } = browserBridge();
 methods.accountState = async () => ({ signedIn: false, persistent: true });
 methods.accountCheck = async () => ({ signedIn: false, persistent: true });
 const panel = new HerdrUpAccountPanel(() => {}, () => new FakeElement("span") as unknown as HTMLElement, bridge);
 panel.setReturnProblem("The sign-in took too long. Sign in again.");
 await panel.refresh(true);
 const root = panel.root as unknown as FakeElement;
 expect(root.text()).toContain("The sign-in took too long. Sign in again.");
 expect(panel.problem).toBe("The sign-in took too long. Sign in again.");
 emit("accountChanged", { signedIn: true, persistent: true });
 expect(panel.problem).toBe("");
 expect(root.text()).not.toContain("The sign-in took too long. Sign in again.");
});
