package account

// Pair requests on the account service (pair-v1, AccountService DESIGN §13,
// themartianapp/herdrup#870): approve-v1's routes and rules (approvals.go,
// §12.2) for an app device asking another app device of the account to add
// its new SSH key S to the owner's machines.
//
//	POST /v1/approvals                new device {kind:"pair", commit, ssh_pub} → 201 {id, expires_in}
//	GET  /v1/approvals?kind=pair      approver   → {requests:[PairRequest]} (never the caller's own)
//	GET  /v1/approvals?kind=any       approver   → browser and pair requests, each with its kind
//	POST /v1/approvals/<id>/claim     approver   {nonce_t}
//	GET  /v1/approvals/<id>           either     → ApprovalStatus (+ kind, commit, ssh_pub, device)
//	POST /v1/approvals/<id>/reveal    new device {nonce_b}
//	POST /v1/approvals/<id>/cancel    new device, while the request is open → outcome cancelled
//	POST /v1/approvals/<id>/finish    claimant   {outcome:"approved", seq ≥ 1, sealed} | {outcome:"denied"}
//	PUT  /v1/approvals/<id>/envelope  claimant   {seq, sealed} → {seq}, for 10 minutes after the finish
//	GET  /v1/pairs/self               new device → {request?, envelopes:[PairSealed]} (at most one)
//
// A request lives 10 minutes, a reported expiry is final, and a new request
// replaces the new device's earlier one and its envelope. A request ends by
// expiry, a denial, the new device's cancel or its new request; a step on a
// cancelled request answers 410.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
)

const (
	// PairFeature is the /v1/health feature that says the service carries
	// pair-v1.
	PairFeature = "pair_v1"
	// PairKind is a pair request's kind.
	PairKind = "pair"
	// PairSelfPath is the new device's read of its request and envelope.
	PairSelfPath = "/v1/pairs/self"
	// PairErrNotNative is a browser asking for a pair, or reading
	// PairSelfPath (403).
	PairErrNotNative = "not_native"
	// PairErrOwnRequest is the new device claiming its own request (403).
	PairErrOwnRequest = "own_request"
	// PairErrNotApproved is an envelope PUT before the request's approval
	// (409).
	PairErrNotApproved = "not_approved"
	// PairErrStaleSeq is an envelope PUT whose seq isn't above the one the
	// request holds (409).
	PairErrStaleSeq = "stale_seq"
)

func approvalPath(id, step string) string {
	p := "/v1/approvals/" + url.PathEscape(id)
	if step != "" {
		p += "/" + step
	}
	return p
}

// PairRequest is one new device waiting for a pair approval.
type PairRequest struct {
	ID        string        `json:"id"`
	Kind      string        `json:"kind"`
	Requester RequestDevice `json:"device"`
	Commit    string        `json:"commit"`
	// SSHPub is S, the key the approver adds to each machine: unpadded
	// base64url of its 32 raw bytes.
	SSHPub string `json:"ssh_pub"`
	// Claimed is "no", "you" or "other".
	Claimed   string `json:"claimed"`
	ExpiresIn int64  `json:"expires_in"`
}

// SSHKey is S's 32 bytes.
func (r PairRequest) SSHKey() ([]byte, error) {
	s, err := base64.RawURLEncoding.Strict().DecodeString(r.SSHPub)
	if err != nil || len(s) != approveKeySize {
		return nil, ErrApproveTampered
	}
	return s, nil
}

// AuthorizedKey is S as herdr's pair.add_key takes it ("ssh-ed25519 AAAA…").
func (r PairRequest) AuthorizedKey() (string, error) {
	s, err := r.SSHKey()
	if err != nil {
		return "", err
	}
	return SSHAuthorizedKey(s)
}

// PairCreated is the answer to a new pair request.
type PairCreated struct {
	ID string `json:"id"`
	// ExpiresIn is the seconds the request has.
	ExpiresIn int64 `json:"expires_in"`
}

// PairSelf is GET /v1/pairs/self: the new device's request, if it has one,
// and the envelope its claimant sealed (at most one, at the latest seq).
type PairSelf struct {
	Request *struct {
		ID            string `json:"id"`
		State         string `json:"state"`
		ExpiresIn     int64  `json:"expires_in"`
		OutcomeStored bool   `json:"outcome_stored,omitempty"`
	} `json:"request,omitempty"`
	Envelopes []PairSealed `json:"envelopes"`
}

// PairSealed is one sealed machine list the new device holds.
type PairSealed struct {
	RequestID    string `json:"request_id"`
	SSHPub       string `json:"ssh_pub"`
	ApproverPub  string `json:"approver_pub"`
	ApproverName string `json:"approver_name"`
	Seq          uint64 `json:"seq"`
	Sealed       string `json:"sealed"`
}

// PairOffered reports whether the service lists pair_v1.
func (c *Client) PairOffered(ctx context.Context) (bool, error) {
	features, err := c.healthFeatures(ctx)
	if err != nil {
		return false, err
	}
	return slices.Contains(features, PairFeature), nil
}

// PairRequests lists the new devices waiting for this account's approval,
// this device's own request left out.
func (c *Client) PairRequests(ctx context.Context, acct string) ([]PairRequest, error) {
	var out struct {
		Requests []PairRequest `json:"requests"`
	}
	if err := c.authed(ctx, acct, http.MethodGet, "/v1/approvals?kind="+PairKind, nil, &out); err != nil {
		return nil, err
	}
	return out.Requests, nil
}

// AnyApproval is one request from GET /v1/approvals?kind=any: a browser's
// (Browser) or a new device's (Pair); the other is nil.
type AnyApproval struct {
	Browser *ApprovalRequest
	Pair    *PairRequest
}

// AnyApprovals lists both kinds of request in one read, in the service's
// order, so an approver polls once: the browsers Approvals lists and the
// new devices PairRequests lists (this device's own request left out).
// The list is never nil.
func (c *Client) AnyApprovals(ctx context.Context, acct string) ([]AnyApproval, error) {
	var out struct {
		Requests []json.RawMessage `json:"requests"`
	}
	if err := c.authed(ctx, acct, http.MethodGet, "/v1/approvals?kind=any", nil, &out); err != nil {
		return nil, err
	}
	list := make([]AnyApproval, 0, len(out.Requests))
	for _, raw := range out.Requests {
		var kind struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(raw, &kind); err != nil {
			return nil, err
		}
		if kind.Kind == PairKind {
			var r PairRequest
			if err := json.Unmarshal(raw, &r); err != nil {
				return nil, err
			}
			list = append(list, AnyApproval{Pair: &r})
			continue
		}
		var r ApprovalRequest
		if err := json.Unmarshal(raw, &r); err != nil {
			return nil, err
		}
		list = append(list, AnyApproval{Browser: &r})
	}
	return list, nil
}

// RequestPair asks the account's other devices to pair this one, with
// commit over this device's key, sshPub and nonce_b (PairCommit). It
// replaces this device's request.
func (c *Client) RequestPair(ctx context.Context, acct string, commit, sshPub []byte) (PairCreated, error) {
	var out PairCreated
	body := map[string]string{
		"kind":    PairKind,
		"commit":  base64.RawURLEncoding.EncodeToString(commit),
		"ssh_pub": base64.RawURLEncoding.EncodeToString(sshPub),
	}
	err := c.authed(ctx, acct, http.MethodPost, "/v1/approvals", body, &out)
	if err == nil && out.ID == "" {
		err = errors.New("account service: a pair request with no id")
	}
	return out, err
}

// RevealPair reveals nonce_b for request id, once it is claimed and this
// device holds nonce_t.
func (c *Client) RevealPair(ctx context.Context, acct, id string, nonceB []byte) error {
	return c.revealPair(ctx, acct, id, nonceB, func() error { return nil })
}

// revealPair is RevealPair with sending called at each dispatch once its
// access token is in hand, the last point before the request is written:
// an error from it ends the reveal unsent.
func (c *Client) revealPair(ctx context.Context, acct, id string, nonceB []byte, sending func() error) error {
	body := map[string]string{"nonce_b": base64.RawURLEncoding.EncodeToString(nonceB)}
	return c.authedEach(ctx, Round{Account: acct}, http.MethodPost, approvalPath(id, "reveal"), func() (any, error) {
		return body, sending()
	}, nil, nil)
}

// CancelPair cancels this device's request id while it is open: its outcome
// becomes cancelled, and every later step on it answers 410.
func (c *Client) CancelPair(ctx context.Context, acct, id string) error {
	return c.authed(ctx, acct, http.MethodPost, approvalPath(id, "cancel"), struct{}{}, nil)
}

// ReadPairSelf is GET /v1/pairs/self.
func (c *Client) ReadPairSelf(ctx context.Context, acct string) (PairSelf, error) {
	var out PairSelf
	err := c.authed(ctx, acct, http.MethodGet, PairSelfPath, nil, &out)
	return out, err
}

// FinishPair finishes request id as approved, with the machine list sealed
// at seq (≥ 1).
func (c *Client) FinishPair(ctx context.Context, acct, id string, seq uint64, sealed string) error {
	return c.finishApproval(ctx, acct, id, struct {
		Outcome string `json:"outcome"`
		Seq     uint64 `json:"seq"`
		Sealed  string `json:"sealed"`
	}{ApprovalApproved, seq, sealed})
}

// PutPairEnvelope replaces the machine list of request id, which this
// device approved, with one sealed at a higher seq: a retry's results.
func (c *Client) PutPairEnvelope(ctx context.Context, acct, id string, seq uint64, sealed string) error {
	body := struct {
		Seq    uint64 `json:"seq"`
		Sealed string `json:"sealed"`
	}{seq, sealed}
	return c.authed(ctx, acct, http.MethodPut, approvalPath(id, "envelope"), body, nil)
}
