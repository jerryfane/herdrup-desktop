package main

// Web owner access, the approving device's side (WIRE-PLAN §2, D1): a browser
// signed in to the account asks to reach the owner's machines; this computer
// shows the request, the user types the browser's 4-digit code, picks
// machines, access and time, and this computer adds a grant on each machine
// over SSH (owner_access.add, herdr #491) and seals the machine list to the
// browser. The account service carries the request and the sealed list; it
// can't grant anything itself.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/account"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// webNow is the clock for grant expiry; tests replace it.
var webNow = time.Now

// webRelays are the relays the web app's CSP lets a browser reach
// (GuestRelay/public/_headers connect-src). A machine on another relay is
// skipped as relay_not_allowed.
var webRelays = []string{"https://guest.herdrup.app", "https://guest.herdrup.themartian.app"}

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

// WebAccessCode is the state of an approval after the browser revealed.
type WebAccessCode struct {
	// Ready: the code can be typed. False while the browser hasn't revealed.
	Ready bool `json:"ready"`
}

// WebAccessResult is what an approval did on each machine.
type WebAccessResult struct {
	Granted []string           `json:"granted"`
	Skipped []WebAccessSkipped `json:"skipped"`
	Failed  []WebAccessSkipped `json:"failed"`
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
	mu     sync.Mutex
	acct   string
	a      *account.Approval
	cancel context.CancelFunc
}

var (
	errNoApproval     = errors.New("that request is no longer open here")
	errNoMachines     = errors.New("choose at least one machine")
	errWebAccessScope = errors.New("choose chat or chat and terminal")
)

// WebAccessOffered reports whether the account service carries browser
// approvals: the page polls for requests and offers approval only then.
func (d *Desk) WebAccessOffered(ctx context.Context) bool {
	cur, _ := d.account.Current()
	if cur == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	offered, _ := d.account.WebApproveOffered(ctx)
	return offered
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
// background) for the browser to show its code. One approval at a time: a
// new one replaces the last.
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
	// The browser reveals within the request's 10 minutes, or never.
	wctx, stop := context.WithTimeout(context.Background(), 10*time.Minute)
	w := &webApproval{acct: cur.AccountID, a: a, cancel: stop}
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

// WebAccessCheck is a typed code's outcome: Ok, or not; Denied after three
// wrong codes (the request is closed).
type WebAccessCheck struct {
	Ok     bool `json:"ok"`
	Denied bool `json:"denied"`
}

// WebAccessCheckCode compares the code the user typed.
func (d *Desk) WebAccessCheckCode(ctx context.Context, id, typed string) (WebAccessCheck, error) {
	w, err := d.currentApproval(id)
	if err != nil {
		return WebAccessCheck{}, err
	}
	ok, denied := w.a.CheckCode(ctx, strings.TrimSpace(typed))
	return WebAccessCheck{Ok: ok, Denied: denied}, nil
}

// WebAccessDeny denies request id.
func (d *Desk) WebAccessDeny(ctx context.Context, id string) error {
	w, err := d.currentApproval(id)
	if err != nil {
		return err
	}
	w.cancel()
	return w.a.Deny(ctx)
}

// webMachine is one machine the approval reaches: its saved entry and how to
// call it.
type webMachine struct {
	m     Machine
	label string
}

// WebAccessApprove adds a grant for the browser on each chosen machine and
// sends it the sealed list. scope is "chat" or "terminal"; length one of
// webAccessTTLs. Machines that fail are reported, not fatal; with none
// granted the request stays open so the user can retry or deny.
func (d *Desk) WebAccessApprove(ctx context.Context, id string, machineIDs []string, scope, length string) (WebAccessResult, error) {
	res := WebAccessResult{Granted: []string{}, Skipped: []WebAccessSkipped{}, Failed: []WebAccessSkipped{}}
	w, err := d.currentApproval(id)
	if err != nil {
		return res, err
	}
	// No grant on any machine before the user typed the browser's code.
	if !w.a.Matched() {
		return res, account.ErrCodeNotChecked
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
	req := w.a.Request()
	envelope := webEnvelope{V: 1, Seq: 1, IssuedUnix: webNow().Unix(), Approver: accountDeviceName(), Machines: []webEnvelopeMachine{}, Skipped: []webEnvelopeSkipped{}}
	expires := webNow().Add(ttl)
	ownerScope := herdrapi.OwnerScope(scope)
	for _, c := range chosen {
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
		}
	}
	if len(envelope.Machines) == 0 {
		return res, nil
	}
	plain, err := json.Marshal(envelope)
	if err != nil {
		return res, err
	}
	if err := w.a.Approve(ctx, scope, expires.UnixMilli(), envelope.Seq, plain); err != nil {
		return res, err
	}
	w.cancel()
	return res, nil
}

// grantOn adds the grant on one machine: owner_access.info for its relay id,
// a statement for that host, then owner_access.add. A machine that can't take
// owner grants is skipped with the envelope's reason.
func (d *Desk) grantOn(ctx context.Context, acct string, c webMachine, p herdrapi.OwnerAccessAddParams) (webEnvelopeMachine, string, error) {
	client, done, err := d.ownerClient(ctx, c.m)
	if err != nil {
		return webEnvelopeMachine{}, "unreachable", nil
	}
	defer done()
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	info, err := client.OwnerAccessInfo(cctx)
	var api *bridge.APIError
	switch {
	case errors.As(err, &api) && api.Code == "owner_access_unsupported":
		return webEnvelopeMachine{}, "unsupported", nil
	case errors.As(err, &api) && (api.Code == "unknown_method" || api.Code == "method_not_found"):
		return webEnvelopeMachine{}, "needs_update", nil
	case err != nil:
		return webEnvelopeMachine{}, "", err
	}
	if !slices.Contains(webRelays, strings.TrimRight(info.RelayURL, "/")) {
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

func truncate(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > n {
		r = r[:n]
	}
	return string(r)
}
