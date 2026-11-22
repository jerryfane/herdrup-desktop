package main

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// The Topics switch (herdr #489, herdrup #788): Turn on/off topics follows
// Restart agent for an omp agent on a server with agent_topics_switch that
// reports topics_enabled, and asks for the other state.
func TestTopicsSwitchInTheAgentRowMenu(t *testing.T) {
	omp := func(enabled *bool) herdrapi.AgentInfo {
		return herdrapi.AgentInfo{PaneID: "w1:p2", TerminalID: "t2", Name: new("docs"), Agent: new("omp"), TopicsEnabled: enabled}
	}
	on, off := true, false
	caps := &herdrapi.ServerCapabilities{AgentTopicsSwitch: true}
	labels := func(a herdrapi.AgentInfo, caps *herdrapi.ServerCapabilities) []string {
		return menuLabels(agentRowMenu(agentMenuInput{Info: a, Caps: caps}))
	}
	if got, want := labels(omp(&off), caps), []string{"Stop agent", "Rename", "Restart agent", "Turn on topics", "Archive"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("topics off: %q, want %q", got, want)
	}
	if got := labels(omp(&on), caps); !slices.Contains(got, "Turn off topics") || slices.Contains(got, "Turn on topics") {
		t.Fatalf("topics on: %q", got)
	}
	for name, menu := range map[string][]string{
		"no agent_topics_switch":  labels(omp(&off), &herdrapi.ServerCapabilities{AgentTopics: true}),
		"no ping yet":             labels(omp(&off), nil),
		"no topics_enabled":       labels(omp(nil), caps),
		"not omp":                 labels(herdrapi.AgentInfo{PaneID: "w1:p1", Agent: new("claude"), TopicsEnabled: &off}, caps),
		"omp-like harness prefix": labels(herdrapi.AgentInfo{PaneID: "w1:p1", Agent: new("ompish"), TopicsEnabled: &off}, caps),
	} {
		if slices.ContainsFunc(menu, func(l string) bool { return l == "Turn on topics" || l == "Turn off topics" }) {
			t.Errorf("%s: %q offers the switch", name, menu)
		}
	}
	for enabled, want := range map[bool]bool{false: true, true: false} {
		entries := agentRowMenu(agentMenuInput{Info: omp(&enabled), Caps: caps})
		i := slices.IndexFunc(entries, func(e menuEntry) bool { return e.Action != nil && e.Action.Kind == "topics" })
		if i < 0 {
			t.Fatalf("topics_enabled %v: no switch", enabled)
		}
		if a := entries[i].Action; a.Enable != want || a.PaneID != "w1:p2" || a.Title != "docs" || entries[i].Icon != "rectangle.stack" {
			t.Errorf("topics_enabled %v: %+v icon %q; want Enable %v", enabled, a, entries[i].Icon, want)
		}
	}
}

// suggestionsDesk opens w1:p1 (an omp agent) on a fake herdr whose topics
// fixture is set up by configure (Suggestions on unless configure says
// otherwise) and whose pong pong edits last, with a one-message Inbox, and
// records what the page is sent.
func suggestionsDesk(t *testing.T, configure func(*fakeherdr.Topics), pong func(map[string]any)) (*Desk, *fakeherdr.Topics, func() []TopicsUpdate) {
	t.Helper()
	var mu sync.Mutex
	var updates []TopicsUpdate
	previous := publishTopics
	publishTopics = func(u TopicsUpdate) {
		mu.Lock()
		updates = append(updates, withLists(u))
		mu.Unlock()
	}
	t.Cleanup(func() { publishTopics = previous })
	fixture := fakeherdr.NewTopics()
	fixture.Turn, fixture.SwitchDelay, fixture.Suggestions = 50*time.Millisecond, 10*time.Millisecond, true
	if configure != nil {
		configure(fixture)
	}
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		base, events := s.Handle, s.Events
		served := fixture.Serve(func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "agent.list":
				return map[string]any{"type": "agent_list", "agents": []any{map[string]any{"pane_id": "w1:p1", "agent": "omp", "agent_status": "idle"}}}, nil
			case "agent.transcript":
				return map[string]any{"type": "agent_transcript", "agent": "omp", "pane_id": "w1:p1", "session_id": "inbox", "after": "a1",
					"entries": []any{map[string]any{"kind": "user", "id": "u1", "ts_ms": 1, "author": "owner", "text": "Review the workspace."}}}, nil
			case "ping":
				p := fakeherdr.Pong(true)
				p["capabilities"].(map[string]bool)["agent_transcript"] = true
				return p, nil
			}
			return base(method, raw)
		})
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			value, err := served(method, raw)
			if method == "ping" && pong != nil {
				pong(value.(map[string]any))
			}
			return value, err
		}
		s.Events = func(ctx context.Context, emit func([]byte) error) {
			if events != nil {
				go events(ctx, emit)
			}
			fixture.Events(ctx, emit)
		}
	})
	board := d.Board()
	if _, err := d.OpenAgentView(AgentTarget{MachineID: board.MachineID, Session: board.Session, PaneID: "w1:p1"}, "view"); err != nil {
		t.Fatal(err)
	}
	return d, fixture, func() []TopicsUpdate {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(updates)
	}
}

func suggestionIDs(u TopicsUpdate) []string {
	var ids []string
	for _, s := range u.Suggestions {
		ids = append(ids, s.SuggestionID)
	}
	return ids
}

// inboxSuggestion reads the Inbox's newest page and returns its
// topic_suggestion entry id, as the page gets it.
func inboxSuggestion(t *testing.T, d *Desk, id string) map[string]any {
	t.Helper()
	raw, err := d.ChatTranscript(context.Background(), "view", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	var page struct {
		Entries []map[string]any `json:"entries"`
	}
	if err := json.Unmarshal([]byte(raw), &page); err != nil {
		t.Fatal(err)
	}
	for _, e := range page.Entries {
		if e["kind"] == "topic_suggestion" && e["id"] == id {
			return e
		}
	}
	t.Fatalf("no topic_suggestion %s in %s", id, raw)
	return nil
}

// The agent's suggestions end to end (herdr #490, herdrup #788): the list
// carries them and offers Organise, the Inbox's transcript carries their
// entries through the app's decoding, Start opens a topic, Not now sets one
// aside, Organise proposes more, and each refusal reads in the app's words.
func TestTopicSuggestionsStartNotNowAndOrganise(t *testing.T) {
	d, _, updates := suggestionsDesk(t, nil, nil)
	ctx := context.Background()
	if err := d.TopicsFollow("view", true); err != nil {
		t.Fatal(err)
	}
	last := func() TopicsUpdate { u := updates(); return u[len(u)-1] }
	waitFor(t, "the first list", func() bool { u := updates(); return len(u) > 0 && last().Loaded })
	first := last()
	if !first.SuggestionsServed || !slices.Equal(suggestionIDs(first), []string{"sg1"}) || first.Suggestions[0].Title != "Workspace review" ||
		!slices.Equal(first.Suggestions[0].MessageIDs, []string{"u1", "r1", "n1"}) || first.RequestedMs <= 0 {
		t.Fatalf("first list %+v; want sg1 served with its three messages", first)
	}
	if e := inboxSuggestion(t, d, "sg1"); e["state"] != "open" || e["title"] != "Workspace review" || e["message_count"] != float64(3) {
		t.Fatalf("open entry %v", e)
	}

	queued, err := d.TopicsOrganise(ctx, "view")
	if err != nil || queued {
		t.Fatalf("organise: %v, %v; want started at once", queued, err)
	}
	if _, err := d.TopicsOrganise(ctx, "view"); err == nil || err.Error() != "The agent is already organising." {
		t.Fatalf("second organise: %v", err)
	}
	waitFor(t, "Organise's proposals", func() bool { return len(last().Suggestions) == 3 })

	topicID, err := d.TopicsAcceptSuggestion(ctx, "view", "sg1")
	if err != nil || topicID == "" {
		t.Fatalf("start: %q, %v", topicID, err)
	}
	waitFor(t, "the started topic listed and sg1 no longer open", func() bool {
		u := last()
		return !slices.Contains(suggestionIDs(u), "sg1") && slices.ContainsFunc(u.Topics, func(x herdrapi.AgentTopicInfo) bool {
			return x.TopicID == topicID && x.Title == "Workspace review"
		})
	})
	if e := inboxSuggestion(t, d, "sg1"); e["state"] != "accepted" || e["topic_id"] != topicID || e["by"] != "owner" {
		t.Fatalf("accepted entry %v; want topic %s", e, topicID)
	}
	if again, err := d.TopicsAcceptSuggestion(ctx, "view", "sg1"); err != nil || again != topicID {
		t.Fatalf("a second Start: %q, %v; want the same topic", again, err)
	}

	if err := d.TopicsDismissSuggestion(ctx, "view", "sg2"); err != nil {
		t.Fatal(err)
	}
	if e := inboxSuggestion(t, d, "sg2"); e["state"] != "dismissed" {
		t.Fatalf("dismissed entry %v", e)
	}
	if err := d.TopicsDismissSuggestion(ctx, "view", "sg1"); err == nil || err.Error() != "Someone already started that topic." {
		t.Fatalf("Not now after Start: %v", err)
	}
	if _, err := d.TopicsAcceptSuggestion(ctx, "view", "sg9"); err == nil || err.Error() != "That suggestion is gone." {
		t.Fatalf("a missing suggestion: %v", err)
	}
	waitFor(t, "only sg3 open", func() bool { return slices.Equal(suggestionIDs(last()), []string{"sg3"}) })
}

// The Inbox follows the list as Topics does while the agent's suggestions are
// served (iOS ChatView): Organise's proposals arrive with Topics never shown,
// and the watch stops with the Inbox and with the view.
func TestTopicsInboxFollowsServedSuggestions(t *testing.T) {
	d, _, updates := suggestionsDesk(t, nil, nil)
	ctx := context.Background()
	last := func() TopicsUpdate { u := updates(); return u[len(u)-1] }
	if err := d.TopicsFollowInbox("view", true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the first list", func() bool { u := updates(); return len(u) > 0 && last().SuggestionsServed })
	if _, err := d.TopicsOrganise(ctx, "view"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "Organise's proposals without Topics shown", func() bool { return len(last().Suggestions) == 3 })

	following := func() bool {
		v, err := d.agentView("view")
		if err != nil {
			return false
		}
		v.topics.mu.Lock()
		defer v.topics.mu.Unlock()
		return v.topics.cancel != nil
	}
	if !following() {
		t.Fatal("the open Inbox on served suggestions does not follow the list")
	}
	if err := d.TopicsFollowInbox("view", false); err != nil {
		t.Fatal(err)
	}
	if following() {
		t.Fatal("the closed Inbox still follows the list")
	}
	if _, err := d.TopicsOrganise(ctx, "view"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	// Organise's own read lists the 3 open; its proposals a turn later are
	// not read without a follower.
	if n := len(last().Suggestions); n != 3 {
		t.Fatalf("%d suggestions listed after the Inbox closed; want the 3 before Organise's proposals", n)
	}

	if err := d.TopicsFollowInbox("view", true); err != nil || !following() {
		t.Fatalf("reopened Inbox: following %v, %v", following(), err)
	}
	v, _ := d.agentView("view")
	d.CloseAgentView("view")
	v.topics.mu.Lock()
	cancel := v.topics.cancel
	v.topics.mu.Unlock()
	if v.ctx.Err() == nil || cancel == nil {
		t.Fatalf("view closed: ctx %v; the follower's context is the view's", v.ctx.Err())
	}
}

// Organise shows only where both say so: the server advertises
// agent_topic_suggestions and the agent's list carries `suggestions`. An
// omp without them answers topics_unsupported; a server without the
// capability is never asked.
func TestTopicSuggestionsNeedTheCapabilityAndTheAgentsList(t *testing.T) {
	ctx := context.Background()
	t.Run("an omp without suggestions", func(t *testing.T) {
		d, _, updates := suggestionsDesk(t, func(f *fakeherdr.Topics) { f.WithoutSuggestions("w1:p1") }, nil)
		if err := d.TopicsRefresh(ctx, "view"); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "the list", func() bool { u := updates(); return len(u) > 0 && u[len(u)-1].Loaded })
		if u := updates()[len(updates())-1]; !u.Offered || u.SuggestionsServed || len(u.Suggestions) != 0 {
			t.Fatalf("list %+v; want topics without suggestions", u)
		}
		if _, err := d.TopicsOrganise(ctx, "view"); err == nil || err.Error() != "This agent has no topics." {
			t.Fatalf("organise: %v", err)
		}
	})
	t.Run("a server without agent_topic_suggestions", func(t *testing.T) {
		d, _, updates := suggestionsDesk(t, nil, func(p map[string]any) {
			delete(p["capabilities"].(map[string]bool), "agent_topic_suggestions")
		})
		if err := d.TopicsRefresh(ctx, "view"); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "the list", func() bool { u := updates(); return len(u) > 0 && u[len(u)-1].Loaded })
		if u := updates()[len(updates())-1]; u.SuggestionsServed {
			t.Fatalf("list %+v offers Organise on a server without the capability", u)
		}
		if _, err := d.TopicsOrganise(ctx, "view"); err == nil || err.Error() != "This server doesn't suggest topics." {
			t.Fatalf("organise: %v", err)
		}
	})
}

// The owner's switch: set_enabled restarts the agent onto the topics build,
// a second call changes nothing, and a server without the switch refuses
// before sending. Its refusals complete "Couldn't turn on topics: …".
func TestTopicsSetEnabled(t *testing.T) {
	ctx := context.Background()
	switched := make(chan struct{}, 4)
	d, _, _ := suggestionsDesk(t, func(f *fakeherdr.Topics) {
		f.TurnOff("w1:p1")
		f.OnSwitch = func() { switched <- struct{}{} }
	}, nil)
	if _, err := d.TopicsOrganise(ctx, "view"); err == nil || err.Error() != "Topics are off for this agent." {
		t.Fatalf("organise with topics off: %v", err)
	}
	got, err := d.TopicsSetEnabled(ctx, "w1:p1", true)
	if err != nil || got != (TopicsSwitched{Changed: true, TopicsEnabled: true}) {
		t.Fatalf("turn on: %+v, %v", got, err)
	}
	select {
	case <-switched:
	default:
		t.Fatal("the switch did not restart the agent")
	}
	if got, err := d.TopicsSetEnabled(ctx, "w1:p1", true); err != nil || got != (TopicsSwitched{Changed: false, TopicsEnabled: true}) {
		t.Fatalf("turn on again: %+v, %v; want unchanged", got, err)
	}
	if _, err := d.TopicsOrganise(ctx, "view"); err != nil {
		t.Fatalf("organise with topics on: %v", err)
	}
}

func TestTopicsSetEnabledRefusals(t *testing.T) {
	plain, _, _ := suggestionsDesk(t, func(f *fakeherdr.Topics) { f.Suggestions = false }, nil)
	if _, err := plain.TopicsSetEnabled(context.Background(), "w1:p1", true); err == nil || err.Error() != "this server has no Topics switch." {
		t.Fatalf("a server without agent_topics_switch: %v", err)
	}
	for _, c := range []struct {
		err  error
		want string
	}{
		{&bridge.APIError{Code: "topics_build_missing", Message: "x"}, "this server has no omp build with topics."},
		{&bridge.APIError{Code: "not_omp", Message: "x"}, "only omp agents have topics."},
		{&bridge.APIError{Code: "guest_forbidden", Message: "x"}, "only the owner can switch topics."},
		{&bridge.APIError{Code: "agent_directory_unavailable", Message: "x"}, "the agent's folder is not available."},
		{&bridge.APIError{Code: "no_resumable_session", Message: "no session to resume"}, "no session to resume"},
		{&engine.ErrUnsupported{Method: "agent.topics.set_enabled", Capability: herdrapi.CapabilityAgentTopicsSwitch}, "this server has no Topics switch."},
		{errors.New("broken pipe"), "couldn't reach the server."},
	} {
		if got := topicsSwitchProblem(c.err); got != c.want {
			t.Errorf("%v: %q, want %q", c.err, got, c.want)
		}
	}
}

// Create N topics starts the ticked proposals and sets the rest aside; one
// someone settled first is skipped, not reported (TopicsModel.settleProposals).
func TestTopicsSettleSuggestions(t *testing.T) {
	d, _, updates := suggestionsDesk(t, nil, nil)
	ctx := context.Background()
	if _, err := d.TopicsOrganise(ctx, "view"); err != nil {
		t.Fatal(err)
	}
	if err := d.TopicsFollow("view", true); err != nil {
		t.Fatal(err)
	}
	last := func() TopicsUpdate { u := updates(); return u[len(u)-1] }
	waitFor(t, "three proposals", func() bool { u := updates(); return len(u) > 0 && len(last().Suggestions) == 3 })
	if _, err := d.TopicsAcceptSuggestion(ctx, "view", "sg2"); err != nil {
		t.Fatal(err)
	}
	problem, err := d.TopicsSettleSuggestions(ctx, "view", []string{"sg1", "sg2"}, []string{"sg3"})
	if err != nil || problem != "" {
		t.Fatalf("settle: %q, %v; want sg2 (already started) skipped", problem, err)
	}
	if e := inboxSuggestion(t, d, "sg1"); e["state"] != "accepted" {
		t.Fatalf("sg1 %v", e)
	}
	if e := inboxSuggestion(t, d, "sg3"); e["state"] != "dismissed" {
		t.Fatalf("sg3 %v", e)
	}
	waitFor(t, "no proposals left", func() bool { return len(last().Suggestions) == 0 })
	if problem, _ := d.TopicsSettleSuggestions(ctx, "view", nil, []string{"sg1", "sg9"}); problem != "" {
		t.Fatalf("setting a started or missing one aside: %q; want skipped", problem)
	}
}

func TestTopicsSettleSuggestionsOnAnOmpWithoutThem(t *testing.T) {
	d, _, updates := suggestionsDesk(t, func(f *fakeherdr.Topics) { f.WithoutSuggestions("w1:p1") }, nil)
	before := len(updates())
	if problem, err := d.TopicsSettleSuggestions(context.Background(), "view", []string{"sg1"}, []string{"sg2"}); err != nil || problem != "This agent has no topics." {
		t.Fatalf("settle on an omp without suggestions: %q, %v", problem, err)
	}
	// The settle reads the list again in the background; let it publish
	// before the test ends, so it never overlaps the next test's hooks.
	waitFor(t, "the read after the settle", func() bool { return len(updates()) > before })
}

// Two different refusals in one settle: the first is the one reported, and
// someone else's earlier Start (already_accepted) is not a refusal.
func TestTopicsSettleSuggestionsReportsTheFirstRefusal(t *testing.T) {
	d, _, updates := suggestionsDesk(t, func(f *fakeherdr.Topics) {
		f.Refuse = map[string]*fakeherdr.APIError{
			"sg1": {Code: "already_accepted", Message: "started"},
			"sg2": {Code: "topic_rejected", Message: "busy"},
			"sg3": {Code: "topics_disabled", Message: "off"},
		}
	}, nil)
	before := len(updates())
	if problem, err := d.TopicsSettleSuggestions(context.Background(), "view", []string{"sg1", "sg2"}, []string{"sg3"}); err != nil || problem != "The agent refused: busy" {
		t.Fatalf("settle with two refusals: %q, %v; want the first", problem, err)
	}
	waitFor(t, "the read after the settle", func() bool { return len(updates()) > before })
}
