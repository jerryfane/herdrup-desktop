package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeService is the account service's sign-in as AccountService/src does it
// (sessions.ts, design #698 §2.3, §2.5): /v1/auth/web/start remembers the
// handoff challenge, /v1/auth/handoff checks S256(verifier) against it, and
// /v1/auth/refresh rotates; presenting a refresh token that was rotated
// away revokes the session (401 session_revoked).
type fakeService struct {
	t *testing.T

	mu        sync.Mutex
	challenge string
	code      string
	current   string // the session's refresh token; "" once revoked
	spent     map[string]bool
	refreshes int
	signouts  []string
	n         int
	down      bool
	features  []string
}

func newFake(t *testing.T) (*fakeService, *httptest.Server) {
	f := &fakeService{t: t, spent: map[string]bool{}}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv
}

func token(prefix string, n int) string {
	return fmt.Sprintf("%s.%022d.%043d", prefix, 7, n)
}

func (f *fakeService) pair() map[string]any {
	f.n++
	f.current = token("r1", f.n)
	return map[string]any{"account_id": "acct-1", "access_token": token("a1", f.n), "access_expires_in": 3600,
		"refresh_token": f.current, "refresh_expires_in": 7776000}
}

func (f *fakeService) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	reply := func(status int, body any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
	if f.down {
		reply(503, map[string]string{"error": "unavailable"})
		return
	}
	var body map[string]string
	_ = json.NewDecoder(r.Body).Decode(&body)
	switch r.URL.Path {
	case "/v1/auth/handoff":
		// Exactly {code, handoff_verifier}: any other field is a 400
		// (herdr-app 523079, Worker branch accounts-web-698).
		if len(body) != 2 {
			reply(400, map[string]string{"error": "bad_request"})
			return
		}
		if body["code"] != f.code || challenge(body["handoff_verifier"]) != f.challenge {
			reply(400, map[string]string{"error": "handoff_invalid"})
			return
		}
		f.code = ""
		p := f.pair()
		p["display_hint"] = "jerry@example.com"
		reply(200, p)
	case "/v1/auth/refresh":
		f.refreshes++
		t := body["refresh_token"]
		switch {
		case f.spent[t]:
			f.current = ""
			reply(401, map[string]string{"error": "session_revoked"})
		case t == "" || t != f.current:
			reply(401, map[string]string{"error": "invalid_token"})
		default:
			f.spent[t] = true
			reply(200, f.pair())
		}
	case "/v1/health":
		reply(200, map[string]any{"ok": true, "version": "0.5.0", "features": f.features})
	case "/v1/auth/signout":
		f.signouts = append(f.signouts, r.Header.Get("Authorization"))
		f.current = ""
		w.WriteHeader(204)
	default:
		reply(404, map[string]string{"error": "not_found"})
	}
}

// start follows the browser half: the service sees the start URL and sends
// back a link with a fresh code.
func (f *fakeService) start(t *testing.T, startURL string) string {
	t.Helper()
	u, err := url.Parse(startURL)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if u.Path != "/v1/auth/web/start" || q.Get("client") != "app" || q.Get("platform") != "linux" || q.Get("handoff_challenge") == "" || len(q) != 4 {
		t.Fatalf("start URL %s", startURL)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.challenge = q.Get("handoff_challenge")
	f.code = strings.Repeat("c", 43)
	return LinkPrefix + "code=" + f.code
}

type memStore struct {
	mu  sync.Mutex
	raw []byte
}

func (m *memStore) Get() ([]byte, error) { m.mu.Lock(); defer m.mu.Unlock(); return m.raw, nil }
func (m *memStore) Set(v []byte) error   { m.mu.Lock(); defer m.mu.Unlock(); m.raw = v; return nil }
func (m *memStore) Delete() error        { m.mu.Lock(); defer m.mu.Unlock(); m.raw = nil; return nil }

func signedIn(t *testing.T) (*fakeService, *Client, *memStore, *time.Time) {
	t.Helper()
	f, srv := newFake(t)
	store := &memStore{}
	c := New(srv.URL, "linux", store, srv.Client())
	now := time.Unix(1_800_000_000, 0)
	c.now = func() time.Time { return now }
	link, err := c.StartSignIn(Google)
	if err != nil {
		t.Fatal(err)
	}
	code, ok := CodeFromLink(f.start(t, link))
	if !ok {
		t.Fatal("link has no code")
	}
	if _, err := c.FinishSignIn(context.Background(), code); err != nil {
		t.Fatal(err)
	}
	return f, c, store, &now
}

func TestSignInRedeemsTheCodeWithTheVerifierOfTheNewestSignIn(t *testing.T) {
	f, srv := newFake(t)
	store := &memStore{}
	c := New(srv.URL, "linux", store, srv.Client())
	ctx := context.Background()

	// A link this app did not start is not redeemed.
	if _, err := c.FinishSignIn(ctx, strings.Repeat("x", 43)); !errors.Is(err, ErrNoSignIn) {
		t.Fatalf("unstarted link: %v", err)
	}
	// Two sign-ins: only the newest one's verifier is held, so the first
	// browser's code can't be redeemed with it.
	first, _ := c.StartSignIn(Apple)
	firstLink := f.start(t, first)
	second, _ := c.StartSignIn(Google)
	_ = second
	code, _ := CodeFromLink(firstLink)
	var api *APIError
	if _, err := c.FinishSignIn(ctx, code); !errors.As(err, &api) || api.Code != "handoff_invalid" {
		t.Fatalf("the first sign-in's code with the second's verifier: %v", err)
	}

	again, _ := c.StartSignIn(Google)
	code, _ = CodeFromLink(f.start(t, again))
	s, err := c.FinishSignIn(ctx, code)
	if err != nil || s.AccountID != "acct-1" || s.DisplayHint != "jerry@example.com" {
		t.Fatalf("sign-in: %+v, %v", s, err)
	}
	if _, err := c.FinishSignIn(ctx, code); !errors.Is(err, ErrNoSignIn) {
		t.Fatalf("the same link twice: %v", err)
	}
	// The store holds the refresh token, never the access token.
	if raw := string(store.raw); !strings.Contains(raw, f.current) || strings.Contains(raw, "a1.") {
		t.Fatalf("stored %s", raw)
	}
}

// Concurrent callers share one refresh: a second refresh with the token the
// first one rotated away would revoke the whole session.
func TestConcurrentCallersShareOneRefresh(t *testing.T) {
	f, c, _, now := signedIn(t)
	*now = now.Add(2 * time.Hour)
	var wg sync.WaitGroup
	tokens := make([]string, 16)
	errs := make([]error, 16)
	for i := range tokens {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tokens[i], errs[i] = c.AccessToken(context.Background())
		}()
	}
	wg.Wait()
	for i := range tokens {
		if errs[i] != nil || tokens[i] != tokens[0] {
			t.Fatalf("caller %d: %q, %v (first %q)", i, tokens[i], errs[i], tokens[0])
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refreshes != 1 || f.current == "" {
		t.Fatalf("%d refreshes, session %q; want one refresh and the session alive", f.refreshes, f.current)
	}
}

func TestARotatedTokenIsKeptAndALaterLaunchUsesIt(t *testing.T) {
	f, c, store, now := signedIn(t)
	*now = now.Add(2 * time.Hour)
	if _, err := c.AccessToken(context.Background()); err != nil {
		t.Fatal(err)
	}
	// The next launch reads the store: the rotated token, not the spent one.
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	defer srv.Close()
	next := New(srv.URL, "linux", store, srv.Client())
	if s, err := next.Current(); err != nil || s == nil || s.DisplayHint != "jerry@example.com" {
		t.Fatalf("restored %+v, %v", s, err)
	}
	if _, err := next.AccessToken(context.Background()); err != nil {
		t.Fatalf("refresh after relaunch: %v", err)
	}
	if f.current == "" {
		t.Fatal("the relaunch presented a spent token and revoked the session")
	}
}

func TestARefusedRefreshSignsOutAndAnOutageKeepsTheSession(t *testing.T) {
	f, c, store, now := signedIn(t)
	*now = now.Add(2 * time.Hour)
	f.mu.Lock()
	f.down = true
	f.mu.Unlock()
	var api *APIError
	if _, err := c.AccessToken(context.Background()); !errors.As(err, &api) || api.Status != 503 {
		t.Fatalf("outage: %v", err)
	}
	if store.raw == nil {
		t.Fatal("an outage dropped the session")
	}
	f.mu.Lock()
	f.down, f.current = false, "" // revoked meanwhile (another device removed this one)
	f.mu.Unlock()
	if _, err := c.AccessToken(context.Background()); !errors.Is(err, ErrSignedOut) {
		t.Fatalf("revoked: %v", err)
	}
	if store.raw != nil {
		t.Fatal("a refused token was kept")
	}
	if s, _ := c.Current(); s != nil {
		t.Fatalf("still signed in as %+v", s)
	}
}

func TestSignOutEndsTheSessionOnTheServiceAndForgetsIt(t *testing.T) {
	f, c, store, _ := signedIn(t)
	if err := c.SignOut(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.signouts) != 1 || !strings.HasPrefix(f.signouts[0], "Bearer a1.") || store.raw != nil {
		t.Fatalf("signouts %v, stored %q", f.signouts, store.raw)
	}
}

func TestErrorFromLink(t *testing.T) {
	if code, ok := ErrorFromLink(LinkPrefix + "error=cancelled"); !ok || code != "cancelled" {
		t.Fatalf("%q %v", code, ok)
	}
	if _, ok := ErrorFromLink(LinkPrefix + "code=" + strings.Repeat("c", 43)); ok {
		t.Fatal("a code link read as an error")
	}
}

func TestCodeFromLink(t *testing.T) {
	code := strings.Repeat("A", 43)
	for link, want := range map[string]bool{
		LinkPrefix + "code=" + code:          true,
		LinkPrefix + "code=" + code[:42]:     false,
		"herdrup://pair#code=" + code:        false,
		LinkPrefix + "code=" + code + "&x=1": true,
	} {
		if got, ok := CodeFromLink(link); ok != want || (ok && got != code) {
			t.Errorf("%s: %q %v", link, got, ok)
		}
	}
}

type fakeSecrets struct {
	values map[string][]byte
	err    error
}

var errNotFound = errors.New("not found")

func (s *fakeSecrets) Get(k string) ([]byte, error) {
	if s.err != nil {
		return nil, s.err
	}
	v, ok := s.values[k]
	if !ok {
		return nil, errNotFound
	}
	return v, nil
}
func (s *fakeSecrets) Set(k string, v []byte) error {
	if s.err != nil {
		return s.err
	}
	s.values[k] = v
	return nil
}
func (s *fakeSecrets) Delete(k string) error {
	if s.err != nil {
		return s.err
	}
	delete(s.values, k)
	return nil
}

// Without a credential store the session lives in memory only: no error,
// no file, and Persistent says the app forgets it at quit.
func TestSecretsStoreFallsBackToMemoryWithoutACredentialStore(t *testing.T) {
	secrets := &fakeSecrets{values: map[string][]byte{}}
	s := NewSecretsStore(secrets, errNotFound)
	if raw, err := s.Get(); raw != nil || err != nil || !s.Persistent() {
		t.Fatalf("empty store: %q, %v", raw, err)
	}
	if err := s.Set([]byte("x")); err != nil || string(secrets.values[SecretKey]) != "x" {
		t.Fatalf("set: %v %q", err, secrets.values)
	}

	none := NewSecretsStore(&fakeSecrets{err: fmt.Errorf("mygo: secrets: %w", errors.ErrUnsupported)}, errNotFound)
	if err := none.Set([]byte("y")); err != nil {
		t.Fatal(err)
	}
	if raw, err := none.Get(); string(raw) != "y" || err != nil || none.Persistent() {
		t.Fatalf("memory fallback: %q, %v, persistent %v", raw, err, none.Persistent())
	}
	if err := none.Delete(); err != nil {
		t.Fatal(err)
	}
	if raw, _ := none.Get(); raw != nil {
		t.Fatalf("after delete %q", raw)
	}

	broken := NewSecretsStore(&fakeSecrets{err: errors.New("locked")}, errNotFound)
	if _, err := broken.Get(); err == nil || !broken.Persistent() {
		t.Fatalf("a failing store is an error, not a fallback: %v", err)
	}
}

// Each provider's button shows only once the service lists its
// web_sign_in_* flag; a provider seen stays.
func TestSignInIsOfferedPerProviderOnceTheServiceListsIt(t *testing.T) {
	f, srv := newFake(t)
	c := New(srv.URL, "linux", &memStore{}, srv.Client())
	ctx := context.Background()
	if got, err := c.WebSignInProviders(ctx); len(got) != 0 || err != nil {
		t.Fatalf("before: %v, %v", got, err)
	}
	f.mu.Lock()
	f.features = []string{"native_sign_in", "sync", "web_sign_in_google"}
	f.mu.Unlock()
	if got, _ := c.WebSignInProviders(ctx); len(got) != 1 || got[0] != Google {
		t.Fatalf("google only: %v", got)
	}
	f.mu.Lock()
	f.features = []string{"web_sign_in_apple"}
	f.mu.Unlock()
	if got, _ := c.WebSignInProviders(ctx); len(got) != 2 || got[0] != Apple || got[1] != Google {
		t.Fatalf("both, Apple first: %v", got)
	}
	f.mu.Lock()
	f.down = true
	f.mu.Unlock()
	if got, _ := c.WebSignInProviders(ctx); len(got) != 2 {
		t.Fatalf("a later outage withdrew sign-in from a running app: %v", got)
	}
}

// A service that can't answer its health check is an error, not "no
// sign-in": the app keeps the account row (and a signed-in session) with the
// problem instead of hiding it (herdrup #770-f3).
func TestUnreachableServiceIsAnErrorNotNoSignIn(t *testing.T) {
	f, srv := newFake(t)
	f.mu.Lock()
	f.down = true
	f.mu.Unlock()
	c := New(srv.URL, "linux", &memStore{}, srv.Client())
	if got, err := c.WebSignInProviders(context.Background()); err == nil {
		t.Fatalf("a failed health check read as no sign-in: %v", got)
	}
	gone := New("http://127.0.0.1:1", "linux", &memStore{}, srv.Client())
	if got, err := gone.WebSignInProviders(context.Background()); err == nil {
		t.Fatalf("no answer read as no sign-in: %v", got)
	}
}

// A sign-out whose context ends while a refresh is out (a window closed):
// the refresh's later answer must neither crash nor bring the session back.
// Each step waits on an explicit signal: the refresh has reached the
// service, sign-out has returned, the refresh has finished.
func TestARefreshAnsweringAfterSignOutCommitsNothing(t *testing.T) {
	f, c, store, now := signedIn(t)
	started, gate := make(chan struct{}), make(chan struct{})
	var once sync.Once
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/auth/refresh" {
			once.Do(func() { close(started) })
			<-gate
		}
		f.serve(w, r)
	}))
	defer slow.Close()
	c.service = slow.URL
	*now = now.Add(2 * time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.SignOut(ctx) }()
	<-started // the refresh is at the service
	c.mu.Lock()
	inFlight := c.flight
	c.mu.Unlock()
	if inFlight == nil {
		t.Fatal("no refresh in flight")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("sign-out: %v", err)
	}
	close(gate) // the refresh answers, with a good token pair
	<-inFlight.done
	if s, _ := c.Current(); s != nil {
		t.Fatalf("signed in again after sign-out: %+v", s)
	}
	if store.raw != nil {
		t.Fatalf("the late refresh stored a session: %s", store.raw)
	}
	if !errors.Is(inFlight.err, ErrSignedOut) {
		t.Fatalf("the late refresh's result: %v; want ErrSignedOut", inFlight.err)
	}
}
