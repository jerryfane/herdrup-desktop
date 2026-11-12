package main

import (
	_ "embed"
	"log"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/egoist/mygo"
)

// The tray icons are the app icon (public/herdrup/appicon.svg): in colour
// for Windows and Linux, and on macOS its mascot as a template, black
// where it is drawn and clear elsewhere, its prompt cut out, which the
// menu bar tints. Made with ImageMagick:
//
//	convert -background none -density 288 public/herdrup/appicon.svg \
//	  -crop 2296x2296+388+388 +repage -colorspace gray -level 12%,72% \
//	  -resize 64x64 mask.png
//	convert -size 64x64 xc:black mask.png -alpha off -compose CopyOpacity \
//	  -composite -define png:color-type=6 -strip trayicon/template.png
//	convert resources/icon.png -resize 64x64 -strip trayicon/color.png
var (
	//go:embed trayicon/template.png
	trayTemplate []byte
	//go:embed trayicon/color.png
	trayColor []byte
)

// AgentOpen wakes the page for a scoped notification or tray activation.
// Desk.PendingAgent retains it across window and board startup.
var AgentOpen = mygo.NewEvent[AgentTarget]("agent:open")

// A notification replaces only a prior notification for the same scoped pane.
const notificationPrefix = "needs-you/"

// installMenuBar sets the application menu: the standard App, File, Edit
// and Window menus, with their shortcuts. App is macOS's own; elsewhere
// File holds Quit. Call it before App.Run.
func installMenuBar() {
	mygo.App.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
		{Role: mygo.RoleAppMenu},
		{Role: mygo.RoleFileMenu},
		{Role: mygo.RoleEditMenu},
		{Role: mygo.RoleWindowMenu},
	}))
}

// onNotificationClick opens the agent of a clicked notification. It is
// registered before App.Run, so a click that launches the app (macOS)
// reaches it too; win is the window once it exists.
func onNotificationClick(d *Desk, win **mygo.Window) {
	mygo.App.OnNotificationClick(func(id string) {
		if strings.HasPrefix(id, appUpdateNotificationPrefix) {
			d.openAppUpdates()
			if *win != nil {
				showWindow(*win)
			}
			return
		}
		if target, ok := notificationTarget(id); ok {
			d.requestAgent(target)
			if *win != nil {
				showWindow(*win)
			}
		}
	})
}

// startPresence puts the app outside its window: a tray icon counting the
// agents that need you, with a menu to open the window or one of them, and
// a notification as an agent starts needing you. With a tray, closing the
// window hides it there; the app quits from the tray or the menu bar.
// Where the system has no tray (Linux without AppIndicator) the window
// works as before.
func startPresence(d *Desk, win *mygo.Window) {
	icon, template := trayColor, false
	if runtime.GOOS == "darwin" {
		icon, template = trayTemplate, true
	}
	tray, err := mygo.NewTray(mygo.TrayOptions{
		ID: "herdrup", Icon: icon, IconIsTemplate: template,
		ToolTip: trayToolTip(0, AppUpdateState{}), Menu: trayMenu(d, win, presenceBoard{}, AppUpdateState{}),
	})
	if err != nil {
		log.Printf("tray: %v", err)
		tray = nil
	}
	if tray != nil {
		// OnBeforeQuit and OnClose run on the main thread.
		quitting := false
		mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { quitting = true })
		win.OnClose(func(e *mygo.CloseEvent) {
			if !quitting {
				e.PreventDefault()
				win.Hide()
			}
		})
		// The Dock icon brings the hidden window back (macOS).
		mygo.App.OnActivate(func(hasVisibleWindows bool) {
			if !hasVisibleWindows {
				showWindow(win)
			}
		})
	}
	// The tray follows both the agents needing you and a newer app; mu keeps
	// the two goroutines that update it in turn.
	var mu sync.Mutex
	var board presenceBoard
	// Filled from the subscription, which starts with the current state; an
	// update found before the tray existed shows at once (review of #167).
	var update AppUpdateState
	render := func() {
		if tray == nil {
			return
		}
		if runtime.GOOS == "darwin" {
			tray.SetTitle(trayTitle(len(board.rows)))
		}
		tray.SetToolTip(trayToolTip(len(board.rows), update))
		tray.SetMenu(trayMenu(d, win, board, update))
	}
	show := func(next presenceBoard) {
		mu.Lock()
		defer mu.Unlock()
		board = next
		render()
	}
	if tray != nil {
		updates := d.appUpdates.subscribe()
		go func() {
			for s := range updates {
				mu.Lock()
				update = s
				render()
				mu.Unlock()
			}
		}()
	}
	go d.presence.serve(show, func(a attention) { go d.showAgentNotification(a) })
}

// trayTitle is the count beside the icon on macOS, none while nobody
// waits.
func trayTitle(n int) string {
	if n == 0 {
		return ""
	}
	return strconv.Itoa(n)
}

func trayToolTip(n int, update AppUpdateState) string {
	text := "herdrup"
	if n > 0 {
		text = needsYouText(n)
	}
	if update.Newer() {
		text += " · update available"
	}
	return text
}

// trayMenu opens the window, or the window on one of the agents needing
// you, offers a newer app, and quits.
func trayMenu(d *Desk, win *mygo.Window, board presenceBoard, update AppUpdateState) *mygo.Menu {
	items := []*mygo.MenuItem{{Label: "Open herdrup", Click: func(*mygo.MenuItem, *mygo.Window) { showWindow(win) }}}
	for _, r := range board.rows {
		target := AgentTarget{board.machineID, board.session, r.ID}
		items = append(items, &mygo.MenuItem{Label: r.Title, Click: func(*mygo.MenuItem, *mygo.Window) {
			d.requestAgent(target)
			showWindow(win)
		}})
	}
	if item := trayUpdateItem(d, win, update); item != nil {
		items = append(items, mygo.Separator(), item)
	}
	items = append(items, mygo.Separator(), &mygo.MenuItem{Role: mygo.RoleQuit})
	return mygo.NewMenu(items)
}

// trayUpdateItem offers a newer app: Settings, App updates, to install it,
// or its release page where this install can't update itself.
func trayUpdateItem(d *Desk, win *mygo.Window, update AppUpdateState) *mygo.MenuItem {
	if !update.Newer() {
		return nil
	}
	if update.Phase == "outdated" {
		version := update.Version
		return &mygo.MenuItem{Label: "Download herdrup " + version + "…", Click: func(*mygo.MenuItem, *mygo.Window) {
			if err := d.OpenExternalURL(appReleaseURL(version)); err != nil {
				log.Printf("tray: %v", err)
			}
		}}
	}
	return &mygo.MenuItem{Label: "Update herdrup to " + update.Version + "…", Click: func(*mygo.MenuItem, *mygo.Window) {
		d.openAppUpdates()
		showWindow(win)
	}}
}

func showWindow(win *mygo.Window) {
	if win.IsMinimized() {
		win.Restore()
	}
	win.Show()
	win.Focus()
}
