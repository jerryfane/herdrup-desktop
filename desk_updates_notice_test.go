package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestNewerVersionOrdersPreviewsAndReleases(t *testing.T) {
	for _, c := range []struct {
		current, candidate string
		want               bool
	}{
		{"0.1.0-preview.9", "0.1.0-preview.12", true}, // numbers by value, not text
		{"0.1.0-preview.12", "0.1.0-preview.9", false},
		{"0.1.0-preview.12", "0.1.0-preview.12", false},
		{"0.1.0-preview.12", "v0.1.0-preview.13", true},
		{"0.1.0-preview.12", "0.1.0", true}, // the release after its previews
		{"0.1.0", "0.1.0-preview.13", false},
		{"0.1.0", "0.2.0-preview.1", true},
		{"0.9.9", "0.10.0", true},
		{"1.0.0-beta.2", "1.0.0-beta.11", true},
		{"1.0.0-beta", "1.0.0-beta.1", true},
		{"1.0.0-1", "1.0.0-alpha", true}, // numbers below words
		{"0.1.0-preview.12", "garbage", false},
		{"dev", "0.1.0", false},
	} {
		if got := newerVersion(c.current, c.candidate); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v, want %v", c.current, c.candidate, got, c.want)
		}
	}
}

// Owner 2026-11-08: an install that can't update itself (a .deb, a protected folder) was
// never told of new versions; it now hears of the latest release.
func TestAppUpdatePackageInstallHearsOfANewerRelease(t *testing.T) {
	h := newAppUpdateHarness(false)
	h.reason = func() (string, bool) { return "Installed by your package manager; update it there.", true }
	latest, latestErr, asked := "0.1.0-preview.6", error(nil), 0
	h.latest = func(context.Context) (string, error) { asked++; return latest, latestErr }
	got := h.check(context.Background(), true)
	if got.Phase != "outdated" || got.Version != "0.1.0-preview.6" || got.Reason == "" || !got.Newer() {
		t.Fatalf("a newer release reads as %+v", got)
	}
	if h.install() == nil {
		t.Fatal("an install that can't update itself started installing")
	}
	latest = "0.1.0-preview.5"
	if got = h.check(context.Background(), true); got.Phase != "disabled" || got.Version != "" || got.Newer() {
		t.Fatalf("the running version reads as %+v", got)
	}
	latest, latestErr = "", errors.New("offline")
	if got = h.check(context.Background(), true); got.Phase != "disabled" || got.Error != "" {
		t.Fatalf("an unreadable release list reads as %+v, want quietly disabled", got)
	}
	// A development build never asks GitHub.
	h.reason = func() (string, bool) { return "This build can't update itself.", false }
	before := asked
	if got = h.check(context.Background(), true); got.Phase != "disabled" || asked != before {
		t.Fatalf("a development build: %+v after %d requests", got, asked-before)
	}
}

func TestAppUpdateNoticesNewerVersionsAndWhoAsked(t *testing.T) {
	h := newAppUpdateHarness(true)
	type notice struct {
		version string
		auto    bool
	}
	var notices []notice
	h.noticed = func(s AppUpdateState, auto bool) { notices = append(notices, notice{s.Version, auto}) }
	h.check(context.Background(), true)
	h.fake.mu.Lock()
	h.fake.release = &appRelease{Version: "0.1.0-preview.6"}
	h.fake.mu.Unlock()
	h.check(context.Background(), true)
	h.check(context.Background(), false)
	want := []notice{{"0.1.0-preview.6", true}, {"0.1.0-preview.6", false}}
	if len(notices) != len(want) || notices[0] != want[0] || notices[1] != want[1] {
		t.Fatalf("notices %+v, want %+v (none while up to date)", notices, want)
	}
}

func TestAppUpdateIsAnnouncedOncePerVersionAcrossRestarts(t *testing.T) {
	dir := t.TempDir()
	d := newDesk(dir)
	if !d.markAppUpdateAnnounced("0.1.0-preview.13") {
		t.Fatal("a new version was not announced")
	}
	if d.markAppUpdateAnnounced("0.1.0-preview.13") || newDesk(dir).markAppUpdateAnnounced("0.1.0-preview.13") {
		t.Fatal("the same version was announced again")
	}
	if !newDesk(dir).markAppUpdateAnnounced("0.1.0-preview.14") {
		t.Fatal("the next version was not announced")
	}
}

// A laptop asleep past the 6 hours: a timer would wait 6 more hours of awake time; the
// check is due by the clock as soon as it wakes or the next tick comes.
func TestAppUpdateRunChecksWhenTheClockSaysItIsDue(t *testing.T) {
	h := newAppUpdateHarness(true)
	var mu sync.Mutex
	now := time.UnixMilli(1793108998000)
	h.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	advance := func(d time.Duration) { mu.Lock(); now = now.Add(d); mu.Unlock() }
	wake := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go h.run(ctx, 0, 6*time.Hour, time.Hour, wake)
	waitChecks := func(n int) {
		t.Helper()
		for deadline := time.Now().Add(5 * time.Second); h.fake.checkCount() < n; time.Sleep(time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("%d checks, want %d", h.fake.checkCount(), n)
			}
		}
	}
	waitChecks(1)
	advance(5 * time.Hour)
	wake <- struct{}{}
	time.Sleep(50 * time.Millisecond)
	if n := h.fake.checkCount(); n != 1 {
		t.Fatalf("checked %d times 5 hours after the last check", n)
	}
	advance(2 * time.Hour) // asleep through the rest
	wake <- struct{}{}
	waitChecks(2)
}

func TestTrayOffersANewerAppOnlyWhenThereIsOne(t *testing.T) {
	if got := trayToolTip(0, AppUpdateState{Phase: "upToDate"}); got != "herdrup" {
		t.Errorf("tooltip %q", got)
	}
	if got := trayToolTip(0, AppUpdateState{Phase: "available", Version: "0.1.0-preview.13"}); got != "herdrup · update available" {
		t.Errorf("tooltip %q", got)
	}
	d := newDesk(t.TempDir())
	if item := trayUpdateItem(d, nil, AppUpdateState{Phase: "upToDate"}); item != nil {
		t.Errorf("up to date offers %q", item.Label)
	}
	if item := trayUpdateItem(d, nil, AppUpdateState{Phase: "available", Version: "0.1.0-preview.13"}); item == nil || item.Label != "Update herdrup to 0.1.0-preview.13…" {
		t.Errorf("available offers %+v", item)
	}
	if item := trayUpdateItem(d, nil, AppUpdateState{Phase: "outdated", Version: "0.1.0-preview.13"}); item == nil || item.Label != "Download herdrup 0.1.0-preview.13…" {
		t.Errorf("outdated offers %+v", item)
	}
}
