//go:build !linux && !windows && !darwin

package main

// imageBase is unknown here: reports carry no stacks.
func imageBase() (uintptr, bool) { return 0, false }
