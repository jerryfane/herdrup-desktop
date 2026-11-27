package main

import (
	"encoding/json"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

func TestOpenAgentViewReportsTranscriptAgyFromCapabilities(t *testing.T) {
	for _, served := range []bool{true, false} {
		d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
			original := s.Handle
			s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
				if method == "ping" {
					return map[string]any{
						"type":     "pong",
						"version":  "0.9.6",
						"protocol": 22,
						"capabilities": map[string]bool{
							"api_bridge_multi": true,
							"events_v2":        true,
							"agent_transcript": true,
							"transcript_agy":   served,
						},
					}, nil
				}
				return original(method, raw)
			}
		})
		waitFor(t, "a listed board", func() bool { b := d.Board(); return b != nil && b.ListedAt != "" })
		b := d.Board()
		view, err := d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: "w1:p1"}, "view")
		if err != nil {
			t.Fatal(err)
		}
		rawView, err := json.Marshal(view)
		if err != nil {
			t.Fatal(err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(rawView, &decoded); err != nil {
			t.Fatal(err)
		}
		got, _ := decoded["transcriptAgy"].(bool)
		if got != served {
			t.Fatalf("served=%v: AgentView JSON transcriptAgy=%v (%s), want %v", served, got, rawView, served)
		}
	}
}
