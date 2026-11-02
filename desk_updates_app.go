package main

// Herdrup Desktop updating itself from its signed GitHub releases
// (mygo.Updater; README.md, "App updates"). desk_updates.go is the other
// update: the herdr server's.

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

const (
	// The first automatic check waits for the app to settle after launch;
	// later ones run every appUpdateInterval while it runs.
	appUpdateFirstCheck = time.Minute
	appUpdateInterval   = 6 * time.Hour
	appUpdateTimeout    = time.Minute
)

// AppUpdateChanged is sent whenever the state of the app's own update
// changes: a check starts or ends, the download progresses, it installs.
var AppUpdateChanged = mygo.NewEvent[AppUpdateState]("app-update:changed")

// AppUpdateState is what Settings shows about updating Herdrup itself.
type AppUpdateState struct {
	// Current is the running version.
	Current string `json:"current"`
	// Phase is "disabled", "idle" (not checked yet), "checking", "upToDate",
	// "available", "failed" (the last check failed), "installing" or
	// "restarting".
	Phase string `json:"phase"`
	// Reason says why the app cannot update itself, in "disabled".
	Reason string `json:"reason"`
	// Version and Notes (Markdown) are the newer version's, in "available"
	// and while it installs.
	Version string `json:"version"`
	Notes   string `json:"notes"`
	// Downloaded and Total are the bytes of the download, in "installing".
	Downloaded int64 `json:"downloaded"`
	Total      int64 `json:"total"`
	// Error is why the last check ("failed") or install ("available") failed.
	Error string `json:"error"`
	// CheckedAt is when the last check ended, in Unix milliseconds; 0 for
	// never.
	CheckedAt int64 `json:"checkedAt"`
}

// appRelease is a newer version that appUpdater.Check found.
type appRelease struct {
	Version, Notes string
	Install        func(ctx context.Context, progress func(downloaded, total int64)) error
}

// appUpdater is mygo.Updater, replaced in tests.
type appUpdater interface {
	Enabled() bool
	// Check returns the newer version, or nil when the app is up to date.
	Check(ctx context.Context) (*appRelease, error)
}

type mygoUpdater struct{}

func (mygoUpdater) Enabled() bool { return mygo.Updater.Enabled() }

func (mygoUpdater) Check(ctx context.Context) (*appRelease, error) {
	up, err := mygo.Updater.Check(ctx)
	if err != nil || up == nil {
		return nil, err
	}
	return &appRelease{Version: up.Version, Notes: up.Notes, Install: up.Install}, nil
}

// appUpdates checks for and installs new versions of the app. Checks and
// installs never overlap; mu guards state and release.
type appUpdates struct {
	updater  appUpdater
	current  string
	reason   func() string // why a disabled updater is disabled
	publish  func(AppUpdateState)
	relaunch func()
	now      func() time.Time

	mu      sync.Mutex
	state   AppUpdateState
	release *appRelease
}

func newAppUpdates() *appUpdates {
	return &appUpdates{
		updater: mygoUpdater{},
		current: mygo.App.Version(),
		reason: func() string {
			exe, _ := os.Executable()
			return appUpdateDisabledReason(runtime.GOOS, exe)
		},
		publish:  func(s AppUpdateState) { _ = AppUpdateChanged.Broadcast(s) },
		relaunch: mygo.App.Relaunch,
		now:      time.Now,
	}
}

// snapshotLocked returns the state, first working out whether the app can
// update itself at all. u.mu must be held.
func (u *appUpdates) snapshotLocked() AppUpdateState {
	if u.state.Phase == "" {
		u.state = AppUpdateState{Current: u.current, Phase: "idle"}
		if !u.updater.Enabled() {
			u.state.Phase, u.state.Reason = "disabled", u.reason()
		}
	}
	return u.state
}

func (u *appUpdates) snapshot() AppUpdateState {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.snapshotLocked()
}

// setLocked publishes s as the state. u.mu must be held, which keeps the
// events in order.
func (u *appUpdates) setLocked(s AppUpdateState) {
	u.state = s
	u.publish(s)
}

func busyAppUpdate(phase string) bool {
	return phase == "checking" || phase == "installing" || phase == "restarting"
}

// check asks for a newer version, unless a check or install is running,
// and returns the state it ends in.
func (u *appUpdates) check(ctx context.Context) AppUpdateState {
	u.mu.Lock()
	s := u.snapshotLocked()
	if busyAppUpdate(s.Phase) {
		u.mu.Unlock()
		return s
	}
	if !u.updater.Enabled() {
		u.release = nil
		s = AppUpdateState{Current: u.current, Phase: "disabled", Reason: u.reason()}
		u.setLocked(s)
		u.mu.Unlock()
		return s
	}
	s.Phase, s.Reason, s.Error = "checking", "", ""
	u.setLocked(s)
	u.mu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, appUpdateTimeout)
	release, err := u.updater.Check(ctx)
	cancel()

	u.mu.Lock()
	defer u.mu.Unlock()
	next := AppUpdateState{Current: u.current, CheckedAt: u.now().UnixMilli()}
	u.release = nil
	switch {
	case errors.Is(err, mygo.ErrUpdatesDisabled):
		next = AppUpdateState{Current: u.current, Phase: "disabled", Reason: u.reason()}
	case err != nil:
		// The update found before is dropped too: it could not download now.
		next.Phase, next.Error = "failed", plainUpdateError(err)
	case release == nil:
		next.Phase = "upToDate"
	default:
		u.release = release
		next.Phase, next.Version, next.Notes = "available", release.Version, release.Notes
	}
	u.setLocked(next)
	return next
}

// install starts installing the version that the last check found, then
// relaunches the app into it. It returns at once; the state follows.
func (u *appUpdates) install() error {
	u.mu.Lock()
	defer u.mu.Unlock()
	release := u.release
	if u.state.Phase != "available" || release == nil {
		return errors.New("there is no update to install; check for updates first")
	}
	s := u.state
	s.Phase, s.Error, s.Downloaded, s.Total = "installing", "", 0, 0
	u.setLocked(s)
	go u.runInstall(release)
	return nil
}

func (u *appUpdates) runInstall(release *appRelease) {
	// The download is the user's choice: it outlives the Settings page that
	// asked for it, and ends with the app.
	lastPercent, lastBytes := -1, int64(-1)
	err := release.Install(context.Background(), func(downloaded, total int64) {
		// An event per percent, or per MiB while the size is unknown: the
		// callback runs for every read.
		percent := -1
		if total > 0 {
			percent = int(downloaded * 100 / total)
		}
		if percent >= 0 && percent == lastPercent || percent < 0 && lastBytes >= 0 && downloaded-lastBytes < 1<<20 {
			return
		}
		lastPercent, lastBytes = percent, downloaded
		u.mu.Lock()
		defer u.mu.Unlock()
		if u.state.Phase == "installing" {
			s := u.state
			s.Downloaded, s.Total = downloaded, total
			u.setLocked(s)
		}
	})
	u.mu.Lock()
	s := u.state
	if err != nil {
		s.Phase, s.Error = "available", plainUpdateError(err)
		u.setLocked(s)
		u.mu.Unlock()
		return
	}
	s.Phase = "restarting"
	u.setLocked(s)
	u.mu.Unlock()
	u.relaunch()
}

// run checks shortly after launch and then every interval until ctx ends.
// Smoke and reference builds never check: their captures must not depend on
// GitHub, and a check could show an update in them.
func (u *appUpdates) run(ctx context.Context, first, interval time.Duration) {
	if smokeEnabled() {
		return
	}
	timer := time.NewTimer(first)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		u.check(ctx)
		timer.Reset(interval)
	}
}

// plainUpdateError drops the "mygo: " prefix of mygo.Updater's errors.
func plainUpdateError(err error) string {
	return strings.ReplaceAll(err.Error(), "mygo: ", "")
}

// appUpdateDisabledReason says why the app at exe cannot update itself,
// mirroring mygo.Updater.Enabled: it must be able to write next to its app
// bundle (macOS) or directory. Where it can, the build has no updates: a
// development build, or one made without update signing.
func appUpdateDisabledReason(goos, exe string) string {
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	target := filepath.Dir(exe)
	if goos == "darwin" {
		target = filepath.Dir(filepath.Dir(filepath.Dir(exe)))
		if !strings.HasSuffix(target, ".app") {
			return "This build can't update itself."
		}
	}
	if probe, err := os.MkdirTemp(filepath.Dir(target), ".herdrup-update-"); err == nil {
		os.Remove(probe)
		return "This build can't update itself."
	}
	if goos == "linux" {
		return "Installed by your package manager; update it there."
	}
	return "Herdrup can't write to the folder it's installed in, so it can't update itself."
}

// AppUpdate returns the state of the app's own update.
func (d *Desk) AppUpdate() AppUpdateState { return d.appUpdates.snapshot() }

// CheckAppUpdate checks for a newer version of the app now.
func (d *Desk) CheckAppUpdate(ctx context.Context) AppUpdateState {
	return d.appUpdates.check(ctx)
}

// InstallAppUpdate installs the newer version that the last check found
// and relaunches the app into it; AppUpdateChanged reports the progress.
func (d *Desk) InstallAppUpdate() error { return d.appUpdates.install() }

// startAppUpdateChecks follows preview releases, as every release is one
// so far, and checks for them in the background (never in smoke builds).
func (d *Desk) startAppUpdateChecks() {
	mygo.Updater.SetPrereleases(true)
	go d.appUpdates.run(context.Background(), appUpdateFirstCheck, appUpdateInterval)
}
