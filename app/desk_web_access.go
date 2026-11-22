package main

// Web owner access, the approving device's side (WIRE-PLAN §2, D1): a browser
// signed in to the account asks to reach the owner's machines; this computer
// shows the request, the user types the browser's 4-digit code, picks
// machines, access and time, and this computer adds a grant on each machine
// over SSH (owner_access.add, herdr #491) and seals the machine list to the
// browser. The account service carries the request and the sealed list; it
// can't grant anything itself.
//
// Grants exist only for a recorded approval: they are made after the service
// confirms the request is still open, and removed again when the service
// definitely didn't record the approval. When that can't be told (no
// answer), the grants stay and Approve retries the same report.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/account"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
	"github.com/jerryfane/herdrup-desktop/internal/webrelay"
)

// webNow is the clock for grant expiry and envelope seq; tests replace it.
var webNow = time.Now

// webAccessTTLs are the lengths the sheet offers, longest first (owner
// decision: 30 days at most).
var webAccessTTLs = map[string]time.Duration{"1d": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}

// WebAccessRequest is one browser waiting for approval, for the sheet.
type WebAccessRequest struct {
	ID          string `json:"id"`
	BrowserName string `json:"browserName"`
	CreatedMs   int64  `json:"createdMs"`
	// Claimed is "no", "you" or "other" (another device is approving it).
	Claimed   string `json:"claimed"`
	ExpiresIn int64  `json:"expiresIn"`
}

// WebAccessMachine is one saved machine as the sheet lists it.
type WebAccessMachine struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// Available: this computer can open a session there now (a key file, or
	// the machine it is connected to).
	Available bool `json:"available"`
	// Why not, when not available: "needs_key" (password machine, not
	// connected now).
	Unavailable string `json:"unavailable,omitempty"`
}

// WebAccessResult is what an approval did on each machine.
type WebAccessResult struct {
	Granted []string           `json:"granted"`
	Skipped []WebAccessSkipped `json:"skipped"`
	Failed  []WebAccessSkipped `json:"failed"`
	// Unsure: the service's answer to the approval was lost (Problem says
	// how); the grants are kept, Approve sends the same report again and
	// Deny removes them.
	Unsure  bool   `json:"unsure,omitempty"`
	Problem string `json:"problem,omitempty"`
}

// WebAccessSkipped is a machine left out, with the reason the browser sees
// (envelope "skipped": needs_update | unsupported | unreachable | relay_not_allowed)
// or the error text for a failure.
type WebAccessSkipped struct {
	Label  string `json:"label"`
	Reason string `json:"reason"`
}

// webApproval is the one approval in progress on this computer.
type webApproval struct {
	acct string
	// approver is this computer's device key (envelope seqs are per key).
	approver []byte
	a        *account.Approval
	cancel   context.CancelFunc
	// op makes Approve and Deny one at a time.
	op sync.Mutex
	// pending is an approval whose report got no answer: its grants stand
	// until the service's outcome is known. Guarded by op.
	pending *webPending
}

// webPending is a report sent without a known outcome, and the grants it
// carries.
type webPending struct {
	scope     string
	expiresMs int64
	seq       uint64
	envelope  []byte
	grants    []webGrant
	res       WebAccessResult
}

// webGrant is a grant made on one machine, to remove it again.
type webGrant struct {
	m       webMachine
	grantID string
}

var (
	errNoApproval     = errors.New("that request is no longer open here")
	errNoMachines     = errors.New("choose at least one machine")
	errWebAccessScope = errors.New("choose chat or chat and terminal")
	errWebAccessBusy  = errors.New("still working on this request")
	errAlreadyOver    = errors.New("the browser was already approved: remove it under Devices to take its access away")
)

// webSeqMu serializes envelope seqs on this computer.
var webSeqMu sync.Mutex

// webSeqState is the highest envelope seq this computer used, per device key,
// kept on disk (web-approve-seq.json).
type webSeqState struct {
	Approver string `json:"approver"`
	Seq      uint64 `json:"seq"`
}

// nextWebSeq is the next envelope seq for approver: the clock in
// milliseconds, above any seq this key used before, written to disk before it
// is used. The service keeps the highest seq per browser and approver and
// refuses one not above it (herdrup #792); this device can't read that value,
// so each report, a new approval included, takes a fresh, larger one, also
// after a restart and a clock set back.
func (d *Desk) nextWebSeq(approver []byte) (uint64, error) {
	webSeqMu.Lock()
	defer webSeqMu.Unlock()
	path := filepath.Join(d.dir, "web-approve-seq.json")
	key := base64.RawURLEncoding.EncodeToString(approver)
	var st webSeqState
	if data, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(data, &st); err != nil {
			return 0, fmt.Errorf("web-approve-seq.json: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return 0, err
	}
	last := uint64(0)
	if st.Approver == key {
		last = st.Seq
	}
	next := max(uint64(webNow().UnixMilli()), last+1)
	data, err := json.Marshal(webSeqState{Approver: key, Seq: next})
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(d.dir, 0o700); err != nil {
		return 0, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return 0, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return 0, err
	}
	return next, nil
}

// WebAccessOffered reports whether the account service carries browser
// approvals. An error means the service couldn't be asked; the page asks
// again on its next look.
func (d *Desk) WebAccessOffered(ctx context.Context) (bool, error) {
	cur, err := d.account.Current()
	if err != nil || cur == nil {
		return false, errSignedOutHere(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return d.account.WebApproveOffered(ctx)
}

// WebAccessRequests lists browsers waiting for approval on the account.
func (d *Desk) WebAccessRequests(ctx context.Context) ([]WebAccessRequest, error) {
	cur, err := d.account.Current()
	if err != nil || cur == nil {
		return []WebAccessRequest{}, errSignedOutHere(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	list, err := d.account.Approvals(ctx, cur.AccountID)
	if err != nil {
		return []WebAccessRequest{}, err
	}
	out := make([]WebAccessRequest, 0, len(list))
	for _, r := range list {
		out = append(out, WebAccessRequest{ID: r.ID, BrowserName: r.Browser.Name, CreatedMs: r.Browser.CreatedMs, Claimed: r.Claimed, ExpiresIn: r.ExpiresIn})
	}
	return out, nil
}

// WebAccessMachines lists the saved machines the sheet offers.
func (d *Desk) WebAccessMachines() ([]WebAccessMachine, error) {
	d.storeMu.Lock()
	st, err := d.load()
	d.storeMu.Unlock()
	if err != nil {
		return nil, err
	}
	d.mu.Lock()
	connected := ""
	if d.link != nil && d.link.client != nil {
		connected = d.link.id
	}
	d.mu.Unlock()
	out := make([]WebAccessMachine, 0, len(st.Machines))
	for _, m := range st.Machines {
		id := machineID(m)
		w := WebAccessMachine{ID: id, Label: machineLabel(m), Available: m.KeyPath != "" || id == connected}
		if !w.Available {
			w.Unavailable = "needs_key"
		}
		out = append(out, w)
	}
	return out, nil
}

func machineLabel(m Machine) string {
	if n := strings.TrimSpace(m.Nickname); n != "" {
		return n
	}
	return m.Host
}

// WebAccessStart claims request id for this computer and waits (in the
// background, until the request expires) for the browser to show its code.
// One approval at a time: a new one replaces the last.
func (d *Desk) WebAccessStart(ctx context.Context, id string) error {
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
	list, err := d.account.Approvals(ctx, cur.AccountID)
	if err != nil {
		return err
	}
	i := slices.IndexFunc(list, func(r account.ApprovalRequest) bool { return r.ID == id })
	if i < 0 {
		return errNoApproval
	}
	a, err := d.account.StartApproval(ctx, cur.AccountID, identity, list[i])
	if err != nil {
		return err
	}
	wctx, stop := context.WithTimeout(context.Background(), time.Duration(list[i].ExpiresIn)*time.Second)
	w := &webApproval{acct: cur.AccountID, approver: identity.PublicKey(), a: a, cancel: stop}
	d.mu.Lock()
	if d.webApproval != nil {
		d.webApproval.cancel()
	}
	d.webApproval = w
	d.mu.Unlock()
	go func() {
		err := a.AwaitReveal(wctx)
		d.emitWebAccess(id, err)
	}()
	return nil
}

// WebAccessUpdate tells the page where an approval stands: "ready" (the
// browser shows its code; type it), "tampered" (denied) or "ended".
type WebAccessUpdate struct {
	ID      string `json:"id"`
	State   string `json:"state"`
	Problem string `json:"problem,omitempty"`
}

// WebAccessEvent carries approval updates to the page.
var WebAccessEvent = mygo.NewEvent[WebAccessUpdate]("web-access:update")

// publishWebAccess sends one update; tests replace it.
var publishWebAccess = func(u WebAccessUpdate) { WebAccessEvent.Broadcast(u) }

// emitWebAccess tells the page the browser revealed (err nil) or the
// approval ended.
func (d *Desk) emitWebAccess(id string, err error) {
	u := WebAccessUpdate{ID: id, State: "ready"}
	switch {
	case err == nil:
	case errors.Is(err, account.ErrApproveTampered):
		u.State, u.Problem = "tampered", "This request was tampered with. It was denied."
	case errors.Is(err, context.Canceled):
		return
	case errors.Is(err, context.DeadlineExceeded):
		u.State, u.Problem = "ended", "This request expired before the browser showed its code."
	default:
		u.State, u.Problem = "ended", err.Error()
	}
	publishWebAccess(u)
}

func (d *Desk) currentApproval(id string) (*webApproval, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	w := d.webApproval
	if w == nil || w.a.Request().ID != id {
		return nil, errNoApproval
	}
	return w, nil
}

// WebAccessCheck is a typed code's outcome. Left is how many more codes may
// be typed; at 0 this computer won't approve the request, and Denied says the
// browser was told (else Problem says why not, and Deny tries again).
type WebAccessCheck struct {
	Ok      bool   `json:"ok"`
	Left    int    `json:"left"`
	Denied  bool   `json:"denied"`
	Problem string `json:"problem,omitempty"`
}

// WebAccessCheckCode compares the code the user typed.
func (d *Desk) WebAccessCheckCode(ctx context.Context, id, typed string) (WebAccessCheck, error) {
	w, err := d.currentApproval(id)
	if err != nil {
		return WebAccessCheck{}, err
	}
	if !w.op.TryLock() {
		return WebAccessCheck{}, errWebAccessBusy
	}
	defer w.op.Unlock()
	c, err := w.a.CheckCode(ctx, strings.TrimSpace(typed))
	if err != nil {
		return WebAccessCheck{}, err
	}
	out := WebAccessCheck{Ok: c.Ok, Left: c.Left, Denied: c.Denied}
	if c.Denied {
		w.cancel()
	}
	if c.DenyErr != nil {
		out.Problem = c.DenyErr.Error()
	}
	return out, nil
}

// WebAccessDeny denies request id. It returns only once the service took the
// denial (or the request was already over); on an error the page keeps the
// request open so Deny can be tried again. Grants waiting on a report with
// no known outcome are removed once this denial was taken, or once the
// service shows the request ended with no report of this device recorded.
func (d *Desk) WebAccessDeny(ctx context.Context, id string) error {
	w, err := d.currentApproval(id)
	if err != nil {
		return err
	}
	if !w.op.TryLock() {
		return errWebAccessBusy
	}
	defer w.op.Unlock()
	denyErr := w.a.Deny(ctx)
	if denyErr != nil && !errors.Is(denyErr, account.ErrApprovalEnded) {
		return fmt.Errorf("couldn't deny (%w): Deny to try again", denyErr)
	}
	w.cancel()
	if w.pending == nil {
		return nil
	}
	// Taken by the service, the denial is the outcome. Otherwise the request
	// was over before it, and only the service knows how.
	if denyErr != nil {
		state, final, err := w.a.Outcome(ctx)
		switch {
		case err != nil:
			return fmt.Errorf("couldn't tell whether the browser was approved (%w): Deny to try again", err)
		case state == account.ApprovalApproved:
			w.pending = nil
			return errAlreadyOver
		case state == account.ApprovalExpired && !final:
			return errors.New("the request expired just after a report that may still be recorded: Deny again in a few minutes")
		case !final:
			return fmt.Errorf("the request is still %s: Deny to try again", state)
		}
	}
	// The ones that couldn't be removed stay pending for the next Deny.
	w.pending.grants = d.removeGrants(ctx, w.pending.grants)
	if len(w.pending.grants) > 0 {
		return fmt.Errorf("denied, but couldn't remove the access added on %s: Deny to try again", grantLabels(w.pending.grants))
	}
	w.pending = nil
	return nil
}

// webMachine is one machine the approval reaches: its saved entry and how to
// call it.
type webMachine struct {
	m     Machine
	label string
}

// webGrantTime is how long one machine's grant may take (SSH, info,
// statement, add); a machine is started only with that much time left before
// the report must go. webReportTime is kept for sending the report.
const (
	webGrantTime  = 30 * time.Second
	webReportTime = 30 * time.Second
)

// errNoTimeLeft is a machine not reached before the request's deadline.
var errNoTimeLeft = errors.New("not reached before this request expires")

// WebAccessApprove adds a grant for the browser on each chosen machine and
// sends it the sealed list. scope is "chat" or "terminal"; length one of
// webAccessTTLs. Machines that fail are reported, not fatal; with none
// granted the request stays open so the user can retry or deny. After a lost
// answer it sends the same report again, whatever was chosen.
func (d *Desk) WebAccessApprove(ctx context.Context, id string, machineIDs []string, scope, length string) (WebAccessResult, error) {
	res := WebAccessResult{Granted: []string{}, Skipped: []WebAccessSkipped{}, Failed: []WebAccessSkipped{}}
	w, err := d.currentApproval(id)
	if err != nil {
		return res, err
	}
	if !w.op.TryLock() {
		return res, errWebAccessBusy
	}
	defer w.op.Unlock()
	if w.pending != nil {
		return d.report(ctx, w, w.pending)
	}
	// No grant on any machine before the user typed the browser's code.
	if err := w.a.Ready(); err != nil {
		return res, err
	}
	if scope != "chat" && scope != "terminal" {
		return res, errWebAccessScope
	}
	ttl, ok := webAccessTTLs[length]
	if !ok {
		return res, fmt.Errorf("unknown length %q", length)
	}
	if len(machineIDs) == 0 {
		return res, errNoMachines
	}
	d.storeMu.Lock()
	st, err := d.load()
	d.storeMu.Unlock()
	if err != nil {
		return res, err
	}
	var chosen []webMachine
	for _, m := range st.Machines {
		if slices.Contains(machineIDs, machineID(m)) {
			chosen = append(chosen, webMachine{m: m, label: machineLabel(m)})
		}
	}
	if len(chosen) == 0 {
		return res, errNoMachines
	}
	// The sealed list must fit what the service takes, at its largest (every
	// machine granted), before any machine changes.
	if n := webEnvelopeFits(chosen); n < len(chosen) {
		return res, fmt.Errorf("%d machines don't fit in one approval: choose at most %d", len(chosen), n)
	}
	// The request must still be open, with time to grant and report, before
	// any machine changes: a grant the service then can't record would be
	// access nobody approved. Machines are granted until the report must go.
	left, err := w.a.Live(ctx, webGrantTime+webReportTime)
	if err != nil {
		return res, err
	}
	reportBy := time.Now().Add(left - webReportTime)
	seq, err := d.nextWebSeq(w.approver)
	if err != nil {
		return res, err
	}
	req := w.a.Request()
	envelope := webEnvelope{V: 1, Seq: seq, IssuedUnix: webNow().Unix(), Approver: accountDeviceName(), Machines: []webEnvelopeMachine{}, Skipped: []webEnvelopeSkipped{}}
	expires := webNow().Add(ttl)
	ownerScope := herdrapi.OwnerScope(scope)
	var grants []webGrant
	for _, c := range chosen {
		if time.Until(reportBy) < webGrantTime {
			res.Failed = append(res.Failed, WebAccessSkipped{Label: c.label, Reason: errNoTimeLeft.Error()})
			continue
		}
		g, skip, err := d.grantOn(ctx, w.acct, c, herdrapi.OwnerAccessAddParams{
			DevicePub: req.Browser.DevicePub, DeviceName: truncate(req.Browser.Name, 64),
			Scope: &ownerScope, TtlSecs: uint64(ttl / time.Second),
			ApprovedBy: truncate(accountDeviceName(), 64),
		})
		switch {
		case err != nil:
			res.Failed = append(res.Failed, WebAccessSkipped{Label: c.label, Reason: err.Error()})
		case skip != "":
			res.Skipped = append(res.Skipped, WebAccessSkipped{Label: c.label, Reason: skip})
			envelope.Skipped = append(envelope.Skipped, webEnvelopeSkipped{HostItemID: c.m.SyncID, Label: c.label, Reason: skip})
		default:
			res.Granted = append(res.Granted, c.label)
			g.HostItemID = c.m.SyncID
			envelope.Machines = append(envelope.Machines, g)
			grants = append(grants, webGrant{m: c, grantID: g.GrantID})
		}
	}
	if len(envelope.Machines) == 0 {
		return res, nil
	}
	plain, err := json.Marshal(envelope)
	if err != nil {
		return res, err
	}
	return d.report(ctx, w, &webPending{scope: scope, expiresMs: expires.UnixMilli(), seq: seq, envelope: plain, grants: grants, res: res})
}

// report sends the approval with its grants. Recorded: done. Definitely not
// recorded: the grants are removed and the reason returned. Unknown: the
// grants stay, p is kept for the next Approve or Deny, and the result says
// Unsure (a result, not an error, so the page gets it).
func (d *Desk) report(ctx context.Context, w *webApproval, p *webPending) (WebAccessResult, error) {
	res := p.res
	err := w.a.Approve(ctx, p.scope, p.expiresMs, p.seq, p.envelope)
	var refused *account.NotApprovedError
	switch {
	case err == nil:
		w.pending = nil
		w.cancel()
		return res, nil
	case errors.As(err, &refused):
		w.pending = nil
		if failed := d.removeGrants(context.WithoutCancel(ctx), p.grants); len(failed) > 0 {
			return res, fmt.Errorf("the browser wasn't approved (%v), and the access added on %s couldn't be removed", err, grantLabels(failed))
		}
		return res, fmt.Errorf("the browser wasn't approved: %w", err)
	}
	w.pending = p
	res.Unsure, res.Problem = true, err.Error()
	return res, nil
}

// removeGrants removes grants made for an approval that wasn't recorded,
// and returns the ones it couldn't remove.
func (d *Desk) removeGrants(ctx context.Context, grants []webGrant) []webGrant {
	var failed []webGrant
	for _, g := range grants {
		if err := d.removeGrant(ctx, g); err != nil {
			failed = append(failed, g)
		}
	}
	return failed
}

func grantLabels(grants []webGrant) string {
	labels := make([]string, len(grants))
	for i, g := range grants {
		labels[i] = g.m.label
	}
	return strings.Join(labels, ", ")
}

func (d *Desk) removeGrant(ctx context.Context, g webGrant) error {
	client, done, err := d.ownerClient(ctx, g.m.m)
	if err != nil {
		return err
	}
	defer done()
	cctx, cancel := context.WithTimeout(ctx, webGrantTime)
	defer cancel()
	_, err = client.OwnerAccessRemove(cctx, herdrapi.OwnerAccessRemoveParams{GrantID: &g.grantID})
	return err
}

// grantOn adds the grant on one machine: owner_access.info for its relay id,
// a statement for that host, then owner_access.add. A machine that can't take
// owner grants is skipped with the envelope's reason.
func (d *Desk) grantOn(ctx context.Context, acct string, c webMachine, p herdrapi.OwnerAccessAddParams) (webEnvelopeMachine, string, error) {
	// One deadline for the SSH dial and every call, so a machine never takes
	// more than webGrantTime of the time kept before the report.
	cctx, cancel := context.WithTimeout(ctx, webGrantTime)
	defer cancel()
	client, done, err := d.ownerClient(cctx, c.m)
	if err != nil {
		return webEnvelopeMachine{}, "unreachable", nil
	}
	defer done()
	info, err := client.OwnerAccessInfo(cctx)
	var api *bridge.APIError
	var old *engine.ErrUnsupported
	switch {
	case errors.As(err, &old):
		return webEnvelopeMachine{}, "needs_update", nil
	case errors.As(err, &api) && api.Code == "owner_access_unsupported":
		return webEnvelopeMachine{}, "unsupported", nil
	case err != nil:
		return webEnvelopeMachine{}, "", err
	}
	if !webrelay.Allowed(info.RelayURL) {
		return webEnvelopeMachine{}, "relay_not_allowed", nil
	}
	statements, err := d.account.Statements(cctx, acct, []string{info.HostID})
	if err != nil {
		return webEnvelopeMachine{}, "", err
	}
	i := slices.IndexFunc(statements, func(s account.Statement) bool { return s.Host == info.HostID })
	if i < 0 {
		return webEnvelopeMachine{}, "", errors.New("the account service gave no statement for this machine")
	}
	p.AccountStatement = statements[i].JWS
	added, err := client.OwnerAccessAdd(cctx, p)
	if err != nil {
		return webEnvelopeMachine{}, "", err
	}
	return webEnvelopeMachine{
		Label: c.label, Relay: strings.TrimRight(info.RelayURL, "/"), HostID: info.HostID, NodePub: info.NodePub,
		GrantID: added.Grant.GrantID, Scope: string(added.Grant.Scope), ExpiresUnix: int64(added.Grant.ExpiresMs / 1000),
	}, "", nil
}

// ownerClient is a herdr client on machine m: the live connection when m is
// the machine this computer is connected to, otherwise a short SSH session
// with its key file. done closes what was opened.
func (d *Desk) ownerClient(ctx context.Context, m Machine) (*engine.Client, func(), error) {
	id := machineID(m)
	d.mu.Lock()
	if d.link != nil && d.link.id == id && d.link.client != nil {
		c := d.link.client
		d.mu.Unlock()
		return engine.New(engine.Bridge(c)), func() {}, nil
	}
	d.mu.Unlock()
	if m.KeyPath == "" {
		return nil, nil, errors.New("needs a key file")
	}
	cfg := bridge.Config{Host: m.Host, Port: m.Port, User: m.User, Session: m.Session, Pins: d.pins}
	if m.Paired {
		cfg.HostKeyAlgorithms = pairingHostKeyAlgorithms
	}
	var err error
	if cfg.KeyPEM, err = os.ReadFile(m.KeyPath); err != nil {
		return nil, nil, err
	}
	dctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	c, err := bridge.Dial(dctx, cfg)
	if err != nil {
		return nil, nil, err
	}
	return engine.New(engine.Bridge(c)), func() { c.Close() }, nil
}

// webEnvelope is the machine list sealed to the browser (WIRE-PLAN §2.3).
type webEnvelope struct {
	V          int                  `json:"v"`
	Seq        uint64               `json:"seq"`
	IssuedUnix int64                `json:"issued_unix"`
	Approver   string               `json:"approver"`
	Machines   []webEnvelopeMachine `json:"machines"`
	Skipped    []webEnvelopeSkipped `json:"skipped"`
}

type webEnvelopeMachine struct {
	HostItemID  string `json:"host_item_id"`
	Label       string `json:"label"`
	Relay       string `json:"relay"`
	HostID      string `json:"host_id"`
	NodePub     string `json:"node_pub"`
	GrantID     string `json:"grant_id"`
	Scope       string `json:"scope"`
	ExpiresUnix int64  `json:"expires_unix"`
}

type webEnvelopeSkipped struct {
	HostItemID string `json:"host_item_id"`
	Label      string `json:"label"`
	Reason     string `json:"reason"`
	Version    string `json:"version,omitempty"`
}

// webEnvelopeFits returns how many of chosen, in order, fit one sealed list
// the service takes, each counted as granted with every field at its
// longest: herdr's host_id and grant_id are b64url of 16 bytes and node_pub
// of an X25519 key, the relay is one of webrelay.Origins, and seq and times
// take their most digits. A skipped machine adds less.
func webEnvelopeFits(chosen []webMachine) int {
	relay := slices.MaxFunc(webrelay.Origins, func(a, b string) int { return len(a) - len(b) })
	e := webEnvelope{V: 1, Seq: math.MaxUint64, IssuedUnix: math.MaxInt64, Approver: accountDeviceName(), Machines: []webEnvelopeMachine{}, Skipped: []webEnvelopeSkipped{}}
	for i, c := range chosen {
		e.Machines = append(e.Machines, webEnvelopeMachine{
			HostItemID: c.m.SyncID, Label: c.label, Relay: relay,
			HostID: strings.Repeat("h", 22), NodePub: strings.Repeat("n", 43), GrantID: strings.Repeat("g", 22),
			Scope: "terminal", ExpiresUnix: math.MaxInt64,
		})
		plain, err := json.Marshal(e)
		if err != nil || account.SealedLength(len(plain)) > account.MaxSealedLength {
			return i
		}
	}
	return len(chosen)
}

func truncate(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > n {
		r = r[:n]
	}
	return string(r)
}
