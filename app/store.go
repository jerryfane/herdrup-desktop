package main

import "context"

// distribution is set to "store" only by the Microsoft Store package's build
// (MYGO_LDFLAGS="-X main.distribution=store", release.yml; README.md,
// "Microsoft Store package"). The Store installs and updates that app: it
// never updates itself or reads GitHub's releases, as Store policy requires.
var distribution string

func storeEnabled() bool { return distribution == "store" }

// storeUpdateReason is what Settings, App updates says in the Store's app.
const storeUpdateReason = "Updates come from the Microsoft Store."

// storeUpdater is the app updater of the Store's app: off.
type storeUpdater struct{}

func (storeUpdater) Enabled() bool { return false }

func (storeUpdater) Check(context.Context) (*appRelease, error) { return nil, nil }
