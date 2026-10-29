// Translated case by case from herdrup 9876878 Tests/HerdrKitTests/GramMentionTests.swift;
// each `test` names its XCTest. The routing tests at the end cover GramView.draftAddress,
// hint(for:), canSend and the pick rule, which herdrup only covers through UI tests.
import { expect, test } from "bun:test";
import * as GramMention from "../src/gramMention";
import type { GramAgent } from "../src/gramMention";

const agents = ["vetrina", "clientloop", "trend-scout", "ci-watch"];

function query(text: string, cursorOffset?: number): { token: string; query: string } | null {
  const found = GramMention.activeQuery(text, cursorOffset);
  return found ? { token: text.slice(found.start, found.end), query: found.query } : null;
}

const resolve = (text: string, names: string[] = agents) => GramMention.resolve(text, names);

// MARK: activeQuery

test("testBareAtIsAnEmptyQuery", () => {
  expect(query("@")).toEqual({ token: "@", query: "" });
});

test("testTrailingTokenAfterSpaceIsTheQuery", () => {
  expect(query("ship it @ve")).toEqual({ token: "@ve", query: "ve" });
});

test("testQueryKeepsHyphens", () => {
  expect(query("@trend-sc")?.query).toBe("trend-sc");
});

test("testQueryAfterNewline", () => {
  expect(query("first line\n@ci")).toEqual({ token: "@ci", query: "ci" });
});

test("testAtInsideAWordIsNotAQuery", () => {
  expect(query("mail me@vet")).toBeNull(); // an email-like @ is not a mention
  expect(query("a@")).toBeNull();
  expect(query("@@ve")).toBeNull();
});

test("testNoQueryOnceTheTokenEnds", () => {
  expect(query("@vetrina ")).toBeNull(); // a space after the name ends the query
  expect(query("@vetrina ship it")).toBeNull(); // only the trailing token counts
  expect(query("")).toBeNull();
  expect(query("ship it")).toBeNull();
});

test("testQueryEndsAtTheCursor", () => {
  // "ask @ve|\nthen go": the token before the cursor, not the text after it.
  expect(query("ask @ve\nthen go", 7)).toEqual({ token: "@ve", query: "ve" });
  expect(query("ask @ve then go", 3)).toBeNull(); // no @ before the cursor
});

// MARK: complete

test("testCompleteReplacesTheTokenWithTheNameAndASpace", () => {
  const text = "ship it @ve";
  const found = GramMention.activeQuery(text)!;
  expect(GramMention.complete(text, found, "vetrina")).toBe("ship it @vetrina ");
});

test("testCompleteAtTheStart", () => {
  const found = GramMention.activeQuery("@")!;
  expect(GramMention.complete("@", found, "ci-watch")).toBe("@ci-watch ");
});

test("testCompleteKeepsTheTextAfterTheCursor", () => {
  const text = "ask @ci\nthen go";
  const found = GramMention.activeQuery(text, 7)!;
  expect(GramMention.complete(text, found, "ci-watch")).toBe("ask @ci-watch \nthen go");
});

// MARK: resolve

test("testLeadingMentionIsTheRecipientAndLeavesTheBody", () => {
  // the leading mention and its space are stripped
  expect(resolve("@vetrina ship it")).toEqual({ recipient: "vetrina", body: "ship it" });
});

test("testLeadingMentionBeforeANewline", () => {
  expect(resolve("@vetrina\nship it")).toEqual({ recipient: "vetrina", body: "ship it" });
});

test("testMentionMatchesCaseInsensitivelyAndReturnsTheKnownSpelling", () => {
  expect(resolve("@VeTrina ship it")).toEqual({ recipient: "vetrina", body: "ship it" });
});

test("testHyphenatedNames", () => {
  expect(resolve("@trend-scout digest?")).toEqual({ recipient: "trend-scout", body: "digest?" });
  expect(resolve("@CI-Watch rerun").recipient).toBe("ci-watch");
});

// Either order of the known names gives the same answer: a shorter name that the longer one
// starts with cannot end the token, so the matcher needs no longest-first sort.
test("testANameThatStartsAnotherNeverStealsTheMention", () => {
  for (const names of [
    ["trend", "trend-scout"],
    ["trend-scout", "trend"],
    ["vetrina", "vetrina.ops"],
    ["vetrina.ops", "vetrina"],
  ]) {
    const scout = resolve("@trend-scout digest?", names);
    const ops = resolve("@vetrina.ops digest?", names);
    if (names.includes("trend")) {
      expect(scout).toEqual({ recipient: "trend-scout", body: "digest?" });
      expect(resolve("@trend digest?", names).recipient).toBe("trend");
    } else {
      expect(ops).toEqual({ recipient: "vetrina.ops", body: "digest?" });
      expect(resolve("@vetrina. digest?", names).recipient).toBe("vetrina");
    }
  }
});

test("testLeadingMentionTakesTheSeparatorAfterItOff", () => {
  expect(resolve("@vetrina, ship it").body).toBe("ship it");
  expect(resolve("@vetrina: go").body).toBe("go");
  expect(resolve("@vetrina - go").body).toBe("go");
  expect(resolve("@vetrina;go").body).toBe("go");
  expect(resolve("@vetrina,\n  ship it").body).toBe("ship it");
  expect(resolve("@vetrina's build").body).toBe("'s build"); // an apostrophe is not a separator
  expect(resolve("@vetrina: ").body).toBe(""); // nothing but a separator is an empty body
  // a mention later in the text keeps its punctuation
  expect(resolve("ask @vetrina, then go").body).toBe("ask @vetrina, then go");
});

// Only the separator after the mention goes: the message's own leading dash, colon or bullet
// is content (CLI flags, negative numbers, markdown lists, smileys).
test("testLeadingMentionKeepsTheMessagesOwnPunctuation", () => {
  expect(resolve("@vetrina -v deploy").body).toBe("-v deploy");
  expect(resolve("@vetrina --dry-run deploy").body).toBe("--dry-run deploy");
  expect(resolve("@vetrina -5% is fine").body).toBe("-5% is fine");
  expect(resolve("@vetrina\n- item one\n- item two").body).toBe("- item one\n- item two");
  expect(resolve("@vetrina :) thanks").body).toBe(":) thanks");
  expect(resolve("@vetrina: - item").body).toBe("- item"); // one separator, then the content
});

test("desktop: an underscore continues a name", () => {
  expect(resolve("@vetrina_ops hi").recipient).toBeNull();
  expect(GramMention.leadingToken("@ci_watch, go")).toBe("ci_watch");
});

test("testAKnownNameMustEndTheToken", () => {
  expect(resolve("@vetrina2 ship it").recipient).toBeNull();
  expect(resolve("@trend-scoutx hi").recipient).toBeNull();
  expect(resolve("@trend digest", ["trend-scout"]).recipient).toBeNull(); // a prefix is not the name
  expect(resolve("@vetrina.dev is live").recipient).toBeNull(); // a domain is not a mention
  expect(resolve("thanks @vetrina.").recipient).toBe("vetrina"); // a full stop ends the name
});

test("testUnknownNameGoesToTheQueueUnchanged", () => {
  expect(resolve("@nobody ship it")).toEqual({ recipient: null, body: "@nobody ship it" });
});

test("testNoMentionGoesToTheQueueUnchanged", () => {
  expect(resolve("Who can triage the failing CI?")).toEqual({
    recipient: null,
    body: "Who can triage the failing CI?",
  });
  expect(resolve("@vetrina hi", []).recipient).toBeNull();
});

test("testEmailLikeAtIsNotAMention", () => {
  expect(resolve("mail me@vetrina when done")).toEqual({ recipient: null, body: "mail me@vetrina when done" });
});

test("testMidTextMentionAddressesButStaysInTheBody", () => {
  expect(resolve("ship it @vetrina")).toEqual({ recipient: "vetrina", body: "ship it @vetrina" });
});

test("testFirstKnownMentionWins", () => {
  expect(resolve("@ci-watch ask @vetrina")).toEqual({ recipient: "ci-watch", body: "ask @vetrina" });
  expect(resolve("ask @trend-scout and @vetrina")).toEqual({
    recipient: "trend-scout",
    body: "ask @trend-scout and @vetrina",
  });
});

test("testUnknownMentionBeforeAKnownOneIsSkipped", () => {
  // the known mention is not leading, so it stays
  expect(resolve("@nobody @vetrina hi")).toEqual({ recipient: "vetrina", body: "@nobody @vetrina hi" });
});

test("testMentionAloneLeavesAnEmptyBody", () => {
  expect(resolve("@vetrina")).toEqual({ recipient: "vetrina", body: "" });
});

// MARK: leadingToken

test("testLeadingTokenIsTheRunAfterALeadingAt", () => {
  expect(GramMention.leadingToken("@vetrna hi")).toBe("vetrna");
  expect(GramMention.leadingToken("  @vetrina, go")).toBe("vetrina");
  expect(GramMention.leadingToken("@vetrina.dev is live")).toBe("vetrina.dev");
  expect(GramMention.leadingToken("@vetrina.")).toBe("vetrina");
  expect(GramMention.leadingToken("@ hi")).toBe("");
  expect(GramMention.leadingToken("@")).toBe("");
});

test("testNoLeadingTokenWithoutALeadingAt", () => {
  expect(GramMention.leadingToken("ship it @vetrina")).toBeNull();
  expect(GramMention.leadingToken("me@vetrina")).toBeNull();
  expect(GramMention.leadingToken("")).toBeNull();
  expect(GramMention.leadingToken("   ")).toBeNull();
});

// MARK: ranges

test("testRangesCoverEveryKnownMention", () => {
  const text = "@vetrina ask @CI-Watch, not @nobody or me@vetrina.dev";
  expect(GramMention.ranges(text, agents).map((r) => text.slice(r.start, r.end))).toEqual(["@vetrina", "@CI-Watch"]);
});

test("testNoRangesWithoutKnownMentions", () => {
  expect(GramMention.ranges("plain text", agents)).toEqual([]);
  expect(GramMention.ranges("@vetrina", [])).toEqual([]);
});

// MARK: addressing / unaddressed (the pill sheet's "Write to" and "Shared queue")

const address = (text: string, name = "clientloop") => GramMention.addressing(text, name, agents);
const unaddress = (text: string) => GramMention.unaddressed(text, agents);

test("testAddressingReplacesALeadingMentionAndItsSeparator", () => {
  expect(address("@vetrina ship it")).toBe("@clientloop ship it");
  expect(address("@vetrina, ship it")).toBe("@clientloop ship it");
  expect(address("  @VETRINA: go")).toBe("@clientloop go");
  expect(address("@vetrina\n- item one")).toBe("@clientloop - item one");
});

test("testAddressingKeepsALaterMentionAsPartOfTheMessage", () => {
  expect(address("ship it @vetrina")).toBe("@clientloop ship it @vetrina");
});

test("testAddressingReplacesALeadingTokenThatNamesNoOne", () => {
  expect(address("@vetrna hi")).toBe("@clientloop hi");
  expect(address("@ hi")).toBe("@clientloop hi");
  expect(address("@")).toBe("@clientloop ");
});

test("testAddressingPrefixesUnaddressedText", () => {
  expect(address("plain text")).toBe("@clientloop plain text");
  expect(address("")).toBe("@clientloop ");
  expect(address("me@vetrina.dev ok", "vetrina")).toBe("@vetrina me@vetrina.dev ok");
});

test("testUnaddressedDropsALeadingMention", () => {
  expect(unaddress("@vetrina ship it")).toBe("ship it");
  expect(unaddress("@vetrina, ship it")).toBe("ship it");
  expect(unaddress("@vetrina")).toBe("");
});

test("testUnaddressedDropsALaterMentionWithOneSpace", () => {
  expect(unaddress("ship it @vetrina")).toBe("ship it");
  expect(unaddress("ask @vetrina to ship")).toBe("ask to ship");
});

// Every mention that would address the draft goes, not just the first: after the leading one
// leaves, the next becomes the address.
test("testUnaddressedDropsEveryAddressingMention", () => {
  expect(unaddress("@vetrina tell @clientloop hi")).toBe("tell hi");
});

test("testUnaddressedDropsALeadingTokenThatNamesNoOne", () => {
  expect(unaddress("@vetrna hi")).toBe("hi");
  expect(unaddress("@ hi")).toBe("hi");
});

test("testUnaddressedLeavesTextWithoutMentions", () => {
  expect(unaddress("plain text")).toBe("plain text");
  expect(unaddress("me@vetrina.dev ok")).toBe("me@vetrina.dev ok");
});

// MARK: GramView routing (draftAddress, hint(for:), canSend, the pick rule) — desktop tests

const vetrinaA: GramAgent = { from: "vetrina", name: "vetrina", machine: "mac" };
const vetrinaB: GramAgent = { from: "hetzner-1/vetrina", name: "vetrina", machine: "hetzner-1" };
const scout: GramAgent = { from: "trend-scout", name: "trend-scout", machine: "mac" };

test("gramAgents keeps each sender once, most recent first, agents only", () => {
  const found = GramMention.gramAgents(
    [
      { fromAgent: true, from: "hetzner-1/vetrina", name: "vetrina", machine: "hetzner-1" },
      { fromAgent: false, from: "owner", name: "owner", machine: null },
      { fromAgent: true, from: "trend-scout", name: "trend-scout", machine: null },
      { fromAgent: true, from: "hetzner-1/vetrina", name: "vetrina", machine: "hetzner-1" },
    ],
    "mac",
  );
  expect(found).toEqual([vetrinaB, scout]);
});

test("mentionNames and sharedNames fold case", () => {
  const upper: GramAgent = { from: "VETRINA", name: "VETRINA", machine: null };
  expect(GramMention.mentionNames([vetrinaA, scout, upper])).toEqual(["vetrina", "trend-scout"]);
  expect([...GramMention.sharedNames([vetrinaA, scout, upper])]).toEqual(["vetrina"]);
});

test("draftAddress: no mention is the queue", () => {
  const a = GramMention.draftAddress("ship it @nobody", [vetrinaA], null);
  expect(a.route).toEqual({ kind: "queue" });
  expect(a.body).toBe("ship it @nobody");
  expect(GramMention.draftHint(a.route)).toBeNull();
  expect(GramMention.draftRecipient(a)).toBeNull();
});

test("draftAddress: one agent with the name is that agent, accent on the mention", () => {
  const a = GramMention.draftAddress("@vetrina, ship it", [vetrinaB, scout], null);
  expect(a.route).toEqual({ kind: "agent", agent: vetrinaB });
  expect(a).toMatchObject({ body: "ship it", leading: true, accent: { start: 0, end: 8 } });
  expect(GramMention.draftRecipient(a)).toBe("hetzner-1/vetrina"); // the full routing name
});

test("draftAddress: a shared name is ambiguous unless picked", () => {
  const agents = [vetrinaA, vetrinaB];
  const a = GramMention.draftAddress("@vetrina hi", agents, null);
  expect(a.route).toEqual({ kind: "ambiguous", name: "vetrina" });
  expect(a.accent).toBeNull();
  expect(GramMention.draftHint(a.route)).toBe("Several agents are called vetrina: pick one");
  expect(GramMention.canSendDraft(a, true)).toBe(false);
  const picked = GramMention.draftAddress("@VETRINA hi", agents, vetrinaB);
  expect(picked.route).toEqual({ kind: "agent", agent: vetrinaB });
});

test("draftAddress: a leading unknown token is held, even before a known mention", () => {
  const a = GramMention.draftAddress("@nobody @vetrina hi", [vetrinaA], null);
  expect(a.route).toEqual({ kind: "unknown", token: "nobody" });
  expect(a.leading).toBe(false);
  expect(GramMention.draftHint(a.route)).toBe("No agent called @nobody in Gram");
  expect(GramMention.canSendDraft(a, true)).toBe(false);
  const bare = GramMention.draftAddress("@ hi", [vetrinaA], null);
  expect(GramMention.draftHint(bare.route)).toBe("Pick an agent after @");
});

test("canSendDraft: a bare mention needs a file", () => {
  const a = GramMention.draftAddress("@vetrina  ", [vetrinaA], null);
  expect(GramMention.canSendDraft(a, false)).toBe(false);
  expect(GramMention.canSendDraft(a, true)).toBe(true);
  const queue = GramMention.draftAddress("  \n ", [vetrinaA], null);
  expect(GramMention.canSendDraft(queue, false)).toBe(false);
  expect(GramMention.canSendDraft(GramMention.draftAddress("hi", [], null), false)).toBe(true);
});

test("pickStillHolds while the addressing mention names the pick", () => {
  const agents = [vetrinaA, vetrinaB];
  expect(GramMention.pickStillHolds("@Vetrina hi", agents, vetrinaB)).toBe(true);
  expect(GramMention.pickStillHolds("ask @vetrina", agents, vetrinaB)).toBe(true);
  expect(GramMention.pickStillHolds("@vetrin hi", agents, vetrinaB)).toBe(false);
  expect(GramMention.pickStillHolds("@trend-scout hi", [...agents, scout], vetrinaB)).toBe(false);
});
