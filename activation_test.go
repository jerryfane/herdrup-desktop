package main

import (
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

func TestAgentActivationReturnsToOrigin(t *testing.T) {
	for _, switched := range []string{"session", "machine"} {
		t.Run(switched, func(t *testing.T) {
			d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
				s.SessionList = `{"sessions":[{"name":"default","default":true,"running":true},{"name":"work","running":true}]}`
			})
			m, err := d.Machine()
			if err != nil || m == nil {
				t.Fatalf("origin: %v %v", m, err)
			}
			target := AgentTarget{machineID(*m), "", "w1:p1"}
			if switched == "session" {
				if err := d.SelectSession("work"); err != nil {
					t.Fatal(err)
				}
				waitFor(t, "other session", func() bool {
					b := d.Board()
					return b != nil && b.ListedAt != "" && b.Session == "work"
				})
			} else {
				other, _ := federatedDesk(t, nil)
				m2, err := other.Machine()
				if err != nil || m2 == nil {
					t.Fatalf("other machine: %v %v", m2, err)
				}
				if err := d.Connect(*m2, ""); err != nil {
					t.Fatal(err)
				}
				waitFor(t, "other machine", func() bool {
					b := d.Board()
					return b != nil && b.ListedAt != "" && b.MachineID == machineID(*m2)
				})
			}
			// The same pane ID exists in the new scope. A click must return
			// to the origin rather than selecting that unrelated row.
			d.requestAgent(target)
			if err := d.ActivateAgent(target); err != nil {
				t.Fatal(err)
			}
			waitFor(t, "origin board", func() bool {
				b := d.Board()
				return b != nil && b.ListedAt != "" && b.MachineID == target.MachineID && b.Session == target.Session
			})
			if got := d.PendingAgent(); got == nil || *got != target {
				t.Fatalf("activation lost before page acknowledgement: %+v", got)
			}
			d.AgentOpened(target)
			if got := d.PendingAgent(); got != nil {
				t.Fatalf("displayed target still pending: %+v", got)
			}
		})
	}
}

func TestAgentActivationSurvivesStartupAndStaleAcknowledgement(t *testing.T) {
	d := newDesk(t.TempDir())
	origin := AgentTarget{"owner@machine-a:22", "", "w1:p1"}
	later := AgentTarget{"owner@machine-b:22", "work", "w1:p1"}
	// No window and no board exists yet, as for a launch notification.
	d.requestAgent(origin)
	if got := d.PendingAgent(); got == nil || *got != origin {
		t.Fatalf("launch activation lost: %+v", got)
	}
	d.requestAgent(later)
	d.AgentOpened(origin)
	if got := d.PendingAgent(); got == nil || *got != later {
		t.Fatalf("old page consumed a newer activation: %+v", got)
	}
}

func TestNotificationIdentitySeparatesScopes(t *testing.T) {
	seen := map[string]bool{}
	for _, target := range []AgentTarget{
		{"a@host:22", "", "w1:p1"},
		{"a@host:22", "work", "w1:p1"},
		{"b@host:22", "", "w1:p1"},
		{"a@[::1]:22", "work", "peer/name:w1:p1"},
	} {
		id := target.notificationID()
		if seen[id] {
			t.Fatalf("notification replaces another scope: %q", id)
		}
		seen[id] = true
		if got, ok := notificationTarget(id); !ok || got != target {
			t.Fatalf("OS activation %q resolves to %+v (%v), want %+v", id, got, ok, target)
		}
	}
}
