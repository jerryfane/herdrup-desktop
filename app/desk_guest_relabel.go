package main

// A renamed machine's existing shares (herdr #519, guest_relabel; GAPS.md
// §2 option 0b): guests see the machine by the label its invite carried, kept
// in each share. When the owner renames a saved machine, the desk asks its
// herdr to relabel every active share and pending invite with the new invite
// label (guest.update {machine_label}, no scope: one call), and guests see it
// in their next hello reply.
//
// The saved profile holds the label (inviteLabel: its nickname, else its
// host) and that label's revision (Machine.LabelRev: every change of the
// label takes max(now in unix ms, the one before + 1)). One path,
// publishLabel, takes it to the live link and its guests, whatever the
// trigger: the SSH connection's first list, a save, the saved machines
// becoming durable again (Desk.settle), an invite of the machine. It reads
// the profile as saved, by the link's local id and at its destination; the
// link shows that label (what an invite carries, never a view's snapshot);
// and one above what herdr has taken on this connection (link.sentRev,
// from 0 at each connect) is sent. A herdr reporting guest_relabel_rev
// (herdr #526) keeps each share's and invite's revision and takes a label
// only above it, so every send is idempotent and ordered there:
// duplicates, concurrent sends and late replies change nothing, and one
// left unanswered or refused stays owed until the next publishLabel or
// connect. A herdr reporting only guest_relabel is sent a label change
// once, while connected, without a revision, best effort, and nothing on
// connect. A herdr reporting neither is asked nothing.
//
// A revision reaches herdr, by a relabel or an invite, only once the file
// holding it is durable (Desk.undurable: a store or folder sync that fully
// succeeded since start): one a crash could take back, the clock gone back
// since, would let herdr refuse the next rename's. Until then the send stays
// owed and no invite of the machine opens (errShareUndurable).
//
// A link knows its profile by its local id (link.profile: every saved
// profile has one, given at load to those without and used once stored),
// never by its address. A link started with a profile whose id could not
// be stored has none for its run: it relabels nothing and opens no invite
// of its own machine until the next connect, started from a stored one.
// (Its first list doesn't take the id stored since for the profile at its
// address: account sync may have put another profile there, just as
// id-less.) A relabel goes by the route of the SSH connection it was
// scheduled on (link.relabelVia: its view, capabilities and lifetime, which
// a session switch keeps), never a later one. A profile moved to another
// destination is relabeled there on its next connect.

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
// durable (an entry of no saved profile is dropped with it). A queue that
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

// shownLabel is the label a link names its machine by, at its revision.
type shownLabel struct {
	label string
	rev   uint64
}

// errShareUnread is why no invite of the machine opens while its saved
// profile can't be read: its label may be stale.
var errShareUnread = errors.New("Couldn't read this machine's settings. Try sharing again in a moment.")

// publishLabel is the one way the live link's label reaches its guests: on its
// SSH connection's first list (firstList), a save, sharing resuming once
// the saved machines are durable (Desk.settle), and an invite of its
// machine. want, when not nil, is the link the caller saw: any other is
// ErrSessionChanged. See publishLabelLocked; ctx ends the wait for the store.
func (d *Desk) publishLabel(ctx context.Context, want *link, firstList bool) (shownLabel, error) {
	if !d.storeMu.LockCtx(ctx) {
		return shownLabel{}, ctx.Err()
	}
	defer d.storeMu.Unlock()
	st, err := d.load()
	if err != nil {
		log.Printf("guest relabel: reading the saved machines: %v", err)
		return shownLabel{}, errShareUnread
	}
	return d.publishLabelLocked(want, st, firstList)
}

// publishLabelLocked verifies the live link's profile in st, the saved
// machines as read now: found by its local id at the link's destination,
// else errShareUnbound (a link bound to none, or the profile moved or
// gone). The link then shows its label (link.shareLabel, what an invite
// carries). Once the saved machines are durable (else errShareUndurable,
// and the send stays owed), a label above what herdr has taken on this
// connection (link.sentRev) and above the one on its way there
// (link.sendingRev) goes over its current route. A herdr without
// guest_relabel_rev is sent a label change once, best effort, and nothing
// on connect. d.storeMu must be held.
func (d *Desk) publishLabelLocked(want *link, st machineStore, firstList bool) (shownLabel, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	l := d.link
	if l == nil || l.guest != nil || want != nil && l != want {
		return shownLabel{}, ErrSessionChanged
	}
	i := st.findProfile(l.profile)
	if i < 0 || machineID(st.Machines[i]) != l.id {
		return shownLabel{}, errShareUnbound
	}
	l.shareLabel, l.shareLabelRev = inviteLabel(st.Machines[i]), st.Machines[i].LabelRev
	shown := shownLabel{l.shareLabel, l.shareLabelRev}
	revs := herdrapi.CapabilityGuestRelabelRev.Supported(l.relabelVia.caps)
	if firstList && !revs {
		l.sentRev = shown.rev
	}
	if d.undurable.Load() {
		return shown, errShareUndurable
	}
	if max(l.sentRev, l.sendingRev) < shown.rev && herdrapi.CapabilityGuestRelabel.Supported(l.relabelVia.caps) {
		if revs {
			l.sendingRev = shown.rev
		} else {
			l.sentRev = shown.rev
		}
		d.relabelLocked(l, shown)
	}
	return shown, nil
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

// relabelLocked schedules shown by l's route as it is now, so the send
// goes over that connection or not at all, whatever replaces it. d.mu must
// be held.
func (d *Desk) relabelLocked(l *link, shown shownLabel) {
	route := l.relabelVia
	l.relabels.Add(1)
	if !l.work.Go(func() {
		defer l.relabels.Add(-1)
		d.relabelGuests(l, route, shown)
	}) {
		l.relabels.Add(-1)
	}
}

// relabelGuests asks the herdr of route to relabel l's shares and pending
// invites shown.label: at its revision where it reports guest_relabel_rev,
// which, answered while route is still l's, herdr has (link.sentRev); else
// without one. Failures are logged; the label stays owed (link.sendingRev
// cleared) until the next publishLabel.
func (d *Desk) relabelGuests(l *link, route relabelRoute, shown shownLabel) {
	var at *uint64
	answered := false
	defer func() {
		d.mu.Lock()
		if l.relabelVia.ctx == route.ctx {
			if l.sendingRev == shown.rev {
				l.sendingRev = 0
			}
			if answered && at != nil && shown.rev > l.sentRev {
				l.sentRev = shown.rev
			}
		}
		d.mu.Unlock()
	}()
	if route.view == nil || route.ctx == nil || route.ctx.Err() != nil || !herdrapi.CapabilityGuestRelabel.Supported(route.caps) {
		return
	}
	if herdrapi.CapabilityGuestRelabelRev.Supported(route.caps) {
		at = &shown.rev
	}
	_, err := engine.New(engine.Bridge(route.view)).GuestRelabel(route.ctx, shown.label, at)
	if err != nil && !errors.Is(err, context.Canceled) {
		log.Printf("guest relabel: %s: %q at %d: %v", l.id, shown.label, shown.rev, err)
	}
	answered = err == nil
}
