package main

// Telling the owner a newer Herdrup is out without opening Settings (owner,
// 2026-11-08): a desktop notification once per version, the tray's update
// item, and the banner over the agents list (appUpdateAsk.ts). Installs that
// can't update themselves still hear of new releases from GitHub.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
)

// appReleasesRepo publishes the app (mygo.config.ts updates.github). Every
// release is marked latest, previews included (release.yml).
const appReleasesRepo = "jerryfane/herdrup-desktop"

// appUpdateNotificationPrefix starts the ID of an update notification.
const appUpdateNotificationPrefix = "app-update/"

// latestPublishedVersion is the version of the repository's latest release,
// without the tag's "v".
func latestPublishedVersion(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/repos/"+appReleasesRepo+"/releases/latest", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "herdrup/"+mygo.App.Version())
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("latest release: %s", resp.Status)
	}
	var release struct {
		Tag string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return "", err
	}
	version := strings.TrimPrefix(release.Tag, "v")
	if version == "" {
		return "", errors.New("latest release has no tag")
	}
	return version, nil
}

// appReleaseURL is the release page of version.
func appReleaseURL(version string) string {
	return "https://github.com/" + appReleasesRepo + "/releases/tag/v" + url.PathEscape(version)
}

// newerVersion reports whether candidate is a later semantic version than
// current: major.minor.patch, then a version without a pre-release above
// one with it, then pre-release fields in order, numbers by value and
// below words (0.1.0-preview.12 > 0.1.0-preview.9). A version that does not
// parse is never newer.
func newerVersion(current, candidate string) bool {
	a, okA := parseVersion(current)
	b, okB := parseVersion(candidate)
	return okA && okB && compareVersions(b, a) > 0
}

// version is a parsed semantic version. Numbers stay digit strings, without
// leading zeros, so any length compares (review of #167): by length, then
// lexically.
type version struct {
	core [3]string
	pre  []string
}

func parseVersion(s string) (version, bool) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	s, _, _ = strings.Cut(s, "+")
	core, pre, hasPre := strings.Cut(s, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return version{}, false
	}
	var v version
	for i, p := range parts {
		if !digits(p) {
			return version{}, false
		}
		v.core[i] = trimZeros(p)
	}
	if hasPre {
		if pre == "" {
			return version{}, false
		}
		v.pre = strings.Split(pre, ".")
	}
	return v, true
}

func digits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func trimZeros(s string) string {
	if t := strings.TrimLeft(s, "0"); t != "" {
		return t
	}
	return "0"
}

// cmpNumber compares two digit strings without leading zeros.
func cmpNumber(a, b string) int {
	if len(a) != len(b) {
		return cmpInt(len(a), len(b))
	}
	return strings.Compare(a, b)
}

func compareVersions(a, b version) int {
	for i := range a.core {
		if c := cmpNumber(a.core[i], b.core[i]); c != 0 {
			return c
		}
	}
	switch {
	case len(a.pre) == 0 && len(b.pre) == 0:
		return 0
	case len(a.pre) == 0:
		return 1
	case len(b.pre) == 0:
		return -1
	}
	for i := 0; i < len(a.pre) && i < len(b.pre); i++ {
		x, y := a.pre[i], b.pre[i]
		switch numX, numY := digits(x), digits(y); {
		case numX && numY:
			if c := cmpNumber(trimZeros(x), trimZeros(y)); c != 0 {
				return c
			}
		case numX:
			return -1
		case numY:
			return 1
		case x != y:
			return strings.Compare(x, y)
		}
	}
	return cmpInt(len(a.pre), len(b.pre))
}

func cmpInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// appUpdateNotice is app-update.json: the newest version announced, so each
// is announced once, across restarts.
type appUpdateNotice struct {
	Announced string `json:"announced"`
}

// noticeAppUpdate announces s's newer version once: a desktop notification
// when a scheduled check found it (a check the owner ran shows it already),
// remembered either way.
func (d *Desk) noticeAppUpdate(s AppUpdateState, auto bool) {
	if !d.markAppUpdateAnnounced(s.Version) || !auto {
		return
	}
	title, body := "herdrup "+s.Version+" is ready", "Open Settings to update and restart."
	if s.Phase == "outdated" {
		title, body = "herdrup "+s.Version+" is out", "Download it from its release page."
	}
	options := mygo.NotificationOptions{ID: appUpdateNotificationPrefix + s.Version, Title: title, Body: body}
	if err := d.deliverNotification("appUpdate", options); err != nil {
		log.Printf("notification: %v", err)
	}
}

// markAppUpdateAnnounced records version as announced and reports whether
// it was not before.
func (d *Desk) markAppUpdateAnnounced(version string) bool {
	d.storeMu.Lock()
	defer d.storeMu.Unlock()
	path := filepath.Join(d.dir, "app-update.json")
	var notice appUpdateNotice
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &notice)
	}
	if notice.Announced == version {
		return false
	}
	notice.Announced = version
	data, err := json.Marshal(notice)
	if err == nil && os.MkdirAll(d.dir, 0o700) == nil {
		tmp := path + ".tmp"
		if err = os.WriteFile(tmp, data, 0o600); err == nil {
			err = os.Rename(tmp, path)
		}
	}
	if err != nil {
		// Announce it anyway: a notification again later beats none.
		log.Printf("app update notice: %v", err)
	}
	return true
}
