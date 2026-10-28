// Herdrup Desktop shows the agents of a herdr machine in a window.
package main

import (
	"log"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/design"
)

func main() {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		log.Fatal(err)
	}
	desk := newDesk(dir)
	mygo.Bind(desk)

	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:           "Herdrup",
			Width:           960,
			Height:          680,
			MinWidth:        560,
			MinHeight:       420,
			BackgroundColor: design.ColorGround,
			StateKey:        "main",
			URL:             "/",
		})
		if smokeEnabled() {
			runSmoke(desk, win)
			return
		}
		// Reconnect to the saved machine when it logs in with a key; a
		// password is never saved, so those wait for the user.
		if m, err := desk.Machine(); err == nil && m != nil && m.KeyPath != "" {
			desk.start(*m, "")
		}
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
