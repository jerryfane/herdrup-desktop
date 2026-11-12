//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

// FOLDERID_Downloads (KnownFolders.h).
var folderIDDownloads = syscall.GUID{Data1: 0x374de290, Data2: 0x123f, Data3: 0x4565, Data4: [8]byte{0x91, 0x64, 0x39, 0xc4, 0x92, 0x5e, 0x46, 0x7b}}

var (
	shGetKnownFolderPath = syscall.NewLazyDLL("shell32.dll").NewProc("SHGetKnownFolderPath")
	coTaskMemFree        = syscall.NewLazyDLL("ole32.dll").NewProc("CoTaskMemFree")
)

// downloadsFolder is the user's Downloads folder where Windows keeps it,
// moved to another drive or folder included (SHGetKnownFolderPath): mygo's
// PathDownloads is %USERPROFILE%\Downloads, which a moved folder no longer
// is (review of #162).
func downloadsFolder() (string, bool) {
	var path *uint16
	hr, _, _ := shGetKnownFolderPath.Call(uintptr(unsafe.Pointer(&folderIDDownloads)), 0, 0, uintptr(unsafe.Pointer(&path)))
	if path != nil {
		defer coTaskMemFree.Call(uintptr(unsafe.Pointer(path)))
	}
	if hr != 0 || path == nil {
		return "", false
	}
	n := 0
	for p := unsafe.Pointer(path); *(*uint16)(unsafe.Add(p, 2*n)) != 0; n++ {
	}
	return syscall.UTF16ToString(unsafe.Slice(path, n)), true
}
