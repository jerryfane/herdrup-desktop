package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// pingStub is the relay: it records each request and answers with status.
type pingStub struct {
	mu       sync.Mutex
	status   int
	bodies   []string
	types    []string
	requests []string
	block    chan struct{} // when set, requests wait for it or their cancellation
	arrived  chan struct{}
}

func newPingStub(t *testing.T) (*pingStub, *httptest.Server) {
	stub := &pingStub{status: http.StatusNoContent, arrived: make(chan struct{}, 8)}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		stub.mu.Lock()
		stub.bodies = append(stub.bodies, string(body))
		stub.types = append(stub.types, r.Header.Get("Content-Type"))
		stub.requests = append(stub.requests, r.Method+" "+r.URL.Path)
		status, block := stub.status, stub.block
		stub.mu.Unlock()
		stub.arrived <- struct{}{}
		if block != nil {
			select {
			case <-block:
			case <-r.Context().Done():
				return
			}
		}
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	return stub, srv
}

func (s *pingStub) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.bodies)
}

func (s *pingStub) body(i int) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bodies[i]
}

type pingClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *pingClock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *pingClock) set(t time.Time) { c.mu.Lock(); c.t = t; c.mu.Unlock() }

func testPinger(t *testing.T, url string) (*usagePing, *pingClock) {
	t.Helper()
	clock := &pingClock{t: time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)}
	p := newUsagePing(filepath.Join(t.TempDir(), "usage-ping.json"), "desktop-linux", "0.1.0-preview.5")
	p.url, p.now = url, clock.now
	return p, clock
}

func readPingState(t *testing.T, p *usagePing) (usagePingState, string) {
	t.Helper()
	data, err := os.ReadFile(p.path)
	if err != nil {
		t.Fatal(err)
	}
	var state usagePingState
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	return state, string(data)
}

var installPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

func TestUsagePingSendsExactlyTheContractBody(t *testing.T) {
	stub, srv := newPingStub(t)
	p, _ := testPinger(t, srv.URL+"/v1/ping")
	if !p.ping() {
		t.Fatal("the relay's 204 was not taken as an accepted ping")
	}
	state, _ := readPingState(t, p)
	if !installPattern.MatchString(state.Install) {
		t.Fatalf("install ID %q is not 22 base64url characters", state.Install)
	}
	want := `{"v":1,"install":"` + state.Install + `","app":"desktop-linux","version":"0.1.0-preview.5","build":"0.1.0-preview.5"}`
	if stub.count() != 1 || stub.body(0) != want {
		t.Fatalf("bodies = %q, want exactly [%s]", stub.bodies, want)
	}
	if stub.requests[0] != "POST /v1/ping" || stub.types[0] != "application/json" {
		t.Fatalf("request = %q with Content-Type %q", stub.requests[0], stub.types[0])
	}
	if state.LastPing != "2026-11-02" {
		t.Fatalf("lastPing = %q, want the UTC date of the accepted ping", state.LastPing)
	}
}

func TestUsagePingIDsAreRandom(t *testing.T) {
	seen := map[string]bool{}
	for range 64 {
		id, err := newInstallID()
		if err != nil {
			t.Fatal(err)
		}
		if !installPattern.MatchString(id) || seen[id] {
			t.Fatalf("install ID %q is malformed or repeated", id)
		}
		seen[id] = true
	}
}

func TestUsagePingAtMostOncePerUTCDay(t *testing.T) {
	stub, srv := newPingStub(t)
	p, clock := testPinger(t, srv.URL)
	p.ping()
	clock.set(time.Date(2026, 11, 2, 23, 59, 0, 0, time.UTC))
	p.ping()
	// Already 3 November on this clock's wall, still 2 November in UTC.
	clock.set(time.Date(2026, 11, 3, 0, 30, 0, 0, time.FixedZone("UTC+2", 2*60*60)))
	p.ping()
	if n := stub.count(); n != 1 {
		t.Fatalf("%d pings on one UTC day, want 1", n)
	}
	clock.set(time.Date(2026, 11, 3, 0, 1, 0, 0, time.UTC))
	if !p.ping() || stub.count() != 2 {
		t.Fatalf("no ping on the next UTC day (%d sent)", stub.count())
	}
	if stub.body(0) != stub.body(1) {
		t.Fatalf("the install changed between days: %s then %s", stub.body(0), stub.body(1))
	}
}

func TestUsagePingFailureWaitsForTheNextTrigger(t *testing.T) {
	stub, srv := newPingStub(t)
	stub.status = http.StatusNotFound // the endpoint is not live yet
	p, _ := testPinger(t, srv.URL)
	if p.ping() {
		t.Fatal("a 404 counted as an accepted ping")
	}
	time.Sleep(150 * time.Millisecond)
	if n := stub.count(); n != 1 {
		t.Fatalf("%d requests after one failed trigger, want 1 (no retry loop)", n)
	}
	if state, _ := readPingState(t, p); state.LastPing != "" {
		t.Fatalf("a failed ping stored lastPing %q", state.LastPing)
	}
	stub.mu.Lock()
	stub.status = http.StatusNoContent
	stub.mu.Unlock()
	if !p.ping() || stub.count() != 2 {
		t.Fatalf("the next trigger did not try again (%d sent)", stub.count())
	}
	if stub.body(0) != stub.body(1) {
		t.Fatal("the retry sent another install ID")
	}

	// An unreachable relay is just another failure.
	srv.Close()
	p2, _ := testPinger(t, srv.URL)
	if p2.ping() {
		t.Fatal("an unreachable relay counted as an accepted ping")
	}
}

func TestUsagePingOffDeletesTheIDAndSendsNothing(t *testing.T) {
	stub, srv := newPingStub(t)
	p, clock := testPinger(t, srv.URL)
	p.ping()
	old, _ := readPingState(t, p)
	if err := p.setEnabled(false); err != nil {
		t.Fatal(err)
	}
	state, raw := readPingState(t, p)
	if !state.Off || state.Install != "" || strings.Contains(raw, old.Install) {
		t.Fatalf("after off the store is %s, want no install ID", raw)
	}
	if on, err := p.enabled(); err != nil || on {
		t.Fatalf("enabled() = %v, %v after off", on, err)
	}
	clock.set(time.Date(2026, 11, 3, 9, 0, 0, 0, time.UTC))
	p.ping()
	if n := stub.count(); n != 1 {
		t.Fatalf("%d pings, want none after off", n-1)
	}
	if _, raw := readPingState(t, p); raw != `{"off":true}` {
		t.Fatalf("a trigger while off wrote %s", raw)
	}
}

func TestUsagePingOffEndsAPingInFlight(t *testing.T) {
	stub, srv := newPingStub(t)
	stub.block = make(chan struct{})
	p, _ := testPinger(t, srv.URL)
	done := make(chan bool)
	go func() { done <- p.ping() }()
	<-stub.arrived
	if err := p.setEnabled(false); err != nil {
		t.Fatal(err)
	}
	select {
	case accepted := <-done:
		if accepted {
			t.Fatal("the ping in flight still counted after off")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("off did not end the ping in flight")
	}
	close(stub.block)
	if _, raw := readPingState(t, p); raw != `{"off":true}` {
		t.Fatalf("the ended ping wrote %s over off", raw)
	}
}

func TestUsagePingOnMakesANewID(t *testing.T) {
	stub, srv := newPingStub(t)
	p, clock := testPinger(t, srv.URL)
	if on, err := p.enabled(); err != nil || !on {
		t.Fatalf("enabled() = %v, %v with no setting, want on", on, err)
	}
	p.ping()
	old, _ := readPingState(t, p)
	if err := p.setEnabled(false); err != nil {
		t.Fatal(err)
	}
	if err := p.setEnabled(true); err != nil {
		t.Fatal(err)
	}
	fresh, _ := readPingState(t, p)
	if fresh.Off || !installPattern.MatchString(fresh.Install) || fresh.Install == old.Install {
		t.Fatalf("after on the install is %q (was %q), want a new one", fresh.Install, old.Install)
	}
	clock.set(time.Date(2026, 11, 3, 9, 0, 0, 0, time.UTC))
	if !p.ping() || !strings.Contains(stub.body(1), `"install":"`+fresh.Install+`"`) {
		t.Fatalf("the next ping did not carry the new ID: %s", stub.body(stub.count()-1))
	}
}

func TestDeskShareUsageCountSwitch(t *testing.T) {
	d := newDesk(t.TempDir())
	if on, err := d.GetShareUsageCount(); err != nil || !on {
		t.Fatalf("GetShareUsageCount() = %v, %v, want on by default", on, err)
	}
	if err := d.SetShareUsageCount(false); err != nil {
		t.Fatal(err)
	}
	if on, _ := d.GetShareUsageCount(); on {
		t.Fatal("the switch stayed on")
	}
	data, err := os.ReadFile(filepath.Join(d.dir, "usage-ping.json"))
	if err != nil || string(data) != `{"off":true}` {
		t.Fatalf("usage-ping.json = %q, %v", data, err)
	}
}

func TestUsagePingNeverSendsWithoutAURL(t *testing.T) {
	stub, srv := newPingStub(t)
	_ = srv
	// A desk built in tests, as everywhere but main, has no URL.
	d := newDesk(t.TempDir())
	d.usage.app, d.usage.version = "desktop-linux", "0.1.0-preview.5"
	if d.usage.ping() || stub.count() != 0 {
		t.Fatal("a desk without a URL sent a ping")
	}
	if _, err := os.Stat(d.usage.path); !os.IsNotExist(err) {
		t.Fatalf("a desk without a URL made an install ID (%v)", err)
	}
	// Nor with a version or platform the relay would reject.
	for _, bad := range []struct{ app, version string }{{"", "0.1.0"}, {"desktop-linux", ""}, {"desktop-linux", strings.Repeat("9", 33)}, {"desktop-linux", "1.0 beta"}} {
		p, _ := testPinger(t, srv.URL)
		p.app, p.version = bad.app, bad.version
		if p.ping() || stub.count() != 0 {
			t.Fatalf("pinged with app %q version %q", bad.app, bad.version)
		}
	}
}

func TestUsagePingURLIsOffInCapturesUnlessStubbed(t *testing.T) {
	saved := smoke
	t.Cleanup(func() { smoke = saved })
	t.Setenv("HERDRUP_USAGE_PING_URL", "")
	t.Setenv("HERDRUP_REF_STATE", "")

	smoke = ""
	if got := usagePingURL(); got != usagePingRelay {
		t.Fatalf("release build URL = %q", got)
	}
	smoke = "1"
	if got := usagePingURL(); got != "" {
		t.Fatalf("smoke build URL = %q, want none", got)
	}
	t.Setenv("HERDRUP_REF_STATE", "/tmp/ref.json")
	if got := usagePingURL(); got != "" {
		t.Fatalf("reference capture URL = %q, want none", got)
	}
	t.Setenv("HERDRUP_USAGE_PING_URL", "http://127.0.0.1:9/v1/ping")
	if got := usagePingURL(); got != "http://127.0.0.1:9/v1/ping" {
		t.Fatalf("stubbed reference capture URL = %q", got)
	}
	smoke = ""
	if got := usagePingURL(); got != "http://127.0.0.1:9/v1/ping" {
		t.Fatalf("stubbed release URL = %q", got)
	}
}

func TestUsagePingApp(t *testing.T) {
	for goos, want := range map[string]string{"darwin": "desktop-macos", "linux": "desktop-linux", "windows": "desktop-windows", "freebsd": ""} {
		if got := usagePingApp(goos); got != want {
			t.Errorf("usagePingApp(%q) = %q, want %q", goos, got, want)
		}
	}
}
