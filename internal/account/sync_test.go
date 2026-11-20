package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
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
}

func (s *syncService) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	reply := func(status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}
	if r.URL.Path == "/v1/auth/refresh" {
		reply(200, map[string]any{"account_id": "acct", "access_token": token("a1", 9), "access_expires_in": 3600, "refresh_token": token("r1", 9), "refresh_expires_in": 1})
		return
	}
	s.auth = append(s.auth, r.Header.Get("Authorization"))
	if r.Method == http.MethodPost {
		var body struct{ Changes []map[string]any }
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.pushes = append(s.pushes, body.Changes)
		reply(200, map[string]any{"rev": 99, "applied": []any{}, "conflicts": []any{}})
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
	out := map[string]any{"rev": last, "changes": page, "more": more}
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
	p, err := c.PullSince(ctx, "acct", 0)
	if err != nil || !p.Full || p.Rev != 5 || len(p.Items) != 5 {
		t.Fatalf("full pull: %+v, %v", p, err)
	}
	p, err = c.PullSince(ctx, "acct", 3)
	if err != nil || p.Full || len(p.Items) != 2 || !p.Items[0].Deleted {
		t.Fatalf("incremental: %+v, %v", p, err)
	}
	s.mu.Lock()
	s.floor = 4
	s.mu.Unlock()
	p, err = c.PullSince(ctx, "acct", 3)
	if err != nil || !p.Full || len(p.Items) != 5 {
		t.Fatalf("after a prune: %+v, %v; want a full pull", p, err)
	}
	for _, a := range s.auth {
		if !strings.HasPrefix(a, "Bearer a1.") {
			t.Fatalf("sync call without the access token: %q", a)
		}
	}
}

// The hosts body carries the allowlist alone: a pushed host never holds a
// key path, a key or a password.
func TestPushedHostsCarryOnlyTheAllowlist(t *testing.T) {
	s := &syncService{items: []Item{hostItem(1, "a", false)}}
	c := syncClient(t, s)
	_, err := c.Push(context.Background(), "acct", []Change{{Collection: "hosts", ID: "00000000-0000-4000-8000-000000000001", Body: HostBody{Host: "pi", Port: 22, Username: "root", AuthKind: "key"}}})
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
	if _, err := c.PullSince(context.Background(), "acct", 0); err != nil {
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
	if _, err := c.PullSince(ctx, "acct", 0); err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	c.saved = &stored{RefreshToken: token("r1", 5), Session: Session{AccountID: "acct-b"}}
	c.mu.Unlock()
	before := len(s.auth)
	if _, err := c.Push(ctx, "acct", []Change{{Collection: "hosts", ID: "00000000-0000-4000-8000-000000000001", Body: HostBody{Host: "x", Username: "u"}}}); !errors.Is(err, ErrAccountChanged) {
		t.Fatalf("push for the old account: %v; want ErrAccountChanged", err)
	}
	if len(s.auth) != before || len(s.pushes) != 0 {
		t.Fatalf("the old account's push reached the service (%d calls, %d pushes)", len(s.auth)-before, len(s.pushes))
	}
}
