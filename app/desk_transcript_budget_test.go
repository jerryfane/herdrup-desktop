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
		for _, page := range []struct{ after, before string }{{"", ""}, {"", "older"}, {"2", ""}} {
			if _, err := d.ChatTranscript(context.Background(), "view", page.after, page.before, ""); err != nil {
				t.Fatal(err)
			}
		}
		mu.Lock()
		got := make([]any, len(sent))
		for i, p := range sent {
			got[i] = p["max_bytes"]
		}
		mu.Unlock()
		want := []any{nil, nil, nil}
		if supported {
			want = []any{float64(transcriptPageBytes), float64(transcriptPageBytes), nil}
		}
		if len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
			t.Fatalf("supported %v: max_bytes newest/older/tail = %v, want %v", supported, got, want)
		}
		d.Disconnect()
	}
}
