package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/account"
	"github.com/jerryfane/herdrup-desktop/internal/guest"
)

// Shares through the HerdrUp account (design #698 §5.1, the shares
// collection; herdrup#700 option A): a guest grant bound to the account at
// its redemption (Access.AccountBound) is written to the account's shares,
// so every device signed in to it lists the share (SyncedShares) and can
// open it without an invitation (OpenSyncedShare). Leaving a bound share
// deletes the item, and a device that sees it deleted lets its grant go.
// Only the item's allowlisted fields travel (account.ShareBody); the
// device's guest identity never does.

// SyncedShare is one of the account's shares, for the page.
type SyncedShare struct {
	// ID is the item id, "<host_id>/<guest_id>" (OpenSyncedShare's).
	ID           string `json:"id"`
	Relay        string `json:"relay"`
	HostID       string `json:"hostID"`
	NodePub      string `json:"nodePub"`
	GuestID      string `json:"guestID"`
	AgentName    string `json:"agentName"`
	OwnerName    string `json:"ownerName"`
	MachineLabel string `json:"machineLabel"`
	ShareGram    bool   `json:"shareGram"`
	// Local says this device holds the grant.
	Local bool `json:"local"`
}

// SyncedSharesChanged tells the page the account's shares, or which of
// them this device holds, changed.
var SyncedSharesChanged = mygo.NewEvent[[]SyncedShare]("syncedShares:changed")

var publishSyncedShares = func(s []SyncedShare) { SyncedSharesChanged.Broadcast(s) }

// shareOp is a bound grant's write (Body) or delete of its shares item that
// this device owes the account the grant is bound to (Account): the
// account signed in at its redemption, which need not be the one a sync
// state holds yet, so a state of another account keeps it until that one
// syncs. Sent, on a write, is the base_rev a request carried it on, and
// SentAt the account revision this device had pulled to then (the
// mirror's), saved before the request goes (journalShareWrites): from
// then on it may have landed, however its answer went, and mergeShares
// settles it by what the account holds rather than writing it afresh (as
// the web's journal of writes sent, src/web/shares.ts SharesRecord sent).
// A dispatch that provably wrote nothing puts both back as they were
// before it (unsendShareWrites). Unproven is a sent create a full pull
// couldn't settle, and whose proof the service didn't give (shareProofs):
// it is neither sent again nor let go until a later ask settles it.
type shareOp struct {
	ID       string             `json:"id"`
	Account  string             `json:"account"`
	Body     *account.ShareBody `json:"body,omitempty"`
	Sent     *int64             `json:"sent,omitempty"`
	SentAt   int64              `json:"sentAt,omitempty"`
	Unproven bool               `json:"unproven,omitempty"`
}

// needsProof is whether op is a create (base 0) sent whose landing the
// pulls since can't rule out by themselves: a full one at revision rev
// (full) past SentAt, or an earlier one whose proof is still owed
// (Unproven). Any landing of it has a revision past SentAt, and any
// tombstone of that landing one past that. An incremental pull from at
// or below SentAt can't miss either: it lists the row or its tombstone,
// or the service refuses it (410) once that tombstone was pruned
// (sync_floor, AccountService DESIGN.md §5.5). A full pull lists no
// pruned tombstone, so its lacking the item proves nothing, unless the
// account has written nothing since (rev at or below SentAt), or the
// service still holds its history from where op was sent (retainedFrom,
// shareProofs).
func needsProof(op shareOp, full bool, rev int64) bool {
	return op.Sent != nil && *op.Sent == 0 && (op.Unproven || full && rev > op.SentAt)
}

// retainedFrom is where a pull starts that, not refused, proves a full
// pull lists any landing of op since it was sent: SentAt, or 1 for one
// sent on an empty account (a pull from 0 is never refused; a tombstone
// of a landing there has a revision past 1).
func retainedFrom(op shareOp) int64 {
	return max(op.SentAt, 1)
}

// shareProofs asks the service, for each sent create of acct in writes
// (the caller's snapshot of syncState.ShareWrites, nothing read here)
// that pull p doesn't list and can't settle by itself (needsProof),
// whether it still holds its history from where the create was sent
// (retainedFrom): one page per revision (account.Retains), lowest first;
// once it does, it does from every later one. proofs maps the id of each
// create answered for to the answer, and holds no other: the one set the
// merge or the readback's settling decides by (settleShareProofs). One
// missing is unknown: the error that left it so comes back with what was
// answered, and the creates it leaves unknown are kept as they are
// (Unproven).
func (d *Desk) shareProofs(ctx context.Context, round account.Round, acct string, p account.Pull, writes []shareOp) (map[string]bool, error) {
	listed := map[string]bool{}
	for _, it := range p.Items {
		if it.Collection == "shares" {
			listed[it.ID] = true
		}
	}
	from := map[string]int64{}
	for _, op := range writes {
		if op.Account == acct && !listed[op.ID] && needsProof(op, p.Full, p.Rev) {
			from[op.ID] = retainedFrom(op)
		}
	}
	revs := slices.Compact(slices.Sorted(maps.Values(from)))
	answers := map[int64]bool{}
	var err error
	for i, rev := range revs {
		var kept bool
		if kept, err = d.account.Retains(ctx, round, rev); err != nil {
			break
		}
		if kept {
			for _, later := range revs[i:] {
				answers[later] = true
			}
			break
		}
		answers[rev] = false
	}
	proofs := map[string]bool{}
	for id, rev := range from {
		if kept, answered := answers[rev]; answered {
			proofs[id] = kept
		}
	}
	return proofs, err
}

// settleShareProofs settles, by the service's answers (proofs,
// shareProofs), the sent creates of acct a committed full readback left
// Unproven: one whose history from its sending is kept never landed (the
// readback would list it), owed again as never proven otherwise, and goes
// at the next push; one whose history was pruned past it may have landed
// and been deleted: it goes, superseded, as the readback would have let
// it go, and its grant here with it, in this save (dropGoneShares), not
// left to a later merge another account's sync may come before. Only a
// round still running (still) settles anything; finished (every create
// asked for answered), the round's status is the readback's (LastSync).
func (d *Desk) settleShareProofs(ctx context.Context, still func() bool, acct string, proofs map[string]bool, finished bool) error {
	if !d.storeMu.LockCtx(ctx) {
		return ctx.Err()
	}
	ended, err := d.settleShareProofsLocked(still, acct, proofs, finished)
	d.storeMu.Unlock()
	d.finishGuests(ended)
	if len(ended) > 0 || err != nil {
		d.announceShares()
	}
	return err
}

// settleShareProofsLocked is settleShareProofs with d.storeMu held; it
// returns the connections its dropped grants ended, for the caller to
// finish once d.storeMu is free.
func (d *Desk) settleShareProofsLocked(still func() bool, acct string, proofs map[string]bool, finished bool) ([]detached, error) {
	if !still() {
		return nil, errSyncAbandoned
	}
	state, err := d.loadSyncState()
	if err != nil || state.AccountID != acct {
		return nil, err
	}
	gone := map[string]bool{}
	writes := state.ShareWrites[:0:0]
	for _, op := range state.ShareWrites {
		if retained, answered := proofs[op.ID]; answered && op.Account == acct && op.Unproven && op.Sent != nil && *op.Sent == 0 {
			if !retained {
				gone[op.ID] = true
				continue
			}
			op.Unproven = false
		}
		writes = append(writes, op)
	}
	state.ShareWrites = writes
	if finished {
		state.LastSync = &AccountSyncStatus{LastSyncedMs: time.Now().UnixMilli(), Machines: len(state.Mirror.Hosts), Prompts: len(state.Mirror.Prompts)}
	}
	// The grants go before the state that no longer owes their writes is
	// saved: a failure leaves the writes as they were, for a later ask.
	ended, err := d.dropGoneShares(acct, gone, goneShareMark{History: state.History, Rev: state.Mirror.Rev})
	if err != nil {
		return ended, err
	}
	if err := d.storeSyncState(state); err != nil {
		return ended, err
	}
	d.pruneGoneSharesLocked(acct, state, false)
	return ended, nil
}

// goneShareMark records the account sync history and revision at which a share
// was observed deleted before its local grant was removed. A newer committed
// live mirror row (higher History, or same History with Rev > mark.Rev)
// supersedes an unpruned marker automatically.
type goneShareMark struct {
	History int64 `json:"history"`
	Rev     int64 `json:"rev"`
}

func goneMarkNewer(a, b goneShareMark) bool {
	return a.History > b.History || (a.History == b.History && a.Rev > b.Rev)
}

// shareMasked reports whether mark still suppresses share id against state.
// A committed live mirror row from a newer history or a strictly higher server
// revision supersedes any stale unpruned deletion marker.
func shareMasked(mark goneShareMark, state syncState, acct, id string) bool {
	if state.AccountID == acct {
		if state.History > mark.History {
			return false
		}
		for _, s := range state.Mirror.Shares {
			if s.ID == id {
				return s.Rev <= mark.Rev
			}
		}
	}
	return true
}

func (d *Desk) goneSharesPath() string { return filepath.Join(d.dir, "sync-gone-shares.json") }

// loadGoneSharesLocked reads sync-gone-shares.json: share deletion markers per
// account recorded durably before removing their local grants.
// d.storeMu must be held.
func (d *Desk) loadGoneSharesLocked() (map[string]map[string]goneShareMark, error) {
	raw, err := os.ReadFile(d.goneSharesPath())
	if errors.Is(err, os.ErrNotExist) {
		return map[string]map[string]goneShareMark{}, nil
	}
	if err != nil {
		return nil, err
	}
	var m map[string]map[string]goneShareMark
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("gone shares %s: %w", d.goneSharesPath(), err)
	}
	if m == nil {
		m = map[string]map[string]goneShareMark{}
	}
	return m, nil
}

// saveGoneSharesLocked writes sync-gone-shares.json atomically (or removes it
// when empty). d.storeMu must be held.
func (d *Desk) saveGoneSharesLocked(m map[string]map[string]goneShareMark) error {
	clean := map[string]map[string]goneShareMark{}
	for acct, marks := range m {
		if acct == "" || len(marks) == 0 {
			continue
		}
		sub := map[string]goneShareMark{}
		for id, mark := range marks {
			if id != "" {
				sub[id] = mark
			}
		}
		if len(sub) > 0 {
			clean[acct] = sub
		}
	}
	if len(clean) == 0 {
		err := os.Remove(d.goneSharesPath())
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	raw, err := json.MarshalIndent(clean, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(d.goneSharesPath(), raw)
}

func (d *Desk) recordGoneSharesMemLocked(acct string, gone map[string]bool, mark goneShareMark) {
	if acct == "" || len(gone) == 0 {
		return
	}
	if d.accountSync.goneShares == nil {
		d.accountSync.goneShares = map[string]map[string]goneShareMark{}
	}
	sub := d.accountSync.goneShares[acct]
	if sub == nil {
		sub = map[string]goneShareMark{}
		d.accountSync.goneShares[acct] = sub
	}
	for id := range gone {
		if id == "" {
			continue
		}
		if cur, ok := sub[id]; !ok || goneMarkNewer(mark, cur) {
			sub[id] = mark
		}
	}
}

// recordGoneSharesLocked durably records gone share markers for acct BEFORE
// dropGoneShares removes local grants, so a failed sync-state save or process
// restart cannot list or reopen a deleted share from the stale mirror.
// d.storeMu must be held.
func (d *Desk) recordGoneSharesLocked(acct string, gone map[string]bool, mark goneShareMark) error {
	if acct == "" || len(gone) == 0 {
		return nil
	}
	m, err := d.loadGoneSharesLocked()
	if err != nil {
		return err
	}
	sub := m[acct]
	if sub == nil {
		sub = map[string]goneShareMark{}
	}
	changed := false
	for id := range gone {
		if id == "" {
			continue
		}
		if cur, ok := sub[id]; !ok || goneMarkNewer(mark, cur) {
			sub[id] = mark
			changed = true
		}
	}
	if !changed {
		return nil
	}
	m[acct] = sub
	return d.saveGoneSharesLocked(m)
}

// pruneGoneSharesLocked removes only those deletion markers for acct whose
// disposition state now records on disk (or whose mark a newer committed live
// row superseded): any id still masked in acct's unsettled ShareWrites (or in
// Mirror.Shares when mirrorFresh is false) stays masked until a commit settles
// it. d.storeMu must be held.
func (d *Desk) pruneGoneSharesLocked(acct string, state syncState, mirrorFresh bool) {
	if acct == "" {
		return
	}
	owed := map[string]bool{}
	for _, op := range state.ShareWrites {
		if op.Account == acct {
			owed[op.ID] = true
		}
	}
	inMirror := map[string]bool{}
	if !mirrorFresh && state.AccountID == acct {
		for _, s := range state.Mirror.Shares {
			inMirror[s.ID] = true
		}
	}
	keep := func(id string, mark goneShareMark) bool {
		return (owed[id] || inMirror[id]) && shareMasked(mark, state, acct, id)
	}
	if mem := d.accountSync.goneShares[acct]; len(mem) > 0 {
		for id, mark := range mem {
			if !keep(id, mark) {
				delete(mem, id)
			}
		}
		if len(mem) == 0 {
			delete(d.accountSync.goneShares, acct)
		}
	}
	m, err := d.loadGoneSharesLocked()
	if err != nil || len(m[acct]) == 0 {
		return
	}
	changed := false
	for id, mark := range m[acct] {
		if !keep(id, mark) {
			delete(m[acct], id)
			changed = true
		}
	}
	if !changed {
		return
	}
	if len(m[acct]) == 0 {
		delete(m, acct)
	}
	_ = d.saveGoneSharesLocked(m)
}

// clearGoneShareLocked removes a single share id from acct's in-memory and
// durable deletion markers (e.g. after a fresh local accept replaces it).
// d.storeMu must be held.
func (d *Desk) clearGoneShareLocked(acct, id string) {
	if acct == "" || id == "" {
		return
	}
	if mem := d.accountSync.goneShares[acct]; len(mem) > 0 {
		delete(mem, id)
		if len(mem) == 0 {
			delete(d.accountSync.goneShares, acct)
		}
	}
	m, err := d.loadGoneSharesLocked()
	if err != nil || len(m[acct]) == 0 {
		return
	}
	if _, ok := m[acct][id]; !ok {
		return
	}
	delete(m[acct], id)
	if len(m[acct]) == 0 {
		delete(m, acct)
	}
	_ = d.saveGoneSharesLocked(m)
}

// allGoneSharesLocked returns the union of durable and in-memory deletion
// markers across all accounts, keeping the newer mark when both record an id.
// d.storeMu must be held.
func (d *Desk) allGoneSharesLocked() (map[string]map[string]goneShareMark, error) {
	m, err := d.loadGoneSharesLocked()
	if err != nil {
		return nil, err
	}
	for acct, mem := range d.accountSync.goneShares {
		if len(mem) == 0 {
			continue
		}
		sub := m[acct]
		if sub == nil {
			sub = map[string]goneShareMark{}
			m[acct] = sub
		}
		for id, mark := range mem {
			if cur, ok := sub[id]; !ok || goneMarkNewer(mark, cur) {
				sub[id] = mark
			}
		}
	}
	return m, nil
}

// goneSharesLocked returns the active deletion markers for acct (union of
// durable sync-gone-shares.json and in-memory markers). d.storeMu must be held.
func (d *Desk) goneSharesLocked(acct string) (map[string]goneShareMark, error) {
	if acct == "" {
		return nil, nil
	}
	m, err := d.allGoneSharesLocked()
	if err != nil {
		return nil, err
	}
	return m[acct], nil
}

// errShareGone is an open of a share the account no longer lists.
var errShareGone = errors.New("This share is no longer on your HerdrUp account.")

// SyncedShares is the account's shares as last synced, and the bound
// grants accepted here not yet written there (no network); none while
// signed out.
func (d *Desk) SyncedShares() ([]SyncedShare, error) {
	cur, _ := d.account.Current()
	if cur == nil {
		return []SyncedShare{}, nil
	}
	d.storeMu.Lock()
	state, err := d.loadSyncState()
	var gone map[string]goneShareMark
	if err == nil {
		gone, err = d.goneSharesLocked(cur.AccountID)
	}
	d.storeMu.Unlock()
	if err != nil {
		return nil, err
	}
	grants, err := d.guestStore.List()
	if err != nil {
		return nil, err
	}
	return syncedSharesOf(cur.AccountID, state, grants, gone), nil
}

// announceShares tells the page the shares now (SyncedShares).
func (d *Desk) announceShares() {
	if shares, err := d.SyncedShares(); err == nil {
		publishSyncedShares(shares)
	}
}

// syncedSharesOf lists account acct's shares: the mirror's (state's, when
// it is acct's) but those left here or observed deleted before state saved
// (gone), then the writes owed to acct. Local marks those whose grant this
// device holds (grants).
func syncedSharesOf(acct string, state syncState, grants []guest.Access, gone map[string]goneShareMark) []SyncedShare {
	held := map[string]bool{}
	for _, g := range grants {
		held[g.ShareID()] = true
	}
	owed := func(ops []shareOp, id string) bool {
		return slices.ContainsFunc(ops, func(op shareOp) bool { return op.Account == acct && op.ID == id })
	}
	masked := func(id string) bool {
		mark, ok := gone[id]
		return ok && shareMasked(mark, state, acct, id)
	}
	out := []SyncedShare{}
	add := func(id string, b account.ShareBody) {
		out = append(out, SyncedShare{ID: id, Relay: b.Relay, HostID: b.HostID, NodePub: b.NodePub, GuestID: b.GuestID, AgentName: b.AgentName,
			OwnerName: b.OwnerName, MachineLabel: b.MachineLabel, ShareGram: b.ShareGram != nil && *b.ShareGram, Local: held[id]})
	}
	listed := map[string]bool{}
	if state.AccountID == acct {
		for _, s := range state.Mirror.Shares {
			if !masked(s.ID) && !owed(state.ShareDeletes, s.ID) {
				add(s.ID, s.Body)
				listed[s.ID] = true
			}
		}
	}
	for _, op := range state.ShareWrites {
		if op.Account == acct && op.Body != nil && !masked(op.ID) && !listed[op.ID] {
			add(op.ID, *op.Body)
			listed[op.ID] = true
		}
	}
	return out
}

// How a bound share's item stands in its account (guest.Access.AccountShare).
const (
	shareConfirmed = "confirmed"
	shareQueued    = "queued"
	shareRefused   = "refused"
	shareRemoved   = "removed"
)

// acceptShareWait bounds the sync an accept runs to confirm its share's
// write (AcceptGuestInvitation): past it, the share is told as queued.
var acceptShareWait = 20 * time.Second

// shareRefusalWords is what a share's refused write says, by the service's
// code: its quota (AccountService src/sync.ts: a cap's CHECK constraint
// failed, 403 quota; COLLECTION_CAPS.shares is 500), or any other.
func shareRefusalWords(code string) string {
	if code == "quota" {
		return "Your HerdrUp account holds as many shares as it can. Remove one from it, and this one is added at the next sync."
	}
	return "Your HerdrUp account didn't take this share. It is tried again at the next sync."
}

// accountShareOf is how bound grant a's item stands in its account by
// state (guest.Access.AccountShare, AccountShareProblem): confirmed while
// the account's synced shares hold it, refused while its owed write was
// last turned down, queued while it is owed, else nothing is known. That
// the account once held it (SharesHeld: a write it took, before the
// readback) confirms it only while the account's state, when it is this
// state's, says nothing newer: a readback that saw it deleted since
// (SharesGone) means it isn't there.
func accountShareOf(state syncState, a guest.Access) (string, string) {
	if !a.AccountBound || a.Account == "" {
		return "", ""
	}
	id := a.ShareID()
	current := state.AccountID == a.Account
	if current && slices.ContainsFunc(state.Mirror.Shares, func(s account.RemoteShare) bool { return s.ID == id }) {
		return shareConfirmed, ""
	}
	owed := slices.ContainsFunc(state.ShareWrites, func(op shareOp) bool { return op.ID == id && op.Account == a.Account })
	deleted := current && slices.Contains(state.SharesGone, id)
	if !owed && !deleted && slices.Contains(state.SharesHeld[a.Account], id) {
		return shareConfirmed, ""
	}
	if owed {
		if code, ok := state.ShareRefusals[id]; ok {
			return shareRefused, shareRefusalWords(code)
		}
		return shareQueued, ""
	}
	return "", ""
}

// boundShareGone reports whether bound share id of account acct is currently
// masked by an active (un-superseded) deletion marker.
func (d *Desk) boundShareGone(acct, id string) (bool, error) {
	if acct == "" || id == "" {
		return false, nil
	}
	d.storeMu.Lock()
	state, err := d.loadSyncState()
	var gone map[string]goneShareMark
	if err == nil {
		gone, err = d.goneSharesLocked(acct)
	}
	d.storeMu.Unlock()
	if err != nil {
		return false, err
	}
	mark, ok := gone[id]
	return ok && shareMasked(mark, state, acct, id), nil
}

// withAccountShares tells each bound grant of list how its item stands in
// its account (accountShareOf), filtering out bound grants already observed
// deleted (even if removing their on-disk grant was deferred because writing
// the durable deletion marker failed).
func (d *Desk) withAccountShares(list []guest.Access) ([]guest.Access, error) {
	if !slices.ContainsFunc(list, func(a guest.Access) bool { return a.AccountBound }) {
		return list, nil
	}
	cur, _ := d.account.Current()
	d.storeMu.Lock()
	state, err := d.loadSyncState()
	var goneAll map[string]map[string]goneShareMark
	if err == nil {
		goneAll, err = d.allGoneSharesLocked()
	}
	d.storeMu.Unlock()
	if err != nil {
		return nil, err
	}
	out := make([]guest.Access, 0, len(list))
	for _, a := range list {
		if a.AccountBound {
			acct := a.Account
			if acct == "" && cur != nil {
				acct = cur.AccountID
			}
			if mark, ok := goneAll[acct][a.ShareID()]; ok && shareMasked(mark, state, acct, a.ShareID()) {
				continue
			}
			a.AccountShare, a.AccountShareProblem = accountShareOf(state, a)
		}
		out = append(out, a)
	}
	return out, nil
}

// confirmShare runs the one sync round a bound accept owns, within
// acceptShareWait, so the grant just accepted can say whether its account
// took its item; a round that can't leaves the owed write to the next
// sync (startMachineSync's, or any other).
func (d *Desk) confirmShare() {
	ctx, cancel := context.WithTimeout(context.Background(), acceptShareWait)
	defer cancel()
	_ = d.SyncMachines(ctx)
}

// journalShareWrites saves, before a push goes, that each share write it
// carries (part, account acct's) was sent on its base_rev (shareOp.Sent),
// with the revision the mirror was pulled to (SentAt): from then on its
// outcome may be unknown, an answer lost, or an answer whose settling
// couldn't be saved, and the merge settles it by what the account holds
// instead of writing it afresh (mergeShares). If the journal can't be
// saved, the push doesn't go. It returns what it marked, for
// unsendShareWrites.
func (d *Desk) journalShareWrites(ctx context.Context, acct string, part []account.Change) (map[string]shareMark, error) {
	sent := map[string]int64{}
	for _, c := range part {
		if c.Collection == "shares" && !c.Deleted {
			sent[c.ID] = c.Base
		}
	}
	if len(sent) == 0 {
		return nil, nil
	}
	if !d.storeMu.LockCtx(ctx) {
		return nil, ctx.Err()
	}
	defer d.storeMu.Unlock()
	state, err := d.loadSyncState()
	if err != nil {
		return nil, err
	}
	marks := map[string]shareMark{}
	for i, op := range state.ShareWrites {
		if base, ok := sent[op.ID]; ok && op.Account == acct {
			marks[op.ID] = shareMark{base: base, at: state.Mirror.Rev, was: op.Sent, wasAt: op.SentAt}
			state.ShareWrites[i].Sent, state.ShareWrites[i].SentAt = &base, state.Mirror.Rev
		}
	}
	if err := d.storeSyncState(state); err != nil {
		return nil, err
	}
	return marks, nil
}

// shareMark is a share write's journal as one dispatch set it (base, at:
// shareOp.Sent and SentAt) and as it was before (was, wasAt).
type shareMark struct {
	base, at int64
	was      *int64
	wasAt    int64
}

// unsendShareWrites takes back what a dispatch's journal marked (marks,
// journalShareWrites) once the dispatch provably wrote nothing (the
// service refused it, or it never connected): each write's journal is
// again what it was, never sent (so no later pull, a full one included,
// makes this dispatch ambiguous, needsProof), or an earlier dispatch
// that may still have landed. A journal changed since is left alone.
func (d *Desk) unsendShareWrites(ctx context.Context, acct string, marks map[string]shareMark) error {
	if len(marks) == 0 {
		return nil
	}
	if !d.storeMu.LockBestEffort(ctx) {
		return ctx.Err()
	}
	defer d.storeMu.Unlock()
	state, err := d.loadSyncState()
	if err != nil {
		return err
	}
	changed := false
	for i, op := range state.ShareWrites {
		if m, ok := marks[op.ID]; ok && op.Account == acct && op.Sent != nil && *op.Sent == m.base && op.SentAt == m.at {
			state.ShareWrites[i].Sent, state.ShareWrites[i].SentAt = m.was, m.wasAt
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return d.storeSyncState(state)
}

// settleShareWrites settles the share writes of applied (a push's answer
// for account acct) the service took: none is owed any more, so none goes
// again (on a tombstone it would bring the share back), and acct is known
// to hold each (SharesHeld), before the round's readback, which may fail,
// and whichever account signs in next. If that can't be saved, the writes
// stay journaled as sent, and the merge settles them by the account's
// history (mergeShares).
func (d *Desk) settleShareWrites(ctx context.Context, acct string, applied []appliedChange) error {
	var took []string
	for _, a := range applied {
		if a.Collection == "shares" && !a.Deleted {
			took = append(took, a.ID)
		}
	}
	if len(took) == 0 {
		return nil
	}
	if !d.storeMu.LockBestEffort(ctx) {
		return ctx.Err()
	}
	defer d.storeMu.Unlock()
	state, err := d.loadSyncState()
	if err != nil || state.AccountID != acct {
		return err
	}
	state.ShareWrites = slices.DeleteFunc(state.ShareWrites, func(op shareOp) bool { return op.Account == acct && slices.Contains(took, op.ID) })
	state.SharesHeld = sharesHeldBy(state.SharesHeld, acct, nil, state.SharesHeld[acct], took)
	return d.storeSyncState(state)
}

// sharesHeldBy is held (SharesHeld) with account acct's set made the ids
// of live and those of each of more, once each and in order; the other
// accounts' sets are as they were.
func sharesHeldBy(held map[string][]string, acct string, live []account.RemoteShare, more ...[]string) map[string][]string {
	var ids []string
	for _, s := range live {
		ids = append(ids, s.ID)
	}
	for _, m := range more {
		ids = append(ids, m...)
	}
	slices.Sort(ids)
	ids = slices.Compact(ids)
	out := maps.Clone(held)
	if out == nil {
		out = map[string][]string{}
	}
	if len(ids) == 0 {
		delete(out, acct)
	} else {
		out[acct] = ids
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// noteShareRefusals is ShareRefusals after a round: prev, with the round's
// refusals (refused, by id) added, the writes the service took (acked) let
// go, and only writes still owed (writes) kept.
func noteShareRefusals(prev map[string]string, writes []shareOp, acked []account.Change, refused map[string]string) map[string]string {
	out := maps.Clone(prev)
	if out == nil {
		out = map[string]string{}
	}
	maps.Copy(out, refused)
	for _, c := range acked {
		if c.Collection == "shares" && !c.Deleted {
			delete(out, c.ID)
		}
	}
	maps.DeleteFunc(out, func(id, _ string) bool {
		return !slices.ContainsFunc(writes, func(op shareOp) bool { return op.ID == id })
	})
	if len(out) == 0 {
		return nil
	}
	return out
}

// shareBodyOf is a bound grant's shares item.
func shareBodyOf(a guest.Access) (account.ShareBody, error) {
	b, ok := account.NewShareBody(a.Endpoint.Relay, a.Endpoint.AccountHost(), a.Endpoint.HostPublicKey, a.GuestID, a.AgentName, a.OwnerName, a.MachineLabel)
	if !ok {
		return account.ShareBody{}, errors.New("this share's address can't be kept on a HerdrUp account")
	}
	return b, nil
}

// noteShare records what this device owes the account a bound grant is
// bound to (Access.Account): its item written, or with leave deleted. It is
// owed to that account whichever is signed in: under another, it waits in
// the sync state until that account syncs again (mergeShares), and nothing
// of it reaches the account signed in. A grant saved before its account
// was kept takes the account an unsent write of it was owed to, else the
// account whose synced shares hold it; with neither, nothing is owed.
// Either replaces any owed before. Then it tells the page; the caller
// owns the sync that sends it (a Leave's round soon, an accept's own one).
func (d *Desk) noteShare(a guest.Access, leave bool) error {
	op := shareOp{ID: a.ShareID(), Account: a.Account}
	if !leave {
		body, err := shareBodyOf(a)
		if err != nil {
			return err
		}
		op.Body = &body
	}
	d.storeMu.Lock()
	state, err := d.loadSyncState()
	if err == nil {
		if op.Account == "" && leave {
			if i := slices.IndexFunc(state.ShareWrites, func(o shareOp) bool { return o.ID == op.ID }); i >= 0 {
				op.Account = state.ShareWrites[i].Account
			} else if slices.ContainsFunc(state.Mirror.Shares, func(s account.RemoteShare) bool { return s.ID == op.ID }) {
				op.Account = state.AccountID
			}
		}
		other := func(o shareOp) bool { return o.ID == op.ID }
		state.ShareWrites = slices.DeleteFunc(state.ShareWrites, other)
		state.ShareDeletes = slices.DeleteFunc(state.ShareDeletes, other)
		if op.Account != "" {
			if leave {
				state.ShareDeletes = append(state.ShareDeletes, op)
			} else {
				state.ShareWrites = append(state.ShareWrites, op)
			}
		}
		err = d.storeSyncState(state)
		if err == nil && !leave && op.Account != "" {
			d.clearGoneShareLocked(op.Account, op.ID)
		}
	}
	d.storeMu.Unlock()
	if err != nil {
		return err
	}
	d.announceShares()
	return nil
}

// mergeShares plans account acct's shares changes from the mirror after a
// pull (mirror; full, at revision rev: the pull that brought it, and what
// the service answered of its history, proofs, shareProofs), the ids
// the account is known to have held (known, as syncPass builds it for
// hosts and prompts), the writes and deletes owed (as shareOp, other
// accounts' kept as they are) and the base revisions (revs, as baseRevs):
//   - an owed write the account holds has landed (this device's, or a copy
//     of the grant from another): it goes;
//   - one whose item the account held and no longer does was left
//     elsewhere: it goes, and so does the grant (gone);
//   - one a request already carried (Sent) is settled, never written
//     afresh: it goes again, on that base, only once the account's
//     history proves it never landed: its item where it was sent (the same
//     base revision: a tombstone not passed, or none), read by pulls that
//     each would have shown a landing since (needsProof: an absent item
//     after a full pull proves nothing for a create, unless the account
//     wrote nothing since, or the service still holds its history from
//     where the create was sent). Otherwise someone else's change
//     superseded it (a tombstone or another write past that base, and not
//     held), or may have (a create a full pull can't rule out, deleted
//     elsewhere, its tombstone pruned): it goes, and so does the grant
//     (gone), as a leave elsewhere would have it. A create that never
//     landed is lost so only past a dispatch with no answer (or an answer
//     whose settling couldn't be saved) and a full pull after a tombstone
//     since was pruned; the invitation can be accepted again. One whose
//     proof the service didn't give is kept as it is, unsent (Unproven);
//   - any other is written, on the revision last seen of its item;
//   - an owed delete of an item the account holds is sent, on its
//     revision; one of an item it doesn't hold is done.
//
// gone are the known items the account no longer holds, and the items of
// superseded writes: this device's bound grants for them go.
func mergeShares(acct string, mirror []account.RemoteShare, known map[string]bool, writes, deletes []shareOp, revs map[string]int64, full bool, rev int64, proofs map[string]bool) (changes []account.Change, nextWrites, nextDeletes []shareOp, gone map[string]bool) {
	held := map[string]int64{}
	for _, s := range mirror {
		held[s.ID] = s.Rev
	}
	gone = map[string]bool{}
	for id := range known {
		if _, ok := held[id]; !ok {
			gone[id] = true
		}
	}
	for _, op := range writes {
		if op.Account != acct {
			nextWrites = append(nextWrites, op)
			continue
		}
		if _, ok := held[op.ID]; ok || gone[op.ID] || op.Body == nil {
			continue
		}
		base := revs["shares/"+op.ID]
		if op.Sent != nil && *op.Sent != base {
			gone[op.ID] = true
			continue
		}
		if needsProof(op, full, rev) {
			retained, answered := proofs[op.ID]
			if !answered {
				op.Unproven = true
				nextWrites = append(nextWrites, op)
				continue
			}
			if !retained {
				gone[op.ID] = true
				continue
			}
			op.Unproven = false
		}
		changes = append(changes, account.Write("shares", op.ID, base, *op.Body))
		nextWrites = append(nextWrites, op)
	}
	for _, op := range deletes {
		if op.Account != acct {
			nextDeletes = append(nextDeletes, op)
			continue
		}
		if rev, ok := held[op.ID]; ok {
			changes = append(changes, account.Delete("shares", op.ID, rev))
			nextDeletes = append(nextDeletes, op)
		}
	}
	return changes, nextWrites, nextDeletes, gone
}

// dropGoneShares lets go of this device's bound grants whose shares item
// account acct deleted (gone, by item id). Each grant's open connection
// ends as the grant is removed (detachGuest), before anything after it can
// fail: a later removal's or the sync's commit's failure leaves no grant
// for a retry to find, so nothing would end it then. It returns what it
// ended, for the caller to finish (finishGuests) once d.storeMu is free,
// whatever happened after. A plain grant is never dropped: sync knows
// nothing of it; nor is one bound to another account, whose collection
// this is not. d.storeMu must be held.
func (d *Desk) dropGoneShares(acct string, gone map[string]bool, mark goneShareMark) ([]detached, error) {
	if len(gone) == 0 {
		return nil, nil
	}
	// Block both open paths in memory and detach live guest sessions as soon as
	// deletion is observed, even if writing the durable marker fails. The
	// on-disk grant is still removed only after the durable marker is stored so
	// a restart before recovery cannot resurrect a removed share.
	d.recordGoneSharesMemLocked(acct, gone, mark)
	grants, listErr := d.guestStore.List()
	var ended []detached
	if listErr == nil {
		for _, g := range grants {
			if g.AccountBound && (g.Account == "" || g.Account == acct) && gone[g.ShareID()] {
				ended = append(ended, d.detachGuest(g.ID()))
			}
		}
	}
	if err := d.recordGoneSharesLocked(acct, gone, mark); err != nil {
		return ended, err
	}
	if listErr != nil {
		return ended, listErr
	}
	for _, g := range grants {
		if g.AccountBound && (g.Account == "" || g.Account == acct) && gone[g.ShareID()] {
			if err := d.guestStore.Remove(g.ID()); err != nil {
				return ended, err
			}
		}
	}
	return ended, nil
}

// OpenSyncedShare opens one of the account's shares on this device (id,
// a SyncedShare's): one this device holds connects as ConnectGuest does;
// otherwise this device joins it by a returning hello with the account's
// statement and no invitation (guest.Open), saves the bound grant, and
// connects.
func (d *Desk) OpenSyncedShare(ctx context.Context, id string) error {
	cur, _ := d.account.Current()
	if cur == nil {
		return account.ErrSignedOut
	}
	d.guestAcceptMu.Lock()
	access, err := d.openSyncedShare(ctx, cur.AccountID, id)
	d.guestAcceptMu.Unlock()
	if err != nil {
		return err
	}
	d.syncGuestGram()
	d.announceShares()
	return d.ConnectGuest(access.ID())
}

// openSyncedShare is OpenSyncedShare's grant: the one held, or the one
// guest.Open admits and this saves. d.guestAcceptMu must be held.
//
// A sync can take the share away while herdr admits this device (another
// device left it): the grant is saved only if, under d.storeMu, the lock a
// sync's tombstones are reconciled under (dropGoneShares, commitMerge),
// the account herdr admitted is still the one signed in and the sync
// state's, and the share is still live in its synced shares with no leave
// owed. Otherwise nothing is saved, and the admitted session, which
// guest.Open has closed, is not opened again: an open that lost the share
// is errShareGone, one that lost the sign-in guest.ErrSignInChanged. A
// sync after the save sees the grant and drops it on the share's
// tombstone, since the save is ordered with the mirror it checked.
func (d *Desk) openSyncedShare(ctx context.Context, acct, id string) (guest.Access, error) {
	d.storeMu.Lock()
	state, err := d.loadSyncState()
	var gone map[string]goneShareMark
	if err == nil {
		gone, err = d.goneSharesLocked(acct)
	}
	d.storeMu.Unlock()
	if err != nil {
		return guest.Access{}, err
	}
	if mark, ok := gone[id]; ok && shareMasked(mark, state, acct, id) {
		return guest.Access{}, errShareGone
	}
	grants, err := d.guestStore.List()
	if err != nil {
		return guest.Access{}, err
	}
	if i := slices.IndexFunc(grants, func(g guest.Access) bool { return g.ShareID() == id }); i >= 0 {
		return grants[i], nil
	}
	body := liveShare(state, acct, id)
	if body == nil {
		return guest.Access{}, errShareGone
	}
	pub, err := base64.RawURLEncoding.DecodeString(body.NodePub)
	if err != nil {
		return guest.Access{}, errShareGone
	}
	identity, err := d.guestIdentity()
	if err != nil {
		return guest.Access{}, err
	}
	share := guest.Access{GuestID: body.GuestID, MachineLabel: body.MachineLabel, OwnerName: body.OwnerName, AgentName: body.AgentName,
		Endpoint: guest.Endpoint{Relay: body.Relay, HostID: body.HostID, HostPublicKey: pub}}
	access, err := guest.Open(ctx, share, identity, time.Now(), d.guestStatements())
	if err != nil {
		return guest.Access{}, err
	}
	d.storeMu.Lock()
	defer d.storeMu.Unlock()
	if cur, _ := d.account.Current(); cur == nil || cur.AccountID != access.Account {
		return guest.Access{}, guest.ErrSignInChanged
	}
	state, err = d.loadSyncState()
	if err != nil {
		return guest.Access{}, err
	}
	gone, err = d.goneSharesLocked(access.Account)
	if err != nil {
		return guest.Access{}, err
	}
	if mark, ok := gone[id]; (ok && shareMasked(mark, state, access.Account, id)) || liveShare(state, access.Account, id) == nil {
		return guest.Access{}, errShareGone
	}
	if err := d.guestStore.Save(access); err != nil {
		return guest.Access{}, err
	}
	return access, nil
}

// liveShare is share id's item as state last synced it, while state is
// account acct's, the account holds the share and no leave of it is owed;
// else nil. d.storeMu must have been held for state.
func liveShare(state syncState, acct, id string) *account.ShareBody {
	if acct == "" || state.AccountID != acct || slices.ContainsFunc(state.ShareDeletes, func(op shareOp) bool { return op.ID == id }) {
		return nil
	}
	if i := slices.IndexFunc(state.Mirror.Shares, func(s account.RemoteShare) bool { return s.ID == id }); i >= 0 {
		return &state.Mirror.Shares[i].Body
	}
	return nil
}
