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
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/live"
	"golang.org/x/crypto/ssh"
)

var fast = live.Timing{
	Backstop:  time.Hour,
	Poll:      50 * time.Millisecond,
	Silence:   300 * time.Millisecond,
	Reconnect: engine.Backoff{Initial: 20 * time.Millisecond, Max: 100 * time.Millisecond},
}

type fake struct {
	srv     *fakeherdr.Server
	status  atomic.Value // string: the one agent's status
	lists   atomic.Int32
	streams atomic.Int32
	events  chan string // lines the next stream writes
	// hold, while set, keeps each agent.list waiting for release.
	hold    atomic.Bool
	release chan struct{}
}

func newFake(t *testing.T, eventsV2 bool) (*fake, *bridge.Client) {
	t.Helper()
	f := &fake{events: make(chan string, 16), release: make(chan struct{})}
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
				status := f.status.Load() // the snapshot is taken when the list starts
				if f.hold.Load() {
					<-f.release
				}
				return map[string]any{"type": "agent_list", "agents": []any{
					map[string]any{"pane_id": "w1:p1", "agent_status": status},
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
	go func() {
		done <- live.Watch(ctx, engine.New(engine.Bridge(c)), fast, func(u live.Update) { updates <- u })
	}()
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
	b := herdr.BuildBoard(u.Agents, herdr.View{})
	if len(b.Sections) == 0 {
		return ""
	}
	return b.Sections[0].Key
}

// quiet is long enough for a list the watcher should not make to show.
const quiet = 100 * time.Millisecond

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

func TestStatusEventPatchesTheRowWithoutAList(t *testing.T) {
	f, c := newFake(t, true)
	updates, _ := watch(t, c)
	if u := next(t, updates); !u.Live || firstGroup(u) != "working" {
		t.Fatalf("first board: live=%v group=%q", u.Live, firstGroup(u))
	}
	waitStreams(t, f, 1)
	before := f.lists.Load()
	f.events <- `{"seq":1,"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"blocked","workspace_id":"w1"}}`
	u := next(t, updates)
	if firstGroup(u) != "needsYou" || u.Agents[0].StatusSinceUnixMs == nil {
		t.Fatalf("after event: group=%q since=%v", firstGroup(u), u.Agents[0].StatusSinceUnixMs)
	}
	time.Sleep(quiet)
	if got := f.lists.Load() - before; got != 0 {
		t.Fatalf("a status event for a listed pane caused %d lists", got)
	}
}

func TestLifecycleEventsRelistCoalesced(t *testing.T) {
	f, c := newFake(t, true)
	updates, _ := watch(t, c)
	next(t, updates)
	waitStreams(t, f, 1)
	f.hold.Store(true)
	f.status.Store("blocked")
	for range 5 {
		f.events <- `{"seq":1,"event":"pane_created","data":{"pane_id":"w1:p2"}}`
	}
	waitLists(t, f, 2)
	time.Sleep(quiet)
	f.hold.Store(false)
	f.release <- struct{}{}
	next(t, updates)
	if u := next(t, updates); firstGroup(u) != "needsYou" {
		t.Fatalf("after pane_created: group=%q", firstGroup(u))
	}
	time.Sleep(quiet)
	// One list in flight and one queued behind it, for all five.
	if got := f.lists.Load(); got != 3 {
		t.Fatalf("5 lifecycle events in a burst made %d lists after the first, want 2", got-1)
	}
}

func TestUnlistedAgentPaneRelistsOnceAndShellsAreIgnored(t *testing.T) {
	f, c := newFake(t, true)
	updates, _ := watch(t, c)
	next(t, updates)
	waitStreams(t, f, 1)
	before := f.lists.Load()
	f.events <- `{"seq":1,"event":"pane.agent_status_changed","data":{"pane_id":"w1:p9","agent_status":"idle","workspace_id":"w1"}}`
	time.Sleep(quiet)
	if got := f.lists.Load() - before; got != 0 {
		t.Fatalf("an event for a plain shell caused %d lists", got)
	}
	f.events <- `{"seq":2,"event":"pane.agent_status_changed","data":{"pane_id":"w1:p9","agent":"pi","agent_status":"idle","workspace_id":"w1"}}`
	next(t, updates)
	if got := f.lists.Load() - before; got != 1 {
		t.Fatalf("an unlisted agent pane caused %d lists, want 1", got)
	}
}

// waitLists waits until n lists have started.
func waitLists(t *testing.T, f *fake, n int32) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for f.lists.Load() < n {
		if time.Now().After(deadline) {
			t.Fatalf("list %d never started (have %d)", n, f.lists.Load())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestAListInFlightDoesNotUndoAPatch(t *testing.T) {
	f, c := newFake(t, true)
	updates, _ := watch(t, c)
	next(t, updates)
	waitStreams(t, f, 1)
	f.hold.Store(true)
	f.events <- `{"seq":1,"event":"pane_created","data":{"pane_id":"w1:p2"}}`
	waitLists(t, f, 2) // started with the agent working
	f.events <- `{"seq":2,"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"blocked","workspace_id":"w1"}}`
	if u := next(t, updates); firstGroup(u) != "needsYou" {
		t.Fatalf("patch: %q", firstGroup(u))
	}
	f.hold.Store(false)
	f.release <- struct{}{}
	if u := next(t, updates); firstGroup(u) != "needsYou" {
		t.Fatalf("the list that was in flight undid the patch: %q", firstGroup(u))
	}
}

func TestUnlistedPaneRelistsOnceWhileAListIsInFlight(t *testing.T) {
	f, c := newFake(t, true)
	updates, _ := watch(t, c)
	next(t, updates)
	waitStreams(t, f, 1)
	f.hold.Store(true)
	ev := `{"seq":1,"event":"pane.agent_status_changed","data":{"pane_id":"w1:p9","agent":"pi","agent_status":"idle","workspace_id":"w1"}}`
	f.events <- ev
	waitLists(t, f, 2)
	f.events <- ev
	f.events <- ev
	time.Sleep(quiet)
	f.hold.Store(false)
	f.release <- struct{}{}
	next(t, updates)
	time.Sleep(quiet)
	if got := f.lists.Load(); got != 2 {
		t.Fatalf("%d lists, want the first and one for the unlisted pane", got)
	}
}

func TestLagAndHeartbeat(t *testing.T) {
	f, c := newFake(t, true)
	updates, _ := watch(t, c)
	next(t, updates)
	waitStreams(t, f, 1)
	before := f.lists.Load()
	f.events <- `{"control":"heartbeat","seq":4}`
	time.Sleep(quiet)
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
		if !errors.Is(err, engine.ErrDisconnected) && !strings.Contains(err.Error(), "closed") {
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
		return json.Unmarshal([]byte(`{"type":"agent_list","agents":[]}`), result)
	}
	return errors.New("unexpected " + method)
}

func (r *refusingCaller) OpenStream(context.Context, string, any) (engine.Stream, error) {
	r.opens.Add(1)
	return nil, errors.New("exec refused")
}

func (r *refusingCaller) Done() <-chan struct{} { return r.done }

func TestSubscribeThatNeverOpensEndsTheWatchWithoutRelisting(t *testing.T) {
	r := &refusingCaller{done: make(chan struct{})}
	done := make(chan error, 1)
	go func() { done <- live.Watch(context.Background(), engine.New(r), fast, func(live.Update) {}) }()
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

// #38: the agent goes blocked while a list is in flight, then more events
// arrive than the ledger keeps. The list was begun with the agent working:
// it must not be published and undo the blocked patch; a fresh list is.
func TestLedgerOverflowDoesNotLetALateListUndoAPatch(t *testing.T) {
	f, c := newFake(t, true)
	updates, _ := watch(t, c)
	next(t, updates)
	waitStreams(t, f, 1)
	f.hold.Store(true)
	f.events <- `{"seq":1,"event":"pane_created","data":{"pane_id":"w1:p2"}}`
	waitLists(t, f, 2) // started with the agent working
	f.status.Store("blocked")
	f.events <- `{"seq":2,"event":"pane.agent_status_changed","data":{"pane_id":"w1:p1","agent_status":"blocked","workspace_id":"w1"}}`
	if u := next(t, updates); firstGroup(u) != "needsYou" {
		t.Fatalf("patch: %q", firstGroup(u))
	}
	// A plain shell's status events are recorded but change no row.
	for i := range 256 {
		f.events <- `{"seq":` + strconv.Itoa(3+i) + `,"event":"pane.agent_status_changed","data":{"pane_id":"w1:p9","agent_status":"idle","workspace_id":"w1"}}`
	}
	time.Sleep(quiet)
	f.hold.Store(false)
	f.release <- struct{}{}
	if u := next(t, updates); firstGroup(u) != "needsYou" {
		t.Fatalf("the list that was in flight undid the patch: %q", firstGroup(u))
	}
	if got := f.lists.Load(); got != 3 {
		t.Fatalf("%d lists, want a fresh one after the overflowed list", got)
	}
}
