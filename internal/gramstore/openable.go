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
	// Windows: Microsoft's list of attachment types Outlook blocks because
	// opening them can run code (support.microsoft.com, "Blocked
	// attachments in Outlook"), plus msix and psm1.
	"ade": true, "adp": true, "apk": true, "appcontent-ms": true, "application": true,
	"appref-ms": true, "appx": true, "asp": true, "aspx": true, "asx": true, "bas": true, "bat": true,
	"bgi": true, "cab": true, "cdxml": true, "cer": true, "chm": true, "cmd": true, "cnt": true,
	"com": true, "cpl": true, "crt": true, "der": true, "diagcab": true, "exe": true, "fxp": true,
	"gadget": true, "grp": true, "hlp": true, "hpj": true, "hta": true, "htc": true, "img": true,
	"inf": true, "ins": true, "iso": true, "isp": true, "its": true, "jar": true, "jnlp": true,
	"js": true, "jse": true, "library-ms": true, "lnk": true, "mad": true, "maf": true, "mag": true,
	"mam": true, "maq": true, "mar": true, "mas": true, "mat": true, "mau": true, "mav": true,
	"maw": true, "mcf": true, "mda": true, "mdb": true, "mde": true, "mdt": true, "mdw": true,
	"mdz": true, "mht": true, "mhtml": true, "msc": true, "msh": true, "msh1": true, "msh1xml": true,
	"msh2": true, "msh2xml": true, "mshxml": true, "msi": true, "msix": true, "msp": true,
	"mst": true, "msu": true, "ops": true, "osd": true, "pcd": true, "pif": true, "pl": true,
	"plg": true, "prf": true, "prg": true, "printerexport": true, "ps1": true, "ps1xml": true,
	"ps2": true, "ps2xml": true, "psc1": true, "psc2": true, "psd1": true, "psdm1": true,
	"psm1": true, "pssc": true, "pst": true, "py": true, "pyc": true, "pyo": true, "pyw": true,
	"pyz": true, "pyzw": true, "reg": true, "scf": true, "scr": true, "sct": true, "search-ms": true,
	"settingcontent-ms": true, "shb": true, "shs": true, "theme": true, "tmp": true, "udl": true,
	"url": true, "vb": true, "vbe": true, "vbp": true, "vbs": true, "vhd": true, "vhdx": true,
	"vsmacros": true, "vsw": true, "webpnp": true, "website": true, "ws": true, "wsb": true,
	"wsc": true, "wsf": true, "wsh": true, "xbap": true, "xll": true, "xnk": true,
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
