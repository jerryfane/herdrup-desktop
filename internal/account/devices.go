package account

import (
	"context"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"unicode"
)

// Devices of the account (DESIGN #698 §3, AccountService src/devices.ts):
//
//	POST   /v1/devices/challenge  → {challenge_id, server_pub, salt, account_id, expires_in}
//	POST   /v1/devices            {challenge_id, device_pub, mac, name, platform} → {device}
//	GET    /v1/devices            → {devices: [Device]}
//	PATCH  /v1/devices/<id>       {name} → {device}
//	DELETE /v1/devices/<id>       → 204; the sessions bound to it end with it
//
// A device is this install's existing guest key (internal/guest Identity),
// never replaced: replacing it would sever every share it holds.

// Device is one device of the account as the service lists it.
type Device struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Platform  string `json:"platform"`
	DevicePub string `json:"device_pub"`
	CreatedMs int64  `json:"created_ms"`
	// Current is the device this session is bound to.
	Current bool `json:"current"`
}

// DeviceKey is the install's guest key: its public half, and X25519 with a
// peer's public key (an error for a low-order peer).
type DeviceKey interface {
	PublicKey() []byte
	SharedSecret(peer []byte) ([]byte, error)
}

// Challenge is POST /v1/devices/challenge's answer.
type Challenge struct {
	ChallengeID string `json:"challenge_id"`
	ServerPub   string `json:"server_pub"`
	Salt        string `json:"salt"`
	AccountID   string `json:"account_id"`
}

const (
	enrolInfo          = "herdrup account enrol v1"
	enrolMessagePrefix = "herdrup-enrol-v1|"
	// MaxDeviceName is the service's limit in characters (devices.ts).
	MaxDeviceName = 64
)

// ErrBadChallenge is a challenge whose server key or salt isn't 32 bytes, or
// whose server key is a low-order point.
var ErrBadChallenge = errors.New("account: malformed device challenge")

// EnrolProof is the device's side of §3.2: k = X25519(d, server_pub),
// mk = HKDF-SHA256(k, salt, "herdrup account enrol v1"), mac =
// HMAC-SHA256(mk, "herdrup-enrol-v1|" account_id "|" device_pub "|"
// challenge_id), keys and mac unpadded base64url. testdata/enrol-v1.json
// (the Worker's vectors) pins it.
func EnrolProof(key DeviceKey, ch Challenge) (devicePub, mac string, err error) {
	serverPub, err1 := base64.RawURLEncoding.DecodeString(ch.ServerPub)
	salt, err2 := base64.RawURLEncoding.DecodeString(ch.Salt)
	if err1 != nil || err2 != nil || len(serverPub) != 32 || len(salt) != 32 {
		return "", "", ErrBadChallenge
	}
	shared, err := key.SharedSecret(serverPub)
	if err != nil || allZero(shared) {
		return "", "", ErrBadChallenge
	}
	mk, err := hkdf.Key(sha256.New, shared, salt, enrolInfo, 32)
	if err != nil {
		return "", "", err
	}
	devicePub = base64.RawURLEncoding.EncodeToString(key.PublicKey())
	h := hmac.New(sha256.New, mk)
	h.Write([]byte(enrolMessagePrefix + ch.AccountID + "|" + devicePub + "|" + ch.ChallengeID))
	return devicePub, base64.RawURLEncoding.EncodeToString(h.Sum(nil)), nil
}

func allZero(b []byte) bool {
	for _, v := range b {
		if v != 0 {
			return false
		}
	}
	return true
}

// DeviceName is name as the service keeps it: control characters removed,
// trimmed, at most MaxDeviceName characters; "" when nothing is left.
func DeviceName(name string) string {
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name))
	if r := []rune(name); len(r) > MaxDeviceName {
		name = strings.TrimSpace(string(r[:MaxDeviceName]))
	}
	return name
}

// Enrol adds key to account acct as this device (name, platform), or binds
// this session to it when the account already has it. The challenge and the
// enrolment run in one go: a challenge is single-use and lives 60 seconds.
// The service's refusals are *APIError: device_in_other_account (409),
// session_has_device (409), too_many_devices (403).
func (c *Client) Enrol(ctx context.Context, acct string, key DeviceKey, name, platform string) (Device, error) {
	var ch Challenge
	if err := c.authed(ctx, acct, http.MethodPost, "/v1/devices/challenge", nil, &ch); err != nil {
		return Device{}, err
	}
	if ch.AccountID != acct {
		return Device{}, ErrAccountChanged
	}
	pub, mac, err := EnrolProof(key, ch)
	if err != nil {
		return Device{}, err
	}
	var out struct {
		Device Device `json:"device"`
	}
	body := map[string]string{"challenge_id": ch.ChallengeID, "device_pub": pub, "mac": mac, "name": DeviceName(name), "platform": platform}
	if err := c.authed(ctx, acct, http.MethodPost, "/v1/devices", body, &out); err != nil {
		return Device{}, err
	}
	return out.Device, nil
}

// Devices lists account acct's devices.
func (c *Client) Devices(ctx context.Context, acct string) ([]Device, error) {
	var out struct {
		Devices []Device `json:"devices"`
	}
	if err := c.authed(ctx, acct, http.MethodGet, "/v1/devices", nil, &out); err != nil {
		return nil, err
	}
	return out.Devices, nil
}

// RenameDevice renames device id of account acct.
func (c *Client) RenameDevice(ctx context.Context, acct, id, name string) (Device, error) {
	name = DeviceName(name)
	if name == "" {
		return Device{}, &APIError{Status: http.StatusBadRequest, Code: "bad_request"}
	}
	var out struct {
		Device Device `json:"device"`
	}
	if err := c.authed(ctx, acct, http.MethodPatch, "/v1/devices/"+url.PathEscape(id), map[string]string{"name": name}, &out); err != nil {
		return Device{}, err
	}
	return out.Device, nil
}

// RemoveDevice removes device id from account acct; the sessions bound to it
// end, so removing the current device signs this app out (the caller then
// forgets the session).
func (c *Client) RemoveDevice(ctx context.Context, acct, id string) error {
	return c.authed(ctx, acct, http.MethodDelete, "/v1/devices/"+url.PathEscape(id), nil, nil)
}

// RemoveThisDevice removes device id, the one this session is bound to.
// The service ends that device's sessions with it, so the session is
// forgotten here too, but only the session that asked: one signed in while
// the answer was on its way is kept, and nothing is revoked on the service.
func (c *Client) RemoveThisDevice(ctx context.Context, acct, id string) error {
	c.mu.Lock()
	epoch := c.epoch
	c.mu.Unlock()
	if err := c.RemoveDevice(ctx, acct, id); err != nil {
		return err
	}
	_, err := c.forgetIf(func() bool { return c.epoch == epoch && c.saved != nil && c.saved.AccountID == acct })
	return err
}
