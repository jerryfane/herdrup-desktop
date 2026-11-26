package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// herdr 31bd88e6 answers cursor_expired for a cursor read before its update.
// The Inbox's and a topic's pages start over from their newest page on it
// (interactionModel.ts cursorExpired), which reads herdr's code from the
// error's "herdr: <code>: " wording: the desk hands it over as herdr said it,
// for after and before cursors alike, and the newest page still reads.
func TestTranscriptHandsHerdrsCursorExpiredToThePage(t *testing.T) {
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		original := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "ping":
				return map[string]any{"type": "pong", "version": "0.9.6", "protocol": 22,
					"capabilities": map[string]bool{"api_bridge_multi": true, "events_v2": true, "agent_transcript": true, "agent_transcript_topic": true}}, nil
			case "agent.transcript":
				var p map[string]any
				_ = json.Unmarshal(raw, &p)
				if p["after"] != nil || p["before"] != nil {
					return nil, &fakeherdr.APIError{Code: "cursor_expired", Message: "the transcript changed under this cursor; reload the newest page"}
				}
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
	ctx := context.Background()
	for name, read := range map[string]func() (string, error){
		"inbox after":  func() (string, error) { return d.ChatTranscript(ctx, "view", "1", "", "", "b0") },
		"inbox before": func() (string, error) { return d.ChatTranscript(ctx, "view", "", "b0", "", "") },
		"topic after":  func() (string, error) { return d.TopicTranscript(ctx, "view", "t1", "1", "", "b0") },
		"topic before": func() (string, error) { return d.TopicTranscript(ctx, "view", "t1", "", "b0", "") },
	} {
		if _, err := read(); err == nil || !strings.HasPrefix(err.Error(), "herdr: cursor_expired: ") {
			t.Fatalf("%s: %v, want herdr's cursor_expired as herdr said it", name, err)
		}
	}
	if _, err := d.ChatTranscript(ctx, "view", "", "", "", ""); err != nil {
		t.Fatalf("the newest page: %v", err)
	}
	if _, err := d.TopicTranscript(ctx, "view", "t1", "", "", ""); err != nil {
		t.Fatalf("the topic's newest page: %v", err)
	}
	d.Disconnect()
}
