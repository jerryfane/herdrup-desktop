package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/egoist/mygo"
)

// A window that never shows its first render can't say why: on RoverOS it
// stayed on its empty bars with every process idle and no page error. The page
// keeps window.__herdrupStartup (main.ts startupStep): the startup step it is on,
// a 1 s tick count, and the fallback that rendered instead, if one did. watchStartup reads it from outside the page's timers,
// with the page's visibility, so the log says where startup stopped and whether
// WebKit still runs the page's timers.

const (
	startupWatchEvery = 30 * time.Second
	startupWatchTimes = 4
)

// startupProbe answers the page's startup marker and what WebKit says of the page.
const startupProbe = `JSON.stringify({
 ...(window.__herdrupStartup ?? { step: "no startup marker" }),
 visibility: document.visibilityState, focus: document.hasFocus(), ready: document.readyState,
 uptimeMs: Math.round(performance.now()),
})`

// startupReport is the log line for one probe answer, or "" once the page has
// rendered (nothing to say, and no more probes).
func startupReport(after time.Duration, answer any, err error) string {
	if err != nil {
		return fmt.Sprintf("startup: no first render after %s; the page didn't answer: %v", after, err)
	}
	s, _ := answer.(string)
	var m struct {
		Step string `json:"step"`
	}
	if json.Unmarshal([]byte(s), &m) == nil && m.Step == "rendered" {
		return ""
	}
	return fmt.Sprintf("startup: no first render after %s: %s", after, s)
}

// watchStartup probes the page every startupWatchEvery, startupWatchTimes at
// most, until it has rendered, and logs each probe that finds it hasn't.
func watchStartup(win *mygo.Window) {
	eval := func(ctx context.Context) (any, error) { return win.Page().EvalContext(ctx, startupProbe) }
	go runStartupWatch(eval, startupWatchEvery, startupAnswerWithin, startupWatchTimes, log.Print)
}

// startupAnswerWithin is how long a probe's answer is waited for.
const startupAnswerWithin = 5 * time.Second

// runStartupWatch probes with eval every `every`, `times` at most, until the
// page has rendered. Ticks are scheduled from one start time, and each line says
// the time measured since. Each answer is waited for on the watch's own deadline
// (within), not the evaluation's: mygo waits for the native UI thread before an
// evaluation sees its context, so a held UI thread would otherwise leave nothing
// in the log. At most one evaluation is in flight: a tick that finds the last
// one still out says so and starts none; one that comes back late only frees the
// slot, and the next tick asks the page again.
func runStartupWatch(eval func(context.Context) (any, error), every, within time.Duration, times int, logf func(...any)) {
	type result struct {
		answer any
		err    error
	}
	start := time.Now()
	var pending chan result
	for i := 1; i <= times; i++ {
		time.Sleep(time.Until(start.Add(time.Duration(i) * every)))
		if pending != nil {
			select {
			case <-pending: // answered after its deadline: stale, and the slot is free again
				pending = nil
			default:
				logf(fmt.Sprintf("startup: no first render after %s; the last probe still has no answer (the window's UI thread or the page is held)", time.Since(start).Round(time.Millisecond)))
				continue
			}
		}
		ch := make(chan result, 1)
		pending = ch
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), within)
			defer cancel()
			answer, err := eval(ctx)
			ch <- result{answer, err}
		}()
		select {
		case r := <-ch:
			pending = nil
			line := startupReport(time.Since(start).Round(time.Millisecond), r.answer, r.err)
			if line == "" {
				return
			}
			logf(line)
		case <-time.After(within):
			logf(fmt.Sprintf("startup: no first render after %s; no answer within %s (the window's UI thread or the page is held)", time.Since(start).Round(time.Millisecond), within))
		}
	}
}
