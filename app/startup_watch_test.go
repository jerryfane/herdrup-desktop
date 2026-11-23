package main

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
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
	if !strings.Contains(lines[0], "no answer within") {
		t.Errorf("first line %q doesn't say the probe went unanswered", lines[0])
	}
	for _, line := range lines[1:] {
		if !strings.Contains(line, "still has no answer") {
			t.Errorf("line %q doesn't say the last probe is still out", line)
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

// Real time on purpose, in milliseconds: a probe answering after its deadline is the case.
func TestStartupWatchProbesAgainOnceALateAnswerFreesTheSlot(t *testing.T) {
	release := make(chan struct{})
	var calls atomic.Int32
	eval := func(context.Context) (any, error) {
		if calls.Add(1) == 1 {
			<-release // held past its deadline, then the UI thread comes back
			return `{"step":"fonts"}`, nil
		}
		return `{"step":"rendered"}`, nil
	}
	var lines []string
	done := make(chan struct{})
	go func() {
		runStartupWatch(eval, 20*time.Millisecond, 5*time.Millisecond, 5, func(v ...any) {
			lines = append(lines, fmt.Sprint(v...))
			if len(lines) == 1 {
				close(release)
			}
		})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the watch didn't finish")
	}
	if n := calls.Load(); n != 2 {
		t.Errorf("%d probes, want a second one after the late answer freed the slot", n)
	}
	for _, line := range lines {
		if strings.Contains(line, `"step":"fonts"`) {
			t.Errorf("the late answer was reported as a tick's result: %q", line)
		}
	}
}

// The bubble's fake clock (testing/synctest) makes the schedule exact.
func TestStartupWatchKeepsItsScheduleAndReportsMeasuredTime(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		begin := time.Now()
		var starts []time.Duration
		eval := func(context.Context) (any, error) {
			starts = append(starts, time.Since(begin))
			time.Sleep(15 * time.Millisecond)
			return `{"step":"fonts"}`, nil
		}
		var lines []string
		runStartupWatch(eval, 10*time.Millisecond, time.Second, 3, func(v ...any) { lines = append(lines, fmt.Sprint(v...)) })
		// Ticks at 10, 20 and 30 ms from one start: each probe starts at its tick, or at once
		// when the tick passed while the last probe was answering. A schedule that drifted (a
		// fresh wait after each probe) would start them at 10, 35 and 60 ms.
		if want := []time.Duration{10 * time.Millisecond, 25 * time.Millisecond, 40 * time.Millisecond}; !slices.Equal(starts, want) {
			t.Errorf("probes started at %v, want %v", starts, want)
		}
		for k, want := range []string{"after 25ms:", "after 40ms:", "after 55ms:"} {
			if k >= len(lines) || !strings.Contains(lines[k], want) {
				t.Errorf("line %d = %q, want the measured %q", k, lines, want)
			}
		}
	})
}
