package main

// distribution is set to "store" only by the Microsoft Store package's build
// (MYGO_LDFLAGS="-X main.distribution=store", release.yml; README.md,
// "Microsoft Store package"). The Store installs and updates that app: it
// never updates itself or reads GitHub's releases (offUpdater), as Store
// policy requires.
var distribution string

func storeEnabled() bool { return distribution == "store" }

// storeUpdateReason is what Settings, App updates says in the Store's app.
const storeUpdateReason = "Updates come from the Microsoft Store."

// registersURLScheme reports whether the app registers herdrup:// for the
// user as it starts. The Store's package declares the scheme in its
// manifest (packaging/msix/AppxManifest.xml), which Windows registers with
// the package and removes with it; a registration of the app's own would
// outlive an uninstall, pointing at a folder that is gone.
func registersURLScheme() bool { return !storeEnabled() }
