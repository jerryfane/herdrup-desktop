package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/gramstore"
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

//go:embed topics_retry.json
var topicsRetryJSON []byte

// topicsRetry is the wait before the open Inbox asks again after a list that
// failed for a passing reason (topics_unreachable, a timeout, a dropped call)
// or a capability that couldn't be read: iOS TopicsDiscoveryBackoff, the last
// one repeating. topics_retry.json holds it in seconds for this desk and the
// web desk (src/web/desk.ts). Tests replace it.
var topicsRetry = func() []time.Duration {
	var secs []int
	if err := json.Unmarshal(topicsRetryJSON, &secs); err != nil || len(secs) == 0 {
		panic("topics_retry.json is not a list of seconds")
	}
	waits := make([]time.Duration, len(secs))
	for i, s := range secs {
		waits[i] = time.Duration(s) * time.Second
	}
	return waits
}()

// TopicsUpdate is the page's Topics state for one view: the list, ordered
// as the Topics view lists it, or why the newest read failed (the last list
// stays on screen: every failure but topics_unsupported keeps it). Offered
// says the agent answered agent.topics.list this session, so the page
// offers Topics; Changed names a topic whose conversation changed (an
// owner's event), so an open topic chat reads its tail. Stale says the
// list is a herdr's cached answer whose last refresh from the agent failed:
// an empty one is not the agent's word that it has no topics.
//
// Suggestions are the agent's open topic suggestions, oldest first (herdr
// #490): Organise's proposals and the ones it made in the Inbox.
// SuggestionsServed says the agent's omp serves them (its list carries
// `suggestions`) on a server with agent_topic_suggestions, so the list
// offers Organise. RequestedMs is when the read behind this list was asked
// for (Unix ms): a list asked for after a reader's Start or Not now went
// through is the server's word on that suggestion.
type TopicsUpdate struct {
	Token             string                              `json:"token"`
	Topics            []herdrapi.AgentTopicInfo           `json:"topics"`
	Offered           bool                                `json:"offered"`
	Loaded            bool                                `json:"loaded"`
	Stale             bool                                `json:"stale,omitempty"`
	Problem           string                              `json:"problem,omitempty"`
	Changed           string                              `json:"changed,omitempty"`
	Suggestions       []herdrapi.AgentTopicSuggestionInfo `json:"suggestions"`
	SuggestionsServed bool                                `json:"suggestionsServed"`
	RequestedMs       int64                               `json:"requestedMs"`
}

var TopicsChanged = mygo.NewEvent[TopicsUpdate]("topics:changed")

// broadcastTopics sends one update to the page; the lists are never null,
// which the page reads as lists. It is a Desk's publishTopics unless a
// test gives the Desk its own.
func broadcastTopics(u TopicsUpdate) {
	TopicsChanged.Broadcast(withLists(u))
}

func withLists(u TopicsUpdate) TopicsUpdate {
	if u.Topics == nil {
		u.Topics = []herdrapi.AgentTopicInfo{}
	}
	if u.Suggestions == nil {
		u.Suggestions = []herdrapi.AgentTopicSuggestionInfo{}
	}
	return u
}

// topicsState is one view's topics watch: the last list and the follower
// that keeps it current while Topics shows, or while the Inbox (the chat)
// is open on an agent whose suggestions are served (iOS ChatView follows
// the list then, so a listed suggestion shows before its transcript entry).
type topicsState struct {
	mu      sync.Mutex
	last    TopicsUpdate
	cancel  context.CancelFunc
	shown   bool
	inbox   bool
	reading bool
	again   bool
	// settled: the newest read is the agent's word: a list with a known
	// suggestions capability, or a refusal for good (topicsNotOffered).
	// Until then the open Inbox asks again on topicsRetry's schedule.
	settled bool
	retry   *time.Timer
	// retryOnClose stops retry when the view closes, so a closed view holds
	// no timer.
	retryOnClose func() bool
	retries      int
	// asOf is when the agent last answered the list shown, as a herdr that
	// serves the list from its cache says (as_of_unix_ms; 0 when unsaid).
	asOf uint64
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
// stops when shown goes false (unless the Inbox still follows) or the view
// closes.
func (d *Desk) TopicsFollow(token string, shown bool) error {
	v, err := d.agentView(token)
	if err != nil {
		return err
	}
	t := &v.topics
	t.mu.Lock()
	t.shown = shown
	t.mu.Unlock()
	if shown {
		d.topicsRead(v)
	}
	d.topicsWatch(v)
	return nil
}

// TopicsFollowInbox says whether the page's Inbox (its Chat view) is open:
// while it is and the agent's suggestions are served, the list is followed
// as Topics follows it; until a read settles that, it is asked again on
// topicsRetry's schedule. It stops when open goes false or the view closes.
func (d *Desk) TopicsFollowInbox(token string, open bool) error {
	v, err := d.agentView(token)
	if err != nil {
		return err
	}
	t := &v.topics
	t.mu.Lock()
	t.inbox = open
	settled := t.settled
	t.mu.Unlock()
	if open && !settled {
		// Whether suggestions are served is the list's word.
		d.topicsRead(v)
	}
	d.topicsWatch(v)
	return nil
}

// stopRetry drops the Inbox's retry timer and its hook on the view's
// close. t.mu is held.
func (t *topicsState) stopRetry() {
	if t.retry != nil {
		t.retry.Stop()
		t.retry = nil
	}
	if t.retryOnClose != nil {
		t.retryOnClose()
		t.retryOnClose = nil
	}
}

// topicsWatch starts the follower when Topics shows or the Inbox is open on
// served suggestions, and stops it when neither holds. Topics on screen or
// an open Inbox whose newest read didn't settle (topics_unreachable on a
// moment's miss, topics_timeout when omp didn't answer in time; herdr #520
// retries both) asks again after a backoff, keeping the list.
func (d *Desk) topicsWatch(v *interaction) {
	t := &v.topics
	t.mu.Lock()
	want := t.shown || (t.inbox && t.last.SuggestionsServed)
	retry := (t.shown || t.inbox) && !t.settled && v.ctx.Err() == nil
	switch {
	case retry && t.retry == nil:
		wait := topicsRetry[min(t.retries, len(topicsRetry)-1)]
		t.retries++
		// Each callback acts only on its own retry: one that fired while
		// the Inbox rearmed waits on t.mu and must not stop the new one.
		var timer *time.Timer
		timer = time.AfterFunc(wait, func() {
			t.mu.Lock()
			if t.retry != timer {
				t.mu.Unlock()
				return
			}
			t.stopRetry()
			t.mu.Unlock()
			if v.ctx.Err() == nil {
				d.topicsRead(v)
			}
		})
		t.retry = timer
		t.retryOnClose = context.AfterFunc(v.ctx, func() {
			t.mu.Lock()
			if t.retry == timer {
				t.stopRetry()
			}
			t.mu.Unlock()
		})
	case !retry && t.retry != nil:
		t.stopRetry()
	}
	if want == (t.cancel != nil) || v.ctx.Err() != nil {
		t.mu.Unlock()
		return
	}
	if !want {
		t.cancel()
		t.cancel = nil
		t.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(v.ctx)
	t.cancel = cancel
	t.mu.Unlock()
	go d.followTopics(ctx, v)
}

// followTopics: a guest polls every topicsGuestPoll; the owner follows
// agent.topics.changed for this pane and polls every topicsBackstop. A
// server that refuses the subscription is polled at the guest's pace.
func (d *Desk) followTopics(ctx context.Context, v *interaction) {
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
				// reason "listed" (herdr #520) names no topic: herdr's list
				// changed, so the read below is all it asks for.
				if change.TopicID != "" {
					d.topicsChangedTopic(v, change.TopicID)
				}
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
	d.publishTopics(u)
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
	requested := time.Now()
	list, fresh, err := v.client.AgentTopicsList(ctx, v.PaneID)
	served, known := false, true
	if err == nil && list.Suggestions != nil {
		served, known = v.client.Supports(ctx, herdrapi.CapabilityAgentTopicSuggestions)
	}
	if v.ctx.Err() != nil {
		return
	}
	t := &v.topics
	t.mu.Lock()
	u := t.last
	u.Token, u.Loaded, u.Changed = v.Token, true, ""
	switch {
	case err == nil && fresh.AsOfMs != 0 && fresh.AsOfMs < t.asOf:
		// An answer older than the list shown (a cache behind the
		// refresh that brought it): the newer list stays.
	case err == nil:
		u.Topics, u.Offered, u.Problem, u.Stale = orderedTopics(list.Topics), true, "", fresh.Stale
		u.Suggestions, u.RequestedMs = openSuggestions(list.Suggestions), requested.UnixMilli()
		if fresh.AsOfMs != 0 {
			t.asOf = fresh.AsOfMs
		}
		// A capability that couldn't be read keeps the last answer and
		// leaves the read unsettled.
		if known {
			u.SuggestionsServed = served
		}
		t.settled = known
	case topicsNotOffered(err):
		// Not an agent with topics (any more): the page goes back to Chat and Terminal.
		u.Topics, u.Offered, u.Problem, u.Stale = nil, false, "", false
		u.Suggestions, u.SuggestionsServed, u.RequestedMs = nil, false, requested.UnixMilli()
		t.settled, t.asOf = true, 0
	default:
		u.Problem = topicsProblem(err)
		t.settled = false
	}
	if t.settled {
		t.retries = 0
	}
	t.last = u
	t.mu.Unlock()
	d.publishTopics(u)
	// Suggestions served or not: the open Inbox follows the list or stops.
	d.topicsWatch(v)
}

// openSuggestions are the list's suggestions as the page lists them
// (AgentTopicList.suggestions): oldest first, one without an id left out.
func openSuggestions(list []herdrapi.AgentTopicSuggestionInfo) []herdrapi.AgentTopicSuggestionInfo {
	return slices.DeleteFunc(slices.Clone(list), func(s herdrapi.AgentTopicSuggestionInfo) bool { return s.SuggestionID == "" })
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

// topicsNotOffered: the agent answered it has no topics. agent_not_found is
// not that answer (an agent herdr briefly can't resolve, as while it
// starts a topic): it keeps the list, as every other failure does.
func topicsNotOffered(err error) bool {
	var unsupported *engine.ErrUnsupported
	if errors.As(err, &unsupported) {
		return true
	}
	var api *bridge.APIError
	return errors.As(err, &api) && api.Code == "topics_unsupported"
}

// topicsProblem says why a topics call failed, in the words the iPhone app
// uses (TopicsModel.describe).
func topicsProblem(err error) string {
	if unsupported := (*engine.ErrUnsupported)(nil); errors.As(err, &unsupported) && unsupported.Capability == herdrapi.CapabilityAgentTopicSuggestions {
		return "This server doesn't suggest topics."
	}
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
	case "suggestion_not_found":
		return "That suggestion is gone."
	case "already_accepted":
		return "Someone already started that topic."
	case "organise_running":
		return "The agent is already organising."
	case "topics_disabled":
		return "Topics are off for this agent."
	case "invalid_message_ids":
		return "The agent's picked messages are no longer in its conversation."
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

// TopicSendReply is how a topic message went. Delivery is "sent" (Mode says
// how the agent took it: "queued" waits for the topic's current turn to
// end), "refused" (the agent or this app turned it down: safe to send again)
// or "unconfirmed" (it may have reached the agent: no one-tap resend).
// Problem is the app's words for a refused or unconfirmed send. The page
// decides from Delivery, never from Problem's wording.
type TopicSendReply struct {
	Mode     string `json:"mode"`
	Delivery string `json:"delivery"`
	Problem  string `json:"problem,omitempty"`
}

// topicSendUnconfirmed is the note for a send whose link broke (iOS: any
// error that is not the agent's answer).
const topicSendUnconfirmed = "Couldn't confirm delivery. Check the topic before sending again."

// topicSendDelivery classifies a failed agent.topics.send as iOS does
// (TopicsModel.deliver): herdr's refusals were not delivered; a timeout, an
// unknown code or a broken link may have been.
func topicSendDelivery(err error) string {
	if unsupported := (*engine.ErrUnsupported)(nil); errors.As(err, &unsupported) {
		return "refused"
	}
	var api *bridge.APIError
	if !errors.As(err, &api) {
		return "unconfirmed"
	}
	switch api.Code {
	case "topics_unreachable", "topic_rejected", "topic_not_found", "agent_not_found", "topics_unsupported", "invalid_params":
		return "refused"
	}
	return "unconfirmed"
}

// TopicsSend sends a message to one topic (agent.topics.send), from the
// page's composer: with its files, they go as the Inbox's do (sendAttached:
// posted as Grams, named in the message), the topic running in the same omp.
// A refusal keeps the files for a retry.
func (d *Desk) TopicsSend(ctx context.Context, token, topicID, text string) (TopicSendReply, error) {
	v, err := d.agentView(token)
	if err != nil {
		return TopicSendReply{}, err
	}
	text = strings.TrimSpace(text)
	attached := len(v.composer.Snapshot().Chips) > 0
	if text == "" && !attached {
		return TopicSendReply{}, errors.New("prompt is empty")
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	if !attached {
		return d.topicSend(ctx, v, topicID, text), nil
	}
	// A caption already over the cap can't go with any file: refused before
	// one is posted (#534). topicSend checks the composed message too.
	if len(text) > topicMessageBytes {
		return TopicSendReply{Delivery: "refused", Problem: errTopicTooLong.Error()}, nil
	}
	if !v.sendMu.TryLock() {
		return TopicSendReply{}, gramstore.ErrSending
	}
	defer v.sendMu.Unlock()
	var reply TopicSendReply
	_, err = d.sendAttached(ctx, v, text, func(prompt string) (string, error) {
		reply = d.topicSend(ctx, v, topicID, prompt)
		if reply.Delivery == "refused" {
			return "", errors.New(reply.Problem)
		}
		return "", nil
	})
	if reply.Delivery == "refused" {
		return reply, nil
	}
	if err != nil {
		return TopicSendReply{}, err
	}
	return reply, nil
}

// topicSend sends message to one topic and says how it went, in the words
// the page shows (topicSendDelivery, topicsProblem); the list is read again.
func (d *Desk) topicSend(ctx context.Context, v *interaction, topicID, message string) TopicSendReply {
	if len(message) > topicMessageBytes {
		return TopicSendReply{Delivery: "refused", Problem: errTopicTooLong.Error()}
	}
	sent, err := v.client.AgentTopicsSend(ctx, herdrapi.AgentTopicsSendParams{Target: v.PaneID, TopicID: topicID, Message: message})
	d.topicsRead(v)
	if err != nil {
		problem := topicsProblem(err)
		if api := (*bridge.APIError)(nil); !errors.As(err, &api) && topicSendDelivery(err) == "unconfirmed" {
			problem = topicSendUnconfirmed
		}
		return TopicSendReply{Delivery: topicSendDelivery(err), Problem: problem}
	}
	return TopicSendReply{Mode: string(sent.Mode), Delivery: "sent"}
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

// TopicsAcceptSuggestion is a suggestion's Start (agent.topics.accept_suggestion):
// the agent starts the topic with the messages it picked, and the page opens
// it by the returned id. A suggestion someone started before answers that
// topic. Owner and guest alike (herdr guest_gate.rs, owner decision 2026-11-22).
func (d *Desk) TopicsAcceptSuggestion(ctx context.Context, token, suggestionID string) (string, error) {
	var topicID string
	err := d.topicAction(ctx, token, func(ctx context.Context, v *interaction) error {
		accepted, err := v.client.AgentTopicsAcceptSuggestion(ctx, herdrapi.AgentTopicSuggestionTarget{Target: v.PaneID, SuggestionID: suggestionID})
		topicID = accepted.TopicID
		return err
	})
	return topicID, err
}

// TopicsDismissSuggestion is a suggestion's Not now (agent.topics.dismiss_suggestion).
func (d *Desk) TopicsDismissSuggestion(ctx context.Context, token, suggestionID string) error {
	return d.topicAction(ctx, token, func(ctx context.Context, v *interaction) error {
		_, err := v.client.AgentTopicsDismissSuggestion(ctx, herdrapi.AgentTopicSuggestionTarget{Target: v.PaneID, SuggestionID: suggestionID})
		return err
	})
}

// TopicsOrganise asks the agent to propose topics from its Inbox
// (agent.topics.organise). It answers at once, queued when the agent's
// current turn runs first; the proposals arrive later as open suggestions.
func (d *Desk) TopicsOrganise(ctx context.Context, token string) (bool, error) {
	var queued bool
	err := d.topicAction(ctx, token, func(ctx context.Context, v *interaction) error {
		started, err := v.client.AgentTopicsOrganise(ctx, herdrapi.AgentTopicsOrganiseParams{Target: v.PaneID})
		queued = started.Queued
		return err
	})
	return queued, err
}

// TopicsSettleSuggestions is the proposals bar (TopicsModel.settleProposals):
// Create N topics starts a topic from each of accept and sets dismiss
// aside; Not now sets all aside. A suggestion someone else settled first is
// skipped. It returns why one did not go through, "" when all did.
func (d *Desk) TopicsSettleSuggestions(ctx context.Context, token string, accept, dismiss []string) (string, error) {
	v, err := d.agentView(token)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	problem := ""
	settle := func(id string, start bool) {
		target := herdrapi.AgentTopicSuggestionTarget{Target: v.PaneID, SuggestionID: id}
		var err error
		if start {
			_, err = v.client.AgentTopicsAcceptSuggestion(ctx, target)
		} else {
			_, err = v.client.AgentTopicsDismissSuggestion(ctx, target)
		}
		var api *bridge.APIError
		if err == nil || problem != "" || (errors.As(err, &api) && (api.Code == "already_accepted" || api.Code == "suggestion_not_found")) {
			return
		}
		problem = topicsProblem(err)
	}
	for _, id := range accept {
		settle(id, true)
	}
	for _, id := range dismiss {
		settle(id, false)
	}
	d.topicsRead(v)
	return problem, nil
}

// TopicsSwitched is how the owner's Topics switch ended: Changed is false
// when the agent already ran that way, and then nothing was restarted.
type TopicsSwitched struct {
	Changed       bool `json:"changed"`
	TopicsEnabled bool `json:"topicsEnabled"`
}

// TopicsSetEnabled is the owner's Topics switch for one omp agent
// (agent.topics.set_enabled, herdr #489): herdr restarts it on the omp build
// with topics, or back on the standard one; its conversation and name stay.
// A refusal reads as the iPhone app words it (TopicsSwitchStatus.describe).
func (d *Desk) TopicsSetEnabled(ctx context.Context, paneID string, enabled bool) (TopicsSwitched, error) {
	client, _, lifetime, err := d.agentLink(paneID)
	if err != nil {
		return TopicsSwitched{}, err
	}
	ctx, cancel := viewRequest(ctx, lifetime)
	defer cancel()
	switched, err := client.AgentTopicsSetEnabled(ctx, herdrapi.AgentTopicsSetEnabledParams{Target: paneID, Enabled: enabled})
	if err != nil {
		return TopicsSwitched{}, errors.New(topicsSwitchProblem(err))
	}
	return TopicsSwitched{Changed: switched.Changed, TopicsEnabled: switched.TopicsEnabled}, nil
}

// topicsSwitchProblem completes "Couldn't turn on topics: …"; agent.restart's
// own refusals come through in herdr's words.
func topicsSwitchProblem(err error) string {
	if unsupported := (*engine.ErrUnsupported)(nil); errors.As(err, &unsupported) {
		return "this server has no Topics switch."
	}
	var api *bridge.APIError
	if !errors.As(err, &api) {
		return "couldn't reach the server."
	}
	switch api.Code {
	case "topics_build_missing":
		return "this server has no omp build with topics."
	case "not_omp":
		return "only omp agents have topics."
	case "guest_forbidden":
		return "only the owner can switch topics."
	case "agent_directory_unavailable":
		return "the agent's folder is not available."
	}
	return api.Message
}
