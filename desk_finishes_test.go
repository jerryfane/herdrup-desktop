package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

func finishedAgent(origin string) herdrapi.AgentInfo {
	last := &herdrapi.LastCompletedTurn{Turn: 5, TurnEpoch: 1, CompletedUnixMs: 77}
	if origin != "" {
		o := herdrapi.TurnOrigin(origin)
		last.TurnOrigin = &o
	}
	name := "docs"
	return herdrapi.AgentInfo{PaneID: "w1:p1", Name: &name, AgentStatus: "done", LastCompletedTurn: last}
}

// "An agent finishes": Off / Only my requests / Always (turn-origin contract, owner 2026-11-06).
// Only my requests stays quiet for a turn someone else started, and still alerts when the
// origin is unknown (an older or federated herdr), so no finish is lost for missing data.
func TestOnlyMyRequestsSkipsOtherFinishesAndKeepsUnknownOnes(t *testing.T) {
	d := newDesk(t.TempDir())
	target := AgentTarget{MachineID: "m", PaneID: "w1:p1"}
	alerts := func(origin string) bool {
		_, ok := d.agentNotification(attention{agent: finishedAgent(origin), target: target, kind: "finishes"})
		return ok
	}
	for _, c := range []struct {
		choice string
		want   map[string]bool
	}{
		{"mine", map[string]bool{"mine": true, "other": false, "": true}},
		{"always", map[string]bool{"mine": true, "other": true, "": true}},
	} {
		if err := d.SetFinishNotifications(c.choice); err != nil {
			t.Fatal(err)
		}
		for origin, want := range c.want {
			if got := alerts(origin); got != want {
				t.Errorf("%s: a finish with origin %q alerts %v, want %v", c.choice, origin, got, want)
			}
		}
	}
	// Off is decided where every alert kind is: the preference, not the origin.
	if err := d.SetFinishNotifications("off"); err != nil {
		t.Fatal(err)
	}
	if p, _, _ := d.notificationPreferences(); p.Finishes || p.FinishesMineOnly {
		t.Fatalf("off saved as %+v", p)
	}
}

func TestFinishChoiceIsSavedAndAnOldOnReadsAsAlways(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notifications.json"), []byte(`{"needsInput":true,"dies":true,"finishes":true,"gram":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	d := newDesk(dir)
	p, _, err := d.notificationPreferences()
	if err != nil || !p.Finishes || p.FinishesMineOnly {
		t.Fatalf("an old finishes on reads as %+v, %v; want Always", p, err)
	}
	if err := d.SetFinishNotifications("mine"); err != nil {
		t.Fatal(err)
	}
	if err := d.SetFinishNotifications("sometimes"); err == nil {
		t.Fatal("an unknown choice was saved")
	}
	p, _, _ = newDesk(dir).notificationPreferences()
	if !p.Finishes || !p.FinishesMineOnly || !p.NeedsInput || !p.Gram {
		t.Fatalf("after Only my requests and a restart: %+v", p)
	}
}

// On a herdr older than turn origins, Settings shows that Only my requests alerts every finish.
func TestSettingsSayWhetherTheMachineKnowsTurnOrigins(t *testing.T) {
	for _, supported := range []bool{false, true} {
		d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
			original := s.Handle
			s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
				if method == "ping" {
					return map[string]any{"type": "pong", "version": "0.9.5", "protocol": 22,
						"capabilities": map[string]bool{"api_bridge_multi": true, "events_v2": true, "turn_origin": supported}}, nil
				}
				return original(method, raw)
			}
		})
		waitFor(t, "the machine's capabilities", func() bool { return d.turnOriginSupported() != nil })
		if got := d.turnOriginSupported(); *got != supported {
			t.Errorf("turn_origin %v reads as %v", supported, *got)
		}
		d.Disconnect()
		if got := d.turnOriginSupported(); got != nil {
			t.Errorf("disconnected still reports %v", *got)
		}
	}
}
