package gramstore

import (
	"path/filepath"
	"strings"
)

// runnable are extensions the system opener would run rather than show.
// herdrup opens a Gram file in QuickLook or its own web viewer, which never
// runs anything; the desk hands files to the system opener, so a file an
// agent sent as one of these is saved, not opened.
var runnable = map[string]bool{
	// Windows
	"exe": true, "com": true, "bat": true, "cmd": true, "msi": true, "msp": true, "msix": true, "appx": true,
	"ps1": true, "psm1": true, "vbs": true, "vbe": true, "js": true, "jse": true, "wsf": true, "wsh": true,
	"scr": true, "pif": true, "lnk": true, "url": true, "hta": true, "cpl": true, "msc": true, "reg": true,
	"inf": true, "jar": true, "appref-ms": true, "application": true, "settingcontent-ms": true,
	// macOS
	"app": true, "command": true, "tool": true, "terminal": true, "pkg": true, "mpkg": true,
	"workflow": true, "scpt": true, "scptd": true, "applescript": true, "action": true,
	"fileloc": true, "inetloc": true, "webloc": true,
	// Linux and shells
	"sh": true, "bash": true, "zsh": true, "csh": true, "ksh": true, "desktop": true, "run": true,
	"appimage": true, "bin": true,
}

// Openable reports whether a file named name may be handed to the system
// opener: false for programs and scripts, which the opener would run.
func Openable(name string) bool {
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(strings.TrimRight(name, ". "))), ".")
	return !runnable[ext]
}
