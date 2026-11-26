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
// gone. After the approval the page keeps reading for pairRetryWindow, the
// time the approver may send a retry's list at a higher seq.
//
// What is saved, and what never is:
//   - Only a list that opened and verified (PairAsk.Machines checks the
//     request id, the approver's key, S and the seq). A list that doesn't
//     saves nothing, and ends the request.
//   - Only machines whose status is added or already. A failed one is
//     reported with the approver's reason.
//   - A machine already saved here at the same host and port (any user) is
//     kept as it is: its key, password and pin stay, and the result says so
//     (it only gets a profile id, Machine.LocalID, if it had none).
//   - A host and port this computer pinned to another host key is not
//     saved: its pin stays, and the result says so.
//   - S is written to identities/ only when a machine uses it, once per
//     request. S, the new pins and the machines are one save: when the
//     machines aren't written, S and the pins this save added (while
//     still its own) are removed again; once they are (even if the
//     folder's sync then fails), all stay.
//   - Nothing is saved once the request was cancelled or replaced here, or
//     the account session that asked signed out: Cancel fences the request
//     before it waits for a read in flight, and the save checks both before
//     it writes machines.json and again after, taking back what it wrote
//     when one came meanwhile. A sign-out waits for a save in progress.

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
)

// pairRetryWindow is how long after the approval a retry's list may still
// come (the service takes a higher seq for 10 minutes after the finish).
const pairRetryWindow = 10 * time.Minute

// pairNow is the clock for the retry window; tests replace it.
var pairNow = time.Now

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
	// PairRemoved: no longer saved here (removed or edited since), so not
	// tried.
	PairRemoved = "removed"
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
	Host      string `json:"host"`
	Port      int    `json:"port"`
	User      string `json:"user"`
	// SyncedID is the account's record of the machine (SyncedMachine.ID)
	// when the account lists it.
	SyncedID string `json:"syncedId,omitempty"`
	// Result is PairSaved, PairKept, PairPinDiffers or PairNotAdded.
	Result string `json:"result"`
	// Reason is the approver's, for PairNotAdded.
	Reason string `json:"reason,omitempty"`
	// Reach is a saved machine's connection try: "" until tried, then
	// PairOnline, PairUnreachable, PairRefused (Problem) or PairRemoved.
	Reach   string `json:"reach,omitempty"`
	Problem string `json:"problem,omitempty"`
}

// pairRequest is the one pair request this computer runs.
type pairRequest struct {
	// round is the account session that asked: nothing is saved once it
	// isn't the current one.
	round account.Round
	ask   *account.PairAsk
	// fenced: cancelled or replaced here. Set before waiting for op, so a
	// read in flight saves nothing.
	fenced atomic.Bool
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
// at the service.
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
	ask, err := d.account.AskToPair(ctx, round.Account, identity, key.Public)
	if err != nil {
		clear(key.PrivatePEM)
		return PairRequestView{}, err
	}
	p := &pairRequest{round: round, ask: ask, key: key,
		view: PairRequestView{ID: ask.ID(), Phase: PairWaiting, ExpiresIn: ask.ExpiresIn(), Device: device, Machines: []PairRequestMachine{}}}
	d.mu.Lock()
	old := d.pairRequest
	d.pairRequest = p
	d.mu.Unlock()
	if old != nil {
		// The service replaced it with this one.
		old.fence()
		old.op.Lock()
		old.end()
		old.op.Unlock()
	}
	return p.view, nil
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
	if !p.deliveredAt.IsZero() && pairNow().Sub(p.deliveredAt) >= pairRetryWindow {
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
	cfg := bridge.Config{Host: m.Host, Port: m.Port, User: m.User, Session: m.Session, Pins: d.pins, ConnectTimeout: pairConnectTimeout, HostKeyAlgorithms: hostKeyAlgorithms(m)}
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
// rules at the top of this file. p.op is held, and d.storeMu all through
// the save: a Cancel waits for p.op and a sign-out for d.storeMu, and the
// save asks pairCommitHolds again once machines.json is written, so one
// that came meanwhile has what it wrote taken back before either returns.
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
	before := slices.Clone(st.Machines)
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
		decided[account.IdentityOf(account.HostBody{Host: r.Host, Port: r.Port, Username: r.User})] = i
	}
	type planned struct {
		m   Machine
		pin string
	}
	var adds []planned
	// profiled: a kept machine got its profile id (Machine.LocalID).
	profiled := false
	set := func(r PairRequestMachine) {
		identity := account.IdentityOf(account.HostBody{Host: r.Host, Port: r.Port, Username: r.User})
		if i, ok := decided[identity]; ok {
			results[i] = r
			return
		}
		results = append(results, r)
		decided[identity] = len(results) - 1
	}
	for _, em := range got.Envelope.Machines {
		identity := account.IdentityOf(em.HostBody())
		if i, ok := decided[identity]; ok && results[i].Result != PairNotAdded {
			continue // saved, kept or refused by an earlier list
		}
		r := PairRequestMachine{Label: pairLabel(em.Nickname, em.Host), Host: em.Host, Port: em.Port, User: em.User}
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
		// PairAsk.Machines checked the body and the host key's form.
		hostKey, err := em.HostPublicKey()
		if err != nil {
			r.Result, r.Reason = PairNotAdded, "its host key couldn't be read"
			set(r)
			continue
		}
		if !slices.Contains(pairHostKeyTypes, hostKey.Type()) {
			r.Result, r.Reason = PairNotAdded, "its host key is a "+hostKey.Type()+" key, which this device doesn't pin"
			set(r)
			continue
		}
		// Paired with the key type the approver pinned: a connection offers
		// only that type's algorithms (hostKeyAlgorithms), so an sshd that
		// also serves another key type is checked against this pin.
		m := Machine{Nickname: em.Nickname, Host: em.Host, Port: em.Port, User: em.User, Paired: true, HostKeyType: hostKey.Type()}
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
		if i := savedAtHostPort(st.Machines, m.Host, m.Port); i >= 0 {
			if st.Machines[i].LocalID == "" {
				st.Machines[i].LocalID, profiled = newLocalID(), true
			}
			r.Result, r.ID, r.ProfileID = PairKept, machineID(st.Machines[i]), st.Machines[i].LocalID
			set(r)
			continue
		}
		if slices.ContainsFunc(adds, func(a planned) bool { return sameHostPort(a.m, m.Host, m.Port) }) {
			continue // the list names it twice: the first stands
		}
		pin := bridge.Fingerprint(hostKey)
		pinned, ok, err := d.pins.Pin(net.JoinHostPort(m.Host, strconv.Itoa(m.Port)))
		if err != nil {
			return fmt.Errorf("This device couldn't read its host keys (%w).", err)
		} else if ok && pinned != pin {
			r.Result = PairPinDiffers
			set(r)
			continue
		}
		m.LocalID = newLocalID()
		r.Result, r.ID, r.ProfileID = PairSaved, machineID(m), m.LocalID
		set(r)
		adds = append(adds, planned{m: m, pin: pin})
	}
	if len(adds) > 0 || profiled {
		// S, the pins and the machines are one save. Until the machines are
		// written, a failure takes back S (when written for them) and the
		// pins this save added that are still its own; once they are, all
		// of it is theirs.
		wrote := false
		type pinAt struct{ hostPort, pin string }
		var added []pinAt
		undo := func() {
			for _, a := range added {
				if err := d.pins.RemovePinIf(a.hostPort, a.pin); err != nil {
					log.Printf("pair request: host key of %s: %v", a.hostPort, err)
				}
			}
			if wrote {
				_ = os.Remove(p.keyPath)
				p.keyPath = ""
			}
		}
		if len(adds) > 0 && p.keyPath == "" {
			path, err := pairing.SaveIdentity(d.dir, p.key.PrivatePEM)
			if err != nil {
				return errors.New("This device couldn't save its key for those machines.")
			}
			p.keyPath, wrote = path, true
		}
		for _, a := range adds {
			hostPort := net.JoinHostPort(a.m.Host, strconv.Itoa(a.m.Port))
			// Only where no other key is pinned, as checked above: one
			// pinned since fails the save, and the next read says so.
			fresh, err := d.pins.AddPin(hostPort, a.pin)
			if err != nil {
				undo()
				return errors.New("This device couldn't save those machines' host keys.")
			}
			if fresh {
				added = append(added, pinAt{hostPort, a.pin})
			}
			a.m.KeyPath = p.keyPath
			st.Machines = append(st.Machines, a.m)
		}
		// A request stopped meanwhile publishes nothing.
		if !d.pairCommitHolds(p) {
			undo()
			return errPairStopped
		}
		published, err := d.publishMachines(st)
		if !published {
			undo()
			return fmt.Errorf("This device couldn't save those machines (%w).", err)
		}
		if err != nil {
			// Written, but the folder's sync failed: S and the pins stay
			// with them.
			log.Printf("pair request: the machines are saved, but: %v", err)
		}
		// A Cancel or sign-out that came while it was written: what this
		// save wrote is taken back, as if it came first.
		if !d.pairCommitHolds(p) {
			st.Machines = before
			if published, err := d.publishMachines(st); !published {
				// Still written: S and the pins stay with them.
				log.Printf("pair request: stopped, but the machines it saved couldn't be removed: %v", err)
				return errPairStopped
			}
			undo()
			return errPairStopped
		}
	}
	p.view.Machines = results
	p.view.SaveFailed, p.view.Problem, p.saveProblem = false, "", ""
	p.applied = got.Seq
	p.view.RetryOpen = true
	for _, a := range adds {
		d.boards.allow(machineID(a.m))
	}
	if len(adds) > 0 {
		d.syncMachinesSoon()
	}
	return nil
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
// no list and saves nothing (pairCommitHolds), and no reveal is sent.
func (p *pairRequest) fence() {
	p.fenced.Store(true)
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
