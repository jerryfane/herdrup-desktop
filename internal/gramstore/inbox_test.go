package gramstore

import (
	"math"
	"slices"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// Translated case by case from herdrup Tests/HerdrKitTests/GramInboxTests.swift
// at 9876878; each test names its Swift original.

// after is the stamp of a request sent after every local read (herdrup's
// default readStamp: .max).
const after = math.MaxInt

func msg(id string, unread bool) herdrapi.GramMessageInfo {
	return herdrapi.GramMessageInfo{ID: id, Direction: herdrapi.GramDirectionAgentToOwner, From: "trend-scout",
		Text: "hi", CreatedUnixMs: 1750000000000, ReadByOwner: !unread}
}

func msgs(ids ...string) []herdrapi.GramMessageInfo {
	out := make([]herdrapi.GramMessageInfo, 0, len(ids))
	for _, id := range ids {
		out = append(out, msg(id, true))
	}
	return out
}

func answer(m []herdrapi.GramMessageInfo, digest string) Answer {
	return Answer{Unchanged: m == nil, Messages: m, Digest: digest, StoreID: "store-1"}
}

func page(m []herdrapi.GramMessageInfo, hasMore bool, unread *int) Answer {
	return Answer{Messages: m, Digest: "d", StoreID: "store-1", HasMore: hasMore, UnreadCount: unread}
}

func ids(b *Inbox) []string {
	var out []string
	for _, m := range b.Messages() {
		out = append(out, m.ID)
	}
	return out
}

// testUnchangedAnswerKeepsTheMessages
func TestInboxUnchangedAnswerKeepsTheMessages(t *testing.T) {
	var b Inbox
	b.Apply(answer(msgs("g1"), "d1"), after)
	if changed := b.Apply(answer(nil, "d1"), after); changed {
		t.Error("an unchanged answer is not a change")
	}
	if len(b.Messages()) != 1 || !b.HasLoaded() || b.ConditionalDigest() != "d1" {
		t.Fatalf("messages %v loaded %v digest %q", ids(&b), b.HasLoaded(), b.ConditionalDigest())
	}
}

// testUnchangedAnswerNeverReArmsTheDigest
func TestInboxUnchangedAnswerNeverReArmsTheDigest(t *testing.T) {
	var b Inbox
	b.Apply(answer(msgs("g1", "g2"), "d1"), after)
	b.Apply(answer(nil, "d-other"), after)
	if b.ConditionalDigest() != "d1" {
		t.Fatalf("an unchanged reply changed the digest to %q", b.ConditionalDigest())
	}
	b.Remove("g1")
	if b.ConditionalDigest() != "" {
		t.Fatal("remove kept the digest")
	}
	b.Apply(answer(nil, "d1"), after)
	if b.ConditionalDigest() != "" {
		t.Fatal("a late unchanged reply re-armed a digest for the pre-mutation list")
	}
}

// testGenuinelyEmptyInboxCountsAsLoaded
func TestInboxGenuinelyEmptyInboxCountsAsLoaded(t *testing.T) {
	var b Inbox
	if b.HasLoaded() || b.ConditionalDigest() != "" {
		t.Fatal("a fresh inbox has loaded or offers a digest")
	}
	b.Apply(answer([]herdrapi.GramMessageInfo{}, "d-empty"), after)
	if !b.HasLoaded() || len(b.Messages()) != 0 {
		t.Fatal("an empty list is a loaded list")
	}
}

// testDigestIsOnlyOfferedWhileTheListIsHeld
func TestInboxDigestIsOnlyOfferedWhileTheListIsHeld(t *testing.T) {
	var b Inbox
	b.Apply(answer(nil, "d9"), after)
	if b.ConditionalDigest() != "" {
		t.Fatal("an unchanged answer arriving first leaves nothing to validate")
	}
	b.Apply(answer(msgs("g1"), "d1"), after)
	if b.ConditionalDigest() != "d1" {
		t.Fatalf("digest %q", b.ConditionalDigest())
	}
}

// testLocalMutationClearsTheDigest
func TestInboxLocalMutationClearsTheDigest(t *testing.T) {
	var b Inbox
	b.Apply(answer(msgs("g1", "g2"), "d1"), after)
	b.Remove("g1")
	if !slices.Equal(ids(&b), []string{"g2"}) || b.ConditionalDigest() != "" {
		t.Fatalf("after remove: %v digest %q", ids(&b), b.ConditionalDigest())
	}
	b.Apply(answer(msgs("g2"), "d2"), after)
	b.MarkRead("g2")
	if b.ConditionalDigest() != "" {
		t.Fatal("a local mark-read kept the digest")
	}
}

// testRemovingAnUnknownIDLeavesTheDigestIntact
func TestInboxRemovingAnUnknownIDLeavesTheDigestIntact(t *testing.T) {
	var b Inbox
	b.Apply(answer(msgs("g1"), "d1"), after)
	b.Remove("nope")
	if b.ConditionalDigest() != "d1" {
		t.Fatal("removing an unknown id cleared the digest")
	}
}

// testUnreadCountTracksTheWholeList
func TestInboxUnreadCountTracksTheWholeList(t *testing.T) {
	var b Inbox
	b.Apply(answer([]herdrapi.GramMessageInfo{msg("g1", true), msg("g2", true), msg("g3", false)}, "d1"), after)
	if b.UnreadCount() != 2 {
		t.Fatalf("unread %d", b.UnreadCount())
	}
	b.MarkRead("g1")
	if b.UnreadCount() != 1 || !b.Messages()[0].ReadByOwner {
		t.Fatalf("after mark: unread %d, first read %v", b.UnreadCount(), b.Messages()[0].ReadByOwner)
	}
}

// testStoreChangeDropsTheHeldList
func TestInboxStoreChangeDropsTheHeldList(t *testing.T) {
	var b Inbox
	b.Apply(Answer{Messages: msgs("g1"), Digest: "d1", StoreID: "store-1"}, after)
	if changed := b.Apply(Answer{Unchanged: true, Digest: "d1", StoreID: "store-2"}, after); changed {
		t.Error("a store swap reported as a change")
	}
	if len(b.Messages()) != 0 || b.HasLoaded() || b.ConditionalDigest() != "" {
		t.Fatalf("another store's messages kept: %v loaded %v digest %q", ids(&b), b.HasLoaded(), b.ConditionalDigest())
	}
}

// testDaemonWithoutDigestsStillLoads
func TestInboxDaemonWithoutDigestsStillLoads(t *testing.T) {
	var b Inbox
	if !b.Apply(Answer{Messages: msgs("g1")}, after) || !b.HasLoaded() || b.ConditionalDigest() != "" {
		t.Fatalf("loaded %v digest %q", b.HasLoaded(), b.ConditionalDigest())
	}
}

// testChangeReportingDistinguishesContentFromTransfer
func TestInboxChangeReportingDistinguishesContentFromTransfer(t *testing.T) {
	var b Inbox
	if !b.Apply(answer(msgs("g1"), "d1"), after) {
		t.Error("first list not a change")
	}
	if b.Apply(answer(msgs("g1"), "d1"), after) {
		t.Error("re-sending identical messages is not a content change")
	}
	if !b.Apply(answer(msgs("g1", "g2"), "d2"), after) {
		t.Error("a new message not a change")
	}
}

// testAppendingAPageExtendsTheListAndMovesTheCursor
func TestInboxAppendingAPageExtendsTheListAndMovesTheCursor(t *testing.T) {
	var b Inbox
	b.Apply(page(msgs("c", "b"), true, nil), after)
	if b.NextCursor() != "b" {
		t.Fatalf("cursor %q", b.NextCursor())
	}
	b.AppendPage(page(msgs("b", "a"), false, nil), b.Generation(), b.ReadStamp())
	if !slices.Equal(ids(&b), []string{"c", "b", "a"}) || b.HasMore() || b.NextCursor() != "" {
		t.Fatalf("%v more %v cursor %q", ids(&b), b.HasMore(), b.NextCursor())
	}
}

// testChangedHeadAnswerDropsOlderPagesSoDeletionsCannotSurvive
func TestInboxChangedHeadAnswerDropsOlderPages(t *testing.T) {
	var b Inbox
	b.Apply(page(msgs("c", "b"), true, nil), after)
	b.AppendPage(page(msgs("a"), false, nil), b.Generation(), after)
	b.Apply(page(msgs("d", "c", "b"), true, nil), after)
	if !slices.Equal(ids(&b), []string{"d", "c", "b"}) || !b.HasMore() {
		t.Fatalf("%v more %v", ids(&b), b.HasMore())
	}
}

// testUnchangedAnswerKeepsDeepPagesLoaded
func TestInboxUnchangedAnswerKeepsDeepPagesLoaded(t *testing.T) {
	var b Inbox
	b.Apply(page(msgs("c"), true, nil), after)
	b.AppendPage(page(msgs("b", "a"), false, nil), b.Generation(), b.ReadStamp())
	if b.Apply(answer(nil, "d"), after) || !slices.Equal(ids(&b), []string{"c", "b", "a"}) {
		t.Fatalf("%v", ids(&b))
	}
}

// testMarkingReadAnIDOutsideTheWindowStillMovesTheCount
func TestInboxMarkingReadOutsideTheWindowMovesTheCount(t *testing.T) {
	var b Inbox
	b.Apply(page(msgs("c"), true, new(3)), after)
	if b.UnreadCount() != 3 {
		t.Fatalf("unread %d", b.UnreadCount())
	}
	b.MarkRead("older-1")
	if b.UnreadCount() != 2 || b.ConditionalDigest() != "" {
		t.Fatalf("unread %d digest %q", b.UnreadCount(), b.ConditionalDigest())
	}
	b.MarkRead("c")
	if b.UnreadCount() != 1 {
		t.Fatalf("unread %d", b.UnreadCount())
	}
	b.MarkRead("c")
	if b.UnreadCount() != 1 {
		t.Fatal("a second mark of the same loaded id decremented again")
	}
}

// testAPageBuiltBeforeAHeadRefreshIsDropped
func TestInboxAPageBuiltBeforeAHeadRefreshIsDropped(t *testing.T) {
	var b Inbox
	b.Apply(page(msgs("c", "b"), true, nil), after)
	gen := b.Generation()
	b.Apply(page(msgs("d", "c"), true, nil), after)
	if b.AppendPage(page(msgs("a"), false, nil), gen, after) {
		t.Error("a stale page landed")
	}
	if !slices.Equal(ids(&b), []string{"d", "c"}) || b.NextCursor() != "c" {
		t.Fatalf("%v cursor %q", ids(&b), b.NextCursor())
	}
}

// testAPageOfAlreadyKnownMessagesReportsNoGrowth
func TestInboxAPageOfKnownMessagesReportsNoGrowth(t *testing.T) {
	var b Inbox
	b.Apply(page(msgs("c", "b"), true, nil), after)
	if b.AppendPage(page(msgs("c", "b"), true, nil), b.Generation(), after) {
		t.Error("nothing new arrived, yet it grew")
	}
	if !slices.Equal(ids(&b), []string{"c", "b"}) {
		t.Fatalf("%v", ids(&b))
	}
}

// testMarkingReadTwiceOutsideTheWindowDecrementsOnce
func TestInboxMarkingReadTwiceOutsideTheWindowDecrementsOnce(t *testing.T) {
	var b Inbox
	b.Apply(page([]herdrapi.GramMessageInfo{msg("c", false)}, true, new(2)), after)
	b.MarkRead("older-1")
	b.MarkRead("older-1")
	if b.UnreadCount() != 1 {
		t.Fatalf("unread %d", b.UnreadCount())
	}
}

// testAnIdenticalHeadAnswerKeepsAnInFlightPageValid
func TestInboxAnIdenticalHeadAnswerKeepsAnInFlightPageValid(t *testing.T) {
	var b Inbox
	b.Apply(page(msgs("c", "b"), true, nil), after)
	gen := b.Generation()
	if b.Apply(page(msgs("c", "b"), true, nil), after) {
		t.Error("an identical answer reported as a change")
	}
	if !b.AppendPage(page(msgs("a"), false, nil), gen, after) {
		t.Error("the page was still contiguous, so it must land")
	}
	if !slices.Equal(ids(&b), []string{"c", "b", "a"}) {
		t.Fatalf("%v", ids(&b))
	}
}

// testAnOutOfWindowReadSurvivesAHeadRefresh
func TestInboxAnOutOfWindowReadSurvivesAHeadRefresh(t *testing.T) {
	var b Inbox
	b.Apply(page(msgs("c"), true, new(3)), after)
	b.MarkRead("older-1")
	if b.UnreadCount() != 2 {
		t.Fatalf("unread %d", b.UnreadCount())
	}
	b.Apply(page(msgs("d", "c"), true, new(2)), after)
	b.MarkRead("older-1")
	if b.UnreadCount() != 2 {
		t.Fatalf("the re-apply decremented again: %d", b.UnreadCount())
	}
}

// testUnreadCountPrefersTheServerCountOverTheWindow
func TestInboxUnreadCountPrefersTheServerCount(t *testing.T) {
	var b Inbox
	b.Apply(page([]herdrapi.GramMessageInfo{msg("c", false)}, true, new(7)), after)
	if b.UnreadCount() != 7 {
		t.Fatalf("unread %d", b.UnreadCount())
	}
	var unpaged Inbox
	unpaged.Apply(answer([]herdrapi.GramMessageInfo{msg("c", true), msg("b", false)}, "d"), after)
	if unpaged.UnreadCount() != 1 || unpaged.HasMore() {
		t.Fatalf("unpaged unread %d more %v", unpaged.UnreadCount(), unpaged.HasMore())
	}
}

// testAppendingAPageNeverAdoptsItsDigest
func TestInboxAppendingAPageNeverAdoptsItsDigest(t *testing.T) {
	var b Inbox
	head := page(msgs("c"), true, nil)
	head.Digest = "head"
	b.Apply(head, after)
	older := page(msgs("b"), false, nil)
	older.Digest = "page"
	b.AppendPage(older, b.Generation(), after)
	if b.ConditionalDigest() != "head" {
		t.Fatalf("digest %q", b.ConditionalDigest())
	}
}

func counted(m []herdrapi.GramMessageInfo, unread int) Answer {
	return Answer{Messages: m, Digest: "d", StoreID: "store-1", UnreadCount: new(unread)}
}

// testAnswerRequestedBeforeAReadKeepsItRead
func TestInboxAnswerRequestedBeforeAReadKeepsItRead(t *testing.T) {
	var b Inbox
	b.Apply(counted(msgs("a", "b"), 2), after)
	asked := b.ReadStamp()
	b.MarkRead("a")
	b.MarkRead("b")
	if b.UnreadCount() != 0 {
		t.Fatalf("unread %d", b.UnreadCount())
	}
	b.Apply(counted(msgs("a", "b"), 2), asked)
	if b.UnreadCount() != 0 || slices.ContainsFunc(b.Messages(), IsUnread) {
		t.Fatalf("a stale answer undid a confirmed read: %d", b.UnreadCount())
	}
	if b.ConditionalDigest() != "" {
		t.Fatal("the held rows are not what the daemon fingerprinted: the next poll must be unconditional")
	}
}

// testAnswerRequestedAfterAReadWins
func TestInboxAnswerRequestedAfterAReadWins(t *testing.T) {
	var b Inbox
	b.Apply(counted(msgs("a"), 1), after)
	b.MarkRead("a")
	asked := b.ReadStamp()
	b.Apply(counted(msgs("a"), 1), asked)
	if b.UnreadCount() != 1 || !IsUnread(b.Messages()[0]) || b.ConditionalDigest() != "d" {
		t.Fatalf("unread %d digest %q", b.UnreadCount(), b.ConditionalDigest())
	}
	b.Apply(counted(msgs("a"), 1), 0)
	if b.UnreadCount() != 1 {
		t.Fatal("a settled read came back")
	}
}

// testStaleAnswerThatAlreadySawTheReadIsNotCountedTwice
func TestInboxStaleAnswerThatSawTheReadIsNotCountedTwice(t *testing.T) {
	var b Inbox
	b.Apply(counted(msgs("a", "b"), 2), after)
	asked := b.ReadStamp()
	b.MarkRead("a")
	b.Apply(counted([]herdrapi.GramMessageInfo{msg("a", false), msg("b", true)}, 1), asked)
	if b.UnreadCount() != 1 || b.ConditionalDigest() != "d" {
		t.Fatalf("unread %d digest %q", b.UnreadCount(), b.ConditionalDigest())
	}
}

// testStaleAnswerStillCountsReadsOutsideTheWindow
func TestInboxStaleAnswerStillCountsReadsOutsideTheWindow(t *testing.T) {
	var b Inbox
	b.Apply(counted(msgs("a"), 2), after)
	asked := b.ReadStamp()
	b.MarkRead("a")
	b.MarkRead("old")
	if b.UnreadCount() != 0 {
		t.Fatalf("unread %d", b.UnreadCount())
	}
	b.Apply(counted(msgs("a"), 2), asked)
	if b.UnreadCount() != 0 || IsUnread(b.Messages()[0]) || b.ConditionalDigest() != "" {
		t.Fatalf("unread %d digest %q", b.UnreadCount(), b.ConditionalDigest())
	}
	b.Apply(counted([]herdrapi.GramMessageInfo{msg("a", false)}, 0), b.ReadStamp())
	if b.UnreadCount() != 0 || b.ConditionalDigest() != "d" {
		t.Fatalf("unread %d digest %q", b.UnreadCount(), b.ConditionalDigest())
	}
}

// testStaleAnswerCountsAnOutOfWindowReadWithNoLoadedRowMarked
func TestInboxStaleAnswerCountsAnOutOfWindowReadAlone(t *testing.T) {
	var b Inbox
	b.Apply(counted(msgs("a"), 2), after)
	asked := b.ReadStamp()
	b.MarkRead("old")
	if b.UnreadCount() != 1 {
		t.Fatalf("unread %d", b.UnreadCount())
	}
	b.Apply(counted(msgs("a"), 2), asked)
	if b.UnreadCount() != 1 || !IsUnread(b.Messages()[0]) || b.ConditionalDigest() != "" {
		t.Fatalf("unread %d digest %q", b.UnreadCount(), b.ConditionalDigest())
	}
}

// GramUnreadBadgeTests.swift: testPagedAnswerCountsTheDaemonsUnreadTotal,
// testUnpagedAnswerCountsItsMessages, testEmptyAnswerWithZeroUnreadIsZero.
func TestBadgeCount(t *testing.T) {
	if c, ok := page(msgs("gx1", "gx2"), true, new(30)).BadgeCount(); !ok || c != 30 {
		t.Errorf("paged: %d %v, want the daemon's 30", c, ok)
	}
	if c, ok := answer(msgs("gx1", "gx2"), "").BadgeCount(); !ok || c != 2 {
		t.Errorf("unpaged: %d %v, want 2", c, ok)
	}
	if c, ok := page([]herdrapi.GramMessageInfo{}, false, new(0)).BadgeCount(); !ok || c != 0 {
		t.Errorf("empty: %d %v", c, ok)
	}
	if _, ok := answer(nil, "d").BadgeCount(); ok {
		t.Error("an unchanged answer has no count")
	}
}

func TestFromList(t *testing.T) {
	a := FromList(&herdrapi.ResponseResultGramList{Digest: "d", StoreID: "s", HasMore: true, UnreadCount: 4}, nil)
	if a.Unchanged || a.Messages == nil || a.Digest != "d" || a.StoreID != "s" || !a.HasMore || a.UnreadCount == nil || *a.UnreadCount != 4 {
		t.Fatalf("list answer %+v", a)
	}
	u := FromList(nil, &herdrapi.ResponseResultGramListUnchanged{Digest: "d", StoreID: "s"})
	if !u.Unchanged || u.Messages != nil || u.StoreID != "s" {
		t.Fatalf("unchanged answer %+v", u)
	}
}

// #46: a page asked for before reads herdr confirmed (a Read all while
// the sentinel's page was in flight) keeps them read and its whole-store
// count leaves them out; a page asked for after them is herdr's word.
func TestInboxAPageAskedForBeforeConfirmedReadsKeepsThemRead(t *testing.T) {
	var b Inbox
	b.Apply(page(msgs("c"), true, new(3)), after)
	gen, asked := b.Generation(), b.ReadStamp()
	for _, id := range []string{"c", "b", "a"} {
		b.MarkRead(id)
	}
	if b.UnreadCount() != 0 {
		t.Fatalf("unread %d after three reads", b.UnreadCount())
	}
	if !b.AppendPage(page(msgs("b", "a"), false, new(3)), gen, asked) {
		t.Fatal("the page did not land")
	}
	if b.UnreadCount() != 0 || slices.ContainsFunc(b.Messages(), IsUnread) {
		t.Fatalf("a stale page undid confirmed reads: unread %d, %v", b.UnreadCount(), b.Messages())
	}

	var fresh Inbox
	fresh.Apply(page(msgs("c"), true, new(3)), after)
	fresh.MarkRead("older")
	gen, asked = fresh.Generation(), fresh.ReadStamp()
	fresh.AppendPage(page(msgs("b", "a"), false, new(2)), gen, asked)
	if fresh.UnreadCount() != 2 {
		t.Fatalf("a page asked for after the read is herdr's word: unread %d, want 2", fresh.UnreadCount())
	}
}

// #46: a head answer settling a read does not let a page asked for before
// the read bring it back.
func TestInboxASettledReadStillHoldsAgainstAnOlderPage(t *testing.T) {
	var b Inbox
	b.Apply(page(msgs("c"), true, new(2)), after)
	gen, asked := b.Generation(), b.ReadStamp()
	b.MarkRead("old")
	// The next head poll, asked for after the read, settles it; its rows are
	// the same, so the page in flight is still contiguous.
	b.Apply(page(msgs("c"), true, new(1)), b.ReadStamp())
	if b.Generation() != gen {
		t.Fatal("an identical head answer replaced the list")
	}
	b.AppendPage(page(msgs("old"), false, new(2)), gen, asked)
	if b.UnreadCount() != 1 || IsUnread(b.Messages()[1]) {
		t.Fatalf("unread %d, %v", b.UnreadCount(), b.Messages())
	}
}
