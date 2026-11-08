package main

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/guest"
)

// sourceRecorder keeps each write method's input_source as the host saw it ("" when absent).
type sourceRecorder struct {
	mu   sync.Mutex
	seen map[string][]string
}

func (r *sourceRecorder) record(method string, raw json.RawMessage) {
	switch method {
	case "agent.prompt", "pane.send_text", "pane.send_keys", "pane.send_input", "agent.send_keys", "pane.input.stream":
	default:
		return
	}
	var p struct {
		InputSource string `json:"input_source"`
	}
	_ = json.Unmarshal(raw, &p)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.seen == nil {
		r.seen = map[string][]string{}
	}
	r.seen[method] = append(r.seen[method], p.InputSource)
}

func (r *sourceRecorder) sources(method string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.seen[method]...)
}

// Turn-origin contract (owner 2026-11-06, herdr #366): herdr counts a turn as the owner's only
// when the write that starts it says input_source "app". Without it, "Only my requests" drops
// the owner's own desktop prompts as "other".
func TestOwnerWritesCarryTheAppInputSource(t *testing.T) {
	var rec sourceRecorder
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		x := fakeherdr.NewInteraction()
		original := s.Handle
		s.Streams = map[string]fakeherdr.StreamFunc{"pane.stream": x.Stream}
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			rec.record(method, params)
			if value, err, ok := x.Handle(method, params); ok {
				return value, err
			}
			return original(method, params)
		}
	})
	defer d.Disconnect()
	b := d.Board()
	if _, err := d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: "w1:p1"}, "view"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ChatPrompt(context.Background(), "view", "review the release"); err != nil {
		t.Fatal(err)
	}
	if err := d.StartTerminal("view", "term"); err != nil {
		t.Fatal(err)
	}
	defer d.StopTerminal("view", "term")
	if err := d.TerminalInput(context.Background(), "view", "term", "ls\r"); err != nil {
		t.Fatal(err)
	}
	if got := rec.sources("agent.prompt"); len(got) == 0 || strings.Join(got, ",") != strings.Repeat("app,", len(got)-1)+"app" {
		t.Fatalf("owner agent.prompt input_source %q, want app", got)
	}
	if got := rec.sources("pane.send_text"); len(got) == 0 || got[0] != "app" {
		t.Fatalf("owner terminal pane.send_text input_source %q, want app", got)
	}
}

func TestGuestWritesCarryNoInputSource(t *testing.T) {
	var rec sourceRecorder
	owner := &guestOwnerHost{status: "idle", seq: 1}
	relay, err := fakeherdr.NewGuestRelay()
	if err != nil {
		t.Fatal(err)
	}
	relay.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
		rec.record(method, raw)
		if method == "agent.prompt" {
			return map[string]any{"type": "agent_prompted", "agent": map[string]any{"pane_id": "w1:p2"}, "delivery": "submitted"}, nil
		}
		return owner.handle(method, raw)
	}
	d, view := openGuestAgent(t, relay, guest.SystemClock)
	if _, err := d.ChatPrompt(context.Background(), view.Token, "hello from a guest"); err != nil {
		t.Fatal(err)
	}
	if got := rec.sources("agent.prompt"); len(got) != 1 || got[0] != "" {
		t.Fatalf("guest agent.prompt input_source %q, want none", got)
	}
}

// Review of #155 (issue #156): herdr marks a prompt someone else brokered with origin "other",
// and the Chat up arrow skips it. The desktop decodes the transcript into herdr's generated
// types and hands the page on, so the field must survive that round trip.
func TestTranscriptKeepsTheOriginOfAnotherPrompt(t *testing.T) {
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		original := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "ping" {
				return map[string]any{"type": "pong", "version": "0.9.5", "protocol": 22,
					"capabilities": map[string]bool{"api_bridge_multi": true, "events_v2": true, "agent_transcript": true, "turn_origin": true}}, nil
			}
			if method != "agent.transcript" {
				return original(method, raw)
			}
			return map[string]any{"type": "agent_transcript", "agent": "omp", "pane_id": "w1:p1", "session_id": "s", "after": "2", "entries": []any{
				map[string]any{"kind": "user", "id": "u1", "ts_ms": 1, "author": "owner", "text": "mine"},
				map[string]any{"kind": "user", "id": "u2", "ts_ms": 2, "author": "owner", "origin": "other", "text": "gitmoot review request"},
			}}, nil
		}
	})
	defer d.Disconnect()
	b := d.Board()
	if _, err := d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: "w1:p1"}, "view"); err != nil {
		t.Fatal(err)
	}
	raw, err := d.ChatTranscript(context.Background(), "view", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	var page struct {
		Entries []struct {
			ID     string  `json:"id"`
			Origin *string `json:"origin"`
		} `json:"entries"`
	}
	if err := json.Unmarshal([]byte(raw), &page); err != nil || len(page.Entries) != 2 {
		t.Fatalf("page %s: %v", raw, err)
	}
	if page.Entries[0].Origin != nil {
		t.Fatalf("the owner's prompt gained an origin: %s", raw)
	}
	if page.Entries[1].Origin == nil || *page.Entries[1].Origin != "other" {
		t.Fatalf("another prompt lost its origin: %s", raw)
	}
}
