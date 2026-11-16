package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// herdr #452: the chat reads an after page's `resent` through ChatTranscript,
// which decodes and re-encodes the page. An empty list must stay present
// (it says nothing was re-sent: keep every entry) and an absent one absent
// (an older server: the page falls back to the timestamp rule).
func TestTranscriptPageKeepsResentPresence(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{`"resent":[]`, `"resent":[]`},
		{`"resent":["a","b"]`, `"resent":["a","b"]`},
		{``, ``},
	} {
		raw := `{"after":"c","agent":"omp","pane_id":"w1:p1","session_id":"s","entries":[]`
		if tc.in != "" {
			raw += "," + tc.in
		}
		raw += "}"
		var page herdrapi.ResponseResultAgentTranscript
		if err := json.Unmarshal([]byte(raw), &page); err != nil {
			t.Fatal(err)
		}
		out, err := json.Marshal(page)
		if err != nil {
			t.Fatal(err)
		}
		got := string(out)
		if tc.want == "" {
			if strings.Contains(got, "resent") {
				t.Fatalf("absent resent came back as %s", got)
			}
		} else if !strings.Contains(got, tc.want) {
			t.Fatalf("resent %s came back as %s", tc.in, got)
		}
	}
}
