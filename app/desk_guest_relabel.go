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
// profile has one, given at load to those without), never by its address.
// It names its machine by the profile snapshot it was started with until
// its connection's first list reads the profile as saved then (a change
// saved while it was starting included); a label change of that profile
// while connected, its destination unchanged, moves it on. A profile moved
// to another destination is relabeled there on its next connect.

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
// in an older build's relabel queue: each saved profile it names takes a
// revision of now at least, so its label goes on its next connect. changed
// reports st to store; queued, the queue to delete once st is stored (an
// entry of no saved profile is dropped with it). A queue that can't be read
// is left for the next load; folding it again only raises revisions.
// d.storeMu must be held.
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
		if m := &st.Machines[i]; entries[m.LocalID] != nil && m.LabelRev < now {
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

// relabelOnConnect renews l's label from its profile as saved now and sends
// it, on its SSH connection's first list. d.mu must be held.
func (d *Desk) relabelOnConnect(l *link) {
	l.work.Go(func() { d.relabelConnected(l) })
}

// relabelConnected reads l's profile as saved now: unless it is gone or
// names another destination, the link names the machine by it (what an
// invite opened from now on carries) and, to a herdr reporting
// guest_relabel_rev, its label goes at its revision.
func (d *Desk) relabelConnected(l *link) {
	d.storeMu.Lock()
	st, err := d.load()
	d.storeMu.Unlock()
	if err != nil {
		log.Printf("guest relabel: %s: %v", l.id, err)
		return
	}
	i := st.findProfile(l.profile)
	if i < 0 || machineID(st.Machines[i]) != l.id {
		return
	}
	label, rev := inviteLabel(st.Machines[i]), st.Machines[i].LabelRev
	d.mu.Lock()
	if rev >= l.shareLabelRev { // a rename saved since is already newer
		l.shareLabel, l.shareLabelRev = label, rev
	}
	caps := l.caps
	d.mu.Unlock()
	if rev > 0 && herdrapi.CapabilityGuestRelabelRev.Supported(caps) {
		d.relabelGuests(l, label, rev)
	}
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

// relabelGuests asks l's herdr to relabel its shares and pending invites
// label: at rev where it reports guest_relabel_rev, else without one.
// Failures are logged; nothing is kept to send again.
func (d *Desk) relabelGuests(l *link, label string, rev uint64) {
	d.mu.Lock()
	c, session, caps, ctx := l.client, l.session, l.caps, l.ctx
	d.mu.Unlock()
	if c == nil || ctx == nil || !herdrapi.CapabilityGuestRelabel.Supported(caps) {
		return
	}
	var at *uint64
	if herdrapi.CapabilityGuestRelabelRev.Supported(caps) {
		at = &rev
	}
	view, err := c.ForSession(session)
	if err == nil {
		_, err = engine.New(engine.Bridge(view)).GuestRelabel(ctx, label, at)
	}
	if err != nil && !errors.Is(err, context.Canceled) {
		log.Printf("guest relabel: %s: %q at %d: %v", l.id, label, rev, err)
	}
}
