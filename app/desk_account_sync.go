package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	// AccountID is the account this state and the machines' sync ids belong
	// to: another account starts over (a full pull, adopt, then push).
	AccountID string         `json:"accountId"`
	Mirror    account.Mirror `json:"mirror"`
	Deletes   []string       `json:"deletes,omitempty"`
	// Baseline is each machine's shared fields (sharedFields) as this
	// device last agreed them with the account, by sync id: a machine that
	// differs from it was edited here. Device-local fields such as whether
	// this device signs in with a key are not part of it.
	Baseline map[string]account.HostBody `json:"baseline,omitempty"`
}

func (d *Desk) syncStatePath() string { return filepath.Join(d.dir, "account-sync.json") }

// loadSyncState reads account-sync.json; none yet is an empty state, and an
// unreadable or damaged one is an error (never a silent restart, which
// would drop pending deletes).
func (d *Desk) loadSyncState() (syncState, error) {
	var s syncState
	raw, err := os.ReadFile(d.syncStatePath())
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return syncState{}, fmt.Errorf("account sync state %s: %w", d.syncStatePath(), err)
	}
	return s, nil
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

// sharedFields are the fields one device's edit of a machine changes for
// every device: nickname, host, port and username.
func sharedFields(m Machine) account.HostBody {
	port := m.Port
	if port == 0 {
		port = 22
	}
	return account.HostBody{Nickname: m.Nickname, Host: m.Host, Port: port, Username: m.User}
}

func sharedOf(b account.HostBody) account.HostBody {
	if b.Port == 0 {
		b.Port = 22
	}
	return account.HostBody{Nickname: b.Nickname, Host: b.Host, Port: b.Port, Username: b.Username}
}

// hostBody is what a saved machine syncs as, over base (the account's copy,
// so fields this app doesn't keep, such as label, are kept). Whether it
// signs in with a key is this device's: it is sent for a new machine only,
// and an edit keeps the account's value.
func hostBody(m Machine, base account.HostBody) account.HostBody {
	b := base
	s := sharedFields(m)
	b.Nickname, b.Host, b.Port, b.Username = s.Nickname, s.Host, s.Port, s.Username
	if b.AuthKind == "" {
		b.AuthKind = "password"
		if m.KeyPath != "" {
			b.AuthKind = "key"
		}
	}
	return b
}

// sameHost reports whether a machine's shared fields equal body's.
func sameHost(m Machine, body account.HostBody) bool {
	return sharedFields(m) == sharedOf(body)
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
var SyncedMachinesChanged = mygo.NewEvent[[]SyncedMachine]("syncedMachines:changed")

var publishSyncedMachines = func(m []SyncedMachine) { SyncedMachinesChanged.Broadcast(m) }

// accountSync runs one sync at a time: a call waits for the one running and
// then makes its own, so it returns once a sync that began after it is done.
// failedFor is the account whose newest sync failed, "" if none: the host
// home's account avatar says "needs attention" while it is the signed-in one.
// It has its own lock, as accountState reads it while a sync holds mu.
type accountSync struct {
	mu        sync.Mutex
	failedMu  sync.Mutex
	failedFor string
}

// syncFailed is whether acct's newest sync failed.
func (d *Desk) syncFailed(acct string) bool {
	d.accountSync.failedMu.Lock()
	defer d.accountSync.failedMu.Unlock()
	return acct != "" && d.accountSync.failedFor == acct
}

// noteSync records how acct's sync ended and tells the page when that
// changes whether it needs attention.
func (d *Desk) noteSync(acct string, failed bool) {
	d.accountSync.failedMu.Lock()
	was := d.accountSync.failedFor == acct
	switch {
	case failed:
		d.accountSync.failedFor = acct
	case was:
		d.accountSync.failedFor = ""
	}
	d.accountSync.failedMu.Unlock()
	if was != failed {
		publishAccount(d.accountState(""))
	}
}

// SyncedMachines is the account's machines this device hasn't saved, as
// last synced (no network).
func (d *Desk) SyncedMachines() ([]SyncedMachine, error) {
	cur, _ := d.account.Current()
	if cur == nil {
		return []SyncedMachine{}, nil
	}
	d.storeMu.Lock()
	st, err := d.load()
	state, stateErr := d.loadSyncState()
	d.storeMu.Unlock()
	if err = errors.Join(err, stateErr); err != nil {
		return nil, err
	}
	if state.AccountID != cur.AccountID {
		// Another account's machines: nothing until this one has synced.
		return []SyncedMachine{}, nil
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
	cur, _ := d.account.Current()
	err := d.syncMachinesOnce(ctx)
	if errors.Is(err, account.ErrSignedOut) {
		publishAccount(d.accountState(""))
		return nil
	}
	// A sign-in to another account meanwhile is not this account failing.
	if cur != nil && !errors.Is(err, account.ErrAccountChanged) {
		d.noteSync(cur.AccountID, err != nil)
	}
	return err
}

func (d *Desk) syncMachinesOnce(ctx context.Context) error {
	cur, err := d.account.Current()
	if err != nil || cur == nil {
		return err
	}
	acct := cur.AccountID
	// still is false once the session is another account's (or gone): a
	// result for the old one is dropped.
	still := func() bool { c, _ := d.account.Current(); return c != nil && c.AccountID == acct }
	d.storeMu.Lock()
	state, err := d.loadSyncState()
	d.storeMu.Unlock()
	if err != nil {
		return err
	}
	switched := state.AccountID != acct
	if switched {
		// Another account (or the first sync): pull everything first and
		// adopt its ids before this device pushes anything.
		state = syncState{AccountID: acct}
	}
	pull, err := d.account.PullSince(ctx, acct, state.Mirror.Rev)
	if errors.Is(err, account.ErrAccountChanged) {
		return nil
	}
	if err != nil {
		return err
	}
	old := state.Mirror
	mirror := old.Apply(pull)
	// The ids the account is known to have held: a machine with one of
	// these that the account no longer lists was deleted elsewhere; any
	// other id it doesn't list was never acknowledged, and is pushed again.
	known := map[string]bool{}
	for _, h := range old.Hosts {
		known[h.ID] = true
	}
	_, tombstoned := account.RemoteHosts(pull.Items)
	for _, id := range tombstoned {
		known[id] = true
	}

	d.storeMu.Lock()
	if !still() {
		d.storeMu.Unlock()
		return nil
	}
	st, err := d.load()
	if err != nil {
		d.storeMu.Unlock()
		return err
	}
	latest, err := d.loadSyncState()
	if err != nil {
		d.storeMu.Unlock()
		return err
	}
	pending, baseline := latest.Deletes, latest.Baseline
	if switched {
		pending, baseline = nil, nil
		for i := range st.Machines {
			st.Machines[i].SyncID = ""
		}
	}
	changes, deletes, renamed, baseline := mergeMachines(&st, old, mirror, known, pending, baseline)
	if err := d.store(st); err != nil {
		d.storeMu.Unlock()
		return err
	}
	// As SaveMachine: the board cache follows a machine's id.
	for from, to := range renamed {
		d.boards.forget(from)
		d.boards.allow(to)
	}
	state = syncState{AccountID: acct, Mirror: mirror, Deletes: deletes, Baseline: baseline}
	if err := d.storeSyncState(state); err != nil {
		d.storeMu.Unlock()
		return err
	}
	d.storeMu.Unlock()

	for start := 0; start < len(changes); start += 100 {
		batch := changes[start:min(start+100, len(changes))]
		_, err := d.account.Push(ctx, acct, batch)
		if err == nil {
			// Acknowledged: what was written is what this device and the
			// account now agree on.
			err = d.ackBaseline(acct, batch)
		}
		if err != nil {
			// Nothing is lost: an unacknowledged id is pushed again next
			// time, and pending deletes stay pending. Another account's
			// session gets none of this account's changes.
			if errors.Is(err, account.ErrAccountChanged) {
				return nil
			}
			return err
		}
	}
	if len(changes) > 0 {
		// Read our own writes back, so the mirror holds what the account holds.
		pull, err := d.account.PullSince(ctx, acct, mirror.Rev)
		if errors.Is(err, account.ErrAccountChanged) {
			return nil
		}
		if err != nil {
			return err
		}
		d.storeMu.Lock()
		if !still() {
			d.storeMu.Unlock()
			return nil
		}
		state, err = d.loadSyncState()
		if err != nil {
			d.storeMu.Unlock()
			return err
		}
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

// ackBaseline records a pushed batch's bodies as agreed.
func (d *Desk) ackBaseline(acct string, batch []account.Change) error {
	d.storeMu.Lock()
	defer d.storeMu.Unlock()
	state, err := d.loadSyncState()
	if err != nil || state.AccountID != acct {
		return err
	}
	if state.Baseline == nil {
		state.Baseline = map[string]account.HostBody{}
	}
	for _, c := range batch {
		if b, ok := c.Body.(account.HostBody); ok && !c.Deleted {
			state.Baseline[c.ID] = sharedOf(b)
		}
	}
	return d.storeSyncState(state)
}

// mergeMachines applies the account's hosts (mirror; old is the copy last
// synced, known the ids the account is known to have held) to the saved
// machines and returns the changes to push, one per id. deletes are
// machines removed here and not yet pushed; it returns those left.
func mergeMachines(st *machineStore, old, mirror account.Mirror, known map[string]bool, deletes []string, baseline map[string]account.HostBody) (changes []account.Change, left []string, renamed map[string]string, nextBaseline map[string]account.HostBody) {
	renamed = map[string]string{}
	now := map[string]account.HostBody{}
	for _, h := range mirror.Hosts {
		now[h.ID] = h.Body
	}
	// A machine was edited here when its shared fields differ from what this
	// device last agreed with the account (its baseline; the last mirror for
	// a machine from before baselines). Device-local fields never count.
	agreed := func(id string) (account.HostBody, bool) {
		if b, ok := baseline[id]; ok {
			return b, true
		}
		for _, h := range old.Hosts {
			if h.ID == id {
				return sharedOf(h.Body), true
			}
		}
		return account.HostBody{}, false
	}
	// An edit made here since the last sync wins over the account's copy:
	// the last write to reach the service wins (§5.3), and this one hasn't.
	edited := map[int]bool{}
	for i, m := range st.Machines {
		if base, ok := agreed(m.SyncID); m.SyncID != "" && ok && sharedFields(m) != base {
			edited[i] = true
		}
	}
	local := make([]account.LocalHost, len(st.Machines))
	for i, m := range st.Machines {
		local[i] = account.LocalHost{SyncID: m.SyncID, Body: hostBody(m, account.HostBody{})}
	}
	plan, err := account.PlanHosts(local, mirror.Hosts, known)
	if err != nil {
		log.Printf("account sync: %v", err)
		return nil, deletes, renamed, baseline
	}
	// One change per id: the service refuses a push naming an id twice.
	seen := map[string]bool{}
	add := func(c account.Change) {
		if !seen[c.ID] {
			seen[c.ID] = true
			changes = append(changes, c)
		}
	}
	for i, id := range plan.Adopt {
		st.Machines[i].SyncID = id
	}
	for i, id := range plan.Push {
		st.Machines[i].SyncID = id
		add(account.Change{Collection: "hosts", ID: id, Body: hostBody(st.Machines[i], account.HostBody{})})
	}
	for i, m := range st.Machines {
		body, ok := now[m.SyncID]
		if !ok || plan.Push[i] != "" {
			continue
		}
		switch {
		case edited[i] && !sameHost(m, body):
			add(account.Change{Collection: "hosts", ID: m.SyncID, Body: hostBody(m, body)})
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
	// A machine still saved here (removed, then added again) keeps its item.
	inUse := map[string]bool{}
	for _, m := range st.Machines {
		inUse[m.SyncID] = true
	}
	for _, id := range plan.Delete {
		if !inUse[id] {
			add(account.Change{Collection: "hosts", ID: id, Deleted: true})
		}
	}
	for _, id := range deletes {
		if _, ok := now[id]; ok && !inUse[id] {
			add(account.Change{Collection: "hosts", ID: id, Deleted: true})
			left = append(left, id)
		}
	}
	// What this device and the account now agree on: a machine's shared
	// fields as they stand after the merge. One whose remote change couldn't
	// be applied here keeps its own, so it isn't pushed back as an edit.
	// A machine this sync writes keeps its old baseline until the service
	// acknowledges the write (ackBaseline): a refused push must leave the
	// edit an edit, to be sent again.
	nextBaseline = map[string]account.HostBody{}
	writing := map[string]bool{}
	for _, c := range changes {
		if !c.Deleted {
			writing[c.ID] = true
		}
	}
	for _, m := range st.Machines {
		if m.SyncID == "" {
			continue
		}
		if !writing[m.SyncID] {
			nextBaseline[m.SyncID] = sharedFields(m)
		} else if base, ok := agreed(m.SyncID); ok {
			nextBaseline[m.SyncID] = base
		}
	}
	return changes, left, renamed, nextBaseline
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
