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

// runSmoke connects to the machine named by HERDRUP_SMOKE_* variables,
// waits for a board with agents, saves a screenshot of the window to
// HERDRUP_SMOKE_CAPTURE and quits. It exits 1 when no agent was shown.
func runSmoke(desk *Desk, win *mygo.Window) {
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
			// Give the page time to render the last event.
			time.Sleep(2 * time.Second)
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
	desk.mu.Lock()
	desk.onBoard = func(b BoardUpdate) {
		if b.Board.Total > 0 {
			go finish(true, "board with "+strconv.Itoa(b.Board.Total)+" agents")
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
