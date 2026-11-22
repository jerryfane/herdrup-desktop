package account

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

// Deleting the account from the desktop (DESIGN #698 §6.6, herdrup #783):
// the deletion is confirmed by a fresh sign-in in the system browser.
//
//  1. POST /v1/account/delete/start, Bearer, {provider, handoff_challenge}
//     → {start_url, expires_in}
//  2. the browser signs in again at start_url (single use)
//  3. herdrup://account#delete_code=<43> or #delete_error=<code>
//  4. POST /v1/account/delete, same Bearer, {handoff_code, handoff_verifier}
//     → {deleted: true, manual_revoke}
//
// The service offers it once /v1/health lists web_delete.

// WebDeleteFeature is the /v1/health feature that says the service can
// confirm a deletion through the browser.
const WebDeleteFeature = "web_delete"

// Deleted is how a deletion ended: ManualRevoke when Apple didn't confirm
// the revoke and the person should stop Sign in with Apple themselves.
type Deleted struct {
	Deleted      bool `json:"deleted"`
	ManualRevoke bool `json:"manual_revoke"`
}

// WebDeleteOffered reports whether the service lists web_delete.
func (c *Client) WebDeleteOffered(ctx context.Context) (bool, error) {
	features, err := c.healthFeatures(ctx)
	if err != nil {
		return false, err
	}
	for _, f := range features {
		if f == WebDeleteFeature {
			return true, nil
		}
	}
	return false, nil
}

// StartDelete asks the service for the confirming sign-in's URL for account
// acct (signed in with provider), keeping its verifier for FinishDelete. A
// newer StartDelete replaces an older one.
func (c *Client) StartDelete(ctx context.Context, acct string, provider Provider) (string, error) {
	if provider != Apple && provider != Google {
		return "", errors.New("account: unknown provider")
	}
	verifier, err := randomB64(32)
	if err != nil {
		return "", err
	}
	var out struct {
		StartURL string `json:"start_url"`
	}
	if err := c.authed(ctx, acct, http.MethodPost, "/v1/account/delete/start", map[string]string{"provider": string(provider), "handoff_challenge": challenge(verifier)}, &out); err != nil {
		return "", err
	}
	u, err := url.Parse(out.StartURL)
	if err != nil || u.Scheme != "https" {
		return "", errors.New("account service: malformed delete link")
	}
	c.mu.Lock()
	c.pendingDelete = verifier
	c.mu.Unlock()
	return out.StartURL, nil
}

// AbandonDelete forgets the pending deletion's verifier.
func (c *Client) AbandonDelete() {
	c.mu.Lock()
	c.pendingDelete = ""
	c.mu.Unlock()
}

// FinishDelete deletes account acct with the code the browser brought back
// and the pending verifier. On success the session that started it is
// forgotten here (the account and its sessions are gone on the service), but
// not a session signed in since. ErrDeleteUnconfirmed means the request went
// out and no answer came back: the service may have deleted the account.
func (c *Client) FinishDelete(ctx context.Context, acct, code string) (Deleted, error) {
	if !handoffCode.MatchString(code) {
		return Deleted{}, errors.New("account: malformed delete link")
	}
	c.mu.Lock()
	verifier := c.pendingDelete
	c.pendingDelete = ""
	epoch := c.epoch
	c.mu.Unlock()
	if verifier == "" {
		return Deleted{}, ErrNoDelete
	}
	var out Deleted
	if err := c.authed(ctx, acct, http.MethodPost, "/v1/account/delete", map[string]string{"handoff_code": code, "handoff_verifier": verifier}, &out); err != nil {
		var api *APIError
		if errors.As(err, &api) || errors.Is(err, ErrSignedOut) || errors.Is(err, ErrAccountChanged) {
			return Deleted{}, err
		}
		return Deleted{}, errors.Join(ErrDeleteUnconfirmed, err)
	}
	if !out.Deleted {
		return Deleted{}, errors.New("account service: the deletion was not confirmed")
	}
	_, err := c.forgetIf(func() bool { return c.epoch == epoch && c.saved != nil && c.saved.AccountID == acct })
	return out, err
}

// ErrDeleteUnconfirmed is a deletion request that got no answer.
var ErrDeleteUnconfirmed = errors.New("account: the deletion's answer didn't arrive")

// ErrNoDelete means a delete link arrived that this app did not start (or
// started before the newest one).
var ErrNoDelete = errors.New("account: no deletion is waiting for this link")

// DeleteCodeFromLink returns the code of a herdrup://account#delete_code=…
// link.
func DeleteCodeFromLink(link string) (string, bool) {
	q, ok := linkFragment(link)
	if !ok {
		return "", false
	}
	code := q.Get("delete_code")
	return code, handoffCode.MatchString(code)
}

// DeleteErrorFromLink returns the code of a herdrup://account#delete_error=…
// link (wrong_account, cancelled, flow_expired, …).
func DeleteErrorFromLink(link string) (string, bool) {
	q, ok := linkFragment(link)
	if !ok {
		return "", false
	}
	code := q.Get("delete_error")
	return code, code != "" && len(code) <= 64
}

// IsDeleteLink is a herdrup://account#delete_code= or #delete_error= link:
// a deletion's return, not a sign-in's.
func IsDeleteLink(link string) bool {
	q, ok := linkFragment(link)
	return ok && (q.Has("delete_code") || q.Has("delete_error"))
}

func linkFragment(link string) (url.Values, bool) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(link), LinkPrefix)
	if !ok {
		return nil, false
	}
	q, err := url.ParseQuery(rest)
	return q, err == nil
}
