package account

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

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
// it has none yet) and its synced fields.
type LocalHost struct {
	SyncID string
	Body   HostBody
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
//     elsewhere; one whose id it never acknowledged is pushed again; one
//     without an id gets a new one to push.
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
		case l.SyncID != "" && known[l.SyncID]:
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

// Apply folds a pull into the mirror.
func (m Mirror) Apply(p Pull) Mirror {
	hosts, goneHosts := RemoteHosts(p.Items)
	prompts, gonePrompts := RemotePrompts(p.Items)
	return Mirror{
		Rev:     p.Rev,
		Hosts:   fold(m.Hosts, p.Full, hosts, goneHosts, func(h RemoteHost) (string, int64) { return h.ID, h.Rev }),
		Prompts: fold(m.Prompts, p.Full, prompts, gonePrompts, func(h RemotePrompt) (string, int64) { return h.ID, h.Rev }),
	}
}

// fold patches one collection's items with a pull's (all of them when
// full), oldest revision first.
func fold[T any](held []T, full bool, live []T, deleted []string, key func(T) (string, int64)) []T {
	byID := map[string]T{}
	if !full {
		for _, it := range held {
			id, _ := key(it)
			byID[id] = it
		}
	}
	for _, id := range deleted {
		delete(byID, id)
	}
	for _, it := range live {
		id, _ := key(it)
		byID[id] = it
	}
	var out []T
	for _, it := range byID {
		out = append(out, it)
	}
	sort.Slice(out, func(i, j int) bool {
		_, a := key(out[i])
		_, b := key(out[j])
		return a < b
	})
	return out
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

// RemoteHosts splits pulled hosts items into live ones and deleted ids.
func RemoteHosts(items []Item) (live []RemoteHost, deleted []string) {
	for _, it := range items {
		if it.Collection != "hosts" {
			continue
		}
		if it.Deleted {
			deleted = append(deleted, it.ID)
			continue
		}
		var b HostBody
		if json.Unmarshal(it.Body, &b) != nil || b.Host == "" || b.Username == "" {
			continue
		}
		live = append(live, RemoteHost{ID: it.ID, Rev: it.Rev, Body: b})
	}
	return live, deleted
}
