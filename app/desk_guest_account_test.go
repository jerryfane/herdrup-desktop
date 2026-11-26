package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/account"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/guest"
)

// rolloverService is the account service for one signed-in account,
// "acct": its sign-in refresh, and statements, each request issuing new
// ones, "acct.<n>.<host>", 600 s long. requests counts the statement
// requests.
type rolloverService struct {
	mu       sync.Mutex
	n        int
	requests int
}

func (s *rolloverService) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	reply := func(v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	switch r.URL.Path {
	case "/v1/auth/refresh":
		s.n++
		reply(map[string]any{"account_id": "acct", "access_token": fmt.Sprintf("a1.%022d.%043d", 1, s.n), "access_expires_in": 3600,
			"refresh_token": fmt.Sprintf("r1.%022d.%043d", 1, s.n), "refresh_expires_in": 1})
	case "/v1/statements":
		var body struct {
			Hosts []string `json:"hosts"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		s.requests++
		var out []map[string]string
		for _, h := range body.Hosts {
			out = append(out, map[string]string{"host": h, "jws": fmt.Sprintf("acct.%d.%s", s.requests, h)})
		}
		reply(map[string]any{"statements": out, "exp": time.Now().Unix() + 600})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (s *rolloverService) asked() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.requests
}

// After the account's signing key rolled over, the host refuses the
// statement the cache holds: through the production cache and the desk's
// statement source, a redemption, and then a saved share's returning hello,
// drop that statement and go once more with a new one from a second
// request, and are admitted (herdr leaves the invitation unused on a
// statement refusal).
func TestAStatementTheHostRefusedIsAskedForAgain(t *testing.T) {
	service := &rolloverService{}
	srv := httptest.NewServer(http.HandlerFunc(service.serve))
	t.Cleanup(srv.Close)
	relay, err := fakeherdr.NewGuestRelay()
	if err != nil {
		t.Fatal(err)
	}
	relay.TerminalID, relay.AgentName = "t2", "docs"
	relay.OwnerName, relay.MachineLabel, relay.GuestName = "Jerry", "studio", "visitor"
	relay.Accounts = true
	// The statements the host still verifies: from the validFrom-th on.
	var mu sync.Mutex
	validFrom := 2
	relay.CheckStatement = func(jws string) (string, time.Time, string) {
		parts := strings.Split(jws, ".")
		if len(parts) != 3 {
			return "", time.Time{}, "statement_invalid"
		}
		n, err := strconv.Atoi(parts[1])
		mu.Lock()
		defer mu.Unlock()
		if err != nil || n < validFrom {
			return "", time.Time{}, "statement_invalid"
		}
		return parts[0], time.Now().Add(600 * time.Second), ""
	}
	relay.Handle = func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
		return map[string]any{"type": "agent_list", "agents": []any{}}, nil
	}
	base, err := relay.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = relay.Close() })

	d := newDesk(t.TempDir())
	signInTo(d, srv, "acct")
	d.statements = account.NewStatementCache(d.account)
	identity, err := guest.LoadIdentity(filepath.Join(t.TempDir(), "identity"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	invite, err := guest.Resolve(ctx, relay.InviteLink(base, time.Now().Add(time.Hour)), time.Now(), d.inviteTransport)
	if err != nil {
		t.Fatal(err)
	}
	access, err := guest.Accept(ctx, invite, identity, "Desktop", time.Now(), d.guestStatements())
	host := relay.HostID()
	if err != nil || !access.AccountBound || relay.Bound() != "acct" {
		t.Fatalf("redemption after a rollover: %+v, %v", access, err)
	}
	if hellos := relay.Hellos(); !slices.Equal(hellos, []string{"acct.1." + host, "acct.2." + host}) || service.asked() != 2 {
		t.Fatalf("hellos %q, statement requests %d; want the refused statement, then a new one", hellos, service.asked())
	}

	// Another rollover: the saved share's held statement is refused too.
	mu.Lock()
	validFrom = 3
	mu.Unlock()
	transport := guest.NewTransport(access, identity, guest.SystemClock, d.guestStatements(), nil)
	t.Cleanup(func() { _ = transport.Close() })
	var reply map[string]any
	if err := transport.Call(ctx, "agent.list", nil, &reply); err != nil {
		t.Fatalf("a saved share after a rollover: %v", err)
	}
	if hellos := relay.Hellos(); !slices.Equal(hellos[2:], []string{"acct.2." + host, "acct.3." + host}) || service.asked() != 3 {
		t.Fatalf("hellos %q, statement requests %d; want the refused statement, then a new one", hellos, service.asked())
	}
}
