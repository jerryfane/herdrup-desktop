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

// Mirror is the account's hosts as last pulled, and the revision to pull
// from next. A full pull replaces it; an incremental one patches it.
type Mirror struct {
	Rev   int64        `json:"rev"`
	Hosts []RemoteHost `json:"hosts"`
}

// Apply folds a pull into the mirror.
func (m Mirror) Apply(p Pull) Mirror {
	live, deleted := RemoteHosts(p.Items)
	byID := map[string]RemoteHost{}
	if !p.Full {
		for _, h := range m.Hosts {
			byID[h.ID] = h
		}
	}
	for _, id := range deleted {
		delete(byID, id)
	}
	for _, h := range live {
		byID[h.ID] = h
	}
	out := Mirror{Rev: p.Rev}
	for _, h := range byID {
		out.Hosts = append(out.Hosts, h)
	}
	sort.Slice(out.Hosts, func(i, j int) bool { return out.Hosts[i].Rev < out.Hosts[j].Rev })
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
