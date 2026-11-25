package guest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// stepClock is a Clock whose sleepers all wake when advance passes their
// deadline.
type stepClock struct {
	mu      sync.Mutex
	now     time.Time
	waiters []stepWaiter
}

type stepWaiter struct {
	at time.Time
	ch chan time.Time
}

func (c *stepClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }

func (c *stepClock) After(d time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch := make(chan time.Time, 1)
	c.waiters = append(c.waiters, stepWaiter{at: c.now.Add(d), ch: ch})
	return ch
}

func (c *stepClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	kept := c.waiters[:0]
	for _, w := range c.waiters {
		if w.at.After(c.now) {
			kept = append(kept, w)
		} else {
			w.ch <- c.now
		}
	}
	c.waiters = kept
}

// reuseHost is a guest of a fakeherdr relay sharing "worker" (t1, pane p1):
// relay, the guest's transport on clock, and the connect redeeming the
// invitation already behind it.
type reuseHost struct {
	relay     *fakeherdr.GuestRelay
	transport *Transport
	clock     *stepClock
	accepted  int
	// gate holds agent.transcript until released, while set.
	mu   sync.Mutex
	gate chan struct{}
}

func newReuseHost(t *testing.T, multiRequest bool) *reuseHost {
	t.Helper()
	relay, err := fakeherdr.NewGuestRelay()
	if err != nil {
		t.Fatal(err)
	}
	h := &reuseHost{relay: relay, clock: &stepClock{now: time.Unix(1_000_000, 0)}}
	relay.TerminalID, relay.AgentName = "t1", "worker"
	relay.OwnerName, relay.MachineLabel, relay.GuestName = "Owner", "Machine", "visitor"
	relay.MultiRequest = multiRequest
	relay.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
		switch method {
		case "agent.list":
			return map[string]any{"type": "agent_list", "agents": []any{map[string]any{
				"terminal_id": "t1", "pane_id": "p1", "name": "worker", "agent": "omp", "agent_status": "idle",
			}}}, nil
		case "agent.prompt":
			var p struct {
				Text string `json:"text"`
			}
			_ = json.Unmarshal(params, &p)
			return map[string]any{"type": "agent_prompted", "text": p.Text}, nil
		case "agent.transcript":
			h.mu.Lock()
			gate := h.gate
			h.mu.Unlock()
			if gate != nil {
				<-gate
			}
			return map[string]any{"type": "agent_transcript", "entries": []any{}}, nil
		}
		return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
	}
	base, err := relay.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = relay.Close() })
	identity, err := LoadIdentity(filepath.Join(t.TempDir(), "identity"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	invite, err := parse(relay.InviteLink(base, now.Add(time.Hour)), now)
	if err != nil {
		t.Fatal(err)
	}
	access, err := Accept(context.Background(), invite, identity, "Desktop", now)
	if err != nil {
		t.Fatal(err)
	}
	h.accepted = len(relay.Connects())
	h.transport = NewTransport(access, identity, h.clock)
	t.Cleanup(func() { _ = h.transport.Close() })
	return h
}

// connects are the guest's connects since it accepted the invitation.
func (h *reuseHost) connects() []fakeherdr.GuestConnect {
	return h.relay.Connects()[h.accepted:]
}

func (h *reuseHost) list(t *testing.T) {
	t.Helper()
	var reply map[string]any
	if err := h.transport.Call(context.Background(), "agent.list", nil, &reply); err != nil {
		t.Fatalf("agent.list: %v", err)
	}
	if reply["type"] != "agent_list" {
		t.Fatalf("agent.list replied %v", reply)
	}
}

func (h *reuseHost) prompt(text string) (string, error) {
	var reply struct {
		Text string `json:"text"`
	}
	err := h.transport.Call(context.Background(), "agent.prompt", map[string]string{"target": "worker", "text": text}, &reply)
	return reply.Text, err
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); !ok(); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func prompts(relay *fakeherdr.GuestRelay) []string {
	var out []string
	for _, call := range relay.Calls() {
		if call.Method == "agent.prompt" {
			var p struct {
				Text string `json:"text"`
			}
			_ = json.Unmarshal(call.Params, &p)
			out = append(out, p.Text)
		}
	}
	return out
}

// herdr #356: a host that advertises features.multi_request serves the
// guest's calls on one session, so N calls are one relay connect; without
// it every call is its own connect, as before.
func TestCallsShareOneSessionOnlyWhenTheHostAdvertisesMultiRequest(t *testing.T) {
	for _, multi := range []bool{true, false} {
		t.Run(fmt.Sprintf("multi_request=%v", multi), func(t *testing.T) {
			h := newReuseHost(t, multi)
			const calls = 6
			for range calls {
				h.list(t)
			}
			if got := h.transport.Features().MultiRequest; got != multi {
				t.Fatalf("Features().MultiRequest = %v", got)
			}
			connects := h.connects()
			if !multi {
				if len(connects) != calls {
					t.Fatalf("%d connects for %d calls without multi_request, want one each", len(connects), calls)
				}
				return
			}
			if len(connects) != 1 || connects[0].Requests != calls {
				t.Fatalf("connects %+v, want 1 serving %d requests", connects, calls)
			}
		})
	}
}

// herdr ends an idle session on its own (revoke while idle, its stop, its
// idle limit). The transport hears the close, drops the session, and the
// next call connects afresh and succeeds.
func TestAServerClosedIdleSessionIsReplaced(t *testing.T) {
	h := newReuseHost(t, true)
	h.list(t)
	h.list(t)
	if n := len(h.connects()); n != 1 {
		t.Fatalf("%d connects for two calls, want one session", n)
	}
	h.relay.EndSessions()
	eventually(t, "herdr to end the session", func() bool { return h.connects()[0].End == "ended" })
	h.list(t)
	connects := h.connects()
	if len(connects) != 2 || connects[0].End != "ended" || connects[0].Requests != 2 || connects[1].Requests != 1 {
		t.Fatalf("connects %+v, want the ended session and one fresh one", connects)
	}
}

// A session whose end its reader already saw (herdr closed it) hands
// nothing of a request to the socket: sent stays false, so Call may send the
// request once more on a fresh session (TestAServerClosedIdleSessionIsReplaced
// covers that path end to end).
func TestNothingIsWrittenOnASessionKnownEnded(t *testing.T) {
	h := newReuseHost(t, true)
	h.list(t)
	h.transport.idleMu.Lock()
	idle := h.transport.idle
	h.transport.idleMu.Unlock()
	if idle == nil {
		t.Fatal("no idle session after a call")
	}
	ended := &session{socket: idle.session.socket, send: idle.session.send, receive: idle.session.receive,
		frames: make(chan []byte, 1), dead: make(chan struct{}), err: io.EOF}
	close(ended.dead)
	wrote := false
	ended.writeHook = func(context.Context, []byte) error { wrote = true; return nil }
	sent, err := ended.sendLine(context.Background(), []byte(`{"id":"x","method":"agent.prompt","params":{}}`))
	if sent || wrote || !errors.Is(err, io.EOF) {
		t.Fatalf("send on a known-ended session: sent %v, wrote %v, err %v; want nothing handed over", sent, wrote, err)
	}
}

// herdrup#612 review (P1): a write that reports an error after its bytes left
// may still have reached herdr. Here herdr receives the prompt and then the
// write fails; the call must fail and never send the prompt again.
func TestAPromptWhoseWriteFailedAfterHerdrHadItIsNotResent(t *testing.T) {
	h := newReuseHost(t, true)
	h.list(t)
	h.transport.idleMu.Lock()
	idle := h.transport.idle
	h.transport.idleMu.Unlock()
	if idle == nil {
		t.Fatal("no idle session after a call")
	}
	idle.session.writeHook = func(ctx context.Context, frame []byte) error {
		if err := idle.session.socket.Write(ctx, websocket.MessageBinary, frame); err != nil {
			return err
		}
		return errors.New("connection lost after the write")
	}
	if _, err := h.prompt("once"); err == nil {
		t.Fatal("the prompt whose write failed reported success")
	}
	eventually(t, "herdr to receive the prompt", func() bool { return len(prompts(h.relay)) >= 1 })
	time.Sleep(100 * time.Millisecond)
	if got := prompts(h.relay); len(got) != 1 {
		t.Fatalf("herdr saw prompts %q, want exactly one", got)
	}
	if connects := h.connects(); len(connects) != 1 {
		t.Fatalf("connects %+v, want no fresh session after a write was attempted", connects)
	}
}

// A request that may have reached herdr is never sent again: herdr acted on
// this agent.prompt and the connection died before its reply, so the call
// fails rather than prompting the agent twice.
func TestAPromptWhoseReplyWasLostIsNotResent(t *testing.T) {
	h := newReuseHost(t, true)
	h.relay.DropReply = func(method string) bool { return method == "agent.prompt" }
	h.list(t)
	if _, err := h.prompt("only once"); err == nil {
		t.Fatal("a prompt without its reply succeeded")
	}
	if got := prompts(h.relay); len(got) != 1 {
		t.Fatalf("herdr saw prompts %q, want exactly one", got)
	}
	eventually(t, "herdr's session to end", func() bool { return h.connects()[0].End != "" })
	connects := h.connects()
	if len(connects) != 1 || connects[0].Requests != 2 || connects[0].End != "dropped" {
		t.Fatalf("connects %+v, want the prompt on the reused session and no other connect", connects)
	}
}

// herdr ends the session after guest_paused (and guest_revoked); after
// guest_forbidden it serves the next request on it.
func TestGuestPausedEndsReuseAndForbiddenKeepsIt(t *testing.T) {
	h := newReuseHost(t, true)
	h.list(t)
	var apiErr *bridge.APIError
	err := h.transport.Call(context.Background(), "agent.get", map[string]string{"target": "someone-else"}, nil)
	if !errors.As(err, &apiErr) || apiErr.Code != "guest_forbidden" {
		t.Fatalf("agent.get on another agent: %v", err)
	}
	h.relay.Pause(true)
	err = h.transport.Call(context.Background(), "agent.get", map[string]string{"target": "worker"}, nil)
	if !errors.As(err, &apiErr) || apiErr.Code != "guest_paused" {
		t.Fatalf("agent.get while paused: %v", err)
	}
	h.relay.Pause(false)
	h.list(t)
	eventually(t, "herdr's paused session to end", func() bool { return h.connects()[0].End != "" })
	connects := h.connects()
	if len(connects) != 2 || connects[0].Requests != 3 || connects[0].End != "guest_paused" || connects[1].Requests != 1 {
		t.Fatalf("connects %+v, want one session through guest_paused, then a fresh one", connects)
	}
}

func TestOnlyPausedRevokedAndInvalidRepliesEndTheSession(t *testing.T) {
	for code, keeps := range map[string]bool{"guest_paused": false, "guest_revoked": false, "invalid_request": false, "guest_forbidden": true, "agent_not_found": true} {
		if got := keepsSession(&bridge.APIError{Code: code}); got != keeps {
			t.Errorf("%s keeps the session: %v, want %v", code, got, keeps)
		}
	}
	if !keepsSession(nil) || keepsSession(errors.New("decode herdr reply")) {
		t.Error("a success must keep the session and an undecodable reply must not")
	}
}

// pane.stream takes a session over, so a stream has its own connect and
// leaves the calls' session idle for the next call.
func TestStreamsOpenTheirOwnSession(t *testing.T) {
	h := newReuseHost(t, true)
	h.relay.Streams = map[string]fakeherdr.StreamFunc{"pane.stream": func(_ context.Context, id string, _ json.RawMessage, emit func([]byte) error) {
		_ = emit([]byte(`{"id":"` + id + `","result":{"type":"pane_stream_started"}}`))
	}}
	h.list(t)
	stream, err := h.transport.OpenStream(context.Background(), "pane.stream", map[string]string{"pane_id": "p1"})
	if err != nil {
		t.Fatal(err)
	}
	if line, err := stream.Next(); err != nil || !strings.Contains(string(line), "pane_stream_started") {
		t.Fatalf("stream line %q, %v", line, err)
	}
	_ = stream.Close()
	h.list(t)
	eventually(t, "the stream's session to end", func() bool { return h.connects()[1].End != "" })
	connects := h.connects()
	if len(connects) != 2 || connects[0].Requests != 2 || connects[1].Requests != 1 || connects[1].End != "stream" {
		t.Fatalf("connects %+v, want the calls' session (2 requests) and the stream's own", connects)
	}
}

// One request at a time per session: concurrent calls each get the answer to
// their own request, the calls overlapping a slow one connect afresh, and
// the sessions still carry several calls each.
func TestConcurrentCallsNeverShareASessionAtOnce(t *testing.T) {
	h := newReuseHost(t, true)
	h.list(t)
	h.mu.Lock()
	h.gate = make(chan struct{})
	h.mu.Unlock()
	slow := make(chan error, 1)
	go func() {
		slow <- h.transport.Call(context.Background(), "agent.transcript", map[string]string{"target": "worker"}, nil)
	}()
	eventually(t, "the slow call to reach herdr", func() bool { return len(h.relay.Calls()) > 0 })
	const workers, each = 4, 5
	var wg sync.WaitGroup
	errs := make(chan error, workers*each)
	for w := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range each {
				want := fmt.Sprintf("w%d-%d", w, i)
				got, err := h.prompt(want)
				if err == nil && got != "visitor (via HerdrUp): "+want {
					err = fmt.Errorf("prompt %q answered %q", want, got)
				}
				if err != nil {
					errs <- err
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	select {
	case err := <-slow:
		t.Fatalf("the slow call returned while held: %v", err)
	default:
	}
	close(h.gate)
	if err := <-slow; err != nil {
		t.Fatalf("slow call: %v", err)
	}
	connects := h.connects()
	if len(connects) >= 1+workers*each {
		t.Fatalf("%d connects for %d calls: no session was reused", len(connects), 2+workers*each)
	}
	served := 0
	for _, c := range connects {
		served += c.Requests
		if c.Overlapped {
			t.Fatalf("a session carried a request while another was out: %+v", connects)
		}
	}
	if served != 2+workers*each {
		t.Fatalf("herdr served %d requests, want %d", served, 2+workers*each)
	}
}

// herdr ends a session after 60 s without a request; the transport closes
// its idle one at reuseIdleLimit, before herdr would, and the next call
// connects afresh.
func TestAnIdleSessionClosesBeforeHerdrsLimit(t *testing.T) {
	if reuseIdleLimit >= 60*time.Second {
		t.Fatalf("reuseIdleLimit %v is not before herdr's 60 s", reuseIdleLimit)
	}
	h := newReuseHost(t, true)
	h.list(t)
	h.clock.advance(reuseIdleLimit - time.Second)
	time.Sleep(50 * time.Millisecond)
	if h.connects()[0].End != "" {
		t.Fatalf("the session closed before reuseIdleLimit: %+v", h.connects())
	}
	h.clock.advance(time.Second)
	eventually(t, "herdr to see the guest close its idle session", func() bool { return h.connects()[0].End == "guest" })
	h.list(t)
	if connects := h.connects(); len(connects) != 2 || connects[1].Requests != 1 {
		t.Fatalf("connects %+v, want a fresh session after the expiry", connects)
	}
}

// A call on a kept session is no relay connect: it goes through during the
// relay's backoff and never ends that backoff (post-merge review of #103,
// F1), since only a connect the relay admitted says anything about it.
func TestAReusedSessionNeitherConnectsNorEndsTheBackoff(t *testing.T) {
	h := newReuseHost(t, true)
	h.list(t)
	h.mu.Lock()
	h.gate = make(chan struct{})
	h.mu.Unlock()
	slow := make(chan error, 1)
	go func() {
		slow <- h.transport.Call(context.Background(), "agent.transcript", map[string]string{"target": "worker"}, nil)
	}()
	eventually(t, "the slow call to reach herdr", func() bool { return len(h.relay.Calls()) > 0 })
	// Every connect from here is refused with 429.
	h.relay.LimitConnects(1)
	if err := h.transport.Call(context.Background(), "agent.list", nil, nil); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("a call needing a connect during the limit: %v", err)
	}
	cooldown := h.transport.RateLimitedUntil()
	if cooldown.IsZero() {
		t.Fatal("the 429 started no backoff")
	}
	close(h.gate)
	if err := <-slow; err != nil {
		t.Fatalf("slow call: %v", err)
	}
	h.list(t)
	if got := h.transport.RateLimitedUntil(); !got.Equal(cooldown) {
		t.Fatalf("calls on the kept session moved the backoff from %v to %v", cooldown, got)
	}
	connects := h.connects()
	if len(connects) != 2 || !connects[1].Refused || connects[0].Requests != 3 {
		t.Fatalf("connects %+v, want the kept session (3 requests) and the refused connect", connects)
	}
}

// herdr tells the guest its features (Gram sharing) only in the handshake.
// A session kept busy past reuseAgeLimit is not reused: the next call
// handshakes again and so reads an owner's change of Gram sharing (herdr-app
// message 388428).
func TestASessionIsNotReusedPastItsAgeLimit(t *testing.T) {
	h := newReuseHost(t, true)
	h.list(t)
	if h.transport.Features().Gram {
		t.Fatal("Gram on before the owner shared it")
	}
	// Calls every 40 s keep the session busy, inside reuseIdleLimit each time.
	for elapsed := time.Duration(0); elapsed+40*time.Second < reuseAgeLimit; elapsed += 40 * time.Second {
		h.clock.advance(40 * time.Second)
		h.list(t)
	}
	if connects := h.connects(); len(connects) != 1 {
		t.Fatalf("connects %+v, want one session until its age limit", connects)
	}
	h.relay.Gram = true
	h.clock.advance(40 * time.Second)
	h.list(t)
	if connects := h.connects(); len(connects) != 2 {
		t.Fatalf("connects %+v, want a fresh handshake past reuseAgeLimit", connects)
	}
	if !h.transport.Features().Gram {
		t.Fatal("the owner's Gram sharing did not reach the guest after the age limit")
	}
}
