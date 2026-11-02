package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

// usagePingRelay counts active installs (the guest relay's /v1/ping, contract:
// herdr-round5-20261029/usage-ping-contract.md). Nothing else is sent there.
const usagePingRelay = "https://guest.herdrup.themartian.app/v1/ping"

// usagePingTimeout keeps a slow or absent relay from holding a ping open; the
// next start or focus tries again.
const usagePingTimeout = 10 * time.Second

// usagePingURL is where pings go. HERDRUP_USAGE_PING_URL (a full endpoint URL)
// replaces the relay, the only way a smoke or reference capture sends one;
// without it those runs send nothing.
func usagePingURL() string {
	if url := os.Getenv("HERDRUP_USAGE_PING_URL"); url != "" {
		return url
	}
	if smokeEnabled() || refEnabled() {
		return ""
	}
	return usagePingRelay
}

// usagePingApp is the relay's name for this desktop platform; "" sends nothing.
func usagePingApp(goos string) string {
	switch goos {
	case "darwin":
		return "desktop-macos"
	case "linux":
		return "desktop-linux"
	case "windows":
		return "desktop-windows"
	}
	return ""
}

// The relay accepts versions and builds of at most 32 of these characters.
var usagePingField = regexp.MustCompile(`^[0-9A-Za-z._-]{1,32}$`)

// usagePingState is usage-ping.json. A missing file is the default: sharing
// on, no ID yet. Off keeps no ID.
type usagePingState struct {
	Off     bool   `json:"off,omitempty"`
	Install string `json:"install,omitempty"`
	// LastPing is the UTC date (YYYY-MM-DD) of the last ping the relay accepted.
	LastPing string `json:"lastPing,omitempty"`
}

// usagePingBody is the whole request; the field order is the contract's.
type usagePingBody struct {
	V       int    `json:"v"`
	Install string `json:"install"`
	App     string `json:"app"`
	Version string `json:"version"`
	Build   string `json:"build"`
}

// usagePing sends the anonymous daily usage count: at most one accepted ping
// per UTC day, tried when the app starts and when its window gains focus. A
// failed ping is not retried until the next of those.
type usagePing struct {
	path string
	// url is the endpoint; "" never sends (tests, smoke and reference runs).
	url string
	app string
	// version is the app version. The desktop has no separate build number:
	// its macOS bundle's CFBundleVersion is this same version, so it is also
	// the build.
	version string
	client  *http.Client
	now     func() time.Time

	mu sync.Mutex
	// cancel ends the ping in flight; nil when none is.
	cancel context.CancelFunc
}

func newUsagePing(path, app, version string) *usagePing {
	return &usagePing{path: path, app: app, version: version, client: &http.Client{Timeout: usagePingTimeout}, now: time.Now}
}

func (p *usagePing) loadLocked() (usagePingState, error) {
	var state usagePingState
	data, err := os.ReadFile(p.path)
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if err = json.Unmarshal(data, &state); err != nil {
		return state, fmt.Errorf("reading the usage count setting: %w", err)
	}
	return state, nil
}

func (p *usagePing) saveLocked(state usagePingState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(p.path), 0o700); err != nil {
		return err
	}
	tmp := p.path + ".tmp"
	if err = os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err = os.Rename(tmp, p.path); err != nil {
		_ = os.Remove(tmp)
	}
	return err
}

// newInstallID is 16 random bytes, base64url without padding: 22 characters
// not derived from anything about the device or its user.
func newInstallID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

func (p *usagePing) enabled() (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	state, err := p.loadLocked()
	return !state.Off, err
}

// setEnabled off ends a ping in flight and forgets the install ID; on starts
// with a new ID.
func (p *usagePing) setEnabled(on bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !on {
		if p.cancel != nil {
			p.cancel()
		}
		return p.saveLocked(usagePingState{Off: true})
	}
	id, err := newInstallID()
	if err != nil {
		return err
	}
	return p.saveLocked(usagePingState{Install: id})
}

// trigger pings in the background, for the window's event handlers.
func (p *usagePing) trigger() { go p.ping() }

// ping sends today's ping unless sharing is off, today's was accepted or one is
// in flight. It reports whether the relay accepted one.
func (p *usagePing) ping() bool {
	if p.url == "" || p.app == "" || !usagePingField.MatchString(p.version) {
		return false
	}
	p.mu.Lock()
	if p.cancel != nil {
		p.mu.Unlock()
		return false
	}
	state, err := p.loadLocked()
	today := p.now().UTC().Format(time.DateOnly)
	if err != nil || state.Off || state.LastPing == today {
		p.mu.Unlock()
		return false
	}
	if state.Install == "" {
		if state.Install, err = newInstallID(); err == nil {
			err = p.saveLocked(state)
		}
		if err != nil {
			p.mu.Unlock()
			return false
		}
	}
	install := state.Install
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	p.mu.Unlock()

	accepted := p.send(ctx, install) == nil

	p.mu.Lock()
	defer p.mu.Unlock()
	cancel()
	p.cancel = nil
	if !accepted {
		return false
	}
	// Switching off (or off and on) while the ping was out keeps its outcome
	// from writing over the new setting.
	if state, err = p.loadLocked(); err != nil || state.Off || state.Install != install {
		return false
	}
	state.LastPing = today
	return p.saveLocked(state) == nil
}

func (p *usagePing) send(ctx context.Context, install string) error {
	body, err := json.Marshal(usagePingBody{V: 1, Install: install, App: p.app, Version: p.version, Build: p.version})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("usage ping: %s", resp.Status)
	}
	return nil
}

// GetShareUsageCount reports the "Share anonymous usage count" switch; it
// defaults on.
func (d *Desk) GetShareUsageCount() (bool, error) { return d.usage.enabled() }

// SetShareUsageCount turns the anonymous usage count on or off. Off deletes the
// install ID and stops pings at once; on makes a new ID.
func (d *Desk) SetShareUsageCount(on bool) error { return d.usage.setEnabled(on) }
