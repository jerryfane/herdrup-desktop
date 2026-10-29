package gramstore

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Translated case by case from herdrup Tests/HerdrKitTests/GramFileCacheTests.swift
// at 9876878; each test names its Swift original.

func newCache(t *testing.T) FileCache {
	return FileCache{Root: filepath.Join(t.TempDir(), "gram-downloads")}
}

func read(t *testing.T, p string) []byte {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// testAStoredFileIsFoundAgainWithItsBytesAndName
func TestCacheAStoredFileIsFoundAgain(t *testing.T) {
	c := newCache(t)
	data := []byte("report contents")
	if _, ok := c.StoreData(data, "msg-1", "report.pdf", "application/pdf"); !ok {
		t.Fatal("not stored")
	}
	hit, ok := c.Cached("msg-1")
	if !ok {
		t.Fatal("a file just stored must be found")
	}
	if hit.Name != "report.pdf" || hit.Mime != "application/pdf" || hit.Size != int64(len(data)) || !bytes.Equal(read(t, hit.Path), data) {
		t.Fatalf("hit %+v", hit)
	}
}

// testAMessageNeverDownloadedIsAMiss
func TestCacheANeverDownloadedMessageIsAMiss(t *testing.T) {
	if _, ok := newCache(t).Cached("never-fetched"); ok {
		t.Fatal("hit")
	}
}

// testSameFileNameUnderDifferentMessagesDoesNotCollide
func TestCacheSameNameUnderDifferentMessagesDoesNotCollide(t *testing.T) {
	c := newCache(t)
	a, _ := c.StoreData([]byte("first"), "msg-1", "same.txt", "")
	b, _ := c.StoreData([]byte("second"), "msg-2", "same.txt", "")
	if string(read(t, a.Path)) != "first" || string(read(t, b.Path)) != "second" {
		t.Fatal("one name overwrote the other")
	}
}

// testStoringAgainReplacesTheEarlierCopyRatherThanAccumulating
func TestCacheStoringAgainReplacesTheEarlierCopy(t *testing.T) {
	c := newCache(t)
	c.StoreData([]byte("old"), "msg-1", "old-name.txt", "")
	c.StoreData([]byte("new bytes"), "msg-1", "new-name.txt", "")
	des, err := os.ReadDir(filepath.Join(c.Dir("msg-1"), "payload"))
	if err != nil || len(des) != 1 || des[0].Name() != "new-name.txt" {
		t.Fatalf("payloads %v, %v", des, err)
	}
	hit, ok := c.Cached("msg-1")
	if !ok || hit.Name != "new-name.txt" || string(read(t, hit.Path)) != "new bytes" {
		t.Fatalf("hit %+v %v", hit, ok)
	}
}

// testRemovingAMessageDropsItsBytes
func TestCacheRemovingAMessageDropsItsBytes(t *testing.T) {
	c := newCache(t)
	c.StoreData([]byte("x"), "msg-1", "f.txt", "")
	c.Remove("msg-1")
	if _, ok := c.Cached("msg-1"); ok {
		t.Fatal("still cached")
	}
	if _, err := os.Stat(c.Dir("msg-1")); !os.IsNotExist(err) {
		t.Fatalf("directory left: %v", err)
	}
}

// testAnIdContainingPathSeparatorsCannotEscapeTheCacheRoot
func TestCacheAHostileIDCannotEscapeTheRoot(t *testing.T) {
	c := newCache(t)
	hostile := "../../etc/passwd"
	dir := c.Dir(hostile)
	if filepath.Dir(dir) != c.Root || filepath.Base(dir) != Key(hostile) || strings.Contains(filepath.Base(dir), ".") {
		t.Fatalf("entry dir %s", dir)
	}
	c.StoreData([]byte("x"), hostile, "p.txt", "")
	hit, ok := c.Cached(hostile)
	if !ok || !strings.HasPrefix(hit.Path, c.Root+string(filepath.Separator)) {
		t.Fatalf("hit %+v", hit)
	}
}

// testTotalBytesCountsThePayloadNotTheMetadata
func TestCacheTotalBytesCountsThePayload(t *testing.T) {
	c := newCache(t)
	chunk := bytes.Repeat([]byte{0x41}, 4<<10)
	c.StoreData(chunk, "one", "one.bin", "")
	c.StoreData(chunk, "two", "two.bin", "")
	if got := c.TotalBytes(); got != 8<<10 {
		t.Fatalf("total %d", got)
	}
}

// testEvictionKeepsTheCacheUnderItsCeiling
func TestCacheEvictionKeepsUnderTheCeiling(t *testing.T) {
	c := newCache(t)
	c.MaxBytes = 10 << 10
	chunk := bytes.Repeat([]byte{0x41}, 4<<10)
	for _, id := range []string{"one", "two", "three"} {
		c.StoreData(chunk, id, id+".bin", "")
	}
	if got := c.TotalBytes(); got > 10<<10 || got == 0 {
		t.Fatalf("total %d", got)
	}
}

// testTheMostRecentlyOpenedEntrySurvivesEviction
func TestCacheTheMostRecentlyOpenedEntrySurvives(t *testing.T) {
	c := newCache(t)
	c.MaxBytes = 10 << 10
	chunk := bytes.Repeat([]byte{0x42}, 4<<10)
	c.StoreData(chunk, "one", "one.bin", "")
	c.StoreData(chunk, "two", "two.bin", "")
	touch := func(id string, at time.Time) {
		if err := os.Chtimes(c.Dir(id), at, at); err != nil {
			t.Fatal(err)
		}
	}
	touch("two", time.Unix(1000, 0))
	touch("one", time.Unix(2000, 0))
	c.StoreData(chunk, "three", "three.bin", "")
	if _, ok := c.Cached("one"); !ok {
		t.Error("the entry just opened was evicted")
	}
	if _, ok := c.Cached("two"); ok {
		t.Error("the least recently used entry survived")
	}
}

// Cached touches the entry it returns (the half of the LRU the test above
// sets by hand).
func TestCacheALookupTouchesTheEntry(t *testing.T) {
	c := newCache(t)
	c.StoreData([]byte("x"), "one", "one.bin", "")
	old := time.Unix(1000, 0)
	_ = os.Chtimes(c.Dir("one"), old, old)
	c.Cached("one")
	st, _ := os.Stat(c.Dir("one"))
	if !st.ModTime().After(old) {
		t.Fatal("a hit did not touch its entry")
	}
}

// testAFileLargerThanTheWholeBudgetIsNotCached
func TestCacheAFileOverTheWholeBudgetIsNotCached(t *testing.T) {
	c := newCache(t)
	c.MaxBytes = 4 << 10
	if _, ok := c.StoreData(bytes.Repeat([]byte{0x43}, 8<<10), "huge", "huge.bin", ""); ok {
		t.Error("stored")
	}
	if _, ok := c.Cached("huge"); ok {
		t.Error("cached")
	}
}

// testEmptyBytesAreNotCached
func TestCacheEmptyBytesAreNotCached(t *testing.T) {
	c := newCache(t)
	if _, ok := c.StoreData(nil, "empty", "e.txt", ""); ok {
		t.Error("stored")
	}
	if _, ok := c.Cached("empty"); ok {
		t.Error("cached")
	}
}

// testIdsThatDifferOnlyInPunctuationOrLengthStayDistinct
func TestCacheIDsDifferingInPunctuationStayDistinct(t *testing.T) {
	c := newCache(t)
	list := []string{"msg/1", "msg.1", "msg 1", "msg:1", "msg+1", "msg_1",
		strings.Repeat("a", 130) + "X", strings.Repeat("a", 130) + "Y"}
	keys := map[string]bool{}
	for i, id := range list {
		c.StoreData([]byte("payload-"+strconv.Itoa(i)), id, "f.txt", "")
		keys[Key(id)] = true
	}
	if len(keys) != len(list) {
		t.Fatal("two ids share a key")
	}
	for i, id := range list {
		hit, ok := c.Cached(id)
		if !ok || string(read(t, hit.Path)) != "payload-"+strconv.Itoa(i) {
			t.Fatalf("%s: %+v %v", id, hit, ok)
		}
	}
}

// testAnEntryWithoutMetadataIsAMiss
func TestCacheAnEntryWithoutMetadataIsAMiss(t *testing.T) {
	c := newCache(t)
	c.StoreData([]byte("complete"), "msg-1", "f.txt", "")
	if err := os.Remove(filepath.Join(c.Dir("msg-1"), "meta.json")); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Cached("msg-1"); ok {
		t.Fatal("a half-written entry was served")
	}
}

// testATruncatedPayloadIsNotServed
func TestCacheATruncatedPayloadIsNotServed(t *testing.T) {
	c := newCache(t)
	c.StoreData(bytes.Repeat([]byte{0x41}, 4096), "msg-1", "f.bin", "")
	hit, _ := c.Cached("msg-1")
	if err := os.WriteFile(hit.Path, bytes.Repeat([]byte{0x41}, 10), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.Cached("msg-1"); ok {
		t.Fatal("a truncated payload was served")
	}
}

// testRemoveAllClearsEveryEntry
func TestCacheRemoveAllClearsEveryEntry(t *testing.T) {
	c := newCache(t)
	c.StoreData([]byte("a"), "one", "a.txt", "")
	c.StoreData([]byte("b"), "two", "b.txt", "")
	c.RemoveAll()
	_, one := c.Cached("one")
	_, two := c.Cached("two")
	if one || two || c.TotalBytes() != 0 {
		t.Fatal("entries left")
	}
}

// testAnAttachmentNamedLikeTheMetadataStillRoundTrips
func TestCacheAnAttachmentNamedMetaJSONRoundTrips(t *testing.T) {
	c := newCache(t)
	data := []byte("the real attachment")
	if _, ok := c.StoreData(data, "msg-1", "meta.json", "application/json"); !ok {
		t.Fatal("not stored")
	}
	hit, ok := c.Cached("msg-1")
	if !ok || hit.Name != "meta.json" || !bytes.Equal(read(t, hit.Path), data) {
		t.Fatalf("hit %+v %v", hit, ok)
	}
}

// GramFileCache.store(movingFile:) and keep: a moved file is gone from its
// source; a copy (the desk's own upload) leaves the source alone.
func TestCacheStoreMovingAndCopy(t *testing.T) {
	c := newCache(t)
	src := filepath.Join(t.TempDir(), "up.bin")
	if err := os.WriteFile(src, []byte("uploaded"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.StoreCopy(src, "msg-1", "up.bin", "application/octet-stream"); !ok {
		t.Fatal("copy not stored")
	}
	if string(read(t, src)) != "uploaded" {
		t.Fatal("the copy moved the source")
	}
	if hit, ok := c.Cached("msg-1"); !ok || string(read(t, hit.Path)) != "uploaded" {
		t.Fatal("copy not found")
	}
	if _, ok := c.StoreMoving(src, "msg-2", "up.bin", ""); !ok {
		t.Fatal("move not stored")
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatal("a moved file is still at its source")
	}
	if hit, ok := c.Cached("msg-2"); !ok || string(read(t, hit.Path)) != "uploaded" {
		t.Fatal("move not found")
	}
}

// GramStagingTests.swift testTraversalNameStaysInsideTheItemDirectory, and
// the rest of safeFileName's contract.
func TestSafeFileName(t *testing.T) {
	for in, want := range map[string]string{
		"../../etc/passwd": "passwd",
		"report.pdf":       "report.pdf",
		"a/b/":             "b",
		`dir\file.txt`:     "dir_file.txt",
		"  spaced.txt  ":   "spaced.txt",
		"..":               "file",
		".":                "file",
		"":                 "file",
		"/":                "file",
	} {
		if got := SafeFileName(in); got != want {
			t.Errorf("SafeFileName(%q) = %q, want %q", in, got, want)
		}
	}
}
