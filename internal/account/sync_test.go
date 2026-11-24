package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// syncService pages hosts items as AccountService src/sync.ts does: two per
// page here, a cursor while more, and 410 reset_required for a since below
// the floor (a pruned delete the caller may have missed).
type syncService struct {
	mu     sync.Mutex
	items  []Item
	floor  int64
	pushes [][]map[string]any
	auth   []string
	// nows are the now_ms of the next sync answers, in turn (0 for none);
	// notAfters the not_after of each push (0 for none).
	nows      []int64
	notAfters []int64
	// revoked are the access tokens a sign-out ended (their requests are
	// answered 401); unauthorizeNext answers the next push 401; handoffs
	// counts the sign-ins redeemed (each a new session of "acct").
	revoked         map[string]bool
	unauthorizeNext bool
	handoffs        int
	refreshes       int
	posted          int // every push received, refused ones too
}

func (s *syncService) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var now int64
	if r.URL.Path == "/v1/sync" && len(s.nows) > 0 {
		now, s.nows = s.nows[0], s.nows[1:]
	}
	withNow := func(out map[string]any) map[string]any {
		if now != 0 {
			out["now_ms"] = now
		}
		return out
	}
	reply := func(status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}
	switch r.URL.Path {
	case "/v1/auth/refresh":
		s.refreshes++
		reply(200, map[string]any{"account_id": "acct", "access_token": token("a1", 100+s.refreshes), "access_expires_in": 3600, "refresh_token": token("r1", 100+s.refreshes), "refresh_expires_in": 1})
		return
	case "/v1/auth/handoff":
		s.handoffs++
		reply(200, map[string]any{"account_id": "acct", "access_token": token("a1", 20+s.handoffs), "access_expires_in": 3600, "refresh_token": token("r1", 20+s.handoffs), "refresh_expires_in": 1})
		return
	case "/v1/auth/signout":
		if s.revoked == nil {
			s.revoked = map[string]bool{}
		}
		s.revoked[r.Header.Get("Authorization")] = true
		reply(200, map[string]any{})
		return
	}
	if r.Method == http.MethodPost {
		s.posted++
	}
	if s.revoked[r.Header.Get("Authorization")] || r.Method == http.MethodPost && s.unauthorizeNext {
		s.unauthorizeNext = false
		reply(401, map[string]string{"error": "invalid_token"})
		return
	}
	s.auth = append(s.auth, r.Header.Get("Authorization"))
	if r.Method == http.MethodPost {
		var body struct {
			Changes  []map[string]any
			NotAfter int64 `json:"not_after"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.pushes, s.notAfters = append(s.pushes, body.Changes), append(s.notAfters, body.NotAfter)
		reply(200, withNow(map[string]any{"rev": 99, "applied": []any{}, "conflicts": []any{}}))
		return
	}
	position := int64(0)
	if c := r.URL.Query().Get("cursor"); c != "" {
		position, _ = strconv.ParseInt(strings.SplitN(c, ".", 2)[0], 10, 64)
	} else {
		since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
		if since != 0 && since < s.floor {
			reply(410, map[string]string{"error": "reset_required"})
			return
		}
		position = since
	}
	var page []Item
	for _, it := range s.items {
		if it.Rev > position && len(page) < 2 {
			page = append(page, it)
		}
	}
	last := s.items[len(s.items)-1].Rev
	more := len(page) > 0 && page[len(page)-1].Rev < last
	out := withNow(map[string]any{"rev": last, "changes": page, "more": more})
	if more {
		out["cursor"] = strconv.FormatInt(page[len(page)-1].Rev, 10) + ".0"
	}
	reply(200, out)
}

func syncClient(t *testing.T, s *syncService) *Client {
	srv := httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(srv.Close)
	store := &memStore{}
	raw, _ := json.Marshal(stored{RefreshToken: token("r1", 1), Session: Session{AccountID: "acct"}})
	store.raw = raw
	c := New(srv.URL, "linux", store, srv.Client())
	c.now = func() time.Time { return time.Unix(1_800_000_000, 0) }
	return c
}

func hostItem(rev int64, host string, deleted bool) Item {
	it := Item{Collection: "hosts", ID: "00000000-0000-4000-8000-00000000000" + strconv.FormatInt(rev, 10), Rev: rev, Deleted: deleted}
	if !deleted {
		it.Body, _ = json.Marshal(HostBody{Host: host, Username: "root"})
	}
	return it
}

func TestPullFollowsTheCursorAndARemovedFloorRestartsAFullPull(t *testing.T) {
	s := &syncService{items: []Item{hostItem(1, "a", false), hostItem(2, "b", false), hostItem(3, "c", false), hostItem(4, "", true), hostItem(5, "e", false)}}
	c := syncClient(t, s)
	ctx := context.Background()
	p, err := c.PullSince(ctx, acctRound, 0)
	if err != nil || !p.Full || p.Reset || p.Rev != 5 || len(p.Items) != 5 {
		t.Fatalf("full pull: %+v, %v", p, err)
	}
	p, err = c.PullSince(ctx, acctRound, 3)
	if err != nil || p.Full || p.Reset || len(p.Items) != 2 || !p.Items[0].Deleted {
		t.Fatalf("incremental: %+v, %v", p, err)
	}
	s.mu.Lock()
	s.floor = 4
	s.mu.Unlock()
	p, err = c.PullSince(ctx, acctRound, 3)
	if err != nil || !p.Full || !p.Reset || len(p.Items) != 5 {
		t.Fatalf("after a prune: %+v, %v; want a full pull", p, err)
	}
	for _, a := range s.auth {
		if !strings.HasPrefix(a, "Bearer a1.") {
			t.Fatalf("sync call without the access token: %q", a)
		}
	}
}

// #448 review: a 410 whose body stalls until the request ends is still a
// reset: the status line decides, before the body is read, so the caller
// is told Reset with the error and can note it.
func TestA410WhoseBodyStallsIsStillAReset(t *testing.T) {
	s := &syncService{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/v1/sync" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusGone)
			w.(http.Flusher).Flush()
			<-r.Context().Done() // the body never comes
			return
		}
		s.serve(w, r)
	}))
	t.Cleanup(srv.Close)
	store := &memStore{}
	store.raw, _ = json.Marshal(stored{RefreshToken: token("r1", 1), Session: Session{AccountID: "acct"}})
	c := New(srv.URL, "linux", store, srv.Client())
	c.now = func() time.Time { return time.Unix(1_800_000_000, 0) }
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	p, err := c.PullSince(ctx, acctRound, 3)
	if err == nil || !p.Reset {
		t.Fatalf("%+v, %v; want the pull failed and the 410 reported (Reset)", p, err)
	}
}

// A pull carries the service's clock as of its earliest page, and none
// when a page came without one (#826); each push's not_after is the newest
// now_ms seen plus two minutes, none before any, and none again once an
// answer comes without now_ms (a service rolled back): until one carries it
// again.
func TestAPullCarriesTheEarliestNowAndAPushItsDeadline(t *testing.T) {
	s := &syncService{items: []Item{hostItem(1, "a", false), hostItem(2, "b", false), hostItem(3, "c", false), hostItem(4, "d", false), hostItem(5, "e", false)}}
	c := syncClient(t, s)
	ctx := context.Background()
	push := changes([]Change{{Collection: "hosts", ID: "00000000-0000-4000-8000-000000000001", Body: HostBody{Host: "x", Username: "u"}}})
	s.nows = []int64{0}
	if _, err := c.Push(ctx, acctRound, push, nil); err != nil {
		t.Fatal(err)
	}
	s.nows = []int64{5_000, 3_000, 9_000}
	if p, err := c.PullSince(ctx, acctRound, 0); err != nil || p.NowMs != 3_000 {
		t.Fatalf("pull at %d (%v); want its earliest page's 3000", p.NowMs, err)
	}
	s.nows = []int64{9_500}
	if _, err := c.Push(ctx, acctRound, push, nil); err != nil {
		t.Fatal(err)
	}
	s.nows = []int64{10_000, 0, 7_000}
	if p, err := c.PullSince(ctx, acctRound, 0); err != nil || p.NowMs != 0 {
		t.Fatalf("pull with a page without now_ms at %d (%v); want none", p.NowMs, err)
	}
	s.nows = []int64{0}
	if _, err := c.Push(ctx, acctRound, push, nil); err != nil {
		t.Fatal(err)
	}
	s.nows = []int64{0}
	if _, err := c.Push(ctx, acctRound, push, nil); err != nil {
		t.Fatal(err)
	}
	want := []int64{0, 9_000 + 120_000, 7_000 + 120_000, 0}
	if !slices.Equal(s.notAfters, want) {
		t.Fatalf("not_after of the pushes %v; want %v: none, the newest now_ms seen plus 120000, again after a page without, and none after a push answered without", s.notAfters, want)
	}
}

// A dispatch provably wrote nothing when it is refused (4xx: told at once,
// even when the answer's body is cut short) or fails before it had a
// connection; a canceled push doesn't prepare. One that had a connection
// and lost it proves nothing.
func TestAPushHearsOfWhatProvablyWroteNothing(t *testing.T) {
	cut := func(status int) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/v1/auth/refresh" {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"account_id": "acct", "access_token": token("a1", 9), "access_expires_in": 3600, "refresh_token": token("r1", 9), "refresh_expires_in": 1})
				return
			}
			_, _ = io.ReadAll(r.Body)
			conn, buf, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			if status != 0 {
				_, _ = fmt.Fprintf(buf, "HTTP/1.1 %d Refused\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"err", status)
				_ = buf.Flush()
			}
			_ = conn.Close()
		}
	}
	client := func(h http.Handler) *Client {
		srv := httptest.NewServer(h)
		t.Cleanup(srv.Close)
		store := &memStore{}
		store.raw, _ = json.Marshal(stored{RefreshToken: token("r1", 1), Session: Session{AccountID: "acct"}})
		c := New(srv.URL, "linux", store, srv.Client())
		c.now = func() time.Time { return time.Unix(1_800_000_000, 0) }
		return c
	}
	push := changes([]Change{{Collection: "hosts", ID: "00000000-0000-4000-8000-000000000001", Body: HostBody{Host: "x", Username: "u"}}})
	heard := func(c *Client, ctx context.Context) int {
		n := 0
		_, _ = c.Push(ctx, acctRound, push, func() error { n++; return nil })
		return n
	}
	if n := heard(client(cut(http.StatusForbidden)), context.Background()); n != 1 {
		t.Fatalf("a refusal cut in its body was heard %d times; want once", n)
	}
	if n := heard(client(cut(0)), context.Background()); n != 0 {
		t.Fatalf("a request lost after its connection was heard %d times; want none", n)
	}
	down := client(cut(0))
	if _, err := down.AccessToken(context.Background()); err != nil {
		t.Fatal(err)
	}
	down.service = "http://127.0.0.1:1"
	if n := heard(down, context.Background()); n != 1 {
		t.Fatalf("a request that never connected was heard %d times; want once", n)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	prepared := false
	_, err := down.Push(canceled, acctRound, func(int64) ([]Change, error) { prepared = true; return nil, nil }, nil)
	if !errors.Is(err, context.Canceled) || prepared {
		t.Fatalf("a canceled push: %v, prepared %v; want it stopped before prepare", err, prepared)
	}
}

// A push whose session ends while its prepare runs (a sign-out after a
// wait on a lock) is not dispatched, and wrote nothing.
func TestAPushWhoseSessionEndedDuringPrepareIsNotSent(t *testing.T) {
	s := &syncService{items: []Item{hostItem(1, "a", false)}}
	c := syncClient(t, s)
	heard := 0
	_, err := c.Push(context.Background(), acctRound, func(int64) ([]Change, error) {
		if err := c.forget(); err != nil {
			t.Fatal(err)
		}
		return []Change{{Collection: "hosts", ID: "00000000-0000-4000-8000-000000000001", Body: HostBody{Host: "x", Username: "u"}}}, nil
	}, func() error { heard++; return nil })
	if !errors.Is(err, ErrAccountChanged) || heard != 1 || len(s.pushes) != 0 {
		t.Fatalf("%v, heard %d, %d pushes; want it abandoned unsent, heard once", err, heard, len(s.pushes))
	}
}

// The hosts body carries the allowlist alone: a pushed host never holds a
// key path, a key or a password.
func TestPushedHostsCarryOnlyTheAllowlist(t *testing.T) {
	s := &syncService{items: []Item{hostItem(1, "a", false)}}
	c := syncClient(t, s)
	_, err := c.Push(context.Background(), acctRound, changes([]Change{{Collection: "hosts", ID: "00000000-0000-4000-8000-000000000001", Body: HostBody{Host: "pi", Port: 22, Username: "root", AuthKind: "key"}}}), nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(s.pushes[0])
	text := string(raw)
	for _, bad := range []string{"keyPath", "key_path", "-----BEGIN", "ssh-ed25519", "password\":"} {
		if strings.Contains(text, bad) {
			t.Fatalf("push carries %q: %s", bad, text)
		}
	}
	body := s.pushes[0][0]["body"].(map[string]any)
	for k := range body {
		switch k {
		case "nickname", "host", "port", "username", "auth_kind", "label":
		default:
			t.Fatalf("field %q outside the hosts allowlist", k)
		}
	}
}

// An access token the service stops taking before its time (refreshed in
// another request, or the session revoked) is dropped and the call retried
// once with a fresh one, not reported as a failure.
func TestASyncCallRetriesOnceWithAFreshAccessToken(t *testing.T) {
	var mu sync.Mutex
	n, seen := 0, []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/auth/refresh" {
			n++
			_ = json.NewEncoder(w).Encode(map[string]any{"account_id": "acct", "access_token": token("a1", 10+n), "access_expires_in": 3600, "refresh_token": token("r1", 10+n), "refresh_expires_in": 1})
			return
		}
		seen = append(seen, r.Header.Get("Authorization"))
		if len(seen) == 1 {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"invalid_token"}`))
			return
		}
		_, _ = w.Write([]byte(`{"rev":0,"changes":[],"more":false}`))
	}))
	defer srv.Close()
	store := &memStore{}
	store.raw, _ = json.Marshal(stored{RefreshToken: token("r1", 1), Session: Session{AccountID: "acct"}})
	c := New(srv.URL, "linux", store, srv.Client())
	if _, err := c.PullSince(context.Background(), acctRound, 0); err != nil {
		t.Fatalf("pull after a refused access token: %v", err)
	}
	if len(seen) != 2 || seen[0] == seen[1] || n != 2 {
		t.Fatalf("auth headers %v after %d refreshes; want a retry with a new token", seen, n)
	}
}

// #257 review: sync work planned for one account never reaches another. Once
// the signed-in account is another one, its requests carry no token.
func TestSyncRequestsAreBoundToTheirAccount(t *testing.T) {
	s := &syncService{items: []Item{hostItem(1, "a", false)}}
	c := syncClient(t, s)
	ctx := context.Background()
	if _, err := c.PullSince(ctx, acctRound, 0); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	c.saved = &stored{RefreshToken: token("r1", 5), Session: Session{AccountID: "acct-b"}}
	c.mu.Unlock()
	before := len(s.auth)
	if _, err := c.Push(ctx, acctRound, changes([]Change{{Collection: "hosts", ID: "00000000-0000-4000-8000-000000000001", Body: HostBody{Host: "x", Username: "u"}}}), nil); !errors.Is(err, ErrAccountChanged) {
		t.Fatalf("push for the old account: %v; want ErrAccountChanged", err)
	}
	if len(s.auth) != before || len(s.pushes) != 0 {
		t.Fatalf("the old account's push reached the service (%d calls, %d pushes)", len(s.auth)-before, len(s.pushes))
	}
}

// signInAgain signs c out and in again to the same account (a real
// sign-out and handoff): another session.
func signInAgain(t *testing.T, c *Client) {
	t.Helper()
	_ = c.SignOut(context.Background())
	if _, err := c.StartSignIn(Google); err != nil {
		t.Fatal(err)
	}
	if _, err := c.FinishSignIn(context.Background(), strings.Repeat("c", 43)); err != nil {
		t.Fatal(err)
	}
}

// #390 r7, #359 r11: a push bound to a session (Round) is not sent once
// that session ended, though the same account signed in again: not after
// its prepare (the sign-in came while it prepared), and not as the replay
// of a dispatch refused for its credential (the sign-in came once that
// refusal was read). A refreshed credential is the same session.
func TestAPushStaysInTheSessionItBeganIn(t *testing.T) {
	push := []Change{{Collection: "hosts", ID: "00000000-0000-4000-8000-000000000001", Body: HostBody{Host: "x", Username: "u"}}}
	s := &syncService{items: []Item{hostItem(1, "a", false)}}
	c := syncClient(t, s)
	r, ok, err := c.Round()
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	heard := 0
	_, err = c.Push(context.Background(), r, func(int64) ([]Change, error) {
		if heard == 0 {
			signInAgain(t, c)
		}
		return push, nil
	}, func() error { heard++; return nil })
	if !errors.Is(err, ErrAccountChanged) || heard != 1 || s.posted != 0 {
		t.Fatalf("%v, heard %d, %d dispatched; want it abandoned unsent after its prepare", err, heard, s.posted)
	}

	r, _, _ = c.Round()
	s.mu.Lock()
	s.unauthorizeNext = true
	s.mu.Unlock()
	heard = 0
	_, err = c.Push(context.Background(), r, changes(push), func() error {
		heard++
		signInAgain(t, c)
		return nil
	})
	if !errors.Is(err, ErrAccountChanged) || heard != 1 || len(s.pushes) != 0 {
		t.Fatalf("%v, heard %d, %d pushes; want the refused push not replayed in the new session", err, heard, len(s.pushes))
	}

	r, _, _ = c.Round()
	s.mu.Lock()
	s.unauthorizeNext = true
	s.mu.Unlock()
	if _, err := c.Push(context.Background(), r, changes(push), nil); err != nil || len(s.pushes) != 1 {
		t.Fatalf("%v, %d pushes; want the replay with a refreshed credential sent", err, len(s.pushes))
	}
}

// #359 r13: once prepare has journaled its sends, every way the request
// ends before it is handed over wrote nothing, and says so once: the round
// ending right after prepare, or a body that can't be encoded.
func TestAPushThatNeverWentOutWroteNothing(t *testing.T) {
	s := &syncService{items: []Item{hostItem(1, "a", false)}}
	c := syncClient(t, s)
	push := []Change{{Collection: "hosts", ID: "00000000-0000-4000-8000-000000000001", Body: HostBody{Host: "x", Username: "u"}}}
	ctx, cancel := context.WithCancel(context.Background())
	heard := 0
	_, err := c.Push(ctx, acctRound, func(int64) ([]Change, error) { cancel(); return push, nil }, func() error { heard++; return nil })
	if !errors.Is(err, context.Canceled) || heard != 1 || s.posted != 0 {
		t.Fatalf("a push whose round ended after prepare: %v, heard %d, %d sent; want it unsent, heard once", err, heard, s.posted)
	}
	heard = 0
	_, err = c.Push(context.Background(), acctRound, changes([]Change{{Collection: "hosts", ID: push[0].ID, Body: make(chan int)}}), func() error { heard++; return nil })
	if err == nil || heard != 1 || s.posted != 0 {
		t.Fatalf("a push that couldn't be encoded: %v, heard %d, %d sent; want it unsent, heard once", err, heard, s.posted)
	}
}

// acctRound is any session of the test account "acct" (Round, unpinned).
var acctRound = Round{Account: "acct"}

// changes is a Push prepare that sends cs at every dispatch.
func changes(cs []Change) func(int64) ([]Change, error) {
	return func(int64) ([]Change, error) { return cs, nil }
}

// Each batch is a push the service takes: ≤100 changes and a request body,
// as Push encodes it (HTML-escaped by json.Marshal), of ≤256 KiB; together
// they are the changes in order.
func TestBatchesFitThePushLimits(t *testing.T) {
	var changes []Change
	for i := range 150 {
		text := strings.Repeat("x", 100)
		if i%3 == 0 {
			text = strings.Repeat("<", 2000) // 6 bytes each once escaped
		}
		changes = append(changes, Change{Collection: "prompts", ID: strconv.Itoa(i), Body: PromptBody{Text: text}})
	}
	batches, err := Batches(changes)
	if err != nil {
		t.Fatal(err)
	}
	var joined []Change
	for _, b := range batches {
		raw, _ := json.Marshal(map[string]any{"changes": b})
		if len(b) == 0 || len(b) > MaxPushChanges || len(raw) > MaxPushBytes {
			t.Fatalf("a batch of %d changes, %d bytes", len(b), len(raw))
		}
		joined = append(joined, b...)
	}
	if len(batches) < 2 || len(joined) != len(changes) || joined[0].ID != "0" || joined[149].ID != "149" {
		t.Fatalf("%d batches holding %d changes", len(batches), len(joined))
	}
}

// The item limit is on the body as the service stores it: 8 KB of text can
// take twice that once its quotes are escaped.
func TestValidPromptMeasuresTheStoredBody(t *testing.T) {
	if !ValidPrompt(PromptBody{Text: strings.Repeat("<", 8192)}) {
		t.Fatal("8 KB of < (stored unescaped) refused")
	}
	if ValidPrompt(PromptBody{Text: "x" + strings.Repeat(`"`, 8191)}) {
		t.Fatal("a prompt whose stored body passes 16 KiB accepted")
	}
}
