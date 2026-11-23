package herdr

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

var updateWebBoard = flag.Bool("update", false, "rewrite testdata/web_board.golden.json")

// webBoard is one golden case: what a desk publishes for an agent.list
// reply, a guest's with no view (desk_guest.go runGuest) and an owner's
// with folders, stars, open folders and a search, which src/web/board.ts
// must reproduce in the browser (test/webboard.test.ts).
type webBoard struct {
	Name         string   `json:"name"`
	DisplayNames []string `json:"displayNames"`
	Board        Board    `json:"board"`
}

// TestWebBoardGolden pins BuildBoard and DisplayName for the fixture
// agent.list replies (web_board_cases.json with View{}, then
// web_board_view_cases.json with each case's view), so the TS port is held
// to Go's output.
func TestWebBoardGolden(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "web_board_cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name   string               `json:"name"`
		Agents []herdrapi.AgentInfo `json:"agents"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	raw, err = os.ReadFile(filepath.Join("testdata", "web_board_view_cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var viewed struct {
		Herds map[string][]herdrapi.AgentInfo `json:"herds"`
		Cases []struct {
			Name string `json:"name"`
			Herd string `json:"herd"`
			View struct {
				Groups *Groups         `json:"groups"`
				Open   map[string]bool `json:"open"`
				Query  string          `json:"query"`
			} `json:"view"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &viewed); err != nil {
		t.Fatal(err)
	}
	got := []webBoard{}
	names := func(agents []herdrapi.AgentInfo) []string {
		out := []string{}
		for _, a := range agents {
			out = append(out, DisplayName(a))
		}
		return out
	}
	for _, c := range cases {
		got = append(got, webBoard{c.Name, names(c.Agents), BuildBoard(c.Agents, View{})})
	}
	for _, c := range viewed.Cases {
		agents := viewed.Herds[c.Herd]
		v := View{Groups: c.View.Groups, Open: c.View.Open, Query: c.View.Query}
		got = append(got, webBoard{c.Name, names(agents), BuildBoard(agents, v)})
	}
	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", " ")
	if err := enc.Encode(got); err != nil {
		t.Fatal(err)
	}
	golden := filepath.Join("testdata", "web_board.golden.json")
	if *updateWebBoard {
		if err := os.WriteFile(golden, out.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out.Bytes(), want) {
		t.Fatalf("board differs from %s (go test ./internal/herdr -run TestWebBoardGolden -update to accept, then check test/webboard.test.ts):\n%s", golden, out.String())
	}
}
