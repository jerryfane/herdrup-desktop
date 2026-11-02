package main

import (
	"context"
	"encoding/json"
	"slices"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// The desk tells the presence of each move into needs you on its
// connection, never of what needed you as it connected or switched
// session, and gives it the agents needing you with every board.
func TestDeskNotifiesEachMoveIntoNeedsYou(t *testing.T) {
	var bStatus atomic.Value
	bStatus.Store("working")
	var version atomic.Int64
	eventsReady := make(chan struct{}, 2)
	waitEvents := func() {
		t.Helper()
		select {
		case <-eventsReady:
		case <-time.After(10 * time.Second):
			t.Fatal("event fixture did not subscribe")
		}
	}
	change := func(status string) {
		bStatus.Store(status)
		version.Add(1)
	}
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		s.SessionList = `{"sessions":[{"name":"default","default":true,"running":true},{"name":"work","running":true}]}`
		handle := s.Handle
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if method != "agent.list" {
				return handle(method, params)
			}
			return map[string]any{"type": "agent_list", "agents": []any{
				map[string]any{"pane_id": "w1:p1", "agent_status": "blocked"},
				map[string]any{"pane_id": "w1:p2", "agent_status": bStatus.Load()},
			}}, nil
		}
		// A pane.created line after each change makes the desk list again.
		s.Events = func(ctx context.Context, emit func([]byte) error) {
			seen := version.Load()
			eventsReady <- struct{}{}
			for seq := 1; ; seq++ {
				select {
				case <-ctx.Done():
					return
				case <-time.After(10 * time.Millisecond):
				}
				if v := version.Load(); v != seen {
					seen = v
					if emit([]byte(`{"seq":`+strconv.Itoa(seq)+`,"event":"pane.created","data":{}}`)) != nil {
						return
					}
				}
			}
		}
	})
	presenceState := func() (rows, started []string) {
		d.presence.mu.Lock()
		defer d.presence.mu.Unlock()
		for _, r := range d.presence.board.rows {
			rows = append(rows, r.ID)
		}
		for _, a := range d.presence.started {
			started = append(started, a.agent.PaneID)
		}
		return rows, started
	}
	board := func(session string, needsYou int) func() bool {
		return func() bool {
			b := d.Board()
			return b != nil && b.ListedAt != "" && b.Session == session && b.Board.NeedsYou == needsYou
		}
	}
	check := func(when string, wantRows, wantStarted []string) {
		t.Helper()
		rows, started := presenceState()
		slices.Sort(rows)
		if !slices.Equal(rows, wantRows) || !slices.Equal(started, wantStarted) {
			t.Fatalf("%s: rows %v started %v, want rows %v started %v", when, rows, started, wantRows, wantStarted)
		}
	}

	waitFor(t, "the first board", board("", 1))
	check("connected with w1:p1 blocked", []string{"w1:p1"}, nil)
	waitEvents() // Watch publishes its initial list before opening the stream.

	change("blocked")
	waitFor(t, "w1:p2 blocked", board("", 2))
	check("w1:p2 blocked", []string{"w1:p1", "w1:p2"}, []string{"w1:p2"})

	change("working")
	waitFor(t, "w1:p2 working", board("", 1))
	// w1:p2 is blocked as session work is first listed, with no event: the
	// new session's baseline, not news.
	bStatus.Store("blocked")
	if err := d.SelectSession("work"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "session work's board", board("work", 2))
	check("switched to work", []string{"w1:p1", "w1:p2"}, []string{"w1:p2"})
	waitEvents()

	change("working")
	waitFor(t, "w1:p2 working", board("work", 1))
	change("blocked")
	waitFor(t, "w1:p2 blocked again", board("work", 2))
	check("w1:p2 blocked again", []string{"w1:p1", "w1:p2"}, []string{"w1:p2", "w1:p2"})

	d.Disconnect()
	check("disconnected", nil, []string{"w1:p2", "w1:p2"})
}
