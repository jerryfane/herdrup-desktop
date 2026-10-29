package main

import (
	"slices"
	"strings"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

func TestStartedNeedingYou(t *testing.T) {
	agent := func(pane string, status herdrapi.AgentStatus) herdrapi.AgentInfo {
		return herdrapi.AgentInfo{PaneID: pane, AgentStatus: status}
	}
	archived := agent("a", herdrapi.AgentStatusBlocked)
	archived.Archived = &herdrapi.AgentArchivedInfo{}
	const (
		w = herdrapi.AgentStatusWorking
		b = herdrapi.AgentStatusBlocked
	)
	// Each step is one agent list of a watch; reset starts a new watch (a
	// connect, reconnect or session switch) before that list.
	type step struct {
		reset  bool
		agents []herdrapi.AgentInfo
		want   []string // panes notified
	}
	for _, tc := range []struct {
		name  string
		steps []step
	}{
		{"already blocked at connect", []step{
			{reset: true, agents: []herdrapi.AgentInfo{agent("a", b), agent("b", w)}},
			{agents: []herdrapi.AgentInfo{agent("a", b), agent("b", w)}},
		}},
		{"working to blocked", []step{
			{reset: true, agents: []herdrapi.AgentInfo{agent("a", w)}},
			{agents: []herdrapi.AgentInfo{agent("a", b)}, want: []string{"a"}},
		}},
		{"blocked stays blocked", []step{
			{reset: true, agents: []herdrapi.AgentInfo{agent("a", w)}},
			{agents: []herdrapi.AgentInfo{agent("a", b)}, want: []string{"a"}},
			{agents: []herdrapi.AgentInfo{agent("a", b)}},
			{agents: []herdrapi.AgentInfo{agent("a", b)}},
		}},
		{"blocked, working, blocked", []step{
			{reset: true, agents: []herdrapi.AgentInfo{agent("a", w)}},
			{agents: []herdrapi.AgentInfo{agent("a", b)}, want: []string{"a"}},
			{agents: []herdrapi.AgentInfo{agent("a", w)}},
			{agents: []herdrapi.AgentInfo{agent("a", b)}, want: []string{"a"}},
		}},
		{"removed then back blocked", []step{
			{reset: true, agents: []herdrapi.AgentInfo{agent("a", b), agent("b", w)}},
			{agents: []herdrapi.AgentInfo{agent("b", w)}},
			{agents: []herdrapi.AgentInfo{agent("a", b), agent("b", w)}, want: []string{"a"}},
		}},
		{"new agent arrives blocked", []step{
			{reset: true, agents: []herdrapi.AgentInfo{agent("a", w)}},
			{agents: []herdrapi.AgentInfo{agent("a", w), agent("b", b)}, want: []string{"b"}},
		}},
		{"archived does not need you", []step{
			{reset: true, agents: nil},
			{agents: []herdrapi.AgentInfo{archived}},
		}},
		{"session switch or reconnect resets the baseline", []step{
			{reset: true, agents: []herdrapi.AgentInfo{agent("a", w)}},
			{reset: true, agents: []herdrapi.AgentInfo{agent("a", b), agent("b", b)}},
			{agents: []herdrapi.AgentInfo{agent("a", b), agent("b", b)}},
			// Left needing you while away: back on this session it is news.
			{reset: true, agents: []herdrapi.AgentInfo{agent("a", w)}},
			{agents: []herdrapi.AgentInfo{agent("a", b)}, want: []string{"a"}},
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var needing map[string]bool
			for i, s := range tc.steps {
				if s.reset {
					needing = nil
				}
				var started []herdrapi.AgentInfo
				needing, started = startedNeedingYou(needing, s.agents)
				var got []string
				for _, a := range started {
					got = append(got, a.PaneID)
				}
				if !slices.Equal(got, s.want) {
					t.Errorf("list %d notified %v, want %v", i, got, s.want)
				}
			}
		})
	}
}

// The tray lists what the board's needs-you section lists, folders and
// all, and nothing else.
func TestNeedingRows(t *testing.T) {
	agents := []herdrapi.AgentInfo{
		{PaneID: "w", AgentStatus: herdrapi.AgentStatusWorking},
		{PaneID: "b1", AgentStatus: herdrapi.AgentStatusBlocked, Name: new("one")},
		{PaneID: "b2", AgentStatus: herdrapi.AgentStatusBlocked, Name: new("two")},
	}
	v := herdr.View{Groups: &herdr.Groups{Folders: []herdrapi.AgentGroupFolder{{ID: "f", Name: "F", Members: []string{"two"}}}}}
	var got []string
	for _, r := range needingRows(herdr.BuildBoard(agents, v)) {
		got = append(got, r.ID)
	}
	slices.Sort(got)
	if !slices.Equal(got, []string{"b1", "b2"}) {
		t.Errorf("needing rows %v, want b1 b2", got)
	}
	if rows := needingRows(herdr.BuildBoard(agents[:1], herdr.View{})); len(rows) != 0 {
		t.Errorf("no one waits, rows %v", rows)
	}
}

// serve applies only the latest rows the desk queued, so an overtaken
// board never shows, and every agent that started needing you.
func TestPresenceKeepsTheLatestRowsAndEveryStart(t *testing.T) {
	p := newPresence()
	p.show([]herdr.Row{{ID: "old"}})
	p.notify([]herdrapi.AgentInfo{{PaneID: "a"}})
	p.show([]herdr.Row{{ID: "new"}})
	p.notify(nil)
	p.notify([]herdrapi.AgentInfo{{PaneID: "b"}})
	close(p.wake) // serve drains what is queued, then returns
	var shown, notified []string
	p.serve(func(rows []herdr.Row) {
		for _, r := range rows {
			shown = append(shown, r.ID)
		}
	}, func(a herdrapi.AgentInfo) { notified = append(notified, a.PaneID) })
	if !slices.Equal(shown, []string{"new"}) {
		t.Errorf("shown %v, want new", shown)
	}
	if !slices.Equal(notified, []string{"a", "b"}) {
		t.Errorf("notified %v, want a b", notified)
	}
}

// The title names the agent as herdr's push does: its own name, its tool
// when it has none, and a federated agent by its name and machine label
// rather than the machine id.
func TestAttentionTitleNamesTheAgent(t *testing.T) {
	for _, tc := range []struct {
		a          herdrapi.AgentInfo
		has, hasnt []string
	}{
		{herdrapi.AgentInfo{PaneID: "w1:p1", Name: new("jarvis"), Agent: new("claude")}, []string{"jarvis"}, []string{"claude", "w1:p1"}},
		{herdrapi.AgentInfo{PaneID: "w1:p1", Name: new("  "), Agent: new("claude")}, []string{"claude"}, []string{"w1:p1"}},
		{herdrapi.AgentInfo{PaneID: "m1/w1:p1", Name: new("m1/llm-opt"), Agent: new("omp"), MachineID: new("m1"), MachineLabel: new("Studio")}, []string{"llm-opt", "Studio"}, []string{"m1", "omp"}},
		{herdrapi.AgentInfo{PaneID: "m1/w1:p1", Name: new("m1/llm-opt"), Agent: new("omp"), MachineID: new("m1")}, []string{"llm-opt", "m1"}, []string{"m1/", "omp"}},
		{herdrapi.AgentInfo{PaneID: "w1:p3"}, []string{"w1:p3"}, nil},
	} {
		got := attentionTitle(tc.a)
		for _, s := range tc.has {
			if !strings.Contains(got, s) {
				t.Errorf("%q lacks %q", got, s)
			}
		}
		for _, s := range tc.hasnt {
			if strings.Contains(got, s) {
				t.Errorf("%q has %q", got, s)
			}
		}
	}
}
