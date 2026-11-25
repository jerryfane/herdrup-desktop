package guest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// fakeStatements is the account service's statements as the account's
// StatementCache gives them, on clock: a host's statement is reused while it
// has at least the time asked for left, and a new one, 600 s long, issued
// otherwise. Its statements are "<account>.<n>.<host>", each live while the
// sign-in it was issued in is the current one (switchTo starts another, and
// drops the held ones). Signed out (account ""), it gives ErrAccountRequired.
type fakeStatements struct {
	clock *stepClock

	mu      sync.Mutex
	account string
	signIn  int
	n       int
	held    map[string]heldStatement
	exps    map[string]time.Time
	hosts   []string
	// onAsk, when set, runs once inside the next ask, after its statement
	// is issued (a switch while it was asked for); onDrop once inside the
	// next Drop.
	onAsk, onDrop func()
}

type heldStatement struct {
	jws string
	exp time.Time
}

func newFakeStatements(clock *stepClock, account string) *fakeStatements {
	f := &fakeStatements{clock: clock, exps: map[string]time.Time{}}
	f.switchTo(account)
	return f
}

// switchTo is another sign-in, to account ("" signed out): the statements
// of the one before are no longer live.
func (f *fakeStatements) switchTo(account string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.account, f.signIn, f.held = account, f.signIn+1, map[string]heldStatement{}
}

func (f *fakeStatements) Statement(_ context.Context, host string, minLeft time.Duration) (Statement, error) {
	f.mu.Lock()
	f.hosts = append(f.hosts, host)
	if f.account == "" {
		f.mu.Unlock()
		return Statement{}, ErrAccountRequired
	}
	now := f.clock.Now()
	h, ok := f.held[host]
	if !ok || h.exp.Sub(now) < minLeft {
		f.n++
		h = heldStatement{jws: fmt.Sprintf("%s.%d.%s", f.account, f.n, host), exp: now.Add(600 * time.Second)}
		f.held[host], f.exps[h.jws] = h, h.exp
	}
	signIn, hook := f.signIn, f.onAsk
	f.onAsk = nil
	f.mu.Unlock()
	if hook != nil {
		hook()
	}
	live := func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.signIn == signIn
	}
	return Statement{JWS: h.jws, Exp: h.exp, Live: live}, nil
}

func (f *fakeStatements) Drop(host, jws string) {
	f.mu.Lock()
	if f.held[host].jws == jws {
		delete(f.held, host)
	}
	hook := f.onDrop
	f.onDrop = nil
	f.mu.Unlock()
	if hook != nil {
		hook()
	}
}

func (f *fakeStatements) asked() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.hosts)
}

// accountHost is a guest of a fakeherdr relay whose host takes accounts
// (relay.Accounts unless plain): its statements are checked by their
// account (the jws's first part) and expiry. refuse, when set, is the code
// every statement is refused with, and refuseOnce the next one's.
type accountHost struct {
	relay      *fakeherdr.GuestRelay
	clock      *stepClock
	statements *fakeStatements
	base       string
	identity   Identity
	now        time.Time

	mu                 sync.Mutex
	refuse, refuseOnce string
}

func newAccountHost(t *testing.T, accounts bool) *accountHost {
	t.Helper()
	relay, err := fakeherdr.NewGuestRelay()
	if err != nil {
		t.Fatal(err)
	}
	clock := &stepClock{now: time.Unix(1_000_000, 0)}
	h := &accountHost{relay: relay, clock: clock, statements: newFakeStatements(clock, "acct"), now: time.Now()}
	relay.TerminalID, relay.AgentName = "t1", "worker"
	relay.OwnerName, relay.MachineLabel, relay.GuestName = "Owner", "Machine", "visitor"
	relay.MultiRequest = true
	relay.Accounts = accounts
	relay.CheckStatement = func(jws string) (string, time.Time, string) {
		h.mu.Lock()
		refuse := h.refuse
		if h.refuseOnce != "" {
			refuse, h.refuseOnce = h.refuseOnce, ""
		}
		h.mu.Unlock()
		if refuse != "" {
			return "", time.Time{}, refuse
		}
		account, rest, ok := strings.Cut(jws, ".")
		if !ok || !strings.HasSuffix(rest, "."+relay.HostID()) {
			return "", time.Time{}, "statement_invalid"
		}
		h.statements.mu.Lock()
		exp, known := h.statements.exps[jws]
		h.statements.mu.Unlock()
		if !known {
			exp = h.clock.Now().Add(600 * time.Second)
		}
		return account, exp, ""
	}
	relay.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
		if method == "agent.list" {
			return map[string]any{"type": "agent_list", "agents": []any{map[string]any{
				"terminal_id": "t1", "pane_id": "p1", "name": "worker", "agent": "omp", "agent_status": "idle",
			}}}, nil
		}
		return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
	}
	// A stream runs until its session ends, or the test does.
	done := make(chan struct{})
	relay.Streams = map[string]fakeherdr.StreamFunc{"pane.stream": func(ctx context.Context, id string, _ json.RawMessage, emit func([]byte) error) {
		_ = emit([]byte(`{"id":"` + id + `","result":{"type":"pane_stream_started"}}`))
		select {
		case <-ctx.Done():
		case <-done:
		}
	}}
	h.base, err = relay.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = relay.Close() })
	t.Cleanup(func() { close(done) })
	if h.identity, err = LoadIdentity(filepath.Join(t.TempDir(), "identity")); err != nil {
		t.Fatal(err)
	}
	return h
}

func (h *accountHost) invite(t *testing.T) Invite {
	t.Helper()
	invite, err := parse(h.relay.InviteLink(h.base, h.now.Add(time.Hour)), h.now)
	if err != nil {
		t.Fatal(err)
	}
	return invite
}

// accept redeems the invitation, binding it with bind when not nil.
func (h *accountHost) accept(t *testing.T, bind StatementSource) Access {
	t.Helper()
	access, err := Accept(context.Background(), h.invite(t), h.identity, "Desktop", h.now, bind)
	if err != nil {
		t.Fatal(err)
	}
	return access
}

func (h *accountHost) transport(t *testing.T, access Access, statements StatementSource) *Transport {
	t.Helper()
	transport := NewTransport(access, h.identity, h.clock, statements)
	t.Cleanup(func() { _ = transport.Close() })
	return transport
}

func list(transport *Transport) error {
	var reply map[string]any
	return transport.Call(context.Background(), "agent.list", nil, &reply)
}

// An invitation from a host that takes accounts, redeemed with a choice to
// bind: the redemption hello carries the account's statement for the host
// (as the service names it, base64url), the share is bound, and its
// returning hellos carry a statement too.
func TestABoundShareSendsItsStatementInEveryHello(t *testing.T) {
	h := newAccountHost(t, true)
	if !h.invite(t).Account {
		t.Fatal("the invitation does not offer accounts")
	}
	access := h.accept(t, h.statements)
	host := h.relay.HostID()
	if hellos := h.relay.Hellos(); !access.AccountBound || len(hellos) != 1 || hellos[0] != "acct.1."+host || h.relay.Bound() != "acct" {
		t.Fatalf("bound %v, hellos %q, bound to %q; want the redemption bound with acct's statement", access.AccountBound, hellos, h.relay.Bound())
	}
	transport := h.transport(t, access, h.statements)
	if err := list(transport); err != nil {
		t.Fatal(err)
	}
	if hellos := h.relay.Hellos(); len(hellos) != 2 || hellos[1] != "acct.1."+host {
		t.Fatalf("hellos %q; want the returning hello with the statement", hellos)
	}
	// Saved and loaded, the share stays bound.
	raw, _ := json.Marshal(access)
	var loaded Access
	if err := json.Unmarshal(raw, &loaded); err != nil || !loaded.AccountBound || !strings.Contains(string(raw), `"accountBound":true`) {
		t.Fatalf("saved %s: %+v, %v", raw, loaded, err)
	}
}

// Without the choice to bind, with an invitation that does not offer
// accounts, or with a share that is not bound, no hello carries a statement
// and none is asked for: old invitations and plain shares are as before.
func TestAPlainShareSendsNoStatement(t *testing.T) {
	for _, c := range []struct {
		name     string
		accounts bool
		bind     bool
	}{{"an old invitation, with the choice to bind", false, true}, {"an invitation offering accounts, without", true, false}} {
		t.Run(c.name, func(t *testing.T) {
			h := newAccountHost(t, c.accounts)
			var bind StatementSource
			if c.bind {
				bind = h.statements
			}
			access := h.accept(t, bind)
			if err := list(h.transport(t, access, h.statements)); err != nil {
				t.Fatal(err)
			}
			if hellos := h.relay.Hellos(); access.AccountBound || len(hellos) != 2 || hellos[0] != "" || hellos[1] != "" || h.statements.asked() != 0 {
				t.Fatalf("bound %v, hellos %q, statements asked %d; want plain hellos and none asked", access.AccountBound, hellos, h.statements.asked())
			}
		})
	}
}

// A bound share's returning hello needs a statement for its account: none
// to give is ErrAccountRequired before any connect, and another account's
// is herdr's account_mismatch.
func TestABoundShareRefusesAnotherAccount(t *testing.T) {
	h := newAccountHost(t, true)
	access := h.accept(t, h.statements)
	if err := list(h.transport(t, access, nil)); !errors.Is(err, ErrAccountRequired) || len(h.relay.Hellos()) != 1 {
		t.Fatalf("no statements: %v, hellos %q", err, h.relay.Hellos())
	}
	other := newFakeStatements(h.clock, "other")
	if err := list(h.transport(t, access, other)); !errors.Is(err, ErrAccountMismatch) {
		t.Fatalf("another account: %v", err)
	}
}

// waiters is how many sleepers the clock holds.
func (c *stepClock) waiting() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.waiters)
}

// A bound session sends a fresh statement in band once less than 2 minutes
// of its own are left, before herdr's deadline (exp + 60 s), and again for
// the next: on the clock, not on time.
func TestABoundSessionRefreshesItsStatementBeforeItExpires(t *testing.T) {
	h := newAccountHost(t, true)
	access := h.accept(t, h.statements)
	transport := h.transport(t, access, h.statements)
	stream, err := transport.OpenStream(context.Background(), "pane.stream", map[string]string{"pane_id": "p1"})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	if _, err := stream.Next(); err != nil {
		t.Fatal(err)
	}
	host := h.relay.HostID()
	for n, want := range []string{"acct.2." + host, "acct.3." + host} {
		// The refresh sleeps until 2 minutes before its statement's exp.
		eventually(t, "the refresh to wait", func() bool { return h.clock.waiting() == 1 })
		// DESIGN §3.3's 2 minutes, not the constant under test.
		h.clock.advance(600*time.Second - 2*time.Minute - time.Second)
		if h.clock.waiting() != 1 || len(h.relay.Refreshes()) != n {
			t.Fatalf("refresh %d: with more than 2 minutes left, refreshes %q", n+1, h.relay.Refreshes())
		}
		h.clock.advance(time.Second)
		eventually(t, "the refresh", func() bool { return len(h.relay.Refreshes()) == n+1 })
		if got := h.relay.Refreshes()[n]; got != want {
			t.Fatalf("refresh %d sent %q, want %q", n+1, got, want)
		}
	}
}

// A refresh herdr refuses ends the session with its code, which the stream
// reads as that refusal.
func TestARefusedRefreshEndsTheSessionWithItsCode(t *testing.T) {
	h := newAccountHost(t, true)
	access := h.accept(t, h.statements)
	transport := h.transport(t, access, h.statements)
	stream, err := transport.OpenStream(context.Background(), "pane.stream", map[string]string{"pane_id": "p1"})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	if _, err := stream.Next(); err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	h.refuse = "device_removed"
	h.mu.Unlock()
	eventually(t, "the refresh to wait", func() bool { return h.clock.waiting() == 1 })
	h.clock.advance(600*time.Second - 2*time.Minute)
	if _, err := stream.Next(); !errors.Is(err, ErrDeviceRemoved) {
		t.Fatalf("after a refused refresh: %v, want ErrDeviceRemoved", err)
	}
}

// Every account code herdr sends, at a hello or as a session's close
// reason, is its own error with its own words; other codes are as before.
// A statement_expired close, which herdr also sends when an owner's grant
// expires, says neither, and is still ErrStatementExpired.
func TestAccountRefusalsAreDistinct(t *testing.T) {
	codes := map[string]error{
		"account_required":   ErrAccountRequired,
		"account_mismatch":   ErrAccountMismatch,
		"statement_invalid":  ErrStatementInvalid,
		"statement_expired":  ErrStatementExpired,
		"account_keys_stale": ErrAccountKeysStale,
		"device_removed":     ErrDeviceRemoved,
		"accounts_disabled":  ErrAccountsDisabled,
	}
	seen := map[string]string{}
	for code, want := range codes {
		if got := refusal(code); got != want {
			t.Errorf("hello refusal %s: %v, want %v", code, got, want)
		}
		got := socketError(websocket.CloseError{Code: websocket.StatusNormalClosure, Reason: code})
		if code == "statement_expired" {
			if !errors.Is(got, ErrStatementExpired) || got.Error() != "The shared machine ended the connection when its authorization expired. Try again." {
				t.Errorf("close reason %s: %v", code, got)
			}
		} else if got != want {
			t.Errorf("close reason %s: %v, want %v", code, got, want)
		}
		if other, dup := seen[want.Error()]; dup {
			t.Errorf("%s and %s say the same: %q", code, other, want)
		}
		seen[want.Error()] = code
	}
	if ErrStatementExpired.Error() != "Your HerdrUp account check expired. Reconnect to continue." {
		t.Errorf("the statement_expired hello refusal says %q", ErrStatementExpired)
	}
	if ErrAccountRequired.Error() != "Sign in to the HerdrUp account that holds this share." ||
		ErrAccountMismatch.Error() != "This share belongs to another HerdrUp account. Sign in to that account to open it." {
		t.Errorf("account words: %q, %q", ErrAccountRequired, ErrAccountMismatch)
	}
	if refusal("revoked") != ErrRevoked || refusal("something_else").Error() != "The shared machine refused this guest connection." {
		t.Error("the other codes changed")
	}
	if got := socketError(websocket.CloseError{Code: websocket.StatusNormalClosure, Reason: "revoked"}); errors.Is(got, ErrRevoked) {
		t.Errorf("a non-account close reason: %v, want as before", got)
	}
}

// A redemption whose sign-in changes while its statement is asked for
// sends nothing: herdr would bind the invitation to the account of
// whichever statement it carried, for good.
func TestARedemptionWhoseSignInChangesSendsNothing(t *testing.T) {
	h := newAccountHost(t, true)
	h.statements.onAsk = func() { h.statements.switchTo("other") }
	_, err := Accept(context.Background(), h.invite(t), h.identity, "Desktop", h.now, h.statements)
	if !errors.Is(err, ErrAccountChanged) || err.Error() != "Your HerdrUp account changed; open the invite again" {
		t.Fatalf("redemption across a switch: %v, want ErrAccountChanged", err)
	}
	if hellos := h.relay.Hellos(); len(hellos) != 0 || h.relay.Bound() != "" {
		t.Fatalf("hellos %q, bound to %q; want nothing sent", hellos, h.relay.Bound())
	}
}

// A bound session's refreshes stay in the sign-in it was admitted in: one
// whose sign-in changes while its statement is asked for sends nothing,
// and the refreshing stops.
func TestABoundSessionsRefreshAfterASwitchSendsNothingAndStops(t *testing.T) {
	h := newAccountHost(t, true)
	access := h.accept(t, h.statements)
	ended := make(chan struct{}, 8)
	hear := func() { ended <- struct{}{} }
	refreshEnded.Store(&hear)
	t.Cleanup(func() { refreshEnded.Store(nil) })
	transport := h.transport(t, access, h.statements)
	stream, err := transport.OpenStream(context.Background(), "pane.stream", map[string]string{"pane_id": "p1"})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	if _, err := stream.Next(); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the refresh to wait", func() bool { return h.clock.waiting() == 1 })
	h.statements.onAsk = func() { h.statements.switchTo("other") }
	h.clock.advance(600*time.Second - 2*time.Minute)
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatalf("the refresh went on after the switch; refreshes %q", h.relay.Refreshes())
	}
	if refreshes := h.relay.Refreshes(); len(refreshes) != 0 {
		t.Fatalf("refreshes %q after the switch; want none", refreshes)
	}
}

// A returning hello refused for its statement goes once more with a fresh
// one, in the same sign-in; past a switch, the retry sends nothing and the
// share reads as another account's.
func TestARetryAfterASwitchIsAnotherAccountsShare(t *testing.T) {
	h := newAccountHost(t, true)
	access := h.accept(t, h.statements)
	host := h.relay.HostID()
	h.mu.Lock()
	h.refuseOnce = "statement_invalid"
	h.mu.Unlock()
	if err := list(h.transport(t, access, h.statements)); err != nil {
		t.Fatalf("a retry with a fresh statement: %v", err)
	}
	if hellos := h.relay.Hellos(); len(hellos) != 3 || hellos[1] != "acct.1."+host || hellos[2] != "acct.2."+host {
		t.Fatalf("hellos %q; want the refused statement, then a fresh one", hellos)
	}
	h.mu.Lock()
	h.refuseOnce = "statement_expired"
	h.mu.Unlock()
	h.statements.onDrop = func() { h.statements.switchTo("other") }
	asked := h.statements.asked()
	err := list(h.transport(t, access, h.statements))
	if !errors.Is(err, ErrAccountMismatch) || errors.Is(err, ErrAccountChanged) {
		t.Fatalf("a retry past a switch: %v, want ErrAccountMismatch", err)
	}
	if hellos := h.relay.Hellos(); len(hellos) != 4 || h.statements.asked() != asked+1 {
		t.Fatalf("hellos %q, statements asked %d more; want the refused hello alone", hellos, h.statements.asked()-asked)
	}
}

// Only one handshake and the session it admitted stay in a sign-in: a new
// connect after the sign-in ended and came back (a sign-out, then the same
// account again) goes out with the current sign-in's statement.
func TestAReconnectGoesUnderTheCurrentSignIn(t *testing.T) {
	h := newAccountHost(t, true)
	h.relay.MultiRequest = false // every request connects
	access := h.accept(t, h.statements)
	transport := h.transport(t, access, h.statements)
	if err := list(transport); err != nil {
		t.Fatal(err)
	}
	h.statements.switchTo("")
	if err := list(transport); !errors.Is(err, ErrAccountRequired) {
		t.Fatalf("signed out: %v, want ErrAccountRequired", err)
	}
	h.statements.switchTo("acct")
	if err := list(transport); err != nil {
		t.Fatalf("the sign-in back: %v", err)
	}
	host := h.relay.HostID()
	if hellos := h.relay.Hellos(); len(hellos) != 3 || hellos[2] != "acct.2."+host {
		t.Fatalf("hellos %q; want the last under the current sign-in", hellos)
	}
}
