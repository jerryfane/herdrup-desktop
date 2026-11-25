package main

import (
	"context"
	"encoding/json"
	"errors"
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
// topics, or one without them, and records what the page is sent, each
// update seen by observe first (on the goroutine that publishes it). A
// topic's turn is answered on each value sent on the returned channel.
// The cleanup ends the view and waits for its Topics watch before the
// recorder is taken away.
func topicsDesk(t *testing.T, withTopics bool, observe ...func(TopicsUpdate)) (*Desk, func() []TopicsUpdate, chan<- struct{}) {
	t.Helper()
	var mu sync.Mutex
	var updates []TopicsUpdate
	previous := publishTopics
	publishTopics = func(u TopicsUpdate) {
		if u.Topics == nil {
			u.Topics = []herdrapi.AgentTopicInfo{}
		}
		for _, see := range observe {
			see(u)
		}
		mu.Lock()
		updates = append(updates, u)
		mu.Unlock()
	}
	t.Cleanup(func() { publishTopics = previous })
	fixture := fakeherdr.NewTopics()
	answer := make(chan struct{})
	fixture.Answer = answer
	t.Cleanup(func() { close(answer) })
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
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
	v, err := d.agentView("view")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		v.cancel()
		v.topics.wait()
	})
	return d, func() []TopicsUpdate {
		mu.Lock()
		defer mu.Unlock()
		return slices.Clone(updates)
	}, answer
}

// wait waits for the watch's goroutines once its view's context ended:
// a goroutine starts only under mu with the view open, so after mu was
// held once none starts.
func (t *topicsState) wait() {
	t.mu.Lock()
	t.mu.Unlock() // orders every start before Wait
	t.running.Wait()
}

// The owner's Topics view end to end: the agent's ordered list, a new
// topic that opens with its first message, a send that is queued while the
// topic works, the topic's own transcript, and an agent_topics_changed
// event naming the topic whose conversation changed.
func TestOwnerTopicsListStartSendAndFollow(t *testing.T) {
	d, updates, answer := topicsDesk(t, true)
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
	waitTopicsSubscribed(t, d, updates)
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

// waitTopicsSubscribed waits until the view's Topics follower hears
// events: its subscription opens on its own goroutine, so t2 is renamed to
// its own title until an event naming it shows. Events sent after this
// are not sent before anyone listens.
func waitTopicsSubscribed(t *testing.T, d *Desk, updates func() []TopicsUpdate) {
	t.Helper()
	waitFor(t, "the topics subscription", func() bool {
		if slices.ContainsFunc(updates(), func(u TopicsUpdate) bool { return u.Changed == "t2" }) {
			return true
		}
		if err := d.TopicsRename(context.Background(), "view", "t2", "Diokan renewal"); err != nil {
			t.Fatal(err)
		}
		return false
	})
}

// #497: ending a view waits for its Topics watch. A publish its follower's
// subscription is still making when the view ends (here held until the
// view's context ended) finishes before topicsState.wait returns, so a
// test's cleanup can take its recorder away after it without a race.
func TestEndingATopicsViewWaitsForItsFollower(t *testing.T) {
	var armed atomic.Bool
	entered, release := make(chan struct{}), make(chan struct{})
	var unblock sync.Once
	late := false // set by the held publish once released; read after wait
	d, updates, _ := topicsDesk(t, true, func(u TopicsUpdate) {
		if u.Changed == "t2" && armed.CompareAndSwap(true, false) {
			close(entered)
			<-release
			late = true
		}
	})
	// Runs before topicsDesk's cleanup waits for the watch.
	t.Cleanup(func() { unblock.Do(func() { close(release) }) })
	if err := d.TopicsFollow("view", true); err != nil {
		t.Fatal(err)
	}
	waitTopicsSubscribed(t, d, updates)
	v, err := d.agentView("view")
	if err != nil {
		t.Fatal(err)
	}
	armed.Store(true)
	if err := d.TopicsRename(context.Background(), "view", "t2", "Diokan renewal"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered: // the follower is publishing that event, held
	case <-time.After(10 * time.Second):
		t.Fatal("the rename's event never reached the follower")
	}
	v.cancel()
	unblock.Do(func() { close(release) })
	v.topics.wait()
	if !late {
		t.Fatal("wait returned while the follower was still publishing")
	}
}

// A herdr without agent_topics: no Topics button, a list read says not
// offered (an empty list, not null), and a topic transcript is refused
// rather than sent as the agent's main conversation.
func TestTopicsWithoutTheCapabilityStayOff(t *testing.T) {
	d, updates, _ := topicsDesk(t, false)
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
