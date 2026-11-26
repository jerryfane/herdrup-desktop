package main

// A renamed machine's existing shares (herdr #519, guest_relabel; GAPS.md
// §2 option 0b): guests see the machine by the label its invite carried, kept
// in each share. When the owner renames a saved machine, the desk asks its
// herdr to relabel every active share and pending invite with the new invite
// label (guest.update {machine_label}, no scope: one call), and guests see it
// in their next hello reply.
//
// The saved profile holds all of it: its label (inviteLabel: its nickname,
// else its host) and that label's revision (Machine.LabelRev: every change
// of the label takes max(now in unix ms, the one before + 1)). The desk
// keeps no delivery state. A herdr reporting guest_relabel_rev (herdr #526)
// keeps each share's and invite's revision and takes a label only above it,
// so every send is idempotent and ordered there: the profile's label goes at
// its revision on each SSH connection's first list and on every label change
// of the profile while connected, and duplicates, concurrent sends and late
// replies change nothing. A send left unanswered or refused needs nothing:
// the next connect sends again. A herdr reporting only guest_relabel is sent
// a label change once, while connected, without a revision, best effort: one
// that misses it (not connected, refused, unanswered, overtaken by an older
// one landing late) keeps the old name until the next change. A herdr
// reporting neither is asked nothing.
//
// A link knows its profile by its local id (link.profile: every saved
// profile has one, given at load to those without and used once stored),
// never by its address; a link started with a profile whose id could not be
// stored yet relabels nothing. It names its machine by the profile snapshot
// it was started with until its SSH connection's first list reads the
// profile as saved then (a change saved while it was starting included),
// before that list's board offers an invite; a label change of that
// profile while connected, its destination unchanged, moves it on. A
// relabel goes by the route of the SSH connection it was scheduled on
// (link.relabelVia: its view, capabilities and lifetime, which a session
// switch keeps), never a later one. A profile moved to another destination
// is relabeled there on its next connect.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// newLocalID is a new profile's Machine.LocalID: 16 random bytes in hex.
func newLocalID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// nextLabelRev is a label change's revision: now in unix ms, above the one
// before (prev) even if the clock went back.
func nextLabelRev(prev uint64) uint64 {
	return max(uint64(time.Now().UnixMilli()), prev+1)
}

// guestRelabelsPath is guest-relabels.json, the relabel queue of the builds
// before #594 (v0.1.0-preview.28: by local id, the label to send), folded
// into the profiles once (tagProfiles), then deleted.
func (d *Desk) guestRelabelsPath() string { return filepath.Join(d.dir, "guest-relabels.json") }

// tagProfiles gives every profile in st without a local id one, and folds
// in an older build's relabel queue: each saved profile it names that has
// no label revision yet takes now, so its label goes on its next connect.
// preview.28 kept no revisions, so a profile with one was folded already
// or renamed since (its label as saved is the newest): folding the queue
// again, after a store its deletion did not follow, changes nothing.
// changed reports st to store; queued, the queue to delete once st is
// stored (an entry of no saved profile is dropped with it). A queue that
// can't be read is left for the next load. d.storeMu must be held.
func (d *Desk) tagProfiles(st *machineStore) (changed, queued bool) {
	for i := range st.Machines {
		if st.Machines[i].LocalID == "" {
			st.Machines[i].LocalID, changed = newLocalID(), true
		}
	}
	data, err := os.ReadFile(d.guestRelabelsPath())
	if errors.Is(err, os.ErrNotExist) {
		return changed, false
	}
	if err != nil {
		log.Printf("guest relabel: reading the older relabel queue: %v", err)
		return changed, false
	}
	var entries map[string]json.RawMessage
	if err := json.Unmarshal(data, &entries); err != nil {
		log.Printf("guest relabel: the older relabel queue is unreadable, dropped: %v", err)
		return changed, true
	}
	now := uint64(time.Now().UnixMilli())
	for i := range st.Machines {
		if m := &st.Machines[i]; entries[m.LocalID] != nil && m.LabelRev == 0 {
			m.LabelRev, changed = now, true
		}
	}
	return changed, true
}

// retireRelabelQueue deletes an older build's relabel queue. d.storeMu must
// be held.
func (d *Desk) retireRelabelQueue() {
	if err := os.Remove(d.guestRelabelsPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("guest relabel: removing the older relabel queue: %v", err)
	}
}

// sameProfile reports whether old, the saved profile a save replaces, is
// the one l was started with. d.mu must be held.
func sameProfile(l *link, old Machine) bool {
	return l != nil && l.guest == nil && l.profile != "" && old.LocalID == l.profile
}

// renewLabel reads l's profile as saved now: unless the link has no stored
// profile, or it is gone or names another destination, or ctx (the watch)
// ends while the store is busy (false), the link names the machine by it
// (what an invite opened from now on carries), a rename saved since aside.
func (d *Desk) renewLabel(ctx context.Context, l *link) bool {
	if !d.storeMu.LockCtx(ctx) {
		return false
	}
	defer d.storeMu.Unlock()
	st, err := d.load()
	if err != nil {
		log.Printf("guest relabel: %s: %v", l.id, err)
		return false
	}
	i := st.findProfile(l.profile)
	if i < 0 || machineID(st.Machines[i]) != l.id {
		return false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if rev := st.Machines[i].LabelRev; rev >= l.shareLabelRev {
		l.shareLabel, l.shareLabelRev = inviteLabel(st.Machines[i]), rev
	}
	return true
}

// findProfile is the index of the saved profile localID, -1 if none.
func (s *machineStore) findProfile(localID string) int {
	for i, m := range s.Machines {
		if localID != "" && m.LocalID == localID {
			return i
		}
	}
	return -1
}

// relabelRoute is what a relabel goes by: the session view of the SSH
// connection whose list reported caps, and that connection's lifetime
// (ctx). The zero route goes nowhere.
type relabelRoute struct {
	view *bridge.Client
	caps *herdrapi.ServerCapabilities
	ctx  context.Context
}

// relabelLocked schedules label at rev by l's route as it is now, so the
// send goes over that connection or not at all, whatever replaces it.
// d.mu must be held.
func (d *Desk) relabelLocked(l *link, label string, rev uint64) {
	route := l.relabelVia
	l.relabels.Add(1)
	if !l.work.Go(func() {
		defer l.relabels.Add(-1)
		d.relabelGuests(l.id, route, label, rev)
	}) {
		l.relabels.Add(-1)
	}
}

// relabelGuests asks the herdr of route to relabel its shares and pending
// invites label: at rev where it reports guest_relabel_rev, else without
// one. Failures are logged; nothing is kept to send again.
func (d *Desk) relabelGuests(id string, route relabelRoute, label string, rev uint64) {
	if route.view == nil || route.ctx == nil || route.ctx.Err() != nil || !herdrapi.CapabilityGuestRelabel.Supported(route.caps) {
		return
	}
	var at *uint64
	if herdrapi.CapabilityGuestRelabelRev.Supported(route.caps) {
		at = &rev
	}
	_, err := engine.New(engine.Bridge(route.view)).GuestRelabel(route.ctx, label, at)
	if err != nil && !errors.Is(err, context.Canceled) {
		log.Printf("guest relabel: %s: %q at %d: %v", id, label, rev, err)
	}
}
