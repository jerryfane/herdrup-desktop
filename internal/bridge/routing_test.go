package bridge_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// eventually waits up to 5 s for cond.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func multiOpens(m *machine) int {
	n := 0
	for _, cmd := range m.srv.Commands() {
		if strings.Contains(cmd, "api-bridge --multi") {
			n++
		}
	}
	return n
}

func TestRequestsGoPerRequestUntilTheCapabilityIsKnown(t *testing.T) {
	m := startMachine(t, nil)
	c := m.dial(t)
	ctx := context.Background()

	// No ping yet: the client does not know whether herdr has --multi.
	if err := c.Call(ctx, "agent.list", nil, nil); err != nil {
		t.Fatal(err)
	}
	// The background capability ping may already have opened --multi (its
	// opening ping goes there), so check the request itself, not the channel.
	if onMulti, perRequest := routes(m); slices.Contains(onMulti, "agent.list") || !slices.Contains(perRequest, "agent.list") {
		t.Fatalf("first agent.list: on --multi %q, per-request %q; want it per-request before the capability was known", onMulti, perRequest)
	}
	// A background ping learns it and opens the channel.
	eventually(t, "the --multi channel to open", func() bool {
		onMulti, _ := routes(m)
		return slices.Contains(onMulti, "ping")
	})
	if err := c.Call(ctx, "agent.list", nil, nil); err != nil {
		t.Fatal(err)
	}
	onMulti, perRequest := routes(m)
	slices.Sort(perRequest) // the capability ping races the first agent.list
	if !slices.Equal(perRequest, []string{"agent.list", "ping"}) {
		t.Errorf("per-request %q, want the first agent.list and the capability ping", perRequest)
	}
	if !slices.Equal(onMulti, []string{"ping", "agent.list"}) {
		t.Errorf("on --multi %q, want the opening ping and the second agent.list", onMulti)
	}
}

func TestMultiThatFailsToOpenFallsBackPerRequestWithoutError(t *testing.T) {
	// herdr advertises api_bridge_multi, but the herdr binary the SSH
	// shell finds first is older and refuses --multi.
	m := startMachine(t, func(s *fakeherdr.Server) { s.NoMulti = true })
	c := m.dial(t)
	ctx := context.Background()
	for _, method := range []string{"ping", "agent.list", "agent.list", "agent.list"} {
		var res struct{ Method string }
		if err := c.Call(ctx, method, nil, &res); err != nil {
			t.Fatalf("%s failed although the per-request path works: %v", method, err)
		}
	}
	if n := multiOpens(m); n != 1 {
		t.Errorf("tried --multi %d times, want once until the retry delay passes", n)
	}
	if _, perRequest := routes(m); len(perRequest) != 4 {
		t.Errorf("per-request %q, want all four", perRequest)
	}
}

func TestStreamingMethodsNeverRideMulti(t *testing.T) {
	m := startMachine(t, nil)
	c := m.dial(t)
	ctx := context.Background()
	if err := c.Call(ctx, "ping", nil, nil); err != nil {
		t.Fatal(err)
	}
	streaming := []string{"events.subscribe", "pane.stream", "pane.input.stream",
		"gram.upload.stream", "server.ssh_agent.register"}
	for _, method := range streaming {
		if err := c.Call(ctx, method, nil, nil); err != nil {
			t.Errorf("%s: %v", method, err)
		}
	}
	// A routable request after them still uses the channel.
	if err := c.Call(ctx, "agent.list", nil, nil); err != nil {
		t.Fatal(err)
	}
	onMulti, perRequest := routes(m)
	for _, method := range streaming {
		if slices.Contains(onMulti, method) {
			t.Errorf("%s went on --multi", method)
		}
		if !slices.Contains(perRequest, method) {
			t.Errorf("%s did not go per-request", method)
		}
	}
	if !slices.Contains(onMulti, "agent.list") {
		t.Errorf("agent.list did not use --multi: %q", onMulti)
	}
}

func TestRequestsOverOneMiBNeverRideMulti(t *testing.T) {
	m := startMachine(t, nil)
	c := m.dial(t)
	ctx := context.Background()
	if err := c.Call(ctx, "ping", nil, nil); err != nil {
		t.Fatal(err)
	}

	// Too big for an exec argument but within herdr's --multi line limit:
	// the channel carries it.
	mid := map[string]string{"text": strings.Repeat("a", 200<<10)}
	if err := c.Call(ctx, "mid", mid, nil); err != nil {
		t.Fatalf("a 200 KiB request failed: %v", err)
	}

	// Over the --multi line limit: it must not be written to the channel,
	// and the per-request path refuses it locally.
	big := map[string]string{"text": strings.Repeat("a", 1<<20)}
	err := c.Call(ctx, "big", big, nil)
	if err == nil || !strings.Contains(err.Error(), "too large") {
		t.Errorf("got %v, want the per-request path's too-large error", err)
	}
	var apiErr *bridge.APIError
	if errors.As(err, &apiErr) {
		t.Errorf("herdr saw the request: %v", err)
	}
	onMulti, _ := routes(m)
	if !slices.Contains(onMulti, "mid") {
		t.Errorf("the 200 KiB request did not use --multi: %q", onMulti)
	}
	if slices.Contains(onMulti, "big") {
		t.Errorf("the request over 1 MiB went on --multi")
	}
}

func TestSeventeenthConcurrentRequestWaitsForASlot(t *testing.T) {
	release := make(chan struct{})
	m := startMachine(t, func(s *fakeherdr.Server) {
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "block" {
				<-release
			}
			return echoHandler(method, params)
		}
	})
	c := m.dial(t)
	ctx := context.Background()
	if err := c.Call(ctx, "ping", nil, nil); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	errs := make(chan error, 17)
	for range 17 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- c.Call(ctx, "block", nil, nil)
		}()
	}
	eventually(t, "16 requests in flight", func() bool {
		now, _ := m.srv.MultiInFlight()
		return now == 16
	})
	// Give a 17th request time to arrive if the client would send it.
	time.Sleep(200 * time.Millisecond)
	if now, peak := m.srv.MultiInFlight(); now != 16 || peak != 16 {
		t.Errorf("in flight %d (peak %d), want 16", now, peak)
	}
	if _, perRequest := routes(m); slices.Contains(perRequest, "block") {
		t.Errorf("a request beyond the limit went per-request instead of waiting")
	}
	close(release)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Error(err)
		}
	}
	onMulti, _ := routes(m)
	blocks := 0
	for _, method := range onMulti {
		if method == "block" {
			blocks++
		}
	}
	if blocks != 17 {
		t.Errorf("%d block requests on --multi, want 17", blocks)
	}
	if _, peak := m.srv.MultiInFlight(); peak != 16 {
		t.Errorf("peak in flight %d, want 16", peak)
	}
}

func TestForSessionSharesTheConnection(t *testing.T) {
	m := startMachine(t, nil)
	c := m.dial(t)
	work, err := c.ForSession("work")
	if err != nil {
		t.Fatal(err)
	}
	if work.Session() != "work" || c.Session() != "" {
		t.Fatalf("sessions %q and %q", c.Session(), work.Session())
	}
	if work.Done() != c.Done() {
		t.Error("the session view has its own connection")
	}
	ctx := context.Background()
	if err := work.Call(ctx, "agent.list", nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := c.Call(ctx, "agent.list", nil, nil); err != nil {
		t.Fatal(err)
	}
	var sessions []string
	for _, r := range m.srv.Requests() {
		if r.Method == "agent.list" {
			sessions = append(sessions, r.Session)
		}
	}
	if !slices.Equal(sessions, []string{"work", ""}) {
		t.Errorf("agent.list went to sessions %q, want work, then the default session", sessions)
	}
	if _, err := c.ForSession("no spaces"); err == nil {
		t.Error("accepted an invalid session name")
	}
}

// hangingMachine answers "hang" only once the test ends, as a herdr whose
// request is stuck, and opens the --multi channel.
func hangingMachine(t *testing.T) (*machine, *bridge.Client) {
	t.Helper()
	release := make(chan struct{})
	m := startMachine(t, func(s *fakeherdr.Server) {
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "hang" {
				<-release
			}
			return echoHandler(method, params)
		}
	})
	t.Cleanup(func() { close(release) })
	c := m.dial(t)
	if err := c.Call(context.Background(), "ping", nil, nil); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the --multi channel to open", func() bool {
		onMulti, _ := routes(m)
		return slices.Contains(onMulti, "ping")
	})
	return m, c
}

func TestAbandonedRequestsHoldingEverySlotReopenTheChannel(t *testing.T) {
	m, c := hangingMachine(t)
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			if err := c.Call(ctx, "hang", nil, nil); !errors.Is(err, context.DeadlineExceeded) {
				t.Errorf("hang: got %v, want its deadline", err)
			}
		}()
	}
	wg.Wait()
	// Every slot of the first channel is held by a request herdr never
	// answers; a new request must not wait for one.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.Call(ctx, "agent.list", nil, nil); err != nil {
		t.Fatalf("a request after 16 abandoned ones: %v", err)
	}
	if n := multiOpens(m); n != 2 {
		t.Errorf("opened --multi %d times, want a second channel", n)
	}
	if onMulti, _ := routes(m); !slices.Contains(onMulti, "agent.list") {
		t.Errorf("the request did not use the new channel: %q", onMulti)
	}
}

func TestAbandonedRequestUnansweredPastTheGraceRetiresTheChannel(t *testing.T) {
	bridge.SetAbandonGrace(t, 100*time.Millisecond)
	m, c := hangingMachine(t)
	// A live request on the first channel, answered after the retirement.
	live := make(chan error, 1)
	go func() { live <- c.Call(context.Background(), "slow", map[string]int{"DelayMs": 600}, nil) }()
	eventually(t, "the slow request to arrive", func() bool {
		onMulti, _ := routes(m)
		return slices.Contains(onMulti, "slow")
	})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := c.Call(ctx, "hang", nil, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("hang: got %v, want its deadline", err)
	}
	time.Sleep(250 * time.Millisecond) // past the grace
	if err := c.Call(context.Background(), "agent.list", nil, nil); err != nil {
		t.Fatal(err)
	}
	if n := multiOpens(m); n != 2 {
		t.Errorf("opened --multi %d times, want a second channel after the grace", n)
	}
	if err := <-live; err != nil {
		t.Errorf("the live request on the retired channel failed: %v", err)
	}
}
