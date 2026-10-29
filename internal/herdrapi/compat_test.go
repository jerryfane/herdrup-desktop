package herdrapi

import (
	"encoding/json"
	"testing"
)

func TestAgentListSurvivesANonObjectArchived(t *testing.T) {
	// One agent with archived:false must not fail the whole list, and only
	// an object marks an agent archived.
	line := `{"type":"agent_list","agents":[
		{"pane_id":"a","agent_status":"working","archived":false},
		{"pane_id":"b","agent_status":"working","archived":null},
		{"pane_id":"c","agent_status":"idle","archived":{"at":"2026-10-20T10:00:00Z","by":"user","reason":"done"}},
		{"pane_id":"d","agent_status":"idle","archived":""}
	]}`
	var r ResponseResult
	if err := json.Unmarshal([]byte(line), &r); err != nil {
		t.Fatalf("agent_list with archived:false failed to decode: %v", err)
	}
	list, ok := r.Value.(ResponseResultAgentList)
	if !ok {
		t.Fatalf("decoded %T, want ResponseResultAgentList", r.Value)
	}
	archived := map[string]bool{}
	for _, a := range list.Agents {
		archived[a.PaneID] = a.Archived != nil
	}
	want := map[string]bool{"a": false, "b": false, "c": true, "d": false}
	for id, w := range want {
		if archived[id] != w {
			t.Errorf("agent %s archived=%v, want %v", id, archived[id], w)
		}
	}
	for _, a := range list.Agents {
		if a.PaneID == "c" && (a.Archived.By != "user" || a.Archived.Reason == nil || *a.Archived.Reason != "done") {
			t.Errorf("archived object decoded as %+v", a.Archived)
		}
		if a.PaneID == "a" && a.AgentStatus == "" {
			t.Error("other fields were not decoded")
		}
	}
}
