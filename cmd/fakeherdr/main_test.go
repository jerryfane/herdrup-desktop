package main

import (
	"encoding/json"
	"testing"
	"time"
)

func agentList(t *testing.T, mode string) (any, bool) {
	t.Helper()
	handle, err := handler(mode, defaultAgents)
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
	if _, err := handler("full", defaultAgents); err == nil {
		t.Fatal("unknown mode accepted")
	}
}
