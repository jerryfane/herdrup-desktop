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
// out is sent when it is done, so the newest name is the last one herdr
// takes. "Done" is an answer (taken or refused) or a request never written:
// a relabel left unanswered (a timeout, a lost reply) may still land, and
// herdr's api-bridge --multi answers a connection's requests concurrently,
// in any order, so nothing more goes on that connection; the newest rename
// waits for the next one (a reconnect). A herdr whose ping doesn't report
// guest_relabel is asked nothing: its shares keep their label, as before.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"

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

// guestRelabelsPath is guest-relabels.json: the relabels not yet taken, by
// profile (Machine.LocalID), each the invite label the machine was renamed
// to.
func (d *Desk) guestRelabelsPath() string { return filepath.Join(d.dir, "guest-relabels.json") }

// loadRelabels reads the relabels not yet taken of the profiles st holds.
// An entry of a profile st no longer holds (removed, or replaced by account
// sync) or of none (#554's user@host:port keys, before #557) is retired: left
// out of the map, and retired reports it, so the caller writes it out with
// its own changes in one write (a cleanup that can't be written leaves the
// map as usable). Nothing is ever matched to a profile by address.
// d.storeMu must be held.
func (d *Desk) loadRelabels(st machineStore) (pending map[string]string, retired bool, err error) {
	pending = map[string]string{}
	data, err := os.ReadFile(d.guestRelabelsPath())
	if errors.Is(err, fs.ErrNotExist) {
		return pending, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if err := json.Unmarshal(data, &pending); err != nil {
		return nil, false, err
	}
	saved := map[string]bool{}
	for _, m := range st.Machines {
		if m.LocalID != "" {
			saved[m.LocalID] = true
		}
	}
	for profile := range pending {
		if !saved[profile] {
			delete(pending, profile)
			retired = true
		}
	}
	return pending, retired, nil
}

// storeRelabels writes them. d.storeMu must be held.
func (d *Desk) storeRelabels(pending map[string]string) error {
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
// renamed to label. d.storeMu must be held.
func (d *Desk) queueRelabel(st machineStore, localID, label string) error {
	pending, _, err := d.loadRelabels(st)
	if err != nil {
		return err
	}
	pending[localID] = label
	return d.storeRelabels(pending)
}

// relabelGuests sends l's machine's relabel not yet taken, if l is the live
// connection, listed, and its herdr reports guest_relabel. A profile has one
// sender at a time: a call while one is out has it send again once that one
// is done (relabelOnce), so a rename made meanwhile goes after the one out,
// never before it; a refusal leaves the relabel for the next connect only
// while no newer rename is waiting on it. After a relabel left unanswered,
// the sender stops: the next goes on another connection.
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
	for {
		done := d.relabelOnce(l, profile)
		d.relabelMu.Lock()
		if !done || !d.relabeling[profile] {
			delete(d.relabeling, profile)
			d.relabelMu.Unlock()
			return
		}
		d.relabeling[profile] = false
		d.relabelMu.Unlock()
	}
}

// relabelOnce sends profile's relabel not yet taken over l, if l is the live
// connection, listed, its herdr reports guest_relabel, and no relabel went
// unanswered on that connection; the label sent is the machine's invite label
// as saved now. It is forgotten once taken, unless a newer rename queued
// another meanwhile; a refusal keeps it for the next connect. done is false
// only when the relabel went unanswered (relabelSettled): it may still land,
// so l's connection takes no more, and the newest stays for the next one.
func (d *Desk) relabelOnce(l *link, profile string) (done bool) {
	d.mu.Lock()
	c, session, caps, ctx, live := l.client, l.session, l.caps, l.ctx, d.link == l
	unsure := c != nil && c == l.relabelUnsure
	d.mu.Unlock()
	if !live || c == nil || ctx == nil || unsure || !herdrapi.CapabilityGuestRelabel.Supported(caps) {
		return true
	}
	// A read alone writes nothing: retired entries go with the next write.
	d.storeMu.Lock()
	st, err := d.load()
	var pending map[string]string
	if err == nil {
		pending, _, err = d.loadRelabels(st)
	}
	d.storeMu.Unlock()
	if err != nil {
		log.Printf("guest relabel: %s: %v", l.id, err)
		return true
	}
	queued, ok := pending[profile]
	i := st.find(l.id)
	if !ok || i < 0 || st.Machines[i].LocalID != profile {
		return true
	}
	label := inviteLabel(st.Machines[i])
	view, err := c.ForSession(session)
	if err == nil {
		_, err = engine.New(engine.Bridge(view)).GuestRelabel(ctx, label)
	}
	if !relabelSettled(err) {
		log.Printf("guest relabel: %s: %v (unanswered: sent again on the next connection)", l.id, err)
		d.mu.Lock()
		l.relabelUnsure = c
		d.mu.Unlock()
		return false
	}
	if err != nil {
		log.Printf("guest relabel: %s: %v (sent again on the next connect)", l.id, err)
		return true
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
