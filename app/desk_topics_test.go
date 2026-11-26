package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// The Topics view's order (herdrup #745 AgentTopicList.ordered), as the page
// gets it: open topics by last activity, newest first, then closed ones; a
// row without an id dropped. test/topicsModel.test.ts checks the web side.
func TestTopicsAreOrderedAsTheTopicsViewListsThem(t *testing.T) {
	topic := func(id string, state herdrapi.AgentTopicState, created, last uint64) herdrapi.AgentTopicInfo {
		return herdrapi.AgentTopicInfo{TopicID: id, State: state, CreatedUnixMs: created, LastActivityUnixMs: last}
	}
	got := orderedTopics([]herdrapi.AgentTopicInfo{
		topic("old", herdrapi.AgentTopicStateIdle, 0, 100),
		topic("closed-new", herdrapi.AgentTopicStateClosed, 0, 900),
		topic("new", herdrapi.AgentTopicStateRunning, 0, 500),
		topic("", herdrapi.AgentTopicStateIdle, 0, 999),
		topic("started", herdrapi.AgentTopicStateStarting, 700, 0),
		topic("closed-old", herdrapi.AgentTopicStateClosed, 0, 200),
		topic("b-tie", herdrapi.AgentTopicStateIdle, 0, 100),
	})
	var ids []string
	for _, t := range got {
		ids = append(ids, t.TopicID)
	}
	if want := []string{"started", "new", "b-tie", "old", "closed-new", "closed-old"}; !slices.Equal(ids, want) {
		t.Fatalf("order %v, want %v", ids, want)
	}
	if empty := orderedTopics(nil); empty == nil || len(empty) != 0 {
		t.Fatalf("no topics must publish [] (the page reads a list), got %#v", empty)
	}
}

// A server without agent_topics or a topics_unsupported answer: the page
// stops offering Topics. Anything else keeps the list and shows why the read
// failed: agent_not_found too, which herdr answers while it briefly can't
// resolve the agent (Topics vanished while the agent was busy).
func TestTopicsRefusalsSayWhetherTheAgentStillHasTopics(t *testing.T) {
	for _, c := range []struct {
		err        error
		notOffered bool
		words      string
	}{
		{&engine.ErrUnsupported{Method: "agent.topics.list", Capability: herdrapi.CapabilityAgentTopics}, true, "Couldn't reach the agent."},
		{&bridge.APIError{Code: "topics_unsupported"}, true, "This agent has no topics."},
		{&bridge.APIError{Code: "agent_not_found"}, false, "This agent is gone."},
		{&bridge.APIError{Code: "topics_unreachable"}, false, "Agent not reachable"},
		{&bridge.APIError{Code: "topic_rejected", Message: "busy"}, false, "The agent refused: busy"},
		{errors.New("eof"), false, "Couldn't reach the agent."},
	} {
		if got := topicsNotOffered(c.err); got != c.notOffered {
			t.Errorf("%v: notOffered %v, want %v", c.err, got, c.notOffered)
		}
		if got := topicsProblem(c.err); got != c.words {
			t.Errorf("%v: %q, want %q", c.err, got, c.words)
		}
	}
}

// topicsDesk opens w1:p1 (an omp agent) on a fake herdr with herdr #475's
// topics, or one without them, and records what the page is sent, in the
// Desk's own publisher, set before the view opens. A topic's turn is
// answered on each value sent on the returned channel, which holds two
// (a test sends both answers without blocking). subscribed closes once the
// fake registered the view's Topics subscription (agent.topics.changed),
// apart from the board's stream: every topics event after that reaches the
// follower.
func topicsDesk(t *testing.T, withTopics bool) (d *Desk, updates func() []TopicsUpdate, answer chan<- struct{}, subscribed <-chan struct{}) {
	return topicsDeskWith(t, withTopics, fakeherdr.NewTopics())
}

// topicsDeskWith is topicsDesk on the test's own topics fixture.
func topicsDeskWith(t *testing.T, withTopics bool, fixture *fakeherdr.Topics) (d *Desk, updates func() []TopicsUpdate, answer chan<- struct{}, subscribed <-chan struct{}) {
	t.Helper()
	var mu sync.Mutex
	var recorded []TopicsUpdate
	answers := make(chan struct{}, 2)
	fixture.Answer = answers
	t.Cleanup(func() { close(answers) })
	registered := make(chan struct{})
	var once sync.Once
	d, _ = federatedDesk(t, func(s *fakeherdr.Server) {
		base, events := s.Handle, s.Events
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "agent.list" {
				return map[string]any{"type": "agent_list", "agents": []any{map[string]any{"pane_id": "w1:p1", "agent": "omp", "agent_status": "idle"}}}, nil
			}
			if withTopics {
				if value, err, ok := fixture.Handle(method, raw); ok {
					return value, err
				}
				if method == "ping" {
					pong := fakeherdr.Pong(true)
					pong["capabilities"].(map[string]bool)["agent_transcript"] = true
					for _, c := range fixture.Capabilities() {
						pong["capabilities"].(map[string]bool)[c] = true
					}
					return pong, nil
				}
			}
			return base(method, raw)
		}
		if s.Streams == nil {
			s.Streams = map[string]fakeherdr.StreamFunc{}
		}
		s.Streams["events.subscribe"] = func(ctx context.Context, id string, params json.RawMessage, emit func([]byte) error) {
			ack, _ := json.Marshal(map[string]any{"id": id, "result": map[string]any{"type": "subscription_started"}})
			if emit(ack) != nil {
				return
			}
			if events != nil {
				go events(ctx, emit)
			}
			var ready func()
			if strings.Contains(string(params), "agent.topics.changed") {
				ready = func() { once.Do(func() { close(registered) }) }
			}
			fixture.EventsReady(ctx, emit, ready)
		}
	})
	d.publishTopics = func(u TopicsUpdate) {
		if u.Topics == nil {
			u.Topics = []herdrapi.AgentTopicInfo{}
		}
		mu.Lock()
		recorded = append(recorded, u)
		mu.Unlock()
	}
	board := d.Board()
	if _, err := d.OpenAgentView(AgentTarget{MachineID: board.MachineID, Session: board.Session, PaneID: "w1:p1"}, "view"); err != nil {
		t.Fatal(err)
	}
	return d, func() []TopicsUpdate {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(recorded)
	}, answers, registered
}

// The owner's Topics view end to end: the agent's ordered list, a new
// topic that opens with its first message, a send that is queued while the
// topic works, the topic's own transcript, and an agent_topics_changed
// event naming the topic whose conversation changed.
func TestOwnerTopicsListStartSendAndFollow(t *testing.T) {
	d, updates, answer, subscribed := topicsDesk(t, true)
	ctx := context.Background()
	if ok, err := d.TopicsAvailable(ctx, "view"); !ok || err != nil {
		t.Fatalf("TopicsAvailable %v, %v; want true for omp on a herdr with agent_topics", ok, err)
	}
	if err := d.TopicsFollow("view", true); err != nil {
		t.Fatal(err)
	}
	last := func() TopicsUpdate { u := updates(); return u[len(u)-1] }
	waitFor(t, "the first list", func() bool { u := updates(); return len(u) > 0 && last().Loaded })
	first := last()
	var ids []string
	for _, topic := range first.Topics {
		ids = append(ids, topic.TopicID)
	}
	if !first.Offered || first.Problem != "" || !slices.Equal(ids, []string{"t1", "t2", "t3"}) {
		t.Fatalf("first list %+v; want offered t1 (working), t2 (idle), t3 (closed)", first)
	}
	select {
	case <-subscribed: // the event under test reaches the follower
	case <-time.After(10 * time.Second):
		t.Fatal("the Topics subscription never registered")
	}
	id, err := d.TopicsNew(ctx, "view", "  Launch plan ", "Outline the launch.")
	if err != nil || id == "" {
		t.Fatalf("TopicsNew %q, %v", id, err)
	}
	waitFor(t, "the new topic first in the list", func() bool {
		u := last()
		return len(u.Topics) == 4 && u.Topics[0].TopicID == id && u.Topics[0].Title == "Launch plan"
	})
	reply, err := d.TopicsSend(ctx, "view", id, "Add a timeline.")
	if err != nil || reply.Mode != "queued" || reply.Delivery != "sent" {
		t.Fatalf("send while the topic works: %+v, %v; want queued", reply, err)
	}
	waitFor(t, "an event naming the new topic", func() bool {
		return slices.ContainsFunc(updates(), func(u TopicsUpdate) bool { return u.Changed == id })
	})
	answer <- struct{}{} // the first turn; the queued message starts the next
	answer <- struct{}{}
	waitFor(t, "both turns answered", func() bool {
		page, err := d.TopicTranscript(ctx, "view", id, "", "", "")
		return err == nil && strings.Count(page, `"kind":"reply"`) == 2
	})
	page, _ := d.TopicTranscript(ctx, "view", id, "", "", "")
	if !strings.Contains(page, "Outline the launch.") || !strings.Contains(page, "Add a timeline.") || strings.Contains(page, "September minutes") {
		t.Fatalf("topic transcript is not that topic's conversation: %s", page)
	}
	if _, err := d.TopicTranscript(ctx, "view", "t99", "", "", ""); err == nil || err.Error() != "This topic's conversation can't be found." {
		t.Fatalf("missing topic: %v", err)
	}
	// A refusal is a reply the page can resend from, classified by herdr's
	// code, not an error whose wording the page would have to parse (#248 P3).
	if reply, err := d.TopicsSend(ctx, "view", "t3", "hello"); err != nil || reply.Delivery != "refused" || reply.Problem != "The agent refused: the topic is closed" {
		t.Fatalf("send to a closed topic: %+v, %v; want refused with the agent's words", reply, err)
	}
}

// #503: each Desk publishes Topics updates to its own publisher, so one
// Desk's watch (a late one included) never publishes into another's
// recorder.
func TestTopicsUpdatesGoToTheirOwnDesk(t *testing.T) {
	a, aUpdates, _, _ := topicsDesk(t, true)
	_, bUpdates, _, _ := topicsDesk(t, true)
	if err := a.TopicsFollow("view", true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the first list", func() bool {
		return slices.ContainsFunc(aUpdates(), func(u TopicsUpdate) bool { return u.Loaded })
	})
	if got := bUpdates(); len(got) != 0 {
		t.Fatalf("the other Desk was sent %+v", got)
	}
}

// A herdr without agent_topics: no Topics button, a list read says not
// offered (an empty list, not null), and a topic transcript is refused
// rather than sent as the agent's main conversation.
func TestTopicsWithoutTheCapabilityStayOff(t *testing.T) {
	d, updates, _, _ := topicsDesk(t, false)
	ctx := context.Background()
	if ok, _ := d.TopicsAvailable(ctx, "view"); ok {
		t.Fatal("TopicsAvailable on a herdr without agent_topics")
	}
	if err := d.TopicsRefresh(ctx, "view"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "a list answer", func() bool { return len(updates()) > 0 })
	if u := updates()[0]; u.Offered || u.Problem != "" || u.Topics == nil || len(u.Topics) != 0 {
		t.Fatalf("update %+v; want not offered with an empty list", u)
	}
	raw, _ := json.Marshal(updates()[0])
	if !strings.Contains(string(raw), `"topics":[]`) {
		t.Fatalf("the page reads topics as a list: %s", raw)
	}
	if _, err := d.TopicTranscript(ctx, "view", "t1", "", "", ""); err == nil || err.Error() != "This server can't show a topic's conversation." {
		t.Fatalf("topic transcript without agent_transcript_topic: %v", err)
	}
}

// A send that may have reached the agent (a timeout, an unknown code, a
// broken link) is unconfirmed: no one-tap resend. herdr's refusals are not.
func TestTopicSendDeliveryFollowsHerdrsCode(t *testing.T) {
	for _, c := range []struct {
		err  error
		want string
	}{
		{&bridge.APIError{Code: "topic_rejected"}, "refused"},
		{&bridge.APIError{Code: "topics_unreachable"}, "refused"},
		{&bridge.APIError{Code: "topic_not_found"}, "refused"},
		{&engine.ErrUnsupported{Method: "agent.topics.send", Capability: herdrapi.CapabilityAgentTopics}, "refused"},
		{&bridge.APIError{Code: "topics_timeout"}, "unconfirmed"},
		{&bridge.APIError{Code: "something_new"}, "unconfirmed"},
		{errors.New("ssh: connection lost"), "unconfirmed"},
	} {
		if got := topicSendDelivery(c.err); got != c.want {
			t.Errorf("%v: %s, want %s", c.err, got, c.want)
		}
	}
}

// topicsListDesk opens w1:p1 (an omp agent) on a fake herdr with agent_topics
// whose agent.topics.list answers come from list, one a call, and records
// what the page is sent.
func topicsListDesk(t *testing.T, list func() (any, *fakeherdr.APIError)) (d *Desk, updates func() []TopicsUpdate) {
	t.Helper()
	var mu sync.Mutex
	var recorded []TopicsUpdate
	d, _ = federatedDesk(t, func(s *fakeherdr.Server) {
		base := s.Handle
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "agent.list":
				return map[string]any{"type": "agent_list", "agents": []any{map[string]any{"pane_id": "w1:p1", "agent": "omp", "agent_status": "working",
					"topic_sessions": []any{map[string]any{"topic_id": "t1", "title": "Q4 board pack", "path": "/s/t1.jsonl", "created_unix_ms": 1000}, map[string]any{"topic_id": "", "path": "/s/x.jsonl"}}}}}, nil
			case "ping":
				pong := fakeherdr.Pong(true)
				pong["capabilities"].(map[string]bool)["agent_topics"] = true
				return pong, nil
			case "agent.topics.list":
				return list()
			}
			return base(method, raw)
		}
	})
	d.publishTopics = func(u TopicsUpdate) {
		mu.Lock()
		recorded = append(recorded, u)
		mu.Unlock()
	}
	board := d.Board()
	if _, err := d.OpenAgentView(AgentTarget{MachineID: board.MachineID, Session: board.Session, PaneID: "w1:p1"}, "view"); err != nil {
		t.Fatal(err)
	}
	return d, func() []TopicsUpdate {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(recorded)
	}
}

// The owner's report (2026-11-25): Topics vanished while the agent was
// busy. An agent_not_found answer keeps the list and says why; a herdr's
// cached answer (stale, as_of_unix_ms) is shown as it says, and one older
// than the list shown doesn't replace it.
func TestTopicsListSurvivesAMissedAgentAndFollowsItsFreshness(t *testing.T) {
	topic := func(id string) map[string]any {
		return map[string]any{"topic_id": id, "title": id, "state": "idle", "created_unix_ms": 1, "last_activity_unix_ms": 1, "queued": 0, "turns": 1}
	}
	answers := []func() (any, *fakeherdr.APIError){
		func() (any, *fakeherdr.APIError) {
			return map[string]any{"type": "agent_topics", "agent": "w1:p1", "pane_id": "w1:p1", "topics": []any{topic("a")}, "as_of_unix_ms": 2000}, nil
		},
		func() (any, *fakeherdr.APIError) {
			return nil, &fakeherdr.APIError{Code: "agent_not_found", Message: "no agent"}
		},
		func() (any, *fakeherdr.APIError) {
			return map[string]any{"type": "agent_topics", "agent": "w1:p1", "pane_id": "w1:p1", "topics": []any{topic("a"), topic("b")}, "stale": true, "as_of_unix_ms": 3000}, nil
		},
		func() (any, *fakeherdr.APIError) {
			return map[string]any{"type": "agent_topics", "agent": "w1:p1", "pane_id": "w1:p1", "topics": []any{topic("c")}, "as_of_unix_ms": 2500}, nil
		},
	}
	var mu sync.Mutex
	next := 0
	d, updates := topicsListDesk(t, func() (any, *fakeherdr.APIError) {
		mu.Lock()
		defer mu.Unlock()
		answer := answers[min(next, len(answers)-1)]
		next++
		return answer()
	})
	ids := func(u TopicsUpdate) []string {
		out := []string{}
		for _, topic := range u.Topics {
			out = append(out, topic.TopicID)
		}
		return out
	}
	read := func(n int) TopicsUpdate {
		t.Helper()
		if err := d.TopicsRefresh(context.Background(), "view"); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "a list answer", func() bool { return len(updates()) >= n })
		return updates()[n-1]
	}
	if u := read(1); !u.Offered || u.Stale || !slices.Equal(ids(u), []string{"a"}) {
		t.Fatalf("first list %+v", u)
	}
	if u := read(2); !u.Offered || u.Problem != "This agent is gone." || !slices.Equal(ids(u), []string{"a"}) {
		t.Fatalf("agent_not_found must keep the list and say why: %+v", u)
	}
	if u := read(3); !u.Offered || !u.Stale || u.Problem != "" || !slices.Equal(ids(u), []string{"a", "b"}) {
		t.Fatalf("a stale cached list is shown as stale: %+v", u)
	}
	if u := read(4); !u.Stale || !slices.Equal(ids(u), []string{"a", "b"}) {
		t.Fatalf("an answer older than the list shown must not replace it: %+v", u)
	}
}

// herdr #520: a refresh behind agent.topics.list that finds a different list
// says agent_topics_changed with reason "listed" and no topic. The follower
// lists again (the backstop poll is a minute away), and no topic is named as
// changed.
func TestTopicsListedChangeListsAgain(t *testing.T) {
	fixture := fakeherdr.NewTopics()
	d, updates, _, subscribed := topicsDeskWith(t, true, fixture)
	if err := d.TopicsFollow("view", true); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the first list", func() bool { u := updates(); return len(u) > 0 && u[len(u)-1].Loaded })
	select {
	case <-subscribed:
	case <-time.After(10 * time.Second):
		t.Fatal("the Topics subscription never registered")
	}
	fixture.Relist("w1:p1", "t9", "Found on refresh")
	waitFor(t, "the list with the topic herdr found", func() bool {
		u := updates()
		return slices.ContainsFunc(u[len(u)-1].Topics, func(x herdrapi.AgentTopicInfo) bool { return x.TopicID == "t9" })
	})
	for _, u := range updates() {
		if u.Changed != "" {
			t.Fatalf("a listed change named topic %q as changed", u.Changed)
		}
	}
}

// herdr #520: a pane where herdr misses omp for a moment answers
// topics_unreachable (retry) where it said topics_unsupported, and an omp
// that doesn't answer in time topics_timeout (retry). With Topics on screen
// the list stays, says why, and is asked for again on topicsRetry's
// schedule, not at the minute's backstop.
func TestTopicsOnScreenKeepTheListAndAskAgainWhenUnreachable(t *testing.T) {
	saved := topicsRetry
	topicsRetry = []time.Duration{20 * time.Millisecond}
	t.Cleanup(func() { topicsRetry = saved })
	for _, c := range []struct{ code, problem string }{
		{"topics_unreachable", "Agent not reachable"},
		{"topics_timeout", "The agent didn't answer in time."},
	} {
		t.Run(c.code, func(t *testing.T) {
			var failing atomic.Value
			failing.Store("")
			fixture := fakeherdr.NewTopics()
			fixture.ListFail = func() string { return failing.Load().(string) }
			d, updates, _, _ := topicsDeskWith(t, true, fixture)
			if err := d.TopicsFollow("view", true); err != nil {
				t.Fatal(err)
			}
			waitFor(t, "the first list", func() bool { u := updates(); return len(u) > 0 && len(u[len(u)-1].Topics) == 3 })
			failing.Store(c.code)
			if err := d.TopicsRefresh(context.Background(), "view"); err != nil {
				t.Fatal(err)
			}
			failedAt := -1
			waitFor(t, "the failed answer", func() bool {
				for i, u := range updates() {
					if u.Problem != "" {
						failedAt = i
						return true
					}
				}
				return false
			})
			if u := updates()[failedAt]; !u.Offered || len(u.Topics) != 3 || u.Problem != c.problem {
				t.Fatalf("%s must keep the list and say why: %+v", c.code, u)
			}
			failing.Store("")
			waitFor(t, "the list asked for again", func() bool {
				u := updates()
				return len(u) > failedAt+1 && u[len(u)-1].Problem == "" && len(u[len(u)-1].Topics) == 3
			})
		})
	}
}

// The page lists the topics the agent's session file holds (topic_sessions)
// until the agent's first list answers: the view carries them, one without
// an id left out, never null.
func TestAgentViewCarriesTheTopicSessions(t *testing.T) {
	d, _ := topicsListDesk(t, func() (any, *fakeherdr.APIError) { return nil, &fakeherdr.APIError{Code: "topics_timeout"} })
	v, err := d.agentView("view")
	if err != nil {
		t.Fatal(err)
	}
	if want := []TopicSession{{TopicID: "t1", Title: "Q4 board pack", CreatedMs: 1000}}; !slices.Equal(v.TopicSessions, want) {
		t.Fatalf("topic sessions %+v, want %+v", v.TopicSessions, want)
	}
	if got := topicSessions(nil); got == nil || len(got) != 0 {
		t.Fatalf("no sessions must be [] (the page reads a list), got %#v", got)
	}
}

// The topic's composer is the Inbox's (owner, 2026-11-25): a file attached
// there goes up as the Inbox's do (gram.upload_chunk, then gram.post to the
// agent), and the topic's message (agent.topics.send) carries the Inbox's
// composed reference to it. A refusal keeps the file for the retry, which
// posts no second Gram.
func TestTopicSendCarriesTheComposersFilesAsTheInboxDoes(t *testing.T) {
	d, g, view, recorded := topicFilesDesk(t)
	ctx := context.Background()
	if reply, err := d.TopicsSend(ctx, "view", "t1", "read this"); err != nil || reply.Delivery != "refused" || reply.Problem != "The agent refused: busy" {
		t.Fatalf("a refused topic send: %+v, %v", reply, err)
	}
	if reply, err := d.TopicsSend(ctx, "view", "t1", "read this"); err != nil || reply.Delivery != "sent" {
		t.Fatalf("the retry: %+v, %v", reply, err)
	}
	messages := g.Messages()
	if len(messages) != 1 || messages[0].To == nil || *messages[0].To != view.Name || messages[0].File == nil {
		t.Fatalf("one Gram with the file to the agent, posted once: %+v", messages)
	}
	want := "read this\n\n[File notes.txt attached via Herdr Gram message " + messages[0].ID + ". Download it with `herdr gram get-file " + messages[0].ID + " -o /tmp/herdr-file-" + messages[0].ID + ".txt`, then inspect /tmp/herdr-file-" + messages[0].ID + ".txt.]"
	if got := recorded(); len(got) != 2 || got[0]["message"] != want || got[1]["message"] != want || got[1]["topic_id"] != "t1" || got[1]["target"] != "w1:p1" {
		t.Fatalf("topic messages %q, want each %q", got, want)
	}
	// The file left with the send: the next message is text alone.
	if reply, err := d.TopicsSend(ctx, "view", "t1", "thanks"); err != nil || reply.Delivery != "sent" || recorded()[2]["message"] != "thanks" {
		t.Fatalf("after the files left: %+v, %v, %q", reply, err, recorded())
	}
}

// #534: a caption already over the topic's cap is refused before any file
// is posted: the agent gets no Gram for a message that can't go, and the
// file stays in the composer.
func TestTopicSendRefusesAnOversizedCaptionBeforePostingItsFiles(t *testing.T) {
	d, g, _, recorded := topicFilesDesk(t)
	reply, err := d.TopicsSend(context.Background(), "view", "t1", strings.Repeat("x", topicMessageBytes+1))
	if err != nil || reply.Delivery != "refused" || reply.Problem != errTopicTooLong.Error() {
		t.Fatalf("an oversized caption: %+v, %v; want refused as too long", reply, err)
	}
	if messages := g.Messages(); len(messages) != 0 {
		t.Fatalf("an oversized caption posted %d Gram(s) before its refusal", len(messages))
	}
	if got := recorded(); len(got) != 0 {
		t.Fatalf("an oversized caption reached agent.topics.send: %d", len(got))
	}
	v, err := d.agentView("view")
	if err != nil {
		t.Fatal(err)
	}
	if chips := v.composer.Snapshot().Chips; len(chips) != 1 {
		t.Fatalf("the file must stay in the composer: %d chips", len(chips))
	}
}

// topicFilesDesk is an omp agent's view on a herdr with Gram and topics, a
// file (notes.txt) in its composer. Its first agent.topics.send is refused
// (topic_rejected: busy), the rest sent; recorded is every send's params.
func topicFilesDesk(t *testing.T) (d *Desk, g *fakeherdr.Gram, view AgentView, recorded func() []map[string]string) {
	t.Helper()
	g = fakeherdr.NewGram("pane-files")
	var mu sync.Mutex
	var sent []map[string]string
	d, _ = federatedDesk(t, func(s *fakeherdr.Server) {
		inner := s.Handle
		s.Duplex = g.Duplex
		s.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if result, err, ok := g.Handle(method, raw); ok {
				return result, err
			}
			switch method {
			case "agent.list":
				return map[string]any{"type": "agent_list", "agents": []any{map[string]any{"pane_id": "w1:p1", "name": "writer", "agent": "omp", "agent_status": "idle"}}}, nil
			case "ping":
				pong := fakeherdr.Pong(true)
				pong["capabilities"].(map[string]bool)["agent_topics"] = true
				return pong, nil
			case "agent.topics.list":
				return map[string]any{"type": "agent_topics", "agent": "w1:p1", "pane_id": "w1:p1", "topics": []any{}}, nil
			case "agent.topics.send":
				var p map[string]string
				if err := json.Unmarshal(raw, &p); err != nil {
					return nil, &fakeherdr.APIError{Code: "invalid_params", Message: err.Error()}
				}
				mu.Lock()
				sent = append(sent, p)
				attempt := len(sent)
				mu.Unlock()
				if attempt == 1 {
					return nil, &fakeherdr.APIError{Code: "topic_rejected", Message: "busy"}
				}
				return map[string]any{"type": "agent_topic_sent", "agent": "w1:p1", "pane_id": "w1:p1", "topic_id": p["topic_id"], "mode": "turn"}, nil
			}
			return inner(method, raw)
		}
	})
	path := filepath.Join(t.TempDir(), "notes.txt")
	if err := os.WriteFile(path, []byte("attachment bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	b := d.Board()
	view, err := d.OpenAgentView(AgentTarget{MachineID: b.MachineID, Session: b.Session, PaneID: "w1:p1"}, "view")
	if err != nil {
		t.Fatal(err)
	}
	if err := d.PaneAttachFiles("view", []string{path}); err != nil {
		t.Fatal(err)
	}
	return d, g, view, func() []map[string]string {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(sent)
	}
}
