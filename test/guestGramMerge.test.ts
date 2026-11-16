// herdrup#697: one guest Gram across grants, merged on the client. A port of HerdrKit's
// GuestGramMergeTests.swift (herdrup#702 @1a8e0bbb), case for case, so the three apps agree.
import { expect, test } from "bun:test";
import { compareKeys, guestGramGroups, laneCursor, mergeGuestGram, recipientLabels, replyTarget, type GuestGramLane, type GuestGramMessage } from "../src/guestGramMerge";

const gram = (id: string, ms: number, { incoming = true, read = false } = {}): GuestGramMessage =>
 ({ id, createdUnixMs: ms, fromAgent: incoming, unread: incoming && !read });
const lane = (grant: string, messages: GuestGramMessage[], hasMore: boolean, loaded = true): GuestGramLane => ({ grant, messages, hasMore, loaded });

/** One grant's host: herdr's order (guest::gram::list), a stable sort by time, newest first, so
 *  equal times come in reverse store order, not by id; paged by before_id like gram.list. */
class Host {
 constructor(readonly grant: string, public store: GuestGramMessage[], readonly pageSize: number) {}
 page(cursor: string | null): { messages: GuestGramMessage[]; hasMore: boolean } {
  const sorted = this.store.map((m, i) => ({ m, i })).sort((a, b) => b.m.createdUnixMs - a.m.createdUnixMs || b.i - a.i).map(x => x.m);
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
  this.lanes = hosts.map(host => { const page = host.page(null); return lane(host.grant, page.messages, page.hasMore); });
 }
 get merge() { return mergeGuestGram(this.lanes); }
 earlier() {
  for (const grant of this.merge.grantsToPage) {
   const i = this.lanes.findIndex(l => l.grant === grant);
   const held = this.lanes[i]!;
   const page = this.hosts[i]!.page(laneCursor(held));
   this.lanes[i] = lane(grant, [...held.messages, ...page.messages], page.hasMore);
  }
 }
 refresh(grant: string) {
  const i = this.lanes.findIndex(l => l.grant === grant);
  const head = this.hosts[i]!.page(null).messages, ids = new Set(head.map(m => m.id));
  const held = this.lanes[i]!;
  this.lanes[i] = { ...held, messages: [...head, ...held.messages.filter(m => !ids.has(m.id))] };
 }
}

/** Every shown message is in order, and no grant still holds back a message at or after the
 *  oldest shown (unfetched messages older than the floor only). */
function assertSafe(client: Client) {
 const items = client.merge.items;
 const keys = items.map(item => [item.message.createdUnixMs, item.message.id, item.grant] as [number, string, string]);
 expect(keys.map(k => k.join("/"))).toEqual([...keys].sort(compareKeys).map(k => k.join("/")));
 const oldestShown = items[0]?.message.createdUnixMs;
 if (oldestShown === undefined) return;
 client.hosts.forEach((host, i) => {
  const held = new Set(client.lanes[i]!.messages.map(m => m.id));
  expect(host.store.filter(m => !held.has(m.id) && m.createdUnixMs >= oldestShown).map(m => m.id)).toEqual([]);
 });
}

const range = (n: number) => [...Array(n).keys()];

function drain(client: Client) {
 let previous = client.merge.items.map(item => item.id), rounds = 0;
 while (client.merge.hasMore) {
  assertSafe(client);
  client.earlier();
  assertSafe(client);
  const now = client.merge.items.map(item => item.id);
  expect(now.slice(now.length - previous.length)).toEqual(previous);
  previous = now;
  expect(++rounds).toBeLessThan(50);
 }
}

test("three grants with uneven paging interleave without a gap, duplicate or reorder", () => {
 const a = new Host("a", range(23).map(i => gram(`a${i}`, 1000 + i * 7)), 5);
 const b = new Host("b", range(4).map(i => gram(`b${i}`, 1003 + i * 40)), 3);
 const c = new Host("c", range(11).map(i => gram(`c${i}`, 1001 + i * 13)), 2);
 const client = new Client([a, b, c]);
 drain(client);
 assertSafe(client);
 const all = a.store.length + b.store.length + c.store.length;
 expect(client.merge.items.length).toBe(all);
 expect(new Set(client.merge.items.map(item => item.id)).size).toBe(all);
 expect(client.merge.hiddenCount).toBe(0);
});

test("the safe floor hides what another grant may still be missing, its own millisecond too", () => {
 const a = new Host("a", range(10).map(i => gram(`a${i}`, 100 + i * 10)), 3);
 const b = new Host("b", range(3).map(i => gram(`b${i}`, 95 + i * 30)), 5);
 const c = new Host("c", range(6).map(i => gram(`c${i}`, 101 + i * 15)), 2);
 const client = new Client([a, b, c]);
 // a holds 170...190 (more), b all of 95, 125, 155, c 161 and 176 (more): floor 170, and only
 // what is strictly newer shows (a's 170 itself waits on its millisecond).
 expect(client.merge.floorUnixMs).toBe(170);
 expect(client.merge.items.map(item => item.id)).toEqual(["c/c5", "a/a8", "a/a9"]);
 expect(client.merge.grantsToPage).toEqual(["a"]);
 expect(client.merge.hiddenCount).toBe(5);
 assertSafe(client);
 client.earlier();
 assertSafe(client);
 expect(client.merge.floorUnixMs).toBe(161);
 expect(client.merge.grantsToPage).toEqual(["c"]);
 expect(client.merge.items[0]?.id).toBe("a/a7");
 expect(client.merge.items.some(item => item.message.createdUnixMs <= 161)).toBe(false);
});

test("equal timestamps break ties by id byte-wise, then grant", () => {
 const lanes = [lane("h2", [gram("m-b", 500), gram("X", 500)], false), lane("h1", [gram("m-b", 500), gram("m-a", 500)], false)];
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
  lane("a", [gram("a2", 300), gram("a1", 50)], true),
  lane("b", [gram("b1", 200), gram("b0", 100, { read: true }), gram("mine", 250, { incoming: false })], false),
  lane("c", [], false),
 ]);
 expect(merge.unreadCount).toBe(3);
 expect([merge.unreadByGrant.get("a"), merge.unreadByGrant.get("b"), merge.unreadByGrant.get("c")]).toEqual([2, 1, 0]);
 // a's oldest held is 50, so the floor is 50: a1 waits on its millisecond.
 expect(Object.fromEntries(merge.shownUnreadByGrant)).toEqual({ a: ["a2"], b: ["b1"] });
 const hidden = mergeGuestGram([lane("a", [gram("a3", 400), gram("a2", 300)], true), lane("b", [gram("b1", 200)], false)]);
 expect(Object.fromEntries(hidden.shownUnreadByGrant)).toEqual({ a: ["a3"] });
 expect(hidden.unreadCount).toBe(3);
});

test("a reply goes to its message's grant; a new message to the newest incoming one's, else the first", () => {
 const merge = mergeGuestGram([lane("a", [gram("x", 100)], false), lane("b", [gram("x", 200), gram("mine", 300, { incoming: false })], false)]);
 expect(replyTarget(merge, "a/x")).toBe("a");
 expect(replyTarget(merge, "b/x")).toBe("b");
 expect(replyTarget(merge, "c/x")).toBeNull();
 expect(merge.defaultTarget).toBe("b");
 expect(mergeGuestGram([lane("q", [], false), lane("r", [], false)]).defaultTarget).toBe("q");
});

// Review 1 (#702): a page can end inside a group sharing one millisecond, which the host orders by
// its store, not by id. Nothing at the floor's millisecond shows until it is complete.
test("a page ending inside one millisecond never inserts below shown rows", () => {
 const scenarios: Array<[GuestGramMessage[], GuestGramMessage[]]> = [
  [[gram("y", 500), gram("z", 500)], [gram("a", 500)]],
  [[gram("q", 500), gram("c", 500)], [gram("k", 500)]],
  [[gram("q", 500), gram("c", 500), gram("top", 900)], [gram("k", 500)]],
 ];
 for (const [a, b] of scenarios) {
  const client = new Client([new Host("a", a, 1), new Host("b", b, 5)]);
  assertSafe(client);
  drain(client);
  expect(client.merge.items.length).toBe(a.length + b.length);
 }
});

test("a grant still loading withholds the combined range", () => {
 const early = mergeGuestGram([lane("fast", [gram("old", 100)], false), lane("slow", [], false, false)]);
 expect(early.items).toEqual([]);
 expect(early.shownUnreadByGrant.size).toBe(0);
 expect(early.hasMore).toBe(false);
 expect(early.pending).toBe(true);
 expect(early.unreadCount).toBe(1);
 const later = mergeGuestGram([lane("fast", [gram("old", 100)], false), lane("slow", [gram("new", 1000)], true)]);
 expect(later.items.some(item => item.id === "fast/old")).toBe(false);
 expect(later.grantsToPage).toEqual(["slow"]);
});

// A share's id is Access.ID(), "<host id>/<guest id>": the last two label parts come from it.
const share = (guest: string, agent: string, owner: string, machine: string, host: string, terminal: string) => ({ id: `${host}/${guest}`, agent, owner, machine, terminal });

test("recipient labels tell same-named agents apart", () => {
 const shares = [
  share("g1", "llm-opt", "Jerry", "Studio", "h1", "w1"),
  share("g2", "enyo-ui", "Jerry", "Studio", "h1", "w2-4"),
  share("g3", "enyo-ui", "Jerry", "Studio", "h1", "w2-9"),
  share("g4", "docs", "Jerry", "Studio", "h1", "w3"),
  share("g5", "docs", "Ana", "Laptop", "h2", "w3"),
 ];
 const labels = recipientLabels(shares);
 expect(shares.map(s => labels.get(s.id))).toEqual([
  "llm-opt", "enyo-ui · Jerry · Studio · w2-4", "enyo-ui · Jerry · Studio · w2-9", "docs · Jerry · Studio", "docs · Ana · Laptop",
 ]);
 expect(new Set(labels.values()).size).toBe(shares.length);
});

// Review 2 (#702): terminals are host-local, so two machines each holding two enyo-ui at the same
// terminals keep their owner and machine as well as the terminal.
test("recipient labels stay unique across machines with duplicates", () => {
 const shares = [
  share("g1", "enyo-ui", "Jerry", "Studio", "h1", "w1-3"),
  share("g2", "enyo-ui", "Jerry", "Studio", "h1", "w2-4"),
  share("g3", "enyo-ui", "Ana", "Laptop", "h2", "w1-3"),
  share("g4", "enyo-ui", "Ana", "Laptop", "h2", "w2-4"),
  // Same owner and machine label on another host, same terminal: the host tells it apart.
  share("g5", "enyo-ui", "Ana", "Laptop", "h3-abcdef", "w1-3"),
 ];
 const labels = recipientLabels(shares);
 expect(shares.map(s => labels.get(s.id))).toEqual([
  "enyo-ui · Jerry · Studio · w1-3", "enyo-ui · Jerry · Studio · w2-4",
  "enyo-ui · Ana · Laptop · w1-3 · h2", "enyo-ui · Ana · Laptop · w2-4",
  "enyo-ui · Ana · Laptop · w1-3 · h3-abc",
 ]);
 expect(new Set(labels.values()).size).toBe(shares.length);
});

test("the list groups rows by owner and machine, newest first, labelled only for several", () => {
 const info = (id: string, owner = "Jerry", machine = "Mac Studio") => ({ id, agent: id, owner, machine, terminal: "w1", label: id });
 const row = (id: string, ms: number[], owner?: string, machine?: string) =>
  ({ ...lane(id, ms.map((t, i) => gram(`${id}${i}`, t)), false), info: info(id, owner, machine) });
 const { groups, labelled } = guestGramGroups([row("legal", [1005]), row("intern", [1031]), row("market", [1044, 900]), row("ledger", [1040], "Alex", "lab-box"), row("quiet", [])]);
 expect(labelled).toBe(true);
 expect(groups.map(g => [g.label, g.rows.map(r => r.grant.id)])).toEqual([
  ["Jerry · Mac Studio", ["market", "intern", "legal", "quiet"]],
  ["Alex · lab-box", ["ledger"]],
 ]);
 expect(guestGramGroups([row("solo", [])]).labelled).toBe(false);
});
