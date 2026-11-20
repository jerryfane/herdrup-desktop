package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/account"
)

// Machine sync through the HerdrUp account (design #698 §5, hosts
// collection; accounts step 5 PR B). Only what identifies a machine travels:
// nickname, host, port, username and whether it signs in with a key. The key
// path, keys, passwords, pins and session never do. A synced machine another
// device added shows on this one to pair (SyncedMachines); its key or password
// is entered here.

// syncState is account-sync.json: the account's hosts as last synced (what
// a local edit is measured against), and the deletes not yet pushed.
type syncState struct {
	Mirror  account.Mirror `json:"mirror"`
	Deletes []string       `json:"deletes,omitempty"`
}

func (d *Desk) syncStatePath() string { return filepath.Join(d.dir, "account-sync.json") }

func (d *Desk) loadSyncState() syncState {
	var s syncState
	if raw, err := os.ReadFile(d.syncStatePath()); err == nil {
		_ = json.Unmarshal(raw, &s)
	}
	return s
}

func (d *Desk) storeSyncState(s syncState) error {
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := d.syncStatePath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, d.syncStatePath())
}

// hostBody is what a saved machine syncs as, over base (the account's copy,
// so fields this app doesn't keep, such as label, are kept).
func hostBody(m Machine, base account.HostBody) account.HostBody {
	b := base
	b.Nickname, b.Host, b.Port, b.Username = m.Nickname, m.Host, m.Port, m.User
	if b.Port == 0 {
		b.Port = 22
	}
	b.AuthKind = "password"
	if m.KeyPath != "" {
		b.AuthKind = "key"
	}
	return b
}

// sameHost reports whether a machine's synced fields equal body's.
func sameHost(m Machine, body account.HostBody) bool {
	return hostBody(m, body) == body
}

// SyncedMachine is an account machine this device hasn't saved: the
// "Welcome back" list offers to pair it (1B).
type SyncedMachine struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname,omitempty"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	// Key says the machine signs in with a key, so pairing asks for one.
	Key bool `json:"key"`
}

// SyncedMachinesChanged tells the page the account's machines changed.
var SyncedMachinesChanged = mygo.NewEvent[[]SyncedMachine]("account:machines")

var publishSyncedMachines = func(m []SyncedMachine) { SyncedMachinesChanged.Broadcast(m) }

// accountSync runs one sync at a time: a call waits for the one running and
// then makes its own, so it returns once a sync that began after it is done.
type accountSync struct{ mu sync.Mutex }

// SyncedMachines is the account's machines this device hasn't saved, as
// last synced (no network).
func (d *Desk) SyncedMachines() ([]SyncedMachine, error) {
	if s, _ := d.account.Current(); s == nil {
		return []SyncedMachine{}, nil
	}
	d.storeMu.Lock()
	st, err := d.load()
	state := d.loadSyncState()
	d.storeMu.Unlock()
	if err != nil {
		return nil, err
	}
	return unsavedHosts(st.Machines, state.Mirror.Hosts), nil
}

func unsavedHosts(local []Machine, mirror []account.RemoteHost) []SyncedMachine {
	saved := map[account.HostIdentity]bool{}
	for _, m := range local {
		saved[account.IdentityOf(hostBody(m, account.HostBody{}))] = true
	}
	out := []SyncedMachine{}
	for _, h := range mirror {
		if saved[account.IdentityOf(h.Body)] {
			continue
		}
		saved[account.IdentityOf(h.Body)] = true // a fork shows once
		port := h.Body.Port
		if port == 0 {
			port = 22
		}
		out = append(out, SyncedMachine{ID: h.ID, Nickname: h.Body.Nickname, Host: h.Body.Host, Port: port, User: h.Body.Username, Key: h.Body.AuthKind != "password"})
	}
	return out
}

// SyncMachines pulls the account's machines, merges them into the saved
// ones and pushes this device's changes. Without a session it does nothing.
func (d *Desk) SyncMachines(ctx context.Context) error {
	d.accountSync.mu.Lock()
	defer d.accountSync.mu.Unlock()
	err := d.syncMachinesOnce(ctx)
	if errors.Is(err, account.ErrSignedOut) {
		publishAccount(d.accountState(""))
		return nil
	}
	return err
}

func (d *Desk) syncMachinesOnce(ctx context.Context) error {
	if cur, err := d.account.Current(); err != nil || cur == nil {
		return err
	}
	d.storeMu.Lock()
	state := d.loadSyncState()
	d.storeMu.Unlock()
	// A device that never synced pulls everything first (since 0) and
	// adopts the account's ids before it pushes anything.
	pull, err := d.account.PullSince(ctx, state.Mirror.Rev)
	if err != nil {
		return err
	}
	old := state.Mirror
	mirror := old.Apply(pull)

	d.storeMu.Lock()
	st, err := d.load()
	if err != nil {
		d.storeMu.Unlock()
		return err
	}
	changes, deletes, renamed := mergeMachines(&st, old, mirror, d.loadSyncState().Deletes)
	if err := d.store(st); err != nil {
		d.storeMu.Unlock()
		return err
	}
	// As SaveMachine: the board cache follows a machine's id.
	for from, to := range renamed {
		d.boards.forget(from)
		d.boards.allow(to)
	}
	state = syncState{Mirror: mirror, Deletes: deletes}
	if err := d.storeSyncState(state); err != nil {
		d.storeMu.Unlock()
		return err
	}
	d.storeMu.Unlock()

	for start := 0; start < len(changes); start += 100 {
		batch := changes[start:min(start+100, len(changes))]
		if _, err := d.account.Push(ctx, batch); err != nil {
			return err
		}
	}
	if len(changes) > 0 {
		// Read our own writes back, so the mirror holds what the account holds.
		d.storeMu.Lock()
		state = d.loadSyncState()
		d.storeMu.Unlock()
		pull, err := d.account.PullSince(ctx, state.Mirror.Rev)
		if err != nil {
			return err
		}
		d.storeMu.Lock()
		state = d.loadSyncState()
		pushed := map[string]bool{}
		for _, c := range changes {
			if c.Deleted {
				pushed[c.ID] = true
			}
		}
		state.Deletes = slices.DeleteFunc(state.Deletes, func(id string) bool { return pushed[id] })
		state.Mirror = state.Mirror.Apply(pull)
		err = d.storeSyncState(state)
		d.storeMu.Unlock()
		if err != nil {
			return err
		}
	}
	publishSyncedMachines(unsavedHosts(st.Machines, state.Mirror.Hosts))
	return nil
}

// mergeMachines applies the account's hosts (mirror; old is the copy last
// synced) to the saved machines and returns the changes to push. deletes
// are machines removed here and not yet pushed; it returns those left.
func mergeMachines(st *machineStore, old, mirror account.Mirror, deletes []string) (changes []account.Change, left []string, renamed map[string]string) {
	renamed = map[string]string{}
	before := map[string]account.HostBody{}
	for _, h := range old.Hosts {
		before[h.ID] = h.Body
	}
	now := map[string]account.HostBody{}
	for _, h := range mirror.Hosts {
		now[h.ID] = h.Body
	}
	// A local edit since the last sync wins over the account's copy: the
	// last write to reach the service wins (§5.3), and this one hasn't yet.
	edited := map[int]bool{}
	for i, m := range st.Machines {
		if base, ok := before[m.SyncID]; m.SyncID != "" && ok && !sameHost(m, base) {
			edited[i] = true
		}
	}
	local := make([]account.LocalHost, len(st.Machines))
	for i, m := range st.Machines {
		local[i] = account.LocalHost{SyncID: m.SyncID, Body: hostBody(m, account.HostBody{})}
	}
	plan, err := account.PlanHosts(local, mirror.Hosts)
	if err != nil {
		log.Printf("account sync: %v", err)
		return nil, deletes, renamed
	}
	for _, id := range plan.Delete {
		changes = append(changes, account.Change{Collection: "hosts", ID: id, Deleted: true})
	}
	for i, id := range plan.Adopt {
		st.Machines[i].SyncID = id
	}
	for i, id := range plan.Push {
		st.Machines[i].SyncID = id
		changes = append(changes, account.Change{Collection: "hosts", ID: id, Body: hostBody(st.Machines[i], account.HostBody{})})
	}
	for i, m := range st.Machines {
		body, ok := now[m.SyncID]
		if !ok || plan.Push[i] != "" {
			continue
		}
		switch {
		case edited[i] && !sameHost(m, body):
			changes = append(changes, account.Change{Collection: "hosts", ID: m.SyncID, Body: hostBody(m, body)})
		case !edited[i] && !sameHost(m, body):
			// Changed on another device: take its fields. The machine's key
			// path and session stay this device's. Its saved id
			// (user@host:port) may change with them; Active follows, and a
			// change onto another saved machine's id is left for the person.
			next := m
			next.Nickname, next.Host, next.Port, next.User = body.Nickname, body.Host, body.Port, body.Username
			if next.Port == 0 {
				next.Port = 22
			}
			from, to := machineID(m), machineID(next)
			if to != from && st.find(to) >= 0 {
				continue
			}
			st.Machines[i] = next
			if to != from {
				if st.Active == from {
					st.Active = to
				}
				renamed[from] = to
			}
		}
	}
	// Deleted on another device: off this device's list (a live connection
	// stays until it ends).
	gone := map[int]bool{}
	for _, i := range plan.Gone {
		gone[i] = true
	}
	if len(gone) > 0 {
		kept := st.Machines[:0]
		for i, m := range st.Machines {
			if gone[i] {
				if st.Active == machineID(m) {
					st.Active = ""
				}
				continue
			}
			kept = append(kept, m)
		}
		st.Machines = kept
	}
	for _, id := range deletes {
		if _, ok := now[id]; ok {
			changes = append(changes, account.Change{Collection: "hosts", ID: id, Deleted: true})
			left = append(left, id)
		}
	}
	return changes, left, renamed
}

// machineSyncEvery is how often a signed-in app syncs machines while open.
const machineSyncEvery = 15 * time.Minute

// startMachineSync syncs at launch and then every machineSyncEvery; a
// signed-out app makes no account calls.
func (d *Desk) startMachineSync() {
	go func() {
		for {
			if s, _ := d.account.Current(); s != nil {
				d.syncMachinesSoon()
			}
			time.Sleep(machineSyncEvery)
		}
	}()
}

// backgroundMachineSync is false in tests that sync by hand.
var backgroundMachineSync = true

// syncMachinesSoon runs a sync in the background after a local change.
func (d *Desk) syncMachinesSoon() {
	if !backgroundMachineSync {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := d.SyncMachines(ctx); err != nil {
			log.Printf("account sync: %v", err)
		}
	}()
}
