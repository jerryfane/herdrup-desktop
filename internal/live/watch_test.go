package live_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/live"
	"golang.org/x/crypto/ssh"
)

var fast = live.Timing{
	Debounce: 20 * time.Millisecond,
	Backstop: time.Hour,
	Poll:     50 * time.Millisecond,
	Silence:  300 * time.Millisecond,
}

type fake struct {
	srv     *fakeherdr.Server
	status  atomic.Value // string: the one agent's status
	lists   atomic.Int32
	streams atomic.Int32
	events  chan string // lines the next stream writes
}

func newFake(t *testing.T, eventsV2 bool) (*fake, *bridge.Client) {
	t.Helper()
	f := &fake{events: make(chan string, 16)}
	f.status.Store("working")
	_, hostPriv, _ := ed25519.GenerateKey(rand.Reader)
	hostKey, _ := ssh.NewSignerFromKey(hostPriv)
	clientPub, clientPriv, _ := ed25519.GenerateKey(rand.Reader)
	authorized, _ := ssh.NewPublicKey(clientPub)
	block, _ := ssh.MarshalPrivateKey(clientPriv, "")
	f.srv = &fakeherdr.Server{
		HostKey: hostKey, Authorized: authorized,
		Handle: func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "ping":
				return map[string]any{"type": "pong", "version": "t", "protocol": 22,
					"capabilities": map[string]bool{"api_bridge_multi": true, "events_v2": eventsV2}}, nil
			case "agent.list":
				f.lists.Add(1)
				return map[string]any{"type": "agent_list", "agents": []any{
					map[string]any{"pane_id": "w1:p1", "agent_status": f.status.Load()},
				}}, nil
			}
			return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
		},
		Events: func(ctx context.Context, emit func([]byte) error) {
			f.streams.Add(1)
			for {
				select {
				case <-ctx.Done():
					return
				case line := <-f.events:
					if line == "close" {
						return
					}
					if line == "hang" {
						<-ctx.Done()
						return
					}
					if emit([]byte(line)) != nil {
						return
					}
				}
			}
		},
	}
	addr, err := f.srv.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.srv.Close() })
	host, portStr, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portStr)
	c, err := bridge.Dial(context.Background(), bridge.Config{
		Host: host, Port: port, User: "dev", KeyPEM: pem.EncodeToMemory(block),
		Pins: bridge.NewFilePinStore(filepath.Join(t.TempDir(), "pins.json")),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return f, c
}

// watch runs Watch in the background and returns its updates.
func watch(t *testing.T, c *bridge.Client) (<-chan live.Update, <-chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	updates := make(chan live.Update, 64)
	done := make(chan error, 1)
	go func() { done <- live.Watch(ctx, live.BridgeCaller{Client: c}, fast, func(u live.Update) { updates <- u }) }()
	return updates, done
}

func next(t *testing.T, updates <-chan live.Update) live.Update {
	t.Helper()
	select {
	case u := <-updates:
		return u
	case <-time.After(5 * time.Second):
		t.Fatal("no board update")
		return live.Update{}
	}
}

func firstGroup(u live.Update) string {
	if len(u.Board.Sections) == 0 {
		return ""
	}
	return u.Board.Sections[0].Key
}

func waitStreams(t *testing.T, f *fake, n int32) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for f.streams.Load() < n {
		if time.Now().After(deadline) {
			t.Fatalf("stream %d never opened (have %d)", n, f.streams.Load())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestEventRelistsTheBoard(t *testing.T) {
	f, c := newFake(t, true)
	updates, _ := watch(t, c)
	if u := next(t, updates); !u.Live || firstGroup(u) != "working" {
		t.Fatalf("first board: live=%v group=%q", u.Live, firstGroup(u))
	}
	waitStreams(t, f, 1)
	f.status.Store("blocked")
	f.events <- `{"seq":1,"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"blocked"}}`
	if u := next(t, updates); firstGroup(u) != "needsYou" || u.Board.NeedsYou != 1 {
		t.Fatalf("after event: group=%q needsYou=%d", firstGroup(u), u.Board.NeedsYou)
	}
}

func TestBurstOfEventsIsOneList(t *testing.T) {
	f, c := newFake(t, true)
	updates, _ := watch(t, c)
	next(t, updates)
	waitStreams(t, f, 1)
	before := f.lists.Load()
	for range 5 {
		f.events <- `{"seq":1,"event":"pane.agent_status_changed","data":{}}`
	}
	next(t, updates)
	time.Sleep(4 * fast.Debounce)
	if got := f.lists.Load() - before; got != 1 {
		t.Fatalf("5 events in a burst caused %d lists, want 1", got)
	}
}

func TestLagAndHeartbeat(t *testing.T) {
	f, c := newFake(t, true)
	updates, _ := watch(t, c)
	next(t, updates)
	waitStreams(t, f, 1)
	before := f.lists.Load()
	f.events <- `{"control":"heartbeat","seq":4}`
	time.Sleep(4 * fast.Debounce)
	if f.lists.Load() != before {
		t.Fatal("a heartbeat caused a list")
	}
	f.events <- `{"control":"lagged","seq":904,"first_missed_seq":1,"last_missed_seq":904}`
	next(t, updates)
}

func TestSilentStreamIsReopenedAndTheBoardRelisted(t *testing.T) {
	f, c := newFake(t, true)
	updates, _ := watch(t, c)
	next(t, updates)
	waitStreams(t, f, 1)
	f.status.Store("blocked")
	f.events <- "hang" // no heartbeat: the client must give up on this stream
	waitStreams(t, f, 2)
	if u := next(t, updates); firstGroup(u) != "needsYou" {
		t.Fatalf("after reopen: group=%q", firstGroup(u))
	}
}

func TestPollsWithoutEventsV2(t *testing.T) {
	f, c := newFake(t, false)
	updates, _ := watch(t, c)
	if u := next(t, updates); u.Live {
		t.Fatal("reported live without events_v2")
	}
	f.status.Store("blocked")
	deadline := time.After(5 * time.Second)
	for {
		select {
		case u := <-updates:
			if firstGroup(u) == "needsYou" {
				if f.streams.Load() != 0 {
					t.Fatal("subscribed on a herdr without events_v2")
				}
				return
			}
		case <-deadline:
			t.Fatal("polling never picked up the change")
		}
	}
}

func TestLostConnectionEndsTheWatch(t *testing.T) {
	_, c := newFake(t, true)
	updates, done := watch(t, c)
	next(t, updates)
	c.Close()
	select {
	case err := <-done:
		if err == nil || errors.Is(err, context.Canceled) {
			t.Fatalf("got %v, want a connection error", err)
		}
		if !errors.Is(err, live.ErrDisconnected) && !strings.Contains(err.Error(), "closed") {
			t.Logf("ended with %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Watch kept running after the connection closed")
	}
}

// refusingCaller answers ping and agent.list, and refuses every stream.
type refusingCaller struct {
	lists atomic.Int32
	opens atomic.Int32
	done  chan struct{}
}

func (r *refusingCaller) Call(_ context.Context, method string, _, result any) error {
	switch method {
	case "ping":
		return json.Unmarshal([]byte(`{"type":"pong","protocol":22,"capabilities":{"events_v2":true}}`), result)
	case "agent.list":
		r.lists.Add(1)
		return json.Unmarshal([]byte(`{"agents":[]}`), result)
	}
	return errors.New("unexpected " + method)
}

func (r *refusingCaller) OpenStream(context.Context, string, any) (live.Stream, error) {
	r.opens.Add(1)
	return nil, errors.New("exec refused")
}

func (r *refusingCaller) Done() <-chan struct{} { return r.done }

func TestSubscribeThatNeverOpensEndsTheWatchWithoutRelisting(t *testing.T) {
	r := &refusingCaller{done: make(chan struct{})}
	done := make(chan error, 1)
	go func() { done <- live.Watch(context.Background(), r, fast, func(live.Update) {}) }()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "exec refused") {
			t.Fatalf("got %v, want the subscribe error", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Watch kept retrying a subscribe that never opens")
	}
	if got := r.opens.Load(); got != 3 {
		t.Errorf("opened %d times, want 3", got)
	}
	if got := r.lists.Load(); got != 1 {
		t.Errorf("listed %d times, want only the first list", got)
	}
}
