// Package guest implements the authenticated guest relay protocol. Invitation
// bearer secrets stay in backend memory and are never part of saved access.
package guest

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/rivo/uniseg"
)

const AppLinkPrefix = "herdrup://guest-invite#"

// windowsAppLinkPrefix is the app link as Windows hands it to the app it
// launches: it inserts a slash before the fragment (herdrup://guest-invite/#…,
// seen from Start-Process, cmd start, explorer and rundll32 alike on Windows
// Server 2025, 2026-11-05).
const windowsAppLinkPrefix = "herdrup://guest-invite/#"

// AppLink returns text as the app link herdrup://guest-invite#<payload> when it
// is one, in either spelling, else text unchanged and false.
func AppLink(text string) (string, bool) {
	if payload, ok := strings.CutPrefix(text, windowsAppLinkPrefix); ok {
		return AppLinkPrefix + payload, true
	}
	return text, strings.HasPrefix(text, AppLinkPrefix)
}

var ErrNotInvite = errors.New("That isn't a herdr guest invitation. Open the invitation link sent by the owner.")
var ErrExpired = errors.New("This invitation has expired. Ask the owner for a new invitation.")

// ErrInviteRevoked and ErrInviteUnreachable are the native short-link failures
// as the app shows them (herdrup GuestInvite.swift:53-54, capitalised by
// GuestKeychain.swift:68-82 at f2df68b). Only ErrInviteUnreachable is worth
// retrying.
var ErrInviteRevoked = errors.New("This invite has expired or was revoked.")
var ErrInviteUnreachable = errors.New("Couldn't reach the invite server; check your connection and try again")

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
	return decodeInviteJSON(raw)
}

// decodeInviteJSON is the v1 validation every link form runs, a short link's
// opened invite included.
func decodeInviteJSON(raw []byte) (Invite, error) {
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

const (
	// A short link's last path segment: a 12-character id (9 random bytes) then a
	// 22-character key (16 random bytes), both base64url without padding.
	sealedIDLength  = 12
	sealedKeyLength = 22
	// The longest sealed invite the relay stores, and the whole fetch's deadline
	// (GuestInvite.swift:128, 182 at f2df68b).
	maxSealedInvite      = 2048
	sealedInviteDeadline = 15 * time.Second
)

// inviteLink is one link split into what it carries and, for a web link, the
// relay it points at (GuestInvite.swift:259-299 at f2df68b).
type inviteLink struct {
	// payload is the base64url v1 invite; empty for a short link.
	payload string
	// id and key name a short link's sealed invite and open it.
	id, key string
	// web is the scheme, host, port and relay path before /i; nil for the app link.
	web *url.URL
}

// linkParts preserves the native HTTPS path and legacy fragment forms. The web
// origin/path must match the relay inside its payload, not just display a link.
func linkParts(text string) (inviteLink, bool) {
	if link, ok := AppLink(text); ok {
		payload := strings.TrimPrefix(link, AppLinkPrefix)
		return inviteLink{payload: payload}, payload != ""
	}
	u, err := url.Parse(text)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery {
		return inviteLink{}, false
	}
	path := u.EscapedPath()
	payload := ""
	base := ""
	short := false
	if u.Fragment != "" {
		if !strings.HasSuffix(path, "/i") {
			return inviteLink{}, false
		}
		payload = u.EscapedFragment()
		base = strings.TrimSuffix(path, "/i")
	} else {
		marker := strings.LastIndex(path, "/i/")
		if marker < 0 {
			return inviteLink{}, false
		}
		payload = path[marker+3:]
		base = path[:marker]
		if strings.Contains(payload, "/") {
			return inviteLink{}, false
		}
		short = !strings.Contains(text, "#") && shortSegment(payload)
	}
	if payload == "" {
		return inviteLink{}, false
	}
	u.Path, _ = url.PathUnescape(base)
	u.RawPath = base
	u.Fragment = ""
	u.RawFragment = ""
	if short {
		return inviteLink{id: payload[:sealedIDLength], key: payload[sealedIDLength:], web: u}, true
	}
	return inviteLink{payload: payload, web: u}, true
}

// shortSegment is the one place that knows a short link's shape: exactly 34
// base64url characters. Anything else is the long form; a v1 payload is always
// hundreds of characters (GuestInvite.swift:353-370 at f2df68b).
func shortSegment(segment string) bool {
	if len(segment) != sealedIDLength+sealedKeyLength {
		return false
	}
	for _, c := range []byte(segment) {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// sealedURL is where the link's own relay serves its sealed invite. It carries
// the id only; the key never leaves this device.
func (l inviteLink) sealedURL() *url.URL {
	target := *l.web
	target.RawPath = l.web.EscapedPath() + "/v1/invite/" + l.id
	target.Path, _ = url.PathUnescape(target.RawPath)
	return &target
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

// admit applies the checks every link form shares after decoding: a web link
// only counts on its own invite's relay, and the invite must not have expired.
func admit(invite Invite, web *url.URL, now time.Time) error {
	if web != nil {
		relay, _ := url.Parse(invite.Endpoint.Relay)
		if !sameRelay(web, relay) {
			return ErrNotInvite
		}
	}
	if !now.Before(invite.Expires) {
		return ErrExpired
	}
	return nil
}

// candidates is the text itself, then each whitespace-separated word in it.
func candidates(text string) []string {
	trimmed := strings.TrimSpace(text)
	words := []string{trimmed}
	for word := range strings.FieldsSeq(trimmed) {
		if word != trimmed {
			words = append(words, word)
		}
	}
	return words
}

// parse reads every link form that carries its payload. A short link needs the
// network and is not an invite here (GuestInvite.swift:75-86 at f2df68b).
func parse(text string, now time.Time) (Invite, error) {
	var failure error
	for _, candidate := range candidates(text) {
		link, ok := linkParts(candidate)
		if !ok || link.payload == "" {
			continue
		}
		invite, err := decodeInvite(link.payload)
		if err == nil {
			err = admit(invite, link.web, now)
		}
		if err == nil {
			return invite, nil
		}
		if failure == nil {
			failure = err
		}
	}
	if failure == nil {
		failure = ErrNotInvite
	}
	return Invite{}, failure
}

// sealedInviteFetch returns a short link's sealed invite from target, or
// ErrInviteRevoked, ErrInviteUnreachable, ErrNotInvite or the caller's cancellation.
type sealedInviteFetch func(ctx context.Context, target *url.URL) ([]byte, error)

// Resolve reads an invitation from any link form, or from text holding one. A
// short web link's sealed invite is fetched from the link's own relay over
// transport (nil: the default), opened with the link's key, must name that
// relay, and then passes the same v1 validation as a long link
// (GuestInvite.swift:93-117 at f2df68b).
func Resolve(ctx context.Context, text string, now time.Time, transport http.RoundTripper) (Invite, error) {
	return resolve(ctx, text, now, httpSealedInviteFetch(transport, sealedInviteDeadline))
}

func resolve(ctx context.Context, text string, now time.Time, fetch sealedInviteFetch) (Invite, error) {
	for _, candidate := range candidates(text) {
		link, ok := linkParts(candidate)
		if !ok || link.payload != "" {
			continue
		}
		blob, err := fetch(ctx, link.sealedURL())
		if err != nil {
			return Invite{}, err
		}
		raw, err := openSealed(blob, link.id, link.key)
		if err != nil {
			return Invite{}, err
		}
		invite, err := decodeInviteJSON(raw)
		if err == nil {
			err = admit(invite, link.web, now)
		}
		if err != nil {
			return Invite{}, err
		}
		return invite, nil
	}
	return parse(text, now)
}

// openSealed opens a sealed invite: AES-128-GCM under the link's 16-byte key,
// laid out as nonce (12) || ciphertext || tag (16), authenticated with the
// ASCII id (GuestInvite.swift:130-141 at f2df68b).
func openSealed(blob []byte, id, key string) ([]byte, error) {
	secret, err := base64.RawURLEncoding.DecodeString(key)
	if err != nil || len(secret) != 16 || len(blob) <= 12+16 || len(blob) > maxSealedInvite {
		return nil, ErrNotInvite
	}
	block, err := aes.NewCipher(secret)
	if err != nil {
		return nil, ErrNotInvite
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrNotInvite
	}
	raw, err := aead.Open(nil, blob[:aead.NonceSize()], blob[aead.NonceSize():], []byte(id))
	if err != nil {
		return nil, ErrNotInvite
	}
	return raw, nil
}

// httpSealedInviteFetch makes one GET that stays on the link's relay (every
// redirect is refused and reads as unreachable), gets deadline for the whole
// exchange, and never reads more than one byte past maxSealedInvite: a hostile
// host cannot make the app hold more (GuestInvite.swift:150-220, 488-534 at f2df68b).
func httpSealedInviteFetch(transport http.RoundTripper, deadline time.Duration) sealedInviteFetch {
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return func(ctx context.Context, target *url.URL) ([]byte, error) {
		unreachable := func() error {
			if err := ctx.Err(); err != nil {
				return err
			}
			return ErrInviteUnreachable
		}
		fetchCtx, cancel := context.WithTimeout(ctx, deadline)
		defer cancel()
		request, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, target.String(), nil)
		if err != nil {
			return nil, ErrNotInvite
		}
		response, err := client.Do(request)
		if err != nil {
			return nil, unreachable()
		}
		defer response.Body.Close()
		switch response.StatusCode {
		case http.StatusOK:
		case http.StatusNotFound:
			return nil, ErrInviteRevoked
		default:
			return nil, ErrInviteUnreachable
		}
		if response.ContentLength > maxSealedInvite {
			return nil, ErrNotInvite
		}
		blob, err := io.ReadAll(io.LimitReader(response.Body, maxSealedInvite+1))
		if err != nil {
			return nil, unreachable()
		}
		if len(blob) > maxSealedInvite {
			return nil, ErrNotInvite
		}
		return blob, nil
	}
}
