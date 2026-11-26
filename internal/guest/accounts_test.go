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
	"github.com/flynn/noise"
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
	// next Drop. raceAsk runs once inside the next ask instead of issuing
	// one, which then fails with errLookupRaced, as the account's cache
	// does when its sign-in ended while it asked; failAsk fails the next
	// ask with itself (the service's answer).
	onAsk, onDrop, raceAsk func()
	failAsk                error
}

// errLookupRaced is the account cache's answer to an ask whose sign-in
// ended while it was out (account.ErrAccountChanged).
var errLookupRaced = errors.New("account: the session changed while the statement was asked for")

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
	race, fail := f.raceAsk, f.failAsk
	f.raceAsk, f.failAsk = nil, nil
	if race != nil {
		f.mu.Unlock()
		race()
		return Statement{}, errLookupRaced
	}
	if fail != nil {
		f.mu.Unlock()
		return Statement{}, fail
	}
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
	transport := NewTransport(access, h.identity, h.clock, statements, nil)
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

// A bound session sends a fresh statement in band 2 minutes before its
// cutoff: first the host's deadline (herdr's: the statement's exp + 60 s),
// then, the refresh being unacknowledged, the new statement's exp. On the
// clock, not on time.
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
	// DESIGN §3.3's 2 minutes, not the constant under test: the deadline at
	// 660 s, then the refreshed statement's exp at 540 + 600 s.
	for n, step := range []struct {
		after time.Duration
		want  string
	}{{660*time.Second - 2*time.Minute, "acct.2." + host}, {600*time.Second - 2*time.Minute, "acct.3." + host}} {
		eventually(t, "the refresh to wait", func() bool { return h.clock.waiting() == 1 })
		h.clock.advance(step.after - time.Second)
		if h.clock.waiting() != 1 || len(h.relay.Refreshes()) != n {
			t.Fatalf("refresh %d: with more than 2 minutes left, refreshes %q", n+1, h.relay.Refreshes())
		}
		h.clock.advance(time.Second)
		eventually(t, "the refresh", func() bool { return len(h.relay.Refreshes()) == n+1 })
		if got := h.relay.Refreshes()[n]; got != step.want {
			t.Fatalf("refresh %d sent %q, want %q", n+1, got, step.want)
		}
	}
}

// The host's advertised deadline is the session's first cutoff: one
// earlier than the statement's exp brings the first refresh forward.
func TestTheHostsDeadlineDrivesTheFirstRefresh(t *testing.T) {
	h := newAccountHost(t, true)
	h.relay.AccountDeadline = func(exp time.Time) time.Time { return exp.Add(-5 * time.Minute) }
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
	// The statement expires 600 s on, the host's deadline 300 s on.
	eventually(t, "the refresh to wait", func() bool { return h.clock.waiting() == 1 })
	h.clock.advance(300*time.Second - 2*time.Minute - time.Second)
	if h.clock.waiting() != 1 || len(h.relay.Refreshes()) != 0 {
		t.Fatalf("with more than 2 minutes to the host's deadline, refreshes %q", h.relay.Refreshes())
	}
	h.clock.advance(time.Second)
	eventually(t, "the refresh before the host's deadline", func() bool { return len(h.relay.Refreshes()) == 1 })
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
	h.clock.advance(660*time.Second - 2*time.Minute)
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

// A bound session's refreshes stay in the sign-in it was admitted in: run
// on its own, a session's refresh loop whose sign-in changes while its
// statement is asked for writes nothing and returns.
func TestABoundSessionsRefreshAfterASwitchSendsNothingAndStops(t *testing.T) {
	clock := &stepClock{now: time.Unix(1_000_000, 0)}
	statements := newFakeStatements(clock, "acct")
	admitted, err := statements.Statement(context.Background(), "host", statementLead)
	if err != nil {
		t.Fatal(err)
	}
	wrote := make(chan []byte, 4)
	s := &session{send: noise.UnsafeNewCipherState(cipherSuite, [32]byte{}, 0), writeHook: func(_ context.Context, frame []byte) error {
		wrote <- frame
		return nil
	}}
	// Due now: its cutoff is statementLead away.
	b := &boundStatement{statements: statements, host: "host", jws: admitted.JWS, cutoff: clock.Now().Add(statementLead), admitted: admitted.Live}
	statements.onAsk = func() { statements.switchTo("other") }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.refresh(ctx, clock, b)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("the refresh went on after the switch; wrote %d frames", len(wrote))
	}
	if len(wrote) != 0 || statements.asked() != 2 {
		t.Fatalf("wrote %d frames, statements asked %d; want one ask and nothing written", len(wrote), statements.asked()-1)
	}
}

// A returning hello refused for its statement goes once more with a fresh
// one, in the same sign-in. When the sign-in changes meanwhile (a failed
// sign-out that brought the same account back), the retry sends nothing and
// says the sign-in changed, not herdr's account_mismatch: both before it
// asks for its statement, and at the send.
func TestARetryAfterTheSignInChangedSendsNothing(t *testing.T) {
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
	changed := func(when string, err error) {
		t.Helper()
		if !errors.Is(err, ErrSignInChanged) || err.Error() != "Your HerdrUp sign-in changed. Try again." || errors.Is(err, ErrAccountMismatch) || errors.Is(err, ErrAccountChanged) {
			t.Fatalf("a retry past a change of sign-in (%s): %v, want ErrSignInChanged", when, err)
		}
	}
	// The sign-in changes before the retry asks for its statement.
	h.mu.Lock()
	h.refuseOnce = "statement_expired"
	h.mu.Unlock()
	h.statements.onDrop = func() { h.statements.switchTo("acct") }
	asked := h.statements.asked()
	changed("before its statement", list(h.transport(t, access, h.statements)))
	if hellos := h.relay.Hellos(); len(hellos) != 4 || h.statements.asked() != asked+1 {
		t.Fatalf("hellos %q, statements asked %d more; want the refused hello alone", hellos, h.statements.asked()-asked)
	}
	// The sign-in changes while the retry's statement is asked for: the
	// stale statement is not sent.
	h.mu.Lock()
	h.refuseOnce = "statement_expired"
	h.mu.Unlock()
	h.statements.onDrop = func() {
		h.statements.mu.Lock()
		h.statements.onAsk = func() { h.statements.switchTo("acct") }
		h.statements.mu.Unlock()
	}
	asked = h.statements.asked()
	changed("at the send", list(h.transport(t, access, h.statements)))
	if hellos := h.relay.Hellos(); len(hellos) != 5 || h.statements.asked() != asked+2 {
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

// A retry's statement lookup the change of sign-in spoiled (the account's
// cache then fails it) is that change: ErrSignInChanged for a saved share,
// ErrAccountChanged for a redemption, with nothing sent. A lookup that
// fails in the same sign-in fails as itself.
func TestARetrysLookupSpoiledByASignInChangeIsThatChange(t *testing.T) {
	later := func(f *fakeStatements, set func()) func() {
		return func() {
			f.mu.Lock()
			defer f.mu.Unlock()
			set()
		}
	}
	t.Run("a saved share", func(t *testing.T) {
		h := newAccountHost(t, true)
		access := h.accept(t, h.statements)
		h.mu.Lock()
		h.refuseOnce = "statement_expired"
		h.mu.Unlock()
		h.statements.onDrop = later(h.statements, func() { h.statements.raceAsk = func() { h.statements.switchTo("acct") } })
		err := list(h.transport(t, access, h.statements))
		if !errors.Is(err, ErrSignInChanged) || errors.Is(err, errLookupRaced) {
			t.Fatalf("a lookup across a change of sign-in: %v, want ErrSignInChanged", err)
		}
		if hellos := h.relay.Hellos(); len(hellos) != 2 {
			t.Fatalf("hellos %q; want the refused one alone", hellos)
		}
	})
	t.Run("a redemption", func(t *testing.T) {
		h := newAccountHost(t, true)
		h.mu.Lock()
		h.refuseOnce = "statement_invalid"
		h.mu.Unlock()
		h.statements.onDrop = later(h.statements, func() { h.statements.raceAsk = func() { h.statements.switchTo("acct") } })
		_, err := Accept(context.Background(), h.invite(t), h.identity, "Desktop", h.now, h.statements)
		if !errors.Is(err, ErrAccountChanged) || errors.Is(err, errLookupRaced) {
			t.Fatalf("a redemption's lookup across a change of sign-in: %v, want ErrAccountChanged", err)
		}
		if hellos := h.relay.Hellos(); len(hellos) != 1 || h.relay.Bound() != "" {
			t.Fatalf("hellos %q, bound to %q; want the refused one alone", hellos, h.relay.Bound())
		}
	})
	t.Run("the same sign-in", func(t *testing.T) {
		h := newAccountHost(t, true)
		access := h.accept(t, h.statements)
		service := errors.New("account service: 503 unavailable")
		h.mu.Lock()
		h.refuseOnce = "statement_expired"
		h.mu.Unlock()
		h.statements.onDrop = later(h.statements, func() { h.statements.failAsk = service })
		if err := list(h.transport(t, access, h.statements)); !errors.Is(err, service) {
			t.Fatalf("a saved share's lookup failing in its sign-in: %v, want the service's error", err)
		}
		fresh := newAccountHost(t, true)
		fresh.mu.Lock()
		fresh.refuseOnce = "statement_invalid"
		fresh.mu.Unlock()
		fresh.statements.onDrop = later(fresh.statements, func() { fresh.statements.failAsk = service })
		if _, err := Accept(context.Background(), fresh.invite(t), fresh.identity, "Desktop", fresh.now, fresh.statements); !errors.Is(err, service) {
			t.Fatalf("a redemption's lookup failing in its sign-in: %v, want the service's error", err)
		}
	})
}

// The relay picks the invitation or grant first, as herdr does
// (src/guest/store.rs:984-1022, 1087-1166), and only then applies the
// account's refusals: a bound share takes in a new device of its account by
// its statement, a refused statement from a device it doesn't hold is an
// unknown guest, and from one it holds is that refusal; a used invitation
// is used whatever its statement.
func TestTheRelaySelectsTheGrantBeforeTheAccountRefusals(t *testing.T) {
	h := newAccountHost(t, true)
	access := h.accept(t, h.statements)
	device := func(name string) Identity {
		identity, err := LoadIdentity(filepath.Join(t.TempDir(), name))
		if err != nil {
			t.Fatal(err)
		}
		return identity
	}
	second := NewTransport(access, device("second"), h.clock, h.statements, nil)
	t.Cleanup(func() { _ = second.Close() })
	if err := list(second); err != nil || h.relay.Devices() != 2 {
		t.Fatalf("a new device of the account: %v, devices %d", err, h.relay.Devices())
	}
	h.mu.Lock()
	h.refuseOnce = "statement_invalid"
	h.mu.Unlock()
	third := NewTransport(access, device("third"), h.clock, h.statements, nil)
	t.Cleanup(func() { _ = third.Close() })
	if err := list(third); !errors.Is(err, ErrRevoked) || h.relay.Devices() != 2 {
		t.Fatalf("a new device with a refused statement: %v, devices %d; want an unknown guest", err, h.relay.Devices())
	}
	h.mu.Lock()
	h.refuse = "account_keys_stale"
	h.mu.Unlock()
	if err := list(h.transport(t, access, h.statements)); !errors.Is(err, ErrAccountKeysStale) {
		t.Fatalf("a held device with a refused statement: %v, want its refusal", err)
	}
	h.mu.Lock()
	h.refuse = "statement_invalid"
	h.mu.Unlock()
	_, err := Accept(context.Background(), h.invite(t), h.identity, "Desktop", h.now, h.statements)
	if err == nil || errors.Is(err, ErrStatementInvalid) || !strings.Contains(err.Error(), "already used") {
		t.Fatalf("a used invitation with a refused statement: %v, want invite_used", err)
	}
}

// Only the host's own refusal of a statement, inside its authenticated
// reply, earns a retry with a fresh one; the same code as a close reason,
// or a lost connection, does not.
func TestOnlyTheHostsOwnRefusalIsRetried(t *testing.T) {
	for _, c := range []struct {
		name  string
		err   error
		retry bool
	}{
		{"a refused hello, statement_invalid", helloRefused{refusal("statement_invalid")}, true},
		{"a refused hello, statement_expired", helloRefused{refusal("statement_expired")}, true},
		{"a refused hello, account_mismatch", helloRefused{refusal("account_mismatch")}, false},
		{"a close, statement_invalid", socketError(websocket.CloseError{Code: websocket.StatusNormalClosure, Reason: "statement_invalid"}), false},
		{"a close, statement_expired", socketError(websocket.CloseError{Code: websocket.StatusNormalClosure, Reason: "statement_expired"}), false},
		{"a lost connection", errors.New("connect to guest relay: EOF"), false},
	} {
		if got := freshStatementMayAdmit(c.err); got != c.retry {
			t.Errorf("%s: retried %v, want %v", c.name, got, c.retry)
		}
	}
	if refused := (helloRefused{refusal("statement_invalid")}); !errors.Is(refused, ErrStatementInvalid) || refused.Error() != ErrStatementInvalid.Error() {
		t.Errorf("a refused hello reads %v, want ErrStatementInvalid", refused)
	}
}
