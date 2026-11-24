package main

import (
	"context"
	"testing"
)

// setDistribution links the build as -X main.distribution=d for one test.
func setDistribution(t *testing.T, d string) {
	t.Helper()
	old := distribution
	distribution = d
	t.Cleanup(func() { distribution = old })
}

// The Store updates its package, and its policy forbids an app updating
// itself: the Store's build neither updates itself nor reads GitHub's
// releases to offer a download, even as a release build.
func TestStoreBuildNeverChecksGitHub(t *testing.T) {
	setDistribution(t, "store")
	u := newAppUpdates()
	if _, ok := u.updater.(offUpdater); !ok {
		t.Fatalf("store build updater: %T, want offUpdater", u.updater)
	}
	u.publish = func(AppUpdateState) {}
	u.release = func() bool { return true }
	looked := false
	u.latest = func(context.Context) (string, error) { looked = true; return "9.9.9", nil }
	for _, auto := range []bool{true, false} {
		got := u.check(context.Background(), auto)
		if looked || got.Phase != "disabled" || got.Reason != storeUpdateReason || got.Newer() {
			t.Fatalf("store check (auto %v): %+v (read GitHub: %v)", auto, got, looked)
		}
	}
}

// Every other build keeps mygo's updater and its own reasons: only the
// Store's build says the Store updates it.
func TestDefaultBuildKeepsTheSelfUpdater(t *testing.T) {
	for _, d := range []string{"", "nsis"} {
		setDistribution(t, d)
		u := newAppUpdates()
		if _, ok := u.updater.(mygoUpdater); !ok {
			t.Fatalf("distribution %q: updater %T, want mygoUpdater", d, u.updater)
		}
		if reason, _ := u.reason(); reason == storeUpdateReason {
			t.Fatalf("distribution %q: reason %q", d, reason)
		}
	}
}

// The Store's package owns herdrup:// (its manifest): the Store's build
// leaves it alone, so no registration outlives the package.
func TestStoreBuildLeavesTheURLSchemeToThePackage(t *testing.T) {
	setDistribution(t, "store")
	if registersURLScheme() {
		t.Fatal("the Store's build registers herdrup:// itself")
	}
}

// Every other build has no package to declare herdrup://: it registers it.
func TestDefaultBuildRegistersTheURLScheme(t *testing.T) {
	for _, d := range []string{"", "nsis"} {
		setDistribution(t, d)
		if !registersURLScheme() {
			t.Fatalf("distribution %q: herdrup:// not registered", d)
		}
	}
}
