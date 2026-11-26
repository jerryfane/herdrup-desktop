package main

// Pair from another device, the approving computer's side (herdr-app PLAN,
// 26 Nov 2026, option B): another app device of the account (the new
// device) made an SSH key S and asks, through the account service, to be
// added to the owner's machines. This computer shows the request, the user
// types the new device's 4-digit code (S is bound into it), ticks
// machines, and this computer adds S on each over its own SSH session
// (herdr pair.add_key), then seals the machine list, with each machine's
// host key as this computer's session verified it, to the new device.
// The service never sees a machine; it carries the request and the sealed
// list.
//
// Nothing is added before the typed code matched (Ready), and the key
// added is always the request's own S (Request().AuthorizedKey()), never
// one from the page.

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/account"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"golang.org/x/crypto/ssh"
)

// ApprovalRequests is every request waiting for approval on the account,
// both kinds, from one read of the service (GET /v1/approvals?kind=any):
// the page polls this once, not a list per kind, so pair requests cost the
// account's approval rate nothing over browser ones. Order is the request
// ids of both kinds in the service's order, which the page opens them in.
type ApprovalRequests struct {
	Browsers []WebAccessRequest   `json:"browsers"`
	Pairs    []PairApproveRequest `json:"pairs"`
	Order    []string             `json:"order"`
}

// PairApproveRequest is one new device waiting for a pair approval, for
// the sheet.
type PairApproveRequest struct {
	ID         string `json:"id"`
	DeviceName string `json:"deviceName"`
	// Platform is the new device's (macos, windows, linux, ios, ipados).
	Platform string `json:"platform"`
	// Claimed is "no", "you" or "other" (another device is approving it).
	Claimed   string `json:"claimed"`
	ExpiresIn int64  `json:"expiresIn"`
}

// ApprovalOffers says which approval requests the account service
// carries: browsers' (web_approve) and new devices' (pair_v1).
type ApprovalOffers struct {
	Browsers bool `json:"browsers"`
	Pairs    bool `json:"pairs"`
}

// ApprovalsOffered reads both from one /v1/health answer. An error means
// the service couldn't be asked; the page asks again on its next look.
func (d *Desk) ApprovalsOffered(ctx context.Context) (ApprovalOffers, error) {
	cur, err := d.account.Current()
	if err != nil || cur == nil {
		return ApprovalOffers{}, errSignedOutHere(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	browsers, pairs, err := d.account.ApprovalsOffered(ctx)
	return ApprovalOffers{Browsers: browsers, Pairs: pairs}, err
}

// ApprovalRequests lists the browsers and new devices waiting for approval.
func (d *Desk) ApprovalRequests(ctx context.Context) (ApprovalRequests, error) {
	out := ApprovalRequests{Browsers: []WebAccessRequest{}, Pairs: []PairApproveRequest{}, Order: []string{}}
	cur, err := d.account.Current()
	if err != nil || cur == nil {
		return out, errSignedOutHere(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	lists, err := d.account.AnyApprovals(ctx, cur.AccountID)
	if err != nil {
		return out, err
	}
	out.Browsers, out.Order = webAccessRequests(lists.Browser), lists.Order
	for _, r := range lists.Pair {
		out.Pairs = append(out.Pairs, pairApproveRequest(r))
	}
	return out, nil
}

func pairApproveRequest(r account.PairRequest) PairApproveRequest {
	return PairApproveRequest{ID: r.ID, DeviceName: r.Requester.Name, Platform: r.Requester.Platform,
		Claimed: r.Claimed, ExpiresIn: r.ExpiresIn}
}

// pairApproval is the one pair approval in progress on this computer.
type pairApproval struct {
	a      *account.PairApproval
	cancel context.CancelFunc
	// op makes Add, Retry and Deny one at a time.
	op sync.Mutex
	// Guarded by op: rows is every ticked machine, in the order added, as
	// the envelope says it; pending is an approval whose answer was lost
	// (Add sends the same envelope again); sentAt is when the service took
	// the approval; unsent is a retry's list the service didn't take (the
	// next Try again sends it).
	rows    []pairRow
	pending bool
	// approved: the service holds this computer's approval (its list
	// perhaps not: unsent).
	approved bool
	sentAt   time.Time
	unsent   bool
}

// pairRow is one ticked machine: its saved entry, and its envelope entry.
// held is why a machine the envelope can't carry was left out of it (it
// is shown failed, never sealed, never tried again).
type pairRow struct {
	m        Machine
	entry    account.PairMachine
	keyLabel string
	held     string
}

// pairProbeSlots bounds the machines probed at once.
var pairProbeSlots = make(chan struct{}, 4)

// Per-machine and report time, as for browser approvals: a machine is
// started only with pairAddTime left before the approval must go, and a
// probe gets pairProbeTime from its connect to its answer.
const (
	pairAddTime    = 30 * time.Second
	pairReportTime = 30 * time.Second
	pairProbeTime  = 8 * time.Second
	// pairResendWindow is how long after the approval the service takes a
	// retry's list.
	pairResendWindow = 10 * time.Minute
)

// pairNow is the clock for the resend window; tests replace it.
var pairNow = time.Now

// PairProbe is what the sheet learns of one machine before the user ticks
// it: "ready" (reachable, its herdr has pair.add_key), "unreachable",
// "needs_update" (Version is its herdr's, when it said), "needs_key" (a
// password machine not connected now), "needs_pin" (never opened from
// this computer, so no host key is kept for it) or "unsendable" (the list
// the new device gets can't carry it; Reason says why).
type PairProbe struct {
	State   string `json:"state"`
	Version string `json:"version,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// PairApproveProbe connects to saved machine machineID for pair request
// id, briefly and at most a few machines at a time, and says whether a key
// can be added there. Only once the typed code matched: before, no
// machine is reached at all. It adds nothing, and pins nothing.
func (d *Desk) PairApproveProbe(ctx context.Context, id, machineID string) (PairProbe, error) {
	p, err := d.currentPair(id)
	if err != nil {
		return PairProbe{}, err
	}
	if err := p.a.Ready(); err != nil {
		return PairProbe{}, err
	}
	m, err := d.savedMachine(machineID)
	if err != nil {
		return PairProbe{}, err
	}
	if err := pairSendable(m); err != nil {
		return PairProbe{State: "unsendable", Reason: pairHeldReason(err)}, nil
	}
	select {
	case pairProbeSlots <- struct{}{}:
	case <-ctx.Done():
		return PairProbe{}, ctx.Err()
	}
	defer func() { <-pairProbeSlots }()
	ctx, cancel := context.WithTimeout(ctx, pairProbeTime)
	defer cancel()
	c, done, err := d.pairBridge(ctx, m)
	switch {
	case errors.Is(err, errNeedsKey):
		return PairProbe{State: "needs_key"}, nil
	case errors.Is(err, errNoPin):
		return PairProbe{State: "needs_pin"}, nil
	case err != nil:
		return PairProbe{State: "unreachable"}, nil
	}
	defer done()
	client := engine.New(engine.Bridge(c))
	ok, err := client.PairAddKeySupported(ctx)
	switch {
	case err != nil:
		return PairProbe{State: "unreachable"}, nil
	case !ok:
		pong, _ := client.Ping(ctx)
		return PairProbe{State: "needs_update", Version: pong.Version}, nil
	}
	return PairProbe{State: "ready"}, nil
}

// errNoPin is a machine with no host key kept here: it was never opened
// from this computer.
var errNoPin = errors.New("open it once on this computer first")

// pairPins is the pin store a pair approval dials with: the pins kept
// here, read only. An approval is no time to trust a host key on first
// sight, and the new device would be handed whatever key answered.
type pairPins struct {
	bridge.PinStore
	missing atomic.Bool
}

func (p *pairPins) SetPin(string, string) error {
	p.missing.Store(true)
	return errNoPin
}

// pairBridge is ownerBridge for a pair approval: a machine without a pin
// kept here is errNoPin, never pinned.
func (d *Desk) pairBridge(ctx context.Context, m Machine) (*bridge.Client, func(), error) {
	pins := &pairPins{PinStore: d.pins}
	c, done, err := d.ownerBridge(ctx, m, pins)
	if err != nil && pins.missing.Load() {
		return nil, nil, errNoPin
	}
	return c, done, err
}

// pairTrialHostKey stands for a machine's host key when its entry is
// checked before the machine is reached.
var pairTrialHostKey = func() string {
	k, err := ssh.NewPublicKey(ed25519.PublicKey(make([]byte, ed25519.PublicKeySize)))
	if err != nil {
		panic(err)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(k)))
}()

// pairSendable says why m can't be in the list the new device gets, by the
// envelope's own rules (PairEnvelope.Marshal) with the entry it would have
// once its key is added; nil when it can.
func pairSendable(m Machine) error {
	entry := pairEntry(m)
	entry.Status, entry.HostKey = account.PairAdded, pairTrialHostKey
	_, err := account.PairEnvelope{V: account.PairEnvelopeVersion, Machines: []account.PairMachine{entry}}.Marshal()
	return err
}

// pairHeldReason is a row's reason for a machine pairSendable refused.
func pairHeldReason(err error) string {
	return truncate("can't be sent to the new device: "+strings.TrimPrefix(err.Error(), "pair-v1: "), 120)
}

func (d *Desk) savedMachine(id string) (Machine, error) {
	d.storeMu.Lock()
	st, err := d.load()
	d.storeMu.Unlock()
	if err != nil {
		return Machine{}, err
	}
	i := slices.IndexFunc(st.Machines, func(m Machine) bool { return machineID(m) == id })
	if i < 0 {
		return Machine{}, errors.New("that machine is no longer saved here")
	}
	return st.Machines[i], nil
}

// PairApproveUpdate tells the page where a pair approval stands: "ready"
// (the new device shows its code; type it), "tampered" (denied) or "ended".
type PairApproveUpdate struct {
	ID      string `json:"id"`
	State   string `json:"state"`
	Problem string `json:"problem,omitempty"`
}

// PairApproveProgress is one machine's step while keys are added:
// "adding", then "added", "already" or "failed" (Reason says why).
// KeyLabel is the label herdr stored the key under.
type PairApproveProgress struct {
	ID        string `json:"id"`
	MachineID string `json:"machineId"`
	Status    string `json:"status"`
	Reason    string `json:"reason,omitempty"`
	KeyLabel  string `json:"keyLabel,omitempty"`
}

// PairApproveEvent and PairApproveProgressEvent carry them to the page.
var (
	PairApproveEvent         = mygo.NewEvent[PairApproveUpdate]("pair-approve:update")
	PairApproveProgressEvent = mygo.NewEvent[PairApproveProgress]("pair-approve:progress")
)

// publishPairApprove and publishPairProgress send one; tests replace them.
var (
	publishPairApprove  = func(u PairApproveUpdate) { PairApproveEvent.Broadcast(u) }
	publishPairProgress = func(p PairApproveProgress) { PairApproveProgressEvent.Broadcast(p) }
)

// pairEnded is the sheet's line for a request that expired unapproved;
// pairCancelled for one its new device cancelled.
const (
	pairEnded     = "This request ended: it expired before anyone approved it."
	pairCancelled = "The other device cancelled this request."
)

// pairEndedLine says how p's request ended: cancelled by its new device,
// or (whatever else the service says, or if it can't be read) expired.
func pairEndedLine(ctx context.Context, p *pairApproval) string {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	state, _, err := p.a.Outcome(ctx)
	var api *account.APIError
	if state == account.ApprovalCancelled || (errors.As(err, &api) && api.Code == account.ApprovalCancelled) {
		return pairCancelled
	}
	return pairEnded
}

// PairApproveStart claims pair request id for this computer and waits (in
// the background, until the request expires) for the new device to show
// its code. One pair approval at a time: a new one replaces the last.
func (d *Desk) PairApproveStart(ctx context.Context, id string) error {
	cur, err := d.account.Current()
	if err != nil || cur == nil {
		return errSignedOutHere(err)
	}
	identity, err := d.guestIdentity()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	list, err := d.account.PairRequests(ctx, cur.AccountID)
	if err != nil {
		return err
	}
	i := slices.IndexFunc(list, func(r account.PairRequest) bool { return r.ID == id })
	if i < 0 {
		return errNoApproval
	}
	a, err := d.account.StartPairApproval(ctx, cur.AccountID, identity, list[i])
	if err != nil {
		return err
	}
	wctx, stop := context.WithTimeout(context.Background(), time.Duration(list[i].ExpiresIn)*time.Second)
	p := &pairApproval{a: a, cancel: stop}
	d.mu.Lock()
	if d.pairApproval != nil {
		d.pairApproval.cancel()
	}
	d.pairApproval = p
	d.mu.Unlock()
	go d.watchPair(wctx, p)
	return nil
}

// watchPair tells the page once the new device shows its code, or how the
// request ended; and, once it was shown, that it expired if it did so
// before this computer approved it.
func (d *Desk) watchPair(ctx context.Context, p *pairApproval) {
	id := p.a.Request().ID
	u := PairApproveUpdate{ID: id, State: "ready"}
	switch err := p.a.AwaitReveal(ctx); {
	case err == nil:
	case errors.Is(err, account.ErrApproveTampered):
		u.State, u.Problem = "tampered", "This request was tampered with. It was denied."
	case errors.Is(err, context.Canceled):
		return
	case errors.Is(err, context.DeadlineExceeded):
		u.State, u.Problem = "ended", pairEnded
	case errors.Is(err, account.ErrApprovalEnded):
		u.State, u.Problem = "ended", pairEndedLine(ctx, p)
	default:
		u.State, u.Problem = "ended", err.Error()
	}
	publishPairApprove(u)
	if u.State != "ready" {
		return
	}
	<-ctx.Done()
	if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return
	}
	// An approval in flight reports its own outcome.
	if !p.op.TryLock() {
		return
	}
	defer p.op.Unlock()
	if !p.approved && !p.pending {
		publishPairApprove(PairApproveUpdate{ID: id, State: "ended", Problem: pairEnded})
	}
}

func (d *Desk) currentPair(id string) (*pairApproval, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p := d.pairApproval
	if p == nil || p.a.Request().ID != id {
		return nil, errNoApproval
	}
	return p, nil
}

// PairApproveCheckCode compares the code the user typed with the new
// device's (3 tries; the last wrong one denies the request).
func (d *Desk) PairApproveCheckCode(ctx context.Context, id, typed string) (WebAccessCheck, error) {
	p, err := d.currentPair(id)
	if err != nil {
		return WebAccessCheck{}, err
	}
	if !p.op.TryLock() {
		return WebAccessCheck{}, errWebAccessBusy
	}
	defer p.op.Unlock()
	c, err := p.a.CheckCode(ctx, strings.TrimSpace(typed))
	if err != nil {
		return WebAccessCheck{}, err
	}
	out := WebAccessCheck{Ok: c.Ok, Left: c.Left, Denied: c.Denied}
	if c.Denied {
		p.cancel()
	}
	if c.DenyErr != nil {
		out.Problem = c.DenyErr.Error()
	}
	return out, nil
}

// PairApproveDeny denies request id. On an error the page keeps the
// request open so Deny can be tried again. Once the new device has a
// machine list from here there is nothing to deny.
func (d *Desk) PairApproveDeny(ctx context.Context, id string) error {
	p, err := d.currentPair(id)
	if err != nil {
		return err
	}
	if !p.op.TryLock() {
		return errWebAccessBusy
	}
	defer p.op.Unlock()
	if p.approved {
		return errors.New("the device was already approved: remove its key with herdr pair --revoke on each machine")
	}
	if err := p.a.Deny(ctx); err != nil && !errors.Is(err, account.ErrApprovalEnded) {
		return fmt.Errorf("couldn't deny (%w): Deny to try again", err)
	}
	p.cancel()
	return nil
}

// PairApproveRow is one ticked machine's outcome: "added", "already" or
// "failed" (Reason). KeyLabel is the label herdr stored the key under.
type PairApproveRow struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Status   string `json:"status"`
	Reason   string `json:"reason,omitempty"`
	KeyLabel string `json:"keyLabel,omitempty"`
}

// PairApproveResult is what an approval, or a retry, did. Sent: the new
// device has a list from here. Unsure: the service's answer was lost
// (Problem says how); Approve sends the same list again. Ended: the request
// ended, or retries did (Problem says so). Unsent: a retry's list didn't
// reach the service; Try again sends it.
type PairApproveResult struct {
	Machines []PairApproveRow `json:"machines"`
	Sent     bool             `json:"sent"`
	Unsure   bool             `json:"unsure,omitempty"`
	Ended    bool             `json:"ended,omitempty"`
	Unsent   bool             `json:"unsent,omitempty"`
	Problem  string           `json:"problem,omitempty"`
}

func (p *pairApproval) result() PairApproveResult {
	res := PairApproveResult{Machines: make([]PairApproveRow, 0, len(p.rows)), Sent: p.approved && !p.unsent}
	for _, r := range p.rows {
		res.Machines = append(res.Machines, PairApproveRow{ID: machineID(r.m), Label: machineLabel(r.m), Status: r.entry.Status, Reason: r.entry.Reason, KeyLabel: r.keyLabel})
	}
	return res
}

// envelope is the list the new device gets: every row but those held out.
func (p *pairApproval) envelope() account.PairEnvelope {
	e := account.PairEnvelope{V: account.PairEnvelopeVersion, Machines: make([]account.PairMachine, 0, len(p.rows))}
	for _, r := range p.rows {
		if r.held == "" {
			e.Machines = append(e.Machines, r.entry)
		}
	}
	return e
}

// PairApproveAdd adds the new device's key on each chosen machine, one at a
// time (progress goes to the page as each starts and ends), then sends it
// the sealed list of those machines. A machine that fails is in the list as
// failed, for Try again. After a lost answer it sends the same list again,
// whatever was chosen.
func (d *Desk) PairApproveAdd(ctx context.Context, id string, machineIDs []string) (PairApproveResult, error) {
	p, err := d.currentPair(id)
	if err != nil {
		return PairApproveResult{Machines: []PairApproveRow{}}, err
	}
	if !p.op.TryLock() {
		return PairApproveResult{Machines: []PairApproveRow{}}, errWebAccessBusy
	}
	defer p.op.Unlock()
	if p.pending {
		return d.sendPair(ctx, p)
	}
	if p.approved {
		return p.result(), errors.New("already approved: Try again adds the key where it failed")
	}
	// No key on any machine before the user typed the new device's code.
	if err := p.a.Ready(); err != nil {
		return PairApproveResult{Machines: []PairApproveRow{}}, err
	}
	d.storeMu.Lock()
	st, err := d.load()
	d.storeMu.Unlock()
	if err != nil {
		return PairApproveResult{Machines: []PairApproveRow{}}, err
	}
	// Every chosen machine is checked by the envelope's own rules before
	// any machine changes: one the list can't carry is held out, never
	// given the key, never sealed.
	var chosen []Machine
	var held []pairRow
	for _, m := range st.Machines {
		if !slices.Contains(machineIDs, machineID(m)) {
			continue
		}
		if err := pairSendable(m); err != nil {
			row := pairRow{m: m, entry: pairEntry(m), held: pairHeldReason(err)}
			row.entry.Status, row.entry.Reason = account.PairFailed, row.held
			held = append(held, row)
			continue
		}
		chosen = append(chosen, m)
	}
	if len(chosen) == 0 {
		if len(held) > 0 {
			return PairApproveResult{Machines: []PairApproveRow{}}, errors.New("none of these machines can be sent to the new device: " + held[0].held)
		}
		return PairApproveResult{Machines: []PairApproveRow{}}, errNoMachines
	}
	if !pairEnvelopeFits(chosen) {
		return PairApproveResult{Machines: []PairApproveRow{}}, errors.New("these machines don't fit in one approval: untick some and try again")
	}
	req := p.a.Request()
	key, err := req.AuthorizedKey()
	if err != nil {
		return PairApproveResult{Machines: []PairApproveRow{}}, err
	}
	label := engine.PairKeyLabel(req.Requester.Name, accountDeviceName())
	// The request must still be open, with time to add and report, before
	// any machine changes.
	deadline, err := p.a.Live(ctx, pairAddTime+pairReportTime)
	switch {
	case errors.Is(err, account.ErrApprovalEnded), errors.Is(err, account.ErrApprovalEnding):
		p.cancel()
		return PairApproveResult{Machines: []PairApproveRow{}, Ended: true, Problem: pairEndedLine(ctx, p)}, nil
	case err != nil:
		return PairApproveResult{Machines: []PairApproveRow{}}, err
	}
	reportBy := deadline.Add(-pairReportTime)
	addCtx, cancelAdds := context.WithDeadline(ctx, reportBy)
	defer cancelAdds()
	p.rows = make([]pairRow, 0, len(chosen)+len(held))
	for _, row := range held {
		publishPairProgress(PairApproveProgress{ID: id, MachineID: machineID(row.m), Status: account.PairFailed, Reason: row.held})
		p.rows = append(p.rows, row)
	}
	for _, m := range chosen {
		var row pairRow
		if time.Until(reportBy) < pairAddTime {
			row = pairRow{m: m, entry: pairEntry(m)}
			row.entry.Status, row.entry.Reason = account.PairFailed, errNoTimeLeft.Error()
		} else {
			row = d.addPairKey(addCtx, id, m, key, label)
		}
		p.rows = append(p.rows, row)
	}
	return d.sendPair(ctx, p)
}

// sendPair sends the approval with the list in p.rows at the next seq (1
// the first time; above any finish whose answer was lost).
func (d *Desk) sendPair(ctx context.Context, p *pairApproval) (PairApproveResult, error) {
	err := p.a.Approve(ctx, p.a.NextSeq(), p.envelope())
	var refused *account.NotApprovedError
	switch {
	case err == nil, errors.Is(err, account.ErrPairApproved):
		p.approved, p.pending = true, false
		p.sentAt = pairNow()
		return p.result(), nil
	case errors.Is(err, account.ErrPairListUnknown):
		// Approved, with which list unknown: this one goes again at the
		// next seq, now or on Try again.
		p.approved, p.pending = true, false
		p.sentAt = pairNow()
		err := p.a.Resend(ctx, p.a.NextSeq(), p.envelope())
		p.unsent = err != nil
		res := p.result()
		res.Unsent = p.unsent
		if err != nil {
			res.Problem = fmt.Sprintf("Couldn't send the list to %s (%v): Try again.", deviceOf(p), err)
		}
		return res, nil
	case errors.As(err, &refused):
		p.pending = false
		res := p.result()
		if errors.Is(err, account.ErrApprovalEnded) {
			res.Ended, res.Problem = true, pairEndedLine(ctx, p)
			p.cancel()
			return res, nil
		}
		p.cancel()
		return res, fmt.Errorf("%s wasn't approved: %w", deviceOf(p), err)
	}
	p.pending = true
	res := p.result()
	res.Unsure, res.Problem = true, err.Error()
	return res, nil
}

func deviceOf(p *pairApproval) string {
	if n := strings.TrimSpace(p.a.Request().Requester.Name); n != "" {
		return n
	}
	return "the device"
}

// PairApproveRetry adds the key again on machines that failed, then sends
// the new device the whole list again at the next seq. The service takes
// it for 10 minutes after the approval.
func (d *Desk) PairApproveRetry(ctx context.Context, id string, machineIDs []string) (PairApproveResult, error) {
	p, err := d.currentPair(id)
	if err != nil {
		return PairApproveResult{Machines: []PairApproveRow{}}, err
	}
	if !p.op.TryLock() {
		return PairApproveResult{Machines: []PairApproveRow{}}, errWebAccessBusy
	}
	defer p.op.Unlock()
	if !p.approved {
		return p.result(), errors.New("approve first")
	}
	// Before any machine changes: the service still holds the approval,
	// with time left (its own count, and the window from here) for an add
	// and the report.
	cur, err := d.account.Current()
	if err != nil || cur == nil {
		return p.result(), errSignedOutHere(err)
	}
	octx, cancel := context.WithTimeout(ctx, 10*time.Second)
	st, err := d.account.ApprovalState(octx, cur.AccountID, p.a.Request().ID)
	cancel()
	var api *account.APIError
	left := min(p.sentAt.Add(pairResendWindow).Sub(pairNow()), time.Duration(st.ExpiresIn)*time.Second)
	switch {
	case errors.As(err, &api) && (api.Status == http.StatusGone || api.Status == http.StatusNotFound),
		err == nil && (st.State != account.ApprovalApproved || left < pairAddTime+pairReportTime):
		res := p.result()
		res.Ended, res.Problem = true, pairTooLate
		return res, nil
	case err != nil:
		return p.result(), fmt.Errorf("couldn't check that %s still takes a list (%w): Try again", deviceOf(p), err)
	}
	req := p.a.Request()
	key, err := req.AuthorizedKey()
	if err != nil {
		return p.result(), err
	}
	label := engine.PairKeyLabel(req.Requester.Name, accountDeviceName())
	addCtx, cancelAdds := context.WithTimeout(ctx, left-pairReportTime)
	defer cancelAdds()
	tried := p.unsent
	for i, r := range p.rows {
		if r.held != "" || r.entry.Status != account.PairFailed || !slices.Contains(machineIDs, machineID(r.m)) {
			continue
		}
		// Only a machine still saved here, as it is saved now: its key
		// file or address may have changed, and one removed is not reached.
		m, err := d.savedMachine(machineID(r.m))
		reason := ""
		if err != nil {
			reason = err.Error()
		} else if err := pairSendable(m); err != nil {
			reason = pairHeldReason(err)
		}
		if reason != "" {
			p.rows[i].entry.Reason = reason
			publishPairProgress(PairApproveProgress{ID: id, MachineID: machineID(r.m), Status: account.PairFailed, Reason: reason})
			continue
		}
		if dl, _ := addCtx.Deadline(); time.Until(dl) < pairAddTime {
			continue
		}
		p.rows[i] = d.addPairKey(addCtx, id, m, key, label)
		tried = true
	}
	if !tried {
		return p.result(), errors.New("nothing to try again")
	}
	err = p.a.Resend(ctx, p.a.NextSeq(), p.envelope())
	p.unsent = err != nil
	res := p.result()
	switch {
	case err == nil:
	case errors.As(err, &api) && api.Status == http.StatusGone:
		p.unsent = false
		res.Ended, res.Problem = true, pairTooLate
	default:
		res.Problem = fmt.Sprintf("Couldn't send the new list to %s (%v): Try again.", deviceOf(p), err)
	}
	res.Unsent = p.unsent
	return res, nil
}

// pairTooLate is a retry the service no longer takes.
const pairTooLate = "Too late to try again: retries end 10 minutes after approving. Use herdr pair there."

// pairEntry is m in the envelope, before its key was added.
func pairEntry(m Machine) account.PairMachine {
	port := m.Port
	if port == 0 {
		port = 22
	}
	nick := []rune(machineLabel(m))
	if len(nick) > 64 {
		nick = nick[:64]
	}
	return account.PairMachine{Nickname: string(nick), Host: m.Host, Port: port, User: m.User}
}

// addPairKey adds key on m over this computer's own SSH session and
// records m's host key as that session verified it, checked against the
// pin kept here.
func (d *Desk) addPairKey(ctx context.Context, id string, m Machine, key, label string) pairRow {
	mid := machineID(m)
	publishPairProgress(PairApproveProgress{ID: id, MachineID: mid, Status: "adding"})
	row := pairRow{m: m, entry: pairEntry(m)}
	fail := func(reason string) pairRow {
		row.entry.Status, row.entry.Reason = account.PairFailed, reason
		publishPairProgress(PairApproveProgress{ID: id, MachineID: mid, Status: account.PairFailed, Reason: reason})
		return row
	}
	ctx, cancel := context.WithTimeout(ctx, pairAddTime)
	defer cancel()
	c, done, err := d.pairBridge(ctx, m)
	switch {
	case errors.Is(err, errNeedsKey):
		return fail("needs a key file")
	case errors.Is(err, errNoPin):
		return fail(errNoPin.Error())
	case err != nil:
		return fail(pairReason(ctx, err))
	}
	defer done()
	hostKey, err := d.verifiedHostKey(c)
	if err != nil {
		return fail(err.Error())
	}
	row.entry.HostKey = hostKey
	added, err := engine.New(engine.Bridge(c)).PairAddKey(ctx, engine.PairAddKeyParams{PublicKey: key, Label: label})
	if err != nil {
		return fail(pairReason(ctx, err))
	}
	row.entry.Status = account.PairAdded
	if added.Already {
		row.entry.Status = account.PairAlready
	}
	row.keyLabel = added.Label
	publishPairProgress(PairApproveProgress{ID: id, MachineID: mid, Status: row.entry.Status, KeyLabel: added.Label})
	return row
}

// verifiedHostKey is the host key c's first handshake verified, as an
// OpenSSH line with no comment, once it matches the pin kept here under
// the address it dialled.
func (d *Desk) verifiedHostKey(c *bridge.Client) (string, error) {
	key, addr := c.HostKey()
	if key == nil {
		return "", errors.New("no host key from this connection")
	}
	pin, ok, err := d.pins.Pin(addr)
	switch {
	case err != nil:
		return "", err
	case !ok || pin != bridge.Fingerprint(key):
		return "", errors.New("its host key doesn't match the one pinned here")
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))), nil
}

// pairReason says why adding the key failed, short enough for a row.
func pairReason(ctx context.Context, err error) string {
	var old *engine.ErrUnsupported
	var api *bridge.APIError
	switch {
	case errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil:
		return "timed out"
	case errors.As(err, &old):
		return "needs a herdr update"
	case errors.Is(err, engine.ErrPairKeyInvalid):
		return "herdr refused the new device's key"
	case errors.Is(err, engine.ErrPairLabelInvalid):
		return "herdr refused the key's name"
	case errors.Is(err, engine.ErrPairGuestForbidden), errors.Is(err, engine.ErrPairOwnerForbidden):
		return "herdr refused this connection"
	case errors.Is(err, engine.ErrPairWriteFailed):
		return "herdr couldn't write authorized_keys"
	case errors.Is(err, engine.ErrPairUnsupportedOS):
		return "pairing isn't supported on this machine's system"
	case errors.Is(err, engine.ErrPairReadFailed):
		return "herdr couldn't read authorized_keys"
	case errors.As(err, &api) && api.Code == "forbidden":
		return "herdr refused this connection"
	case errors.As(err, &api):
		return truncate(api.Message, 120)
	}
	return truncate(err.Error(), 120)
}

// pairEnvelopeFits reports whether the sealed list for chosen fits what the
// service takes, each machine counted with its longest entry: an RSA 8192
// host key and a full reason.
func pairEnvelopeFits(chosen []Machine) bool {
	e := account.PairEnvelope{V: account.PairEnvelopeVersion}
	for _, m := range chosen {
		entry := pairEntry(m)
		entry.HostKey = "ssh-rsa " + strings.Repeat("A", 1400)
		entry.Status = account.PairFailed
		entry.Reason = strings.Repeat("r", 120)
		e.Machines = append(e.Machines, entry)
	}
	plain, err := json.Marshal(e)
	return err == nil && account.SealedLength(len(plain)) <= account.MaxSealedLength
}
