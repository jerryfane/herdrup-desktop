package account

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"sync"
	"time"
)

// ErrApprovalEnded is a request the browser or the service ended (denied,
// expired, or answered elsewhere) before this device finished it.
var ErrApprovalEnded = errors.New("this request is no longer waiting")

// ErrCodeNotChecked is an approval attempted before the user typed the
// browser's code correctly: the approver approves only on a match (§2.2 step 5).
var ErrCodeNotChecked = errors.New("enter the code shown in the browser first")

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
	done    bool
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

// AwaitReveal waits for the browser's nonce_b and checks it. A nonce that
// doesn't open the commit denies the request and returns ErrApproveTampered.
func (a *Approval) AwaitReveal(ctx context.Context) error {
	start := a.c.now()
	for {
		st, err := a.c.ApprovalState(ctx, a.acct, a.request.ID)
		if err != nil {
			return err
		}
		switch st.State {
		case ApprovalRevealed:
			nonceB, err := base64.RawURLEncoding.DecodeString(st.NonceB)
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
		case ApprovalWaiting, ApprovalClaimed:
		default:
			return ErrApprovalEnded
		}
		timer := time.NewTimer(approvalPoll(a.c.now().Sub(start)))
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

// CheckCode compares the code the user typed with this device's. After
// maxCodeTries wrong codes the request is denied; denied reports that.
func (a *Approval) CheckCode(ctx context.Context, typed string) (ok, denied bool) {
	a.mu.Lock()
	if a.code == "" || a.done {
		a.mu.Unlock()
		return false, a.done
	}
	if ApproveCodeMatches(typed, a.code) {
		a.matched = true
		a.mu.Unlock()
		return true, false
	}
	a.tries++
	deny := a.tries >= maxCodeTries
	a.mu.Unlock()
	if deny {
		_ = a.Deny(ctx)
	}
	return false, deny
}

// Matched reports whether the user typed the browser's code correctly and the
// request is still open: grants may be made on the machines only then.
func (a *Approval) Matched() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.matched && !a.done
}

// Approve finishes the request with the grants made on the machines and the
// machine list (envelope JSON) sealed to the browser at seq.
func (a *Approval) Approve(ctx context.Context, scope string, expiresMs int64, seq uint64, envelope []byte) error {
	a.mu.Lock()
	ready, done := a.matched, a.done
	a.mu.Unlock()
	if done {
		return ErrApprovalEnded
	}
	if !ready {
		return ErrCodeNotChecked
	}
	sealed, err := SealEnvelope(a.key, a.browserPub, seq, envelope)
	if err != nil {
		return err
	}
	if err := a.c.ApproveBrowser(ctx, a.acct, a.request.ID, ApprovalGrant{Scope: scope, ExpiresMs: expiresMs, Seq: seq, Sealed: sealed}); err != nil {
		return err
	}
	a.mu.Lock()
	a.done = true
	a.mu.Unlock()
	return nil
}

// Deny finishes the request as denied.
func (a *Approval) Deny(ctx context.Context) error {
	a.mu.Lock()
	if a.done {
		a.mu.Unlock()
		return nil
	}
	a.done = true
	a.mu.Unlock()
	return a.c.DenyBrowser(ctx, a.acct, a.request.ID)
}
