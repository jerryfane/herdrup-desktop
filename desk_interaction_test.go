package main

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

func TestAgentViewRejectsStaleWrites(t *testing.T) {
	var mu sync.Mutex
	var targets []string
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		original := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "agent.prompt" {
				var p struct {
					Target string `json:"target"`
				}
				_ = json.Unmarshal(raw, &p)
				mu.Lock()
				targets = append(targets, p.Target)
				mu.Unlock()
				return map[string]any{"type": "agent_prompted", "agent": map[string]any{"pane_id": p.Target}, "delivery": "submitted"}, nil
			}
			return original(method, raw)
		}
	})
	board := d.Board()
	target := AgentTarget{MachineID: board.MachineID, Session: board.Session, PaneID: "w1:p1"}
	if _, err := d.OpenAgentView(target, "first"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ChatPrompt(context.Background(), "first", "local prompt"); err != nil {
		t.Fatal(err)
	}
	target.PaneID = piID + "/w1:p1"
	if _, err := d.OpenAgentView(target, "second"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ChatPrompt(context.Background(), "first", "must not reach peer"); err == nil {
		t.Fatal("old view could send to newly selected agent")
	}
	if _, err := d.ChatPrompt(context.Background(), "second", "peer prompt"); err != nil {
		t.Fatal(err)
	}
	d.CloseAgentView("first") // a late close must not tear down the newer pane
	if _, err := d.ChatPrompt(context.Background(), "second", "still selected"); err != nil {
		t.Fatal(err)
	}
	d.Disconnect()
	if _, err := d.ChatPrompt(context.Background(), "second", "must not send after disconnect"); err == nil {
		t.Fatal("disconnected view accepted prompt")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(targets) != 3 || targets[0] != "w1:p1" || targets[1] != piID+"/w1:p1" || targets[2] != targets[1] {
		t.Fatalf("wrong deliveries: %v", targets)
	}
}

func TestAgentViewCannotOpenForeignMachineOrMissingPane(t *testing.T) {
	d, _ := federatedDesk(t, nil)
	board := d.Board()
	for _, target := range []AgentTarget{
		{MachineID: "other", Session: board.Session, PaneID: "w1:p1"},
		{MachineID: board.MachineID, Session: "other", PaneID: "w1:p1"},
		{MachineID: board.MachineID, Session: board.Session, PaneID: "missing"},
	} {
		if _, err := d.OpenAgentView(target, "invalid"); err == nil {
			t.Fatalf("opened foreign target %+v", target)
		}
	}
}

func TestTerminalSurfaceRejectsStaleInputAndResize(t *testing.T) {
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		x := fakeherdr.NewInteraction()
		original := s.Handle
		s.Streams = map[string]fakeherdr.StreamFunc{"pane.stream": x.Stream}
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if value, err, ok := x.Handle(method, params); ok {
				return value, err
			}
			return original(method, params)
		}
	})
	b := d.Board()
	if _, err := d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: "w1:p1"}, "view"); err != nil {
		t.Fatal(err)
	}
	if err := d.StartTerminal("view", "old"); err != nil {
		t.Fatal(err)
	}
	d.StopTerminal("view", "old")
	if err := d.StartTerminal("view", "new"); err != nil {
		t.Fatal(err)
	}
	defer d.StopTerminal("view", "new")
	if err := d.TerminalInput(context.Background(), "view", "old", "late Enter\r"); err == nil {
		t.Fatal("old surface could type into replacement")
	}
	if err := d.TerminalSize(context.Background(), "view", "old", 60, 20); err == nil {
		t.Fatal("old surface could resize replacement")
	}
	d.StopTerminal("view", "old")
	if err := d.TerminalInput(context.Background(), "view", "new", "current"); err != nil {
		t.Fatal(err)
	}
	if err := d.TerminalSize(context.Background(), "view", "new", 100, 30); err != nil {
		t.Fatal(err)
	}
}
