package herdr

import (
	"encoding/json"
	"reflect"
	"testing"
)

func agent(t *testing.T, js string) AgentInfo {
	t.Helper()
	var a AgentInfo
	if err := json.Unmarshal([]byte(js), &a); err != nil {
		t.Fatal(err)
	}
	return a
}

func TestGroupOfMatchesIOS(t *testing.T) {
	for _, tc := range []struct {
		name string
		js   string
		live bool
		want Group
	}{
		{"blocked", `{"agent_status":"blocked"}`, true, NeedsYou},
		{"working with a menu open", `{"agent_status":"working","input_pending":true}`, true, NeedsYou},
		{"working", `{"agent_status":"working"}`, true, Working},
		{"idle", `{"agent_status":"idle"}`, true, Idle},
		{"done", `{"agent_status":"done"}`, true, Idle},
		{"unknown, peer was blocked", `{"agent_status":"unknown","last_known_status":"blocked"}`, true, NeedsYou},
		{"unknown, peer was working", `{"agent_status":"unknown","last_known_status":"working"}`, true, Unrecognised},
		{"idle with a stale last-known blocked", `{"agent_status":"idle","last_known_status":"blocked"}`, true, Idle},
		{"no status", `{}`, true, Unrecognised},
		{"a status this build does not know", `{"agent_status":"compacting"}`, true, Unrecognised},
		{"gone, even if blocked", `{"agent_status":"blocked","input_pending":true}`, false, Stopped},
	} {
		if got := GroupOf(agent(t, tc.js), tc.live); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got.Label(), tc.want.Label())
		}
	}
}

func TestBuildBoardOrdersGroupsThenRecencyAndLeavesArchivedOut(t *testing.T) {
	agents := []AgentInfo{
		agent(t, `{"pane_id":"p-idle-old","agent_status":"idle","last_completed_turn":{"completed_unix_ms":100}}`),
		agent(t, `{"pane_id":"p-work","agent_status":"working"}`),
		agent(t, `{"pane_id":"p-idle-new","agent_status":"done","last_completed_turn":{"completed_unix_ms":200}}`),
		agent(t, `{"pane_id":"p-idle-never-b","agent_status":"idle"}`),
		agent(t, `{"pane_id":"p-idle-never-a","agent_status":"idle"}`),
		agent(t, `{"pane_id":"p-blocked","agent_status":"blocked"}`),
		agent(t, `{"pane_id":"p-archived","agent_status":"blocked","archived":{"at":"x"}}`),
		agent(t, `{"pane_id":"p-null-archive","agent_status":"working","archived":null}`),
	}
	b := BuildBoard(agents)
	var got [][]string
	for _, s := range b.Sections {
		ids := []string{s.Key}
		for _, r := range s.Rows {
			ids = append(ids, r.ID)
		}
		got = append(got, ids)
	}
	want := [][]string{
		{"needsYou", "p-blocked"},
		{"working", "p-null-archive", "p-work"},
		{"idle", "p-idle-new", "p-idle-old", "p-idle-never-a", "p-idle-never-b"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sections\n got %v\nwant %v", got, want)
	}
	if b.NeedsYou != 1 || b.Total != 7 || len(b.Archived) != 1 || b.Archived[0].ID != "p-archived" {
		t.Fatalf("needsYou=%d total=%d archived=%v", b.NeedsYou, b.Total, b.Archived)
	}
	if !b.Sections[2].Collapsed || b.Sections[0].Collapsed || b.Sections[1].Collapsed {
		t.Fatal("only idle starts collapsed")
	}
}

func TestDisplayName(t *testing.T) {
	for _, tc := range []struct{ js, want string }{
		{`{"pane_id":"w1:p1","name":"jarvis","terminal_title_stripped":"t"}`, "jarvis"},
		{`{"pane_id":"w1:p1","terminal_title_stripped":"π > build"}`, "π > build"},
		{`{"pane_id":"w1:p1"}`, "w1:p1"},
		{`{"pane_id":"b/w1:p2","name":"b/render","machine_id":"b","machine_label":"mac-studio"}`, "mac-studio/render"},
		{`{"pane_id":"b/w1:p2","name":"render","machine_id":"b","machine_label":"mac-studio"}`, "render"},
		{`{"pane_id":"b/w1:p2","name":"b/render","machine_id":"b","machine_label":""}`, "b/render"},
	} {
		if got := DisplayName(agent(t, tc.js)); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.js, got, tc.want)
		}
	}
}

func TestActivity(t *testing.T) {
	for in, want := range map[string]string{
		"π > reading files":       "reading files",
		"  π  >  reading files":   "reading files",
		"⠋ running tests":         "running tests",
		"✳ π > x":                 "x",
		"> literal quote":         "> literal quote",
		"π > > nested":            "nested",
		"plain title":             "plain title",
		"":                        "",
		"π":                       "",
		"⠋⠙ two spinner glyphs":   "two spinner glyphs",
		"x⠋ not a spinner prefix": "x⠋ not a spinner prefix",
	} {
		if got := Activity(in); got != want {
			t.Errorf("Activity(%q) = %q, want %q", in, got, want)
		}
	}
}
