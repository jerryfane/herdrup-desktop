package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

func TestSavedTerminalSurvivesReopenWithoutCrossingScope(t *testing.T) {
	d, fixture, starts := creationDesk(t, false)
	result, err := d.CreateTerminal(context.Background(), "create")
	if err != nil || result.Phase != "started" || result.Terminal == nil {
		t.Fatalf("create: %+v %v", result, err)
	}
	board := d.Board()
	target := AgentTarget{MachineID: board.MachineID, Session: board.Session, PaneID: result.Terminal.PaneID}
	if err := d.RenameTerminal(context.Background(), target, "Build logs"); err != nil {
		t.Fatal(err)
	}
	if labels := creationState(t, fixture)["labels"].(map[string]string); labels[target.PaneID] != "Build logs" {
		t.Fatalf("pane name did not reach daemon: %+v", labels)
	}
	reopened := newDesk(d.dir)
	saved, err := reopened.terminals.list(terminalScope(target.MachineID, target.Session))
	if err != nil || len(saved) != 1 || saved[0].Label != "Build logs" || saved[0].PaneID != target.PaneID {
		t.Fatalf("reopened: %+v %v", saved, err)
	}
	for _, scope := range []string{terminalScope("another-host", target.Session), terminalScope(target.MachineID, "another-session")} {
		rows, err := reopened.terminals.list(scope)
		if err != nil || len(rows) != 0 {
			t.Fatalf("cross-scope saved terminal: %+v %v", rows, err)
		}
	}
	if starts.Load() != 0 {
		t.Fatal("plain terminal started an agent")
	}
	if _, err := d.OpenTerminalView(target, "shell"); err != nil {
		t.Fatal(err)
	}
	forged := target
	forged.PaneID = "not-saved"
	if _, err := d.OpenTerminalView(forged, "forged"); err == nil {
		t.Fatal("opened unsaved pane")
	}
	if err := d.ForgetTerminal(target); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ChatPrompt(context.Background(), "shell", "must not reach forgotten pane"); err == nil {
		t.Fatal("forgotten terminal retained write authority")
	}
	if state := creationState(t, fixture); len(state["panes"].([]string)) != 1 || strings.Contains(state["calls"].(string), "pane.close") {
		t.Fatalf("forget closed remote shell: %+v", state)
	}
}

func TestTerminalPersistenceFailureClosesOnlyNewPane(t *testing.T) {
	d, fixture, _ := creationDesk(t, false)
	scope := terminalScope(d.Board().MachineID, d.Board().Session)
	if _, err := d.terminals.list(scope); err != nil {
		t.Fatal(err)
	}
	original := d.terminals.path
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocker, []byte("block"), 0600); err != nil {
		t.Fatal(err)
	}
	d.terminals.path = filepath.Join(blocker, "terminals.json")
	failed, err := d.CreateTerminal(context.Background(), "create")
	if err != nil || failed.Phase != "failed" {
		t.Fatalf("save failure: %+v %v", failed, err)
	}
	if state := creationState(t, fixture); len(state["panes"].([]string)) != 0 {
		t.Fatalf("failed save leaked pane: %+v", state)
	}
	d.terminals.path = original
	result, err := d.CreateTerminal(context.Background(), "create")
	if err != nil || result.Phase != "started" || result.Terminal == nil {
		t.Fatalf("retry: %+v %v", result, err)
	}
	saved, err := d.terminals.list(scope)
	if err != nil || len(saved) != 1 || saved[0].PaneID != result.Terminal.PaneID {
		t.Fatalf("failed save polluted records: %+v %v", saved, err)
	}
}

func TestPlainTerminalWritesWithoutSubmittingAndRetainsUncertainClose(t *testing.T) {
	fixture := fakeherdr.NewCreation(nil)
	writes := make(chan string, 4)
	d, _ := federatedDesk(t, func(server *fakeherdr.Server) {
		previous := server.Handle
		server.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "pane.send_text" {
				var p struct {
					Text string `json:"text"`
				}
				if err := json.Unmarshal(raw, &p); err != nil {
					panic(err)
				}
				writes <- p.Text
				return map[string]any{"type": "ok"}, nil
			}
			if method == "pane.close" {
				return map[string]any{"type": "pane_info"}, nil
			}
			if method == "pane.rename" {
				return nil, &fakeherdr.APIError{Code: "permission_denied", Message: "rename refused"}
			}
			if value, err, handled := fixture.Handle(method, raw); handled {
				return value, err
			}
			return previous(method, raw)
		}
	})
	board := d.Board()
	if err := d.OpenCreation(board.MachineID, board.Session, "terminal"); err != nil {
		t.Fatal(err)
	}
	result, err := d.CreateTerminal(context.Background(), "terminal")
	if err != nil || result.Terminal == nil {
		t.Fatalf("create: %+v %v", result, err)
	}
	target := AgentTarget{MachineID: board.MachineID, Session: board.Session, PaneID: result.Terminal.PaneID}
	if _, err := d.OpenTerminalView(target, "shell"); err != nil {
		t.Fatal(err)
	}
	if err := d.RenameTerminal(context.Background(), target, "Not saved"); err == nil {
		t.Fatal("rename refusal was hidden")
	}
	unchanged, err := d.SavedTerminals(target.MachineID, target.Session)
	if err != nil || len(unchanged) != 1 || unchanged[0].Label != result.Terminal.Label {
		t.Fatalf("refused rename changed saved name: %+v %v", unchanged, err)
	}
	receipt, err := d.ChatPrompt(context.Background(), "shell", "printf hello")
	if err != nil || !strings.Contains(receipt, `"delivery":"written"`) {
		t.Fatalf("write: %s %v", receipt, err)
	}
	select {
	case text := <-writes:
		if text != "printf hello" {
			t.Fatalf("shell input was submitted or altered: %q", text)
		}
	default:
		t.Fatal("terminal received no text")
	}
	if err := d.CloseTerminal(context.Background(), target); err == nil {
		t.Fatal("unexpected close reply accepted")
	}
	saved, err := d.SavedTerminals(target.MachineID, target.Session)
	if err != nil || len(saved) != 1 || saved[0].PaneID != target.PaneID {
		t.Fatalf("uncertain close lost handle: %+v %v", saved, err)
	}
}

func TestTerminalCreationRejectsClosedScope(t *testing.T) {
	d, fixture, _ := creationDesk(t, false)
	d.CloseCreation("create")
	if _, err := d.CreateTerminal(context.Background(), "create"); err == nil {
		t.Fatal("closed scope created terminal")
	}
	if state := creationState(t, fixture); strings.Contains(state["calls"].(string), "pane.split") {
		t.Fatalf("closed scope reached daemon: %+v", state)
	}
}
