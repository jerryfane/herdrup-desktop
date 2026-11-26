package account

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"slices"
	"sync"
)

// ErrPairNotApproved is a retry's envelope for a request this device hasn't
// approved (PairApproval.Resend before Approve succeeded).
var ErrPairNotApproved = errors.New("this device hasn't approved that request")

// ErrPairSeq is an envelope seq of 0, or a retry's not above the last one
// the service took from this device.
var ErrPairSeq = errors.New("pair-v1: envelope seq must grow")

// PairAsk is this device's pair request, as the new device runs it: it
// commits to nonce_b for its device key B and the request's SSH key S,
// reveals once an approver has claimed the request, shows the code, then
// opens the machine lists that approver seals to it.
type PairAsk struct {
	c      *Client
	acct   string
	key    DeviceKey
	sshPub []byte
	nonceB []byte
	id     string
	expIn  int64

	mu sync.Mutex
	// approverPub and nonceT are the claim the code is computed over, kept
	// from the first read that showed them: only that approver's envelopes
	// are opened, and a later read showing another is tampering.
	approverPub, nonceT []byte
	code                string
	// revealed: the service has this device's nonce_b.
	revealed bool
	// abandoned: Abandon was called.
	abandoned bool
	// delivered is the newest machine list opened, so a service can't
	// hand back an older one.
	delivered *PairDelivery
}

// AskToPair posts a pair request for this device (key is its enrolled
// device key, B) and the SSH key sshPub (S, 32 bytes) it made for this
// request (pairing.NewPairKey). It replaces this device's live request.
func (c *Client) AskToPair(ctx context.Context, acct string, key DeviceKey, sshPub []byte) (*PairAsk, error) {
	nonceB, err := NewApproveNonce()
	if err != nil {
		return nil, err
	}
	commit, err := PairCommit(key.PublicKey(), sshPub, nonceB)
	if err != nil {
		return nil, err
	}
	created, err := c.RequestPair(ctx, acct, commit, sshPub)
	if err != nil {
		return nil, err
	}
	return &PairAsk{c: c, acct: acct, key: key, sshPub: slices.Clone(sshPub), nonceB: nonceB, id: created.ID, expIn: created.ExpiresIn}, nil
}

// ID is the request's id.
func (p *PairAsk) ID() string { return p.id }

// ExpiresIn is the seconds the request had when it was made.
func (p *PairAsk) ExpiresIn() int64 { return p.expIn }

// PairProgress is one read of a pair request, as the new device shows it.
type PairProgress struct {
	// State is an approve-v1 state (ApprovalWaiting … ApprovalExpired).
	State string
	// ExpiresIn is the seconds the request has left.
	ExpiresIn int64
	// Approver is the claiming device's name, once there is one.
	Approver string
	// Code is the 4 digits to show, once this device revealed.
	Code string
	// Final: the service stored the outcome (outcome_stored), so a reported
	// expiry is final.
	Final bool
}

// Poll reads the request once and moves it on: once it is claimed, it
// reveals nonce_b and has the code. A request the service no longer has
// (replaced, removed) is ErrApprovalEnded; an approver key or nonce_t that
// changes after the code was computed is ErrApproveTampered.
func (p *PairAsk) Poll(ctx context.Context) (PairProgress, error) {
	p.mu.Lock()
	abandoned := p.abandoned
	p.mu.Unlock()
	if abandoned {
		return PairProgress{State: ApprovalDenied}, ErrApprovalEnded
	}
	st, err := p.c.ApprovalState(ctx, p.acct, p.id)
	if requestGone(err) {
		return PairProgress{State: ApprovalExpired}, ErrApprovalEnded
	}
	if err != nil {
		return PairProgress{}, err
	}
	prog := PairProgress{State: st.State, ExpiresIn: st.ExpiresIn, Final: st.OutcomeStored}
	if st.Approver != nil {
		prog.Approver = st.Approver.Name
	}
	if st.State == ApprovalClaimed || st.State == ApprovalRevealed {
		if err := p.reveal(ctx, st); err != nil {
			return prog, err
		}
	}
	p.mu.Lock()
	if p.revealed {
		prog.Code = p.code
	}
	p.mu.Unlock()
	return prog, nil
}

// reveal computes the code over the claim st shows and sends nonce_b.
func (p *PairAsk) reveal(ctx context.Context, st ApprovalStatus) error {
	if st.Approver == nil {
		return ErrApproveTampered
	}
	approverPub, err1 := base64.RawURLEncoding.Strict().DecodeString(st.Approver.DevicePub)
	nonceT, err2 := base64.RawURLEncoding.Strict().DecodeString(st.NonceT)
	if err1 != nil || err2 != nil || len(approverPub) != approveKeySize || len(nonceT) != approveNonceSize {
		return ErrApproveTampered
	}
	p.mu.Lock()
	switch {
	case p.approverPub == nil && st.State == ApprovalRevealed:
		// Only this device reveals, and it keeps the claim before it does.
		p.mu.Unlock()
		return ErrApproveTampered
	case p.approverPub == nil:
		code, err := PairCode(p.key.PublicKey(), p.sshPub, approverPub, p.nonceB, nonceT)
		if err != nil {
			p.mu.Unlock()
			return err
		}
		p.approverPub, p.nonceT, p.code = approverPub, nonceT, code
	case !bytes.Equal(p.approverPub, approverPub) || !bytes.Equal(p.nonceT, nonceT):
		p.mu.Unlock()
		return ErrApproveTampered
	}
	if st.State == ApprovalRevealed {
		p.revealed = true
	}
	done := p.revealed
	p.mu.Unlock()
	if done {
		return nil
	}
	err := p.c.RevealPair(ctx, p.acct, p.id, p.nonceB)
	var api *APIError
	if errors.As(err, &api) && api.Status == http.StatusConflict && api.Code == "already_revealed" {
		// An earlier reveal of this device went through; its answer was lost.
		err = nil
	}
	if err != nil {
		return err
	}
	p.mu.Lock()
	p.revealed = true
	p.mu.Unlock()
	return nil
}

// Abandon stops this request here: it reveals nothing more and opens no
// machine list. The service has no cancel, so the request itself ends at
// its expiry or with this device's next request. Before the reveal no
// approver can approve it (a finish needs the reveal); after it, an
// approver that already has the code still can, and may add the key.
func (p *PairAsk) Abandon() {
	p.mu.Lock()
	p.abandoned = true
	p.mu.Unlock()
}

// PairDelivery is the newest machine list the approver sealed to this
// device.
type PairDelivery struct {
	Seq      uint64
	Envelope PairEnvelope
}

// Machines reads GET /v1/pairs/self and opens this request's machine list
// from the approver the code was computed with. ok is false while there is
// none (or after Abandon). An envelope for this request that names another
// SSH key, or doesn't open, is ErrApproveTampered; one older than a list
// already opened is passed over for that list.
func (p *PairAsk) Machines(ctx context.Context) (PairDelivery, bool, error) {
	p.mu.Lock()
	approverPub, revealed, abandoned := p.approverPub, p.revealed, p.abandoned
	p.mu.Unlock()
	if !revealed || abandoned {
		return PairDelivery{}, false, nil
	}
	self, err := p.c.ReadPairSelf(ctx, p.acct)
	if err != nil {
		return PairDelivery{}, false, err
	}
	var newest *PairDelivery
	for _, e := range self.Envelopes {
		if e.RequestID != p.id {
			continue
		}
		pub, err1 := base64.RawURLEncoding.DecodeString(e.ApproverPub)
		ssh, err2 := base64.RawURLEncoding.DecodeString(e.SSHPub)
		if err1 != nil || err2 != nil || !bytes.Equal(pub, approverPub) || !bytes.Equal(ssh, p.sshPub) || e.Seq < 1 {
			return PairDelivery{}, false, ErrApproveTampered
		}
		plain, err := OpenPairEnvelope(p.key, approverPub, e.Seq, e.Sealed)
		if err != nil {
			return PairDelivery{}, false, ErrApproveTampered
		}
		env, err := ParsePairEnvelope(plain)
		if err != nil {
			return PairDelivery{}, false, err
		}
		if newest == nil || e.Seq > newest.Seq {
			newest = &PairDelivery{Seq: e.Seq, Envelope: env}
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if newest != nil && (p.delivered == nil || newest.Seq > p.delivered.Seq) {
		p.delivered = newest
	}
	if p.delivered == nil {
		return PairDelivery{}, false, nil
	}
	return *p.delivered, true, nil
}

// PairApproval is one pair request as the approving device runs it: the
// claim, the reveal check and the typed code as for a browser (AwaitReveal,
// CheckCode, Ready, Live, Deny, Outcome), then the sealed machine list, and
// later lists for retries. herdr's pair.add_key adds the request's key
// (Request().AuthorizedKey()) to each machine between Live and Approve.
type PairApproval struct {
	*approvalRun
	request PairRequest

	sentMu sync.Mutex
	// approved: the service has this device's approval; sent is the
	// highest seq it took from this device.
	approved bool
	sent     uint64
}

// StartPairApproval claims req for this device (key is its enrolled device
// key, T). The new device's key, its SSH key and the commit are the ones
// in req, read before nonce_t exists.
func (c *Client) StartPairApproval(ctx context.Context, acct string, key DeviceKey, req PairRequest) (*PairApproval, error) {
	if req.Kind != PairKind {
		return nil, errors.New("account: not a pair request")
	}
	sshPub, err := req.SSHKey()
	if err != nil {
		return nil, err
	}
	run, err := c.claim(ctx, acct, key, pairV1, req.ID, req.Requester.DevicePub, req.Commit, sshPub)
	if err != nil {
		return nil, err
	}
	run.party = "the device"
	return &PairApproval{approvalRun: run, request: req}, nil
}

// Request is the pair request this approval answers.
func (a *PairApproval) Request() PairRequest { return a.request }

// Approve finishes the request with the machine list sealed to the new
// device at seq (≥ 1, above any seq this device sealed to it before; a
// clock in milliseconds is). Its outcomes are Approval.Approve's.
func (a *PairApproval) Approve(ctx context.Context, seq uint64, env PairEnvelope) error {
	if seq == 0 {
		return &NotApprovedError{ErrPairSeq}
	}
	plain, err := env.Marshal()
	if err != nil {
		return &NotApprovedError{err}
	}
	err = a.finish(ctx, seq, plain, func(sealed string) error {
		return a.c.FinishPair(ctx, a.acct, a.id, seq, sealed)
	})
	if err == nil {
		a.sentMu.Lock()
		a.approved, a.sent = true, max(a.sent, seq)
		a.sentMu.Unlock()
	}
	return err
}

// Resend replaces the machine list the new device gets with env sealed at
// seq, above the last one the service took (Seq): a retry's results, up
// to 10 minutes after Approve. A seq the service already holds is an
// *APIError with PairErrStaleSeq; the end of the 10 minutes 410 expired.
func (a *PairApproval) Resend(ctx context.Context, seq uint64, env PairEnvelope) error {
	a.sentMu.Lock()
	approved, sent := a.approved, a.sent
	a.sentMu.Unlock()
	switch {
	case !approved:
		return ErrPairNotApproved
	case seq <= sent:
		return ErrPairSeq
	}
	plain, err := env.Marshal()
	if err != nil {
		return err
	}
	sealed, err := a.proto.seal(a.key, a.requesterPub, seq, plain)
	if err != nil {
		return err
	}
	if err := a.c.PutPairEnvelope(ctx, a.acct, a.id, seq, sealed); err != nil {
		return err
	}
	a.sentMu.Lock()
	a.sent = max(a.sent, seq)
	a.sentMu.Unlock()
	return nil
}

// Seq is the highest envelope seq the service took from this device for
// the request; 0 before Approve succeeded.
func (a *PairApproval) Seq() uint64 {
	a.sentMu.Lock()
	defer a.sentMu.Unlock()
	return a.sent
}
