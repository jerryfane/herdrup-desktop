package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
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

func TestAgentViewAcceptsExplicitDefaultSession(t *testing.T) {
	d, _ := federatedDesk(t, nil)
	machine, err := d.Machine()
	if err != nil || machine == nil {
		t.Fatalf("saved machine: %v", err)
	}
	d.Disconnect()
	machine.Session = "default"
	if err := d.Connect(*machine, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "explicit default session board", func() bool { return d.Board() != nil })
	b := d.Board()
	for _, session := range []string{"", "default"} {
		view, err := d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: session, PaneID: "w1:p1"}, "view")
		if err != nil {
			t.Fatalf("default session spelling %q rejected: %v", session, err)
		}
		if view.PaneID != "w1:p1" {
			t.Fatalf("wrong selected pane: %s", view.PaneID)
		}
		d.CloseAgentView("view")
	}
}

func TestPanePromptUncertaintyDoesNotOfferDuplicateSend(t *testing.T) {
	for _, code := range []string{"timeout", "agent_prompt_unverifiable", "agent_prompt_stalled", "agent_status_unobserved_after_submit", "agent_prompt_unsubmitted", "agent_not_ready"} {
		t.Run(code, func(t *testing.T) {
			d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
				inner := s.Handle
				s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
					if method == "agent.prompt" {
						return nil, &fakeherdr.APIError{Code: code, Message: "deliberate rejection"}
					}
					return inner(method, raw)
				}
			})
			b := d.Board()
			if _, err := d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: "w1:p1"}, "view"); err != nil {
				t.Fatal(err)
			}
			raw, err := d.ChatPrompt(context.Background(), "view", "do not duplicate me")
			if code == "agent_not_ready" {
				if err == nil {
					t.Fatal("definite rejection consumed the draft")
				}
				return
			}
			if err != nil {
				t.Fatalf("possibly delivered prompt offered as retryable: %v", err)
			}
			var receipt struct {
				Delivery string `json:"delivery"`
			}
			if err := json.Unmarshal([]byte(raw), &receipt); err != nil {
				t.Fatal(err)
			}
			if receipt.Delivery != "unconfirmed" {
				t.Fatalf("false confirmed delivery: %s", raw)
			}
		})
	}
}

func TestPaneAttachmentRetryKeepsReferencesWithoutReposting(t *testing.T) {
	g := fakeherdr.NewGram("pane-files")
	var mu sync.Mutex
	var prompts []string
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		inner := s.Handle
		s.Duplex = g.Duplex
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if result, err, ok := g.Handle(method, raw); ok {
				return result, err
			}
			if method == "agent.list" {
				return map[string]any{"type": "agent_list", "agents": []any{map[string]any{"pane_id": "w1:p1", "name": "writer", "agent_status": "idle"}}}, nil
			}
			if method == "agent.prompt" {
				var p struct {
					Text   string `json:"text"`
					Target string `json:"target"`
				}
				if err := json.Unmarshal(raw, &p); err != nil {
					return nil, &fakeherdr.APIError{Code: "invalid_params", Message: err.Error()}
				}
				mu.Lock()
				prompts = append(prompts, p.Text)
				attempt := len(prompts)
				mu.Unlock()
				if attempt == 1 {
					return nil, &fakeherdr.APIError{Code: "agent_not_ready", Message: "try later"}
				}
				if attempt == 2 {
					return nil, &fakeherdr.APIError{Code: "timeout", Message: "written but receipt lost"}
				}
				return map[string]any{"type": "agent_prompted", "agent": map[string]any{"pane_id": p.Target}, "delivery": "submitted"}, nil
			}
			return inner(method, raw)
		}
	})
	paths := []string{filepath.Join(t.TempDir(), "notes.txt"), filepath.Join(t.TempDir(), "photo.png")}
	for _, path := range paths {
		if err := os.WriteFile(path, []byte("attachment bytes"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	d.openDialog = func(context.Context) ([]string, error) { return paths, nil }
	b := d.Board()
	view, err := d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: "w1:p1"}, "view")
	if err != nil {
		t.Fatal(err)
	}
	picker, ok := any(d).(interface {
		PanePickFiles(context.Context, string) error
	})
	if !ok {
		t.Fatal("pane composer cannot attach files")
	}
	if err := picker.PanePickFiles(context.Background(), "view"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ChatPrompt(context.Background(), "view", "inspect both"); err == nil {
		t.Fatal("definite rejection lost")
	}
	if _, err := d.ChatPrompt(context.Background(), "view", "inspect both"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ChatPrompt(context.Background(), "view", "next message"); err != nil {
		t.Fatal(err)
	}
	messages := g.Messages()
	if len(messages) != 2 {
		t.Fatalf("retry duplicated files: %+v", messages)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(prompts) != 3 || prompts[0] != prompts[1] || prompts[2] != "next message" {
		t.Fatalf("prompt retention/consumption: %q", prompts)
	}
	for _, message := range messages {
		if message.To == nil || *message.To != view.Name || message.File == nil {
			t.Fatalf("wrong recipient or attachment: %+v", message)
		}
		if !strings.Contains(prompts[0], "herdr gram get-file "+message.ID+" -o /tmp/herdr-") {
			t.Fatalf("missing download reference for %s: %s", message.ID, prompts[0])
		}
	}
}

func TestTerminalHistorySeparatesExpiredCursorFromTransportFailure(t *testing.T) {
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		original := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if method != "pane.history" {
				value, err := original(method, raw)
				if method == "ping" && err == nil {
					value.(map[string]any)["capabilities"].(map[string]bool)["pane_history"] = true
				}
				return value, err
			}
			var p struct {
				Cursor string `json:"cursor"`
			}
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, &fakeherdr.APIError{Code: "invalid_request", Message: err.Error()}
			}
			if p.Cursor == "expired" {
				return nil, &fakeherdr.APIError{Code: "history_expired", Message: "cursor expired"}
			}
			return map[string]any{"type": "pane_history", "pane_id": "w1:p1", "history_b64": "b2xkDQo=", "cursor": nil, "rows": 1}, nil
		}
	})
	board := d.Board()
	if _, err := d.OpenAgentView(AgentTarget{MachineID: board.MachineID, Session: board.Session, PaneID: "w1:p1"}, "history"); err != nil {
		t.Fatal(err)
	}
	page, err := d.TerminalHistory(context.Background(), "history", "valid")
	if err != nil || page.Page == nil || page.Unavailable != "" {
		t.Fatalf("valid history was unavailable: %+v, %v", page, err)
	}
	page, err = d.TerminalHistory(context.Background(), "history", "expired")
	if err != nil || page.Page != nil || !strings.Contains(page.Unavailable, "history_expired") {
		t.Fatalf("expired cursor should stop paging, not request a transport retry: %+v, %v", page, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	page, err = d.TerminalHistory(ctx, "history", "valid")
	if !errors.Is(err, context.Canceled) || page.Unavailable != "" {
		t.Fatalf("cancelled request was misclassified as a permanently expired cursor: %+v, %v", page, err)
	}
}

func TestTerminalHistoryStopsPagingOnUnsupportedDaemon(t *testing.T) {
	d, _ := federatedDesk(t, nil)
	board := d.Board()
	if _, err := d.OpenAgentView(AgentTarget{MachineID: board.MachineID, Session: board.Session, PaneID: "w1:p1"}, "history"); err != nil {
		t.Fatal(err)
	}
	page, err := d.TerminalHistory(context.Background(), "history", "old")
	if err != nil || page.Page != nil || !strings.Contains(page.Unavailable, "pane_history") {
		t.Fatalf("unsupported history should stop paging with a reason, not retry: %+v, %v", page, err)
	}
}
