import { expect, test } from "bun:test";
import { GRANT_SEP, guestGramView } from "../src/guestGramView";
import type { GramMessage, GramSnapshot, GuestGramSnapshot, GuestGramState } from "../src/mygo";

const msg = (grant: string, id: string, ms: number, o: Partial<GramMessage> = {}): GramMessage => ({
 id: grant + GRANT_SEP + id, fromAgent: true, from: "a", name: "a", senderName: "a", machine: "host", text: id, createdUnixMs: ms, unread: false, saved: false, pending: false, ...o,
});
const snap = (messages: GramMessage[], o: Partial<GramSnapshot> = {}): GramSnapshot => ({
 phase: "loaded", messages, unreadCount: 0, hasMore: false, loadingOlder: false, refreshing: false, markingAllRead: false, agents: [], saved: [],
 localMachine: "", attachments: [], sending: false, sendProgress: 0, sendProgressShown: false, draftPosted: 0, visible: true, ...o,
});
const grant = (id: string, owner: string, messages: GramMessage[], o: { gram?: boolean; hasMore?: boolean; status?: string } = {}): GuestGramState => ({
 grant: { id, agent: id, owner, machine: owner === "Jerry" ? "Mac Studio" : "lab-box", gram: o.gram ?? true, ready: true },
 gram: snap(messages, { hasMore: o.hasMore ?? false, ...(o.status ? { status: o.status } : {}) }),
});

const s: GuestGramSnapshot = {
 active: true, recipient: "",
 grants: [
  grant("market", "Jerry", [msg("market", "m2", 300, { unread: true }), msg("market", "m1", 100)]),
  grant("ledger", "Alex", [msg("ledger", "l1", 200, { unread: true }), msg("ledger", "mine", 250, { fromAgent: false })], { status: "Couldn't send" }),
  grant("quiet", "Alex", [msg("quiet", "q", 400)], { gram: false }),
 ],
};

test("All agents draws the merged feed newest first, with the owner on agent sender lines", () => {
 const v = guestGramView(s, null);
 expect(v.snapshot.messages.map(m => m.id)).toEqual(["market\u001fm2", "ledger\u001fmine", "ledger\u001fl1", "market\u001fm1"]);
 expect(v.snapshot.messages.filter(m => m.fromAgent).map(m => m.machine)).toEqual(["Jerry", "Alex", "Jerry"]);
 expect(v.snapshot.messages.find(m => !m.fromAgent)?.machine).toBe("host");
 expect(v.snapshot.unreadCount).toBe(2);
 expect(v.badge).toBe(2);
 expect(v.offered).toBe(true);
 expect([...v.grants.keys()]).toEqual(["market", "ledger"]);
 expect(v.all.agents).toEqual(["market", "ledger"]);
 expect(v.all.newest?.id).toBe("market\u001fm2");
 // The newest agent message is market's: the composer writes to it, and shows its banner state.
 expect(v.recipient?.id).toBe("market");
});

test("one agent selected shows its messages only, and the composer writes to it", () => {
 const v = guestGramView(s, "ledger");
 expect(v.snapshot.messages.map(m => m.id)).toEqual(["ledger\u001fmine", "ledger\u001fl1"]);
 expect(v.snapshot.unreadCount).toBe(1);
 expect(v.recipient?.id).toBe("ledger");
 expect(v.snapshot.status).toBe("Couldn't send");
 expect(v.badge).toBe(2);
});

test("a chosen recipient wins over the default, and the safe floor holds the feed back", () => {
 const paged: GuestGramSnapshot = { ...s, recipient: "ledger", grants: [grant("market", "Jerry", [msg("market", "m2", 300)], { hasMore: true }), s.grants[1]!] };
 const v = guestGramView(paged, null);
 expect(v.recipient?.id).toBe("ledger");
 // market may still hold messages older than 300: ledger's 200 and 250 wait.
 expect(v.snapshot.messages.map(m => m.id)).toEqual(["market\u001fm2"]);
 expect(v.snapshot.hasMore).toBe(true);
 expect(v.merge.grantsToPage).toEqual(["market"]);
});

test("no shared agent with Gram offers no Gram tab", () => {
 const v = guestGramView({ active: true, recipient: "", grants: [s.grants[2]!] }, null);
 expect(v.offered).toBe(false);
 expect(v.recipient).toBeNull();
 expect(v.snapshot.phase).toBe("idle");
});
