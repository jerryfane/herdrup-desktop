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
	go func() {
		for i := 1; i <= startupWatchTimes; i++ {
			time.Sleep(startupWatchEvery)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			answer, err := win.Page().EvalContext(ctx, startupProbe)
			cancel()
			line := startupReport(time.Duration(i)*startupWatchEvery, answer, err)
			if line == "" {
				return
			}
			log.Print(line)
		}
	}()
}
