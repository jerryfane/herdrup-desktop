package main

import (
	_ "embed"
	"log"
	"runtime"
	"strconv"

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
		ToolTip: trayToolTip(0), Menu: trayMenu(d, win, presenceBoard{}),
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
	show := func(board presenceBoard) {
		rows := board.rows
		if tray == nil {
			return
		}
		if runtime.GOOS == "darwin" {
			tray.SetTitle(trayTitle(len(rows)))
		}
		tray.SetToolTip(trayToolTip(len(rows)))
		tray.SetMenu(trayMenu(d, win, board))
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

func trayToolTip(n int) string {
	if n == 0 {
		return "Herdrup"
	}
	return needsYouText(n)
}

// trayMenu opens the window, or the window on one of the agents needing
// you, and quits.
func trayMenu(d *Desk, win *mygo.Window, board presenceBoard) *mygo.Menu {
	items := []*mygo.MenuItem{{Label: "Open Herdrup", Click: func(*mygo.MenuItem, *mygo.Window) { showWindow(win) }}}
	for _, r := range board.rows {
		target := AgentTarget{board.machineID, board.session, r.ID}
		items = append(items, &mygo.MenuItem{Label: r.Title, Click: func(*mygo.MenuItem, *mygo.Window) {
			d.requestAgent(target)
			showWindow(win)
		}})
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
