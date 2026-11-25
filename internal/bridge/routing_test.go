package bridge_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
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

// #476: requests held to one --multi channel all go on it, the herdr that
// answered the first answering the rest; once it ended, a request goes on
// no other channel (one that may reach a restarted herdr) and not
// per-request either: it fails ErrNotSent, unsent.
func TestARequestHeldToOneChannelGoesOnNoOther(t *testing.T) {
	m := startMachine(t, nil)
	c := m.dial(t)
	ctx := context.Background()
	err := c.OnOneChannel(ctx, func(h *bridge.HeldChannel) error {
		if err := h.Ping(ctx, nil); err != nil {
			return err
		}
		if err := h.Call(ctx, "agent.list", nil, nil); err != nil {
			return err
		}
		m.srv.EndMultiChannels()
		eventually(t, "the held channel to end", func() bool { return !bridge.MultiAlive(c) })
		if err := h.Call(ctx, "pane.send_text", nil, nil); !errors.Is(err, bridge.ErrNotSent) {
			t.Errorf("a request after the held channel ended: %v, want ErrNotSent", err)
		}
		// A ping after an answer stays on the held channel too.
		if err := h.Ping(ctx, nil); !errors.Is(err, bridge.ErrNotSent) {
			t.Errorf("a ping after the held channel answered and ended: %v, want ErrNotSent", err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var held []int // the --multi channel of each request work sent
	for _, r := range m.srv.Requests() {
		if r.Method == "pane.send_text" {
			t.Fatalf("the request went out after its channel ended: %+v", r)
		}
		if r.Multi {
			held = append(held, r.Channel)
		}
	}
	// The channel's own opening ping, then work's ping and agent.list.
	if len(held) != 3 || held[0] != held[1] || held[1] != held[2] {
		t.Fatalf("requests %+v; want the held ping and agent.list on the one --multi channel", m.srv.Requests())
	}
}

// heldPing sends a ping held to one --multi channel and returns the
// channel it went on.
func heldPing(t *testing.T, m *machine, c *bridge.Client) int {
	t.Helper()
	before := len(m.srv.Requests())
	if err := c.OnOneChannel(context.Background(), func(h *bridge.HeldChannel) error {
		return h.Ping(context.Background(), nil)
	}); err != nil {
		t.Fatalf("held ping: %v", err)
	}
	// The last ping on --multi: work's (a fresh channel's opening ping
	// comes before it, on the same channel).
	reqs := m.srv.Requests()[before:]
	for i := len(reqs) - 1; i >= 0; i-- {
		if reqs[i].Method == "ping" && reqs[i].Multi {
			return reqs[i].Channel
		}
	}
	t.Fatalf("requests %+v; want the held ping on --multi", reqs)
	return 0
}

// #476 (#481): after the session's channel ended (a herdr restart), the
// next held requests open a fresh channel and go there, rather than fail.
func TestHeldRequestsOpenAFreshChannelAfterTheLastEnded(t *testing.T) {
	m := startMachine(t, nil)
	c := m.dial(t)
	first := heldPing(t, m, c)
	m.srv.EndMultiChannels()
	eventually(t, "the client to hear its channel end", func() bool { return !bridge.MultiAlive(c) })
	if second := heldPing(t, m, c); second == first {
		t.Fatalf("the held ping went on channel %d again, want a fresh one", second)
	}
}

// #476 (#481): the channel taken may already have ended without the client
// having heard: the held ping dies with it, unanswered, and goes on a fresh
// channel in its place (nothing was learnt from the ended one).
func TestAHeldChannelThatEndsBeforeAnsweringIsReplaced(t *testing.T) {
	var armed atomic.Bool
	m := startMachine(t, func(s *fakeherdr.Server) {
		s.EndMultiOn = func(method string) bool { return method == "ping" && armed.CompareAndSwap(true, false) }
	})
	c := m.dial(t)
	first := heldPing(t, m, c)
	armed.Store(true)
	if second := heldPing(t, m, c); second == first {
		t.Fatalf("the held ping was answered on channel %d, the one that ended", second)
	}
}

// #476: a request not marked idempotent is sent at most once, first or
// not: when the held channel ends under it before it answers, it fails
// and is never sent again, on a fresh channel or per-request.
func TestANonIdempotentFirstRequestIsSentAtMostOnce(t *testing.T) {
	m := startMachine(t, func(s *fakeherdr.Server) {
		s.EndMultiOn = func(method string) bool { return method == "pane.send_text" }
	})
	c := m.dial(t)
	heldPing(t, m, c) // the session's channel is open
	var sendErr error
	if err := c.OnOneChannel(context.Background(), func(h *bridge.HeldChannel) error {
		sendErr = h.Call(context.Background(), "pane.send_text", nil, nil)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if sendErr == nil {
		t.Fatal("a request whose channel ended under it, unanswered, succeeded")
	}
	// herdr got it once, its channel ending under it; no copy went anywhere
	// else.
	copies := 0
	for _, r := range m.srv.Requests() {
		if r.Method == "pane.send_text" {
			copies++
		}
	}
	if copies != 1 {
		t.Fatalf("pane.send_text sent %d times, want once: %v", copies, sendErr)
	}
}

// #481 review: a held request whose context ended before it was written is
// unsent (ErrNotSent) and keeps its cause (context.Canceled); herdr never
// gets it.
func TestAHeldRequestCancelledBeforeItsWriteIsUnsent(t *testing.T) {
	m := startMachine(t, nil)
	c := m.dial(t)
	heldPing(t, m, c) // the session's channel is open
	var sendErr error
	if err := c.OnOneChannel(context.Background(), func(h *bridge.HeldChannel) error {
		ended, cancel := context.WithCancel(context.Background())
		cancel()
		sendErr = h.Call(ended, "pane.send_text", nil, nil)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(sendErr, bridge.ErrNotSent) || !errors.Is(sendErr, context.Canceled) {
		t.Fatalf("%v; want ErrNotSent with context.Canceled", sendErr)
	}
	for _, r := range m.srv.Requests() {
		if r.Method == "pane.send_text" {
			t.Fatalf("the cancelled request went out: %+v", r)
		}
	}
}

// #481 review: when the per-request probe for --multi fails, the held
// channel's refusal keeps the probe's error with ErrNotSent, so a failed
// probe is told apart from a herdr with no --multi channel to give.
func TestAFailedProbeForAHeldChannelKeepsItsError(t *testing.T) {
	for _, c := range []struct {
		name  string
		probe func(method string, params json.RawMessage) (any, *fakeherdr.APIError)
		code  string
	}{
		{"probe refused", func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "ping" {
				return nil, &fakeherdr.APIError{Code: "server_unavailable", Message: "busy"}
			}
			return echoHandler(method, params)
		}, "server_unavailable"},
		{"no --multi", func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "ping" {
				return fakeherdr.Pong(false), nil
			}
			return echoHandler(method, params)
		}, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			m := startMachine(t, func(s *fakeherdr.Server) { s.Handle = c.probe })
			err := m.dial(t).OnOneChannel(context.Background(), func(*bridge.HeldChannel) error {
				t.Fatal("work ran without a channel")
				return nil
			})
			var api *bridge.APIError
			if !errors.Is(err, bridge.ErrNotSent) || errors.As(err, &api) != (c.code != "") || c.code != "" && api.Code != c.code {
				t.Fatalf("%v; want ErrNotSent, with the probe's %q error when it failed", err, c.code)
			}
		})
	}
}

// #492: only a successful pong teaches the capability. A probe herdr
// refused leaves it unknown, so the next held channel probes again, and
// gets one from that pong.
func TestARefusedProbeLeavesTheCapabilityUnknown(t *testing.T) {
	var pings atomic.Int32
	m := startMachine(t, func(s *fakeherdr.Server) {
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "ping" && pings.Add(1) == 1 {
				return nil, &fakeherdr.APIError{Code: "server_unavailable", Message: "busy"}
			}
			return echoHandler(method, params)
		}
	})
	c := m.dial(t)
	var api *bridge.APIError
	if err := c.OnOneChannel(context.Background(), func(*bridge.HeldChannel) error {
		t.Fatal("work ran without a channel")
		return nil
	}); !errors.Is(err, bridge.ErrNotSent) || !errors.As(err, &api) || api.Code != "server_unavailable" {
		t.Fatalf("%v; want ErrNotSent with the refused probe's error", err)
	}
	if err := c.OnOneChannel(context.Background(), func(h *bridge.HeldChannel) error {
		return h.Ping(context.Background(), nil)
	}); err != nil {
		t.Fatalf("%v; want a held channel once a probe is answered", err)
	}
}

// #492: a call whose deadline ends while the session's --multi channel is
// still opening takes no other path, and fails unsent keeping its cause:
// ErrNotSent with context.DeadlineExceeded. The channel's opening ping is
// held until the test ends, so the open can't finish first.
func TestACallWhoseDeadlineEndsWhileTheChannelOpensKeepsItsCause(t *testing.T) {
	release := make(chan struct{})
	var pings atomic.Int32
	m := startMachine(t, func(s *fakeherdr.Server) {
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "ping" && pings.Add(1) > 1 {
				<-release // the channel's opening ping: the open waits
			}
			return echoHandler(method, params)
		}
	})
	t.Cleanup(func() { close(release) })
	c := m.dial(t)
	if err := c.Call(context.Background(), "ping", nil, nil); err != nil {
		t.Fatal(err) // per-request: learns --multi, and the open starts
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	err := c.Call(ctx, "agent.list", nil, nil)
	if !errors.Is(err, bridge.ErrNotSent) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("%v; want ErrNotSent with context.DeadlineExceeded", err)
	}
	for _, r := range m.srv.Requests() {
		if r.Method == "agent.list" {
			t.Fatalf("agent.list went out after its deadline: %+v", r)
		}
	}
}

// cancelOnEncode is request params whose encoding ends the call's context:
// the request is cancelled while it is being encoded.
type cancelOnEncode struct{ cancel context.CancelFunc }

func (p cancelOnEncode) MarshalJSON() ([]byte, error) {
	p.cancel()
	return []byte(`{}`), nil
}

// #492: a held request cancelled while it is encoded is never written,
// whichever of a free slot and the cancellation the channel's select picks:
// the write boundary checks the context, so none of them reaches herdr,
// and each fails ErrNotSent with context.Canceled.
func TestAHeldRequestCancelledWhileEncodedIsNeverWritten(t *testing.T) {
	m := startMachine(t, nil)
	c := m.dial(t)
	heldPing(t, m, c) // the session's channel is open
	const tries = 32
	if err := c.OnOneChannel(context.Background(), func(h *bridge.HeldChannel) error {
		if err := h.Ping(context.Background(), nil); err != nil {
			return err
		}
		for range tries {
			ctx, cancel := context.WithCancel(context.Background())
			err := h.Call(ctx, "pane.send_text", cancelOnEncode{cancel}, nil)
			if !errors.Is(err, bridge.ErrNotSent) || !errors.Is(err, context.Canceled) {
				t.Errorf("%v; want ErrNotSent with context.Canceled", err)
			}
		}
		return h.Ping(context.Background(), nil) // the channel still answers
	}); err != nil {
		t.Fatal(err)
	}
	for _, r := range m.srv.Requests() {
		if r.Method == "pane.send_text" {
			t.Fatalf("a request cancelled while encoded reached herdr: %+v", r)
		}
	}
}

// within fails the test unless ch yields within a bound, so a regression
// fails rather than hanging the package.
func within[T any](t *testing.T, what string, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
		var zero T
		return zero
	}
}

// #499: an earlier request herdr never answers gets the channel retired
// while the last pending request waits for the write lock; cancelling that
// one withdraws it, and the retired channel, now empty, closes: its SSH
// channel ends, not only its state.
func TestARetiredChannelClosesOnceItsLastPendingRequestIsWithdrawn(t *testing.T) {
	hold := make(chan struct{})
	var released sync.Once
	release := func() { released.Do(func() { close(hold) }) }
	m := startMachine(t, func(s *fakeherdr.Server) {
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "hang" {
				<-hold // unanswered until the test releases it
			}
			return echoHandler(method, params)
		}
	})
	t.Cleanup(release)
	c := m.dial(t)
	if err := c.Call(context.Background(), "ping", nil, nil); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the --multi channel", func() bool { return bridge.MultiAlive(c) })
	ch := bridge.ChannelOf(c)

	hangCtx, cancelHang := context.WithCancel(context.Background())
	defer cancelHang()
	hung := make(chan error, 1)
	go func() { hung <- c.Call(hangCtx, "hang", nil, nil) }()
	eventually(t, "the unanswered request written", func() bool {
		return slices.ContainsFunc(m.srv.Requests(), func(r fakeherdr.Request) bool { return r.Method == "hang" && r.Multi })
	})
	unlock := ch.LockWrites(t)
	lastCtx, cancelLast := context.WithCancel(context.Background())
	defer cancelLast()
	last := make(chan error, 1)
	go func() { last <- c.Call(lastCtx, "agent.list", nil, nil) }()
	eventually(t, "the last request pending at the write lock", func() bool { return ch.Pending() == 2 })
	cancelHang() // abandoned: herdr still has it
	if err := within(t, "the abandoned request's return", hung); !errors.Is(err, context.Canceled) {
		t.Fatalf("abandoned request: %v", err)
	}
	ch.Retire()
	select {
	case <-ch.Dead():
		t.Fatal("the retired channel closed with a request still pending")
	default:
	}
	cancelLast()
	unlock()
	if err := within(t, "the withdrawn request's return", last); !errors.Is(err, bridge.ErrNotSent) || !errors.Is(err, context.Canceled) {
		t.Fatalf("%v; want ErrNotSent with context.Canceled", err)
	}
	within(t, "the retired channel to close once empty", ch.Dead())
	for _, r := range m.srv.Requests() {
		if r.Method == "agent.list" {
			t.Fatalf("the withdrawn request reached herdr: %+v", r)
		}
	}
	// The fake keeps a channel until its handlers return; once the held
	// one does, the channel's end shows only if the client closed its SSH
	// session, before the connection itself is closed in cleanup.
	release()
	eventually(t, "the retired channel's SSH session to close", func() bool { return m.srv.OpenChannels() == 0 })
}

// #499: a cancelled request on a retired channel that has closed fails
// unsent keeping context.Canceled, whichever of the free slot, the
// retirement, the death and the cancellation the channel's select picks.
func TestACancelledRequestOnARetiredClosedChannelKeepsItsCause(t *testing.T) {
	m := startMachine(t, nil)
	c := m.dial(t)
	if err := c.Call(context.Background(), "ping", nil, nil); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the --multi channel", func() bool { return bridge.MultiAlive(c) })
	ch := bridge.ChannelOf(c)
	ch.Retire() // nothing pending: it closes at once
	within(t, "the retired channel to close", ch.Dead())
	for range 32 {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if err := ch.Do(ctx, "pane.send_text"); !errors.Is(err, bridge.ErrNotSent) || !errors.Is(err, context.Canceled) {
			t.Errorf("%v; want ErrNotSent with context.Canceled", err)
		}
	}
	for _, r := range m.srv.Requests() {
		if r.Method == "pane.send_text" {
			t.Fatalf("a cancelled request reached herdr: %+v", r)
		}
	}
}

// #499: a request cancelled while it waits for the write lock is withdrawn
// at the write boundary, unsent, keeping context.Canceled on the channel
// itself (Call would add the cause back otherwise).
func TestARequestCancelledAtTheWriteLockKeepsItsCause(t *testing.T) {
	m := startMachine(t, nil)
	c := m.dial(t)
	if err := c.Call(context.Background(), "ping", nil, nil); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the --multi channel", func() bool { return bridge.MultiAlive(c) })
	ch := bridge.ChannelOf(c)
	unlock := ch.LockWrites(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- ch.Do(ctx, "pane.send_text") }()
	eventually(t, "the request pending at the write lock", func() bool { return ch.Pending() == 1 })
	cancel()
	unlock()
	if err := within(t, "the withdrawn request's return", done); !errors.Is(err, bridge.ErrNotSent) || !errors.Is(err, context.Canceled) {
		t.Fatalf("%v; want ErrNotSent with context.Canceled", err)
	}
	if n := ch.Pending(); n != 0 {
		t.Fatalf("%d requests still pending after the withdrawal", n)
	}
}

// #501 review: a request offered to a channel that died fails unsent with
// why it died (the read or process error fail recorded), and with the
// context's end too when that has ended, whichever of the free slot, the
// death and the cancellation the channel's select picks.
func TestARequestOnADeadChannelKeepsWhyItDied(t *testing.T) {
	m := startMachine(t, nil)
	c := m.dial(t)
	if err := c.Call(context.Background(), "ping", nil, nil); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the --multi channel", func() bool { return bridge.MultiAlive(c) })
	ch := bridge.ChannelOf(c)
	died := errors.New("herdr api-bridge exited: broken pipe")
	ch.Fail(died)
	for range 32 {
		if err := ch.Do(context.Background(), "pane.send_text"); !errors.Is(err, bridge.ErrNotSent) || !errors.Is(err, died) {
			t.Errorf("%v; want ErrNotSent with why the channel died", err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if err := ch.Do(ctx, "pane.send_text"); !errors.Is(err, bridge.ErrNotSent) || !errors.Is(err, context.Canceled) {
			t.Errorf("%v; want ErrNotSent with context.Canceled", err)
		}
	}
}
