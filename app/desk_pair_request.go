package main

// Pair from another device, the new device's side (pair-v1, herdr-app PLAN
// 26 Nov 2026, option B): this computer makes an SSH key S for one request,
// asks the account's other devices, and shows the 4-digit code once one of
// them claims the request. That device (the approver) adds S to the
// machines its user ticks, over its own SSH sessions, and seals the list to
// this computer. Each machine it added S to is saved here with S and the
// host key the approver pinned, then tried.
//
// The page drives it: PairRequestRead reads the request once, and the page
// calls it again on its own cadence, so nothing is read once the page is
// gone. After the approval the page keeps reading for pairResendWindow, the
// time the approver may send a retry's list at a higher seq (pairNow).
//
// What is saved, and what never is:
//   - Only a list that opened and verified (PairAsk.Machines checks the
//     request id, the approver's key, S and the seq). A list that doesn't
//     saves nothing, and ends the request.
//   - Only machines whose status is added or already. A failed one is
//     reported with the approver's reason.
//   - Each machine is decided by its pin first: a host and port this
//     computer pins to another host key is not saved (its pin stays, and
//     the result says so), whichever user the row names.
//   - A machine already saved here at the same host and port (any user),
//     or saved by an earlier row of the same list, is kept as it is: its
//     key, password and pin stay, and the result says so (it only gets a
//     profile id, Machine.LocalID, if it had none).
//   - The host key the approver pinned is saved in the machine's profile
//     (Machine.HostKeyPin), and only its connections check it (pinsFor):
//     the pins this computer trusts on first use are read, never written.
//   - S is written to identities/ only when a machine uses it, once per
//     request. S and the machines are one save, staged first and committed
//     by renaming machines.json into place: until then a failure removes
//     what was staged; once it is renamed (even if the folder's sync then
//     fails), all stay.
//   - Nothing is saved once the request was cancelled or replaced here, or
//     the account session that asked signed out: the commit runs only
//     while neither happened, and holds both off until it is done
//     (commitPairDelivery), so a Cancel or sign-out after it keeps what
//     it saved.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/account"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/pairing"
	"golang.org/x/crypto/ssh"
)

// pairConnectTimeout bounds each machine's connection try.
var pairConnectTimeout = 10 * time.Second

var errNoPairRequest = errors.New("that pair request is no longer open here")

// The phases of a pair request as the page shows them.
const (
	// PairWaiting: no device opened the request yet.
	PairWaiting = "waiting"
	// PairClaimed: a device opened it; the code shows.
	PairClaimed = "claimed"
	// PairApproved: approved; the machine list is being saved or tried.
	PairApproved = "approved"
	// PairDone: the list is saved (Machines).
	PairDone = "done"
	// PairDenied, PairExpired: it ended without an approval.
	PairDenied  = "denied"
	PairExpired = "expired"
	// PairFailed: it ended on a problem (Problem), nothing more saved.
	PairFailed = "failed"
)

// A machine's result.
const (
	// PairSaved: saved here with this request's key and pinned host key.
	PairSaved = "saved"
	// PairKept: a machine saved here at that host and port stays as it was.
	PairKept = "kept"
	// PairPinDiffers: not saved; this computer pinned another host key there.
	PairPinDiffers = "pin_differs"
	// PairNotAdded: the approver couldn't add the key (Reason).
	PairNotAdded = "failed"
)

// A saved machine's reach after the connection try.
const (
	PairOnline      = "online"
	PairUnreachable = "unreachable"
	// PairRefused: reached, but it refused this connection (Problem).
	PairRefused = "refused"
	// PairRemoved: no longer saved here, so not tried.
	PairRemoved = "removed"
	// PairChanged: saved, but edited since to another address, so not
	// tried.
	PairChanged = "changed"
)

// PairRequestView is a pair request as the page draws it.
type PairRequestView struct {
	ID    string `json:"id"`
	Phase string `json:"phase"`
	// ExpiresIn is the seconds the request had at the last read.
	ExpiresIn int64 `json:"expiresIn"`
	// Device is this computer's name as the account lists it.
	Device string `json:"device"`
	// Approver is the device that opened the request, once one has.
	Approver string `json:"approver,omitempty"`
	// Code is the 4 digits to type on the approver, once it opened it.
	Code     string               `json:"code,omitempty"`
	Machines []PairRequestMachine `json:"machines"`
	// RetryOpen: the approver may still send a retry's list, so the page
	// keeps reading.
	RetryOpen bool `json:"retryOpen"`
	// SaveFailed: the last list couldn't be saved here (Problem says why);
	// it is read and saved again until the retry window ends. The page
	// backs off as for a failed read.
	SaveFailed bool   `json:"saveFailed,omitempty"`
	Problem    string `json:"problem,omitempty"`
}

// PairRequestMachine is one machine of the approver's list and what became
// of it here.
type PairRequestMachine struct {
	// ID is the saved machine's id (user@host:port) when saved or kept.
	ID string `json:"id,omitempty"`
	// ProfileID is that saved profile's own id (Machine.LocalID, never
	// reused): a profile saved later at the same address is another one.
	ProfileID string `json:"profileId,omitempty"`
	Label     string `json:"label"`
	// Host, Port and User: the profile's address as saved (or kept) here,
	// else the list's.
	Host string `json:"host"`
	Port int    `json:"port"`
	User string `json:"user"`
	// SyncedID is the account's record of the machine (SyncedMachine.ID)
	// when the account lists it.
	SyncedID string `json:"syncedId,omitempty"`
	// Result is PairSaved, PairKept, PairPinDiffers or PairNotAdded.
	Result string `json:"result"`
	// Reason is the approver's, for PairNotAdded.
	Reason string `json:"reason,omitempty"`
	// Reach is a saved machine's connection try: "" until tried, then
	// PairOnline, PairUnreachable, PairRefused (Problem), PairRemoved or
	// PairChanged.
	Reach   string `json:"reach,omitempty"`
	Problem string `json:"problem,omitempty"`
	// entry is the list's entry it is the result of.
	entry account.HostIdentity
}

// pairRequest is the one pair request this computer runs.
type pairRequest struct {
	// round is the account session that asked: nothing is saved once it
	// isn't the current one.
	round account.Round
	ask   *account.PairAsk
	// fenced: cancelled or replaced here. Set before waiting for op, so a
	// read in flight saves nothing, and under commitMu, so it waits for a
	// save at its commit point.
	fenced   atomic.Bool
	commitMu sync.Mutex
	// key is S. Its private half is cleared once nothing more can use it.
	key pairing.PairKey
	// op makes reads, connection tries and the cancel one at a time.
	op sync.Mutex
	// The rest is guarded by op.
	view PairRequestView
	// keyPath is S's file once a machine uses it.
	keyPath string
	// applied is the highest seq of a list saved; deliveredAt the time the
	// first list came, saved or not (the retry window's start).
	applied     uint64
	deliveredAt time.Time
	// saveProblem is why the last list couldn't be saved (SaveFailed).
	saveProblem string
	// ended: denied, expired, failed or cancelled; nothing more is read.
	ended bool
}

// PairRequestOffered reports whether this computer can ask another device
// to pair it: signed in, and the account service offers pair_v1.
func (d *Desk) PairRequestOffered(ctx context.Context) (bool, error) {
	cur, err := d.account.Current()
	if err != nil || cur == nil {
		return false, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return d.account.PairOffered(ctx)
}

// PairRequestStart asks the account's other devices to pair this computer,
// with a new key S. It replaces this computer's earlier request, here and
// at the service. One Start asks and installs its request at a time
// (d.pairStartMu): a later one asks only once the earlier one is installed,
// so the request installed here is always the service's newest.
func (d *Desk) PairRequestStart(ctx context.Context) (PairRequestView, error) {
	round, ok, err := d.account.Round()
	if err != nil || !ok {
		return PairRequestView{}, errSignedOutHere(err)
	}
	identity, err := d.guestIdentity()
	if err != nil {
		return PairRequestView{}, err
	}
	device := accountDeviceName()
	key, err := pairing.NewPairKey(device)
	if err != nil {
		return PairRequestView{}, errors.New("Couldn't make a key for this device.")
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	d.pairStartMu.Lock()
	ask, err := d.account.AskToPair(ctx, round.Account, identity, key.Public)
	if err != nil {
		d.pairStartMu.Unlock()
		clear(key.PrivatePEM)
		return PairRequestView{}, err
	}
	p := &pairRequest{round: round, ask: ask, key: key,
		view: PairRequestView{ID: ask.ID(), Phase: PairWaiting, ExpiresIn: ask.ExpiresIn(), Device: device, Machines: []PairRequestMachine{}}}
	// Its view as started, copied before it is installed: a later Start may
	// end it at once.
	view := p.copyView()
	d.mu.Lock()
	old := d.pairRequest
	d.pairRequest = p
	d.mu.Unlock()
	d.pairStartMu.Unlock()
	if old != nil {
		// The service replaced it with this one.
		old.fence()
		old.op.Lock()
		old.end()
		old.op.Unlock()
	}
	return view, nil
}

// PairRequestCurrent is the request this computer runs, as last read; nil
// when there is none. A page opened again shows it.
func (d *Desk) PairRequestCurrent() *PairRequestView {
	d.mu.Lock()
	p := d.pairRequest
	d.mu.Unlock()
	if p == nil {
		return nil
	}
	p.op.Lock()
	defer p.op.Unlock()
	v := p.copyView()
	return &v
}

func (d *Desk) currentPairRequest(id string) (*pairRequest, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if p := d.pairRequest; p != nil && p.ask.ID() == id {
		return p, nil
	}
	return nil, errNoPairRequest
}

// PairRequestCancel ends request id: the service cancels it, so no device
// can approve it any more. It is fenced here first (it reveals nothing more,
// opens no list and saves nothing, a read in flight included), so when the
// service can't be told it still ends here.
func (d *Desk) PairRequestCancel(ctx context.Context, id string) error {
	p, err := d.currentPairRequest(id)
	if err != nil {
		return nil
	}
	d.mu.Lock()
	if d.pairRequest == p {
		d.pairRequest = nil
	}
	d.mu.Unlock()
	p.fence()
	p.op.Lock()
	defer p.op.Unlock()
	// A list saved before the fence stays; the service is told either way.
	saved := p.view.Phase == PairDone
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	err = p.ask.Cancel(ctx)
	p.end()
	var api *account.APIError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &api) && api.Status == http.StatusConflict:
		if saved {
			return nil
		}
		return errors.New("This device stopped the request, but your other device had already approved it: its key may be on those machines, though this device saved none of them.")
	}
	return fmt.Errorf("This device stopped the request, but the account service didn't hear it (%w). A device that already has the code could still approve it until it expires.", err)
}

// PairRequestRead reads request id once and moves it on: the code once a
// device opened it, and, once approved, the approver's machine list, saved
// here (the save rules in app/desk_pair_request.go). A list sent again at a
// higher seq is saved too, while RetryOpen. A list that couldn't be saved
// is the view's Problem (SaveFailed), and is read and saved again until
// the retry window ends; then the problem is final. An error is a read
// that failed (no answer); the page reads again.
func (d *Desk) PairRequestRead(ctx context.Context, id string) (PairRequestView, error) {
	p, err := d.currentPairRequest(id)
	if err != nil {
		return PairRequestView{}, err
	}
	p.op.Lock()
	defer p.op.Unlock()
	if p.ended || p.fenced.Load() {
		return p.copyView(), nil
	}
	if !d.account.Holds(p.round) {
		p.signedOut()
		return p.copyView(), nil
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if p.view.Phase == PairWaiting || p.view.Phase == PairClaimed {
		prog, err := p.ask.Poll(ctx)
		switch {
		case errors.Is(err, account.ErrApproveTampered):
			p.fail("The request was tampered with on its way, so this device stopped it. Nothing was saved.")
			return p.copyView(), nil
		case errors.Is(err, account.ErrApprovalEnded):
			p.view.Phase, p.view.ExpiresIn = PairExpired, 0
			p.end()
			return p.copyView(), nil
		case err != nil:
			return p.copyView(), err
		}
		p.view.ExpiresIn = prog.ExpiresIn
		if prog.Approver != "" {
			p.view.Approver = prog.Approver
		}
		if prog.Code != "" {
			p.view.Code = prog.Code
		}
		switch prog.State {
		case account.ApprovalDenied:
			p.view.Phase = PairDenied
			p.end()
			return p.copyView(), nil
		case account.ApprovalExpired, account.ApprovalCancelled:
			p.view.Phase, p.view.ExpiresIn = PairExpired, 0
			p.end()
			return p.copyView(), nil
		case account.ApprovalApproved:
			p.view.Phase = PairApproved
		default:
			if p.view.Code != "" {
				p.view.Phase = PairClaimed
			}
		}
	}
	if p.view.Phase != PairApproved && p.view.Phase != PairDone {
		return p.copyView(), nil
	}
	if !p.deliveredAt.IsZero() && pairNow().Sub(p.deliveredAt) >= pairResendWindow {
		if p.view.SaveFailed {
			// The approver can't send it again any more.
			p.view.SaveFailed = false
			if p.applied == 0 {
				p.fail(p.saveProblem + " This device stopped trying, so it saved none of those machines.")
				return p.copyView(), nil
			}
			p.view.Problem = p.saveProblem + " This device stopped trying, so it saved nothing more from the later list."
		}
		p.end()
		return p.copyView(), nil
	}
	got, ok, err := p.ask.Machines(ctx)
	switch {
	case errors.Is(err, account.ErrApproveTampered):
		if p.applied == 0 {
			p.fail("The machine list was tampered with on its way, so this device saved none of it.")
		} else {
			p.view.Problem = "A later machine list was tampered with on its way, so this device saved none of it."
			p.end()
		}
		return p.copyView(), nil
	case err != nil:
		return p.copyView(), err
	case !ok || got.Seq <= p.applied:
		return p.copyView(), nil
	}
	if p.deliveredAt.IsZero() {
		p.deliveredAt = pairNow()
	}
	switch err := d.savePairDelivery(p, got); {
	case errors.Is(err, errPairStopped):
		if !p.fenced.Load() {
			p.signedOut()
		}
		return p.copyView(), nil
	case err != nil:
		// The page shows it, and reads and saves the list again.
		p.saveProblem = err.Error()
		p.view.SaveFailed, p.view.Problem = true, p.saveProblem+" Trying again."
		return p.copyView(), nil
	}
	p.view.Phase = PairDone
	return p.copyView(), nil
}

// PairRequestConnect tries each machine saved by request id that hasn't
// been tried: online, unreachable from here, or refused (why).
func (d *Desk) PairRequestConnect(ctx context.Context, id string) (PairRequestView, error) {
	p, err := d.currentPairRequest(id)
	if err != nil {
		return PairRequestView{}, err
	}
	p.op.Lock()
	defer p.op.Unlock()
	d.storeMu.Lock()
	st, err := d.load()
	d.storeMu.Unlock()
	if err != nil {
		return p.copyView(), err
	}
	var wg sync.WaitGroup
	for i := range p.view.Machines {
		pm := &p.view.Machines[i]
		if pm.Result != PairSaved || pm.Reach != "" {
			continue
		}
		at := slices.IndexFunc(st.Machines, func(m Machine) bool { return m.LocalID == pm.ProfileID })
		if at < 0 {
			// Removed since it was saved (a profile saved at its address
			// since is another one): nothing to try.
			pm.Reach = PairRemoved
			continue
		}
		m := st.Machines[at]
		if m.User != pm.User || m.Host != pm.Host || m.Port != pm.Port {
			// Edited since to another address: not the machine the
			// approver added the key to, so not tried.
			pm.Reach = PairChanged
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			pm.Reach, pm.Problem = d.tryPairedMachine(ctx, m, p.view.Approver)
		}()
	}
	wg.Wait()
	return p.copyView(), nil
}

// tryPairedMachine connects to m as a session would (its key, its pin,
// Paired's host key algorithms) and closes again.
func (d *Desk) tryPairedMachine(ctx context.Context, m Machine, approver string) (reach, problem string) {
	cfg := bridge.Config{Host: m.Host, Port: m.Port, User: m.User, Session: m.Session, Pins: d.pinsFor(m), ConnectTimeout: pairConnectTimeout, HostKeyAlgorithms: hostKeyAlgorithms(m)}
	var err error
	if cfg.KeyPEM, err = os.ReadFile(m.KeyPath); err != nil {
		return PairRefused, "This device couldn't read its key for it."
	}
	defer clear(cfg.KeyPEM)
	c, err := bridge.Dial(ctx, cfg)
	var changed *bridge.HostKeyChangedError
	switch {
	case err == nil:
		c.Close()
		return PairOnline, ""
	case errors.As(err, &changed):
		if approver == "" {
			approver = "your other device"
		}
		return PairRefused, fmt.Sprintf("Its host key isn't the one %s pinned, so this device didn't connect.", approver)
	case isAuthError(err):
		return PairRefused, "It didn't accept this device's key."
	}
	return PairUnreachable, ""
}

// PairOpenTarget is the saved profile a result row opens, as the page drew
// it: its id, and the profile id and address the row joined it by.
type PairOpenTarget struct {
	ID        string `json:"id"`
	ProfileID string `json:"profileId"`
	User      string `json:"user"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
}

// SelectPairedMachine is SelectMachine for a result row: it opens
// target.ID only while that saved profile is still the row's (its profile
// id and address), checked under the store lock. opened is false, and
// nothing changes, when it isn't (removed, edited or replaced since): the
// page draws its rows again.
func (d *Desk) SelectPairedMachine(target PairOpenTarget, password string) (opened bool, err error) {
	if target.ProfileID == "" {
		return false, nil
	}
	return d.selectMachine(target.ID, password, func(m Machine) bool {
		return m.LocalID == target.ProfileID && m.User == target.User && m.Host == target.Host && m.Port == target.Port
	})
}

// errPairStopped: the request was cancelled or replaced here, or the
// account session that asked signed out, so nothing was saved from it.
var errPairStopped = errors.New("pair request stopped here")

// pairCommitHolds is whether p may still save: it is this computer's
// request, not fenced, and the session that asked is the current one.
func (d *Desk) pairCommitHolds(p *pairRequest) bool {
	d.mu.Lock()
	current := d.pairRequest == p
	d.mu.Unlock()
	return current && !p.fenced.Load() && d.account.Holds(p.round)
}

// savePairDelivery saves the machines of got, a list above any applied:
// each added or already machine not decided by an earlier list, by the
// rules at the top of this file. p.op is held, and d.storeMu all through.
//
// Each machine's pin is decided first, against the pins this computer
// keeps (read only), then where it goes: kept, saved, or named again at an
// address the list saves already. A saved machine carries its pin in its
// profile (Machine.HostKeyPin), so machines.json alone publishes the save:
// S's file, written only when a machine uses it, and machines.json's next
// content are staged, and the commit point, the rename of machines.json
// into place, runs only while p isn't fenced (p.commitMu) and its session
// is the current one (WhileHolds), holding a Cancel and a sign-out off
// until it is done. One that came first leaves nothing written: the staged
// files are removed. One that comes after finds the machines saved, and
// they stay.
func (d *Desk) savePairDelivery(p *pairRequest, got account.PairDelivery) error {
	d.storeMu.Lock()
	defer d.storeMu.Unlock()
	if !d.pairCommitHolds(p) {
		return errPairStopped
	}
	st, err := d.load()
	if err != nil {
		return err
	}
	// The account's record of a machine, to save it as that record (its
	// fields and sync id), so it isn't listed to pair any more and doesn't
	// sync as a second one.
	var mirror []account.RemoteHost
	if state, err := d.loadSyncState(); err == nil && state.AccountID == p.round.Account {
		mirror = state.Mirror.Hosts
	}
	// Decided here and put in the view only once everything is saved.
	results := append([]PairRequestMachine{}, p.view.Machines...)
	decided := map[account.HostIdentity]int{}
	for i, r := range results {
		decided[r.entry] = i
	}
	var adds []Machine
	// profiled: a kept machine got its profile id (Machine.LocalID).
	profiled := false
	set := func(r PairRequestMachine) {
		if i, ok := decided[r.entry]; ok {
			results[i] = r
			return
		}
		results = append(results, r)
		decided[r.entry] = len(results) - 1
	}
	for i, em := range got.Envelope.Machines {
		identity := account.IdentityOf(em.HostBody())
		if i, ok := decided[identity]; ok && results[i].Result != PairNotAdded {
			continue // saved, kept or refused by an earlier list
		}
		r := PairRequestMachine{entry: identity, Label: pairLabel(em.Nickname, em.Host), Host: em.Host, Port: em.Port, User: em.User}
		// The record SyncedMachines lists for it (the first, as there).
		for _, h := range mirror {
			if account.IdentityOf(h.Body) == identity {
				r.SyncedID = h.ID
				break
			}
		}
		if em.Status != account.PairAdded && em.Status != account.PairAlready {
			r.Result, r.Reason = PairNotAdded, em.Reason
			set(r)
			continue
		}
		// As the envelope's checks parsed it (PairAsk.Machines). The
		// contract sends the plain key; a certificate sent anyway is pinned
		// as the key it certifies (bridge accepts a certificate of a
		// pinned key).
		hostKey := got.HostKeys[i]
		if cert, ok := hostKey.(*ssh.Certificate); ok {
			hostKey = cert.Key
		}
		// pair-v1 pins ed25519 and ECDSA host keys only (pairHostKeyTypes),
		// whatever an approver, an older one too, sent.
		if _, ok := pairHostKeyTypes[hostKey.Type()]; !ok {
			r.Result, r.Reason = PairNotAdded, "its host key is a "+hostKey.Type()+" key, and this device takes only ed25519 or ECDSA host keys from another device"
			set(r)
			continue
		}
		// Paired with the key the approver pinned, in the profile: a
		// connection offers only its type (hostKeyAlgorithms) and checks it
		// (pinsFor).
		m := Machine{Nickname: em.Nickname, Host: em.Host, Port: em.Port, User: em.User, Paired: true, HostKeyType: hostKey.Type(), HostKeyPin: bridge.Fingerprint(hostKey)}
		for _, h := range mirror {
			if account.IdentityOf(h.Body) == identity && !slices.ContainsFunc(st.Machines, func(s Machine) bool { return s.SyncID == h.ID }) {
				m.Nickname, m.Host, m.Port, m.User, m.SyncID = h.Body.Nickname, h.Body.Host, h.Body.Port, h.Body.Username, h.ID
				if m.Port == 0 {
					m.Port = 22
				}
				break
			}
		}
		r.Label = machineLabel(m)
		// Its pin first: this computer pinning another key at that address
		// decides it, whichever row (user) names it.
		pinned, ok, err := d.pins.Pin(net.JoinHostPort(m.Host, strconv.Itoa(m.Port)))
		if err != nil {
			return fmt.Errorf("This device couldn't read its host keys (%w).", err)
		}
		if ok && pinned != m.HostKeyPin {
			r.Result = PairPinDiffers
			set(r)
			continue
		}
		if i := savedAtHostPort(st.Machines, m.Host, m.Port); i >= 0 {
			kept := &st.Machines[i]
			if kept.LocalID == "" {
				kept.LocalID, profiled = newLocalID(), true
			}
			// The address as saved here: the profile is that one only
			// while it still has it.
			r.Result, r.ID, r.ProfileID = PairKept, machineID(*kept), kept.LocalID
			r.Host, r.Port, r.User = kept.Host, kept.Port, kept.User
			set(r)
			continue
		}
		if j := slices.IndexFunc(adds, func(a Machine) bool { return sameHostPort(a, m.Host, m.Port) }); j >= 0 {
			// Named again (another user) at an address this list saves
			// already: one profile per address, the first one, as for a
			// machine saved here before. Another key for it differs.
			first := adds[j]
			if first.HostKeyPin != m.HostKeyPin {
				r.Result = PairPinDiffers
			} else {
				r.Result, r.ID, r.ProfileID = PairKept, machineID(first), first.LocalID
				r.Host, r.Port, r.User = first.Host, first.Port, first.User
			}
			set(r)
			continue
		}
		m.LocalID = newLocalID()
		r.Result, r.ID, r.ProfileID = PairSaved, machineID(m), m.LocalID
		r.Host, r.Port, r.User = m.Host, m.Port, m.User
		set(r)
		adds = append(adds, m)
	}
	if len(adds) > 0 || profiled {
		if err := d.commitPairDelivery(p, st, adds); err != nil {
			return err
		}
	}
	p.view.Machines = results
	p.view.SaveFailed, p.view.Problem, p.saveProblem = false, "", ""
	p.applied = got.Seq
	p.view.RetryOpen = true
	for _, m := range adds {
		d.boards.allow(machineID(m))
	}
	if len(adds) > 0 {
		d.syncMachinesSoon()
	}
	return nil
}

// commitPairDelivery saves adds, each with S (written for them unless a
// machine uses it already), and st's machines, as savePairDelivery says.
func (d *Desk) commitPairDelivery(p *pairRequest, st machineStore, adds []Machine) error {
	if err := d.replayCommit(); err != nil {
		return err
	}
	keyWritten := false
	if len(adds) > 0 && p.keyPath == "" {
		path, err := pairing.SaveIdentity(d.dir, p.key.PrivatePEM)
		if err != nil {
			return errors.New("This device couldn't save its key for those machines.")
		}
		p.keyPath, keyWritten = path, true
	}
	for i := range adds {
		adds[i].KeyPath = p.keyPath
	}
	st.Machines = append(st.Machines, adds...)
	err := d.publishPairMachines(p, st)
	if err != nil && keyWritten {
		// Staged for machines that weren't saved: no machine uses it.
		_ = os.Remove(p.keyPath)
		p.keyPath = ""
	}
	return err
}

// publishPairMachines writes st as machines.json: staged beside it, then
// renamed into place at the commit point, only while p isn't fenced and its
// session is the current one.
func (d *Desk) publishPairMachines(p *pairRequest, st machineStore) error {
	data, err := encodeMachines(st)
	if err != nil {
		return err
	}
	tmp, err := d.stageMachinesFile(data)
	if err != nil {
		return fmt.Errorf("This device couldn't save those machines (%w).", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(tmp)
		}
	}()
	p.commitMu.Lock()
	defer p.commitMu.Unlock()
	if p.fenced.Load() {
		return errPairStopped
	}
	held, err := d.account.WhileHolds(p.round, func() error {
		published, err := d.commitMachinesFile(tmp)
		if !published {
			return fmt.Errorf("This device couldn't save those machines (%w).", err)
		}
		committed = true
		if err != nil {
			// In place, but the folder's sync failed: S stays with them.
			log.Printf("pair request: the machines are saved, but: %v", err)
		}
		return nil
	})
	if !held {
		return errPairStopped
	}
	return err
}

// savedAtHostPort is the index of a machine saved at host and port, by any
// user; -1 when none is.
func savedAtHostPort(ms []Machine, host string, port int) int {
	for i, m := range ms {
		if sameHostPort(m, host, port) {
			return i
		}
	}
	return -1
}

func sameHostPort(m Machine, host string, port int) bool {
	a := account.IdentityOf(account.HostBody{Host: m.Host, Port: m.Port})
	b := account.IdentityOf(account.HostBody{Host: host, Port: port})
	return a.Host == b.Host && a.Port == b.Port
}

// pairLabel names a machine of the list: its nickname, else its host.
func pairLabel(nickname, host string) string {
	if n := strings.TrimSpace(nickname); n != "" {
		return n
	}
	return host
}

// fail ends the request on problem. p.op is held.
func (p *pairRequest) fail(problem string) {
	p.view.Phase, p.view.Problem = PairFailed, problem
	p.ask.Abandon()
	p.end()
}

// fence stops p here before its op is waited for: a read in flight opens
// no list and saves nothing, and no reveal is sent. A save at its commit
// point (commitPairDelivery) finishes first, and stays.
func (p *pairRequest) fence() {
	p.commitMu.Lock()
	p.fenced.Store(true)
	p.commitMu.Unlock()
	p.ask.Abandon()
}

// signedOut ends p once the session that asked isn't the current one:
// nothing more is saved, and what was stays. p.op is held.
func (p *pairRequest) signedOut() {
	const problem = "This device signed out of the account that asked, so it stopped the request. Nothing more was saved from it."
	if p.view.Phase == PairDone {
		p.ask.Abandon()
		p.view.Problem = problem
		p.end()
		return
	}
	p.fail(problem)
}

// end stops reading the request and clears S's private half from memory:
// it is on disk when a machine uses it. p.op is held.
func (p *pairRequest) end() {
	p.ended = true
	p.view.RetryOpen = false
	clear(p.key.PrivatePEM)
}

func (p *pairRequest) copyView() PairRequestView {
	v := p.view
	v.Machines = append([]PairRequestMachine{}, p.view.Machines...)
	return v
}
