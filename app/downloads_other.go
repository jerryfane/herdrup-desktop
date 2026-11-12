//go:build !windows

package main

import "github.com/egoist/mygo"

// downloadsFolder is the user's Downloads folder: ~/Downloads on macOS,
// XDG_DOWNLOAD_DIR (else ~/Downloads) on Linux.
func downloadsFolder() (string, bool) {
	dir, err := mygo.App.Path(mygo.PathDownloads)
	return dir, err == nil
}
