package main

// A renamed machine's existing shares (herdr #519, guest_relabel; GAPS.md
// §2 option 0b): guests see the machine by the label its invite carried, kept
// in each share. When the owner renames a saved machine, the desk asks its
// herdr to relabel every active share and pending invite with the new invite
// label (guest.update {machine_label}, no scope: one call), and guests see it
// in their next hello reply.
//
// The saved profile holds all of it: its label (inviteLabel) and that
// label's revision (Machine.LabelRev: a rename's is max(now in unix ms, the
// one before + 1)). The desk keeps no delivery state. A herdr reporting
// guest_relabel_rev (herdr #526) keeps each share's and invite's revision and
// takes a label only above it, so every send is idempotent and ordered there:
// the link's label goes at its revision on every owner connection's first
// list and on every rename of its profile while connected, and duplicates,
// concurrent sends and late replies change nothing. A send left unanswered
// or refused needs nothing: the next connect sends again. A herdr reporting
// only guest_relabel is sent a rename once, while connected, without a
// revision, best effort: one that misses it (not connected, refused,
// unanswered, overtaken by an older one landing late) keeps the old name
// until the next rename. A herdr reporting neither is asked nothing.
//
// The link names its machine by the profile snapshot it was started with
// (link.profile, shareLabel, shareLabelRev): a rename of that profile while
// connected, its destination unchanged, moves them on and sends; a profile
// moved to another destination is sent there on its next connect.
//
// guest-relabels.json, the relabel queue of the builds before #594, is
// deleted where a connection starts: the profile's label goes at its
// revision on that connect anyway.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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

// nextLabelRev is a rename's label revision: now in unix ms, above the one
// before (prev) even if the clock went back.
func nextLabelRev(prev uint64) uint64 {
	return max(uint64(time.Now().UnixMilli()), prev+1)
}

// guestRelabelsPath is guest-relabels.json, the relabel queue of the builds
// before #594, deleted unread (retireRelabelQueue).
func (d *Desk) guestRelabelsPath() string { return filepath.Join(d.dir, "guest-relabels.json") }

// retireRelabelQueue deletes an older build's relabel queue. d.storeMu must
// be held.
func (d *Desk) retireRelabelQueue() {
	if err := os.Remove(d.guestRelabelsPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("guest relabel: removing the older relabel queue: %v", err)
	}
}

// sameProfile reports whether old, the saved profile a save replaces at
// replacing, is the one l was started with: by its local id, or, for a
// link started with a profile that had none, the profile at l's address
// still without one. d.mu must be held.
func sameProfile(l *link, old Machine, replacing string) bool {
	if l == nil || l.guest != nil {
		return false
	}
	if l.profile != "" {
		return old.LocalID == l.profile
	}
	return old.LocalID == "" && replacing == l.id
}

// relabelOnConnect sends l's label at its revision on its first list, to a
// herdr reporting guest_relabel_rev. d.mu must be held.
func (d *Desk) relabelOnConnect(l *link) {
	if !herdrapi.CapabilityGuestRelabelRev.Supported(l.caps) || l.shareLabelRev == 0 {
		return
	}
	label, rev := l.shareLabel, l.shareLabelRev
	l.work.Go(func() { d.relabelGuests(l, label, rev) })
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
