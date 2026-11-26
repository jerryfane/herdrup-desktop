package main

// A renamed machine's existing shares (herdr #519, guest_relabel; GAPS.md
// §2 option 0b): guests see the machine by the label its invite carried, kept
// in each share. When the owner renames a saved machine, the desk asks its
// herdr once to relabel every active share and pending invite with the new
// invite label (guest.update {machine_label}, no scope: one call), and guests
// see it in their next hello reply.
//
// The relabel is remembered per machine id in guest-relabels.json until its
// herdr takes it: sent at once when the renamed machine is the live
// connection, else on the machine's next connect; a failure is logged and
// sent again on the next connect. A herdr whose ping doesn't report
// guest_relabel is asked nothing: its shares keep their label, as before.

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"

	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// guestRelabelsPath is guest-relabels.json: the relabels not yet taken, by
// machine id, each the invite label the machine was renamed to.
func (d *Desk) guestRelabelsPath() string { return filepath.Join(d.dir, "guest-relabels.json") }

// loadRelabels reads the relabels not yet taken. d.storeMu must be held.
func (d *Desk) loadRelabels() (map[string]string, error) {
	pending := map[string]string{}
	data, err := os.ReadFile(d.guestRelabelsPath())
	if errors.Is(err, fs.ErrNotExist) {
		return pending, nil
	}
	if err != nil {
		return nil, err
	}
	return pending, json.Unmarshal(data, &pending)
}

// storeRelabels writes them. d.storeMu must be held.
func (d *Desk) storeRelabels(pending map[string]string) error {
	data, err := json.Marshal(pending)
	if err != nil {
		return err
	}
	return writeFileAtomic(d.guestRelabelsPath(), data)
}

// queueRelabel records SaveMachine's edit of machine replacing, saved as id:
// a relabel not yet taken follows the machine to id, and a rename (label,
// "" when the save renamed nothing) is to be sent. d.storeMu must be held.
func (d *Desk) queueRelabel(id, replacing, label string) error {
	pending, err := d.loadRelabels()
	if err != nil {
		return err
	}
	changed := false
	if queued, ok := pending[replacing]; ok && replacing != id {
		delete(pending, replacing)
		pending[id], changed = queued, true
	}
	if label != "" {
		pending[id], changed = label, true
	}
	if !changed {
		return nil
	}
	return d.storeRelabels(pending)
}

// relabelGuests sends l's machine's relabel not yet taken, if l is the live
// connection, listed, and its herdr reports guest_relabel. The label sent is
// the machine's invite label as saved now; the relabel is forgotten once
// taken, unless a newer rename queued another meanwhile. A failure keeps it
// for the next connect.
func (d *Desk) relabelGuests(l *link) {
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
	queued, ok := pending[l.id]
	i := st.find(l.id)
	if !ok || i < 0 {
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
	if pending, err = d.loadRelabels(); err == nil && pending[l.id] == queued {
		delete(pending, l.id)
		err = d.storeRelabels(pending)
	}
	if err != nil {
		log.Printf("guest relabel: %s: %v", l.id, err)
	}
}
