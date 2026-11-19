package main

import (
	"errors"
	"slices"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
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
