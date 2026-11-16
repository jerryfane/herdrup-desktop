import { expect, test } from "bun:test";
import { defaultRecipient, hasOlder, inboxList, mergedFeed, olderPlan, readPlan, safeFloor, totalUnread, type GrantFeed, type GuestGrant } from "../src/guestGramMerge";
import type { GramInfo } from "../src/web/gramInbox";

const grant = (id: string, owner = "Jerry", machine = "Mac Studio", gram = true): GuestGrant => ({ id, agent: id, owner, machine, gram });
const inbound = (id: string, ms: number, read = false): GramInfo => ({ id, direction: "agent_to_owner", from: "a", text: id, createdUnixMs: ms, readByOwner: read });
const mine = (id: string, ms: number): GramInfo => ({ id, direction: "owner_to_agent", from: "me", text: id, createdUnixMs: ms, readByOwner: true });
const feed = (g: GuestGrant, messages: GramInfo[], hasMore = false): GrantFeed => ({ grant: g, messages, hasMore });

const market = grant("market"), legal = grant("legal"), ledger = grant("ledger", "Alex", "lab-box");

test("the feed orders every grant's messages by time, then id, keyed by grant", () => {
 // The same id on two hosts is two messages.
 const feeds = [feed(market, [inbound("m2", 30), inbound("x", 10)]), feed(ledger, [inbound("x", 20), inbound("b", 30)])];
 expect(mergedFeed(feeds).map(m => `${m.grant.id}/${m.message.id}`)).toEqual(["market/x", "ledger/x", "ledger/b", "market/m2"]);
});

test("the safe floor hides what another grant may still be missing", () => {
 // market holds 100-140 with more below; ledger holds 50-200, exhausted. ledger's 50 and 90
 // wait: market may hold messages between 50 and 100 not read yet.
 const feeds = [feed(market, [inbound("m140", 140), inbound("m100", 100)], true), feed(ledger, [inbound("l200", 200), inbound("l90", 90), inbound("l50", 50)])];
 expect(safeFloor(feeds)).toBe(100);
 expect(mergedFeed(feeds).map(m => m.message.id)).toEqual(["m100", "m140", "l200"]);
 // Earlier pages market only (at the floor); once it is exhausted everything shows.
 expect(olderPlan(feeds)).toEqual(["market"]);
 const paged = [feed(market, [inbound("m140", 140), inbound("m100", 100), inbound("m70", 70)], false), feeds[1]!];
 expect(safeFloor(paged)).toBeNull();
 expect(mergedFeed(paged).map(m => m.message.id)).toEqual(["l50", "m70", "l90", "m100", "m140", "l200"]);
 expect(hasOlder(paged)).toBe(false);
});

test("the floor is the newest oldest among grants with more, and Earlier pages those at or above it", () => {
 const feeds = [feed(market, [inbound("m", 100)], true), feed(legal, [inbound("l", 80)], true), feed(ledger, [inbound("x", 120)], true)];
 expect(safeFloor(feeds)).toBe(120);
 expect(mergedFeed(feeds).map(m => m.message.id)).toEqual(["x"]);
 expect(olderPlan(feeds)).toEqual(["ledger"]);
});

test("a selected grant shows all it holds and pages only itself", () => {
 const feeds = [feed(market, [inbound("m140", 140)], true), feed(ledger, [inbound("l90", 90), inbound("l50", 50)], true)];
 expect(mergedFeed(feeds, "ledger").map(m => m.message.id)).toEqual(["l50", "l90"]);
 expect(olderPlan(feeds, "ledger")).toEqual(["ledger"]);
});

test("a grant without Gram is left out of the feed, the counts and the list", () => {
 const off = grant("off", "Jerry", "Mac Studio", false);
 const feeds = [feed(market, [inbound("m", 10)]), feed(off, [inbound("o", 20)], true)];
 expect(mergedFeed(feeds).map(m => m.message.id)).toEqual(["m"]);
 expect(safeFloor(feeds)).toBeNull();
 expect(totalUnread(feeds)).toBe(1);
 expect(inboxList(feeds).groups.flatMap(g => g.rows.map(r => r.grant.id))).toEqual(["market"]);
});

test("unread sums across grants and showing marks each grant's own", () => {
 const feeds = [feed(market, [inbound("m1", 10), inbound("m2", 20, true), mine("p", 30)]), feed(ledger, [inbound("l1", 15)])];
 expect(totalUnread(feeds)).toBe(2);
 expect([...readPlan(mergedFeed(feeds))]).toEqual([["market", ["m1"]], ["ledger", ["l1"]]]);
});

test("the list: All agents, then rows by owner and machine, newest first, labelled when several", () => {
 const intern = grant("intern");
 const feeds = [
  feed(legal, [inbound("l", 1005)]), feed(intern, [inbound("i", 1031)]),
  feed(market, [inbound("m", 1044), inbound("m0", 900)]), feed(ledger, [inbound("q", 1040)]),
 ];
 const list = inboxList(feeds);
 expect(list.labelled).toBe(true);
 expect(list.groups.map(g => [g.label, g.rows.map(r => r.grant.id)])).toEqual([
  ["Jerry · Mac Studio", ["market", "intern", "legal"]],
  ["Alex · lab-box", ["ledger"]],
 ]);
 expect(list.all.latest?.message.id).toBe("m");
 expect(list.all.agents.map(a => a.id)).toEqual(["market", "ledger"]);
 expect(list.all.unread).toBe(5);
 expect(inboxList([feed(market, [])]).labelled).toBe(false);
});

test("the composer's to is the selected agent, else the newest agent message's, else the first row", () => {
 const feeds = [feed(market, [inbound("m", 10), mine("p", 40)]), feed(ledger, [inbound("l", 30)])];
 expect(defaultRecipient(feeds)?.id).toBe("ledger");
 expect(defaultRecipient(feeds, "market")?.id).toBe("market");
 expect(defaultRecipient([feed(market, [mine("p", 5)]), feed(ledger, [])])?.id).toBe("market");
 expect(defaultRecipient([])).toBeNull();
});
