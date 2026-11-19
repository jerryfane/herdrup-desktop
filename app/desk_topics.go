package main

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// An omp agent's Topics (herdr #475, herdrup #745 option D): the agent is a
// front desk (the Inbox, its own conversation) and every topic a permanent
// worker conversation under it. Owner and guest share all of it (owner
// decision 2026-11-19); only the server's agent_topics capability gates it.
// The owner follows agent.topics.changed with a slow backstop poll; a guest
// has no event stream and polls while Topics is on screen.

const (
	// topicsGuestPoll is a guest's list poll while Topics shows (TopicsModel.pollSeconds).
	topicsGuestPoll = 15 * time.Second
	// topicsBackstop is the owner's poll behind the event stream, for a missed event.
	topicsBackstop = 60 * time.Second
	// topicMessageBytes is the host's cap on a topic message (as agent.prompt).
	topicMessageBytes = 32 * 1024
)

// TopicsUpdate is the page's Topics state for one view: the list, ordered
// as the Topics view lists it, or why the newest read failed (the last list
// stays on screen: topics_unreachable keeps it). Offered says the agent
// answered agent.topics.list this session, so the page offers Topics;
// Changed names a topic whose conversation changed (an owner's event), so
// an open topic chat reads its tail.
type TopicsUpdate struct {
	Token   string                    `json:"token"`
	Topics  []herdrapi.AgentTopicInfo `json:"topics"`
	Offered bool                      `json:"offered"`
	Loaded  bool                      `json:"loaded"`
	Problem string                    `json:"problem,omitempty"`
	Changed string                    `json:"changed,omitempty"`
}

var TopicsChanged = mygo.NewEvent[TopicsUpdate]("topics:changed")

// publishTopics sends one update to the page; the list is never null, which
// the page reads as a list.
var publishTopics = func(u TopicsUpdate) {
	if u.Topics == nil {
		u.Topics = []herdrapi.AgentTopicInfo{}
	}
	TopicsChanged.Broadcast(u)
}

// topicsState is one view's topics watch: the last list and the follower
// that keeps it current while Topics shows.
type topicsState struct {
	mu      sync.Mutex
	last    TopicsUpdate
	cancel  context.CancelFunc
	reading bool
	again   bool
}

// TopicsAvailable reports whether the view's server serves an omp agent's
// topics (agent_topics): the page asks the agent then (TopicsRefresh).
func (d *Desk) TopicsAvailable(ctx context.Context, token string) (bool, error) {
	v, err := d.agentView(token)
	if err != nil {
		return false, err
	}
	if !ompHarness(v.Harness) {
		return false, nil
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	ok, _ := v.client.Supports(ctx, herdrapi.CapabilityAgentTopics)
	return ok, nil
}

// ompHarness reports whether a harness name is omp's (the page's own test:
// /^omp(?:$| |-)/i).
func ompHarness(h string) bool {
	h = strings.ToLower(h)
	return h == "omp" || strings.HasPrefix(h, "omp ") || strings.HasPrefix(h, "omp-")
}

// TopicsRefresh reads the agent's topics now and publishes them
// (TopicsChanged); concurrent calls coalesce into one more round.
func (d *Desk) TopicsRefresh(ctx context.Context, token string) error {
	v, err := d.agentView(token)
	if err != nil {
		return err
	}
	d.topicsRead(v)
	return nil
}

// TopicsFollow keeps the list current while the page's Topics shows, and
// stops when shown goes false or the view closes.
func (d *Desk) TopicsFollow(token string, shown bool) error {
	v, err := d.agentView(token)
	if err != nil {
		return err
	}
	t := &v.topics
	t.mu.Lock()
	if t.cancel != nil {
		t.cancel()
		t.cancel = nil
	}
	if !shown {
		t.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(v.ctx)
	t.cancel = cancel
	t.mu.Unlock()
	go d.followTopics(ctx, v)
	return nil
}

// followTopics: a guest polls every topicsGuestPoll; the owner follows
// agent.topics.changed for this pane and polls every topicsBackstop. A
// server that refuses the subscription is polled at the guest's pace.
func (d *Desk) followTopics(ctx context.Context, v *interaction) {
	d.topicsRead(v)
	poll := topicsGuestPoll
	if !v.Guest {
		events := make(chan struct{}, 1)
		go func() {
			err := v.client.Subscribe(ctx, engine.SubscribeOptions{
				Subscriptions: []herdrapi.Subscription{{Value: herdrapi.SubscriptionAgentTopicsChanged{}}},
				NoList:        true,
			}, func(e engine.Event) {
				if e.Kind != engine.EventLine || e.Line == nil || strings.ReplaceAll(e.Line.Event, ".", "_") != "agent_topics_changed" {
					return
				}
				var change herdrapi.EventDataAgentTopicsChanged
				if json.Unmarshal(e.Line.Data, &change) != nil || change.PaneID != v.PaneID {
					return
				}
				d.topicsChangedTopic(v, change.TopicID)
				select {
				case events <- struct{}{}:
				default:
				}
			})
			if err != nil && ctx.Err() == nil {
				close(events)
			}
		}()
		poll = topicsBackstop
		timer := time.NewTimer(poll)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case _, open := <-events:
				if !open {
					d.pollTopics(ctx, v, topicsGuestPoll)
					return
				}
				d.topicsRead(v)
			case <-timer.C:
				d.topicsRead(v)
				timer.Reset(poll)
			}
		}
	}
	d.pollTopics(ctx, v, poll)
}

func (d *Desk) pollTopics(ctx context.Context, v *interaction, every time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.topicsRead(v)
		}
	}
}

// topicsChangedTopic tells the page one topic's conversation changed.
func (d *Desk) topicsChangedTopic(v *interaction, topicID string) {
	t := &v.topics
	t.mu.Lock()
	u := t.last
	t.mu.Unlock()
	u.Token, u.Changed = v.Token, topicID
	publishTopics(u)
}

// topicsRead reads the list once (or once more after the read in flight)
// and publishes it.
func (d *Desk) topicsRead(v *interaction) {
	t := &v.topics
	t.mu.Lock()
	if t.reading {
		t.again = true
		t.mu.Unlock()
		return
	}
	t.reading = true
	t.mu.Unlock()
	go func() {
		for {
			d.topicsReadOnce(v)
			t.mu.Lock()
			if !t.again || v.ctx.Err() != nil {
				t.reading = false
				t.mu.Unlock()
				return
			}
			t.again = false
			t.mu.Unlock()
		}
	}()
}

func (d *Desk) topicsReadOnce(v *interaction) {
	ctx, cancel := context.WithTimeout(v.ctx, 20*time.Second)
	defer cancel()
	list, err := v.client.AgentTopicsList(ctx, v.PaneID)
	if v.ctx.Err() != nil {
		return
	}
	t := &v.topics
	t.mu.Lock()
	u := t.last
	u.Token, u.Loaded, u.Changed = v.Token, true, ""
	switch {
	case err == nil:
		u.Topics, u.Offered, u.Problem = orderedTopics(list.Topics), true, ""
	case topicsNotOffered(err):
		// Not an agent with topics (any more): the page goes back to Chat and Terminal.
		u.Topics, u.Offered, u.Problem = nil, false, ""
	default:
		u.Problem = topicsProblem(err)
	}
	t.last = u
	t.mu.Unlock()
	publishTopics(u)
}

// orderedTopics is the Topics view's order (AgentTopicList.ordered): open
// topics by last activity, newest first, then the closed ones the same way.
func orderedTopics(topics []herdrapi.AgentTopicInfo) []herdrapi.AgentTopicInfo {
	out := slices.DeleteFunc(slices.Clone(topics), func(t herdrapi.AgentTopicInfo) bool { return t.TopicID == "" })
	activity := func(t herdrapi.AgentTopicInfo) uint64 { return max(t.LastActivityUnixMs, t.CreatedUnixMs) }
	slices.SortStableFunc(out, func(a, b herdrapi.AgentTopicInfo) int {
		ac, bc := a.State == herdrapi.AgentTopicStateClosed, b.State == herdrapi.AgentTopicStateClosed
		if ac != bc {
			if ac {
				return 1
			}
			return -1
		}
		if x, y := activity(a), activity(b); x != y {
			if x > y {
				return -1
			}
			return 1
		}
		return strings.Compare(a.TopicID, b.TopicID)
	})
	if out == nil {
		out = []herdrapi.AgentTopicInfo{}
	}
	return out
}

func topicsNotOffered(err error) bool {
	var unsupported *engine.ErrUnsupported
	if errors.As(err, &unsupported) {
		return true
	}
	var api *bridge.APIError
	return errors.As(err, &api) && (api.Code == "topics_unsupported" || api.Code == "agent_not_found")
}

// topicsProblem says why a topics call failed, in the words the iPhone app
// uses (TopicsModel.describe).
func topicsProblem(err error) string {
	var api *bridge.APIError
	if !errors.As(err, &api) {
		return "Couldn't reach the agent."
	}
	switch api.Code {
	case "topics_unreachable":
		return "Agent not reachable"
	case "topics_timeout":
		return "The agent didn't answer in time."
	case "topic_rejected":
		if api.Message == "" {
			return "The agent refused."
		}
		return "The agent refused: " + api.Message
	case "topic_not_found":
		return "This topic is gone."
	case "agent_not_found":
		return "This agent is gone."
	case "topics_unsupported":
		return "This agent has no topics."
	}
	return "Couldn't reach the agent."
}

// topicsError is a topics call's refusal for the page: herdr's code and the
// app's words for it.
func topicsError(err error) error {
	if err == nil {
		return nil
	}
	return errors.New(topicsProblem(err))
}

// TopicsNew starts a topic with its title and first message; the page
// opens it by the returned id.
func (d *Desk) TopicsNew(ctx context.Context, token, title, message string) (string, error) {
	v, err := d.agentView(token)
	if err != nil {
		return "", err
	}
	title, message = strings.TrimSpace(title), strings.TrimSpace(message)
	if title == "" || message == "" {
		return "", errors.New("A topic needs a title and a first message.")
	}
	if len(message) > topicMessageBytes {
		return "", errTopicTooLong
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	created, err := v.client.AgentTopicsNew(ctx, herdrapi.AgentTopicsNewParams{Target: v.PaneID, Title: title, Message: message})
	if err != nil {
		return "", topicsError(err)
	}
	d.topicsRead(v)
	return created.TopicID, nil
}

var errTopicTooLong = errors.New("Messages are limited to 32 KB. Send it in parts.")

// TopicSendReply says how the agent took a topic message: "queued" waits
// for the topic's current turn to end.
type TopicSendReply struct {
	Mode string `json:"mode"`
}

// TopicsSend sends a message to one topic (agent.topics.send).
func (d *Desk) TopicsSend(ctx context.Context, token, topicID, text string) (TopicSendReply, error) {
	v, err := d.agentView(token)
	if err != nil {
		return TopicSendReply{}, err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return TopicSendReply{}, errors.New("prompt is empty")
	}
	if len(text) > topicMessageBytes {
		return TopicSendReply{}, errTopicTooLong
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	sent, err := v.client.AgentTopicsSend(ctx, herdrapi.AgentTopicsSendParams{Target: v.PaneID, TopicID: topicID, Message: text})
	if err != nil {
		return TopicSendReply{}, topicsError(err)
	}
	d.topicsRead(v)
	return TopicSendReply{Mode: string(sent.Mode)}, nil
}

// TopicsClose, TopicsReopen and TopicsRename change one topic, then read
// the list again.
func (d *Desk) TopicsClose(ctx context.Context, token, topicID string) error {
	return d.topicAction(ctx, token, func(ctx context.Context, v *interaction) error {
		return v.client.AgentTopicsClose(ctx, herdrapi.AgentTopicTarget{Target: v.PaneID, TopicID: topicID})
	})
}

func (d *Desk) TopicsReopen(ctx context.Context, token, topicID string) error {
	return d.topicAction(ctx, token, func(ctx context.Context, v *interaction) error {
		return v.client.AgentTopicsReopen(ctx, herdrapi.AgentTopicTarget{Target: v.PaneID, TopicID: topicID})
	})
}

func (d *Desk) TopicsRename(ctx context.Context, token, topicID, title string) error {
	title = strings.TrimSpace(title)
	if title == "" {
		return errors.New("A topic needs a title.")
	}
	return d.topicAction(ctx, token, func(ctx context.Context, v *interaction) error {
		return v.client.AgentTopicsRename(ctx, herdrapi.AgentTopicsRenameParams{Target: v.PaneID, TopicID: topicID, Title: title})
	})
}

func (d *Desk) topicAction(ctx context.Context, token string, do func(context.Context, *interaction) error) error {
	v, err := d.agentView(token)
	if err != nil {
		return err
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	if err := do(ctx, v); err != nil {
		return topicsError(err)
	}
	d.topicsRead(v)
	return nil
}
