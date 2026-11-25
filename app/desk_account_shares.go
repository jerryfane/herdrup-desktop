package main

import (
	"context"
	"encoding/base64"
	"errors"
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
// syncs.
type shareOp struct {
	ID      string             `json:"id"`
	Account string             `json:"account"`
	Body    *account.ShareBody `json:"body,omitempty"`
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
	d.storeMu.Unlock()
	if err != nil {
		return nil, err
	}
	grants, err := d.guestStore.List()
	if err != nil {
		return nil, err
	}
	return syncedSharesOf(cur.AccountID, state, grants), nil
}

// announceShares tells the page the shares now (SyncedShares).
func (d *Desk) announceShares() {
	if shares, err := d.SyncedShares(); err == nil {
		publishSyncedShares(shares)
	}
}

// syncedSharesOf lists account acct's shares: the mirror's (state's, when
// it is acct's) but those left here, then the writes owed to acct. Local
// marks those whose grant this device holds (grants).
func syncedSharesOf(acct string, state syncState, grants []guest.Access) []SyncedShare {
	held := map[string]bool{}
	for _, g := range grants {
		held[g.ShareID()] = true
	}
	owed := func(ops []shareOp, id string) bool {
		return slices.ContainsFunc(ops, func(op shareOp) bool { return op.Account == acct && op.ID == id })
	}
	out := []SyncedShare{}
	add := func(id string, b account.ShareBody) {
		out = append(out, SyncedShare{ID: id, Relay: b.Relay, HostID: b.HostID, NodePub: b.NodePub, GuestID: b.GuestID, AgentName: b.AgentName,
			OwnerName: b.OwnerName, MachineLabel: b.MachineLabel, ShareGram: b.ShareGram != nil && *b.ShareGram, Local: held[id]})
	}
	listed := map[string]bool{}
	if state.AccountID == acct {
		for _, s := range state.Mirror.Shares {
			if !owed(state.ShareDeletes, s.ID) {
				add(s.ID, s.Body)
				listed[s.ID] = true
			}
		}
	}
	for _, op := range state.ShareWrites {
		if op.Account == acct && op.Body != nil && !listed[op.ID] {
			add(op.ID, *op.Body)
			listed[op.ID] = true
		}
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

// noteShare records what this device owes the account of a bound grant: its
// item written (acct, the account it was bound to), or with leave deleted
// (for the account an unsent write of it was owed to, else the one signed
// in, else the state's). Either replaces any owed before. Then it syncs
// soon and tells the page.
func (d *Desk) noteShare(a guest.Access, acct string, leave bool) error {
	op := shareOp{ID: a.ShareID(), Account: acct}
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
		if leave {
			if i := slices.IndexFunc(state.ShareWrites, func(o shareOp) bool { return o.ID == op.ID }); i >= 0 {
				op.Account = state.ShareWrites[i].Account
			} else if cur, _ := d.account.Current(); cur != nil {
				op.Account = cur.AccountID
			} else {
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
	}
	d.storeMu.Unlock()
	if err != nil {
		return err
	}
	d.syncMachinesSoon()
	d.announceShares()
	return nil
}

// mergeShares plans account acct's shares changes from the mirror after a
// pull (mirror), the ids the account is known to have held (known, as
// syncPass builds it for hosts and prompts), the writes and deletes owed
// (as shareOp, other accounts' kept as they are) and the base revisions
// (revs, as baseRevs):
//   - an owed write the account holds has landed (this device's, or a copy
//     of the grant from another): it goes;
//   - one whose item the account held and no longer does was left
//     elsewhere: it goes, and so does the grant (gone);
//   - any other is written, on the revision last seen of its item;
//   - an owed delete of an item the account holds is sent, on its
//     revision; one of an item it doesn't hold is done.
//
// gone are the known items the account no longer holds: this device's
// bound grants for them go.
func mergeShares(acct string, mirror []account.RemoteShare, known map[string]bool, writes, deletes []shareOp, revs map[string]int64) (changes []account.Change, nextWrites, nextDeletes []shareOp, gone map[string]bool) {
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
		changes = append(changes, account.Write("shares", op.ID, revs["shares/"+op.ID], *op.Body))
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
// the account deleted (gone, by item id), and returns their grant ids.
// A plain grant is never dropped: sync knows nothing of it.
func (d *Desk) dropGoneShares(gone map[string]bool) ([]string, error) {
	if len(gone) == 0 {
		return nil, nil
	}
	grants, err := d.guestStore.List()
	if err != nil {
		return nil, err
	}
	var dropped []string
	for _, g := range grants {
		if g.AccountBound && gone[g.ShareID()] {
			if err := d.guestStore.Remove(g.ID()); err != nil {
				return dropped, err
			}
			dropped = append(dropped, g.ID())
		}
	}
	return dropped, nil
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
func (d *Desk) openSyncedShare(ctx context.Context, acct, id string) (guest.Access, error) {
	grants, err := d.guestStore.List()
	if err != nil {
		return guest.Access{}, err
	}
	if i := slices.IndexFunc(grants, func(g guest.Access) bool { return g.ShareID() == id }); i >= 0 {
		return grants[i], nil
	}
	d.storeMu.Lock()
	state, err := d.loadSyncState()
	d.storeMu.Unlock()
	if err != nil {
		return guest.Access{}, err
	}
	var body *account.ShareBody
	if state.AccountID == acct && !slices.ContainsFunc(state.ShareDeletes, func(op shareOp) bool { return op.ID == id }) {
		if i := slices.IndexFunc(state.Mirror.Shares, func(s account.RemoteShare) bool { return s.ID == id }); i >= 0 {
			body = &state.Mirror.Shares[i].Body
		}
	}
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
	if err := d.guestStore.Save(access); err != nil {
		return guest.Access{}, err
	}
	return access, nil
}
