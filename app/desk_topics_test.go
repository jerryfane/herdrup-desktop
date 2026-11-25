package main

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
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

// A server without agent_topics, a topics_unsupported or agent_not_found
// answer: the page stops offering Topics. Anything else keeps the list and
// shows why the read failed.
func TestTopicsRefusalsSayWhetherTheAgentStillHasTopics(t *testing.T) {
	for _, c := range []struct {
		err        error
		notOffered bool
		words      string
	}{
		{&engine.ErrUnsupported{Method: "agent.topics.list", Capability: herdrapi.CapabilityAgentTopics}, true, "Couldn't reach the agent."},
		{&bridge.APIError{Code: "topics_unsupported"}, true, "This agent has no topics."},
		{&bridge.APIError{Code: "agent_not_found"}, true, "This agent is gone."},
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
	t.Helper()
	var mu sync.Mutex
	var recorded []TopicsUpdate
	fixture := fakeherdr.NewTopics()
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
