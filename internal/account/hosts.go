package account

import (
	"cmp"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The hosts collection's limits, in code points (AccountService
// src/sync.ts SCHEMAS.hosts, design §5.1).
const (
	maxHostNickname = 64
	maxHostHost     = 253
	maxHostUsername = 64
	maxHostLabel    = 64
)

// Check reports whether the service takes b as a hosts item, by its rules:
// every text valid UTF-8 without a control character (Cc); nickname and
// label at most 64 code points; host 1–253 with no white space; username
// 1–64; port none (0) or 1–65535; auth kind none, key or password. Host
// sync and pair-v1's machine list both hold machines to it.
func (b HostBody) Check() error {
	text := func(field, s string, required bool, max int) error {
		switch {
		case !utf8.ValidString(s) || strings.ContainsFunc(s, unicode.IsControl):
			return fmt.Errorf("machine %s %q has a control character", field, s)
		case required && s == "":
			return fmt.Errorf("machine %s is empty", field)
		case utf8.RuneCountInString(s) > max:
			return fmt.Errorf("machine %s is over %d characters", field, max)
		}
		return nil
	}
	return errors.Join(
		text("nickname", b.Nickname, false, maxHostNickname),
		text("host", b.Host, true, maxHostHost),
		text("username", b.Username, true, maxHostUsername),
		text("label", b.Label, false, maxHostLabel),
		func() error {
			switch {
			case strings.ContainsFunc(b.Host, func(r rune) bool { return unicode.IsSpace(r) || r == '\uFEFF' }):
				// JavaScript's \s, which the service tests, has U+FEFF too.
				return fmt.Errorf("machine host %q has a space", b.Host)
			case b.Port < 0 || b.Port > 65535:
				return fmt.Errorf("machine port %d", b.Port)
			case b.AuthKind != "" && b.AuthKind != "key" && b.AuthKind != "password":
				return fmt.Errorf("machine auth kind %q", b.AuthKind)
			}
			return nil
		}(),
	)
}

// HostIdentity is what makes two saved machines the same machine across
// devices (design #698 §5.5, the rule iOS uses too): the username exactly as
// typed, the host lowercased without a trailing dot, the port with 22 for
// none. Nickname, label and auth kind are not part of it.
type HostIdentity struct {
	Username string
	Host     string
	Port     int
}

func IdentityOf(b HostBody) HostIdentity {
	port := b.Port
	if port == 0 {
		port = 22
	}
	return HostIdentity{Username: b.Username, Host: strings.TrimSuffix(strings.ToLower(b.Host), "."), Port: port}
}

// LocalHost is one saved machine as the merge sees it: its sync id ("" when
// it has none yet), its synced fields, and whether they were edited here
// since this device last agreed them with the account.
type LocalHost struct {
	SyncID string
	Body   HostBody
	Edited bool
}

// RemoteHost is a live (not deleted) hosts item.
type RemoteHost struct {
	ID   string
	Rev  int64
	Body HostBody
}

// HostsPlan is what a merge decides.
type HostsPlan struct {
	// Adopt maps a local machine (by index) to the account's id for it.
	Adopt map[int]string
	// Push are local machines to write to the account, with their id: new
	// ones, and ones whose earlier push was never acknowledged.
	Push map[int]string
	// Delete are account items that fork a machine another item already
	// holds (the higher rev of two with one identity): tombstone them.
	Delete []string
	// Gone are local machines the account deleted: their id was in the
	// account (known) and no longer is.
	Gone []int
}

// PlanHosts merges the account's hosts (the whole mirror) into the local
// machines (design #698 §5.5, the same rule as iOS). known are the ids the
// account is known to have held: the mirror before this pull, and ids it
// sent tombstones for.
//   - forks: of two account items with one identity, the lower rev is kept
//     and the other deleted; a machine on the deleted one moves to the kept;
//   - a machine whose id the account holds is that item, whatever its host
//     or user now (a rename on either side is an edit, not a delete);
//   - a machine otherwise matching an item's identity takes its id, the
//     account's id winning over a different local one;
//   - a machine whose id the account held and doesn't now was deleted
//     elsewhere, unless it was edited here since: then the edit stands and
//     is pushed again, as is a machine whose id the account never
//     acknowledged; one without an id gets a new one to push.
func PlanHosts(local []LocalHost, mirror []RemoteHost, known map[string]bool) (HostsPlan, error) {
	plan := HostsPlan{Adopt: map[int]string{}, Push: map[int]string{}}
	sorted := append([]RemoteHost(nil), mirror...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Rev < sorted[j].Rev })
	byIdentity := map[HostIdentity]string{}
	kept := map[string]bool{}
	forkOf := map[string]string{} // deleted fork member -> kept item
	for _, r := range sorted {
		id := IdentityOf(r.Body)
		if keep, ok := byIdentity[id]; ok {
			plan.Delete = append(plan.Delete, r.ID)
			forkOf[r.ID] = keep
			continue
		}
		byIdentity[id] = r.ID
		kept[r.ID] = true
	}
	claimed := map[string]bool{}
	matched := make([]bool, len(local))
	// By id first: the account's item is this machine even after a rename.
	for i, l := range local {
		target := l.SyncID
		if keep, ok := forkOf[target]; ok {
			target = keep
		}
		if target == "" || !kept[target] || claimed[target] {
			continue
		}
		claimed[target], matched[i] = true, true
		if target != l.SyncID {
			plan.Adopt[i] = target
		}
	}
	for i, l := range local {
		if matched[i] {
			continue
		}
		if id, ok := byIdentity[IdentityOf(l.Body)]; ok && !claimed[id] {
			claimed[id] = true
			if id != l.SyncID {
				plan.Adopt[i] = id
			}
			continue
		}
		switch {
		case l.SyncID != "" && known[l.SyncID] && !l.Edited:
			plan.Gone = append(plan.Gone, i)
		case l.SyncID != "":
			plan.Push[i] = l.SyncID
		default:
			id, err := NewHostID()
			if err != nil {
				return HostsPlan{}, err
			}
			plan.Push[i] = id
		}
	}
	return plan, nil
}

// Mirror is the account's hosts and prompts as last pulled, and the
// revision to pull from next. A full pull replaces it; an incremental one
// patches it.
type Mirror struct {
	Rev     int64          `json:"rev"`
	Hosts   []RemoteHost   `json:"hosts"`
	Prompts []RemotePrompt `json:"prompts,omitempty"`
}

// Tombstones are the items a pull deleted, by collection: id to the
// tombstone's revision (the newest, when the pull holds more). The account
// held each of them.
type Tombstones struct {
	Hosts   map[string]int64
	Prompts map[string]int64
}

// Apply folds a pull into the mirror, in revision order (the pull is
// ordered once for both collections), and returns the pull's tombstones.
func (m Mirror) Apply(p Pull) (Mirror, Tombstones) {
	items := slices.Clone(p.Items)
	slices.SortStableFunc(items, func(a, b Item) int { return cmp.Compare(a.Rev, b.Rev) })
	next, gone := Mirror{Rev: p.Rev}, Tombstones{}
	next.Hosts, gone.Hosts = fold(m.Hosts, p.Full, items, "hosts", hostRow, func(h RemoteHost) (string, int64) { return h.ID, h.Rev })
	next.Prompts, gone.Prompts = fold(m.Prompts, p.Full, items, "prompts", promptRow, func(h RemotePrompt) (string, int64) { return h.ID, h.Rev })
	return next, gone
}

// Adopt makes each conflict's Server row the account's copy of its item,
// whatever the mirror held: the service's answer to changes it turned
// down. nil (no such item) and a tombstone leave the item out. A
// collection no conflict names is left as it is.
func (m Mirror) Adopt(conflicts []Conflict) Mirror {
	m.Hosts = adoptRows(m.Hosts, conflicts, "hosts", hostRow, func(h RemoteHost) string { return h.ID })
	m.Prompts = adoptRows(m.Prompts, conflicts, "prompts", promptRow, func(p RemotePrompt) string { return p.ID })
	return m
}

// adoptRows is Adopt for one collection.
func adoptRows[T any](held []T, conflicts []Conflict, collection string, row func(Item) (T, bool), id func(T) string) []T {
	rows := map[string]*Item{}
	for _, c := range conflicts {
		if c.Collection == collection {
			rows[c.ID] = c.Server
		}
	}
	if len(rows) == 0 {
		return held
	}
	out := slices.DeleteFunc(slices.Clone(held), func(it T) bool { _, ok := rows[id(it)]; return ok })
	for _, it := range rows {
		if it == nil || it.Deleted {
			continue
		}
		if r, ok := row(*it); ok {
			out = append(out, r)
		}
	}
	return out
}

// fold patches one collection's held items with a pull's (all of them when
// full), given in revision order, each replacing the one held: a pull's
// pages are read one at a time, so an item can show live on one page and
// deleted, at a newer revision, on a later one. An item older than the one
// held is skipped; a live one row can't read leaves the held one as it is.
// deleted are the collection's tombstones in the pull, skipped ones too.
func fold[T any](held []T, full bool, items []Item, collection string, row func(Item) (T, bool), key func(T) (string, int64)) (out []T, deleted map[string]int64) {
	deleted = map[string]int64{}
	byID := map[string]T{}
	if !full {
		for _, it := range held {
			id, _ := key(it)
			byID[id] = it
		}
	}
	for _, it := range items {
		if it.Collection != collection {
			continue
		}
		if it.Deleted {
			deleted[it.ID] = it.Rev
		}
		if h, ok := byID[it.ID]; ok {
			if _, rev := key(h); rev > it.Rev {
				continue
			}
		}
		if it.Deleted {
			delete(byID, it.ID)
		} else if r, ok := row(it); ok {
			byID[it.ID] = r
		}
	}
	for _, it := range byID {
		out = append(out, it)
	}
	sort.Slice(out, func(i, j int) bool {
		_, a := key(out[i])
		_, b := key(out[j])
		return a < b
	})
	return out, deleted
}

// NewHostID is a random version-4 UUID, lowercase as the service requires.
func NewHostID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// hostRow reads a live hosts item; one the service wouldn't hold (Check)
// is none.
func hostRow(it Item) (RemoteHost, bool) {
	var b HostBody
	if json.Unmarshal(it.Body, &b) != nil || b.Check() != nil {
		return RemoteHost{}, false
	}
	return RemoteHost{ID: it.ID, Rev: it.Rev, Body: b}, true
}
