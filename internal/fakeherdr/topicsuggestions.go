package fakeherdr

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
)

// The Topics fixture's herdr #489/#490 half (Topics.Suggestions): the owner's
// per-agent Topics switch, and the agent's topic suggestions. Each agent's
// Inbox starts with one open suggestion picked from the -interactions
// transcript (u1, r1, n1); Organise proposes two more a turn later. Start
// opens a topic with the suggestion's title, Not now sets it aside; both
// change its topic_suggestion entry, which every Inbox page re-sends under
// the same id (newest state wins).

// TurnOff starts targets (pane ids) with their topics switched off: their
// topics_enabled is false and agent.topics.* answer as a stock omp's.
func (t *Topics) TurnOff(targets ...string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, target := range targets {
		t.off[target] = true
	}
}

// WithoutSuggestions makes targets omp agents whose omp has topics but no
// suggestions: their list carries no `suggestions` and the suggestion
// methods answer topics_unsupported.
func (t *Topics) WithoutSuggestions(targets ...string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, target := range targets {
		t.plain[target] = true
	}
}

// Serve answers through t, then next: the pong gains Capabilities, an
// agent.list or agent.get its omp agents' topics_enabled, and an agent's
// own transcript (no `topic`) its topic_suggestion entries.
func (t *Topics) Serve(next func(string, json.RawMessage) (any, *APIError)) func(string, json.RawMessage) (any, *APIError) {
	return func(method string, raw json.RawMessage) (any, *APIError) {
		if value, err, ok := t.Handle(method, raw); ok {
			return value, err
		}
		value, err := next(method, raw)
		if err != nil {
			return value, err
		}
		switch method {
		case "ping":
			if caps, ok := value.(map[string]any)["capabilities"].(map[string]bool); ok {
				for _, name := range t.Capabilities() {
					caps[name] = true
				}
			}
		case "agent.list", "agent.get":
			if t.Suggestions {
				value = t.withTopicsEnabled(value)
			}
		case "agent.transcript":
			if t.Suggestions {
				value = t.withSuggestionEntries(raw, value)
			}
		}
		return value, err
	}
}

// asObject is a result as a JSON object, whatever Go value carries it.
func asObject(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	data, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(data, &m) != nil {
		return nil
	}
	return m
}

func (t *Topics) withTopicsEnabled(value any) any {
	m := asObject(value)
	if m == nil {
		return value
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	mark := func(a any) {
		if agent, ok := a.(map[string]any); ok && agent["agent"] == "omp" {
			pane, _ := agent["pane_id"].(string)
			agent["topics_enabled"] = !t.off[pane]
		}
	}
	if agents, ok := m["agents"].([]any); ok {
		for _, a := range agents {
			mark(a)
		}
	}
	mark(m["agent"])
	return m
}

// withSuggestionEntries appends the Inbox's topic_suggestion entries to a
// newest or after page of an agent's own conversation; an older page has
// none (they are the conversation's tail).
func (t *Topics) withSuggestionEntries(raw json.RawMessage, value any) any {
	var p struct {
		Target   string  `json:"target"`
		Topic    *string `json:"topic"`
		Subagent *string `json:"subagent"`
		Before   *string `json:"before"`
	}
	if json.Unmarshal(raw, &p) != nil || p.Topic != nil || p.Subagent != nil || (p.Before != nil && *p.Before != "") {
		return value
	}
	t.mu.Lock()
	if t.off[p.Target] || t.plain[p.Target] {
		t.mu.Unlock()
		return value
	}
	entries := cloneEntries(t.agent(p.Target).suggestions)
	t.mu.Unlock()
	m := asObject(value)
	if m == nil || len(entries) == 0 {
		return value
	}
	page, _ := m["entries"].([]any)
	for _, e := range entries {
		page = append(page, e)
	}
	m["entries"] = page
	return m
}

// suggestLocked opens a suggestion of messageIDs in a's Inbox and returns
// its id.
func (t *Topics) suggestLocked(a *topicAgent, title, reason string, messageIDs []string) string {
	a.nextSuggestion++
	id := fmt.Sprintf("sg%d", a.nextSuggestion)
	a.suggestions = append(a.suggestions, map[string]any{"kind": "topic_suggestion", "id": id, "ts_ms": t.now().UnixMilli(),
		"title": title, "reason": reason, "message_ids": slices.Clone(messageIDs), "message_count": len(messageIDs), "state": "open"})
	return id
}

// openSuggestionsLocked is the list's `suggestions`: the open ones, oldest first.
func openSuggestionsLocked(a *topicAgent) []any {
	out := []any{}
	for _, s := range a.suggestions {
		if s["state"] == "open" {
			out = append(out, map[string]any{"suggestion_id": s["id"], "title": s["title"], "reason": s["reason"],
				"message_ids": slices.Clone(s["message_ids"].([]string)), "created_unix_ms": s["ts_ms"]})
		}
	}
	return out
}

// newTopicLocked starts a topic with its title and first message.
func (t *Topics) newTopicLocked(target string, a *topicAgent, title, message string) string {
	id := fmt.Sprintf("t%d", a.next)
	a.next++
	now := t.now().UnixMilli()
	a.order = append(a.order, id)
	a.topics[id] = &fakeTopic{info: map[string]any{"topic_id": id, "title": strings.TrimSpace(title), "state": "starting", "turns": uint64(0), "queued": uint64(0),
		"created_unix_ms": now, "last_activity_unix_ms": now}}
	t.startTurnLocked(target, id, message)
	return id
}

func (t *Topics) suggestionChangedLocked(target, id, reason string) {
	t.seq++
	line, _ := json.Marshal(map[string]any{"seq": t.seq, "event": "agent_topics_changed", "data": map[string]any{
		"type": "agent_topics_changed", "pane_id": target, "workspace_id": "w1", "topic_id": "", "suggestion_id": id, "reason": reason}})
	for c := range t.subs {
		select {
		case c <- line:
		default:
		}
	}
}

// handleSuggestions answers the switch and the suggestion methods, and any
// topics call to an agent whose topics are off; ok is false otherwise.
func (t *Topics) handleSuggestions(method string, raw json.RawMessage) (any, *APIError, bool) {
	var p struct {
		Target       string `json:"target"`
		Enabled      *bool  `json:"enabled"`
		SuggestionID string `json:"suggestion_id"`
		// The guest a herdr guest gate acts for (omp's `by`).
		ActingGuest string `json:"acting_guest"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &APIError{Code: "invalid_params", Message: err.Error()}, true
	}
	if method == "agent.topics.set_enabled" {
		return t.setEnabled(p.Target, p.Enabled)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	suggestion := method == "agent.topics.accept_suggestion" || method == "agent.topics.dismiss_suggestion" || method == "agent.topics.organise"
	if refusal := t.Refuse[p.SuggestionID]; refusal != nil && suggestion && method != "agent.topics.organise" {
		return nil, refusal, true
	}
	switch {
	case t.off[p.Target] && suggestion:
		return nil, &APIError{Code: "topics_disabled", Message: "topics are off for this agent"}, true
	case t.off[p.Target] && method != "agent.transcript":
		return nil, &APIError{Code: "topics_unsupported", Message: "the agent runs omp without topics"}, true
	case !suggestion:
		return nil, nil, false
	case t.plain[p.Target]:
		return nil, &APIError{Code: "topics_unsupported", Message: "this omp has no topic suggestions"}, true
	}
	a := t.agent(p.Target)
	reply := func(kind string, fields map[string]any) map[string]any {
		fields["type"], fields["agent"], fields["pane_id"] = kind, "omp", p.Target
		return fields
	}
	if method == "agent.topics.organise" {
		if a.organising {
			return nil, &APIError{Code: "organise_running", Message: "an Organise turn is already running"}, true
		}
		a.organising = true
		time.AfterFunc(t.Turn, func() {
			t.mu.Lock()
			defer t.mu.Unlock()
			a.organising = false
			for _, s := range []struct{ title, reason, ids string }{
				{"Linux packaging", "The build notes are about packaging the Linux app, not the review.", "n2"},
				{"Cancellation checks", "The advisor's cancellation check is a separate piece of work.", "n3 n4"},
			} {
				t.suggestionChangedLocked(p.Target, t.suggestLocked(a, s.title, s.reason, strings.Fields(s.ids)), "suggested")
			}
		})
		return reply("agent_topics_organise_started", map[string]any{"queued": false}), nil, true
	}
	i := slices.IndexFunc(a.suggestions, func(s map[string]any) bool { return s["id"] == p.SuggestionID })
	if i < 0 {
		return nil, &APIError{Code: "suggestion_not_found", Message: "no suggestion " + p.SuggestionID}, true
	}
	s := a.suggestions[i]
	by := "owner"
	if p.ActingGuest != "" {
		by = p.ActingGuest
	}
	settle := func(state string) { s["state"], s["by"] = state, by }
	if method == "agent.topics.accept_suggestion" {
		if s["state"] == "accepted" {
			return reply("agent_topic_suggestion_accepted", map[string]any{"suggestion_id": p.SuggestionID, "topic_id": s["topic_id"], "already_accepted": true}), nil, true
		}
		title := s["title"].(string)
		id := t.newTopicLocked(p.Target, a, title, "Continue "+title+" from the Inbox.")
		settle("accepted")
		s["topic_id"] = id
		t.suggestionChangedLocked(p.Target, p.SuggestionID, "suggestion_accepted")
		return reply("agent_topic_suggestion_accepted", map[string]any{"suggestion_id": p.SuggestionID, "topic_id": id, "already_accepted": false}), nil, true
	}
	switch s["state"] {
	case "accepted":
		return nil, &APIError{Code: "already_accepted", Message: "a topic was started from it"}, true
	case "dismissed":
		return reply("agent_topic_suggestion_dismissed", map[string]any{"suggestion_id": p.SuggestionID, "already_dismissed": true}), nil, true
	}
	settle("dismissed")
	t.suggestionChangedLocked(p.Target, p.SuggestionID, "suggestion_dismissed")
	return reply("agent_topic_suggestion_dismissed", map[string]any{"suggestion_id": p.SuggestionID, "already_dismissed": false}), nil, true
}

// setEnabled is agent.topics.set_enabled: the agent restarts (SwitchDelay)
// on or off the topics build, unless it already runs that way.
func (t *Topics) setEnabled(target string, enabled *bool) (any, *APIError, bool) {
	if target == "" || enabled == nil {
		return nil, &APIError{Code: "invalid_params", Message: "target and enabled are required"}, true
	}
	t.mu.Lock()
	changed := t.off[target] == *enabled
	t.mu.Unlock()
	if changed {
		time.Sleep(t.SwitchDelay)
		t.mu.Lock()
		if *enabled {
			delete(t.off, target)
		} else {
			t.off[target] = true
		}
		t.mu.Unlock()
		if t.OnSwitch != nil {
			t.OnSwitch()
		}
	}
	return map[string]any{"type": "agent_topics_switched", "changed": changed, "topics_enabled": *enabled,
		"agent": map[string]any{"pane_id": target, "agent": "omp", "topics_enabled": *enabled}}, nil, true
}
