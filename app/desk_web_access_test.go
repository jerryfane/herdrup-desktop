package main

import (
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"errors"
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
	// The service as herdrup #792 runs it: the request's state and time
	// left, and the highest envelope seq it holds for this browser and
	// approver (a finish at or below it is 409 stale_seq).
	outcome   string
	expiresIn int
	lastSeq   float64
	finishes  int
	// Faults: finishes answer finishStatus (lost: recorded first), state
	// reads after a finish answer readStatus; old makes the machine an herdr without
	// owner_access; statements, when set, is received from before each
	// statement is given.
	finishStatus int
	lost         bool
	readStatus   int
	old          bool
	statements   chan struct{}
	held         int
	// again opens a new request from the same browser and claims it.
	again func()
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
			switch {
			case w.readStatus != 0 && w.finishes > 0:
				reply(w.readStatus, map[string]any{"error": "unavailable"})
			case w.outcome != "":
				reply(200, map[string]any{"state": w.outcome, "expires_in": w.expiresIn})
			case w.nonceT == nil:
				reply(200, map[string]any{"state": "waiting", "expires_in": w.expiresIn})
			default:
				reply(200, map[string]any{"state": "revealed", "expires_in": w.expiresIn, "nonce_b": b64u(w.nonceB)})
			}
		case r.URL.Path == "/v1/statements":
			if w.statements != nil {
				w.held++
				w.mu.Unlock()
				<-w.statements
				w.mu.Lock()
			}
			hosts := body["hosts"].([]any)
			reply(200, map[string]any{"statements": []any{map[string]any{"host": hosts[0], "jws": "jws-for-" + hosts[0].(string)}}, "exp": 600})
		case r.URL.Path == "/v1/approvals/req-1/finish":
			w.finishes++
			switch {
			case w.outcome == "expired":
				reply(410, map[string]any{"error": "expired"})
			case w.outcome != "":
				reply(409, map[string]any{"error": "already_finished"})
			case w.finishStatus != 0 && !w.lost:
				reply(w.finishStatus, map[string]any{"error": "unavailable"})
			case body["outcome"] == "approved" && body["seq"].(float64) <= w.lastSeq:
				reply(409, map[string]any{"error": "stale_seq"})
			default:
				w.finish, w.outcome = body, body["outcome"].(string)
				if seq, ok := body["seq"].(float64); ok {
					w.lastSeq = seq
				}
				if w.lost {
					reply(w.finishStatus, map[string]any{"error": "unavailable"})
				} else {
					reply(200, map[string]any{})
				}
			}
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
	w := &webAccessWorld{browser: priv, nonceB: []byte(strings.Repeat("b", 32)), owner: fakeherdr.NewOwnerAccess(relay), expiresIn: 600}
	svc := w.service(t)
	var published []WebAccessUpdate
	var pubMu sync.Mutex
	saved := publishWebAccess
	publishWebAccess = func(u WebAccessUpdate) { pubMu.Lock(); published = append(published, u); pubMu.Unlock() }
	t.Cleanup(func() { publishWebAccess = saved })
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		inner := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			w.mu.Lock()
			old := w.old
			w.mu.Unlock()
			if old && strings.HasPrefix(method, "owner_access.") {
				return nil, &fakeherdr.APIError{Code: "invalid_request", Message: "unknown variant `" + method + "`, expected one of `ping`"}
			}
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
	w.again = func() {
		w.mu.Lock()
		w.nonceT, w.outcome, w.finish, w.nonceB = nil, "", nil, []byte(strings.Repeat("c", 32))
		w.mu.Unlock()
		startWebAccess(t, d, w, &published, &pubMu)
	}
	startWebAccess(t, d, w, &published, &pubMu)
	return d, w, ms[0].ID
}

// startWebAccess claims the (new) request and waits for the browser's code.
func startWebAccess(t *testing.T, d *Desk, w *webAccessWorld, published *[]WebAccessUpdate, pubMu *sync.Mutex) {
	t.Helper()
	pubMu.Lock()
	*published = nil
	pubMu.Unlock()
	if err := d.WebAccessStart(context.Background(), "req-1"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the browser's code", func() bool {
		pubMu.Lock()
		defer pubMu.Unlock()
		return len(*published) > 0 && (*published)[0].State == "ready"
	})
}

// typeCode types the browser's code.
func typeCode(t *testing.T, d *Desk, w *webAccessWorld) {
	t.Helper()
	if c, err := d.WebAccessCheckCode(context.Background(), "req-1", w.code(t)); !c.Ok || err != nil {
		t.Fatalf("browser's code: %+v %v", c, err)
	}
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
	plain, err := account.OpenEnvelope(x25519Browser{w.browser}, w.approver, uint64(w.finish["seq"].(float64)), w.finish["sealed"].(string))
	if err != nil {
		t.Fatalf("the browser can't open the list: %v", err)
	}
	var env webEnvelope
	if err := json.Unmarshal(plain, &env); err != nil || env.Seq != uint64(w.finish["seq"].(float64)) || len(env.Machines) != 1 || env.Machines[0].HostID != w.owner.HostID ||
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

// live are the grants that still give access.
func (w *webAccessWorld) live(t *testing.T) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, g := range w.grants(t) {
		if g["revoked"] != true {
			out = append(out, g)
		}
	}
	return out
}

func (w *webAccessWorld) set(f func()) {
	w.mu.Lock()
	defer w.mu.Unlock()
	f()
}

// A browser approved again (a new request, same approving computer) is
// recorded: its report carries a seq above the first, which the service
// requires, and the browser keeps one live grant, the one in its list.
func TestWebAccessApprovingTheSameBrowserAgainIsRecorded(t *testing.T) {
	webNow = func() time.Time { return time.Unix(1_800_000_000, 0) }
	t.Cleanup(func() { webNow = time.Now })
	d, w, machine := webAccessDesk(t, "https://guest.herdrup.app")
	ctx := context.Background()
	typeCode(t, d, w)
	if _, err := d.WebAccessApprove(ctx, "req-1", []string{machine}, "chat", "7d"); err != nil {
		t.Fatal(err)
	}
	w.again()
	typeCode(t, d, w)
	if _, err := d.WebAccessApprove(ctx, "req-1", []string{machine}, "terminal", "1d"); err != nil {
		t.Fatalf("second approval: %v", err)
	}
	live := w.live(t)
	w.mu.Lock()
	defer w.mu.Unlock()
	plain, err := account.OpenEnvelope(x25519Browser{w.browser}, w.approver, uint64(w.finish["seq"].(float64)), w.finish["sealed"].(string))
	var env webEnvelope
	if err == nil {
		err = json.Unmarshal(plain, &env)
	}
	if err != nil || len(live) != 1 || len(env.Machines) != 1 || env.Machines[0].GrantID != live[0]["grant_id"] {
		t.Fatalf("live grants %v, envelope %+v, %v", live, env, err)
	}
}

// A request that ended, or has too little time left, gets no grant on any
// machine.
func TestWebAccessMakesNoGrantForAnEndingRequest(t *testing.T) {
	for _, tc := range []struct {
		name    string
		outcome string
		left    int
	}{{"expired", "expired", 0}, {"20 s left", "", 20}} {
		t.Run(tc.name, func(t *testing.T) {
			d, w, machine := webAccessDesk(t, "https://guest.herdrup.app")
			typeCode(t, d, w)
			w.set(func() { w.outcome, w.expiresIn = tc.outcome, tc.left })
			if _, err := d.WebAccessApprove(context.Background(), "req-1", []string{machine}, "chat", "7d"); err == nil {
				t.Fatal("approved")
			}
			if g := w.grants(t); len(g) != 0 {
				t.Fatalf("grants %v", g)
			}
		})
	}
}

// An approval the service refuses after the grants were made (here it
// expires meanwhile) leaves no live grant.
func TestWebAccessRemovesTheGrantsOfARefusedApproval(t *testing.T) {
	d, w, machine := webAccessDesk(t, "https://guest.herdrup.app")
	typeCode(t, d, w)
	w.statements = make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := d.WebAccessApprove(context.Background(), "req-1", []string{machine}, "chat", "7d")
		done <- err
	}()
	// The request expires while the machine's grant is being made.
	waitFor(t, "the grant in flight", func() bool {
		w.mu.Lock()
		defer w.mu.Unlock()
		return w.held == 1
	})
	w.set(func() { w.outcome = "expired" })
	w.statements <- struct{}{}
	if err := <-done; err == nil {
		t.Fatal("approval reported done")
	}
	if len(w.grants(t)) != 1 {
		t.Fatalf("fixture: grants %v, want the one made", w.grants(t))
	}
	if live := w.live(t); len(live) != 0 {
		t.Fatalf("live grants after the refusal: %v", live)
	}
}

// When the service's answer is lost and its state can't be read, the grants
// stay and the next Approve sends the same report, with no new grant.
func TestWebAccessRetriesTheSameReportAfterALostAnswer(t *testing.T) {
	d, w, machine := webAccessDesk(t, "https://guest.herdrup.app")
	ctx := context.Background()
	typeCode(t, d, w)
	w.set(func() { w.finishStatus, w.readStatus = http.StatusServiceUnavailable, http.StatusServiceUnavailable })
	res, err := d.WebAccessApprove(ctx, "req-1", []string{machine}, "chat", "7d")
	if err != nil || !res.Unsure || res.Problem == "" {
		t.Fatalf("lost answer: %+v, %v", res, err)
	}
	if live := w.live(t); len(live) != 1 {
		t.Fatalf("live grants while unsure: %v", live)
	}
	w.set(func() { w.finishStatus, w.readStatus = 0, 0 })
	res, err = d.WebAccessApprove(ctx, "req-1", []string{machine}, "terminal", "1d")
	if err != nil || res.Unsure || len(res.Granted) != 1 {
		t.Fatalf("retry: %+v, %v", res, err)
	}
	if g := w.grants(t); len(g) != 1 || g[0]["scope"] != "chat" {
		t.Fatalf("grants %v, want the first one only", g)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.finishes != 2 || w.outcome != "approved" || w.finish["scope"] != "chat" {
		t.Fatalf("finishes %d, outcome %q, finish %v", w.finishes, w.outcome, w.finish)
	}
}

// Deny is refused while an approval is in flight, and a denial the service
// doesn't take is an error the page shows, not a closed request.
func TestWebAccessDenyWaitsForApprovalAndReportsAFailedDenial(t *testing.T) {
	d, w, machine := webAccessDesk(t, "https://guest.herdrup.app")
	ctx := context.Background()
	typeCode(t, d, w)
	w.statements = make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := d.WebAccessApprove(ctx, "req-1", []string{machine}, "chat", "7d")
		done <- err
	}()
	waitFor(t, "the approval in flight", func() bool {
		w.mu.Lock()
		defer w.mu.Unlock()
		return w.held == 1
	})
	if err := d.WebAccessDeny(ctx, "req-1"); !errors.Is(err, errWebAccessBusy) {
		t.Fatalf("deny during approval: %v", err)
	}
	w.statements <- struct{}{}
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	w.again()
	w.set(func() { w.finishStatus = http.StatusServiceUnavailable })
	if err := d.WebAccessDeny(ctx, "req-1"); err == nil {
		t.Fatal("a refused denial reported done")
	}
	w.set(func() { w.finishStatus = 0 })
	if err := d.WebAccessDeny(ctx, "req-1"); err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.outcome != "denied" {
		t.Fatalf("outcome %q", w.outcome)
	}
}

// A herdr without owner_access (its unknown-method answer, which the engine
// turns into ErrUnsupported) is skipped as needs_update.
func TestWebAccessSkipsAnOlderHerdrAsNeedsUpdate(t *testing.T) {
	d, w, machine := webAccessDesk(t, "https://guest.herdrup.app")
	typeCode(t, d, w)
	w.set(func() { w.old = true })
	res, err := d.WebAccessApprove(context.Background(), "req-1", []string{machine}, "chat", "7d")
	if err != nil || len(res.Skipped) != 1 || res.Skipped[0].Reason != "needs_update" || len(res.Failed) != 0 {
		t.Fatalf("approve %+v, %v", res, err)
	}
}

// Seqs only grow: within one millisecond, and after a restart with the clock
// set back (the last seq is on disk).
func TestWebSeqAlwaysGrows(t *testing.T) {
	t.Cleanup(func() { webNow = time.Now })
	dir := t.TempDir()
	key := []byte(strings.Repeat("k", 32))
	webNow = func() time.Time { return time.Unix(1_800_000_000, 0) }
	first := &Desk{dir: dir}
	a, err1 := first.nextWebSeq(key)
	b, err2 := first.nextWebSeq(key)
	if err1 != nil || err2 != nil || a < uint64(time.Unix(1_800_000_000, 0).UnixMilli()) || b <= a {
		t.Fatalf("seqs %d then %d (%v, %v)", a, b, err1, err2)
	}
	webNow = func() time.Time { return time.Unix(1_800_000_000, 0).Add(-time.Hour) }
	restarted := &Desk{dir: dir}
	if c, err := restarted.nextWebSeq(key); err != nil || c <= b {
		t.Fatalf("after a restart with the clock set back: %d after %d (%v)", c, b, err)
	}
}

// Twenty ticked machines fit a fresh request: the time check is the
// request's own deadline, not a fixed time per machine.
func TestWebAccessManyMachinesFitAFreshRequest(t *testing.T) {
	d, w, machine := webAccessDesk(t, "https://guest.herdrup.app")
	ids := []string{machine}
	d.storeMu.Lock()
	st, err := d.load()
	for i := range 20 {
		m := Machine{Host: fmt.Sprintf("box%02d.example", i), User: "me"}
		st.Machines = append(st.Machines, m)
		ids = append(ids, machineID(m))
	}
	if err == nil {
		err = d.store(st)
	}
	d.storeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	typeCode(t, d, w)
	res, err := d.WebAccessApprove(context.Background(), "req-1", ids, "chat", "7d")
	if err != nil || len(res.Granted) != 1 || len(res.Skipped) != 20 {
		t.Fatalf("approve: granted %v, skipped %d, failed %v, %v", res.Granted, len(res.Skipped), res.Failed, err)
	}
	if live := w.live(t); len(live) != 1 {
		t.Fatalf("live grants %v", live)
	}
}

// After an approval whose answer was lost, Deny never removes a grant the
// service may have published: not when its state can't be read, not when
// Deny is tried again, and not once the service shows the approval.
func TestWebAccessDenyKeepsTheGrantsOfAnApprovalThatWentThrough(t *testing.T) {
	d, w, machine := webAccessDesk(t, "https://guest.herdrup.app")
	ctx := context.Background()
	typeCode(t, d, w)
	// The service records the approval, but its answer and later reads fail.
	w.set(func() {
		w.finishStatus, w.lost, w.readStatus = http.StatusServiceUnavailable, true, http.StatusServiceUnavailable
	})
	if res, err := d.WebAccessApprove(ctx, "req-1", []string{machine}, "chat", "7d"); err != nil || !res.Unsure {
		t.Fatalf("lost answer: %+v, %v", res, err)
	}
	for try := 1; try <= 2; try++ {
		if err := d.WebAccessDeny(ctx, "req-1"); err == nil {
			t.Fatalf("deny %d reported done while the outcome is unknown", try)
		}
		if live := w.live(t); len(live) != 1 {
			t.Fatalf("after deny %d: live grants %v", try, live)
		}
	}
	w.set(func() { w.readStatus = 0 })
	if err := d.WebAccessDeny(ctx, "req-1"); !errors.Is(err, errAlreadyOver) {
		t.Fatalf("deny once the approval shows: %v", err)
	}
	if live := w.live(t); len(live) != 1 {
		t.Fatalf("live grants %v", live)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.outcome != "approved" {
		t.Fatalf("outcome %q", w.outcome)
	}
}
