package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

func TestGuestInviteStaysWithSelectedPeerAndRejectsClosedView(t *testing.T) {
	const peerID = "11111111111111111111111111111111"
	guests := fakeherdr.NewGuests()
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		s.Machines = []fakeherdr.Machine{{ProfileID: peerID, DisplayLabel: "render-box", SavedState: "coordinated", FederationReachability: "reachable"}}
		original := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "agent.list" {
				return map[string]any{"type": "agent_list", "agents": []any{
					map[string]any{"pane_id": "workspace/w1:p1", "name": "Local", "agent_status": "working"},
					map[string]any{"pane_id": peerID + "/workspace/w1:p1", "name": "Remote", "agent_status": "working", "machine_id": peerID, "machine_label": "render-box"},
				}}, nil
			}
			if value, err, handled := guests.Handle(method, raw); handled {
				return value, err
			}
			return original(method, raw)
		}
	})
	b := d.Board()
	ctx := context.Background()
	target := AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: peerID + "/workspace/w1:p1"}
	if _, err := d.OpenAgentView(target, "peer"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.CreateGuestInvite(ctx, "peer", "Taylor_peer", "Owner", true); err != nil {
		t.Fatal(err)
	}
	target.PaneID = "workspace/w1:p1"
	if _, err := d.OpenAgentView(target, "local"); err != nil {
		t.Fatal(err)
	}
	if _, err := d.CreateGuestInvite(ctx, "peer", "stale", "Owner", false); err == nil {
		t.Fatal("replaced view created an invitation")
	}
	if _, err := d.CreateGuestInvite(ctx, "local", "Taylor_local", "Owner", false); err != nil {
		t.Fatal(err)
	}
	d.CloseAgentView("local")
	if _, err := d.CreateGuestInvite(ctx, "local", "closed", "Owner", false); err == nil {
		t.Fatal("closed view created an invitation")
	}
	if err := d.OpenSettings(b.MachineID, b.Session, "review"); err != nil {
		t.Fatal(err)
	}
	defer d.CloseSettings("review")
	for _, machine := range []string{"", peerID} {
		raw, err := d.SettingsGuestMachine(ctx, "review", machine)
		if err != nil {
			t.Fatal(err)
		}
		var result struct {
			Listing *herdrapi.ResponseResultGuestList `json:"listing"`
		}
		if err := json.Unmarshal([]byte(raw), &result); err != nil {
			t.Fatal(err)
		}
		if result.Listing == nil {
			t.Fatalf("guest store unavailable: %s", raw)
		}
		found := false
		want, forbidden := "Taylor_local", "Taylor_peer"
		if machine != "" {
			want, forbidden = forbidden, want
		}
		for _, invite := range result.Listing.Invites {
			if invite.Name == forbidden || invite.Name == "stale" || invite.Name == "closed" {
				t.Fatalf("invitation escaped its view: machine=%q name=%q", machine, invite.Name)
			}
			if invite.Name == want {
				found = true
				if invite.Grant.TerminalID != "workspace/w1:p1" {
					t.Fatalf("grant did not identify the daemon-local pane: %+v", invite.Grant)
				}
				if invite.ShareGram != (machine != "") {
					t.Fatalf("Gram consent changed: %+v", invite)
				}
			}
		}
		if !found {
			t.Fatalf("invitation missing from selected machine %q", machine)
		}
	}
}
