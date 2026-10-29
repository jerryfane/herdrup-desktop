package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Changing the agents file serves the new list and tells every open event
// stream that the panes changed; a half-written file is not served.
func TestAgentsFollowTheFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agents.json")
	first := `{"type":"agent_list","agents":[]}`
	if err := os.WriteFile(path, []byte(first), 0o644); err != nil {
		t.Fatal(err)
	}
	set := newAgentSet([]byte(first))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	lines := make(chan string, 8)
	go set.events(ctx, func(line []byte) error { lines <- string(line); return nil })
	go set.follow(ctx, path, 5*time.Millisecond)
	waitUntil := func(what string, cond func() bool) {
		t.Helper()
		for deadline := time.Now().Add(5 * time.Second); !cond(); time.Sleep(5 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s", what)
			}
		}
	}
	// Let the stream subscribe before the file changes.
	waitUntil("the stream", func() bool { set.mu.Lock(); defer set.mu.Unlock(); return len(set.subs) == 1 })

	if err := os.WriteFile(path, []byte(`{"type":"agent_list","agents":[`), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if got := string(set.get()); got != first {
		t.Fatalf("served a half-written file: %s", got)
	}
	second := `{"type":"agent_list","agents":[{"pane_id":"w1:p1","agent_status":"blocked"}]}`
	if err := os.WriteFile(path, []byte(second), 0o644); err != nil {
		t.Fatal(err)
	}
	waitUntil("the new list", func() bool { return string(set.get()) == second })
	select {
	case line := <-lines:
		if !strings.Contains(line, `"event":"pane.created"`) {
			t.Errorf("stream line %s does not announce a pane change", line)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the stream was not told")
	}
}
