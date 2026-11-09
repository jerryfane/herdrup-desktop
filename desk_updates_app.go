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
	// later ones run once appUpdateInterval has passed on the clock since the
	// last, which a computer asleep past it (a timer would not count the
	// sleep) makes due on waking.
	appUpdateFirstCheck = time.Minute
	appUpdateInterval   = 6 * time.Hour
	appUpdateTick       = 10 * time.Minute
	appUpdateTimeout    = time.Minute
)

// AppUpdateChanged is sent whenever the state of the app's own update
// changes: a check starts or ends, the download progresses, it installs.
var AppUpdateChanged = mygo.NewEvent[AppUpdateState]("app-update:changed")

// AppUpdateOpen asks the page to show Settings, App updates: a click on the
// update notification or the tray's update item.
var AppUpdateOpen = mygo.NewEvent[bool]("app-update:open")

// AppUpdateState is what Settings shows about updating Herdrup itself.
type AppUpdateState struct {
	// Current is the running version.
	Current string `json:"current"`
	// Phase is "disabled", "idle" (not checked yet), "checking", "upToDate",
	// "available", "failed" (the last check failed), "installing",
	// "restarting", or "outdated": a newer version is published, but this
	// install can't update itself (a package manager's, or a folder it can't
	// write), so it is downloaded from its release.
	Phase string `json:"phase"`
	// Reason says why the app cannot update itself, in "disabled" and
	// "outdated".
	Reason string `json:"reason"`
	// Version and Notes (Markdown) are the newer version's, in "available",
	// while it installs, and in "outdated" (Version only).
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

// Newer reports whether s says a newer version is out: one this app can
// install, or one its package manager or release page has.
func (s AppUpdateState) Newer() bool {
	switch s.Phase {
	case "available", "installing", "restarting", "outdated":
		return s.Version != ""
	}
	return false
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
	updater appUpdater
	current string
	// reason says why a disabled updater is disabled, and whether the app
	// is a release that only can't write where it is installed (external):
	// those still learn of newer versions, from latest.
	reason func() (reason string, external bool)
	// latest is the newest published version (latestPublishedVersion).
	latest   func(ctx context.Context) (string, error)
	publish  func(AppUpdateState)
	relaunch func()
	now      func() time.Time
	// noticed is told of each newer version a check finds, and whether the
	// check was automatic; it runs outside mu.
	noticed func(s AppUpdateState, auto bool)

	mu      sync.Mutex
	state   AppUpdateState
	release *appRelease
	watch   chan AppUpdateState
}

func newAppUpdates() *appUpdates {
	return &appUpdates{
		updater: mygoUpdater{},
		current: mygo.App.Version(),
		reason: func() (string, bool) {
			exe, _ := os.Executable()
			return appUpdateDisabledReason(runtime.GOOS, exe)
		},
		latest:   latestPublishedVersion,
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
			u.state.Phase, u.state.Reason = "disabled", u.disabledReason()
		}
	}
	return u.state
}

func (u *appUpdates) disabledReason() string {
	reason, _ := u.reason()
	return reason
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
	if u.watch != nil {
		// The newest state replaces one not read yet.
		select {
		case <-u.watch:
		default:
		}
		u.watch <- s
	}
}

// subscribe returns a channel that holds the newest state after each
// change (the tray's). Call it once, before checks start.
func (u *appUpdates) subscribe() <-chan AppUpdateState {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.watch = make(chan AppUpdateState, 1)
	return u.watch
}

func busyAppUpdate(phase string) bool {
	return phase == "checking" || phase == "installing" || phase == "restarting"
}

// check asks for a newer version, unless a check or install is running,
// and returns the state it ends in. auto is a scheduled check, not one the
// user asked for.
func (u *appUpdates) check(ctx context.Context, auto bool) AppUpdateState {
	u.mu.Lock()
	s := u.snapshotLocked()
	if busyAppUpdate(s.Phase) {
		u.mu.Unlock()
		return s
	}
	enabled := u.updater.Enabled()
	reason, external := "", false
	if !enabled {
		reason, external = u.reason()
		if !external {
			u.release = nil
			s = AppUpdateState{Current: u.current, Phase: "disabled", Reason: reason}
			u.setLocked(s)
			u.mu.Unlock()
			return s
		}
	}
	s.Phase, s.Reason, s.Error = "checking", reason, ""
	u.setLocked(s)
	u.mu.Unlock()

	ctx, cancel := context.WithTimeout(ctx, appUpdateTimeout)
	next := AppUpdateState{Current: u.current}
	var release *appRelease
	if enabled {
		var err error
		release, err = u.updater.Check(ctx)
		switch {
		case errors.Is(err, mygo.ErrUpdatesDisabled):
			next = AppUpdateState{Current: u.current, Phase: "disabled", Reason: u.disabledReason()}
		case err != nil:
			// The update found before is dropped too: it could not download now.
			next.Phase, next.Error = "failed", plainUpdateError(err)
		case release == nil:
			next.Phase = "upToDate"
		default:
			next.Phase, next.Version, next.Notes = "available", release.Version, release.Notes
		}
	} else {
		// An install that updates elsewhere: say when a newer release is out,
		// and stay quietly "disabled" when that can't be read.
		latest, err := u.latest(ctx)
		next.Phase, next.Reason = "disabled", reason
		if err == nil && newerVersion(u.current, latest) {
			next.Phase, next.Version = "outdated", latest
		}
	}
	cancel()

	u.mu.Lock()
	next.CheckedAt = u.now().UnixMilli()
	u.release = release
	u.setLocked(next)
	u.mu.Unlock()
	if next.Newer() && u.noticed != nil {
		u.noticed(next, auto)
	}
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

// due reports whether interval has passed on the clock since the last
// check ended, or none has.
func (u *appUpdates) due(interval time.Duration) bool {
	u.mu.Lock()
	checked := u.state.CheckedAt
	u.mu.Unlock()
	return checked == 0 || u.now().UnixMilli()-checked >= interval.Milliseconds()
}

// run checks first after launch, then whenever interval has passed since
// the last check, looking every tick and when the system wakes (wake)
// until ctx ends. Smoke and reference builds never check: their captures
// must not depend on GitHub, and a check could show an update in them.
func (u *appUpdates) run(ctx context.Context, first, interval, tick time.Duration, wake <-chan struct{}) {
	if smokeEnabled() {
		return
	}
	timer := time.NewTimer(first)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-timer.C:
	}
	u.check(ctx, true)
	ticker := time.NewTicker(tick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-wake:
		}
		if u.due(interval) {
			u.check(ctx, true)
		}
	}
}

// plainUpdateError drops the "mygo: " prefix of mygo.Updater's errors.
func plainUpdateError(err error) string {
	return strings.ReplaceAll(err.Error(), "mygo: ", "")
}

// appUpdateDisabledReason says why the app at exe cannot update itself,
// mirroring mygo.Updater.Enabled: it must be able to write next to its app
// bundle (macOS) or directory. Where it can, the build has no updates: a
// development build, or one made without update signing. external is an
// installed release that only can't write there (a package manager's, a
// protected folder): it still hears of newer releases.
func appUpdateDisabledReason(goos, exe string) (reason string, external bool) {
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	target := filepath.Dir(exe)
	if goos == "darwin" {
		target = filepath.Dir(filepath.Dir(filepath.Dir(exe)))
		if !strings.HasSuffix(target, ".app") {
			return "This build can't update itself.", false
		}
	}
	if probe, err := os.MkdirTemp(filepath.Dir(target), ".herdrup-update-"); err == nil {
		os.Remove(probe)
		return "This build can't update itself.", false
	}
	if goos == "linux" {
		return "Installed by your package manager; update it there.", true
	}
	return "herdrup can't write to the folder it's installed in, so it can't update itself.", true
}

// AppUpdate returns the state of the app's own update.
func (d *Desk) AppUpdate() AppUpdateState { return d.appUpdates.snapshot() }

// CheckAppUpdate checks for a newer version of the app now.
func (d *Desk) CheckAppUpdate(ctx context.Context) AppUpdateState {
	return d.appUpdates.check(ctx, false)
}

// InstallAppUpdate installs the newer version that the last check found
// and relaunches the app into it; AppUpdateChanged reports the progress.
func (d *Desk) InstallAppUpdate() error { return d.appUpdates.install() }

// openAppUpdates shows Settings, App updates in the page.
func (d *Desk) openAppUpdates() { _ = AppUpdateOpen.Broadcast(true) }

// startAppUpdateChecks follows preview releases, as every release is one
// so far, and checks for them in the background (never in smoke builds),
// also as the system wakes. A newer version found by a scheduled check is
// announced once, with a desktop notification.
func (d *Desk) startAppUpdateChecks() {
	mygo.Updater.SetPrereleases(true)
	d.appUpdates.noticed = d.noticeAppUpdate
	wake := make(chan struct{}, 1)
	mygo.Power.OnResume(func() {
		select {
		case wake <- struct{}{}:
		default:
		}
	})
	go d.appUpdates.run(context.Background(), appUpdateFirstCheck, appUpdateInterval, appUpdateTick, wake)
}
