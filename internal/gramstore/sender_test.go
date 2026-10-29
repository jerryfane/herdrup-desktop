package gramstore

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// Translated from herdrup Tests/HerdrKitTests/GramSenderTests.swift,
// GramExpiredFileTests.swift and AgentAvatarTests.swift
// (testGramSendersResolveThroughTheRoster) at 9876878.

const alias = "8195b6326f748f4da1945364a4e205b9"

func decodeMsg(t *testing.T, raw string) herdrapi.GramMessageInfo {
	t.Helper()
	var m herdrapi.GramMessageInfo
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func from(t *testing.T, id, from, extra string) herdrapi.GramMessageInfo {
	return decodeMsg(t, `{"id":"`+id+`","direction":"agent_to_owner","from":"`+from+`","text":"hi","created_unix_ms":1750000000000,"read_by_owner":false`+extra+`}`)
}

// testAFederatedSenderReadsAsItsMachineLabel
func TestSenderAFederatedSenderReadsAsItsMachineLabel(t *testing.T) {
	a := from(t, "g1", alias+"/llm-opt", `,"machine_label":"Mac Studio"`)
	b := from(t, "g2", alias+"/w1:p2/scout", `,"machine_label":"Mac Studio"`)
	if SenderName(a) != "Mac Studio/llm-opt" || a.From != alias+"/llm-opt" || SenderName(b) != "Mac Studio/w1:p2/scout" {
		t.Fatalf("%q %q", SenderName(a), SenderName(b))
	}
}

// testWithoutALabelTheSenderIsUnchanged
func TestSenderWithoutALabelTheSenderIsUnchanged(t *testing.T) {
	var got []string
	for _, m := range []herdrapi.GramMessageInfo{
		from(t, "g1", alias+"/llm-opt", ""),
		from(t, "g2", alias+"/llm-opt", `,"machine_label":""`),
		from(t, "g3", "trend-scout", ""),
		from(t, "g4", "trend-scout", `,"machine_label":"Mac Studio"`),
	} {
		got = append(got, SenderName(m))
	}
	if !slices.Equal(got, []string{alias + "/llm-opt", alias + "/llm-opt", "trend-scout", "trend-scout"}) {
		t.Fatalf("%q", got)
	}
}

// testSenderSplitsIntoBareAgentNameAndMachine
func TestSenderSplitsIntoBareAgentNameAndMachine(t *testing.T) {
	ms := []herdrapi.GramMessageInfo{
		from(t, "g1", alias+"/llm-opt", `,"machine_label":"hetzner-1"`),
		from(t, "g2", alias+"/w1:p2/scout", `,"machine_label":"hetzner-1"`),
		from(t, "g3", alias+"/llm-opt", ""),
		from(t, "g4", alias+"/llm-opt", `,"machine_label":""`),
		from(t, "g5", "trend-scout", ""),
		from(t, "g6", "trend-scout", `,"machine_label":"mac-studio"`),
	}
	var names, machines []string
	for _, m := range ms {
		names = append(names, AgentName(m.From))
		machines = append(machines, SenderMachine(m))
	}
	if !slices.Equal(names, []string{"llm-opt", "scout", "llm-opt", "llm-opt", "trend-scout", "trend-scout"}) {
		t.Errorf("names %q", names)
	}
	if !slices.Equal(machines, []string{"hetzner-1", "hetzner-1", alias, alias, "", "mac-studio"}) {
		t.Errorf("machines %q", machines)
	}
}

// testAgentNameOfARoutingName
func TestSenderAgentNameOfARoutingName(t *testing.T) {
	for in, want := range map[string]string{"vetrina": "vetrina", alias + "/clientloop": "clientloop", "a/b/c": "c", "odd/": "odd/"} {
		if got := AgentName(in); got != want {
			t.Errorf("AgentName(%q) = %q, want %q", in, got, want)
		}
	}
}

// GramExpiredFileTests: testAnExpiredFileDecodesAsMetadataOnly,
// testAbsentExpiredFileStaysNil, testAFileAndAnExpiredFileAreNeverBothOpenable
// (the attachment preview half; the desk drops an expired file beside a
// live one when it builds a row).
func TestAttachmentPreview(t *testing.T) {
	expired := `,"expired_file":{"name":"chart.png","size":873472,"mime":"image/png","sha256":"18ce"}`
	live := `,"file":{"name":"report.zip","size":1024,"mime":"application/zip","sha256":"3d5e"}`
	for extra, want := range map[string]string{expired: "chart.png (expired)", "": "", live: "report.zip", live + expired: "report.zip"} {
		if got := AttachmentPreview(from(t, "g1", "vetrina", extra)); got != want {
			t.Errorf("%s: %q, want %q", extra, got, want)
		}
	}
}

// testGramSendersResolveThroughTheRoster (the federated namesake listed
// first, so a local sender cannot pick it up by its bare name)
func TestAgentForSenderResolvesThroughTheRoster(t *testing.T) {
	var roster []herdrapi.AgentInfo
	if err := json.Unmarshal([]byte(`[
		{"pane_id":"4b1e/w1:p2","terminal_id":"t-2","name":"4b1e/clientloop","machine_id":"4b1e","machine_label":"hetzner-1","avatar":{"style":"mascot","mascot":"zag"}},
		{"pane_id":"w1:p1","terminal_id":"t-1","name":"clientloop","avatar":{"style":"mascot","mascot":"bot"}},
		{"pane_id":"w1:p3","terminal_id":"t-3","name":"vetrina"}]`), &roster); err != nil {
		t.Fatal(err)
	}
	for from, want := range map[string]string{
		"clientloop":            "t-1", // a local sender is the local agent, not the federated namesake
		"4b1e/clientloop":       "t-2",
		"4b1e/w1:p2/clientloop": "t-2",
		"hetzner-1/clientloop":  "t-2", // the machine label names the machine too
		"other/clientloop":      "",
		"forgotten":             "",
	} {
		a, ok := AgentForSender(from, roster)
		if got := map[bool]string{true: a.TerminalID}[ok]; got != want {
			t.Errorf("AgentForSender(%q) = %q, want %q", from, got, want)
		}
	}
}
