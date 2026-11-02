package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo"
)

// fakeAppUpdater stands in for mygo.Updater: Check returns release and err
// as they are set, after block (when not nil) is closed.
type fakeAppUpdater struct {
	mu      sync.Mutex
	enabled bool
	release *appRelease
	err     error
	block   chan struct{}
	checks  int
}

func (f *fakeAppUpdater) Enabled() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.enabled
}

func (f *fakeAppUpdater) Check(ctx context.Context) (*appRelease, error) {
	f.mu.Lock()
	f.checks++
	block, release, err := f.block, f.release, f.err
	f.mu.Unlock()
	if block != nil {
		<-block
	}
	return release, err
}

func (f *fakeAppUpdater) checkCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.checks
}

type appUpdateHarness struct {
	*appUpdates
	fake      *fakeAppUpdater
	mu        sync.Mutex
	events    []AppUpdateState
	relaunchs chan struct{}
}

func newAppUpdateHarness(enabled bool) *appUpdateHarness {
	h := &appUpdateHarness{fake: &fakeAppUpdater{enabled: enabled}, relaunchs: make(chan struct{}, 1)}
	h.appUpdates = &appUpdates{
		updater: h.fake,
		current: "0.1.0-preview.5",
		reason:  func() string { return "This build can't update itself." },
		publish: func(s AppUpdateState) {
			h.mu.Lock()
			h.events = append(h.events, s)
			h.mu.Unlock()
		},
		relaunch: func() { h.relaunchs <- struct{}{} },
		now:      func() time.Time { return time.UnixMilli(1793108998000) },
	}
	return h
}

func (h *appUpdateHarness) phases() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var phases []string
	for _, e := range h.events {
		if len(phases) == 0 || phases[len(phases)-1] != e.Phase {
			phases = append(phases, e.Phase)
		}
	}
	return phases
}

// waitPhase waits for the state to reach phase, as the install goroutine
// moves it.
func (h *appUpdateHarness) waitPhase(t *testing.T, phase string) AppUpdateState {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(time.Millisecond) {
		if s := h.snapshot(); s.Phase == phase {
			return s
		}
	}
	t.Fatalf("state stayed %+v, want phase %q", h.snapshot(), phase)
	return AppUpdateState{}
}

func TestAppUpdateDisabledBuildSaysWhyAndNeverChecks(t *testing.T) {
	h := newAppUpdateHarness(false)
	want := AppUpdateState{Current: "0.1.0-preview.5", Phase: "disabled", Reason: "This build can't update itself."}
	if got := h.snapshot(); got != want {
		t.Fatalf("snapshot = %+v, want %+v", got, want)
	}
	if got := h.check(context.Background()); got != want {
		t.Fatalf("check = %+v, want %+v", got, want)
	}
	if n := h.fake.checkCount(); n != 0 {
		t.Fatalf("a disabled updater was asked %d times", n)
	}
	if err := h.install(); err == nil {
		t.Fatal("install succeeded in a build that cannot update")
	}
}

func TestAppUpdateUpToDate(t *testing.T) {
	h := newAppUpdateHarness(true)
	if got := h.snapshot(); got.Phase != "idle" {
		t.Fatalf("before any check: %+v, want idle", got)
	}
	got := h.check(context.Background())
	want := AppUpdateState{Current: "0.1.0-preview.5", Phase: "upToDate", CheckedAt: 1793108998000}
	if got != want {
		t.Fatalf("check = %+v, want %+v", got, want)
	}
	if p := strings.Join(h.phases(), ","); p != "checking,upToDate" {
		t.Fatalf("events = %s, want checking,upToDate", p)
	}
}

func TestAppUpdateCheckFailureIsPlainText(t *testing.T) {
	h := newAppUpdateHarness(true)
	h.fake.err = errors.New("mygo: checking for updates: GET https://api.github.com/repos/x/y/releases: 403 rate limit exceeded")
	got := h.check(context.Background())
	if got.Phase != "failed" || got.Error != "checking for updates: GET https://api.github.com/repos/x/y/releases: 403 rate limit exceeded" {
		t.Fatalf("check = %+v", got)
	}
	// A build whose updater says updates are off after all is disabled, not failed.
	h.fake.err = mygo.ErrUpdatesDisabled
	if got := h.check(context.Background()); got.Phase != "disabled" || got.Reason == "" {
		t.Fatalf("ErrUpdatesDisabled: %+v", got)
	}
}

func TestAppUpdateAvailableInstallsWithProgressAndRelaunches(t *testing.T) {
	h := newAppUpdateHarness(true)
	var installed bool
	h.fake.release = &appRelease{
		Version: "0.1.0-preview.6", Notes: "- Settings checks for app updates",
		Install: func(ctx context.Context, progress func(downloaded, total int64)) error {
			for done := int64(0); done <= 10_000; done += 10 {
				progress(done, 10_000)
			}
			installed = true
			return nil
		},
	}
	got := h.check(context.Background())
	if got.Phase != "available" || got.Version != "0.1.0-preview.6" || got.Notes != "- Settings checks for app updates" {
		t.Fatalf("check = %+v", got)
	}
	if err := h.install(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-h.relaunchs:
	case <-time.After(5 * time.Second):
		t.Fatal("the app did not relaunch after installing")
	}
	if !installed {
		t.Fatal("relaunched before the install finished")
	}
	if s := h.snapshot(); s.Phase != "restarting" || s.Version != "0.1.0-preview.6" {
		t.Fatalf("after install: %+v", s)
	}
	if p := strings.Join(h.phases(), ","); p != "checking,available,installing,restarting" {
		t.Fatalf("phases = %s", p)
	}
	// One progress event per percent, not one per read: 1001 callbacks.
	h.mu.Lock()
	var progress []int64
	for _, e := range h.events {
		if e.Phase == "installing" && e.Total > 0 {
			progress = append(progress, e.Downloaded)
		}
	}
	h.mu.Unlock()
	if len(progress) != 101 || progress[0] != 0 || progress[100] != 10_000 {
		t.Fatalf("progress events: %d, first %v", len(progress), progress[:min(3, len(progress))])
	}
}

func TestAppUpdateInstallFailureKeepsTheUpdate(t *testing.T) {
	h := newAppUpdateHarness(true)
	attempts := 0
	h.fake.release = &appRelease{Version: "0.1.0-preview.6", Install: func(context.Context, func(int64, int64)) error {
		attempts++
		return fmt.Errorf("mygo: installing the update: %w", errors.New("signature does not match"))
	}}
	h.check(context.Background())
	if err := h.install(); err != nil {
		t.Fatal(err)
	}
	s := h.waitPhase(t, "available")
	if s.Error != "installing the update: signature does not match" || s.Version != "0.1.0-preview.6" {
		t.Fatalf("after a failed install: %+v", s)
	}
	select {
	case <-h.relaunchs:
		t.Fatal("relaunched after a failed install")
	default:
	}
	// Update and restart again.
	if err := h.install(); err != nil {
		t.Fatalf("retry: %v", err)
	}
	h.waitPhase(t, "available")
	if attempts != 2 {
		t.Fatalf("install ran %d times, want 2", attempts)
	}
}

func TestAppUpdateFailedCheckDropsTheUpdate(t *testing.T) {
	h := newAppUpdateHarness(true)
	h.fake.release = &appRelease{Version: "0.1.0-preview.6", Install: func(context.Context, func(int64, int64)) error { return nil }}
	h.check(context.Background())
	h.fake.release, h.fake.err = nil, errors.New("offline")
	if got := h.check(context.Background()); got.Phase != "failed" || got.Version != "" {
		t.Fatalf("check = %+v", got)
	}
	if err := h.install(); err == nil {
		t.Fatal("installed an update the last check could not confirm")
	}
}

func TestAppUpdateChecksDoNotOverlap(t *testing.T) {
	h := newAppUpdateHarness(true)
	h.fake.block = make(chan struct{})
	done := make(chan AppUpdateState)
	go func() { done <- h.check(context.Background()) }()
	h.waitPhase(t, "checking")
	if got := h.check(context.Background()); got.Phase != "checking" {
		t.Fatalf("second check = %+v, want the running one's state", got)
	}
	if err := h.install(); err == nil {
		t.Fatal("install started during a check")
	}
	close(h.fake.block)
	if got := <-done; got.Phase != "upToDate" {
		t.Fatalf("first check = %+v", got)
	}
	if n := h.fake.checkCount(); n != 1 {
		t.Fatalf("updater asked %d times, want 1", n)
	}
}

func TestAppUpdateRunChecksAfterLaunchAndThenPeriodically(t *testing.T) {
	h := newAppUpdateHarness(true)
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() { h.run(ctx, 10*time.Millisecond, 5*time.Millisecond); close(stopped) }()
	if n := h.fake.checkCount(); n != 0 {
		t.Fatalf("checked %d times at once, want after the first delay", n)
	}
	for deadline := time.Now().Add(5 * time.Second); h.fake.checkCount() < 3; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("only %d checks", h.fake.checkCount())
		}
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("run kept going after its context ended")
	}
}

func TestAppUpdateRunNeverChecksInSmokeBuilds(t *testing.T) {
	old := smoke
	smoke = "1" // reference builds are smoke builds too (refEnabled)
	defer func() { smoke = old }()
	h := newAppUpdateHarness(true)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	h.run(ctx, 0, time.Millisecond)
	if n := h.fake.checkCount(); n != 0 {
		t.Fatalf("a smoke build checked for updates %d times", n)
	}
}

func TestAppUpdateDisabledReason(t *testing.T) {
	dir := t.TempDir()
	cases := []struct{ goos, exe, want string }{
		// Where it could write, the build itself has no updates.
		{"linux", filepath.Join(dir, "herdrup.app", "herdrup"), "This build can't update itself."},
		{"darwin", filepath.Join(dir, "Herdrup.app", "Contents", "MacOS", "Herdrup"), "This build can't update itself."},
		// A macOS executable outside an app bundle: a development build.
		{"darwin", "/nonexistent/bin/herdrup", "This build can't update itself."},
		// The Debian package's /opt/herdrup: its parent is not the user's.
		{"linux", "/nonexistent/opt/herdrup/herdrup", "Installed by your package manager; update it there."},
		{"darwin", "/nonexistent/Applications/Herdrup.app/Contents/MacOS/Herdrup", "Herdrup can't write to the folder it's installed in, so it can't update itself."},
		{"windows", `/nonexistent/Program Files/Herdrup/Herdrup.exe`, "Herdrup can't write to the folder it's installed in, so it can't update itself."},
	}
	for _, c := range cases {
		if got := appUpdateDisabledReason(c.goos, c.exe); got != c.want {
			t.Errorf("%s %s: %q, want %q", c.goos, c.exe, got, c.want)
		}
	}
}
