// Herdrup Desktop shows the agents of a herdr machine in a window.
package main

import (
	"log"
	"os"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/design"
)

func main() {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		log.Fatal(err)
	}
	if smokeEnabled() {
		// Test-hook runs start with no saved state: on a persistent CI
		// machine the user data would carry the previous run's pinned host
		// key (each fakeherdr has a new one) into the next. The directory is
		// in TMPDIR, which a CI runner clears after the job; the runs exit
		// with os.Exit, so a deferred removal would not run.
		if dir, err = os.MkdirTemp("", "herdrup-smoke-"); err != nil {
			log.Fatal(err)
		}
	}
	desk := newDesk(dir)
	if !smokeEnabled() {
		// Downloaded Gram files go under the user cache directory, which the
		// system may clear; smoke runs keep everything in their temp dir.
		if cache, err := mygo.App.Path(mygo.PathCache); err == nil {
			desk.cacheDir = cache
		}
	}
	mygo.Bind(desk)
	mygo.Bind(Symbols{})

	installMenuBar()
	var win *mygo.Window
	// One Herdrup at a time, so launching it again brings back the window
	// that closing hid to the tray, also where no tray icon is drawn
	// (GNOME without its AppIndicator extension). Test-hook runs may run
	// side by side and are left out.
	if !smokeEnabled() && !refEnabled() {
		if !mygo.App.RequestSingleInstanceLock() {
			return
		}
		mygo.App.OnSecondInstance(func([]string, string) {
			if win != nil {
				showWindow(win)
			}
		})
	}
	onNotificationClick(desk, &win)
	mygo.App.WhenReady(func() {
		win = mygo.NewWindow(mygo.WindowOptions{
			Title:           "Herdrup",
			Width:           960,
			Height:          680,
			MinWidth:        560,
			MinHeight:       420,
			BackgroundColor: design.ColorGround,
			StateKey:        "main",
			URL:             "/",
			// The menu bar of Linux and Windows windows stays out of the
			// way of herdrup's layout until Alt or F10; its shortcuts work.
			AutoHideMenuBar: true,
		})
		startPresence(desk, win)
		if refEnabled() {
			runRef(desk, win)
			return
		}
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
