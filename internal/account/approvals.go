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
	"net/url"
	"slices"
)

// Approval states (GET /v1/approvals/<id>).
const (
	ApprovalWaiting  = "waiting"
	ApprovalClaimed  = "claimed"
	ApprovalRevealed = "revealed"
	ApprovalDenied   = "denied"
	ApprovalApproved = "approved"
	ApprovalExpired  = "expired"
)

// ApprovalRequest is one browser waiting for approval.
type ApprovalRequest struct {
	ID      string `json:"id"`
	Browser struct {
		DeviceID  string `json:"device_id"`
		DevicePub string `json:"device_pub"`
		Name      string `json:"name"`
		Platform  string `json:"platform"`
		CreatedMs int64  `json:"created_ms"`
	} `json:"browser"`
	Commit string `json:"commit"`
	// Claimed is "no", "you" or "other".
	Claimed   string `json:"claimed"`
	ExpiresIn int64  `json:"expires_in"`
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

// WebApproveOffered reports whether the service lists web_approve.
func (c *Client) WebApproveOffered(ctx context.Context) (bool, error) {
	features, err := c.healthFeatures(ctx)
	if err != nil {
		return false, err
	}
	return slices.Contains(features, WebApproveFeature), nil
}

// Approvals lists the browsers waiting for this account's approval.
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
	return c.authed(ctx, acct, http.MethodPost, "/v1/approvals/"+url.PathEscape(id)+"/claim",
		map[string]string{"nonce_t": base64.RawURLEncoding.EncodeToString(nonceT)}, nil)
}

// ApprovalState reads request id.
func (c *Client) ApprovalState(ctx context.Context, acct, id string) (ApprovalStatus, error) {
	var out ApprovalStatus
	err := c.authed(ctx, acct, http.MethodGet, "/v1/approvals/"+url.PathEscape(id), nil, &out)
	return out, err
}

// ApproveBrowser finishes request id as approved, with the grants it made.
func (c *Client) ApproveBrowser(ctx context.Context, acct, id string, g ApprovalGrant) error {
	body := struct {
		Outcome string `json:"outcome"`
		ApprovalGrant
	}{"approved", g}
	return c.authed(ctx, acct, http.MethodPost, "/v1/approvals/"+url.PathEscape(id)+"/finish", body, nil)
}

// DenyBrowser finishes request id as denied.
func (c *Client) DenyBrowser(ctx context.Context, acct, id string) error {
	return c.authed(ctx, acct, http.MethodPost, "/v1/approvals/"+url.PathEscape(id)+"/finish",
		map[string]string{"outcome": "denied"}, nil)
}

// Statements returns this device's account statements for hosts (≤ 50).
func (c *Client) Statements(ctx context.Context, acct string, hosts []string) ([]Statement, error) {
	var out struct {
		Statements []Statement `json:"statements"`
	}
	if err := c.authed(ctx, acct, http.MethodPost, "/v1/statements", map[string]any{"hosts": hosts}, &out); err != nil {
		return nil, err
	}
	return out.Statements, nil
}
