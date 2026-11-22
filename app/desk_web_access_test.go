package main

import (
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/account"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// webAccessWorld is the account service plus the browser behind one approval
// request (WIRE-PLAN §2.2, §2.4), and a herdr serving owner_access over SSH.
type webAccessWorld struct {
	mu       sync.Mutex
	browser  *ecdh.PrivateKey
	nonceB   []byte
	nonceT   []byte
	approver []byte // the approving device's key, as the service records it
	finish   map[string]any
	owner    *fakeherdr.OwnerAccess
}

func b64u(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func (w *webAccessWorld) code(t *testing.T) string {
	t.Helper()
	w.mu.Lock()
	defer w.mu.Unlock()
	c, err := account.ApproveCode(w.browser.PublicKey().Bytes(), w.approver, w.nonceB, w.nonceT)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func (w *webAccessWorld) service(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		reply := func(code int, v any) {
			rw.Header().Set("Content-Type", "application/json")
			rw.WriteHeader(code)
			_ = json.NewEncoder(rw).Encode(v)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.mu.Lock()
		defer w.mu.Unlock()
		switch {
		case r.URL.Path == "/v1/auth/refresh":
			reply(200, map[string]any{"account_id": "acct", "access_token": fmt.Sprintf("a1.%022d.%043d", 1, 1), "access_expires_in": 3600,
				"refresh_token": fmt.Sprintf("r1.%022d.%043d", 1, 2), "refresh_expires_in": 1})
		case r.URL.Path == "/v1/approvals" && r.Method == http.MethodGet:
			commit, _ := account.ApproveCommit(w.browser.PublicKey().Bytes(), w.nonceB)
			reply(200, map[string]any{"requests": []any{map[string]any{
				"id": "req-1", "commit": b64u(commit), "claimed": "no", "expires_in": 600,
				"browser": map[string]any{"device_id": "dev-web", "device_pub": b64u(w.browser.PublicKey().Bytes()), "name": "Chrome on macOS", "platform": "web", "created_ms": 1},
			}}})
		case r.URL.Path == "/v1/approvals/req-1/claim":
			w.nonceT, _ = base64.RawURLEncoding.DecodeString(body["nonce_t"].(string))
			reply(200, map[string]any{})
		case r.URL.Path == "/v1/approvals/req-1" && r.Method == http.MethodGet:
			if w.nonceT == nil {
				reply(200, map[string]any{"state": "waiting"})
			} else {
				reply(200, map[string]any{"state": "revealed", "nonce_b": b64u(w.nonceB)})
			}
		case r.URL.Path == "/v1/statements":
			hosts := body["hosts"].([]any)
			reply(200, map[string]any{"statements": []any{map[string]any{"host": hosts[0], "jws": "jws-for-" + hosts[0].(string)}}, "exp": 600})
		case r.URL.Path == "/v1/approvals/req-1/finish":
			w.finish = body
			reply(200, map[string]any{})
		default:
			reply(404, map[string]any{"error": "not_found"})
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func webAccessDesk(t *testing.T, relay string) (*Desk, *webAccessWorld, string) {
	t.Helper()
	quietSync(t) // no background account sync reading d.account while signInTo sets it
	priv, _ := ecdh.X25519().NewPrivateKey(append(make([]byte, 31), 9))
	w := &webAccessWorld{browser: priv, nonceB: []byte(strings.Repeat("b", 32)), owner: fakeherdr.NewOwnerAccess(relay)}
	svc := w.service(t)
	var published []WebAccessUpdate
	var pubMu sync.Mutex
	saved := publishWebAccess
	publishWebAccess = func(u WebAccessUpdate) { pubMu.Lock(); published = append(published, u); pubMu.Unlock() }
	t.Cleanup(func() { publishWebAccess = saved })
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		inner := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if v, e, ok := w.owner.Handle(method, raw); ok {
				return v, e
			}
			return inner(method, raw)
		}
	})
	signInTo(d, svc, "acct")
	identity, err := d.guestIdentity()
	if err != nil {
		t.Fatal(err)
	}
	w.approver = identity.PublicKey()
	ms, err := d.WebAccessMachines()
	if err != nil || len(ms) != 1 || !ms[0].Available {
		t.Fatalf("machines %+v, %v", ms, err)
	}
	if err := d.WebAccessStart(context.Background(), "req-1"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the browser's code", func() bool {
		pubMu.Lock()
		defer pubMu.Unlock()
		return len(published) > 0 && published[0].State == "ready"
	})
	return d, w, ms[0].ID
}

// The whole approval: a typed code that matches, a grant on the machine bound
// to its own statement, and a sealed list only the browser can open.
func TestWebAccessApprovalGrantsAndSealsTheMachineList(t *testing.T) {
	webNow = func() time.Time { return time.Unix(1_800_000_000, 0) }
	t.Cleanup(func() { webNow = time.Now })
	d, w, machine := webAccessDesk(t, "https://guest.herdrup.app")
	ctx := context.Background()
	if _, err := d.WebAccessApprove(ctx, "req-1", []string{machine}, "chat", "7d"); err == nil {
		t.Fatal("approved before the code was typed")
	}
	if c, err := d.WebAccessCheckCode(ctx, "req-1", w.code(t)); !c.Ok || c.Denied || err != nil {
		t.Fatalf("browser's code: %+v %v", c, err)
	}
	res, err := d.WebAccessApprove(ctx, "req-1", []string{machine}, "chat", "7d")
	if err != nil || len(res.Granted) != 1 || len(res.Failed) != 0 || len(res.Skipped) != 0 {
		t.Fatalf("approve %+v, %v", res, err)
	}
	grants := w.grants(t)
	if len(grants) != 1 {
		t.Fatalf("grants %v", grants)
	}
	g := grants[0]
	if len(w.owner.Statements) != 1 || w.owner.Statements[0] != "jws-for-"+w.owner.HostID {
		t.Fatalf("statements sent %v, want this machine's", w.owner.Statements)
	}
	if g["scope"] != "chat" || g["device_pub"] != b64u(w.browser.PublicKey().Bytes()) || g["device"] != "Chrome on macOS" ||
		g["expires_ms"].(float64)-g["created_ms"].(float64) != 7*24*3600*1000 {
		t.Fatalf("grant %v", g)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.finish["outcome"] != "approved" || w.finish["scope"] != "chat" || w.finish["expires_ms"].(float64) != float64(time.Unix(1_800_000_000, 0).Add(7*24*time.Hour).UnixMilli()) {
		t.Fatalf("finish %v", w.finish)
	}
	plain, err := account.OpenEnvelope(x25519Browser{w.browser}, w.approver, 1, w.finish["sealed"].(string))
	if err != nil {
		t.Fatalf("the browser can't open the list: %v", err)
	}
	var env webEnvelope
	if err := json.Unmarshal(plain, &env); err != nil || len(env.Machines) != 1 || env.Machines[0].HostID != w.owner.HostID ||
		env.Machines[0].GrantID != g["grant_id"] || env.Machines[0].Relay != "https://guest.herdrup.app" {
		t.Fatalf("envelope %s, %v", plain, err)
	}
}

// A machine on a relay the web app can't reach gets no grant and is listed
// as skipped; with nothing granted the request stays open.
func TestWebAccessSkipsAMachineOnAnotherRelay(t *testing.T) {
	d, w, machine := webAccessDesk(t, "https://relay.example.com")
	ctx := context.Background()
	if c, _ := d.WebAccessCheckCode(ctx, "req-1", w.code(t)); !c.Ok {
		t.Fatal("code refused")
	}
	res, err := d.WebAccessApprove(ctx, "req-1", []string{machine}, "chat", "7d")
	if err != nil || len(res.Granted) != 0 || len(res.Skipped) != 1 || res.Skipped[0].Reason != "relay_not_allowed" {
		t.Fatalf("approve %+v, %v", res, err)
	}
	if g := w.grants(t); len(g) != 0 {
		t.Fatalf("grants %v", g)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.finish != nil {
		t.Fatalf("finish %v", w.finish)
	}
}

// grants are the machine's grants, as owner_access.list reports them.
func (w *webAccessWorld) grants(t *testing.T) []map[string]any {
	t.Helper()
	v, e, _ := w.owner.Handle("owner_access.list", nil)
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(v)
	var out struct{ Grants []map[string]any }
	_ = json.Unmarshal(raw, &out)
	return out.Grants
}

type x25519Browser struct{ k *ecdh.PrivateKey }

func (b x25519Browser) PublicKey() []byte { return b.k.PublicKey().Bytes() }
func (b x25519Browser) SharedSecret(peer []byte) ([]byte, error) {
	p, err := ecdh.X25519().NewPublicKey(peer)
	if err != nil {
		return nil, err
	}
	return b.k.ECDH(p)
}
