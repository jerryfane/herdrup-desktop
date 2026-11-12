package main

import (
	"context"
	"os"
)

// Kiosk mode: herdrup as a device's only app, e.g. RoverOS, a phone that
// boots into herdrup full screen under the cage compositor (rover, gitmoot
// 456087). HERDRUP_KIOSK=1 turns it on: the window fills the screen with no
// title bar and no minimum size (main.go), and the app never updates itself
// or offers a release download, as the device's system updates it.
func kioskEnabled() bool { return os.Getenv("HERDRUP_KIOSK") == "1" }

// kioskUpdateReason is what Settings, App updates says in kiosk mode.
const kioskUpdateReason = "Updated with the system it runs on."

// kioskUpdater is the app updater of kiosk mode: off.
type kioskUpdater struct{}

func (kioskUpdater) Enabled() bool { return false }

func (kioskUpdater) Check(context.Context) (*appRelease, error) { return nil, nil }
