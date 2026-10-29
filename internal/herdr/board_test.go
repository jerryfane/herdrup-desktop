package herdr

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

func agent(t *testing.T, js string) herdrapi.AgentInfo {
	t.Helper()
	var a herdrapi.AgentInfo
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
	agents := []herdrapi.AgentInfo{
		agent(t, `{"pane_id":"p-idle-old","agent_status":"idle","last_completed_turn":{"completed_unix_ms":100}}`),
		agent(t, `{"pane_id":"p-work","agent_status":"working"}`),
		agent(t, `{"pane_id":"p-idle-new","agent_status":"done","last_completed_turn":{"completed_unix_ms":200}}`),
		agent(t, `{"pane_id":"p-idle-never-b","agent_status":"idle"}`),
		agent(t, `{"pane_id":"p-idle-never-a","agent_status":"idle"}`),
		agent(t, `{"pane_id":"p-blocked","agent_status":"blocked"}`),
		agent(t, `{"pane_id":"p-archived","agent_status":"blocked","archived":{"at":"x"}}`),
		agent(t, `{"pane_id":"p-null-archive","agent_status":"working","archived":null}`),
		agent(t, `{"pane_id":"p-false-archive","agent_status":"working","archived":false}`),
	}
	b := BuildBoard(agents, View{})
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
		{"working", "p-false-archive", "p-null-archive", "p-work"},
		{"idle", "p-idle-new", "p-idle-old", "p-idle-never-a", "p-idle-never-b"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sections\n got %v\nwant %v", got, want)
	}
	if b.NeedsYou != 1 || b.Total != 8 || len(b.Archived) != 1 || b.Archived[0].ID != "p-archived" {
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

// The expected indexes were computed independently with Python's FNV-1a
// (64-bit, fold high bits, mod 4); the reference screenshots from herdrup
// show the same gradients for the fixture's agents.
func TestTintIndexMatchesHerdrup(t *testing.T) {
	for name, want := range map[string]int{
		"api-review": 3, "docs": 1, "web": 0, "infra": 2, "release": 1, "notes": 3,
		"mac-studio/render": 1, "": 1, "é-ünicode": 0,
	} {
		if got := TintIndex(name); got != want {
			t.Errorf("TintIndex(%q) = %d, want %d", name, got, want)
		}
	}
}

func TestPreview(t *testing.T) {
	for _, tc := range []struct{ js, want string }{
		{`{"pane_id":"w1:p1","cwd":"/home/dev/api","terminal_title_stripped":"π > migrating"}`, "api · migrating"},
		{`{"pane_id":"w1:p1","cwd":"/home/dev/api"}`, "api"},
		{`{"pane_id":"w1:p1","terminal_title_stripped":"⠋ testing"}`, "testing"},
		{`{"pane_id":"w1:p1","cwd":"/","terminal_title_stripped":"π"}`, "w1:p1"},
		{`{"pane_id":"w1:p1"}`, "w1:p1"},
	} {
		if got := Preview(agent(t, tc.js)); got != tc.want {
			t.Errorf("Preview(%s) = %q, want %q", tc.js, got, tc.want)
		}
	}
}

func TestInitial(t *testing.T) {
	for in, want := range map[string]string{"docs": "D", "  web": "W", "élan": "É", "": "?", "   ": "?"} {
		if got := Initial(in); got != want {
			t.Errorf("Initial(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestBuildBoardBadgesAndArchivedNote(t *testing.T) {
	b := BuildBoard([]herdrapi.AgentInfo{
		agent(t, `{"pane_id":"a","agent_status":"blocked"}`),
		agent(t, `{"pane_id":"b","agent_status":"working","reachability":"unreachable"}`),
		agent(t, `{"pane_id":"c","agent_status":"compacting"}`),
		agent(t, `{"pane_id":"d","agent_status":"idle"}`),
		agent(t, `{"pane_id":"e","agent_status":"idle","archived":{"at":"2026-10-20T10:00:00Z","by":"user","reason":"done"}}`),
		agent(t, `{"pane_id":"f","agent_status":"idle","archived":{"at":"2026-10-27T10:00:00Z"}}`),
	}, View{})
	badges := map[string]string{}
	for _, s := range b.Sections {
		for _, r := range s.Rows {
			badges[r.ID] = r.Badge
		}
	}
	want := map[string]string{"a": "waiting", "b": "offline", "c": "unrecognised", "d": "none"}
	if !reflect.DeepEqual(badges, want) {
		t.Errorf("badges %v, want %v", badges, want)
	}
	// Newest archived first; "archived" alone when herdr recorded no one.
	var got [][2]string
	for _, r := range b.Archived {
		got = append(got, [2]string{r.ID, r.ArchivedNote})
	}
	if !reflect.DeepEqual(got, [][2]string{{"f", "archived"}, {"e", "archived by user · done"}}) {
		t.Errorf("archived %q", got)
	}
}

func TestRowMatchIsWhatSearchLooksIn(t *testing.T) {
	b := BuildBoard([]herdrapi.AgentInfo{
		// Federated: shown as the machine's label, but the raw name with the
		// alias and the terminal title must still find it.
		agent(t, `{"pane_id":"p1","agent_status":"working","name":"studio/render","machine_id":"studio","machine_label":"Studio Mac","terminal_title_stripped":"π > baking lights"}`),
		// No name: the display name is the terminal title, listed once.
		agent(t, `{"pane_id":"p2","agent_status":"working","terminal_title_stripped":"docs"}`),
	}, View{})
	got := map[string][]string{}
	for _, s := range b.Sections {
		for _, r := range s.Rows {
			got[r.ID] = r.Match
		}
	}
	want := map[string][]string{
		"p1": {"Studio Mac/render", "studio/render", "π > baking lights"},
		"p2": {"docs"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("match %q, want %q", got, want)
	}
}
