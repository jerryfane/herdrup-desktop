package main

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// Slow-network fix 5 (herdr #409): a newest or older transcript page asks for at most
// transcriptPageBytes where herdr advertises transcript_max_bytes; a tail read (after) and a
// herdr without the capability get no max_bytes.
func TestTranscriptPagesCarryAByteBudgetOnlyWhereHerdrTakesOne(t *testing.T) {
	for _, supported := range []bool{true, false} {
		var mu sync.Mutex
		var sent []map[string]any
		d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
			original := s.Handle
			s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
				switch method {
				case "ping":
					return map[string]any{"type": "pong", "version": "0.9.6", "protocol": 22,
						"capabilities": map[string]bool{"api_bridge_multi": true, "events_v2": true, "agent_transcript": true, "transcript_max_bytes": supported}}, nil
				case "agent.transcript":
					var p map[string]any
					_ = json.Unmarshal(raw, &p)
					mu.Lock()
					sent = append(sent, p)
					mu.Unlock()
					return map[string]any{"type": "agent_transcript", "agent": "omp", "pane_id": "w1:p1", "session_id": "s", "after": "2", "entries": []any{}}, nil
				}
				return original(method, raw)
			}
		})
		waitFor(t, "a listed board", func() bool { b := d.Board(); return b != nil && b.ListedAt != "" })
		b := d.Board()
		if _, err := d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: "w1:p1"}, "view"); err != nil {
			t.Fatal(err)
		}
		pages := []struct{ after, before, heldFrom string }{{"", "", ""}, {"", "older", ""}, {"2", "", "b1"}, {"2", "", ""}}
		for _, page := range pages {
			if _, err := d.ChatTranscript(context.Background(), "view", page.after, page.before, "", page.heldFrom); err != nil {
				t.Fatal(err)
			}
		}
		mu.Lock()
		got := make([]any, len(sent))
		held := make([]any, len(sent))
		for i, p := range sent {
			got[i] = p["max_bytes"]
			held[i] = p["held_from"]
		}
		mu.Unlock()
		want := []any{nil, nil, nil, nil}
		if supported {
			want = []any{float64(transcriptPageBytes), float64(transcriptPageBytes), nil, nil}
		}
		if len(got) != 4 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] || got[3] != want[3] {
			t.Fatalf("supported %v: max_bytes newest/older/tail = %v, want %v", supported, got, want)
		}
		// herdr #430: every tail read says what the chat holds, "" for the whole session; the
		// newest and older pages carry no held_from.
		if wantHeld := []any{nil, nil, "b1", ""}; held[0] != wantHeld[0] || held[1] != wantHeld[1] || held[2] != wantHeld[2] || held[3] != wantHeld[3] {
			t.Fatalf("held_from newest/older/tail/tail-whole = %#v, want %#v", held, wantHeld)
		}
		d.Disconnect()
	}
}
