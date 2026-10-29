package main

import (
	_ "embed"
	"log"
	"runtime"
	"strconv"
	"strings"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
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

// AgentOpen asks the window to show an agent, by pane id: the tray menu's
// agents and the notifications' clicks send it.
var AgentOpen = mygo.NewEvent[string]("agent:open")

// notificationPrefix starts the ID of a needs-you notification; the pane
// id follows. A notification of a pane replaces its last one.
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
func onNotificationClick(win **mygo.Window) {
	mygo.App.OnNotificationClick(func(id string) {
		pane, ok := strings.CutPrefix(id, notificationPrefix)
		if ok && *win != nil {
			openAgent(*win, pane)
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
		ToolTip: trayToolTip(0), Menu: trayMenu(win, nil),
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
	show := func(rows []herdr.Row) {
		if tray == nil {
			return
		}
		if runtime.GOOS == "darwin" {
			tray.SetTitle(trayTitle(len(rows)))
		}
		tray.SetToolTip(trayToolTip(len(rows)))
		tray.SetMenu(trayMenu(win, rows))
	}
	go d.presence.serve(show, func(a herdrapi.AgentInfo) { go showNotification(a) })
}

// trayTitle is the count beside the icon on macOS, none while nobody
// waits.
func trayTitle(n int) string {
	if n == 0 {
		return ""
	}
	return strconv.Itoa(n)
}

func trayToolTip(n int) string {
	if n == 0 {
		return "Herdrup"
	}
	return needsYouText(n)
}

// trayMenu opens the window, or the window on one of the agents needing
// you, and quits.
func trayMenu(win *mygo.Window, rows []herdr.Row) *mygo.Menu {
	items := []*mygo.MenuItem{{Label: "Open Herdrup", Click: func(*mygo.MenuItem, *mygo.Window) { showWindow(win) }}}
	for _, r := range rows {
		id := r.ID
		items = append(items, &mygo.MenuItem{Label: r.Title, Click: func(*mygo.MenuItem, *mygo.Window) { openAgent(win, id) }})
	}
	items = append(items, mygo.Separator(), &mygo.MenuItem{Role: mygo.RoleQuit})
	return mygo.NewMenu(items)
}

func showWindow(win *mygo.Window) {
	if win.IsMinimized() {
		win.Restore()
	}
	win.Show()
	win.Focus()
}

// openAgent shows the window with the agent's row (src/main.ts).
func openAgent(win *mygo.Window, pane string) {
	showWindow(win)
	AgentOpen.Broadcast(pane)
}

// showNotification tells that a started needing you, as herdr's push
// does: "jarvis needs attention", over its row's subtitle.
func showNotification(a herdrapi.AgentInfo) {
	if !mygo.NotificationsSupported() {
		return
	}
	n := mygo.NewNotification(mygo.NotificationOptions{
		ID:    notificationPrefix + a.PaneID,
		Title: attentionTitle(a),
		Body:  herdr.Preview(a),
	})
	if err := n.Show(); err != nil {
		log.Printf("notification: %v", err)
	}
}
