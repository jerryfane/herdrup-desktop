package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return string(b)
}

// The rename to "herdrup" must not lose the hosts, keys and preferences a
// Linux user kept under "Herdrup": mygo has already made the new, empty
// folder by the time the app looks.
func TestFormerUserDataMovesToTheNewName(t *testing.T) {
	config := t.TempDir()
	write(t, filepath.Join(config, "Herdrup", "machines.json"), `{"saved":1}`)
	write(t, filepath.Join(config, "Herdrup", "client.key"), "key")
	if err := os.MkdirAll(filepath.Join(config, "herdrup"), 0o755); err != nil {
		t.Fatal(err)
	}
	if same, err := sameDir(config); err != nil || same {
		t.Skipf("file system ignores case (%v): the names are one folder", err)
	}
	if err := moveFormerUserData(config, "herdrup"); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(config, "herdrup", "machines.json")); got != `{"saved":1}` {
		t.Errorf("hosts after the rename: %q", got)
	}
	if got := read(t, filepath.Join(config, "herdrup", "client.key")); got != "key" {
		t.Errorf("key after the rename: %q", got)
	}
	if _, err := os.Stat(filepath.Join(config, "Herdrup")); !os.IsNotExist(err) {
		t.Errorf("former folder still there: %v", err)
	}
}

// Data already under the new name wins: nothing is merged or overwritten.
func TestNewUserDataIsNeverOverwritten(t *testing.T) {
	config := t.TempDir()
	write(t, filepath.Join(config, "Herdrup", "machines.json"), "old")
	write(t, filepath.Join(config, "herdrup", "machines.json"), "new")
	if same, err := sameDir(config); err != nil || same {
		t.Skipf("file system ignores case (%v)", err)
	}
	if err := moveFormerUserData(config, "herdrup"); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(config, "herdrup", "machines.json")); got != "new" {
		t.Errorf("new data replaced: %q", got)
	}
	if got := read(t, filepath.Join(config, "Herdrup", "machines.json")); got != "old" {
		t.Errorf("former data touched: %q", got)
	}
}

func TestNoFormerUserDataIsNothingToDo(t *testing.T) {
	config := t.TempDir()
	if err := moveFormerUserData(config, "herdrup"); err != nil {
		t.Fatal(err)
	}
}

// sameDir reports whether config's file system folds case, so that
// "Herdrup" and "herdrup" name one folder.
func sameDir(config string) (bool, error) {
	probe := filepath.Join(config, "CaseProbe")
	if err := os.Mkdir(probe, 0o755); err != nil {
		return false, err
	}
	defer os.Remove(probe)
	_, err := os.Stat(filepath.Join(config, "caseprobe"))
	return err == nil, nil
}

// A paired host keeps its private key in the app's own folder and its
// absolute path in machines.json; after the move the saved host must still
// find that key (PR #100 review), while a key of the user's own keeps its
// path and every other field is kept.
func TestMovedUserDataKeepsPairedHostKeys(t *testing.T) {
	config := t.TempDir()
	if same, err := sameDir(config); err != nil || same {
		t.Skipf("file system ignores case (%v)", err)
	}
	former := filepath.Join(config, "Herdrup")
	paired := filepath.Join(former, "identities", "herdr-pair-abc.key")
	write(t, paired, "PAIRED KEY")
	own := filepath.Join(config, "elsewhere", "id_ed25519")
	store := map[string]any{
		"active": "root@100.106.218.88:22",
		"machines": []map[string]any{
			{"host": "100.106.218.88", "user": "root", "keyPath": paired, "paired": true, "nickname": "hetzner"},
			{"host": "10.0.0.2", "user": "me", "keyPath": own},
		},
	}
	data, _ := json.Marshal(store)
	write(t, filepath.Join(former, "machines.json"), string(data))
	if err := os.MkdirAll(filepath.Join(config, "herdrup"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := moveFormerUserData(config, "herdrup"); err != nil {
		t.Fatal(err)
	}
	ms, err := newDesk(filepath.Join(config, "herdrup")).Machines()
	if err != nil || len(ms) != 2 {
		t.Fatalf("saved hosts after the move: %+v, %v", ms, err)
	}
	if got := read(t, ms[0].KeyPath); got != "PAIRED KEY" {
		t.Fatalf("paired host's key after the move: %q at %s", got, ms[0].KeyPath)
	}
	if ms[0].KeyPath != filepath.Join(config, "herdrup", "identities", "herdr-pair-abc.key") || !ms[0].Paired || ms[0].Nickname != "hetzner" {
		t.Errorf("paired host after the move: %+v", ms[0].Machine)
	}
	if ms[1].KeyPath != own {
		t.Errorf("the user's own key path changed: %s", ms[1].KeyPath)
	}
}
