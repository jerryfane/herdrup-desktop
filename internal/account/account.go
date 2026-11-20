// Package account signs the desktop app in to the HerdrUp account service
// (accounts.herdrup.app, design #698 §2.3 and §2.5).
//
// Sign-in is the web flow through the service: the app makes a random
// handoff verifier, opens /v1/auth/web/start in the system browser with its
// S256 challenge, and the service sends the browser back to
// herdrup://account#code=…. The app redeems that code with the verifier
// (POST /v1/auth/handoff), so another app that catches the custom-scheme
// link cannot use it.
//
// A session is a 1-hour access token kept in memory and a 90-day refresh
// token that rotates on every use. The service treats a refresh token
// presented after it rotated as theft and revokes the whole session, so
// refreshes are single-flight: one in flight per process, the others wait
// for its result.
package account

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// DefaultService is the account service the app signs in to.
const DefaultService = "https://accounts.herdrup.app"

// Provider is how a person signs in.
type Provider string

const (
	Apple  Provider = "apple"
	Google Provider = "google"
)

// LinkPrefix starts the link the service sends a finished sign-in back to.
const LinkPrefix = "herdrup://account#"

var (
	// ErrSignedOut means there is no session: the person signs in again.
	// It is returned once the service refused the refresh token, which is
	// then forgotten.
	ErrSignedOut = errors.New("account: signed out")
	// ErrNoSignIn means a sign-in link arrived that this app did not start
	// (or started before the newest one): it is not redeemed.
	ErrNoSignIn = errors.New("account: no sign-in is waiting for this link")
)

// APIError is the service's answer {"error": code} with its HTTP status.
type APIError struct {
	Status int
	Code   string
}

func (e *APIError) Error() string { return fmt.Sprintf("account service: %d %s", e.Status, e.Code) }

// Session is what the app shows about the signed-in account.
type Session struct {
	AccountID string `json:"account_id"`
	// DisplayHint is the Google address the service passes once at sign-in
	// ("Signed in as …"); "" for Apple, which sends none.
	DisplayHint string `json:"display_hint,omitempty"`
}

// tokenPair is the service's TokenPair (AccountService/src/sessions.ts),
// with the sign-in fields that come with it.
type tokenPair struct {
	AccountID        string `json:"account_id"`
	AccessToken      string `json:"access_token"`
	AccessExpiresIn  int64  `json:"access_expires_in"`
	RefreshToken     string `json:"refresh_token"`
	RefreshExpiresIn int64  `json:"refresh_expires_in"`
	DisplayHint      string `json:"display_hint,omitempty"`
}

var (
	accessToken  = regexp.MustCompile(`^a1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$`)
	refreshToken = regexp.MustCompile(`^r1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$`)
	handoffCode  = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

func (p tokenPair) valid() bool {
	return p.AccountID != "" && accessToken.MatchString(p.AccessToken) && refreshToken.MatchString(p.RefreshToken) && p.AccessExpiresIn > 0
}

// stored is what Store keeps under its key: the refresh token and what the
// app shows about the account.
type stored struct {
	RefreshToken string `json:"refresh_token"`
	Session
}

// Store keeps the session's refresh token. Get returns (nil, nil) when it
// holds none.
type Store interface {
	Get() ([]byte, error)
	Set([]byte) error
	Delete() error
}

// Client is one app's account session.
type Client struct {
	service  string
	platform string
	http     *http.Client
	store    Store
	now      func() time.Time

	// writes serialises the session's transitions with their store writes,
	// so a sign-out's delete can't be followed by a late refresh's save.
	writes sync.Mutex
	mu     sync.Mutex
	// epoch counts sign-ins and sign-outs: a refresh commits only into the
	// session it started from.
	epoch    uint64
	live     map[Provider]bool // providers the service said it offers (kept once seen)
	pending  string            // the newest sign-in's handoff verifier
	saved    *stored
	loaded   bool
	access   string
	accessAt time.Time // when the access token stops working
	flight   *refresh
}

// refresh is one refresh in flight; done closes when it has an answer.
type refresh struct {
	done  chan struct{}
	err   error
	epoch uint64
}

// New returns a client for service (DefaultService when ""). platform is
// the service's platform name: macos, windows or linux.
func New(service, platform string, store Store, client *http.Client) *Client {
	if service == "" {
		service = DefaultService
	}
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	return &Client{service: strings.TrimRight(service, "/"), platform: platform, http: client, store: store, now: time.Now}
}

// webSignInFeature is the /v1/health feature that says the service can
// finish a web sign-in with provider (its Apple Services ID, or its Google
// web client id and secret, is set).
func webSignInFeature(p Provider) string { return "web_sign_in_" + string(p) }

// WebSignInProviders returns the providers the service can sign in with on
// the web, Apple first, so the app shows only buttons a deployed service
// can finish. A provider seen once stays for the life of the client; the
// rest are asked again on the next call. A health check that fails (no
// answer, not 200, not JSON) is an error unless a provider was seen
// before: unreachable is not the same as "offers no sign-in".
func (c *Client) WebSignInProviders(ctx context.Context) ([]Provider, error) {
	c.mu.Lock()
	all := c.live[Apple] && c.live[Google]
	c.mu.Unlock()
	if all {
		return []Provider{Apple, Google}, nil
	}
	features, err := c.healthFeatures(ctx)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.live == nil {
		c.live = map[Provider]bool{}
	}
	for _, f := range features {
		for _, p := range []Provider{Apple, Google} {
			if f == webSignInFeature(p) {
				c.live[p] = true
			}
		}
	}
	var out []Provider
	for _, p := range []Provider{Apple, Google} {
		if c.live[p] {
			out = append(out, p)
		}
	}
	if len(out) == 0 && err != nil {
		return nil, err
	}
	return out, nil
}

// healthFeatures is the service's /v1/health feature list.
func (c *Client) healthFeatures(ctx context.Context) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.service+"/v1/health", nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("account service health: %s", resp.Status)
	}
	var health struct {
		Features []string `json:"features"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<10)).Decode(&health); err != nil {
		return nil, fmt.Errorf("account service health: %w", err)
	}
	return health.Features, nil
}

// StartSignIn returns the URL to open in the system browser. A sign-in
// started before it can no longer finish.
func (c *Client) StartSignIn(provider Provider) (string, error) {
	if provider != Apple && provider != Google {
		return "", fmt.Errorf("account: unknown provider %q", provider)
	}
	verifier, err := randomB64(32)
	if err != nil {
		return "", err
	}
	c.mu.Lock()
	c.pending = verifier
	c.mu.Unlock()
	// The session opens with the platform named here when the code is
	// redeemed; the handoff itself carries only the code and verifier.
	q := url.Values{"provider": {string(provider)}, "client": {"app"}, "platform": {c.platform}, "handoff_challenge": {challenge(verifier)}}
	return c.service + "/v1/auth/web/start?" + q.Encode(), nil
}

// challenge is S256(verifier): base64url of its SHA-256, without padding.
func challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// CodeFromLink returns the handoff code of a herdrup://account#code=… link.
func CodeFromLink(link string) (string, bool) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(link), LinkPrefix)
	if !ok {
		return "", false
	}
	q, err := url.ParseQuery(rest)
	if err != nil {
		return "", false
	}
	code := q.Get("code")
	return code, handoffCode.MatchString(code)
}

// ErrorFromLink returns the code of a herdrup://account#error=… link: the
// service's word for a sign-in that ended without a session (cancelled,
// flow_expired, browser_mismatch, provider_not_configured, token_invalid,
// provider_error, exchange_failed).
func ErrorFromLink(link string) (string, bool) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(link), LinkPrefix)
	if !ok {
		return "", false
	}
	q, err := url.ParseQuery(rest)
	if err != nil {
		return "", false
	}
	code := q.Get("error")
	return code, code != "" && len(code) <= 64
}

// AbandonSignIn forgets the newest sign-in's verifier: the service said it
// ended without a session.
func (c *Client) AbandonSignIn() {
	c.mu.Lock()
	c.pending = ""
	c.mu.Unlock()
}

// FinishSignIn redeems the code of the link the service sent back, with
// the verifier of the newest sign-in this app started, and keeps the
// session. Each verifier is redeemed at most once.
func (c *Client) FinishSignIn(ctx context.Context, code string) (Session, error) {
	if !handoffCode.MatchString(code) {
		return Session{}, errors.New("account: malformed sign-in link")
	}
	c.mu.Lock()
	verifier := c.pending
	c.pending = ""
	c.mu.Unlock()
	if verifier == "" {
		return Session{}, ErrNoSignIn
	}
	var pair tokenPair
	if err := c.post(ctx, "/v1/auth/handoff", "", map[string]string{"code": code, "handoff_verifier": verifier}, &pair); err != nil {
		return Session{}, err
	}
	if !pair.valid() {
		return Session{}, errors.New("account service: malformed session")
	}
	s := &stored{RefreshToken: pair.RefreshToken, Session: Session{AccountID: pair.AccountID, DisplayHint: pair.DisplayHint}}
	c.writes.Lock()
	defer c.writes.Unlock()
	c.mu.Lock()
	c.epoch++
	c.flight = nil
	c.saved, c.loaded = s, true
	c.access, c.accessAt = pair.AccessToken, c.expiry(pair.AccessExpiresIn)
	c.mu.Unlock()
	return s.Session, c.persist(s)
}

// Current is the signed-in account, or nil. It reads the store once.
func (c *Client) Current() (*Session, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.loadLocked(); err != nil {
		return nil, err
	}
	if c.saved == nil {
		return nil, nil
	}
	s := c.saved.Session
	return &s, nil
}

func (c *Client) loadLocked() error {
	if c.loaded {
		return nil
	}
	raw, err := c.store.Get()
	if err != nil {
		return err
	}
	c.loaded = true
	if raw == nil {
		return nil
	}
	var s stored
	if json.Unmarshal(raw, &s) != nil || !refreshToken.MatchString(s.RefreshToken) || s.AccountID == "" {
		// Not a session this app wrote: forget it rather than send it.
		_ = c.store.Delete()
		return nil
	}
	c.saved = &s
	return nil
}

// AccessToken returns a current access token, refreshing the session when
// the one held is missing or about to expire. Concurrent callers share one
// refresh.
func (c *Client) AccessToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	if err := c.loadLocked(); err != nil {
		c.mu.Unlock()
		return "", err
	}
	if c.access != "" && c.now().Before(c.accessAt) {
		token := c.access
		c.mu.Unlock()
		return token, nil
	}
	if c.saved == nil {
		c.mu.Unlock()
		return "", ErrSignedOut
	}
	f := c.flight
	if f == nil {
		f = &refresh{done: make(chan struct{}), epoch: c.epoch}
		c.flight = f
		token := c.saved.RefreshToken
		go c.refresh(f, token)
	}
	c.mu.Unlock()
	select {
	case <-f.done:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	if f.err != nil {
		return "", f.err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.access == "" {
		return "", ErrSignedOut
	}
	return c.access, nil
}

// refresh rotates the session once. It runs on its own context, so a
// caller that gives up does not abandon a rotation the service already made:
// its new refresh token is kept either way.
func (c *Client) refresh(f *refresh, token string) {
	defer close(f.done)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var pair tokenPair
	err := c.post(ctx, "/v1/auth/refresh", "", map[string]string{"refresh_token": token}, &pair)
	c.writes.Lock()
	defer c.writes.Unlock()
	c.mu.Lock()
	if c.flight == f {
		c.flight = nil
	}
	var api *APIError
	switch {
	case c.epoch != f.epoch || c.saved == nil:
		// Signed out (or in again) while this ran: its answer belongs to a
		// session the app no longer holds.
		c.mu.Unlock()
		f.err = ErrSignedOut
		return
	case errors.As(err, &api) && api.Status == http.StatusUnauthorized:
		// invalid_token or session_revoked: this token never works again.
		c.saved, c.access = nil, ""
		c.epoch++
		c.mu.Unlock()
		_ = c.store.Delete()
		f.err = ErrSignedOut
		return
	case err != nil:
		// Offline or the service failed: the token was not rotated, so it
		// stays for the next try.
		c.mu.Unlock()
		f.err = err
		return
	case !pair.valid():
		c.mu.Unlock()
		f.err = errors.New("account service: malformed session")
		return
	}
	s := &stored{RefreshToken: pair.RefreshToken, Session: c.saved.Session}
	if pair.AccountID != "" {
		s.AccountID = pair.AccountID
	}
	c.saved = s
	c.access, c.accessAt = pair.AccessToken, c.expiry(pair.AccessExpiresIn)
	c.mu.Unlock()
	// The old token is spent now: presenting it again would revoke the
	// session, so the new one replaces it in the store. If the store fails,
	// the session lives on in memory until the app quits; the access token
	// is good either way.
	_ = c.persist(s)
}

// SignOut ends the session on the service when it can and forgets it here
// either way.
func (c *Client) SignOut(ctx context.Context) error {
	token, err := c.AccessToken(ctx)
	c.writes.Lock()
	c.mu.Lock()
	c.epoch++
	c.flight = nil
	c.saved, c.access, c.pending, c.loaded = nil, "", "", true
	c.mu.Unlock()
	deleted := c.store.Delete()
	c.writes.Unlock()
	if err == nil {
		var api *APIError
		if err := c.post(ctx, "/v1/auth/signout", token, nil, nil); err != nil && !(errors.As(err, &api) && api.Status == http.StatusUnauthorized) {
			// Forgotten here; the service drops the session when its
			// refresh token expires.
			return errors.Join(deleted, err)
		}
	}
	return deleted
}

func (c *Client) persist(s *stored) error {
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return c.store.Set(raw)
}

// expiry is when an access token issued now stops being used: a minute
// before the service's expiry, so a request does not race it.
func (c *Client) expiry(seconds int64) time.Time {
	return c.now().Add(time.Duration(seconds)*time.Second - time.Minute)
}

// ErrAccountChanged means the signed-in account is no longer the one a
// request was made for: its work is stale and is not sent.
var ErrAccountChanged = errors.New("account: the signed-in account changed")

// accessTokenFor is AccessToken, for account acct only: a token is returned
// only while acct's session is the current one, so work planned for one
// account never reaches another.
func (c *Client) accessTokenFor(ctx context.Context, acct string) (string, error) {
	token, err := c.AccessToken(ctx)
	if err != nil {
		return "", err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.saved == nil || c.saved.AccountID != acct || c.access != token {
		return "", ErrAccountChanged
	}
	return token, nil
}

// authed makes a request for account acct with its access token. A 401
// means the access token stopped working before its time (the session was
// refreshed elsewhere in this process, or revoked): it is dropped and the
// request retried once with a fresh one, still for acct only.
func (c *Client) authed(ctx context.Context, acct, method, path string, body, out any) error {
	for attempt := 0; ; attempt++ {
		token, err := c.accessTokenFor(ctx, acct)
		if err != nil {
			return err
		}
		err = c.send(ctx, method, path, token, body, out)
		var api *APIError
		if attempt == 0 && errors.As(err, &api) && api.Status == http.StatusUnauthorized {
			c.mu.Lock()
			if c.access == token {
				c.access = ""
			}
			c.mu.Unlock()
			continue
		}
		return err
	}
}

// post sends body as JSON (none when nil) and decodes a 2xx answer into
// out (when not nil); any other answer is an *APIError.
func (c *Client) post(ctx context.Context, path, bearer string, body any, out any) error {
	return c.send(ctx, http.MethodPost, path, bearer, body, out)
}

func (c *Client) send(ctx context.Context, method, path, bearer string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.service+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		var answer struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &answer)
		return &APIError{Status: resp.StatusCode, Code: answer.Error}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func randomB64(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
