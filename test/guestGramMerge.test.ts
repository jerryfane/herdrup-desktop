// herdrup#697: one guest Gram across grants, merged on the client. A port of HerdrKit's
// GuestGramMergeTests.swift (herdrup#702), case for case, so the three apps agree.
import { expect, test } from "bun:test";
import { compareKeys, guestGramGroups, laneCursor, mergeGuestGram, replyTarget, type GuestGramLane, type GuestGramMessage } from "../src/guestGramMerge";

const gram = (id: string, ms: number, { incoming = true, read = false } = {}): GuestGramMessage =>
 ({ id, createdUnixMs: ms, fromAgent: incoming, unread: incoming && !read });

/** One grant's host: its Grams newest first, paged by before_id like gram.list. */
class Host {
 constructor(readonly grant: string, public store: GuestGramMessage[], readonly pageSize: number) {}
 page(cursor: string | null): { messages: GuestGramMessage[]; hasMore: boolean } {
  const sorted = [...this.store].sort((a, b) => b.createdUnixMs - a.createdUnixMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const at = cursor === null ? -1 : sorted.findIndex(m => m.id === cursor);
  const start = at < 0 ? 0 : at + 1;
  const slice = sorted.slice(start, start + this.pageSize);
  return { messages: slice, hasMore: start + slice.length < sorted.length };
 }
}

/** The client: a lane per grant, its newest page first, then Earlier as the merge asks. */
class Client {
 lanes: GuestGramLane[];
 constructor(readonly hosts: Host[]) {
  this.lanes = hosts.map(host => { const page = host.page(null); return { grant: host.grant, messages: page.messages, hasMore: page.hasMore }; });
 }
 get merge() { return mergeGuestGram(this.lanes); }
 earlier() {
  for (const grant of this.merge.grantsToPage) {
   const i = this.lanes.findIndex(lane => lane.grant === grant);
   const lane = this.lanes[i]!;
   const page = this.hosts[i]!.page(laneCursor(lane));
   this.lanes[i] = { grant, messages: [...lane.messages, ...page.messages], hasMore: page.hasMore };
  }
 }
 refresh(grant: string) {
  const i = this.lanes.findIndex(lane => lane.grant === grant);
  const head = this.hosts[i]!.page(null).messages, ids = new Set(head.map(m => m.id));
  const lane = this.lanes[i]!;
  this.lanes[i] = { ...lane, messages: [...head, ...lane.messages.filter(m => !ids.has(m.id))] };
 }
}

/** Every shown message is in order, and no grant still holds back a message newer than the
 *  oldest shown (unfetched messages older than the floor only). */
function assertSafe(client: Client) {
 const items = client.merge.items;
 const keys = items.map(item => [item.message.createdUnixMs, item.message.id, item.grant] as [number, string, string]);
 expect(keys.map(k => k.join("/"))).toEqual([...keys].sort(compareKeys).map(k => k.join("/")));
 const oldestShown = items[0]?.message.createdUnixMs;
 if (oldestShown === undefined) return;
 client.hosts.forEach((host, i) => {
  const held = new Set(client.lanes[i]!.messages.map(m => m.id));
  expect(host.store.filter(m => !held.has(m.id) && m.createdUnixMs > oldestShown).map(m => m.id)).toEqual([]);
 });
}

const range = (n: number) => [...Array(n).keys()];

test("three grants with uneven paging interleave without a gap, duplicate or reorder", () => {
 const a = new Host("a", range(23).map(i => gram(`a${i}`, 1000 + i * 7)), 5);
 const b = new Host("b", range(4).map(i => gram(`b${i}`, 1003 + i * 40)), 3);
 const c = new Host("c", range(11).map(i => gram(`c${i}`, 1001 + i * 13)), 2);
 const client = new Client([a, b, c]);
 let previous = client.merge.items.map(item => item.id), rounds = 0;
 while (client.merge.hasMore) {
  assertSafe(client);
  client.earlier();
  const now = client.merge.items.map(item => item.id);
  expect(now.slice(now.length - previous.length)).toEqual(previous);
  previous = now;
  expect(++rounds).toBeLessThan(50);
 }
 assertSafe(client);
 const all = a.store.length + b.store.length + c.store.length;
 expect(client.merge.items.length).toBe(all);
 expect(new Set(client.merge.items.map(item => item.id)).size).toBe(all);
 expect(client.merge.hiddenCount).toBe(0);
});

test("the safe floor hides what another grant may still be missing", () => {
 const a = new Host("a", range(10).map(i => gram(`a${i}`, 100 + i * 10)), 3);
 const b = new Host("b", range(3).map(i => gram(`b${i}`, 95 + i * 30)), 5);
 const c = new Host("c", range(6).map(i => gram(`c${i}`, 101 + i * 15)), 2);
 const client = new Client([a, b, c]);
 // a holds 170...190 (more), b all of 95, 125, 155, c 161 and 176 (more): floor 170.
 expect(client.merge.floorUnixMs).toBe(170);
 expect(client.merge.items.map(item => item.id)).toEqual(["a/a7", "c/c5", "a/a8", "a/a9"]);
 expect(client.merge.grantsToPage).toEqual(["a"]);
 expect(client.merge.hiddenCount).toBe(4);
 assertSafe(client);
 client.earlier();
 assertSafe(client);
 expect(client.merge.floorUnixMs).toBe(161);
 expect(client.merge.grantsToPage).toEqual(["c"]);
 expect(client.merge.items.some(item => item.message.createdUnixMs < 161)).toBe(false);
});

test("equal timestamps break ties by id byte-wise, then grant", () => {
 const lanes: GuestGramLane[] = [
  { grant: "h2", messages: [gram("m-b", 500), gram("X", 500)], hasMore: false },
  { grant: "h1", messages: [gram("m-b", 500), gram("m-a", 500)], hasMore: false },
 ];
 expect(mergeGuestGram(lanes).items.map(item => item.id)).toEqual(["h2/X", "h1/m-a", "h1/m-b", "h2/m-b"]);
 expect(mergeGuestGram([...lanes].reverse()).items.map(item => item.id)).toEqual(["h2/X", "h1/m-a", "h1/m-b", "h2/m-b"]);
});

test("a new message in one grant while the others page joins at the bottom", () => {
 const a = new Host("a", range(9).map(i => gram(`a${i}`, 10 + i * 10)), 3);
 const b = new Host("b", range(9).map(i => gram(`b${i}`, 15 + i * 10)), 3);
 const client = new Client([a, b]);
 client.earlier();
 a.store.push(gram("a-new", 10_000));
 client.refresh("a");
 expect(client.merge.items.at(-1)?.id).toBe("a/a-new");
 assertSafe(client);
 while (client.merge.hasMore) { client.earlier(); assertSafe(client); }
 expect(client.merge.items.length).toBe(19);
 expect(new Set(client.merge.items.map(item => item.id)).size).toBe(19);
});

test("unread sums across grants and reading marks only shown unread, per grant", () => {
 const merge = mergeGuestGram([
  { grant: "a", messages: [gram("a2", 300), gram("a1", 50)], hasMore: true },
  { grant: "b", messages: [gram("b1", 200), gram("b0", 100, { read: true }), gram("mine", 250, { incoming: false })], hasMore: false },
  { grant: "c", messages: [], hasMore: false },
 ]);
 expect(merge.unreadCount).toBe(3);
 expect([merge.unreadByGrant.get("a"), merge.unreadByGrant.get("b"), merge.unreadByGrant.get("c")]).toEqual([2, 1, 0]);
 expect(Object.fromEntries(merge.shownUnreadByGrant)).toEqual({ a: ["a1", "a2"], b: ["b1"] });
 const hidden = mergeGuestGram([
  { grant: "a", messages: [gram("a2", 300)], hasMore: true },
  { grant: "b", messages: [gram("b1", 200)], hasMore: false },
 ]);
 expect(Object.fromEntries(hidden.shownUnreadByGrant)).toEqual({ a: ["a2"] });
 expect(hidden.unreadCount).toBe(2);
});

test("a reply goes to its message's grant; a new message to the newest incoming one's, else the first", () => {
 const merge = mergeGuestGram([
  { grant: "a", messages: [gram("x", 100)], hasMore: false },
  { grant: "b", messages: [gram("x", 200), gram("mine", 300, { incoming: false })], hasMore: false },
 ]);
 expect(replyTarget(merge, "a/x")).toBe("a");
 expect(replyTarget(merge, "b/x")).toBe("b");
 expect(replyTarget(merge, "c/x")).toBeNull();
 expect(merge.defaultTarget).toBe("b");
 expect(mergeGuestGram([{ grant: "q", messages: [], hasMore: false }, { grant: "r", messages: [], hasMore: false }]).defaultTarget).toBe("q");
});

test("the list groups rows by owner and machine, newest first, labelled only for several", () => {
 const info = (id: string, owner = "Jerry", machine = "Mac Studio") => ({ id, agent: id, owner, machine });
 const lane = (id: string, ms: number[], owner?: string, machine?: string) =>
  ({ grant: id, info: info(id, owner, machine), messages: ms.map((t, i) => gram(`${id}${i}`, t)), hasMore: false });
 const { groups, labelled } = guestGramGroups([lane("legal", [1005]), lane("intern", [1031]), lane("market", [1044, 900]), lane("ledger", [1040], "Alex", "lab-box"), lane("quiet", [])]);
 expect(labelled).toBe(true);
 expect(groups.map(g => [g.label, g.rows.map(r => r.grant.id)])).toEqual([
  ["Jerry · Mac Studio", ["market", "intern", "legal", "quiet"]],
  ["Alex · lab-box", ["ledger"]],
 ]);
 expect(guestGramGroups([lane("solo", [])]).labelled).toBe(false);
});
