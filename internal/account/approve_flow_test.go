package account

import (
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"errors"
	mathrand "math/rand/v2"
	"net/http"
	"sync"
	"testing"
	"time"
)

// fixedKey is an X25519 key from a fixed seed, so every run computes the
// same codes.
func fixedKey(t *testing.T, seed byte) x25519Key {
	t.Helper()
	k, err := ecdh.X25519().NewPrivateKey(make32(seed))
	if err != nil {
		t.Fatal(err)
	}
	return x25519Key{k}
}

// approvalService plays the account service and, behind it, the browser of
// one approval request (WIRE-PLAN §2.2, §2.4). shown is the browser key the
// service shows the approver; a compromised service shows its own.
type approvalService struct {
	mu       sync.Mutex
	browser  x25519Key // the real browser
	shown    x25519Key // the key the approver is shown (== browser when honest)
	nonceB   []byte    // what the shown key committed to
	reveal   []byte    // what the service reveals (== nonceB when honest)
	nonceT   []byte
	finished map[string]string
	denied   int
	// Faults: the next readBusy state reads answer 429; finishes answer
	// finishStatus (0: as asked) and, when lost, are still recorded; state
	// reads answer readStatus (0: the state), or readState when set (an
	// expiry the service computes on the read, recording nothing; or, with
	// readStored, one it stored).
	readBusy     int
	finishStatus int
	lost         bool
	readStatus   int
	readState    string
	readStored   bool
	finishes     int
	// readHeld, when set, holds each state read that long after noting
	// when it arrived in readAt.
	readHeld  time.Duration
	readAt    time.Time
	expiresIn int
}

func newApprovalService(t *testing.T) *approvalService {
	b := fixedKey(t, 0xb0)
	nonce, _ := NewApproveNonce()
	return &approvalService{browser: b, shown: b, nonceB: nonce, reveal: nonce, expiresIn: 600}
}

func (s *approvalService) request() ApprovalRequest {
	commit, _ := ApproveCommit(s.shown.PublicKey(), s.nonceB)
	var r ApprovalRequest
	r.ID, r.Commit, r.Claimed = "req-1", base64.RawURLEncoding.EncodeToString(commit), "no"
	r.Browser.DeviceID, r.Browser.Name, r.Browser.Platform = "dev-web", "Chrome on macOS", "web"
	r.Browser.DevicePub = base64.RawURLEncoding.EncodeToString(s.shown.PublicKey())
	return r
}

func (s *approvalService) serve(w http.ResponseWriter, r *http.Request, body map[string]string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case r.URL.Path == "/v1/approvals/req-1/claim" && r.Method == http.MethodPost:
		s.nonceT, _ = base64.RawURLEncoding.DecodeString(body["nonce_t"])
		reply(w, 200, map[string]any{})
	case r.URL.Path == "/v1/approvals/req-1" && r.Method == http.MethodGet:
		if s.readHeld > 0 {
			s.readAt = time.Now()
			time.Sleep(s.readHeld)
		}
		switch {
		case s.readBusy > 0:
			s.readBusy--
			reply(w, 429, map[string]any{"error": "too_many_requests"})
		case s.readStatus != 0:
			reply(w, s.readStatus, map[string]any{"error": "unavailable"})
		case s.readState != "":
			st := map[string]any{"state": s.readState, "expires_in": 0}
			if s.readStored {
				st["outcome_stored"] = true
			}
			reply(w, 200, st)
		case s.finished != nil:
			reply(w, 200, map[string]any{"state": s.finished["outcome"], "expires_in": s.expiresIn})
		case s.nonceT == nil:
			reply(w, 200, map[string]any{"state": ApprovalWaiting, "expires_in": s.expiresIn})
		default:
			reply(w, 200, map[string]any{"state": ApprovalRevealed, "expires_in": s.expiresIn, "nonce_b": base64.RawURLEncoding.EncodeToString(s.reveal)})
		}
	case r.URL.Path == "/v1/approvals/req-1/finish" && r.Method == http.MethodPost:
		s.finishes++
		if s.finished != nil {
			reply(w, 409, map[string]any{"error": "already_finished"})
			break
		}
		if s.finishStatus != 0 && !s.lost {
			reply(w, s.finishStatus, map[string]any{"error": "unavailable"})
			break
		}
		s.finished = body
		if body["outcome"] == "denied" {
			s.denied++
		}
		if s.lost {
			reply(w, s.finishStatus, map[string]any{"error": "unavailable"})
			break
		}
		reply(w, 200, map[string]any{})
	default:
		return false
	}
	return true
}

// browserCode is the code the real browser shows: over its own key, the
// approver key it was given and its own nonce.
func (s *approvalService) browserCode(t *testing.T, approverPub []byte) string {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	code, err := ApproveCode(s.browser.PublicKey(), approverPub, s.nonceB, s.nonceT)
	if err != nil {
		t.Fatal(err)
	}
	return code
}

func approvalSetup(t *testing.T) (*approvalService, *Client, x25519Key) {
	t.Helper()
	savedPoll, savedRand := approvalPoll, approveRand
	approvalPoll = func(time.Duration) time.Duration { return time.Millisecond }
	approveRand = mathrand.NewChaCha8([32]byte{7})
	t.Cleanup(func() { approvalPoll, approveRand = savedPoll, savedRand })
	f, c, _, _ := signedIn(t)
	s := newApprovalService(t)
	f.extra = s.serve
	return s, c, fixedKey(t, 0x70)
}

func TestAnHonestBrowserIsApprovedWithItsCodeAndCanOpenTheMachineList(t *testing.T) {
	s, c, approver := approvalSetup(t)
	ctx := context.Background()
	a, err := c.StartApproval(ctx, "acct-1", approver, s.request())
	if err != nil {
		t.Fatal(err)
	}
	if err := a.AwaitReveal(ctx); err != nil {
		t.Fatal(err)
	}
	if err := a.Approve(ctx, "terminal", 1, 1, []byte(`{"v":1}`)); !errors.Is(err, ErrCodeNotChecked) {
		t.Fatalf("approve before the code: %v", err)
	}
	if c, err := a.CheckCode(ctx, s.browserCode(t, approver.PublicKey())); !c.Ok || err != nil {
		t.Fatal("the browser's own code was refused")
	}
	if err := a.Approve(ctx, "terminal", 1_800_000_000_000, 1, []byte(`{"v":1,"machines":[]}`)); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	finished := s.finished
	s.mu.Unlock()
	if finished["outcome"] != "approved" || finished["scope"] != "terminal" {
		t.Fatalf("finish = %v", finished)
	}
	plain, err := OpenEnvelope(s.browser, approver.PublicKey(), 1, finished["sealed"])
	if err != nil || string(plain) != `{"v":1,"machines":[]}` {
		t.Fatalf("browser opens %q, %v", plain, err)
	}
}

// A reveal that doesn't open the commit the approver claimed against is denied.
func TestARevealThatDoesNotOpenTheCommitIsDenied(t *testing.T) {
	s, c, approver := approvalSetup(t)
	s.reveal, _ = NewApproveNonce()
	ctx := context.Background()
	a, err := c.StartApproval(ctx, "acct-1", approver, s.request())
	if err != nil {
		t.Fatal(err)
	}
	if err := a.AwaitReveal(ctx); !errors.Is(err, ErrApproveTampered) {
		t.Fatalf("reveal: %v, want tampered", err)
	}
	if s.denied != 1 {
		t.Fatalf("denials sent = %d, want 1", s.denied)
	}
}

// A compromised service shows the approver its own key (with a valid commit).
// The real browser's code then doesn't match, so the approver never approves;
// three wrong codes deny the request.
func TestASwappedBrowserKeyIsNeverApproved(t *testing.T) {
	s, c, approver := approvalSetup(t)
	s.shown = fixedKey(t, 0xa7)
	ctx := context.Background()
	a, err := c.StartApproval(ctx, "acct-1", approver, s.request())
	if err != nil {
		t.Fatal(err)
	}
	if err := a.AwaitReveal(ctx); err != nil {
		t.Fatal(err)
	}
	real := s.browserCode(t, approver.PublicKey())
	if real == a.code {
		t.Fatal("fixture: the attacker's code equals the browser's; pick other seeds")
	}
	for i := 0; i < maxCodeTries; i++ {
		c, err := a.CheckCode(ctx, real)
		if c.Ok || err != nil {
			t.Fatalf("approved a code shown for another key: %+v, %v", c, err)
		}
		if last := i == maxCodeTries-1; c.Denied != last || c.Left != maxCodeTries-1-i {
			t.Fatalf("try %d: %+v", i+1, c)
		}
	}
	if err := a.Approve(ctx, "chat", 1, 1, []byte(`{}`)); !errors.Is(err, ErrApprovalEnded) {
		t.Fatalf("approve after denial: %v", err)
	}
	if s.denied != 1 || s.finished["outcome"] != "denied" || s.finished["sealed"] != "" {
		t.Fatalf("finish = %v, denials %d", s.finished, s.denied)
	}
}

// revealedApproval is an approval whose browser revealed, for the steps after.
func revealedApproval(t *testing.T) (*approvalService, *Approval, x25519Key) {
	t.Helper()
	s, c, approver := approvalSetup(t)
	a, err := c.StartApproval(context.Background(), "acct-1", approver, s.request())
	if err != nil {
		t.Fatal(err)
	}
	if err := a.AwaitReveal(context.Background()); err != nil {
		t.Fatal(err)
	}
	return s, a, approver
}

// A rate-limited read keeps the claim: the wait goes on and sees the reveal.
func TestARateLimitedReadDoesNotEndTheWaitForTheReveal(t *testing.T) {
	s, c, approver := approvalSetup(t)
	s.readBusy = 2
	a, err := c.StartApproval(context.Background(), "acct-1", approver, s.request())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := a.AwaitReveal(ctx); err != nil {
		t.Fatalf("reveal after two 429s: %v", err)
	}
	if c, err := a.CheckCode(ctx, s.browserCode(t, approver.PublicKey())); !c.Ok || err != nil {
		t.Fatalf("code after the busy reads: %+v, %v", c, err)
	}
}

// The last wrong code locks the approval even when the denial can't be sent;
// Deny then sends it again.
func TestWrongCodesLockTheApprovalEvenWhenTheDenialFails(t *testing.T) {
	s, a, approver := revealedApproval(t)
	ctx := context.Background()
	s.finishStatus = http.StatusServiceUnavailable
	var c CodeCheck
	for range maxCodeTries {
		c, _ = a.CheckCode(ctx, "0000")
	}
	if c.Left != 0 || c.Denied || c.DenyErr == nil {
		t.Fatalf("third wrong code with the service down: %+v", c)
	}
	if c, err := a.CheckCode(ctx, s.browserCode(t, approver.PublicKey())); c.Ok || !errors.Is(err, ErrApprovalEnded) {
		t.Fatalf("right code after the lockout: %+v, %v", c, err)
	}
	if err := a.Approve(ctx, "chat", 1, 1, []byte(`{}`)); !errors.Is(err, ErrApprovalEnded) {
		t.Fatalf("approve after the lockout: %v", err)
	}
	s.mu.Lock()
	s.finishStatus = 0
	s.mu.Unlock()
	if err := a.Deny(ctx); err != nil {
		t.Fatal(err)
	}
	if s.denied != 1 {
		t.Fatalf("denials recorded = %d, want 1", s.denied)
	}
}

// A denial that fails is reported, and the next Deny sends it again.
func TestDenyFailsUntilTheServiceTakesIt(t *testing.T) {
	s, a, _ := revealedApproval(t)
	ctx := context.Background()
	s.finishStatus = http.StatusServiceUnavailable
	if err := a.Deny(ctx); err == nil {
		t.Fatal("denial reported done while the service refused it")
	}
	s.mu.Lock()
	s.finishStatus = 0
	s.mu.Unlock()
	if err := a.Deny(ctx); err != nil {
		t.Fatal(err)
	}
	if s.finishes != 2 || s.denied != 1 {
		t.Fatalf("finishes %d, denials %d; want 2 and 1", s.finishes, s.denied)
	}
}

// A failed approval is told apart: the only finish refused by the service,
// or a request that ended, is NotApprovedError; recorded but unanswered is
// success; a request still revealed, or read as expired, after a lost or 5xx
// answer is unknown, since the finish may yet be applied, unless that read
// says the expiry is stored (outcome_stored), which no finish can follow.
func TestAFailedApprovalIsToldApart(t *testing.T) {
	cases := []struct {
		name         string
		finishStatus int
		lost         bool
		readStatus   int
		outcome      string
		readState    string
		readStored   bool
		want         string
	}{
		{"refused by the service", http.StatusConflict, false, 0, "", "", false, "not approved"},
		// The browser replaced the request: the finish and every read are 404.
		{"refused, then gone", http.StatusNotFound, false, http.StatusNotFound, "", "", false, "not approved"},
		{"503, still revealed", http.StatusServiceUnavailable, false, 0, "", "", false, "unknown"},
		{"request over before the finish", http.StatusServiceUnavailable, false, 0, ApprovalExpired, "", false, "not approved"},
		{"503, then read as expired", http.StatusServiceUnavailable, false, 0, "", ApprovalExpired, false, "unknown"},
		{"503, then read as a stored expiry", http.StatusServiceUnavailable, false, 0, "", ApprovalExpired, true, "not approved"},
		// The browser denied it meanwhile: no finish can be recorded after that.
		{"503, then read as denied", http.StatusServiceUnavailable, false, 0, "", ApprovalDenied, false, "not approved"},
		{"answer lost", http.StatusServiceUnavailable, true, 0, "", "", false, "approved"},
		{"state unreadable", http.StatusServiceUnavailable, false, http.StatusServiceUnavailable, "", "", false, "unknown"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, a, approver := revealedApproval(t)
			ctx := context.Background()
			if c, _ := a.CheckCode(ctx, s.browserCode(t, approver.PublicKey())); !c.Ok {
				t.Fatal("code refused")
			}
			s.mu.Lock()
			s.finishStatus, s.lost, s.readStatus, s.readState, s.readStored = tc.finishStatus, tc.lost, tc.readStatus, tc.readState, tc.readStored
			if tc.outcome != "" {
				s.finishStatus = 0
				s.finished = map[string]string{"outcome": tc.outcome}
			}
			s.mu.Unlock()
			err := a.Approve(ctx, "chat", 1_800_000_000_000, 7, []byte(`{}`))
			var refused *NotApprovedError
			got := "unknown"
			switch {
			case err == nil:
				got = "approved"
			case errors.As(err, &refused):
				got = "not approved"
			}
			if got != tc.want {
				t.Fatalf("approve: %v (%s), want %s", err, got, tc.want)
			}
		})
	}
}

// Live refuses a request that ended or has too little time left.
func TestLiveRefusesAnEndedOrEndingRequest(t *testing.T) {
	s, a, approver := revealedApproval(t)
	ctx := context.Background()
	if c, _ := a.CheckCode(ctx, s.browserCode(t, approver.PublicKey())); !c.Ok {
		t.Fatal("code refused")
	}
	// The deadline counts from before the read (here held 50 ms after it
	// arrived), less the second the service may have rounded up.
	s.mu.Lock()
	s.readHeld = 50 * time.Millisecond
	s.mu.Unlock()
	deadline, err := a.Live(ctx, time.Minute)
	if err != nil {
		t.Fatalf("open request: %v", err)
	}
	s.mu.Lock()
	latest := s.readAt.Add(599 * time.Second)
	s.readHeld = 0
	s.mu.Unlock()
	if deadline.After(latest) {
		t.Fatalf("deadline %v is after %v (600 s left when the read arrived, rounded up)", deadline, latest)
	}
	s.mu.Lock()
	s.expiresIn = 20
	s.mu.Unlock()
	if _, err := a.Live(ctx, time.Minute); !errors.Is(err, ErrApprovalEnding) {
		t.Fatalf("20 s left: %v", err)
	}
	s.mu.Lock()
	s.finished = map[string]string{"outcome": ApprovalExpired}
	s.mu.Unlock()
	if _, err := a.Live(ctx, time.Minute); !errors.Is(err, ErrApprovalEnded) {
		t.Fatalf("expired: %v", err)
	}
}

// After a finish with an unknown outcome, an expired read settles nothing
// (the service only computes that expiry, and the finish may still be
// recorded), and a later refusal doesn't either. It settles when the service
// shows the finish recorded.
func TestAnExpiredReadDoesNotSettleAFinishWithAnUnknownOutcome(t *testing.T) {
	s, a, approver := revealedApproval(t)
	ctx := context.Background()
	if c, _ := a.CheckCode(ctx, s.browserCode(t, approver.PublicKey())); !c.Ok {
		t.Fatal("code refused")
	}
	s.mu.Lock()
	s.finishStatus, s.readState = http.StatusServiceUnavailable, ApprovalExpired
	s.mu.Unlock()
	var refused *NotApprovedError
	if err := a.Approve(ctx, "chat", 1_800_000_000_000, 7, []byte(`{}`)); err == nil || errors.As(err, &refused) {
		t.Fatalf("lost finish, then expired: %v; want unknown", err)
	}
	// The service now refuses finishes (410 expired).
	s.mu.Lock()
	s.finishStatus = http.StatusGone
	s.mu.Unlock()
	if err := a.Approve(ctx, "chat", 1_800_000_000_000, 7, []byte(`{}`)); err == nil || errors.As(err, &refused) {
		t.Fatalf("refused after the unknown one: %v; want unknown", err)
	}
	// The first finish was recorded after all.
	s.mu.Lock()
	s.readState = ApprovalApproved
	s.mu.Unlock()
	if err := a.Approve(ctx, "chat", 1_800_000_000_000, 7, []byte(`{}`)); err != nil {
		t.Fatalf("once the service shows it: %v; want approved", err)
	}
}

// Once the service took this device's denial, Deny keeps saying so: no
// approval of the request can be recorded after it.
func TestATakenDenialStaysTheOutcome(t *testing.T) {
	s, a, _ := revealedApproval(t)
	ctx := context.Background()
	for try := 1; try <= 2; try++ {
		if err := a.Deny(ctx); err != nil {
			t.Fatalf("deny %d: %v", try, err)
		}
	}
	if s.finishes != 1 || s.denied != 1 {
		t.Fatalf("finishes %d, denials %d; want 1 and 1", s.finishes, s.denied)
	}
}
