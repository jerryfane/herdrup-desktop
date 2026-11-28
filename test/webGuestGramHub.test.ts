// Multi-grant browser Guest Gram hub (src/web/gram.ts): when a browser guest holds multiple
// shared agents (e.g. fleetup + jarvis), Guest Gram discovers and polls all of them so the Gram
// sidebar lists every Gram-sharing agent and routes posts/read-marks/refreshes to the right grant.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { grantKey } from "../src/grantKey";
import { guestGramView } from "../src/guestGramView";
import { gramDesk, guestGramDesk, setGuestGramSource, type GuestGrantSource } from "../src/web/gram";
import { setLink, type GuestAccess, type WebLink } from "../src/web/link";
import type { Access as TransportAccess } from "../src/webguest/transport";

const store = new Map<string, string>();
beforeAll(() => {
 Reflect.set(globalThis, "localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => void store.delete(k),
 });
});
afterAll(() => { Reflect.deleteProperty(globalThis, "localStorage"); });

afterEach(async () => {
 setGuestGramSource(null);
 await guestGramDesk.guestGramSetVisible!(false);
 setLink(null);
 store.clear();
});

function makeAccess(guestID: string, agentName: string, hostID = "H1"): TransportAccess {
 return {
  guestID, guestName: "test", machineLabel: "hetzner", ownerName: "jerry", agentName,
  agentTarget: "term-" + guestID,
  endpoint: { relay: "wss://relay.invalid", hostID, hostPublicKey: new Uint8Array(32) },
  acceptedAt: new Date(1000),
 };
}

function pageAccessOf(a: TransportAccess): GuestAccess {
 return {
  guestID: a.guestID, guestName: a.guestName, machineLabel: a.machineLabel, ownerName: a.ownerName,
  agentName: a.agentName, agentTarget: a.agentTarget,
  endpoint: { relay: a.endpoint.relay, hostID: a.endpoint.hostID, hostPublicKey: "" },
  acceptedAt: a.acceptedAt.toISOString(),
 } as unknown as GuestAccess;
}

function makeMockLink(
 access: TransportAccess,
 shareGram: boolean,
 handle: (method: string, params: Record<string, unknown>) => unknown,
): WebLink {
 return {
  access: pageAccessOf(access),
  features: () => ({ gram: shareGram, push: false }),
  call: async <T>(method: string, params?: unknown) => handle(method, (params ?? {}) as Record<string, unknown>) as T,
  stream: () => { throw new Error("no streams"); },
 };
}

async function settle() {
 for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 5));
}

test("multi-grant Guest Gram hub lists all Gram-sharing held grants and routes post/markRead/remove per grant", async () => {
 const fleetup = makeAccess("g-fleetup", "fleetup");
 const jarvis = makeAccess("g-jarvis", "jarvis");
 const fleetupID = grantKey(fleetup);
 const jarvisID = grantKey(jarvis);

 let held: TransportAccess[] = [fleetup, jarvis];
 const watchers = new Set<() => void>();
 const closed: string[] = [];
 const fleetupCalls: [string, Record<string, unknown>][] = [];
 const jarvisCalls: [string, Record<string, unknown>][] = [];

 let jarvisMessages = [
  { id: "jm1", direction: "agent_to_owner", from: "jarvis", text: "hello from jarvis", created_unix_ms: 2000, read_by_owner: false },
 ];
 const fleetupMessages = [
  { id: "fm1", direction: "agent_to_owner", from: "fleetup", text: "hello from fleetup", created_unix_ms: 1000, read_by_owner: false },
 ];

 const fleetupLink = makeMockLink(fleetup, true, (method, params) => {
  fleetupCalls.push([method, params]);
  if (method === "gram.list") return { messages: fleetupMessages, has_more: false };
  if (method === "gram.mark_read") return { type: "ok" };
  throw new Error("unexpected fleetup " + method);
 });

 const source: GuestGrantSource = {
  listGrants: async () => [...held],
  openGrant: async (grant) => {
   const id = grantKey(grant);
   const link = makeMockLink(grant, true, (method, params) => {
    jarvisCalls.push([method, params]);
    if (method === "agent.list") return { type: "agent_list", agents: [{ terminal_id: grant.agentTarget, name: grant.agentName }] };
    if (method === "gram.list") return { messages: jarvisMessages, has_more: false };
    if (method === "gram.mark_read") {
     const ids = params.ids as string[];
     jarvisMessages = jarvisMessages.map(m => ids.includes(m.id) ? { ...m, read_by_owner: true } : m);
     return { type: "ok" };
    }
    if (method === "gram.post") {
     const posted = { id: "jp1", direction: "owner_to_agent", from: "guest", to: String(params.to ?? ""), text: String(params.text ?? ""), created_unix_ms: 3000, read_by_owner: true };
     jarvisMessages = [posted, ...jarvisMessages];
     return { type: "gram_sent", message: posted };
    }
    throw new Error("unexpected jarvis " + method);
   });
   return { link, close: () => { closed.push(id); } };
  },
  onChange: (f) => { watchers.add(f); return () => { watchers.delete(f); }; },
 };

 setGuestGramSource(source);
 setLink(fleetupLink, null);
 await guestGramDesk.guestGramSetVisible!(true);
 await settle();

 const raw = await guestGramDesk.guestGramState!();
 expect(raw.active).toBe(true);
 expect(raw.grants.map(item => [item.grant.id, item.grant.agent, item.grant.gram, item.grant.ready])).toEqual([
  [fleetupID, "fleetup", true, true],
  [jarvisID, "jarvis", true, true],
 ]);

 // guestGramView merges both grants into the sidebar groups and combined feed.
 const view = guestGramView(raw, null);
 expect(view.offered).toBe(true);
 expect(view.groups.flatMap(group => group.rows.map(r => r.grant.agent))).toEqual(["jarvis", "fleetup"]);
 expect(view.snapshot.messages.map(m => m.text)).toEqual(["hello from jarvis", "hello from fleetup"]);

 // Selecting jarvis as recipient routes gramPost to jarvis's link, not fleetup's.
 await guestGramDesk.guestGramSetRecipient!(jarvisID);
 await gramDesk.gramPost!("ping jarvis", [], []);
 expect(jarvisCalls.some(([m, p]) => m === "gram.post" && p.to === "jarvis" && p.text === "ping jarvis")).toBe(true);
 expect(fleetupCalls.some(([m]) => m === "gram.post")).toBe(false);

 // Marking a jarvis message read routes to jarvis's link via the "<grant>\x1f<id>" prefix.
 await gramDesk.gramMarkRead!(jarvisID + "\u001f" + "jm1");
 expect(jarvisCalls.some(([m, p]) => m === "gram.mark_read" && Array.isArray(p.ids) && p.ids[0] === "jm1")).toBe(true);
 expect(fleetupCalls.some(([m]) => m === "gram.mark_read")).toBe(false);

 // Removing jarvis from held grants closes its background link and removes it from guestGramState.
 held = [fleetup];
 for (const f of watchers) f();
 await settle();
 expect(closed).toEqual([jarvisID]);
 expect((await guestGramDesk.guestGramState!()).grants.map(item => item.grant.id)).toEqual([fleetupID]);
});
