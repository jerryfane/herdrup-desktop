package main

// A renamed machine's existing shares (herdr #519, guest_relabel; GAPS.md
// §2 option 0b): guests see the machine by the label its invite carried, kept
// in each share. When the owner renames a saved machine, the desk asks its
// herdr once to relabel every active share and pending invite with the new
// invite label (guest.update {machine_label}, no scope: one call), and guests
// see it in their next hello reply.
//
// The saved profile is the relabel's whole record (#592): its label
// (inviteLabel), that label's revision (Machine.LabelRev, the rename's unix
// ms, above every one before) and the last revision its herdr settled
// (Machine.LabelSent), written together by the rename. While LabelRev is
// above LabelSent the label is to be sent: at once when the renamed profile
// is the live connection's (link.profile, its LocalID, never its address),
// else on its next connect; a refusal leaves it for the next connect. A
// removed profile takes its relabel with it. One relabel of a profile is out
// at a time: a rename while one is out is sent when it is done. While an
// older build's relabel queue is there but not folded in (it can't be
// read), nothing is sent or settled (#594): each attempt folds it first.
//
// With guest_relabel_rev (herdr #526) herdr keeps each share's and invite's
// revision and takes a label only above it, so a relabel left unanswered (a
// timeout, a lost reply; herdr may still apply it, even after a reconnect,
// in any order) can never overwrite a newer one: the newest goes at once, on
// the same connection. It is settled when the reply shows every share and
// invite either at its revision with its label, or holding a label from
// elsewhere (the rule, #593): one above its revision is never this desk's
// (each rename's is above all before it, a queue of an older build's
// included, and none is past the clock), so it is a newer label from
// another of the owner's devices or herdr's CLI; another label at its very
// revision is one written elsewhere in the same ms (or by this desk before
// account sync renamed the machine), which herdr, taking a label only above
// a revision, already kept. Either stands: the relabel is settled, not
// taken, and not sent again. One below its revision leaves it to send again
// on the next connect.
// Without guest_relabel_rev, "done" is an answer (taken or refused)
// or a request never written: after one left unanswered nothing more goes on
// that connection and the newest waits for the next one (#563), which a
// relabel the old connection carried can still land after. A herdr whose
// ping doesn't report guest_relabel is asked nothing: its shares keep their
// label, as before.

import (
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

// nextLabelRev is a rename's label revision: now in unix ms, above the one
// before (prev) even if the clock went back.
func nextLabelRev(prev uint64) uint64 {
	return max(uint64(time.Now().UnixMilli()), prev+1)
}

// relabelPending reports whether m's label is still to be sent to its guests.
func relabelPending(m Machine) bool { return m.LocalID != "" && m.LabelRev > m.LabelSent }

// guestRelabelsPath is guest-relabels.json, the relabel queue of the builds
// before #592: by profile (Machine.LocalID), the label alone or {label, rev}.
// It is read only to fold it into the profiles (foldRelabels).
func (d *Desk) guestRelabelsPath() string { return filepath.Join(d.dir, "guest-relabels.json") }

// foldRelabels folds an older build's relabel queue into st, once: each
// saved profile it names is to be sent again, its LabelRev raised to the
// entry's revision (the file's time for an entry without one) if that is
// higher, but never past now, so the next rename's revision is above
// everything this desk ever sent (#593). The profile's label, not the
// entry's, is what goes (#592: the queue only ever marked it unsent).
// Entries of no saved profile (removed, replaced, #554's user@host:port
// keys) are dropped. st.RelabelsFolded records the fold in the same write
// as the profiles, so it never runs again (an older build's write drops the
// mark, and its queue is folded on the next upgrade); deleting the queue
// after (retireRelabelQueue) is only cleanup. folded reports st changed, to
// store; a queue that can't be read is left for the next load. d.storeMu
// must be held.
func (d *Desk) foldRelabels(st *machineStore) (folded bool) {
	if st.RelabelsFolded {
		return false
	}
	path := d.guestRelabelsPath()
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("guest relabel: reading the older relabel queue: %v", err)
		return false
	}
	st.RelabelsFolded = true
	if err != nil {
		return true
	}
	var entries map[string]json.RawMessage
	if err := json.Unmarshal(data, &entries); err != nil {
		log.Printf("guest relabel: the older relabel queue is unreadable, dropped: %v", err)
		return true
	}
	now := uint64(time.Now().UnixMilli())
	stamp := now
	if info, err := os.Stat(path); err == nil {
		stamp = min(uint64(info.ModTime().UnixMilli()), now)
	}
	for i := range st.Machines {
		m := &st.Machines[i]
		raw, ok := entries[m.LocalID]
		if m.LocalID == "" || !ok {
			continue
		}
		var entry struct {
			Rev uint64 `json:"rev"`
		}
		rev := stamp
		if json.Unmarshal(raw, &entry) == nil && entry.Rev > 0 {
			rev = min(entry.Rev, now)
		}
		m.LabelRev = max(m.LabelRev, rev, 1)
		m.LabelSent = min(m.LabelSent, m.LabelRev-1)
	}
	return true
}

// retireRelabelQueue deletes the older build's relabel queue once st's fold
// of it is stored. A failure is logged and harmless: the fold is recorded.
// d.storeMu must be held.
func (d *Desk) retireRelabelQueue() {
	if err := os.Remove(d.guestRelabelsPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("guest relabel: removing the older relabel queue: %v", err)
	}
}

// followSavedLabel has the live connection name its machine to guests as
// st saves its profile (link.profile, never the address, which account
// sync can give to another profile while the link stays): the invite label
// and its revision a share view opened from now on sends. A link whose
// profile is no longer saved (removed on another device: the connection
// stays until it ends) keeps what it had. Called with every stored change
// of a LabelRev not made before the connection started (a rename, a fold).
// d.mu must be held.
func (d *Desk) followSavedLabel(st machineStore) {
	if l := d.link; l != nil && l.guest == nil {
		if i := st.findProfile(l.profile); i >= 0 {
			l.shareLabel, l.shareLabelRev = inviteLabel(st.Machines[i]), st.Machines[i].LabelRev
		}
	}
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

// relabelGuests sends the label of l's profile (link.profile) if it is
// still to be sent, l is the live connection, listed, and its herdr reports
// guest_relabel. A profile has one sender at a time: a call while one is
// out has it send again once that one is done (relabelOnce), so a rename
// made meanwhile goes after the one out, never before it. After a relabel
// left unanswered it sends again at once (the newest, once) where herdr
// orders labels by revision, and stops where it doesn't: the next goes on
// another connection. A sender acts for l alone, as l's work: once another
// connection to the profile replaced l, it hands the rest to that
// connection's work.
func (d *Desk) relabelGuests(l *link) {
	profile := l.profile
	if profile == "" {
		return
	}
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
	// answered is the revision this sender's last answered relabel went at:
	// a call asking again while it was out (the rename was already saved)
	// sends nothing new, and a refusal waits for the next connect.
	var answered uint64
	for {
		outcome := d.relabelOnce(l, profile, &answered)
		if hook := d.relabelSent.Load(); hook != nil {
			(*hook)(l)
		}
		d.relabelMu.Lock()
		next := d.relabeling[profile] || outcome == relabelUnsure && !resent
		if outcome == relabelUnsure {
			resent = true
		}
		if outcome == relabelBlocked || !next || d.replaced(l) {
			delete(d.relabeling, profile)
			d.relabelMu.Unlock()
			d.handRelabelOn(l)
			return
		}
		d.relabeling[profile] = false
		d.relabelMu.Unlock()
	}
}

// findProfile is the index of the saved profile localID (Machine.LocalID),
// -1 if none.
func (s *machineStore) findProfile(localID string) int {
	for i, m := range s.Machines {
		if localID != "" && m.LocalID == localID {
			return i
		}
	}
	return -1
}

// loadFolded is d.load with an older build's relabel queue folded in and
// stored first (foldRelabels), the live link following it. folded is false
// while the queue exists but can't be read: no relabel is sent or settled
// then, since the queue's revision may be above the profile's (#594).
// d.storeMu must be held.
func (d *Desk) loadFolded() (st machineStore, folded bool, err error) {
	if st, err = d.load(); err != nil {
		return st, false, err
	}
	if d.foldRelabels(&st) {
		if err = d.store(st); err != nil {
			return st, false, err
		}
		d.retireRelabelQueue()
		d.mu.Lock()
		d.followSavedLabel(st)
		d.mu.Unlock()
	}
	return st, st.RelabelsFolded, nil
}

// replaced reports whether l is no longer the live connection.
func (d *Desk) replaced(l *link) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.link != l
}

// handRelabelOn starts a sender as the work of the connection that replaced
// l to the same profile, if one did: what l's sender leaves is that
// connection's to send.
func (d *Desk) handRelabelOn(l *link) {
	d.mu.Lock()
	live := d.link
	d.mu.Unlock()
	if live != nil && live != l && live.guest == nil && live.profile == l.profile {
		live.work.Go(func() { d.relabelGuests(live) })
	}
}

// relabelOnce sends profile's label over l if it is still to be sent, l is
// the live connection, listed, its herdr reports guest_relabel, and (on a
// herdr without guest_relabel_rev) no relabel went unanswered on that
// connection. The label and revision sent are the profile's as saved now,
// unless that revision is *answered (this sender's last answered one),
// which it sets once herdr answers. Once settled (taken; on a herdr with
// guest_relabel_rev, by the rule above) the profile records it sent, unless
// a newer rename came meanwhile; a refusal leaves it for the next connect.
func (d *Desk) relabelOnce(l *link, profile string, answered *uint64) relabelOutcome {
	d.mu.Lock()
	c, session, caps, ctx, live := l.client, l.session, l.caps, l.ctx, d.link == l
	blocked := c != nil && c == l.relabelUnsure
	d.mu.Unlock()
	if !live || c == nil || ctx == nil || blocked || !herdrapi.CapabilityGuestRelabel.Supported(caps) {
		return relabelDone
	}
	ordered := herdrapi.CapabilityGuestRelabelRev.Supported(caps)
	d.storeMu.Lock()
	st, folded, err := d.loadFolded()
	d.storeMu.Unlock()
	if err != nil {
		log.Printf("guest relabel: %s: %v", l.id, err)
		return relabelDone
	}
	if !folded {
		log.Printf("guest relabel: %s: the older relabel queue is still to fold in (sent on a later connect)", l.id)
		return relabelDone
	}
	i := st.findProfile(profile)
	if i < 0 || !relabelPending(st.Machines[i]) || st.Machines[i].LabelRev == *answered {
		return relabelDone
	}
	label, sent := inviteLabel(st.Machines[i]), st.Machines[i].LabelRev
	var rev *uint64
	if ordered {
		rev = &sent
	}
	var reply herdrapi.ResponseResultGuestRelabeled
	view, err := c.ForSession(session)
	if err == nil {
		reply, err = engine.New(engine.Bridge(view)).GuestRelabel(ctx, label, rev)
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
	*answered = sent
	if err != nil {
		log.Printf("guest relabel: %s: %v (sent again on the next connect)", l.id, err)
		return relabelDone
	}
	if ordered {
		switch relabelReached(reply, label, sent) {
		case relabelBelow:
			log.Printf("guest relabel: %s: a share or invite is below %q's revision %d (sent again on the next connect)", l.id, label, sent)
			return relabelDone
		case relabelSuperseded:
			log.Printf("guest relabel: %s: another label than %q stands at or above its revision %d", l.id, label, sent)
		}
	}
	d.storeMu.Lock()
	defer d.storeMu.Unlock()
	if st, err = d.load(); err == nil {
		if i := st.findProfile(profile); i >= 0 && st.Machines[i].LabelRev == sent {
			st.Machines[i].LabelSent = sent
			err = d.store(st)
		}
	}
	if err != nil {
		log.Printf("guest relabel: %s: %v", l.id, err)
	}
	return relabelDone
}

// relabelReach is where a relabel stands by herdr's reply (the rule above).
type relabelReach int

const (
	// relabelTaken: every share and invite holds the label at its revision.
	relabelTaken relabelReach = iota
	// relabelSuperseded: none is below its revision, and one holds a label
	// from elsewhere (above its revision, or another label at it), which
	// stands.
	relabelSuperseded
	// relabelBelow: one is below its revision.
	relabelBelow
)

// relabelReached reads a relabel of label at rev in herdr's reply: the
// furthest from taken any share or invite stands.
func relabelReached(reply herdrapi.ResponseResultGuestRelabeled, label string, rev uint64) relabelReach {
	reach := relabelTaken
	record := func(recLabel string, recRev uint64) {
		switch {
		case recRev < rev:
			reach = relabelBelow
		case recRev > rev || recLabel != label:
			reach = max(reach, relabelSuperseded)
		}
	}
	for _, g := range reply.Guests {
		record(g.MachineLabel, g.MachineLabelRev)
	}
	for _, i := range reply.Invites {
		record(i.MachineLabel, i.MachineLabelRev)
	}
	return reach
}

// relabelSettled reports whether err, a relabel's outcome, settles it: herdr
// answered (nil: taken; an API error: refused) or the request was never
// written (bridge.ErrNotSent). Anything else (a timeout, a reply lost with
// its connection) leaves it unanswered: herdr may still apply it.
func relabelSettled(err error) bool {
	var refused *bridge.APIError
	return err == nil || errors.As(err, &refused) || errors.Is(err, bridge.ErrNotSent)
}
