package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// formerAppName is the name the app had until it took herdrup's lower case
// (owner request 2026-11-02). mygo keeps the user data under the config
// directory by the app's name: on macOS and Windows the two names are one
// folder, on Linux two.
const formerAppName = "Herdrup"

// moveFormerUserData moves the user data kept under the former name to the
// current name's folder, where saved hosts, keys and preferences are looked
// for, when they are different folders and the current one holds nothing
// yet: mygo has already made it, empty. A current folder with anything in it
// is left as it is, and so is the former one.
func moveFormerUserData(config, current string) error {
	from, to := filepath.Join(config, formerAppName), filepath.Join(config, current)
	old, err := os.Stat(from)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil || !old.IsDir() {
		return err
	}
	if now, err := os.Stat(to); err == nil {
		if os.SameFile(old, now) {
			return nil // a file system that ignores case: one folder
		}
		entries, err := os.ReadDir(to)
		if err != nil || len(entries) > 0 {
			return err
		}
		if err := os.Remove(to); err != nil {
			return err
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.Rename(from, to)
}
