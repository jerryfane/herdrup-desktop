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
// the machine's next connect; a failure is logged and sent again on the next
// connect. One relabel of a profile is out at a time: a rename while one is
// out is sent when it is done, so the newest name is the last one herdr
// takes. A herdr whose ping doesn't report guest_relabel is asked nothing:
// its shares keep their label, as before.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"regexp"

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

// loadRelabels reads the relabels not yet taken. d.storeMu must be held.
// Entries keyed by anything but a profile's LocalID (the user@host:port keys
// of #554, before #557) are bound to no profile: they are retired here,
// written out of the file, and never matched to a profile by address, which
// would let a new profile at that address inherit one again.
func (d *Desk) loadRelabels() (map[string]string, error) {
	pending := map[string]string{}
	data, err := os.ReadFile(d.guestRelabelsPath())
	if errors.Is(err, fs.ErrNotExist) {
		return pending, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &pending); err != nil {
		return nil, err
	}
	retired := false
	for key := range pending {
		if !localIDPattern.MatchString(key) {
			delete(pending, key)
			retired = true
		}
	}
	if retired {
		return pending, d.storeRelabels(pending)
	}
	return pending, nil
}

// localIDPattern is a Machine.LocalID, as newLocalID makes them.
var localIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// storeRelabels writes them. d.storeMu must be held.
func (d *Desk) storeRelabels(pending map[string]string) error {
	data, err := json.Marshal(pending)
	if err != nil {
		return err
	}
	return writeFileAtomic(d.guestRelabelsPath(), data)
}

// queueRelabel records that the profile localID of st, just saved, was
// renamed to label, and forgets the relabels of profiles st no longer holds
// (removed, or replaced by account sync). d.storeMu must be held.
func (d *Desk) queueRelabel(st machineStore, localID, label string) error {
	pending, err := d.loadRelabels()
	if err != nil {
		return err
	}
	saved := map[string]bool{}
	for _, m := range st.Machines {
		saved[m.LocalID] = true
	}
	for id := range pending {
		if !saved[id] {
			delete(pending, id)
		}
	}
	pending[localID] = label
	return d.storeRelabels(pending)
}

// dropRelabel forgets the relabel of profile localID, removed. d.storeMu
// must be held.
func (d *Desk) dropRelabel(localID string) error {
	pending, err := d.loadRelabels()
	if _, ok := pending[localID]; err != nil || !ok {
		return err
	}
	delete(pending, localID)
	return d.storeRelabels(pending)
}

// relabelGuests sends l's machine's relabel not yet taken, if l is the live
// connection, listed, and its herdr reports guest_relabel. A profile has one
// sender at a time: a call while one is out has it send again once done, so
// a rename made meanwhile goes after the one out, never before it. It goes
// whether the one out was taken or refused: a refusal leaves the relabel for
// the next connect only while no newer rename is waiting on this one.
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
		d.relabelOnce(l, profile)
		d.relabelMu.Lock()
		if !d.relabeling[profile] {
			delete(d.relabeling, profile)
			d.relabelMu.Unlock()
			return
		}
		d.relabeling[profile] = false
		d.relabelMu.Unlock()
	}
}

// relabelOnce sends profile's relabel not yet taken over l, if l is the live
// connection, listed, and its herdr reports guest_relabel; the label sent is
// the machine's invite label as saved now. It is forgotten once taken, unless
// a newer rename queued another meanwhile; a refusal keeps it for the next
// connect.
func (d *Desk) relabelOnce(l *link, profile string) {
	d.mu.Lock()
	c, session, caps, ctx, live := l.client, l.session, l.caps, l.ctx, d.link == l
	d.mu.Unlock()
	if !live || c == nil || ctx == nil || !herdrapi.CapabilityGuestRelabel.Supported(caps) {
		return
	}
	d.storeMu.Lock()
	pending, err := d.loadRelabels()
	var st machineStore
	if err == nil {
		st, err = d.load()
	}
	d.storeMu.Unlock()
	if err != nil {
		log.Printf("guest relabel: %s: %v", l.id, err)
		return
	}
	queued, ok := pending[profile]
	i := st.find(l.id)
	if !ok || i < 0 || st.Machines[i].LocalID != profile {
		return
	}
	label := inviteLabel(st.Machines[i])
	view, err := c.ForSession(session)
	if err == nil {
		_, err = engine.New(engine.Bridge(view)).GuestRelabel(ctx, label)
	}
	if err != nil {
		log.Printf("guest relabel: %s: %v (sent again on the next connect)", l.id, err)
		return
	}
	d.storeMu.Lock()
	defer d.storeMu.Unlock()
	if pending, err = d.loadRelabels(); err == nil && pending[profile] == queued {
		delete(pending, profile)
		err = d.storeRelabels(pending)
	}
	if err != nil {
		log.Printf("guest relabel: %s: %v", l.id, err)
	}
}
