package main

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// herdr #521: agent.transcript takes relay_entries where ping advertises
// transcript_relay_entries, and then answers a handover as a relay entry. The
// Inbox's and a topic's pages ask for it there; a subagent's page and a herdr
// without the flag never do. The page reaches chatRelay.ts with herdr's own
// field names.
func TestTranscriptAsksForRelayEntriesOnlyWhereHerdrServesThem(t *testing.T) {
	relay := map[string]any{"kind": "relay", "id": "r1", "ts_ms": float64(1), "from": "Board pack", "topic_id": "t1", "direction": "to_inbox", "text": "The intro is drafted."}
	note := map[string]any{"kind": "note", "id": "r1", "ts_ms": float64(1), "source": "irc", "title": "Board pack", "body": "<irc>\nThe intro is drafted."}
	for _, served := range []bool{true, false} {
		var mu sync.Mutex
		var sent []map[string]any
		d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
			original := s.Handle
			s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
				switch method {
				case "ping":
					return map[string]any{"type": "pong", "version": "0.9.6", "protocol": 22,
						"capabilities": map[string]bool{"api_bridge_multi": true, "events_v2": true, "agent_transcript": true, "agent_transcript_topic": true, "transcript_relay_entries": served}}, nil
				case "agent.transcript":
					var p map[string]any
					_ = json.Unmarshal(raw, &p)
					mu.Lock()
					sent = append(sent, p)
					mu.Unlock()
					page := map[string]any{"type": "agent_transcript", "agent": "omp", "pane_id": "w1:p1", "session_id": "s", "after": "1", "entries": []any{note}}
					if p["relay_entries"] == true {
						page["entries"], page["relay_entries"] = []any{relay}, true
					}
					return page, nil
				}
				return original(method, raw)
			}
		})
		waitFor(t, "a listed board", func() bool { b := d.Board(); return b != nil && b.ListedAt != "" })
		b := d.Board()
		if _, err := d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: "w1:p1"}, "view"); err != nil {
			t.Fatal(err)
		}
		inbox, err := d.ChatTranscript(context.Background(), "view", "", "", "", "")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := d.TopicTranscript(context.Background(), "view", "t1", "", "", ""); err != nil {
			t.Fatal(err)
		}
		if _, err := d.ChatTranscript(context.Background(), "view", "", "", "sub-1", ""); err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		got := make([]any, len(sent))
		for i, p := range sent {
			got[i] = p["relay_entries"]
		}
		mu.Unlock()
		want := []any{nil, nil, nil}
		if served {
			want = []any{true, true, nil}
		}
		if len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
			t.Fatalf("served %v: relay_entries inbox/topic/subagent = %v, want %v", served, got, want)
		}
		var page struct {
			Entries []map[string]any `json:"entries"`
		}
		if err := json.Unmarshal([]byte(inbox), &page); err != nil {
			t.Fatal(err)
		}
		wantEntry := note
		if served {
			wantEntry = relay
		}
		if len(page.Entries) != 1 || len(page.Entries[0]) != len(wantEntry) {
			t.Fatalf("served %v: entries %v, want [%v]", served, page.Entries, wantEntry)
		}
		for k, v := range wantEntry {
			if page.Entries[0][k] != v {
				t.Fatalf("served %v: entry %s = %v, want %v (%v)", served, k, page.Entries[0][k], v, page.Entries[0])
			}
		}
		d.Disconnect()
	}
}
