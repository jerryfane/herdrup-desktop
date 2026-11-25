package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

const hostA = "AAAAAAAAAAAAAAAAAAAAAA"

// lead is the minLeft a client asks with (DESIGN §3.3: "less than 2
// minutes remain"); the cache itself has no lead.
const lead = 2 * time.Minute

// statementService answers POST /v1/statements as statements.ts does: one
// statement per host asked for, exp 600 s after now, each a new jws. It
// counts the requests.
func statementService(t *testing.T, f *fakeService, now *time.Time) (asked func() int) {
	n := 0
	f.extra = func(w http.ResponseWriter, r *http.Request, _ map[string]string) bool {
		if r.URL.Path != "/v1/statements" || r.Method != http.MethodPost {
			return false
		}
		if r.Header.Get("Authorization") == "" {
			t.Errorf("a statement asked for without the access token")
		}
		var body struct {
			Hosts []string `json:"hosts"`
		}
		if err := json.Unmarshal(f.raw, &body); err != nil {
			reply(w, 400, map[string]string{"error": "bad_request"})
			return true
		}
		n++
		var out []map[string]string
		for _, h := range body.Hosts {
			out = append(out, map[string]string{"host": h, "jws": h + ".jws." + strings.Repeat("x", n)})
		}
		reply(w, 200, map[string]any{"statements": out, "exp": now.Unix() + 600})
		return true
	}
	return func() int {
		f.mu.Lock()
		defer f.mu.Unlock()
		return n
	}
}

// The cache asks for one host and gives its jws with the answer's absolute
// exp; the service's refusal comes back as it is.
func TestStatementCacheAsksForTheHost(t *testing.T) {
	f, c, _, now := signedIn(t)
	statementService(t, f, now)
	got, err := NewStatementCache(c).Get(context.Background(), hostA, lead)
	if err != nil || got.JWS != hostA+".jws.x" || !got.Exp.Equal(now.Add(600*time.Second)) {
		t.Fatalf("statement %+v, %v", got, err)
	}
	f.extra = func(w http.ResponseWriter, r *http.Request, _ map[string]string) bool {
		reply(w, 403, map[string]string{"error": "device_removed"})
		return true
	}
	var api *APIError
	if _, err := NewStatementCache(c).Get(context.Background(), hostA, lead); !errors.As(err, &api) || api.Code != "device_removed" {
		t.Fatalf("a removed device: %v", err)
	}
}

// The cache reuses a host's statement while at least the time asked for is
// left, and asks again with less (DESIGN §3.3: under 2 minutes).
func TestStatementCacheRefreshesWithLessThanTwoMinutesLeft(t *testing.T) {
	f, c, _, now := signedIn(t)
	asked := statementService(t, f, now)
	cache := NewStatementCache(c)
	ctx := context.Background()
	first, err := cache.Get(ctx, hostA, lead)
	if err != nil || asked() != 1 {
		t.Fatalf("first: %+v, %v, asked %d", first, err, asked())
	}
	*now = first.Exp.Add(-lead) // exactly 2 minutes left: still good
	if again, err := cache.Get(ctx, hostA, lead); err != nil || again != first || asked() != 1 {
		t.Fatalf("with 2 minutes left: %+v, %v, asked %d; want the same statement", again, err, asked())
	}
	*now = now.Add(time.Second) // under 2 minutes left
	fresh, err := cache.Get(ctx, hostA, lead)
	if err != nil || fresh == first || asked() != 2 || !fresh.Exp.Equal(now.Add(600*time.Second)) {
		t.Fatalf("with under 2 minutes left: %+v, %v, asked %d; want a new statement", fresh, err, asked())
	}
}

// A sign-out drops the cache: nothing signed is given after it.
func TestStatementCacheIsTheSessions(t *testing.T) {
	f, c, _, now := signedIn(t)
	asked := statementService(t, f, now)
	cache := NewStatementCache(c)
	if _, err := cache.Get(context.Background(), hostA, lead); err != nil {
		t.Fatal(err)
	}
	if err := c.SignOut(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.Get(context.Background(), hostA, lead); !errors.Is(err, ErrSignedOut) || asked() != 1 {
		t.Fatalf("after a sign-out: %v, asked %d", err, asked())
	}
}

// A statement is live while the sign-in it was issued in is the current
// one; a refused one dropped is asked for again, another one dropped is
// not.
func TestStatementCacheLiveAndDrop(t *testing.T) {
	f, c, _, now := signedIn(t)
	asked := statementService(t, f, now)
	cache := NewStatementCache(c)
	ctx := context.Background()
	first, err := cache.Get(ctx, hostA, lead)
	if err != nil || !cache.Live(first) {
		t.Fatalf("first: %+v, %v, live %v", first, err, cache.Live(first))
	}
	cache.Drop(hostA, "another")
	if again, err := cache.Get(ctx, hostA, lead); err != nil || again != first || asked() != 1 {
		t.Fatalf("after dropping another: %+v, %v, asked %d", again, err, asked())
	}
	cache.Drop(hostA, first.JWS)
	if fresh, err := cache.Get(ctx, hostA, lead); err != nil || fresh.JWS == first.JWS || asked() != 2 {
		t.Fatalf("after dropping it: %+v, %v, asked %d", fresh, err, asked())
	}
	if err := c.SignOut(ctx); err != nil {
		t.Fatal(err)
	}
	if cache.Live(first) {
		t.Fatal("a statement of a session that ended is live")
	}
}
