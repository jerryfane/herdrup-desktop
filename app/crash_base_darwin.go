package main

import "github.com/ebitengine/purego"

// imageBase is the main executable's Mach-O header (image 0): the start of
// its __TEXT segment.
func imageBase() (uintptr, bool) {
	lib, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_LAZY|purego.RTLD_GLOBAL)
	if err != nil {
		return 0, false
	}
	sym, err := purego.Dlsym(lib, "_dyld_get_image_header")
	if err != nil {
		return 0, false
	}
	h, _, _ := purego.SyscallN(sym, 0)
	return h, h != 0
}
