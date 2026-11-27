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

// ApprovalRequest is one request waiting for approval on the account, in
// the list ApprovalRequests reads (GET /v1/approvals?kind=any) in the
// service's order: Kind "browser" (Browser) or "pair" (Pair). The page
// polls this one list, not a list per kind, so pair requests cost the
// account's approval rate nothing over browser ones.
type ApprovalRequest struct {
	Kind    string              `json:"kind"`
	Browser *WebAccessRequest   `json:"browser,omitempty"`
	Pair    *PairApproveRequest `json:"pair,omitempty"`
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

// ApprovalRequests lists the browsers and new devices waiting for
// approval, in the service's order, which the page opens them in.
func (d *Desk) ApprovalRequests(ctx context.Context) ([]ApprovalRequest, error) {
	cur, err := d.account.Current()
	if err != nil || cur == nil {
		return []ApprovalRequest{}, errSignedOutHere(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	list, err := d.account.AnyApprovals(ctx, cur.AccountID)
	if err != nil {
		return []ApprovalRequest{}, err
	}
	out := make([]ApprovalRequest, 0, len(list))
	for _, r := range list {
		switch {
		case r.Pair != nil:
			p := pairApproveRequest(*r.Pair)
			out = append(out, ApprovalRequest{Kind: "pair", Pair: &p})
		case r.Browser != nil:
			b := webAccessRequest(*r.Browser)
			out = append(out, ApprovalRequest{Kind: "browser", Browser: &b})
		}
	}
	return out, nil
}

func pairApproveRequest(r account.PairRequest) PairApproveRequest {
	return PairApproveRequest{ID: r.ID, DeviceName: r.Requester.Name, Platform: r.Requester.Platform, Claimed: r.Claimed, ExpiresIn: r.ExpiresIn}
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

	// probed is each machine's host key as its probe verified it (machine
	// id to OpenSSH line), which sizes the list before any key is added.
	probedMu sync.Mutex
	probed   map[string]string
}

func (p *pairApproval) probedKey(machineID string) string {
	p.probedMu.Lock()
	defer p.probedMu.Unlock()
	return p.probed[machineID]
}

// pairRow is one ticked machine: its saved entry, and its envelope entry.
// hostKey is the host key the list is sized with: the probe's, until a
// connection to add the key verified one. held is why a machine the
// envelope can't carry was left out of it (it is shown failed, never
// sealed, never tried again). retry: a failure Try again may mend (a
// timeout, say, not a herdr too old).
type pairRow struct {
	m        Machine
	entry    account.PairMachine
	hostKey  string
	keyLabel string
	held     string
	retry    bool
}

// fail marks r failed with reason (cut to pairReasonRunes).
func (r *pairRow) fail(reason string, retry bool) {
	r.entry.Status, r.entry.Reason, r.retry = account.PairFailed, truncate(reason, pairReasonRunes), retry
}

// hold leaves r out of the list, failed, for reason.
func (r *pairRow) hold(reason string) {
	r.fail(reason, false)
	r.held, r.entry.HostKey = r.entry.Reason, ""
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
// this computer, so no host key is kept for it) or "unsendable" (it can't
// be shared now: the list the new device gets can't carry it, or its host
// key can't be checked here; Reason says why).
type PairProbe struct {
	State   string `json:"state"`
	Version string `json:"version,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// PairApproveProbe connects to saved machine machineID for pair request
// id, briefly and at most a few machines at a time, and says whether a key
// can be added there. Only once the typed code matched: before, no
// machine is reached at all. It adds nothing, and pins nothing. The host
// key it verified is kept for sizing the list (PairApproveAdd); a machine
// whose entry alone can't fit is "unsendable".
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
		if unread := (*pinsUnreadError)(nil); errors.As(err, &unread) {
			return PairProbe{State: "unsendable", Reason: truncate(unread.Error(), pairReasonRunes)}, nil
		}
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
	hostKey, err := d.verifiedHostKey(c)
	if err != nil {
		return PairProbe{State: "unsendable", Reason: truncate(err.Error(), pairReasonRunes)}, nil
	}
	if err := pairFits([]pairRow{{entry: pairEntry(m), hostKey: hostKey}}); err != nil {
		return PairProbe{State: "unsendable", Reason: pairHeldReason(err)}, nil
	}
	p.probedMu.Lock()
	if p.probed == nil {
		p.probed = map[string]string{}
	}
	p.probed[machineID] = hostKey
	p.probedMu.Unlock()
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

func (p *pairPins) Pin(addr string) (string, bool, error) {
	pin, ok, err := p.PinStore.Pin(addr)
	if err != nil {
		return "", false, &pinsUnreadError{err}
	}
	return pin, ok, nil
}

// pinsUnreadError is a pin store this computer couldn't read: no host key
// can be checked, so no machine is used.
type pinsUnreadError struct{ err error }

func (e *pinsUnreadError) Error() string {
	return "couldn't read the host keys pinned here (" + e.err.Error() + ")"
}

func (e *pinsUnreadError) Unwrap() error { return e.err }

// pairBridge is this computer's own SSH session to m for a pair approval.
// The live connection is used, however it signed in (a password machine
// is usable only then), while its host key is the one pinned here now; a
// pin store not read is its error. Otherwise a new session (dialMachine)
// negotiates as the machine was pinned, as the live one did, so the host
// shows the key this computer trusts. The pin holds a fingerprint only:
// when that session's key isn't the pinned one (a host pinned by its
// ed25519 key or certificate that offers an ECDSA one since, which SSH's
// defaults prefer), one session per type in pairSearchTypes looks for it,
// and the first whose key or certificate is the pinned one is used. A
// session failing otherwise than on its host key ends the search with its
// error; none found, the host key changed. A machine without a pin is
// errNoPin; nothing is ever pinned. The key is sent if the new device
// checks its type (verifiedHostKey).
func (d *Desk) pairBridge(ctx context.Context, m Machine) (*bridge.Client, func(), error) {
	if c := d.liveBridge(m); c != nil {
		if key, addr := c.HostKey(); key != nil {
			switch err := d.pinnedKey(key, addr); {
			case err == nil:
				return c, func() {}, nil
			case !errors.Is(err, errNotPinned):
				return nil, nil, err
			}
		}
	}
	pins := &pairPins{PinStore: d.pins}
	c, done, err := d.dialMachine(ctx, m, pins, nil)
	var changed *bridge.HostKeyChangedError
	switch {
	case err != nil && pins.missing.Load():
		return nil, nil, errNoPin
	case errors.As(err, &changed):
		for _, algo := range pairSearchTypes {
			tc, tdone, terr := d.dialMachine(ctx, m, pins, []string{algo})
			var other *bridge.HostKeyChangedError
			var none *ssh.AlgorithmNegotiationError
			switch {
			case terr == nil:
				return tc, tdone, nil
			case errors.As(terr, &other):
				continue
			case errors.As(terr, &none) && none.What == "host key":
				continue
			}
			// The key was the pinned one and the session failed after
			// (its sign-in, say), or it failed on something else (its key
			// exchange): it says why.
			return nil, nil, terr
		}
	}
	return c, done, err
}

// errNotPinned is a host key other than the one pinned here.
var errNotPinned = errors.New("its host key doesn't match the one pinned here")

// pinnedKey says whether key, from a session to addr, is the one pinned
// here: nil when it is, errNotPinned when not (or no pin), and a
// pinsUnreadError when the pin store can't be read.
func (d *Desk) pinnedKey(key ssh.PublicKey, addr string) error {
	pin, ok, err := d.pins.Pin(addr)
	switch {
	case err != nil:
		return &pinsUnreadError{err}
	case !ok || pin != bridge.Fingerprint(key):
		return errNotPinned
	}
	return nil
}

// pairHostKeyTypes are the host keys the new device checks (pair-v1
// host_key).
var pairHostKeyTypes = []string{ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521}

// pairSearchTypes are what pairBridge negotiates, one session each, to
// find the pinned host key: pairHostKeyTypes, each followed by its
// certificate, as a pin may hold a certificate's fingerprint (SSH's
// defaults negotiate one first). The certified key is what is sent.
var pairSearchTypes = []string{
	ssh.KeyAlgoED25519, ssh.CertAlgoED25519v01,
	ssh.KeyAlgoECDSA256, ssh.CertAlgoECDSA256v01,
	ssh.KeyAlgoECDSA384, ssh.CertAlgoECDSA384v01,
	ssh.KeyAlgoECDSA521, ssh.CertAlgoECDSA521v01,
}

// errHostKeyType is a machine whose verified host key the new device
// can't check (an RSA key, say): it is held out of the list before any
// key is added there.
var errHostKeyType = errors.New("can't share this machine: its host key type isn't supported")

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

// pairHeldReason is a row's reason for a machine pairSendable or pairFits
// refused on its own.
func pairHeldReason(err error) string {
	return truncate("can't be sent to the new device: "+strings.TrimPrefix(err.Error(), "pair-v1: "), pairReasonRunes)
}

// pairReasonRunes bounds every row's reason (truncate).
const pairReasonRunes = 120

// pairNoRoom is a machine left out because the list, with the machines
// before it, would be too long for the service.
const pairNoRoom = "no room for it in the list with the others"

// pairFits says why the list for rows might not fit the service, by the
// envelope's own rules (PairEnvelope.Marshal), nil when it fits. Each row
// not held out counts with its host key (the probe's, or the one its
// connection verified) and its longest status, "already", but no reason:
// a reason is optional on the wire, and the list leaves out what doesn't
// fit (pairApproval.envelope). A row with no host key yet counts without
// one, as failed: before a connection adds a key there it checks the
// list again with the key it verified.
func pairFits(rows []pairRow) error {
	e := account.PairEnvelope{V: account.PairEnvelopeVersion, Machines: make([]account.PairMachine, 0, len(rows))}
	for _, r := range rows {
		if r.held != "" {
			continue
		}
		longest := r.entry
		longest.HostKey, longest.Status, longest.Reason = r.hostKey, account.PairAlready, ""
		if r.hostKey == "" {
			longest.Status = account.PairFailed
		}
		e.Machines = append(e.Machines, longest)
	}
	_, err := e.Marshal()
	return err
}

// errMachineGone is a machine the store, read, no longer has.
var errMachineGone = errors.New("that machine is no longer saved here")

// savedMachine is the machine saved here as id, errMachineGone when the
// store has none; any other error is the store unread.
func (d *Desk) savedMachine(id string) (Machine, error) {
	d.storeMu.Lock()
	st, err := d.load()
	d.storeMu.Unlock()
	if err != nil {
		return Machine{}, err
	}
	i := slices.IndexFunc(st.Machines, func(m Machine) bool { return machineID(m) == id })
	if i < 0 {
		return Machine{}, errMachineGone
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
// Retryable: a failed machine Try again may mend (PairApproveRetry tries
// no other).
type PairApproveRow struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Status    string `json:"status"`
	Reason    string `json:"reason,omitempty"`
	KeyLabel  string `json:"keyLabel,omitempty"`
	Retryable bool   `json:"retryable,omitempty"`
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
		res.Machines = append(res.Machines, PairApproveRow{ID: machineID(r.m), Label: machineLabel(r.m), Status: r.entry.Status, Reason: r.entry.Reason, KeyLabel: r.keyLabel, Retryable: r.retryable()})
	}
	return res
}

// retryable: r failed in a way Try again may mend, and the list carries it.
func (r pairRow) retryable() bool {
	return r.held == "" && r.entry.Status == account.PairFailed && r.retry
}

// envelope is the list the new device gets: every row but those held out.
// The list is sized without reasons (pairFits): when they make it too
// long they are left out from the last row on until it fits. The sheet
// keeps every reason (result).
func (p *pairApproval) envelope() account.PairEnvelope {
	e := account.PairEnvelope{V: account.PairEnvelopeVersion, Machines: make([]account.PairMachine, 0, len(p.rows))}
	for _, r := range p.rows {
		if r.held == "" {
			e.Machines = append(e.Machines, r.entry)
		}
	}
	for i := len(e.Machines) - 1; i >= 0; i-- {
		if _, err := e.Marshal(); !errors.Is(err, account.ErrPairEnvelopeTooLong) {
			break
		}
		e.Machines[i].Reason = ""
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
	// any machine changes, with the host key its probe verified: one the
	// list can't carry, alone or after the machines before it, is held
	// out, never given the key, never sealed.
	var rows []pairRow
	for _, m := range st.Machines {
		if !slices.Contains(machineIDs, machineID(m)) {
			continue
		}
		row := pairRow{m: m, entry: pairEntry(m), hostKey: p.probedKey(machineID(m))}
		if err := pairFits([]pairRow{row}); err != nil {
			row.hold(pairHeldReason(err))
		} else if pairFits(append(slices.Clone(rows), row)) != nil {
			row.hold(pairNoRoom)
		}
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		return PairApproveResult{Machines: []PairApproveRow{}}, errNoMachines
	}
	if !slices.ContainsFunc(rows, func(r pairRow) bool { return r.held == "" }) {
		return PairApproveResult{Machines: []PairApproveRow{}}, errors.New("none of these machines can be sent to the new device: " + rows[0].held)
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
	p.rows = rows
	for _, row := range rows {
		if row.held != "" {
			publishPairProgress(PairApproveProgress{ID: id, MachineID: machineID(row.m), Status: account.PairFailed, Reason: row.held})
		}
	}
	for i, row := range p.rows {
		switch {
		case row.held != "":
		case time.Until(reportBy) < pairAddTime:
			p.rows[i].fail(errNoTimeLeft.Error(), true)
		default:
			p.rows[i] = d.addPairKey(addCtx, id, p.rows, i, key, label)
		}
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

// PairApproveRetry adds the key again on machines that failed in a way a
// retry may mend (Retryable), then sends the new device the whole list
// again at the next seq. The service takes it for 10 minutes after the
// approval; a list the service didn't take goes again until then, a key is
// added only with time left to add it and report.
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
	// with time left (its own count, and the window from here).
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
		err == nil && (st.State != account.ApprovalApproved || left <= 0):
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
	// A key written needs time for the add and the report; the list alone
	// goes while the service takes it.
	addBy := pairNow().Add(left - pairReportTime)
	addCtx, cancelAdds := context.WithTimeout(ctx, max(left-pairReportTime, 0))
	defer cancelAdds()
	tried, late, answered := p.unsent, false, false
	for i, r := range p.rows {
		if !r.retryable() || !slices.Contains(machineIDs, machineID(r.m)) {
			continue
		}
		// Only a machine still saved here, as it is saved now: its key
		// file or address may have changed, and one removed is not reached.
		// Only a store read that has no such machine, or a saved profile
		// the list can't carry, ends its retries: a store not read (an
		// error, a change not yet committed) may be read next time.
		m, err := d.savedMachine(machineID(r.m))
		reason, retry := "", false
		switch {
		case errors.Is(err, errMachineGone):
			reason = err.Error()
		case err != nil:
			reason, retry = fmt.Sprintf("couldn't read the machines saved here (%v)", err), true
		default:
			if err := pairSendable(m); err != nil {
				reason = pairHeldReason(err)
			}
		}
		if reason != "" {
			p.rows[i].fail(reason, retry)
			publishPairProgress(PairApproveProgress{ID: id, MachineID: machineID(r.m), Status: account.PairFailed, Reason: p.rows[i].entry.Reason})
			answered = true
			continue
		}
		if addBy.Sub(pairNow()) < pairAddTime {
			late = true
			continue
		}
		now := slices.Clone(p.rows)
		now[i] = pairRow{m: m, entry: pairEntry(m), hostKey: r.hostKey}
		p.rows[i] = d.addPairKey(addCtx, id, now, i, key, label)
		tried = true
	}
	if !tried {
		switch {
		case late:
			res := p.result()
			res.Ended, res.Problem = true, pairTooLate
			return res, nil
		case answered:
			// Rows with a new reason (and Try again only for those a retry
			// may still mend): the sheet shows them.
			return p.result(), nil
		}
		return p.result(), errors.New("nothing to try again")
	}
	err = p.a.Resend(ctx, p.a.NextSeq(), p.envelope())
	p.unsent = err != nil
	res := p.result()
	switch {
	case err == nil && late:
		// Sent; the machines left out have no time for a key any more.
		res.Ended, res.Problem = true, pairTooLate
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

// addPairKey adds key on rows[i]'s machine over this computer's own SSH
// session and records its host key as that session verified it, checked
// against the pin kept here. Before the key is added, the list (rows) is
// sized again with that host key: a machine that would make it too long
// for the service gets no key and is held out.
func (d *Desk) addPairKey(ctx context.Context, id string, rows []pairRow, i int, key, label string) pairRow {
	row := rows[i]
	mid := machineID(row.m)
	publishPairProgress(PairApproveProgress{ID: id, MachineID: mid, Status: "adding"})
	fail := func(reason string, retry bool) pairRow {
		row.fail(reason, retry)
		publishPairProgress(PairApproveProgress{ID: id, MachineID: mid, Status: account.PairFailed, Reason: row.entry.Reason})
		return row
	}
	hold := func(reason string) pairRow {
		row.hold(reason)
		publishPairProgress(PairApproveProgress{ID: id, MachineID: mid, Status: account.PairFailed, Reason: row.held})
		return row
	}
	ctx, cancel := context.WithTimeout(ctx, pairAddTime)
	defer cancel()
	c, done, err := d.pairBridge(ctx, row.m)
	switch {
	case errors.Is(err, errNeedsKey):
		return fail("needs a key file", false)
	case errors.Is(err, errNoPin):
		return fail(errNoPin.Error(), false)
	case err != nil:
		return fail(pairReason(ctx, err))
	}
	defer done()
	hostKey, err := d.verifiedHostKey(c)
	switch {
	case errors.Is(err, errHostKeyType):
		return hold(err.Error())
	case err != nil:
		return fail(err.Error(), false)
	}
	sized := slices.Clone(rows)
	sized[i].hostKey = hostKey
	if pairFits(sized) != nil {
		return hold(pairNoRoom)
	}
	row.hostKey, row.entry.HostKey = hostKey, hostKey
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
// the address it dialled. The list carries plain keys the new device
// checks only (pairHostKeyTypes): for a host certificate it is the key
// the certificate certifies, which is what the new device pins (it never
// negotiates certificates); errHostKeyType for any other key.
func (d *Desk) verifiedHostKey(c *bridge.Client) (string, error) {
	key, addr := c.HostKey()
	if key == nil {
		return "", errors.New("no host key from this connection")
	}
	if err := d.pinnedKey(key, addr); err != nil {
		return "", err
	}
	if cert, isCert := key.(*ssh.Certificate); isCert {
		key = cert.Key
	}
	if key == nil || !slices.Contains(pairHostKeyTypes, key.Type()) {
		return "", errHostKeyType
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))), nil
}

// pairReason says why adding the key failed, and whether Try again may
// mend it (a timeout, a connection, a write; not a herdr too old, nor one
// refusing the key). The row cuts it short (pairRow.fail).
func pairReason(ctx context.Context, err error) (string, bool) {
	var old *engine.ErrUnsupported
	var api *bridge.APIError
	var unread *pinsUnreadError
	switch {
	case errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil:
		return "timed out", true
	case errors.As(err, &unread):
		return unread.Error(), true
	case errors.As(err, &old):
		return "needs a herdr update", false
	case errors.Is(err, engine.ErrPairKeyInvalid):
		return "herdr refused the new device's key", false
	case errors.Is(err, engine.ErrPairLabelInvalid):
		return "herdr refused the key's name", false
	case errors.Is(err, engine.ErrPairGuestForbidden), errors.Is(err, engine.ErrPairOwnerForbidden):
		return "herdr refused this connection", false
	case errors.Is(err, engine.ErrPairWriteFailed):
		return "herdr couldn't write authorized_keys", true
	case errors.Is(err, engine.ErrPairUnsupportedOS):
		return "pairing isn't supported on this machine's system", false
	case errors.Is(err, engine.ErrPairReadFailed):
		return "herdr couldn't read authorized_keys", true
	case errors.As(err, &api) && api.Code == "forbidden":
		return "herdr refused this connection", false
	case errors.As(err, &api):
		return api.Message, true
	}
	return err.Error(), true
}
