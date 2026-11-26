package account

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"sync"
)

// MaxPairSeq is the highest envelope seq the service takes (a safe
// integer, Number.isSafeInteger).
const MaxPairSeq = 1<<53 - 1

// ErrPairNotApproved is a retry's envelope for a request this device hasn't
// approved (PairApproval.Resend before Approve succeeded).
var ErrPairNotApproved = errors.New("this device hasn't approved that request")

// ErrPairApproved is an Approve of a request this device already approved:
// a new machine list goes with Resend.
var ErrPairApproved = errors.New("this device already approved that request")

// ErrPairSeq is an envelope seq outside 1…MaxPairSeq, or not above every
// seq this device sent for the request (PairApproval.NextSeq).
var ErrPairSeq = errors.New("pair-v1: envelope seq must grow")

// ErrPairListUnknown is an approval the service holds while which machine
// list it holds is unknown: an earlier finish whose answer was lost may be
// the one it took. Resend the list at NextSeq.
var ErrPairListUnknown = errors.New("the device was approved, but whether it has this machine list is unknown")

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
	// revealSent: this device sent nonce_b (the service may hold it);
	// revealed: the service is known to hold it.
	revealSent, revealed bool
	// abandoned: Abandon (or Cancel) was called. Checked under mu after
	// every read, and before the reveal is sent, so nothing a read still in
	// flight returns is acted on.
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
	if err := pairV1.checkBinding(sshPub, created.ID); err != nil {
		// No envelope for it could ever be opened.
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
	// State is an approval state (ApprovalWaiting … ApprovalCancelled).
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
// (replaced, removed), or one this device abandoned, is ErrApprovalEnded;
// an approver key or nonce_t that changes after the code was computed is
// ErrApproveTampered.
func (p *PairAsk) Poll(ctx context.Context) (PairProgress, error) {
	if p.isAbandoned() {
		return PairProgress{State: ApprovalCancelled}, ErrApprovalEnded
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
			if errors.Is(err, ErrApprovalEnded) {
				return PairProgress{State: ApprovalCancelled}, err
			}
			return prog, err
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.abandoned {
		return PairProgress{State: ApprovalCancelled}, ErrApprovalEnded
	}
	if p.revealed {
		prog.Code = p.code
	}
	return prog, nil
}

func (p *PairAsk) isAbandoned() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.abandoned
}

// reveal computes the code over the claim st shows and sends nonce_b,
// unless the request was abandoned meanwhile (ErrApprovalEnded).
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
	case p.abandoned:
		p.mu.Unlock()
		return ErrApprovalEnded
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
	if st.State == ApprovalRevealed && p.revealSent {
		p.revealed = true
	}
	if p.revealed {
		p.mu.Unlock()
		return nil
	}
	p.mu.Unlock()
	err := p.c.revealPair(ctx, p.acct, p.id, p.nonceB, func() error {
		// The access token is in hand (a refresh may have taken a while):
		// past this point Abandon can't stop the reveal, and RevealSent
		// says so.
		p.mu.Lock()
		defer p.mu.Unlock()
		if p.abandoned {
			return ErrApprovalEnded
		}
		p.revealSent = true
		return nil
	})
	var api *APIError
	if errors.As(err, &api) && api.Status == http.StatusConflict && api.Code == "already_revealed" {
		// An earlier reveal of this device went through; its answer was lost.
		err = nil
	}
	if err != nil {
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.revealed = true
	if p.abandoned {
		return ErrApprovalEnded
	}
	return nil
}

// RevealSent reports whether this device sent nonce_b. After Abandon, a
// sent reveal lets an approver that has the code still approve (and add
// the key) until the request ends; one never sent can't.
func (p *PairAsk) RevealSent() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.revealSent
}

// Cancel ends this request on the service (POST /v1/approvals/<id>/cancel):
// its outcome becomes cancelled and an approver's later steps answer 410.
// This device stops the request first, whatever the service answers
// (Abandon). A request the service already ended (expired, cancelled,
// replaced) is nil; any other error means the service may still have it
// open, or finished it (409 already_finished once an approver approved or
// denied it).
func (p *PairAsk) Cancel(ctx context.Context) error {
	p.Abandon()
	err := p.c.CancelPair(ctx, p.acct, p.id)
	if requestGone(err) {
		return nil
	}
	return err
}

// Abandon stops this request here only, as Cancel does before it tells the
// service: once it returns, this device sends no reveal it hadn't sent
// (RevealSent), shows no code and opens no machine list, whatever reads
// were in flight. The request itself ends at its expiry or with this
// device's next request.
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

func (d PairDelivery) clone() PairDelivery {
	d.Envelope.Machines = slices.Clone(d.Envelope.Machines)
	return d
}

// Machines reads GET /v1/pairs/self and opens this request's machine list
// from the approver the code was computed with. ok is false while there is
// none, and once the request is abandoned (whatever the read in flight
// returns). An envelope for this request that names another SSH key, a seq
// out of range, or doesn't open, is ErrApproveTampered; one older than a
// list already opened is passed over for that list. The delivery is the
// caller's own copy.
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
		if err1 != nil || err2 != nil || !bytes.Equal(pub, approverPub) || !bytes.Equal(ssh, p.sshPub) || e.Seq < 1 || e.Seq > MaxPairSeq {
			return PairDelivery{}, false, ErrApproveTampered
		}
		plain, err := OpenPairEnvelope(p.key, approverPub, p.sshPub, p.id, e.Seq, e.Sealed)
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
	if p.abandoned {
		return PairDelivery{}, false, nil
	}
	if newest != nil && (p.delivered == nil || newest.Seq > p.delivered.Seq) {
		p.delivered = newest
	}
	if p.delivered == nil {
		return PairDelivery{}, false, nil
	}
	return p.delivered.clone(), true, nil
}

// PairApproval is one pair request as the approving device runs it: the
// claim, the reveal check and the typed code as for a browser (AwaitReveal,
// CheckCode, Ready, Live, Deny, Outcome), then the sealed machine list, and
// later lists for retries. herdr's pair.add_key adds the request's key
// (Request().AuthorizedKey()) to each machine between Live and Approve.
type PairApproval struct {
	*approvalRun
	request PairRequest

	// writeMu is held across each of Approve's and Resend's writes, from
	// reserving its seq to settling what the service did with it: one
	// envelope of this approval is in flight at a time, so while a write
	// runs its seq is the highest this device ever sent.
	writeMu sync.Mutex

	sentMu sync.Mutex
	// approved: the service holds this device's approval. attempted is
	// the highest seq this device sent for the request (in a finish or an
	// envelope PUT), any of which the service may hold; acked the highest
	// it is known to hold, 0 when none or unknown.
	approved         bool
	attempted, acked uint64
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
	if err := pairV1.checkBinding(sshPub, req.ID); err != nil {
		// Its envelope couldn't be sealed: don't claim what can't be approved.
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

// usable checks seq for a write, under writeMu: in range and above every
// seq sent before (the service may hold any of them). The write marks it
// sent (sending) just before it sends it, still under writeMu, so no other
// write can take seq in between, and one that never went out (refused here)
// leaves it free.
func (a *PairApproval) usable(seq uint64) error {
	a.sentMu.Lock()
	defer a.sentMu.Unlock()
	if seq == 0 || seq > MaxPairSeq || seq <= a.attempted {
		return ErrPairSeq
	}
	return nil
}

// sending marks seq sent, under writeMu: the service may hold it from now
// on.
func (a *PairApproval) sending(seq uint64) {
	a.sentMu.Lock()
	a.attempted = seq
	a.sentMu.Unlock()
}

// Approve finishes the request with the machine list sealed to the new
// device at seq (NextSeq or above). Its outcomes are Approval.Approve's,
// except that a retry after an unknown outcome takes a higher seq: when the
// service turns out to hold an approval this finish didn't get an answer
// for (an earlier one's, perhaps, with another list), Approve sends this
// list over it with the envelope route, and if that fails too returns
// ErrPairListUnknown with the approval held (Resend at NextSeq). Approve
// and Resend run one at a time: a call waits for the one in flight to
// settle (so a second Approve then answers ErrPairApproved).
func (a *PairApproval) Approve(ctx context.Context, seq uint64, env PairEnvelope) error {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	a.sentMu.Lock()
	approved := a.approved
	a.sentMu.Unlock()
	if approved {
		return ErrPairApproved
	}
	plain, err := env.Marshal()
	if err != nil {
		return &NotApprovedError{err}
	}
	if err := a.usable(seq); err != nil {
		return &NotApprovedError{err}
	}
	acknowledged := false
	err = a.finish(ctx, seq, plain, func(sealed string) error {
		a.sending(seq)
		err := a.c.FinishPair(ctx, a.acct, a.id, seq, sealed)
		acknowledged = err == nil
		return err
	})
	if err != nil {
		return err
	}
	a.sentMu.Lock()
	a.approved = true
	if acknowledged {
		a.acked = seq
	}
	a.sentMu.Unlock()
	if acknowledged {
		return nil
	}
	if err := a.put(ctx, seq, plain, true); err != nil {
		return fmt.Errorf("%w: %w", ErrPairListUnknown, err)
	}
	return nil
}

// Resend replaces the machine list the new device gets with env sealed at
// seq (NextSeq or above): a retry's results, up to 10 minutes after the
// approval (then 410 expired).
func (a *PairApproval) Resend(ctx context.Context, seq uint64, env PairEnvelope) error {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	a.sentMu.Lock()
	approved := a.approved
	a.sentMu.Unlock()
	if !approved {
		return ErrPairNotApproved
	}
	plain, err := env.Marshal()
	if err != nil {
		return err
	}
	if err := a.usable(seq); err != nil {
		return err
	}
	return a.put(ctx, seq, plain, false)
}

// put sends plain sealed at seq over the envelope route, under writeMu.
// recovering: seq is also the seq of this write's finish, whose answer was
// lost though the service holds an approval. A stale_seq refusal then says
// the service holds a seq at least this one; it holds none above the
// highest this device sent, which under writeMu is seq (checked), and only
// the claimant writes: so it holds exactly seq, this write's finish, list
// and all.
func (a *PairApproval) put(ctx context.Context, seq uint64, plain []byte, recovering bool) error {
	sealed, err := a.seal(seq, plain)
	if err != nil {
		return err
	}
	a.sending(seq)
	err = a.c.PutPairEnvelope(ctx, a.acct, a.id, seq, sealed)
	var api *APIError
	if recovering && errors.As(err, &api) && api.Status == http.StatusConflict && api.Code == PairErrStaleSeq {
		a.sentMu.Lock()
		highest := seq == a.attempted
		a.sentMu.Unlock()
		if highest {
			err = nil
		}
	}
	if err != nil {
		return err
	}
	a.sentMu.Lock()
	a.acked = max(a.acked, seq)
	a.sentMu.Unlock()
	return nil
}

// Seq is the highest envelope seq the service is known to hold from this
// device for the request: 0 before an approval, or while which list it
// holds is unknown.
func (a *PairApproval) Seq() uint64 {
	a.sentMu.Lock()
	defer a.sentMu.Unlock()
	return a.acked
}

// NextSeq is the lowest seq Approve or Resend takes: above every seq this
// device sent for the request, since the service may hold any of them.
func (a *PairApproval) NextSeq() uint64 {
	a.sentMu.Lock()
	defer a.sentMu.Unlock()
	return a.attempted + 1
}
