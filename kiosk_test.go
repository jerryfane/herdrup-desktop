package main

import (
	"context"
	"testing"
)

// A kiosk device's system updates herdrup (rover, gitmoot 456087): RoverOS
// has a read-only root and no browser. A read-only install elsewhere reads
// GitHub's latest release and offers Download; in kiosk mode the app must
// neither update itself nor read GitHub and offer a download it couldn't open.
func TestKioskNeverChecksGitHubOrOffersADownload(t *testing.T) {
	t.Setenv("HERDRUP_KIOSK", "1")
	u := newAppUpdates()
	u.publish = func(AppUpdateState) {}
	u.release = func() bool { return true } // a release build, as on the device
	looked := false
	u.latest = func(context.Context) (string, error) { looked = true; return "9.9.9", nil }
	got := u.check(context.Background(), true)
	if looked || got.Phase != "disabled" || got.Reason != kioskUpdateReason || got.Newer() {
		t.Fatalf("kiosk check: %+v (read GitHub: %v)", got, looked)
	}
}
