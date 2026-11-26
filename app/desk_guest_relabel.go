package main

// A renamed machine's existing shares (herdr #519, guest_relabel; GAPS.md
// §2 option 0b): guests see the machine by the label its invite carried, kept
// in each share. When the owner renames a saved machine, the desk asks its
// herdr once to relabel every active share and pending invite with the new
// invite label (guest.update {machine_label}, no scope: one call), and guests
// see it in their next hello reply.
//
// The relabel is remembered per saved profile (Machine.LocalID, never reused)
// in guest-relabels.json until its herdr takes it, and goes when the profile
// does: sent at once when the renamed machine is the live connection, else on
// the machine's next connect; a refusal is logged and sent again on the next
// connect. One relabel of a profile is out at a time: a rename while one is
// out is sent when it is done. Each carries its revision (Machine.LabelRev,
// the rename's unix ms).
//
// With guest_relabel_rev (herdr #526) herdr keeps each share's and invite's
// revision and takes a label only above it, so a relabel left unanswered (a
// timeout, a lost reply; herdr may still apply it, even after a reconnect,
// in any order) can never overwrite a newer one: the newest goes at once, on
// the same connection, and is forgotten once a reply shows every share and
// invite at its revision or above. Without it, "done" is an answer (taken or
// refused) or a request never written: after one left unanswered nothing
// more goes on that connection and the newest waits for the next one (#563),
// which a relabel the old connection carried can still land after (#570). A
// herdr whose ping doesn't report guest_relabel is asked nothing: its shares
// keep their label, as before.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
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

// nextLabelRev is a rename's label revision: now in unix ms, above the one
// before (prev) even if the clock went back.
func nextLabelRev(prev uint64) uint64 {
	return max(uint64(time.Now().UnixMilli()), prev+1)
}

// queuedRelabel is a relabel not yet taken: the invite label a profile was
// renamed to, and its revision.
type queuedRelabel struct {
	Label string `json:"label"`
	Rev   uint64 `json:"rev"`
}

// UnmarshalJSON reads an entry, or one of the format before revisions (the
// label alone): that one takes rev, set by the caller (loadRelabels).
func (q *queuedRelabel) UnmarshalJSON(data []byte) error {
	var label string
	if json.Unmarshal(data, &label) == nil {
		q.Label = label
		return nil
	}
	type plain queuedRelabel
	return json.Unmarshal(data, (*plain)(q))
}

// guestRelabelsPath is guest-relabels.json: the relabels not yet taken, by
// profile (Machine.LocalID).
func (d *Desk) guestRelabelsPath() string { return filepath.Join(d.dir, "guest-relabels.json") }

// loadRelabels reads the relabels not yet taken of the profiles st holds.
// An entry of a profile st no longer holds (removed, or replaced by account
// sync) or of none (#554's user@host:port keys, before #557) is retired: left
// out of the map, and retired reports it, so the caller writes it out with
// its own changes in one write (a cleanup that can't be written leaves the
// map as usable). Nothing is ever matched to a profile by address. An entry
// written before revisions takes the file's time as its revision: the same
// on every read until the file is written again. d.storeMu must be held.
func (d *Desk) loadRelabels(st machineStore) (pending map[string]queuedRelabel, retired bool, err error) {
	pending = map[string]queuedRelabel{}
	path := d.guestRelabelsPath()
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return pending, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if err := json.Unmarshal(data, &pending); err != nil {
		return nil, false, err
	}
	var stamp uint64
	if info, err := os.Stat(path); err == nil {
		stamp = uint64(info.ModTime().UnixMilli())
	}
	saved := map[string]bool{}
	for _, m := range st.Machines {
		if m.LocalID != "" {
			saved[m.LocalID] = true
		}
	}
	for profile, q := range pending {
		switch {
		case !saved[profile]:
			delete(pending, profile)
			retired = true
		case q.Rev == 0:
			q.Rev = max(stamp, 1)
			pending[profile] = q
		}
	}
	return pending, retired, nil
}

// storeRelabels writes them. d.storeMu must be held.
func (d *Desk) storeRelabels(pending map[string]queuedRelabel) error {
	data, err := json.Marshal(pending)
	if err != nil {
		return err
	}
	return writeFileAtomic(d.guestRelabelsPath(), data)
}

// retireRelabels writes out the relabels of profiles st no longer holds, if
// there are any; a failure is logged. d.storeMu must be held.
func (d *Desk) retireRelabels(st machineStore) {
	pending, retired, err := d.loadRelabels(st)
	if err == nil && retired {
		err = d.storeRelabels(pending)
	}
	if err != nil {
		log.Printf("guest relabel: retiring relabels of no saved profile: %v", err)
	}
}

// queueRelabel records that the profile localID of st, just saved, was
// renamed: q. d.storeMu must be held.
func (d *Desk) queueRelabel(st machineStore, localID string, q queuedRelabel) error {
	pending, _, err := d.loadRelabels(st)
	if err != nil {
		return err
	}
	pending[localID] = q
	return d.storeRelabels(pending)
}

// relabelOutcome is what one relabel came to, for the sender (relabelGuests).
type relabelOutcome int

const (
	// relabelDone: answered (taken or refused), never written, or nothing to
	// send on this connection.
	relabelDone relabelOutcome = iota
	// relabelUnsure: unanswered, on a herdr that orders labels by revision:
	// the connection takes more.
	relabelUnsure
	// relabelBlocked: unanswered, on a herdr that doesn't: the connection
	// takes no more.
	relabelBlocked
)

// relabelGuests sends l's machine's relabel not yet taken, if l (or the live
// connection to its machine since) is the live connection, listed, and its
// herdr reports guest_relabel. A profile has one sender at a time: a call
// while one is out has it send again once that one is done (relabelOnce), so
// a rename made meanwhile goes after the one out, never before it; a refusal
// leaves the relabel for the next connect only while no newer rename is
// waiting on it. After a relabel left unanswered it sends again at once (the
// newest, once) where herdr orders labels by revision, and stops where it
// doesn't: the next goes on another connection.
func (d *Desk) relabelGuests(l *link) {
	d.storeMu.Lock()
	st, err := d.load()
	d.storeMu.Unlock()
	i := -1
	if err == nil {
		i = st.find(l.id)
	}
	if i < 0 || st.Machines[i].LocalID == "" {
		return
	}
	profile := st.Machines[i].LocalID
	d.relabelMu.Lock()
	if _, out := d.relabeling[profile]; out {
		d.relabeling[profile] = true
		d.relabelMu.Unlock()
		return
	}
	if d.relabeling == nil {
		d.relabeling = map[string]bool{}
	}
	d.relabeling[profile] = false
	d.relabelMu.Unlock()
	resent := false
	for {
		// A sender that outlived its connection goes on with the one that
		// replaced it, to the same machine.
		d.mu.Lock()
		if live := d.link; live != nil && live.guest == nil && live.id == l.id {
			l = live
		}
		d.mu.Unlock()
		outcome := d.relabelOnce(l, profile)
		d.relabelMu.Lock()
		next := d.relabeling[profile] || outcome == relabelUnsure && !resent
		if outcome == relabelUnsure {
			resent = true
		}
		if outcome == relabelBlocked || !next {
			delete(d.relabeling, profile)
			d.relabelMu.Unlock()
			return
		}
		d.relabeling[profile] = false
		d.relabelMu.Unlock()
	}
}

// relabelOnce sends profile's relabel not yet taken over l, if l is the live
// connection, listed, its herdr reports guest_relabel, and (on a herdr
// without guest_relabel_rev) no relabel went unanswered on that connection.
// It is forgotten once taken, unless a newer rename queued another
// meanwhile, and on a herdr with guest_relabel_rev only when the reply shows
// every share and invite at its revision or above; a refusal keeps it for
// the next connect.
func (d *Desk) relabelOnce(l *link, profile string) relabelOutcome {
	d.mu.Lock()
	c, session, caps, ctx, live := l.client, l.session, l.caps, l.ctx, d.link == l
	blocked := c != nil && c == l.relabelUnsure
	d.mu.Unlock()
	if !live || c == nil || ctx == nil || blocked || !herdrapi.CapabilityGuestRelabel.Supported(caps) {
		return relabelDone
	}
	ordered := herdrapi.CapabilityGuestRelabelRev.Supported(caps)
	// A read alone writes nothing: retired entries go with the next write.
	d.storeMu.Lock()
	st, err := d.load()
	var pending map[string]queuedRelabel
	if err == nil {
		pending, _, err = d.loadRelabels(st)
	}
	d.storeMu.Unlock()
	if err != nil {
		log.Printf("guest relabel: %s: %v", l.id, err)
		return relabelDone
	}
	queued, ok := pending[profile]
	i := st.find(l.id)
	if !ok || i < 0 || st.Machines[i].LocalID != profile {
		return relabelDone
	}
	var rev *uint64
	if ordered {
		rev = &queued.Rev
	}
	var reply herdrapi.ResponseResultGuestRelabeled
	view, err := c.ForSession(session)
	if err == nil {
		reply, err = engine.New(engine.Bridge(view)).GuestRelabel(ctx, queued.Label, rev)
	}
	if !relabelSettled(err) {
		if ordered {
			log.Printf("guest relabel: %s: %v (unanswered: sent again, at its revision)", l.id, err)
			return relabelUnsure
		}
		log.Printf("guest relabel: %s: %v (unanswered: sent again on the next connection)", l.id, err)
		d.mu.Lock()
		l.relabelUnsure = c
		d.mu.Unlock()
		return relabelBlocked
	}
	if err != nil {
		log.Printf("guest relabel: %s: %v (sent again on the next connect)", l.id, err)
		return relabelDone
	}
	if ordered && !relabelReached(reply, queued.Rev) {
		log.Printf("guest relabel: %s: a share or invite is below revision %d (sent again on the next connect)", l.id, queued.Rev)
		return relabelDone
	}
	d.storeMu.Lock()
	defer d.storeMu.Unlock()
	retired := false
	if st, err = d.load(); err == nil {
		pending, retired, err = d.loadRelabels(st)
	}
	if err == nil {
		taken := pending[profile] == queued
		if taken {
			delete(pending, profile)
		}
		if taken || retired {
			err = d.storeRelabels(pending)
		}
	}
	if err != nil {
		log.Printf("guest relabel: %s: %v", l.id, err)
	}
	return relabelDone
}

// relabelReached reports whether a relabel at rev has reached every share
// and invite the reply lists: each at rev or above (a newer one, from
// another of the owner's devices, stands).
func relabelReached(reply herdrapi.ResponseResultGuestRelabeled, rev uint64) bool {
	for _, g := range reply.Guests {
		if g.MachineLabelRev < rev {
			return false
		}
	}
	for _, i := range reply.Invites {
		if i.MachineLabelRev < rev {
			return false
		}
	}
	return true
}

// relabelSettled reports whether err, a relabel's outcome, settles it: herdr
// answered (nil: taken; an API error: refused) or the request was never
// written (bridge.ErrNotSent). Anything else (a timeout, a reply lost with
// its connection) leaves it unanswered: herdr may still apply it.
func relabelSettled(err error) bool {
	var refused *bridge.APIError
	return err == nil || errors.As(err, &refused) || errors.Is(err, bridge.ErrNotSent)
}
