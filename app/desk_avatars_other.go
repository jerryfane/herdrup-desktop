//go:build !windows

package main

import "os"

// replaceAvatar renames tmp over dst. A Unix rename replaces a read-only
// file or a link itself, never what a link points to, so nothing is repaired
// first (#381).
func replaceAvatar(tmp, dst string) error { return os.Rename(tmp, dst) }
