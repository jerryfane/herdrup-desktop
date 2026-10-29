// Package gramstore holds Gram's client-side state as herdrup keeps it:
// the inbox between loads (HerdrKit GramInbox), the saved copies
// (SavedGramStore), the download cache (GramFileCache), the composer's
// upload line and sender (ComposerUploader, GramAttachmentSender) and the
// attachment chip states (ComposerAttachmentState). None of it talks to
// herdr itself: the desk layer passes answers in and calls out through the
// functions it hands over, so every rule here is tested without a network.
package gramstore

import (
	"maps"
	"reflect"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// Answer is one gram.list answer as the inbox consumes it (herdrup
// GramListAnswer).
type Answer struct {
	// Unchanged is a gram_list_unchanged answer: no messages, NOT an empty
	// inbox.
	Unchanged bool
	// Messages are newest first.
	Messages []herdrapi.GramMessageInfo
	// Digest is "" from a daemon without digests.
	Digest  string
	StoreID string
	HasMore bool
	// UnreadCount is the unread count over the whole store; nil when the
	// daemon sent none (the window is then the whole list).
	UnreadCount *int
}

// FromList is the Answer of a gram.list result: r.List or r.Unchanged.
func FromList(list *herdrapi.ResponseResultGramList, unchanged *herdrapi.ResponseResultGramListUnchanged) Answer {
	if list == nil {
		if unchanged == nil {
			return Answer{Unchanged: true}
		}
		return Answer{Unchanged: true, Digest: unchanged.Digest, StoreID: unchanged.StoreID}
	}
	msgs := list.Messages
	if msgs == nil {
		msgs = []herdrapi.GramMessageInfo{}
	}
	return Answer{Messages: msgs, Digest: list.Digest, StoreID: list.StoreID, HasMore: list.HasMore,
		UnreadCount: new(int(list.UnreadCount))}
}

// BadgeCount is the tab badge's count from an unread_only answer: the
// daemon's whole-store count when it sends one, else the messages it
// returned (herdrup unreadBadgeCount); ok is false for an unchanged answer.
func (a Answer) BadgeCount() (n int, ok bool) {
	if a.UnreadCount != nil {
		return *a.UnreadCount, true
	}
	if a.Unchanged {
		return 0, false
	}
	return len(a.Messages), true
}

// IsUnread reports an agent->owner message the owner has not read.
func IsUnread(m herdrapi.GramMessageInfo) bool {
	return m.Direction == herdrapi.GramDirectionAgentToOwner && !m.ReadByOwner
}

// Inbox is the Gram inbox as held between loads: the last list, plus the
// digest it was answered with (herdrup GramInbox, whose comments explain
// each rule). The zero value is an inbox nothing has loaded into.
type Inbox struct {
	messages  []herdrapi.GramMessageInfo
	digest    string
	storeID   string
	hasLoaded bool
	hasMore   bool
	// generation is bumped whenever the list is replaced, so a page built
	// on an older cursor is refused.
	generation   int
	serverUnread *int
	// readOutsideWindow are ids marked read that the window does not hold,
	// so a second mark cannot decrement the daemon's count twice.
	readOutsideWindow map[string]bool
	readStamp         int
	// localReads are ids read locally, by stamp, until a head answer asked
	// for after the read settles them.
	localReads map[string]int
	// confirmedReads are every read herdr confirmed, by stamp, kept until
	// the store changes: a page asked for before a read can land after a
	// head answer settled it.
	confirmedReads map[string]int
}

// Messages is the held list, newest first. It must not be modified.
func (b *Inbox) Messages() []herdrapi.GramMessageInfo { return b.messages }

// HasLoaded reports whether a full list has ever landed; an empty inbox
// that loaded counts.
func (b *Inbox) HasLoaded() bool { return b.hasLoaded }

// HasMore reports whether older messages remain beyond those loaded.
func (b *Inbox) HasMore() bool { return b.hasMore }

// Generation counts replacements of the list.
func (b *Inbox) Generation() int { return b.generation }

// ReadStamp is the stamp of the last local read; a head request reads it
// before it is sent and hands it back to Apply.
func (b *Inbox) ReadStamp() int { return b.readStamp }

// ConditionalDigest is the digest to send as if_unchanged_digest: only
// while the list it fingerprints is held.
func (b *Inbox) ConditionalDigest() string {
	if !b.hasLoaded {
		return ""
	}
	return b.digest
}

// UnreadCount is the daemon's whole-store count when it sent one, else the
// held list's.
func (b *Inbox) UnreadCount() int {
	if b.serverUnread != nil {
		return *b.serverUnread
	}
	n := 0
	for _, m := range b.messages {
		if IsUnread(m) {
			n++
		}
	}
	return n
}

// NextCursor is the oldest loaded id while older messages remain, else "".
func (b *Inbox) NextCursor() string {
	if !b.hasMore || len(b.messages) == 0 {
		return ""
	}
	return b.messages[len(b.messages)-1].ID
}

func (b *Inbox) index(id string) int {
	for i, m := range b.messages {
		if m.ID == id {
			return i
		}
	}
	return -1
}

// Apply folds in an answer to a head request and reports whether the list
// changed. A changed answer REPLACES the list, deep pages included; an
// unchanged one keeps everything, digest included. asked is ReadStamp as it
// was when the request was sent: a read made after it stays read. Apply
// takes ownership of a.Messages.
func (b *Inbox) Apply(a Answer, asked int) bool {
	if b.storeID != "" && a.StoreID != "" && b.storeID != a.StoreID {
		*b = Inbox{generation: b.generation + 1, readStamp: b.readStamp}
	}
	if a.StoreID != "" {
		b.storeID = a.StoreID
	}
	if a.Unchanged {
		// The digest is deliberately not adopted: a late unchanged reply
		// must not re-arm a digest a local edit cleared.
		return false
	}
	fresh := a.Messages
	unread := a.UnreadCount
	if unread != nil {
		unread = new(*unread)
	}
	heldRead := false
	for id, stamp := range b.localReads {
		if stamp <= asked {
			continue
		}
		if i := indexOf(fresh, id); i >= 0 {
			if !IsUnread(fresh[i]) {
				continue
			}
			fresh[i].ReadByOwner = true
		}
		if unread != nil {
			*unread = max(0, *unread-1)
		}
		heldRead = true
	}
	maps.DeleteFunc(b.localReads, func(_ string, stamp int) bool { return stamp <= asked })
	changed := !sameMessages(fresh, b.messages)
	b.messages = fresh
	if heldRead {
		b.digest = ""
	} else {
		b.digest = a.Digest
	}
	b.hasLoaded = true
	b.serverUnread = unread
	b.hasMore = a.HasMore
	if changed {
		b.generation++
	}
	return changed
}

func indexOf(ms []herdrapi.GramMessageInfo, id string) int {
	for i, m := range ms {
		if m.ID == id {
			return i
		}
	}
	return -1
}

// sameMessages compares two lists as herdrup's Equatable arrays do: an
// empty list equals no list.
func sameMessages(a, b []herdrapi.GramMessageInfo) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !reflect.DeepEqual(a[i], b[i]) {
			return false
		}
	}
	return true
}

// AppendPage folds in an answer to a page request (before_id): older
// messages appended, de-duplicated by id. generation and asked are
// Generation and ReadStamp as they were when the page was asked for: a
// page built before a replacement is dropped, and reads confirmed after it
// was asked for stay read, its whole-store count leaving out those it
// shows unread (herdrup's appendPage adopts the page's flags and count as
// they are). It reports whether the list grew. The digest is never
// adopted.
func (b *Inbox) AppendPage(a Answer, generation, asked int) bool {
	if generation != b.generation {
		return false
	}
	if b.storeID != "" && a.StoreID != "" && b.storeID != a.StoreID {
		return false
	}
	if a.Unchanged || len(a.Messages) == 0 {
		b.hasMore = a.HasMore
		return false
	}
	known := make(map[string]bool, len(b.messages))
	for _, m := range b.messages {
		known[m.ID] = true
	}
	var unread *int
	if a.UnreadCount != nil {
		unread = new(*a.UnreadCount)
	}
	// herdr's count is the whole store's when it built the page. Only a
	// read the page itself shows unread is known to be missing from it; a
	// read of a message outside the page may already be counted (herdr
	// applied it before building the page), so herdr's number stands.
	// A changed count invalidates the head digest below, even if a head
	// refresh settled the read while this page was in flight (#55, #59).
	for id, stamp := range b.confirmedReads {
		if stamp <= asked {
			continue
		}
		i := indexOf(a.Messages, id)
		if i < 0 || !IsUnread(a.Messages[i]) {
			continue
		}
		a.Messages[i].ReadByOwner = true
		if unread != nil {
			*unread = max(0, *unread-1)
		}
	}
	before := len(b.messages)
	for _, m := range a.Messages {
		if !known[m.ID] {
			b.messages = append(b.messages, m)
			known[m.ID] = true
		}
	}
	b.hasMore = a.HasMore
	if unread != nil {
		if b.serverUnread == nil || *b.serverUnread != *unread {
			// The retained head digest does not certify this page's count.
			// Force the next head poll to reconcile it instead of accepting
			// an unchanged reply indefinitely.
			b.digest = ""
		}
		b.serverUnread = unread
	}
	b.hasLoaded = true
	return len(b.messages) > before
}

// Remove drops a message the owner deleted and clears the digest. An id
// not held changes nothing.
func (b *Inbox) Remove(id string) {
	i := b.index(id)
	if i < 0 {
		return
	}
	if IsUnread(b.messages[i]) && b.serverUnread != nil {
		*b.serverUnread = max(0, *b.serverUnread-1)
	}
	b.messages = append(b.messages[:i:i], b.messages[i+1:]...)
	b.digest = ""
}

// MarkRead marks a message read once herdr confirmed gram.mark_read. An id
// the window does not hold still moves the count, once.
func (b *Inbox) MarkRead(id string) {
	if i := b.index(id); i >= 0 {
		if !IsUnread(b.messages[i]) {
			return
		}
		b.messages[i].ReadByOwner = true
	} else {
		if b.readOutsideWindow[id] {
			return
		}
		if b.readOutsideWindow == nil {
			b.readOutsideWindow = map[string]bool{}
		}
		b.readOutsideWindow[id] = true
	}
	if b.serverUnread != nil {
		*b.serverUnread = max(0, *b.serverUnread-1)
	}
	b.digest = ""
	b.readStamp++
	if b.localReads == nil {
		b.localReads, b.confirmedReads = map[string]int{}, map[string]int{}
	}
	b.localReads[id] = b.readStamp
	b.confirmedReads[id] = b.readStamp
}
