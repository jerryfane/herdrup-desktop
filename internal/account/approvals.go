package account

// The approver's side of browser approval (web owner access WIRE-PLAN §2.4):
// a trusted device lists the browsers waiting, claims one with nonce_t, waits
// for the browser's reveal, then finishes with the sealed machine list or a
// denial. Statements (DESIGN §3.3) bind each machine's grant to this account.
//
//	GET  /v1/approvals                         → {requests:[…]}
//	POST /v1/approvals/<id>/claim   {nonce_t}  → 200 | 409 already_claimed
//	GET  /v1/approvals/<id>                    → {state, expires_in, approver?, nonce_t?, nonce_b?}
//	POST /v1/approvals/<id>/finish  {outcome, scope?, expires_ms?, seq?, sealed?}
//	POST /v1/statements {hosts}               → {statements:[{host, jws}], exp}

import (
	"context"
	"encoding/base64"
	"net/http"
	"slices"
)

// Approval states (GET /v1/approvals/<id>). ApprovalCancelled is a pair
// request its new device cancelled (pairs.go).
const (
	ApprovalWaiting   = "waiting"
	ApprovalClaimed   = "claimed"
	ApprovalRevealed  = "revealed"
	ApprovalDenied    = "denied"
	ApprovalApproved  = "approved"
	ApprovalExpired   = "expired"
	ApprovalCancelled = "cancelled"
)

// ApprovalRequest is one browser waiting for approval.
type ApprovalRequest struct {
	ID      string        `json:"id"`
	Browser RequestDevice `json:"browser"`
	Commit  string        `json:"commit"`
	// Claimed is "no", "you" or "other".
	Claimed   string `json:"claimed"`
	ExpiresIn int64  `json:"expires_in"`
}

// RequestDevice is the device that asks, as GET /v1/approvals lists it: a
// browser, or the new device of a pair request.
type RequestDevice struct {
	DeviceID  string `json:"device_id"`
	DevicePub string `json:"device_pub"`
	Name      string `json:"name"`
	Platform  string `json:"platform"`
	CreatedMs int64  `json:"created_ms"`
}

// ApprovalStatus is GET /v1/approvals/<id> as the approver reads it.
type ApprovalStatus struct {
	State string `json:"state"`
	// ExpiresIn is the seconds the request has left.
	ExpiresIn int64 `json:"expires_in"`
	Approver  *struct {
		DevicePub string `json:"device_pub"`
		Name      string `json:"name"`
	} `json:"approver,omitempty"`
	NonceT string `json:"nonce_t,omitempty"`
	NonceB string `json:"nonce_b,omitempty"`
	// OutcomeStored: the service answered from an outcome it stored, not one
	// it computed from the clock. For an expiry, no finish can be recorded
	// after it (herdrup #801).
	OutcomeStored bool `json:"outcome_stored,omitempty"`
	// Kind, Commit, SSHPub and Device come with a pair request only
	// (pairs.go): what an approver opening it by id needs.
	Kind   string         `json:"kind,omitempty"`
	Commit string         `json:"commit,omitempty"`
	SSHPub string         `json:"ssh_pub,omitempty"`
	Device *RequestDevice `json:"device,omitempty"`
}

// ApprovalGrant is what the approver reports with an approval: the scope and
// expiry it gave, and the machine list sealed to the browser.
type ApprovalGrant struct {
	Scope     string `json:"scope"`
	ExpiresMs int64  `json:"expires_ms"`
	Seq       uint64 `json:"seq"`
	Sealed    string `json:"sealed"`
}

// Statement is one machine's account statement (a JWS for aud = host).
type Statement struct {
	Host string `json:"host"`
	JWS  string `json:"jws"`
}

// WebApproveFeature is the /v1/health feature that says the service carries
// browser approvals (herdrup #792).
const WebApproveFeature = "web_approve"

// ApprovalsOffered reads /v1/health once for both kinds of approval
// request: browsers' (web_approve) and new devices' (pair_v1).
func (c *Client) ApprovalsOffered(ctx context.Context) (browsers, pairs bool, err error) {
	features, err := c.healthFeatures(ctx)
	if err != nil {
		return false, false, err
	}
	return slices.Contains(features, WebApproveFeature), slices.Contains(features, PairFeature), nil
}

// WebApproveOffered reports whether the service lists web_approve.
func (c *Client) WebApproveOffered(ctx context.Context) (bool, error) {
	features, err := c.healthFeatures(ctx)
	if err != nil {
		return false, err
	}
	return slices.Contains(features, WebApproveFeature), nil
}

// Approvals lists the browsers waiting for this account's approval (pair
// requests are listed apart, PairRequests, or with them, AnyApprovals).
func (c *Client) Approvals(ctx context.Context, acct string) ([]ApprovalRequest, error) {
	var out struct {
		Requests []ApprovalRequest `json:"requests"`
	}
	if err := c.authed(ctx, acct, http.MethodGet, "/v1/approvals", nil, &out); err != nil {
		return nil, err
	}
	return out.Requests, nil
}

// ClaimApproval claims request id with nonceT. The service records this device
// as the approver from the session, never from the body.
func (c *Client) ClaimApproval(ctx context.Context, acct, id string, nonceT []byte) error {
	return c.authed(ctx, acct, http.MethodPost, approvalPath(id, "claim"),
		map[string]string{"nonce_t": base64.RawURLEncoding.EncodeToString(nonceT)}, nil)
}

// ApprovalState reads request id.
func (c *Client) ApprovalState(ctx context.Context, acct, id string) (ApprovalStatus, error) {
	var out ApprovalStatus
	err := c.authed(ctx, acct, http.MethodGet, approvalPath(id, ""), nil, &out)
	return out, err
}

// finishApproval finishes request id with body: {outcome: "denied"}, or
// {outcome: "approved"} and what the request's protocol reports with it.
func (c *Client) finishApproval(ctx context.Context, acct, id string, body any) error {
	return c.authed(ctx, acct, http.MethodPost, approvalPath(id, "finish"), body, nil)
}

// ApproveBrowser finishes request id as approved, with the grants it made.
func (c *Client) ApproveBrowser(ctx context.Context, acct, id string, g ApprovalGrant) error {
	return c.finishApproval(ctx, acct, id, struct {
		Outcome string `json:"outcome"`
		ApprovalGrant
	}{ApprovalApproved, g})
}

// DenyApproval finishes request id, a browser's or a pair request, as
// denied.
func (c *Client) DenyApproval(ctx context.Context, acct, id string) error {
	return c.finishApproval(ctx, acct, id, map[string]string{"outcome": ApprovalDenied})
}

// Statements returns this device's account statements for hosts (≤ 50).
func (c *Client) Statements(ctx context.Context, acct string, hosts []string) ([]Statement, error) {
	statements, _, err := c.statements(ctx, Round{Account: acct}, hosts)
	return statements, err
}

// statements is Statements for r, with the answer's exp (unix seconds, the
// same for every statement: AccountService src/statements.ts).
func (c *Client) statements(ctx context.Context, r Round, hosts []string) ([]Statement, int64, error) {
	var out struct {
		Statements []Statement `json:"statements"`
		Exp        int64       `json:"exp"`
	}
	body := map[string]any{"hosts": hosts}
	if err := c.authedEach(ctx, r, http.MethodPost, "/v1/statements", func() (any, error) { return body, nil }, nil, &out); err != nil {
		return nil, 0, err
	}
	return out.Statements, out.Exp, nil
}
