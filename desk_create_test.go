package main

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

func creationDesk(t *testing.T, uncertain bool) (*Desk, *fakeherdr.Creation, *atomic.Int32) {
	t.Helper()
	fixture := fakeherdr.NewCreation(nil)
	starts := &atomic.Int32{}
	d, _ := federatedDesk(t, func(server *fakeherdr.Server) {
		previous := server.Handle
		server.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "agent.start" {
				starts.Add(1)
				if uncertain {
					return map[string]any{"type": "ok"}, nil
				}
			}
			if value, err, handled := fixture.Handle(method, raw); handled {
				return value, err
			}
			return previous(method, raw)
		}
	})
	board := d.Board()
	if err := d.OpenCreation(board.MachineID, board.Session, "create"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.CloseCreation("create") })
	return d, fixture, starts
}

func creationState(t *testing.T, fixture *fakeherdr.Creation) map[string]any {
	t.Helper()
	value, err, _ := fixture.Handle("fixture.creation.state", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	return value.(map[string]any)
}

func TestCreatedAgentOpensBeforeRosterRefreshWithoutInventingAgents(t *testing.T) {
	d, fixture, _ := creationDesk(t, false)
	result, err := d.CreateAgent(context.Background(), "create", "/home/ci/My Project", "omp")
	if err != nil || result.Phase != "started" || result.Name != "my-project" {
		t.Fatalf("creation: %+v %v", result, err)
	}
	board := d.Board()
	target := AgentTarget{MachineID: board.MachineID, Session: board.Session, PaneID: result.PaneID}
	view, err := d.OpenAgentView(target, "created")
	if err != nil || view.Name != "my-project" || view.Harness != "omp" {
		t.Fatalf("newly registered agent: %+v %v", view, err)
	}
	target.PaneID = "not-created"
	if _, err := d.OpenAgentView(target, "forged"); err == nil {
		t.Fatal("an arbitrary unlisted pane was accepted")
	}
	d.CloseCreation("create")
	target.PaneID = result.PaneID
	if _, err := d.OpenAgentView(target, "closed"); err == nil {
		t.Fatal("closed creation still authorized an absent roster entry")
	}
	state := creationState(t, fixture)
	if len(state["panes"].([]string)) != 1 {
		t.Fatalf("success closed the running pane: %+v", state)
	}
}

func TestAgentCreationCleansOnlyDefinitivelyRefusedPane(t *testing.T) {
	d, fixture, _ := creationDesk(t, false)
	result, err := d.CreateAgent(context.Background(), "create", "/reject", "claude")
	if err != nil || result.Phase != "failed" || !strings.Contains(result.Message, "another folder") {
		t.Fatalf("refusal: %+v %v", result, err)
	}
	if state := creationState(t, fixture); len(state["panes"].([]string)) != 0 {
		t.Fatalf("refused start left an empty pane: %+v", state)
	}
	result, err = d.CreateAgent(context.Background(), "create", "/home/ci/working", "claude")
	if err != nil || result.Phase != "started" {
		t.Fatalf("definitive failure could not be retried safely: %+v %v", result, err)
	}
}

func TestAgentCreationUncertainStartNeitherClosesNorRepeats(t *testing.T) {
	d, fixture, starts := creationDesk(t, true)
	result, err := d.CreateAgent(context.Background(), "create", "/home/ci/project", "claude")
	if err != nil || result.Phase != "uncertain" || result.PaneID == "" {
		t.Fatalf("uncertain start misreported: %+v %v", result, err)
	}
	if _, err := d.CreateAgent(context.Background(), "create", "/home/ci/project", "claude"); err == nil {
		t.Fatal("uncertain start offered an unsafe retry")
	}
	state := creationState(t, fixture)
	if starts.Load() != 1 || len(state["panes"].([]string)) != 1 || strings.Contains(state["calls"].(string), "pane.close") {
		t.Fatalf("uncertain start mutated twice or closed the pane: starts=%d %+v", starts.Load(), state)
	}
}

func TestAgentCreationRejectsClosedScopeBeforeCreatingPane(t *testing.T) {
	d, fixture, _ := creationDesk(t, false)
	d.CloseCreation("create")
	if _, err := d.CreateAgent(context.Background(), "create", "/home/ci/project", "claude"); err == nil {
		t.Fatal("closed dialog started a pane")
	}
	if state := creationState(t, fixture); len(state["panes"].([]string)) != 0 || strings.Contains(state["calls"].(string), "pane.split") {
		t.Fatalf("closed scope reached the daemon: %+v", state)
	}
}
