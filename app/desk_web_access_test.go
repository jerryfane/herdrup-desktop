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
	adds     []map[string]any
	relay    string
	hostID   string
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

func (w *webAccessWorld) herdr(method string, raw json.RawMessage) (any, *fakeherdr.APIError, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	switch method {
	case "owner_access.info":
		return map[string]any{"type": "owner_access_info", "protocol": 1, "host_id": w.hostID, "node_pub": b64u(make([]byte, 32)),
			"relay_url": w.relay, "link": map[string]any{"state": "up"}, "max_ttl_secs": 2592000, "scopes": []string{"chat", "terminal"}, "version": "0.9.5"}, nil, true
	case "owner_access.add":
		var p map[string]any
		_ = json.Unmarshal(raw, &p)
		w.adds = append(w.adds, p)
		return map[string]any{"type": "owner_access_added", "replaced": []string{}, "grant": map[string]any{
			"grant_id": "g-1", "device_pub": p["device_pub"], "fingerprint": "SHA256:x", "device": p["device_name"], "scope": p["scope"],
			"approved_by": p["approved_by"], "created_ms": 1, "expires_ms": 1_000 + uint64(p["ttl_secs"].(float64))*1000, "revoked": false}}, nil, true
	}
	return nil, nil, false
}

func webAccessDesk(t *testing.T, relay string) (*Desk, *webAccessWorld, string) {
	t.Helper()
	priv, _ := ecdh.X25519().NewPrivateKey(append(make([]byte, 31), 9))
	w := &webAccessWorld{browser: priv, nonceB: []byte(strings.Repeat("b", 32)), relay: relay, hostID: b64u([]byte("host-id-16-bytes"))}
	svc := w.service(t)
	var published []WebAccessUpdate
	var pubMu sync.Mutex
	saved := publishWebAccess
	publishWebAccess = func(u WebAccessUpdate) { pubMu.Lock(); published = append(published, u); pubMu.Unlock() }
	t.Cleanup(func() { publishWebAccess = saved })
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		inner := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if v, e, ok := w.herdr(method, raw); ok {
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
	if _, err := d.WebAccessApprove(ctx, "req-1", []string{machine}, "terminal", "7d"); err == nil {
		t.Fatal("approved before the code was typed")
	}
	if ok, denied, err := d.WebAccessCheckCode(ctx, "req-1", w.code(t)); !ok || denied || err != nil {
		t.Fatalf("browser's code: ok %v denied %v %v", ok, denied, err)
	}
	res, err := d.WebAccessApprove(ctx, "req-1", []string{machine}, "terminal", "7d")
	if err != nil || len(res.Granted) != 1 || len(res.Failed) != 0 || len(res.Skipped) != 0 {
		t.Fatalf("approve %+v, %v", res, err)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.adds) != 1 {
		t.Fatalf("owner_access.add calls %d", len(w.adds))
	}
	add := w.adds[0]
	if add["account_statement"] != "jws-for-"+w.hostID || add["scope"] != "terminal" || add["ttl_secs"].(float64) != 7*24*3600 ||
		add["device_pub"] != b64u(w.browser.PublicKey().Bytes()) || add["machine"] != nil {
		t.Fatalf("owner_access.add %v", add)
	}
	if w.finish["outcome"] != "approved" || w.finish["scope"] != "terminal" || w.finish["expires_ms"].(float64) != float64(time.Unix(1_800_000_000, 0).Add(7*24*time.Hour).UnixMilli()) {
		t.Fatalf("finish %v", w.finish)
	}
	plain, err := account.OpenEnvelope(x25519Browser{w.browser}, w.approver, 1, w.finish["sealed"].(string))
	if err != nil {
		t.Fatalf("the browser can't open the list: %v", err)
	}
	var env webEnvelope
	if err := json.Unmarshal(plain, &env); err != nil || len(env.Machines) != 1 || env.Machines[0].HostID != w.hostID ||
		env.Machines[0].GrantID != "g-1" || env.Machines[0].Relay != "https://guest.herdrup.app" {
		t.Fatalf("envelope %s, %v", plain, err)
	}
}

// A machine on a relay the web app can't reach gets no grant and is listed
// as skipped; with nothing granted the request stays open.
func TestWebAccessSkipsAMachineOnAnotherRelay(t *testing.T) {
	d, w, machine := webAccessDesk(t, "https://relay.example.com")
	ctx := context.Background()
	if ok, _, _ := d.WebAccessCheckCode(ctx, "req-1", w.code(t)); !ok {
		t.Fatal("code refused")
	}
	res, err := d.WebAccessApprove(ctx, "req-1", []string{machine}, "chat", "7d")
	if err != nil || len(res.Granted) != 0 || len(res.Skipped) != 1 || res.Skipped[0].Reason != "relay_not_allowed" {
		t.Fatalf("approve %+v, %v", res, err)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.adds) != 0 || w.finish != nil {
		t.Fatalf("adds %v finish %v", w.adds, w.finish)
	}
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
