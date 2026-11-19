package fakeherdr

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Topics is an opt-in fixture of herdr #475's agent topics: agent.topics.*,
// agent.transcript with `topic`, and agent_topics_changed events. Every
// agent has the same three sample topics (one working, one idle with a
// queued message, one closed); a send or a new topic answers with a reply a
// moment later, as a topic's turn does. It runs no model.
type Topics struct {
	mu     sync.Mutex
	agents map[string]*topicAgent
	subs   map[chan []byte]bool
	seq    uint64
	// Turn is how long a topic's turn takes before its reply (default 2 s).
	Turn time.Duration
	now  func() time.Time
}

type topicAgent struct {
	order  []string
	topics map[string]*fakeTopic
	next   int
}

type fakeTopic struct {
	info    map[string]any
	entries []map[string]any
	queued  []string
}

func NewTopics() *Topics {
	return &Topics{agents: map[string]*topicAgent{}, subs: map[chan []byte]bool{}, Turn: 2 * time.Second, now: time.Now}
}

// Capabilities are what a herdr with topics advertises on ping.
func (*Topics) Capabilities() []string { return []string{"agent_topics", "agent_transcript_topic"} }

func (t *Topics) agent(target string) *topicAgent {
	if a := t.agents[target]; a != nil {
		return a
	}
	now := t.now().UnixMilli()
	day := int64(24 * time.Hour / time.Millisecond)
	a := &topicAgent{topics: map[string]*fakeTopic{}, next: 4}
	add := func(id, title, state, activity string, last int64, queued uint64, entries []map[string]any) {
		a.order = append(a.order, id)
		a.topics[id] = &fakeTopic{info: map[string]any{"topic_id": id, "title": title, "state": state, "turns": uint64(len(entries) / 2),
			"queued": queued, "created_unix_ms": last - day, "last_activity_unix_ms": last, "last_activity": activity}, entries: entries}
	}
	add("t1", "Q4 board pack", "running", "Reading the September minutes", now-5*60*1000, 0, []map[string]any{
		{"kind": "user", "id": "t1u1", "ts_ms": now - 20*60*1000, "author": "owner", "text": "Draft the Q4 board pack from the September minutes."},
		{"kind": "step", "id": "t1s1", "ts_ms": now - 19*60*1000, "tool": "read", "intent": "Reading minutes", "detail": "board/2026-09.md", "status": "ok"},
		{"kind": "reply", "id": "t1r1", "ts_ms": now - 18*60*1000, "final": true, "text": "The **September minutes** list three open items. I'll start with the budget."},
	})
	add("t2", "Diokan renewal", "idle", "Sent the renewal terms for review", now-3*day, 1, []map[string]any{
		{"kind": "user", "id": "t2u1", "ts_ms": now - 3*day - 60000, "author": "owner", "text": "Check the Diokan renewal terms."},
		{"kind": "reply", "id": "t2r1", "ts_ms": now - 3*day, "final": true, "text": "The renewal keeps the **same price** for 12 months; the notice period is 60 days."},
	})
	add("t3", "Trip to Lisbon", "closed", "Booked the flights", now-10*day, 0, []map[string]any{
		{"kind": "user", "id": "t3u1", "ts_ms": now - 10*day - 60000, "author": "owner", "text": "Book flights to Lisbon for the 4th."},
		{"kind": "reply", "id": "t3r1", "ts_ms": now - 10*day, "final": true, "text": "Booked: TP 1361, departing 08:05."},
	})
	t.agents[target] = a
	return a
}

// Handle answers the topics methods; ok is false for any other method and
// for agent.transcript without `topic`.
func (t *Topics) Handle(method string, raw json.RawMessage) (any, *APIError, bool) {
	if !strings.HasPrefix(method, "agent.topics.") && method != "agent.transcript" {
		return nil, nil, false
	}
	var p struct {
		Target  string `json:"target"`
		Topic   string `json:"topic"`
		TopicID string `json:"topic_id"`
		Title   string `json:"title"`
		Message string `json:"message"`
		After   string `json:"after"`
		Before  string `json:"before"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &APIError{Code: "invalid_params", Message: err.Error()}, true
	}
	if method == "agent.transcript" && p.Topic == "" {
		return nil, nil, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	a := t.agent(p.Target)
	reply := func(kind string, fields map[string]any) map[string]any {
		fields["type"], fields["agent"], fields["pane_id"] = kind, "omp", p.Target
		return fields
	}
	if method == "agent.topics.list" {
		list := make([]any, 0, len(a.order))
		for _, id := range a.order {
			list = append(list, a.topics[id].info)
		}
		return reply("agent_topics", map[string]any{"topics": list}), nil, true
	}
	if method == "agent.topics.new" {
		if strings.TrimSpace(p.Title) == "" || strings.TrimSpace(p.Message) == "" {
			return nil, &APIError{Code: "invalid_params", Message: "title and message are required"}, true
		}
		id := fmt.Sprintf("t%d", a.next)
		a.next++
		now := t.now().UnixMilli()
		a.order = append(a.order, id)
		a.topics[id] = &fakeTopic{info: map[string]any{"topic_id": id, "title": strings.TrimSpace(p.Title), "state": "starting", "turns": uint64(0), "queued": uint64(0),
			"created_unix_ms": now, "last_activity_unix_ms": now}}
		t.startTurnLocked(p.Target, id, p.Message)
		return reply("agent_topic_created", map[string]any{"topic_id": id}), nil, true
	}
	id := p.TopicID
	if method == "agent.transcript" {
		id = p.Topic
	}
	topic := a.topics[id]
	if topic == nil {
		return nil, &APIError{Code: "topic_not_found", Message: "no topic " + id}, true
	}
	switch method {
	case "agent.transcript":
		entries := topic.entries
		if p.After != "" {
			var n int
			if _, err := fmt.Sscanf(p.After, "a%d", &n); err == nil && n <= len(entries) {
				entries = entries[n:]
			}
		}
		if p.Before != "" {
			entries = nil
		}
		page := map[string]any{"type": "agent_transcript", "agent": "omp", "pane_id": p.Target, "session_id": "topic-" + id,
			"entries": append([]map[string]any{}, entries...), "after": fmt.Sprintf("a%d", len(topic.entries))}
		if state := topic.info["state"]; state == "running" || state == "starting" {
			page["working"] = map[string]any{"since_ms": topic.info["last_activity_unix_ms"], "intent": topic.info["last_activity"], "tool": ""}
		}
		return page, nil, true
	case "agent.topics.send":
		switch topic.info["state"] {
		case "closed":
			return nil, &APIError{Code: "topic_rejected", Message: "the topic is closed"}, true
		case "running", "starting":
			topic.queued = append(topic.queued, p.Message)
			topic.info["queued"] = uint64(len(topic.queued))
			t.changedLocked(p.Target, id, "queued")
			return reply("agent_topic_sent", map[string]any{"topic_id": id, "mode": "queued"}), nil, true
		}
		t.startTurnLocked(p.Target, id, p.Message)
		return reply("agent_topic_sent", map[string]any{"topic_id": id, "mode": "turn"}), nil, true
	case "agent.topics.close":
		topic.info["state"] = "closed"
	case "agent.topics.reopen":
		topic.info["state"] = "idle"
	case "agent.topics.rename":
		if strings.TrimSpace(p.Title) == "" {
			return nil, &APIError{Code: "invalid_params", Message: "title is required"}, true
		}
		topic.info["title"] = strings.TrimSpace(p.Title)
	default:
		return nil, &APIError{Code: "unknown_method", Message: method}, true
	}
	t.changedLocked(p.Target, id, strings.TrimPrefix(method, "agent.topics."))
	return reply("agent_topic_updated", map[string]any{"topic_id": id}), nil, true
}

// startTurnLocked records the owner's message and answers it after Turn;
// a message queued meanwhile starts the next turn.
func (t *Topics) startTurnLocked(target, id, message string) {
	topic := t.agents[target].topics[id]
	now := t.now().UnixMilli()
	n := len(topic.entries)
	topic.entries = append(topic.entries, map[string]any{"kind": "user", "id": fmt.Sprintf("%su%d", id, n), "ts_ms": now, "author": "owner", "text": message})
	topic.info["state"], topic.info["last_activity_unix_ms"], topic.info["last_activity"] = "running", now, "Working on it"
	t.changedLocked(target, id, "turn_started")
	time.AfterFunc(t.Turn, func() {
		t.mu.Lock()
		defer t.mu.Unlock()
		now := t.now().UnixMilli()
		topic.entries = append(topic.entries, map[string]any{"kind": "reply", "id": fmt.Sprintf("%sr%d", id, len(topic.entries)), "ts_ms": now, "final": true,
			"text": "Done: **" + firstLine(message) + "**."})
		topic.info["turns"] = topic.info["turns"].(uint64) + 1
		topic.info["state"], topic.info["last_activity_unix_ms"], topic.info["last_activity"] = "idle", now, "Answered: "+firstLine(message)
		if len(topic.queued) > 0 {
			next := topic.queued[0]
			topic.queued = topic.queued[1:]
			topic.info["queued"] = uint64(len(topic.queued))
			t.startTurnLocked(target, id, next)
			return
		}
		t.changedLocked(target, id, "turn_ended")
	})
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(strings.TrimSpace(s), "\n")
	if len(s) > 60 {
		s = s[:60]
	}
	return s
}

func (t *Topics) changedLocked(target, id, reason string) {
	t.seq++
	line, _ := json.Marshal(map[string]any{"seq": t.seq, "event": "agent_topics_changed", "data": map[string]any{
		"type": "agent_topics_changed", "pane_id": target, "workspace_id": "w1", "topic_id": id, "reason": reason}})
	for c := range t.subs {
		select {
		case c <- line:
		default:
		}
	}
}

// Events writes agent_topics_changed lines to one events.subscribe stream
// until ctx ends.
func (t *Topics) Events(ctx context.Context, emit func([]byte) error) {
	c := make(chan []byte, 16)
	t.mu.Lock()
	t.subs[c] = true
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		delete(t.subs, c)
		t.mu.Unlock()
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case line := <-c:
			if emit(line) != nil {
				return
			}
		}
	}
}
