package main

import (
	"log"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// smoke is set to "1" only by CI (MYGO_LDFLAGS="-X main.smoke=1"). Release
// builds have no smoke mode.
var smoke string

func smokeEnabled() bool { return smoke == "1" }

// Capture failures before the application's module starts. An empty board alone
// cannot distinguish a failed module load from a connected but empty roster.
func smokePreload() string {
	if !smokeEnabled() {
		return ""
	}
	return `window.__herdrupSmokeErrors = [];
const record = value => window.__herdrupSmokeErrors.push(String(value));
window.addEventListener("error", event => record(event.error?.stack || event.message || event.target?.src || event.target?.href || "resource error"), true);
window.addEventListener("unhandledrejection", event => record(event.reason?.stack || event.reason));`
}

// runSmoke connects to the machine named by HERDRUP_SMOKE_* variables,
// waits for a board with agents, saves a screenshot of the window to
// HERDRUP_SMOKE_CAPTURE and quits. It exits 1 when no agent was shown. A
// Windows GUI program has no stderr, so it logs to HERDRUP_SMOKE_LOG.
func runSmoke(desk *Desk, win *mygo.Window) {
	if path := os.Getenv("HERDRUP_SMOKE_LOG"); path != "" {
		if f, err := os.Create(path); err == nil {
			log.SetOutput(f)
		}
	}
	go func() {
		var last ConnState
		for range time.Tick(200 * time.Millisecond) {
			if s := desk.State(); s != last {
				log.Printf("smoke: state %+v", s)
				last = s
			}
		}
	}()
	port, _ := strconv.Atoi(os.Getenv("HERDRUP_SMOKE_PORT"))
	m := Machine{
		Host:    os.Getenv("HERDRUP_SMOKE_HOST"),
		Port:    port,
		User:    os.Getenv("HERDRUP_SMOKE_USER"),
		KeyPath: os.Getenv("HERDRUP_SMOKE_KEY"),
	}
	out := os.Getenv("HERDRUP_SMOKE_CAPTURE")
	var once sync.Once
	finish := func(ok bool, why string) {
		once.Do(func() {
			png, err := win.CapturePage()
			if err != nil {
				log.Printf("smoke: capture: %v", err)
				ok = false
			} else if err := os.WriteFile(out, png, 0o644); err != nil {
				log.Printf("smoke: write capture: %v", err)
				ok = false
			}
			log.Printf("smoke: %s (state %+v)", why, desk.State())
			if !ok {
				os.Exit(1)
			}
			mygo.App.Quit()
		})
	}
	// The board reaching Go is not the page showing it: wait until the
	// page has drawn a row for every agent in the open sections.
	pageShows := func(want int) {
		const probe = `return {rows: document.querySelectorAll(".row").length, ` +
			`text: document.body.innerText.slice(0, 300), errors: window.__herdrupSmokeErrors, ` +
			`scripts: Array.from(document.scripts, script => script.src), ready: document.readyState}`
		var last any
		for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); time.Sleep(250 * time.Millisecond) {
			v, err := win.Page().Eval(probe)
			if err != nil {
				last = err
				continue
			}
			last = v
			if m, ok := v.(map[string]any); ok {
				if n, _ := m["rows"].(float64); int(n) == want {
					// Let the browser paint the frame it just laid out.
					time.Sleep(500 * time.Millisecond)
					if err := smokePreviews(win, out); err != nil {
						finish(false, err.Error())
						return
					}
					if err := smokeTyping(win, out); err != nil {
						finish(false, err.Error())
						return
					}
					finish(true, "page shows "+strconv.Itoa(want)+" rows; preview isolation and predictive typing passed")
					return
				}
			}
		}
		log.Printf("smoke: page never showed %d rows; last probe: %v", want, last)
		finish(false, "page did not render the board")
	}
	var started sync.Once
	desk.mu.Lock()
	desk.onBoard = func(b BoardUpdate) {
		visible := 0
		for _, s := range b.Board.Sections {
			if !s.Collapsed {
				visible += len(s.Rows)
			}
		}
		if visible > 0 {
			started.Do(func() { go pageShows(visible) })
		}
	}
	desk.mu.Unlock()
	if err := desk.Connect(m, ""); err != nil {
		log.Printf("smoke: connect: %v", err)
		go finish(false, "connect failed")
		return
	}
	time.AfterFunc(90*time.Second, func() { finish(false, "timed out without a board") })
}
