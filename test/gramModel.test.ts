// The Gram screen's decisions (src/gramModel.ts), against herdrup 9876878's GramView.swift,
// GramCards.swift, ComposerView.swift and HerdrKit ConversationColumnWidth.
import { describe, expect, test } from "bun:test";
import { draftAddress, type GramAgent } from "../src/gramMention";
import * as m from "../src/gramModel";

const H = 3_600_000;
const t0 = Date.UTC(2026, 9, 29, 9, 0);
const utcDay = (a: Date, b: Date) => a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
const agent = (id: string, from: string, at: number) => ({ id, fromAgent: true, from, createdUnixMs: at });
const mine = (id: string, to: string | undefined, at: number) => ({ id, fromAgent: false, from: "owner", to, createdUnixMs: at });

describe("feedEntries", () => {
  test("separators go above the first row, after an hour's gap and on a new day", () => {
    const rows = [agent("a", "v", t0), agent("b", "v", t0 + H), agent("c", "v", t0 + 2 * H + 1000), agent("d", "v", t0 + 15 * H)];
    const e = m.feedEntries(rows, null, utcDay);
    expect(e.map((x) => x.separator !== null)).toEqual([true, false, true, true]);
  });

  test("groups are one side and one sender (theirs) or recipient (yours); markers break them", () => {
    const rows = [agent("a", "v", t0), agent("b", "v", t0 + 1), agent("c", "w", t0 + 2), mine("d", "v", t0 + 3), mine("e", "v", t0 + 4), mine("f", undefined, t0 + 5)];
    const e = m.feedEntries(rows, { messageID: "b", count: 2 }, utcDay);
    expect(e.map((x) => [x.startsGroup, x.endsGroup])).toEqual([
      [true, true], // the rule above b breaks the a-b group
      [true, true],
      [true, true],
      [true, false],
      [false, true],
      [true, true],
    ]);
    expect(e[1]!.unreadCount).toBe(2);
    expect(e[0]!.unreadCount).toBeNull();
  });

  test("row gaps: 0 at the top, 2 inside a group, 10 between and after a marker", () => {
    const e = m.feedEntries([agent("a", "v", t0), agent("b", "v", t0 + 1), agent("c", "w", t0 + 2)], null, utcDay);
    expect(e.map((x, i) => m.rowGaps(i, x))).toEqual([
      { separator: 0, rule: 12, row: 10 },
      { separator: 16, rule: 12, row: 2 },
      { separator: 16, rule: 12, row: 10 },
    ]);
    expect(m.rowGaps(0, { ...e[1]!, separator: null })).toEqual({ separator: 0, rule: 0, row: 0 });
  });
});

describe("unread rule and window", () => {
  test("the rule sits on the oldest unread, counting every unread held", () => {
    const msgs = [{ ...agent("n", "v", 3), unread: true }, { ...agent("o", "v", 2), unread: false }, { ...agent("p", "v", 1), unread: true }];
    expect(m.captureUnreadRule(msgs)).toEqual({ messageID: "p", count: 2 });
    expect(m.captureUnreadRule([{ ...agent("x", "v", 1), unread: false }])).toBeNull();
  });

  test("the window is the newest N, oldest first", () => {
    expect(m.drawnWindow(["c", "b", "a"], 2)).toEqual(["b", "c"]);
  });

  test("the sentinel shows with hidden older rows or more on herdr", () => {
    expect(m.showsSentinel(81, 80, false)).toBe(true);
    expect(m.showsSentinel(80, 80, false)).toBe(false);
    expect(m.showsSentinel(10, 80, true)).toBe(true);
  });
});

describe("search", () => {
  const msgs = [
    { text: "deploy", from: "a/vetrina", senderName: "Mac/vetrina", to: undefined },
    { text: "x", from: "owner", senderName: "You", to: "clientloop" },
    { text: "y", from: "llm", senderName: "llm", file: { name: "Bench.csv" } },
    { text: "z", from: "llm", senderName: "llm", expiredFile: { name: "logs.tar" } },
  ];
  test("matches text, sender, recipient and file name, ignoring case", () => {
    expect(m.filterMessages(msgs, "DEPLOY").length).toBe(1);
    expect(m.filterMessages(msgs, "mac/").length).toBe(1);
    expect(m.filterMessages(msgs, "clientloop").length).toBe(1);
    expect(m.filterMessages(msgs, "bench").length).toBe(1);
    expect(m.filterMessages(msgs, "logs").length).toBe(1);
    expect(m.filterMessages(msgs, "").length).toBe(4);
  });
  test("saved copies match sender, text and file name", () => {
    expect(m.filterSaved([{ text: "a", from: "vetrina", file: { name: "k.png" } }], "K.PNG").length).toBe(1);
  });
});

describe("states", () => {
  const base = { phase: "loaded", messageCount: 3, visibleCount: 3, search: "", showsSetupCard: false, hasMore: false };
  test("without a search the feed shows, whatever the visible count says", () => {
    expect(m.inboxView({ phase: "loaded", messageCount: 3, visibleCount: 0, search: "", showsSetupCard: false, hasMore: false }).kind).toBe("feed");
  });
  test("loading, unavailable, empty, no matches, feed", () => {
    expect(m.inboxView({ ...base, phase: "loading" }).kind).toBe("loading");
    expect(m.inboxView({ ...base, phase: "unavailable", unavailable: "x" })).toEqual({ kind: "unavailable", text: "x" });
    expect(m.inboxView({ ...base, messageCount: 0, visibleCount: 0 }).kind).toBe("empty");
    expect(m.inboxView({ ...base, messageCount: 0, visibleCount: 0, showsSetupCard: true }).kind).toBe("feed");
    expect(m.inboxView({ ...base, search: "q", visibleCount: 0, hasMore: true })).toEqual({ kind: "noMatches", hasOlder: true, loadedCount: 3 });
    expect(m.inboxView(base).kind).toBe("feed");
  });
  test("saved: empty, no matches, feed", () => {
    expect([m.savedView(0, 0), m.savedView(2, 0), m.savedView(2, 1)]).toEqual(["empty", "noMatches", "feed"]);
  });
  test("the setup card hides once an agent wrote or it was dismissed", () => {
    expect(m.showsSetupCard(false, [{ fromAgent: false }])).toBe(true);
    expect(m.showsSetupCard(false, [{ fromAgent: true }])).toBe(false);
    expect(m.showsSetupCard(true, [])).toBe(false);
  });
  test("sentinel and no-matches wording", () => {
    const s = { pageError: null, searching: false, searchingOlder: false, searchedWithoutMatch: null };
    expect(m.sentinelLine(s).text).toBe("Loading older messages…");
    expect(m.sentinelLine({ ...s, pageError: "Couldn't load older messages." })).toEqual({ text: "Couldn't load older messages. Tap to retry.", icon: "retry", tappable: true });
    expect(m.sentinelLine({ ...s, searching: true }).text).toBe("Tap or scroll up to search older messages");
    expect(m.sentinelLine({ ...s, searching: true, searchedWithoutMatch: 120 }).text).toBe("No older matches in 120 messages. Tap or scroll up to search further");
    expect(m.sentinelLine({ ...s, searching: true, searchingOlder: true }).text).toBe("Searching older messages…");
    expect(m.noMatchesText(true, 40, "q", null).body).toBe("Nothing in the 40 most recent messages matches “q”.");
    expect(m.noMatchesText(false, 40, "q", null)).toEqual({ title: "No matches", body: "Nothing in this list matches “q”.", offersOlder: false });
  });
});

describe("cards", () => {
  test("an image card takes the picture's shape, clamped to 3:4 … 4:1, within 440 x 236", () => {
    expect(m.imageBox(null)).toEqual({ width: 440, height: 236 });
    expect(m.imageBox({ width: 1000, height: 100 })).toEqual({ width: 440, height: 110 });
    expect(m.imageBox({ width: 100, height: 1000 })).toEqual({ width: 177, height: 236 });
  });
  test("the tail goes only on a group's last text part with no card", () => {
    const s = { endsGroup: true, hasText: true, hasCard: false, hasImage: false };
    expect(m.showsTail(s)).toBe(true);
    expect(m.showsTail({ ...s, endsGroup: false })).toBe(false);
    expect(m.showsTail({ ...s, hasCard: true })).toBe(false);
    expect(m.showsTail({ ...s, hasImage: true })).toBe(false);
  });
  test("the context menu in herdrup's order", () => {
    expect(m.menuItems({ hasFile: true, hasText: true, saved: false, savedCopy: false })).toEqual(["Save to Files", "Copy", "Save", "Delete"]);
    expect(m.menuItems({ hasFile: false, hasText: true, saved: true, savedCopy: false })).toEqual(["Copy", "Unsave", "Delete"]);
    expect(m.menuItems({ hasFile: true, hasText: false, saved: true, savedCopy: true })).toEqual(["Save to Files"]);
  });
  test("document label, file kind and middle truncation", () => {
    expect(m.documentLabel("a.markdown")).toBe("MARK");
    expect(m.documentLabel("Makefile")).toBe("");
    expect(m.fileKind("bench.CSV", "text/csv")).toBe("comma-separated values");
    expect(m.fileKind("x.unknown", "image/x")).toBe("Image");
    expect(m.middleTruncate("abcdefghij", 6, (s) => s.length)).toBe("abc…ij");
    expect(m.middleTruncate("abc", 6, (s) => s.length)).toBe("abc");
  });
  test("links: http(s) and www, without trailing punctuation", () => {
    expect(m.linkRuns("see https://x.dev/a), and www.y.io.")).toEqual([
      { text: "see ", href: null },
      { text: "https://x.dev/a", href: "https://x.dev/a" },
      { text: "), and ", href: null },
      { text: "www.y.io", href: "https://www.y.io" },
      { text: ".", href: null },
    ]);
    expect(m.linkRuns("(https://x.dev/a_(b))")[1]!.text).toBe("https://x.dev/a_(b)");
  });
});

describe("avatars and the sidebar", () => {
  test("the header cluster: newest 38 pt in the middle, the next two 26 pt either side", () => {
    expect(m.clusterPlaces(["a/v", "v", "w", "x", "y"])).toEqual([
      { name: "w", size: 26, x: 0, y: 16 },
      { name: "x", size: 26, x: 52, y: 16 },
      { name: "a/v", size: 38, x: 20, y: 2 },
    ]);
  });
  test("the Gram row's two most recent distinct agents", () => {
    expect(m.recentAgentSenders([{ fromAgent: false, name: "o" }, { fromAgent: true, name: "v" }, { fromAgent: true, name: "v" }, { fromAgent: true, name: "w" }, { fromAgent: true, name: "z" }])).toEqual(["v", "w"]);
  });
});

describe("composer", () => {
  const agents: GramAgent[] = [
    { from: "vetrina", name: "vetrina", machine: "hz" },
    { from: "a/vet", name: "vet", machine: "Mac" },
    { from: "b/ovet", name: "ovet", machine: null },
  ];
  test("@ matches: names starting with the query, then containing it", () => {
    expect(m.mentionMatches(agents, "VET").map((a) => a.name)).toEqual(["vetrina", "vet", "ovet"]);
    expect(m.mentionMatches(agents, "o").map((a) => a.name)).toEqual(["ovet"]);
    expect(m.mentionMatches(agents, "").length).toBe(3);
  });
  test("a shared name carries its machine in the title", () => {
    expect(m.agentTitle(agents[0]!, new Set(["vetrina"]))).toEqual({ title: "vetrina · hz", machineLine: null });
    expect(m.agentTitle(agents[2]!, new Set(["ovet"])).title).toBe("ovet · this device");
    expect(m.agentTitle(agents[1]!, new Set())).toEqual({ title: "vet", machineLine: "Mac" });
  });
  test("Send: routed, something to say, nothing in flight", () => {
    const ok = draftAddress("@vetrina hi", agents, null);
    expect(m.canSend(ok, 0, false, false)).toBe(true);
    expect(m.canSend(ok, 0, true, false)).toBe(false);
    expect(m.canSend(ok, 0, false, true)).toBe(false);
    expect(m.canSend(draftAddress("@nobody hi", agents, null), 1, false, false)).toBe(false);
    expect(m.canSend(draftAddress("@vetrina", agents, null), 0, false, false)).toBe(false);
    expect(m.canSend(draftAddress("@vetrina", agents, null), 1, false, false)).toBe(true);
  });
  test("the sheet's checkmark and the hint", () => {
    const a = draftAddress("@vet hi", agents, null);
    expect(m.isAddressed(a, agents[1]!)).toBe(true);
    expect(m.isAddressed(a, agents[0]!)).toBe(false);
    expect(m.isAddressed(draftAddress("hi", agents, null), null)).toBe(true);
    expect(m.shownHint("x", true)).toBeNull();
    expect(m.shownHint("x", false)).toBe("x");
  });
  test("chips: glyph, ring and the latest upload event", () => {
    expect(m.chipGlyph({ state: "uploaded", failed: false, isImage: true })).toBe("check");
    expect(m.chipGlyph({ state: "uploadFailed", failed: true, isImage: false })).toBe("alert");
    expect(m.chipGlyph({ state: "ready", failed: false, isImage: true })).toBe("photo");
    expect(m.chipRing({ determinate: true, indeterminate: false, fraction: 0.4 })).toBe(0.4);
    expect(m.chipRing({ determinate: false, indeterminate: true, fraction: 0 })).toBe("spin");
    expect(m.chipRing({ determinate: false, indeterminate: false, fraction: 0 })).toBeNull();
    const chip = { path: "/f", state: "uploading", fraction: 0.1, label: "10%" };
    expect(m.mergeChip(chip, { path: "/f", state: "uploading", fraction: 0.5, label: "50%" }).label).toBe("50%");
    expect(m.mergeChip(chip, { path: "/f", state: "uploaded", fraction: 1, label: "Ready" })).toBe(chip);
  });
  test("the field leaves its row once a file is attached or the text wraps, with hysteresis", () => {
    const lines = (w: number) => (w < 100 ? 2 : 1);
    expect(m.composerExpanded(true, lines, 500, false)).toBe(true);
    expect(m.composerExpanded(false, lines, 99, false)).toBe(true);
    expect(m.composerExpanded(false, lines, 110, false)).toBe(false);
    expect(m.composerExpanded(false, lines, 110, true)).toBe(true);
  });
  test("a pick keeps the caret's distance from the end", () => {
    expect(m.caretAfter("hi @ve x", 6, "hi @vetrina  x")).toBe(12);
  });
});

describe("column width", () => {
  test("displayed, dragged with snaps, stored and read out", () => {
    expect(m.displayedWidth(Number.NaN, 2000)).toBe(1000);
    expect(m.displayedWidth(300, 2000)).toBe(560);
    expect(m.displayedWidth(1000, 800)).toBe(800);
    expect(m.draggedWidth(700, 4, "trailing", 2000)).toBe(720);
    expect(m.draggedWidth(700, 4, "leading", 2000)).toBe(692);
    expect(m.draggedWidth(600, -100, "trailing", 2000)).toBe(560);
    expect(m.storedWidth(1500, 1500)).toBe(100_000);
    expect(m.widthReadout(720, 2000)).toBe("720 pt · Readable");
    expect(m.widthReadout(800, 2000)).toBe("800 pt");
  });
});
