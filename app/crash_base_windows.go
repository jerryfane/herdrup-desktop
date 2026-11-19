package main

import "syscall"

// imageBase is the executable's module handle: where its image is loaded.
func imageBase() (uintptr, bool) {
	h, _, _ := syscall.NewLazyDLL("kernel32.dll").NewProc("GetModuleHandleW").Call(0)
	return h, h != 0
}
