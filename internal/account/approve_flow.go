package account

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// ErrApprovalEnded is a request the browser or the service ended (denied,
// expired, or answered elsewhere) before this device finished it.
var ErrApprovalEnded = errors.New("this request is no longer waiting")

// ErrCodeNotChecked is an approval attempted before the user typed the
// browser's code correctly: the approver approves only on a match (§2.2 step 5).
var ErrCodeNotChecked = errors.New("enter the code shown in the browser first")

// ErrCodeNotShown is a code typed before the browser revealed its nonce.
var ErrCodeNotShown = errors.New("the browser hasn't shown its code yet")

// ErrApprovalEnding is a request with too little time left to add grants on
// the machines and report them before it expires.
var ErrApprovalEnding = errors.New("this request is about to expire: ask the browser for a new one")

// NotApprovedError is an approval the account service didn't record: it
// refused it, the request ended, or it was never sent. The browser never sees
// grants made for it, so the caller removes them.
type NotApprovedError struct{ Err error }

func (e *NotApprovedError) Error() string { return e.Err.Error() }
func (e *NotApprovedError) Unwrap() error { return e.Err }

// maxCodeTries is how many wrong codes the approver accepts before it denies
// the request, so a request can't be approved by guessing.
const maxCodeTries = 3

// approvalPoll is how long to wait between reads of a request: every 2 s for
// the first minute, then every 5 s (WIRE-PLAN §2.4). Tests replace it.
var approvalPoll = func(elapsed time.Duration) time.Duration {
	if elapsed < time.Minute {
		return 2 * time.Second
	}
	return 5 * time.Second
}

// approvalBackoffMax caps the wait between reads after failed ones.
const approvalBackoffMax = 30 * time.Second

// Approval is one browser approval as the approving device runs it: claim with
// a fresh nonce_t, wait for the browser to reveal nonce_b, check it against
// the commit seen before claiming, and approve only once the user has typed the
// browser's code.
type Approval struct {
	c       *Client
	acct    string
	key     DeviceKey
	request ApprovalRequest

	browserPub, commit, nonceT []byte

	mu      sync.Mutex
	code    string
	tries   int
	matched bool
	// locked: this device won't approve the request any more (a denial was
	// asked for, or too many wrong codes), whether or not the service has
	// taken the denial yet.
	locked bool
	// done: the service has the request's outcome, or the request is over.
	done bool
	// denied: the service took this device's denial. A finish can't be
	// recorded after it (both need a request with no outcome), so no
	// approval of this request ever will be.
	denied bool
	// unsure: a finish this device sent has an unknown outcome. An expiry
	// the service only computed may still be followed by that finish being
	// recorded; a stored one (outcome_stored) stops it.
	unsure bool
}

// StartApproval claims req for this device (key is its enrolled device key).
// The browser key and commit are the ones in req, read before nonce_t exists.
func (c *Client) StartApproval(ctx context.Context, acct string, key DeviceKey, req ApprovalRequest) (*Approval, error) {
	browserPub, err := base64.RawURLEncoding.DecodeString(req.Browser.DevicePub)
	if err != nil || len(browserPub) != approveKeySize {
		return nil, ErrApproveTampered
	}
	commit, err := base64.RawURLEncoding.DecodeString(req.Commit)
	if err != nil || len(commit) != sha256.Size {
		return nil, ErrApproveTampered
	}
	nonceT, err := NewApproveNonce()
	if err != nil {
		return nil, err
	}
	if err := c.ClaimApproval(ctx, acct, req.ID, nonceT); err != nil {
		return nil, err
	}
	return &Approval{c: c, acct: acct, key: key, request: req, browserPub: browserPub, commit: commit, nonceT: nonceT}, nil
}

// Request is the browser request this approval answers.
func (a *Approval) Request() ApprovalRequest { return a.request }

// requestGone reports an answer that says the request no longer exists or is
// over for this device.
func requestGone(err error) bool {
	var api *APIError
	return errors.As(err, &api) && (api.Status == http.StatusNotFound || api.Status == http.StatusGone)
}

// transient reports a failed read worth repeating: no answer, a rate limit,
// or a server error. The claim stays valid meanwhile.
func transient(err error) bool {
	var api *APIError
	if !errors.As(err, &api) {
		return true
	}
	return api.Status == http.StatusTooManyRequests || api.Status >= 500
}

// AwaitReveal waits for the browser's nonce_b and checks it. A nonce that
// doesn't open the commit denies the request and returns ErrApproveTampered.
// A busy or unreachable service is read again, more slowly, until ctx ends.
func (a *Approval) AwaitReveal(ctx context.Context) error {
	start := a.c.now()
	failures := 0
	for {
		wait := approvalPoll(a.c.now().Sub(start))
		st, err := a.c.ApprovalState(ctx, a.acct, a.request.ID)
		switch {
		case err != nil && ctx.Err() != nil:
			return ctx.Err()
		case requestGone(err):
			a.end()
			return ErrApprovalEnded
		case err != nil && !transient(err):
			return err
		case err != nil:
			failures = min(failures+1, 5)
			wait = min(wait<<failures, approvalBackoffMax)
		case st.State == ApprovalRevealed:
			return a.revealed(ctx, st.NonceB)
		case st.State == ApprovalWaiting || st.State == ApprovalClaimed:
			failures = 0
		default:
			a.end()
			return ErrApprovalEnded
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (a *Approval) revealed(ctx context.Context, nonceB64 string) error {
	nonceB, err := base64.RawURLEncoding.DecodeString(nonceB64)
	if err == nil {
		err = ApproveOpen(a.browserPub, a.commit, nonceB)
	}
	if err != nil {
		_ = a.Deny(ctx)
		return ErrApproveTampered
	}
	code, err := ApproveCode(a.browserPub, a.key.PublicKey(), nonceB, a.nonceT)
	if err != nil {
		return err
	}
	a.mu.Lock()
	a.code = code
	a.mu.Unlock()
	return nil
}

func (a *Approval) end() {
	a.mu.Lock()
	a.locked, a.done = true, true
	a.mu.Unlock()
}

// CodeCheck is one typed code's outcome. Left is how many more codes may be
// typed; with none left the request can't be approved here any more, Denied
// says the service took the denial, and DenyErr why it didn't.
type CodeCheck struct {
	Ok      bool
	Left    int
	Denied  bool
	DenyErr error
}

// CheckCode compares the code the user typed with this device's. The last
// wrong code locks the approval and denies the request.
func (a *Approval) CheckCode(ctx context.Context, typed string) (CodeCheck, error) {
	a.mu.Lock()
	switch {
	case a.locked || a.done:
		a.mu.Unlock()
		return CodeCheck{}, ErrApprovalEnded
	case a.code == "":
		a.mu.Unlock()
		return CodeCheck{Left: maxCodeTries - a.tries}, ErrCodeNotShown
	case ApproveCodeMatches(typed, a.code):
		a.matched = true
		left := maxCodeTries - a.tries
		a.mu.Unlock()
		return CodeCheck{Ok: true, Left: left}, nil
	}
	a.tries++
	left := maxCodeTries - a.tries
	a.locked = left == 0
	a.mu.Unlock()
	if left > 0 {
		return CodeCheck{Left: left}, nil
	}
	err := a.Deny(ctx)
	if errors.Is(err, ErrApprovalEnded) {
		err = nil
	}
	return CodeCheck{Denied: err == nil, DenyErr: err}, nil
}

// Ready says whether grants may be made for this request now: the user typed
// the browser's code and nothing ended or locked the approval.
func (a *Approval) Ready() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	switch {
	case a.locked || a.done:
		return ErrApprovalEnded
	case !a.matched:
		return ErrCodeNotChecked
	}
	return nil
}

// Live checks with the service, just before grants are made, that the
// request is still revealed to this device with at least min left, so no
// machine gets a grant the service would then refuse to record. It returns
// the request's deadline, counted from before the read (the service rounds
// the time left up to a second, so one second less).
func (a *Approval) Live(ctx context.Context, min time.Duration) (time.Time, error) {
	if err := a.Ready(); err != nil {
		return time.Time{}, err
	}
	start := time.Now()
	st, err := a.c.ApprovalState(ctx, a.acct, a.request.ID)
	switch {
	case requestGone(err):
		a.end()
		return time.Time{}, ErrApprovalEnded
	case err != nil:
		return time.Time{}, err
	case st.State != ApprovalRevealed:
		a.end()
		return time.Time{}, ErrApprovalEnded
	}
	deadline := start.Add(time.Duration(st.ExpiresIn-1) * time.Second)
	if time.Until(deadline) < min {
		return deadline, ErrApprovalEnding
	}
	return deadline, nil
}

// Approve finishes the request with the grants made on the machines and the
// machine list (envelope JSON) sealed to the browser at seq. It returns nil
// once the service has the approval (also when only its reply was lost), a
// *NotApprovedError when the service definitely doesn't have it, and any
// other error when that can't be told. Sent again after an unknown outcome,
// it reports what the service has.
func (a *Approval) Approve(ctx context.Context, scope string, expiresMs int64, seq uint64, envelope []byte) error {
	if err := a.Ready(); err != nil {
		// Locked or over since an earlier report: only the service knows
		// whether that report was recorded.
		return a.settle(ctx, err)
	}
	sealed, err := SealEnvelope(a.key, a.browserPub, seq, envelope)
	if err != nil {
		return &NotApprovedError{err}
	}
	if err := a.c.ApproveBrowser(ctx, a.acct, a.request.ID, ApprovalGrant{Scope: scope, ExpiresMs: expiresMs, Seq: seq, Sealed: sealed}); err != nil {
		// The service answering with a refusal (a 4xx other than 429: the
		// finish is one transaction, herdrup #792) didn't record this
		// finish; anything else may yet be recorded.
		var api *APIError
		refused := errors.As(err, &api) && api.Status >= 400 && api.Status < 500 && api.Status != http.StatusTooManyRequests
		a.mu.Lock()
		earlier := a.unsure
		a.unsure = a.unsure || !refused
		a.mu.Unlock()
		if refused && !earlier {
			// The only finish this device sent was refused, and only the
			// claimant finishes: whatever the request is now, it holds no
			// approval from here.
			return &NotApprovedError{err}
		}
		return a.settle(ctx, err)
	}
	a.end()
	return nil
}

// settle decides what the finishes this device sent did, from the
// request's state: approved means one went through (only the claimant
// finishes); denied means none can be; expired means none can be only when
// none had an unknown outcome. Still revealed proves nothing, since a sent
// finish may yet be applied; anything else stays unknown.
func (a *Approval) settle(ctx context.Context, finishErr error) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	state, final, err := a.Outcome(ctx)
	switch {
	case err != nil || !final:
	case state == ApprovalApproved:
		a.end()
		return nil
	default:
		a.end()
		return &NotApprovedError{finishErr}
	}
	return fmt.Errorf("couldn't tell whether the browser was approved: %w", finishErr)
}

// Outcome reads the request's state as the service has it now. final says
// it is the request's outcome for this device: approved, denied, or expired
// when no finish of this device has an unknown outcome or this very read
// says the expiry is stored (outcome_stored: a Worker version that doesn't
// store it never says so, whatever /v1/health lists). A request the service
// no longer knows is an error (its outcome can't be told).
func (a *Approval) Outcome(ctx context.Context) (string, bool, error) {
	st, err := a.c.ApprovalState(ctx, a.acct, a.request.ID)
	if err != nil {
		return "", false, err
	}
	switch st.State {
	case ApprovalApproved, ApprovalDenied:
		return st.State, true, nil
	case ApprovalExpired:
		a.mu.Lock()
		defer a.mu.Unlock()
		return st.State, !a.unsure || st.OutcomeStored, nil
	}
	return st.State, false, nil
}

// Deny finishes the request as denied. It locks the approval at once, and
// reports success only when the service took this device's denial (now or
// on an earlier Deny); ErrApprovalEnded when the request was already over
// some other way (nothing is sent then).
func (a *Approval) Deny(ctx context.Context) error {
	a.mu.Lock()
	a.locked = true
	done, denied := a.done, a.denied
	a.mu.Unlock()
	switch {
	case denied:
		return nil
	case done:
		return ErrApprovalEnded
	}
	err := a.c.DenyBrowser(ctx, a.acct, a.request.ID)
	var api *APIError
	if requestGone(err) || errors.As(err, &api) && api.Status == http.StatusConflict {
		err = ErrApprovalEnded
	}
	if err == nil {
		a.mu.Lock()
		a.denied = true
		a.mu.Unlock()
	}
	if err == nil || errors.Is(err, ErrApprovalEnded) {
		a.end()
	}
	return err
}
