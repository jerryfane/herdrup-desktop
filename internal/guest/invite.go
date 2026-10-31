// Package guest implements the authenticated guest relay protocol. Invitation
// bearer secrets stay in backend memory and are never part of saved access.
package guest

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/rivo/uniseg"
)

const AppLinkPrefix = "herdrup://guest-invite#"

var ErrNotInvite = errors.New("That isn't a herdr guest invitation. Open the invitation link sent by the owner.")
var ErrExpired = errors.New("This invitation has expired. Ask the owner for a new invitation.")

type Endpoint struct {
	Relay         string `json:"relay"`
	HostID        string `json:"hostID"`
	HostPublicKey []byte `json:"hostPublicKey"`
}

func (e Endpoint) socketURL() (string, error) {
	u, err := url.Parse(e.Relay)
	if err != nil || !validRelay(u) {
		return "", ErrNotInvite
	}
	if u.Scheme == "http" {
		u.Scheme = "ws"
	} else {
		u.Scheme = "wss"
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/v1/guest/" + e.HostID
	u.RawPath = ""
	u.RawQuery = ""
	u.ForceQuery = false
	u.Fragment = ""
	u.RawFragment = ""
	return u.String(), nil
}

type Invite struct {
	Endpoint     Endpoint
	MachineLabel string
	OwnerName    string
	AgentName    string
	GuestName    string
	Expires      time.Time
	inviteID     string
	secret       string
}

func (Invite) String() string     { return "guest invitation (bearer secret redacted)" }
func (i Invite) GoString() string { return i.String() }

func decode64(value string) ([]byte, error) {
	encoding := base64.RawURLEncoding
	if strings.ContainsAny(value, "+/") {
		encoding = base64.RawStdEncoding
	}
	if strings.Contains(value, "=") {
		if encoding == base64.RawURLEncoding {
			encoding = base64.URLEncoding
		} else {
			encoding = base64.StdEncoding
		}
	}
	return encoding.DecodeString(value)
}

func validGuestName(value string) bool {
	if len(value) < 1 || len(value) > 32 {
		return false
	}
	for index, c := range []byte(value) {
		alphanumeric := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
		if !alphanumeric && (index == 0 || c != '.' && c != '_' && c != '-') {
			return false
		}
	}
	return true
}

func validLabel(value string) bool {
	return strings.TrimSpace(value) != "" && uniseg.GraphemeClusterCount(value) <= 128 && !strings.ContainsFunc(value, func(c rune) bool { return unicode.IsControl(c) || unicode.Is(unicode.Cf, c) })
}

func validRelay(u *url.URL) bool {
	if u.Hostname() == "" {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	return u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")
}

func decodeInvite(payload string) (Invite, error) {
	raw, err := decode64(payload)
	if err != nil {
		return Invite{}, ErrNotInvite
	}
	var wire struct {
		Version       int    `json:"v"`
		Relay         string `json:"relay"`
		HostID        string `json:"host_id"`
		HostPublicKey string `json:"host_pub"`
		InviteID      string `json:"invite_id"`
		Secret        string `json:"secret"`
		MachineLabel  string `json:"machine_label"`
		OwnerName     string `json:"owner_name"`
		AgentName     string `json:"agent_name"`
		GuestName     string `json:"guest_name"`
		Expires       int64  `json:"expires_unix"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return Invite{}, ErrNotInvite
	}
	if wire.Version != 1 {
		return Invite{}, errors.New("This invitation requires another version of herdrup. Update the app and ask the owner for a new link.")
	}
	relay, err := url.Parse(wire.Relay)
	if err != nil || !validRelay(relay) {
		return Invite{}, ErrNotInvite
	}
	var public []byte
	fields := [...]struct {
		value string
		size  int
	}{{wire.HostID, 16}, {wire.HostPublicKey, 32}, {wire.InviteID, 16}, {wire.Secret, 32}}
	for index, field := range fields {
		decoded, err := decode64(field.value)
		if err != nil || len(decoded) != field.size {
			return Invite{}, ErrNotInvite
		}
		if index == 1 {
			public = decoded
		}
	}
	if !validGuestName(wire.GuestName) || !validLabel(wire.MachineLabel) || !validLabel(wire.OwnerName) || !validLabel(wire.AgentName) || wire.Expires <= 0 {
		return Invite{}, ErrNotInvite
	}
	return Invite{Endpoint: Endpoint{Relay: relay.String(), HostID: wire.HostID, HostPublicKey: public}, MachineLabel: wire.MachineLabel, OwnerName: wire.OwnerName, AgentName: wire.AgentName, GuestName: wire.GuestName, Expires: time.Unix(wire.Expires, 0), inviteID: wire.InviteID, secret: wire.Secret}, nil
}

// linkParts preserves the native HTTPS path and legacy fragment forms. The web
// origin/path must match the relay inside its payload, not just display a link.
func linkParts(text string) (string, *url.URL, bool) {
	if payload, ok := strings.CutPrefix(text, AppLinkPrefix); ok {
		return payload, nil, payload != ""
	}
	u, err := url.Parse(text)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery {
		return "", nil, false
	}
	path := u.EscapedPath()
	payload := ""
	base := ""
	if u.Fragment != "" {
		if !strings.HasSuffix(path, "/i") {
			return "", nil, false
		}
		payload = u.EscapedFragment()
		base = strings.TrimSuffix(path, "/i")
	} else {
		marker := strings.LastIndex(path, "/i/")
		if marker < 0 {
			return "", nil, false
		}
		payload = path[marker+3:]
		base = path[:marker]
		if strings.Contains(payload, "/") {
			return "", nil, false
		}
	}
	if payload == "" {
		return "", nil, false
	}
	u.Path, _ = url.PathUnescape(base)
	u.RawPath = base
	u.Fragment = ""
	u.RawFragment = ""
	return payload, u, true
}

func sameRelay(a, b *url.URL) bool {
	port := func(u *url.URL) string {
		if p := u.Port(); p != "" {
			return p
		}
		if u.Scheme == "https" {
			return "443"
		}
		return "80"
	}
	return a.Scheme == b.Scheme && strings.EqualFold(a.Hostname(), b.Hostname()) && port(a) == port(b) && strings.TrimRight(a.EscapedPath(), "/") == strings.TrimRight(b.EscapedPath(), "/")
}

func Parse(text string, now time.Time) (Invite, error) {
	trimmed := strings.TrimSpace(text)
	var failure error
	attempt := func(candidate string) (Invite, bool) {
		payload, web, ok := linkParts(candidate)
		if !ok {
			return Invite{}, false
		}
		invite, err := decodeInvite(payload)
		if err == nil && web != nil {
			relay, _ := url.Parse(invite.Endpoint.Relay)
			if !sameRelay(web, relay) {
				err = ErrNotInvite
			}
		}
		if err == nil && !now.Before(invite.Expires) {
			err = ErrExpired
		}
		if err == nil {
			return invite, true
		}
		if failure == nil {
			failure = err
		}
		return Invite{}, false
	}
	if invite, ok := attempt(trimmed); ok {
		return invite, nil
	}
	for candidate := range strings.FieldsSeq(trimmed) {
		if candidate == trimmed {
			continue
		}
		if invite, ok := attempt(candidate); ok {
			return invite, nil
		}
	}
	if failure == nil {
		failure = ErrNotInvite
	}
	return Invite{}, failure
}
