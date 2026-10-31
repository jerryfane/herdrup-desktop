package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPreviewJavaScriptPermissionSurvivesFailedSave(t *testing.T) {
	// The interface keeps this behavior check runnable against the prior build,
	// which has no preview permission API, for test-check's old/new proof.
	type preferences interface {
		GetPreviewJavaScript() (bool, error)
		SetPreviewJavaScript(bool) error
	}
	dir := t.TempDir()
	prefs, ok := any(&Desk{dir: dir}).(preferences)
	if !ok {
		t.Fatal("received documents have no device-local script permission control")
	}
	if enabled, err := prefs.GetPreviewJavaScript(); enabled || err != nil {
		t.Fatalf("a new device must not allow document scripts: %v, %v", enabled, err)
	}
	tmp := filepath.Join(dir, "previews.json.tmp")
	if err := os.Mkdir(tmp, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := prefs.SetPreviewJavaScript(true); err == nil {
		t.Fatal("failed permission write reported success")
	}
	if enabled, err := prefs.GetPreviewJavaScript(); enabled || err != nil {
		t.Fatalf("failed save granted script permission: %v, %v", enabled, err)
	}
	if err := os.Remove(tmp); err != nil {
		t.Fatal(err)
	}
	if err := prefs.SetPreviewJavaScript(true); err != nil {
		t.Fatal(err)
	}
	reopened := any(&Desk{dir: dir}).(preferences)
	if enabled, err := reopened.GetPreviewJavaScript(); !enabled || err != nil {
		t.Fatalf("saved permission lost on restart: %v, %v", enabled, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "previews.json"), []byte(`{"javascript":"true"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if enabled, err := reopened.GetPreviewJavaScript(); enabled || err == nil {
		t.Fatalf("malformed permission must fail closed with an error: %v, %v", enabled, err)
	}
}
