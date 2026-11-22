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
}

func newApprovalService(t *testing.T) *approvalService {
	b := fixedKey(t, 0xb0)
	nonce, _ := NewApproveNonce()
	return &approvalService{browser: b, shown: b, nonceB: nonce, reveal: nonce}
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
		if s.finished != nil {
			reply(w, 200, map[string]any{"state": s.finished["outcome"]})
		} else if s.nonceT == nil {
			reply(w, 200, map[string]any{"state": ApprovalWaiting})
		} else {
			reply(w, 200, map[string]any{"state": ApprovalRevealed, "nonce_b": base64.RawURLEncoding.EncodeToString(s.reveal)})
		}
	case r.URL.Path == "/v1/approvals/req-1/finish" && r.Method == http.MethodPost:
		s.finished = body
		if body["outcome"] == "denied" {
			s.denied++
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
	if ok, _ := a.CheckCode(ctx, s.browserCode(t, approver.PublicKey())); !ok {
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
		ok, denied := a.CheckCode(ctx, real)
		if ok {
			t.Fatal("approved a code shown for another key")
		}
		if denied != (i == maxCodeTries-1) {
			t.Fatalf("try %d: denied = %v", i+1, denied)
		}
	}
	if err := a.Approve(ctx, "chat", 1, 1, []byte(`{}`)); !errors.Is(err, ErrApprovalEnded) {
		t.Fatalf("approve after denial: %v", err)
	}
	if s.denied != 1 || s.finished["outcome"] != "denied" || s.finished["sealed"] != "" {
		t.Fatalf("finish = %v, denials %d", s.finished, s.denied)
	}
}
