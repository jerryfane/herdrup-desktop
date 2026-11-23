package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestStartupReport(t *testing.T) {
	if got := startupReport(30*time.Second, `{"step":"rendered","ticks":2,"visibility":"visible"}`, nil); got != "" {
		t.Errorf("a rendered page: %q, want nothing", got)
	}
	stuck := startupReport(30*time.Second, `{"step":"fonts","ticks":0,"visibility":"hidden"}`, nil)
	for _, want := range []string{"30s", `"step":"fonts"`, `"ticks":0`, `"visibility":"hidden"`} {
		if !strings.Contains(stuck, want) {
			t.Errorf("a stuck page: %q lacks %s", stuck, want)
		}
	}
	if got := startupReport(time.Minute, nil, errors.New("context deadline exceeded")); !strings.Contains(got, "didn't answer") || !strings.Contains(got, "deadline") {
		t.Errorf("a page that doesn't answer: %q", got)
	}
	if got := startupReport(time.Minute, `{"step":"fonts","fallback":"host screen"}`, nil); got == "" {
		t.Error("a fallback render is still reported")
	}
}

// Real time on purpose, in milliseconds: the watch's own deadline is the behaviour under test.
func TestStartupWatchLogsAHeldProbeAndStartsNoSecond(t *testing.T) {
	held := make(chan struct{})
	defer close(held)
	var calls atomic.Int32
	eval := func(context.Context) (any, error) { calls.Add(1); <-held; return nil, nil } // the UI thread never comes back
	var lines []string
	done := make(chan struct{})
	go func() {
		runStartupWatch(eval, time.Millisecond, 5*time.Millisecond, 3, func(v ...any) { lines = append(lines, fmt.Sprint(v...)) })
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the watch waited on the held probe instead of its own deadline")
	}
	if len(lines) != 3 {
		t.Fatalf("lines = %q, want one per tick", lines)
	}
	for _, line := range lines {
		if !strings.Contains(line, "no answer within") {
			t.Errorf("line %q doesn't say the probe went unanswered", line)
		}
	}
	if n := calls.Load(); n != 1 {
		t.Errorf("%d probes started, want one in flight at most", n)
	}
}

func TestStartupWatchStopsOnceRendered(t *testing.T) {
	var lines []string
	eval := func(context.Context) (any, error) { return `{"step":"rendered"}`, nil }
	runStartupWatch(eval, time.Millisecond, time.Second, 3, func(v ...any) { lines = append(lines, fmt.Sprint(v...)) })
	if len(lines) != 0 {
		t.Errorf("a rendered page logged %q", lines)
	}
}
