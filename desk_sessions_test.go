package main

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

func TestRunningSessionsOrder(t *testing.T) {
	in := []bridge.Session{
		{Name: "default", Default: true, Running: true},
		{Name: "s10", Running: true},
		{Name: "Work", Running: true},
		{Name: "s2", Running: true},
		{Name: "asleep", Running: false},
		{Name: "alpha", Running: true},
	}
	var got []string
	for _, s := range runningSessions(in) {
		got = append(got, s.Name)
	}
	want := []string{"alpha", "s2", "s10", "Work", "default"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestPillsOf(t *testing.T) {
	one := []bridge.Session{{Name: "default", Default: true, Running: true}}
	if p := pillsOf(one, "", nil); len(p) != 0 {
		t.Fatalf("one session shows pills: %v", p)
	}
	two := []bridge.Session{{Name: "work", Running: true}, {Name: "default", Default: true, Running: true}}
	for _, current := range []string{"", "default"} {
		p := pillsOf(two, current, map[string]int{"work": 3})
		want := []SessionPill{{Name: "work", NeedsYou: 3}, {Name: "default", Default: true, Selected: true}}
		if !reflect.DeepEqual(p, want) {
			t.Fatalf("current %q: got %+v, want %+v", current, p, want)
		}
	}
	if p := pillsOf(two, "work", nil); !p[0].Selected || p[1].Selected {
		t.Fatalf("named current: %+v", p)
	}
}

func TestSessionGone(t *testing.T) {
	running := []bridge.Session{{Name: "work", Running: true}, {Name: "default", Default: true, Running: true}}
	for _, tc := range []struct {
		current string
		want    bool
	}{{"", false}, {"default", false}, {"work", false}, {"play", true}} {
		if got := sessionGone(running, tc.current); got != tc.want {
			t.Errorf("%q: got %v", tc.current, got)
		}
	}
}

func TestNeedsYouCount(t *testing.T) {
	var agents []herdrapi.AgentInfo
	if err := json.Unmarshal([]byte(`[
		{"pane_id":"1","agent_status":"blocked"},
		{"pane_id":"2","agent_status":"working","input_pending":true},
		{"pane_id":"3","agent_status":"unknown","last_known_status":"blocked","reachability":"degraded"},
		{"pane_id":"4","agent_status":"working"},
		{"pane_id":"5","agent_status":"blocked","archived":{"at":"2026-01-01T00:00:00Z","by":"x"}}
	]`), &agents); err != nil {
		t.Fatal(err)
	}
	if n := needsYouCount(agents); n != 3 {
		t.Fatalf("got %d, want 3", n)
	}
}

func TestAccountLabelsFirstWins(t *testing.T) {
	got := accountLabels([]herdrapi.AccountInfo{{ID: "a", Label: "Work"}, {ID: "a", Label: "Dup"}, {ID: "b", Label: "Home"}})
	if !reflect.DeepEqual(got, map[string]string{"a": "Work", "b": "Home"}) {
		t.Fatalf("got %v", got)
	}
}

func TestSessionSwitchSeedsFromRecentBoard(t *testing.T) {
	d := newDesk(t.TempDir())
	now := time.Unix(1_700_000_000, 0)
	work := herdr.Board{Total: 7}
	home := &BoardUpdate{Board: herdr.Board{Total: 2}}
	d.sessions.pills = []SessionPill{{Name: "work"}, {Name: "default", Default: true, Selected: true}}
	// Leaving the default session keeps its board.
	if b := d.sessionSwitched("", "work", home, now); b != nil {
		t.Fatalf("seeded work with no board seen: %+v", b)
	}
	if !d.sessions.pills[0].Selected || d.sessions.pills[1].Selected {
		t.Fatalf("pills did not follow the switch: %+v", d.sessions.pills)
	}
	if b := d.sessionSwitched("work", "default", &BoardUpdate{Board: work}, now.Add(60*time.Second)); b == nil || b.Total != 2 {
		t.Fatalf("a 60 s old board was not used: %+v", b)
	}
	if b := d.sessionSwitched("default", "work", nil, now.Add(121*time.Second)); b != nil {
		t.Fatalf("a 61 s old board was used: %+v", b)
	}
}

func TestStandardLess(t *testing.T) {
	for _, tc := range []struct {
		a, b string
		want bool
	}{
		{"a", "B", true}, {"B", "a", false}, {"s2", "s10", true}, {"s10", "s2", false},
		{"s02", "s3", true}, {"ab", "abc", true}, {"abc", "ab", false}, {"x", "x", false},
	} {
		if got := standardLess(tc.a, tc.b); got != tc.want {
			t.Errorf("%q < %q: got %v", tc.a, tc.b, got)
		}
	}
}
