package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
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
	if err := os.Rename(from, to); err != nil {
		return err
	}
	return movedKeyPaths(filepath.Join(to, "machines.json"), from, to)
}

// movedKeyPaths points the saved machines whose private key the app keeps
// in its own folder (a paired host's identities/herdr-pair-….key,
// savePairedIdentity) at the moved folder (PR #100 review). A key kept
// anywhere else is the user's and keeps its path. Unknown fields are kept:
// the file is rewritten from its own JSON, changing only keyPath values.
func movedKeyPaths(machines, from, to string) error {
	data, err := os.ReadFile(machines)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var store map[string]json.RawMessage
	if err := json.Unmarshal(data, &store); err != nil {
		return err
	}
	var list []map[string]json.RawMessage
	if raw, ok := store["machines"]; !ok || json.Unmarshal(raw, &list) != nil {
		return nil
	}
	prefix := from + string(filepath.Separator)
	changed := false
	for _, m := range list {
		var path string
		if json.Unmarshal(m["keyPath"], &path) != nil || !strings.HasPrefix(path, prefix) {
			continue
		}
		moved, _ := json.Marshal(filepath.Join(to, strings.TrimPrefix(path, prefix)))
		m["keyPath"], changed = moved, true
	}
	if !changed {
		return nil
	}
	raw, err := json.Marshal(list)
	if err != nil {
		return err
	}
	store["machines"] = raw
	out, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	tmp := machines + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, machines)
}
