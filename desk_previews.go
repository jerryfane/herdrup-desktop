package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type previewPreferences struct {
	JavaScript bool `json:"javascript"`
}

// GetPreviewJavaScript defaults off. A malformed preference is an error rather
// than permission to run a received document's scripts.
func (d *Desk) GetPreviewJavaScript() (bool, error) {
	d.storeMu.Lock()
	defer d.storeMu.Unlock()
	data, err := os.ReadFile(filepath.Join(d.dir, "previews.json"))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var prefs previewPreferences
	if err = json.Unmarshal(data, &prefs); err != nil {
		return false, err
	}
	return prefs.JavaScript, nil
}

func (d *Desk) SetPreviewJavaScript(enabled bool) error {
	d.storeMu.Lock()
	defer d.storeMu.Unlock()
	data, err := json.Marshal(previewPreferences{JavaScript: enabled})
	if err != nil {
		return err
	}
	if err = os.MkdirAll(d.dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(d.dir, "previews.json")
	tmp := path + ".tmp"
	if err = os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
	}
	return err
}

func webDocument(name, mime string) bool {
	ext := strings.ToLower(filepath.Ext(strings.TrimRight(name, ". ")))
	mime, _, _ = strings.Cut(strings.ToLower(mime), ";")
	return ext == ".html" || ext == ".htm" || ext == ".svg" || mime == "text/html" || mime == "image/svg+xml" || mime == "application/xhtml+xml"
}
