package main

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

// imageBase is where the executable's first segment (file offset 0) is mapped.
func imageBase() (uintptr, bool) {
	exe, err := os.Readlink("/proc/self/exe")
	if err != nil {
		return 0, false
	}
	f, err := os.Open("/proc/self/maps")
	if err != nil {
		return 0, false
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		// start-end perms offset dev inode path
		fields := strings.Fields(s.Text())
		if len(fields) < 6 || fields[5] != exe || fields[2] != "00000000" {
			continue
		}
		start, _, _ := strings.Cut(fields[0], "-")
		base, err := strconv.ParseUint(start, 16, 64)
		return uintptr(base), err == nil
	}
	return 0, false
}
