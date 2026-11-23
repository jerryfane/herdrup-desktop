// The web owner's shell: what the desktop shell decides differently in the browser (shellModel.ts,
// the desktop's answers unchanged), which page a load runs (bootChoice.ts), and an owner link's
// folders (groups.ts).
import { expect, test } from "bun:test";
import { ownerWrites, shareShown, shellParts } from "../src/shellModel";
import { choosePage } from "../src/web/bootChoice";
import { GROUPS_REFRESH_MS, OwnerGroups } from "../src/web/groups";
import { localRecord } from "../src/web/storage";
import { ErrUnsupported } from "../src/web/engine";
import { HerdrAPIError } from "../src/webguest/errors";
import type { ConnState } from "../src/mygo";

const owner = (scope?: string): Pick<ConnState, "guest"> => ({
 guest: { access: { guestID: "g1", guestName: "", machineLabel: "dev", ownerName: "", agentName: "", agentTarget: "", endpoint: { relay: "", hostID: "h", hostPublic: "" }, acceptedAt: "" }, features: { gram: true, push: false, multi_request: true }, fingerprint: "", ...(scope ? { ownerScope: scope } : {}) },
});

test("the desktop keeps every desktop-only part; the browser has none", () => {
 expect(shellParts(false)).toEqual({ sessionPills: true, appUpdates: true, starAsk: true, usageCount: true, federation: true });
 expect(shellParts(true)).toEqual({ sessionPills: false, appUpdates: false, starAsk: false, usageCount: false, federation: false });
});

test("a guest connection is a share on the desktop, never in the browser's owner shell", () => {
 expect(shareShown(owner(), false)).toBe(true);
 expect(shareShown({}, false)).toBe(false);
 expect(shareShown(owner("terminal"), true)).toBe(false);
});

test("writes: always on the desktop, only a terminal-scope link in the browser", () => {
 expect(ownerWrites({}, false)).toBe(true);
 expect(ownerWrites(owner("chat"), false)).toBe(true);
 expect(ownerWrites(owner("terminal"), true)).toBe(true);
 expect(ownerWrites(owner("chat"), true)).toBe(false);
 expect(ownerWrites(owner(), true)).toBe(false);
});

const facts = (f: Partial<{ fragment: boolean; guestInstead: boolean; grant: boolean | Error; signedIn: boolean | Error }>) => {
 const asked: string[] = [];
 const read = (name: string, v: boolean | Error | undefined) => async () => { asked.push(name); if (v instanceof Error) throw v; return v ?? false; };
 return { asked, facts: { fragment: f.fragment ?? false, guestInstead: f.guestInstead ?? false, grant: read("grant", f.grant), signedIn: read("signedIn", f.signedIn) } };
};

test("an invite in the address or a kept grant is the guest's page, without asking the account service", async () => {
 const invite = facts({ fragment: true, signedIn: true });
 expect(await choosePage(invite.facts)).toBe("guest");
 expect(invite.asked).toEqual([]);
 const kept = facts({ grant: true, signedIn: true });
 expect(await choosePage(kept.facts)).toBe("guest");
 expect(kept.asked).toEqual(["grant"]);
});

test("a signed-in browser without a grant gets the owner's shell, unless it asked for the guest page", async () => {
 expect(await choosePage(facts({ signedIn: true }).facts)).toBe("owner");
 expect(await choosePage(facts({ signedIn: false }).facts)).toBe("guest");
 expect(await choosePage(facts({ signedIn: true, guestInstead: true }).facts)).toBe("guest");
});

test("a fact that can't be read counts as absent", async () => {
 expect(await choosePage(facts({ grant: new Error("idb"), signedIn: true }).facts)).toBe("owner");
 expect(await choosePage(facts({ signedIn: new Error("offline") }).facts)).toBe("guest");
});

function memory() {
 const data = new Map<string, string>();
 return () => ({ getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); } });
}
const doc = (revision: number, name = "Build") => ({ type: "agent_groups", revision, stars: ["a"], folders: [{ id: "f1", name, order: 0, members: ["a"] }] });

function groupsWith(answers: (() => unknown)[], storage = memory()) {
 let clock = 1_000_000, changes = 0;
 const calls: string[] = [];
 const client = { async call(method: string, _p: unknown, tag: string, capability: string) { calls.push(`${method} ${tag} ${capability}`); const a = answers.shift()!(); if (a instanceof Error) throw a; return a; } };
 const open = localRecord<Record<string, string[]>>("open", storage);
 const g = new OwnerGroups(client as never, "host-1", () => { changes++; }, () => clock, open);
 return { g, calls, open, tick: (ms: number) => { clock += ms; }, changes: () => changes };
}
const signal = new AbortController().signal;

test("folders show once agent.groups.get answers, read again at most once a minute", async () => {
 const s = groupsWith([() => doc(1), () => doc(2, "Renamed")]);
 expect(s.g.view().groups).toBeNull();
 await s.g.refresh(signal);
 expect(s.calls).toEqual(["agent.groups.get agent_groups agent_groups"]);
 expect(s.g.view().groups?.folders?.[0]?.name).toBe("Build");
 expect(s.changes()).toBe(1);
 s.tick(GROUPS_REFRESH_MS - 1);
 await s.g.refresh(signal);
 expect(s.calls.length).toBe(1);
 s.tick(1);
 await s.g.refresh(signal);
 expect(s.g.view().groups?.folders?.[0]?.name).toBe("Renamed");
 expect(s.changes()).toBe(2);
});

test("an older revision, or the same document, changes nothing", async () => {
 const s = groupsWith([() => doc(5), () => doc(4, "Old"), () => doc(5)]);
 await s.g.refresh(signal);
 await s.g.refresh(signal, true);
 expect(s.g.view().groups?.revision).toBe(5);
 await s.g.refresh(signal, true);
 expect(s.changes()).toBe(1);
});

test("a host without folders, or refusing the owner's browser, shows the plain list; a hiccup keeps them", async () => {
 for (const off of [new ErrUnsupported("agent.groups.get", "agent_groups", "0.9"), new HerdrAPIError("owner_forbidden", "no", null)]) {
  const s = groupsWith([() => doc(1), () => off, () => doc(2)]);
  await s.g.refresh(signal);
  await s.g.refresh(signal, true);
  expect(s.g.view().groups).toBeNull();
  await s.g.refresh(signal, true);
  expect(s.calls.length).toBe(2);
 }
 const s = groupsWith([() => doc(1), () => new Error("socket closed")]);
 await s.g.refresh(signal);
 await s.g.refresh(signal, true);
 expect(s.g.view().groups?.revision).toBe(1);
});

test("open folders are this browser's, per machine", () => {
 const storage = memory();
 const s = groupsWith([], storage);
 s.g.setOpen("f1", true);
 s.g.setOpen("f2", true);
 s.g.setOpen("f1", false);
 expect(s.g.view().open).toEqual({ f2: true });
 expect(s.open.get()).toEqual({ "host-1": ["f2"] });
 expect(s.changes()).toBe(3);
 const other = new OwnerGroups({ call: async () => doc(1) }, "host-2", () => {}, Date.now, localRecord("open", storage));
 expect(other.view().open).toEqual({});
});
