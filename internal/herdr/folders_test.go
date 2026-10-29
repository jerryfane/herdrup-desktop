package herdr

import (
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

func folder(id, name string, order int64, members ...string) herdrapi.AgentGroupFolder {
	return herdrapi.AgentGroupFolder{ID: id, Name: name, Order: order, Members: members}
}

// items flattens a board to "section: item item…", an agent as its id
// (with * when starred and >folder when indented) and a folder as
// [id open|closed count/summary].
func items(b Board) []string {
	var out []string
	for _, s := range b.Sections {
		line := s.Key + "(" + strconv.Itoa(s.AgentCount) + "):"
		for _, it := range s.Items {
			switch it.Kind {
			case "agent":
				line += " " + it.Row.ID
				if it.Row.Starred {
					line += "*"
				}
				if it.Row.FolderID != "" {
					line += ">" + it.Row.FolderID
				}
			case "folder":
				state := "closed"
				if it.Folder.Open {
					state = "open"
				}
				line += " [" + it.Folder.ID + " " + state + " " + it.Folder.Count + "/" + it.Folder.Summary + "]"
			}
		}
		out = append(out, line)
	}
	for _, f := range b.EmptyFolders {
		out = append(out, "empty: "+f.ID+" "+f.Summary)
	}
	return out
}

func roster(t *testing.T) []herdrapi.AgentInfo {
	return []herdrapi.AgentInfo{
		agent(t, `{"pane_id":"b1","name":"rev","agent_status":"blocked","last_completed_turn":{"completed_unix_ms":9}}`),
		agent(t, `{"pane_id":"b2","name":"efm","agent_status":"blocked","last_completed_turn":{"completed_unix_ms":8}}`),
		agent(t, `{"pane_id":"w1","name":"web","agent_status":"working","last_completed_turn":{"completed_unix_ms":7}}`),
		agent(t, `{"pane_id":"w2","name":"api","agent_status":"working","last_completed_turn":{"completed_unix_ms":6}}`),
		agent(t, `{"pane_id":"i1","name":"doc","agent_status":"idle","last_completed_turn":{"completed_unix_ms":5}}`),
		agent(t, `{"pane_id":"i2","agent_status":"idle","last_completed_turn":{"completed_unix_ms":4}}`),
	}
}

func TestPlainListWithoutGroups(t *testing.T) {
	b := BuildBoard(roster(t), View{})
	want := []string{"needsYou(2): b1 b2", "working(2): w1 w2", "idle(2): i1 i2"}
	if got := items(b); !reflect.DeepEqual(got, want) {
		t.Errorf("got %q, want %q", got, want)
	}
	if len(b.EmptyFolders) != 0 || b.EmptyFolders == nil {
		t.Errorf("empty folders %v, want [] (not null)", b.EmptyFolders)
	}
}

func TestFolderLayoutMatchesHerdrup(t *testing.T) {
	g := &Groups{
		Revision: 3,
		Stars:    []string{"api", "efm"},
		Folders: []herdrapi.AgentGroupFolder{
			// Listed first but ordered second.
			folder("f2", "Later", 1, "doc", "web"),
			folder("f1", "Review", 0, "rev", "api", "web"), // web also in f2: f1 wins (order first)
			folder("f3", "Gone", 2, "nobody"),
		},
	}
	b := BuildBoard(roster(t), View{Groups: g, Open: map[string]bool{"f1": true}})
	want := []string{
		// Starred loose efm first, then folder f1 (its most urgent is rev,
		// needs you), open: its members starred-first per section:
		// rev (needsYou), then api* (starred, working) before web.
		"needsYou(4): b2* [f1 open 3 agents/rev needs you] b1>f1 w2*>f1 w1>f1",
		// f2 holds only doc now (web went to f1): it sits in idle, closed.
		"idle(2): [f2 closed 1 agent/idle] i2",
		"empty: f3 empty",
	}
	if got := items(b); !reflect.DeepEqual(got, want) {
		t.Errorf("got\n%q\nwant\n%q", got, want)
	}
	// Rows keep every agent of the section, those in folders included.
	if n := len(b.Sections[0].Rows); n != 2 {
		t.Errorf("needsYou rows %d, want 2", n)
	}
	if b.Total != 6 || b.NeedsYou != 2 {
		t.Errorf("total %d needsYou %d", b.Total, b.NeedsYou)
	}
}

func TestFolderSummaryLines(t *testing.T) {
	for _, tc := range []struct {
		groups []Group
		want   string
	}{
		{nil, "empty"},
		{[]Group{Idle}, "idle"},
		{[]Group{Working, Working, Idle}, "2 working"},
		{[]Group{NeedsYou}, "a needs you"},
		{[]Group{NeedsYou, NeedsYou}, "a and b need you"},
		{[]Group{NeedsYou, NeedsYou, NeedsYou, Stopped}, "3 need you · d stopped"},
		{[]Group{Stopped, Stopped, Working}, "a and b stopped"},
	} {
		var ms []member
		for i, g := range tc.groups {
			ms = append(ms, member{Row{Title: string(rune('a' + i))}, g})
		}
		s := summarise(folder("f", "F", 0), ms, false)
		if s.Summary != tc.want {
			t.Errorf("%v: %q, want %q", tc.groups, s.Summary, tc.want)
		}
	}
	s := summarise(folder("f", "F", 0), []member{{Row{ID: "1"}, NeedsYou}, {Row{ID: "2"}, Stopped}, {Row{ID: "3"}, NeedsYou}, {Row{ID: "4"}, Idle}, {Row{ID: "5"}, Idle}}, true)
	if s.Waiting != 2 || s.Stopped != 1 || s.Count != "5 agents" || len(s.Picture) != 4 || s.Picture[3].ID != "4" {
		t.Errorf("summary %+v", s)
	}
}

func TestSearchOpensEveryFolderAndHidesEmptyOnes(t *testing.T) {
	g := &Groups{Folders: []herdrapi.AgentGroupFolder{
		folder("f1", "Review", 0, "rev", "web"),
		folder("f3", "Gone", 1, "nobody"),
	}}
	b := BuildBoard(roster(t), View{Groups: g, Query: "WE"})
	want := []string{"working(1): [f1 open 1 agent/1 working] w1>f1"}
	if got := items(b); !reflect.DeepEqual(got, want) {
		t.Errorf("got %q, want %q", got, want)
	}
	if b.Total != 6 || b.NeedsYou != 2 {
		t.Errorf("search changed the totals: %d %d", b.Total, b.NeedsYou)
	}
}

func TestMatches(t *testing.T) {
	federated := []string{"Studio Mac/render", "studio/render", "π > baking lights"}
	for q, want := range map[string]bool{
		"studio mac": true, "STUDIO/": true, "baking": true,
		"render π": false, "deploy": false, "": true,
	} {
		if got := Matches(federated, q); got != want {
			t.Errorf("Matches(%q) = %v", q, got)
		}
	}
	if Matches(nil, "a") || !Matches(nil, "") {
		t.Error("an empty match list")
	}
}

func TestEdits(t *testing.T) {
	base := Groups{Revision: 4, Stars: []string{"a"}, Folders: []herdrapi.AgentGroupFolder{
		folder("x", "X", 0, "a", "b"),
		folder("y", "Y", 5, "c"),
	}}
	snapshot := clone(base)
	apply := func(e Edit) Groups {
		t.Helper()
		out := e.Apply(base)
		if !GroupsEqual(base, snapshot) {
			t.Fatalf("%+v changed the document it was applied to", e)
		}
		return out
	}
	if g := apply(Edit{Kind: EditSetStar, Name: "a", Star: true}); !reflect.DeepEqual(g.Stars, []string{"a"}) {
		t.Errorf("star twice: %q", g.Stars)
	}
	if g := apply(Edit{Kind: EditSetStar, Name: "a"}); len(g.Stars) != 0 {
		t.Errorf("unstar: %q", g.Stars)
	}
	if g := apply(Edit{Kind: EditMove, Name: "a", Folder: "y"}); !reflect.DeepEqual(g.Folders[0].Members, []string{"b"}) || !reflect.DeepEqual(g.Folders[1].Members, []string{"c", "a"}) {
		t.Errorf("move: %+v", g.Folders)
	}
	if g := apply(Edit{Kind: EditMove, Name: "a", Folder: "gone"}); !GroupsEqual(g, base) {
		t.Errorf("move to a missing folder changed %+v", g)
	}
	if g := apply(Edit{Kind: EditRemoveFromFolder, Name: "b"}); !reflect.DeepEqual(g.Folders[0].Members, []string{"a"}) {
		t.Errorf("remove: %+v", g.Folders)
	}
	g := apply(Edit{Kind: EditAddFolder, Folder: "z", Text: "Z", Name: "c"})
	if z := g.Folders[2]; z.ID != "z" || z.Order != 6 || !reflect.DeepEqual(z.Members, []string{"c"}) || len(g.Folders[1].Members) != 0 {
		t.Errorf("add folder: %+v", g.Folders)
	}
	if g := apply(Edit{Kind: EditRenameFolder, Folder: "y", Text: "Why"}); g.Folders[1].Name != "Why" {
		t.Errorf("rename: %+v", g.Folders)
	}
	if g := apply(Edit{Kind: EditDeleteFolder, Folder: "x"}); len(g.Folders) != 1 || g.Folders[0].ID != "y" {
		t.Errorf("delete: %+v", g.Folders)
	}
	g = apply(Edit{Kind: EditMoveFolder, Folder: "y", By: -1})
	if g.Folders[0].ID != "y" || g.Folders[0].Order != 0 || g.Folders[1].Order != 1 {
		t.Errorf("move up: %+v", g.Folders)
	}
	if g := apply(Edit{Kind: EditMoveFolder, Folder: "y", By: 1}); !GroupsEqual(g, base) {
		t.Errorf("moving the last folder down changed %+v", g)
	}
}

func TestFolderNameAndID(t *testing.T) {
	if got := FolderName("  \n "); got != "" {
		t.Errorf("blank: %q", got)
	}
	long := strings.Repeat("é", 70)
	if got := FolderName("  " + long + " "); got != strings.Repeat("é", 64) {
		t.Errorf("long: %d runes", len([]rune(got)))
	}
	id := NewFolderID()
	if len(id) != 12 || strings.Trim(id, "0123456789abcdef") != "" || id == NewFolderID() {
		t.Errorf("id %q", id)
	}
}
