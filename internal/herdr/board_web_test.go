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

// webBoard is one golden case: what a guest's desk publishes for an
// agent.list reply (desk_guest.go runGuest), which src/web/board.ts must
// reproduce in the browser (test/webboard.test.ts).
type webBoard struct {
	Name         string   `json:"name"`
	DisplayNames []string `json:"displayNames"`
	Board        Board    `json:"board"`
}

// TestWebBoardGolden pins BuildBoard(agents, View{}) and DisplayName for
// the fixture agent.list replies, so the TS port is held to Go's output.
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
	got := []webBoard{}
	for _, c := range cases {
		names := []string{}
		for _, a := range c.Agents {
			names = append(names, DisplayName(a))
		}
		got = append(got, webBoard{c.Name, names, BuildBoard(c.Agents, View{})})
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
