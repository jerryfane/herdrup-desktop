package main

import (
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
