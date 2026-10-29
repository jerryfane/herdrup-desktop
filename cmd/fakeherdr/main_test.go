package main

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

func agentList(t *testing.T, mode string) (any, bool) {
	t.Helper()
	handle, err := handler(mode, newAgentSet(defaultAgents).get, newWrites())
	if err != nil {
		t.Fatal(err)
	}
	if _, apiErr := handle("ping", nil); apiErr != nil {
		t.Fatalf("%s: ping: %v", mode, apiErr)
	}
	got := make(chan any, 1)
	go func() {
		v, _ := handle("agent.list", nil)
		got <- v
	}()
	select {
	case v := <-got:
		return v, true
	case <-time.After(300 * time.Millisecond):
		return nil, false
	}
}

func countAgents(t *testing.T, v any) int {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var list struct {
		Type   string            `json:"type"`
		Agents []json.RawMessage `json:"agents"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatal(err)
	}
	if list.Type != "agent_list" || list.Agents == nil {
		t.Fatalf("not an agent list: %s", raw)
	}
	return len(list.Agents)
}

func TestModes(t *testing.T) {
	v, ok := agentList(t, "populated")
	if !ok || countAgents(t, v) == 0 {
		t.Fatalf("populated: answered %v with %v", ok, v)
	}
	v, ok = agentList(t, "empty")
	if !ok || countAgents(t, v) != 0 {
		t.Fatalf("empty: answered %v with %v", ok, v)
	}
	if v, ok = agentList(t, "loading"); ok {
		t.Fatalf("loading answered agent.list with %v", v)
	}
	if _, err := handler("full", newAgentSet(defaultAgents).get, newWrites()); err == nil {
		t.Fatal("unknown mode accepted")
	}
}

func TestSampleGramsSeed(t *testing.T) {
	var fixtures []fakeherdr.GramFixture
	if err := json.Unmarshal(sampleGrams, &fixtures); err != nil {
		t.Fatal(err)
	}
	w := newWrites()
	if err := w.gram.Seed(fixtures, time.Now()); err != nil {
		t.Fatal(err)
	}
	msgs := w.gram.Messages()
	if len(msgs) != len(fixtures) || len(msgs) == 0 {
		t.Fatalf("%d messages from %d fixtures", len(msgs), len(fixtures))
	}
	var files, expired, unread int
	for i, m := range msgs {
		if i > 0 && m.CreatedUnixMs < msgs[i-1].CreatedUnixMs {
			t.Errorf("%s is older than the message before it", m.ID)
		}
		if m.File != nil {
			files++
			if m.File.Size == 0 || len(m.File.SHA256) != 64 {
				t.Errorf("%s: file %+v has no bytes", m.ID, m.File)
			}
		}
		if m.ExpiredFile != nil {
			expired++
		}
		if m.Direction == herdrapi.GramDirectionAgentToOwner && !m.ReadByOwner {
			unread++
		}
	}
	if files < 2 || expired != 1 || unread < 1 {
		t.Fatalf("files %d expired %d unread %d", files, expired, unread)
	}
	res, apiErr, _ := w.gram.Handle("gram.get_file_chunk", json.RawMessage(`{"id":"gs-06","offset":0}`))
	if apiErr != nil || res == nil {
		t.Fatalf("get_file_chunk: %v", apiErr)
	}
}
