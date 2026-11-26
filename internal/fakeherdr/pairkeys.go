package fakeherdr

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"golang.org/x/crypto/ssh"
)

// PairKeys serves pair.add_key as herdr does (jerryfane/herdr#529,
// src/pairing.rs add_paired_key): a label of 1–80 characters with no
// control character (else pair_label_invalid), then one ssh-ed25519 key
// line (else pair_key_invalid); the label is stored reduced by
// sanitize_device_label and the reply carries the stored one. A key whose
// material is there already changes nothing and answers added false,
// already true. Guests get guest_forbidden and owner browsers
// owner_forbidden. Keys records what it added, in memory; nothing is
// written.
type PairKeys struct {
	mu   sync.Mutex
	keys []PairKey
}

// PairKey is one key pair.add_key added: its "ssh-ed25519 AAAA…" line
// (without the client's comment), stored label and OpenSSH SHA256
// fingerprint.
type PairKey struct {
	PublicKey, Label, Fingerprint string
}

// PairCaller is who sends pair.add_key.
type PairCaller int

const (
	// PairOwner is the owner's own SSH session, the only caller herdr serves.
	PairOwner PairCaller = iota
	// PairGuest is a guest's connection.
	PairGuest
	// PairOwnerBrowser is an owner browser (owner access).
	PairOwnerBrowser
)

// PongPairAddKey is a ping result that also advertises pair_add_key.
func PongPairAddKey(multi bool) map[string]any {
	p := Pong(multi)
	p["capabilities"].(map[string]bool)["pair_add_key"] = true
	return p
}

// Keys are the keys added, in order.
func (p *PairKeys) Keys() []PairKey {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]PairKey(nil), p.keys...)
}

// Handle answers pair.add_key on the owner's own connection; handled is
// false for other methods.
func (p *PairKeys) Handle(method string, raw json.RawMessage) (any, *APIError, bool) {
	return p.HandleFrom(PairOwner, method, raw)
}

// HandleFrom answers pair.add_key from caller.
func (p *PairKeys) HandleFrom(caller PairCaller, method string, raw json.RawMessage) (any, *APIError, bool) {
	if method != "pair.add_key" {
		return nil, nil, false
	}
	switch caller {
	case PairGuest:
		return nil, &APIError{Code: "guest_forbidden", Message: "guests cannot call pair.add_key"}, true
	case PairOwnerBrowser:
		return nil, &APIError{Code: "owner_forbidden", Message: "owner access cannot call pair.add_key"}, true
	}
	params, e := closedParams(raw, "public_key", "label")
	if e != nil {
		return nil, e, true
	}
	line, _ := params["public_key"].(string)
	label, _ := params["label"].(string)
	if n := utf8.RuneCountInString(label); n == 0 || n > 80 || strings.IndexFunc(label, unicode.IsControl) >= 0 {
		return nil, &APIError{Code: "pair_label_invalid", Message: "label must be 1 to 80 printable characters"}, true
	}
	key, material, ok := ed25519Line(line)
	if !ok {
		return nil, &APIError{Code: "pair_key_invalid", Message: "expected an ssh-ed25519 key"}, true
	}
	fingerprint := ssh.FingerprintSHA256(key)
	stored := sanitizeDeviceLabel(label)
	reply := map[string]any{"type": "pair_key_added", "added": true, "already": false, "fingerprint": fingerprint, "label": stored}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, k := range p.keys {
		if strings.Fields(k.PublicKey)[1] == material {
			reply["added"], reply["already"] = false, true
			return reply, nil, true
		}
	}
	p.keys = append(p.keys, PairKey{PublicKey: "ssh-ed25519 " + material, Label: stored, Fingerprint: fingerprint})
	return reply, nil, true
}

// ed25519Line is validate_public_key_line: one line, ssh-ed25519, its
// material standard base64 of the 51-byte ed25519 wire key; a comment
// after it is allowed.
func ed25519Line(line string) (ssh.PublicKey, string, bool) {
	trimmed := strings.TrimSpace(line)
	if strings.ContainsAny(trimmed, "\r\n") {
		return nil, "", false
	}
	fields := strings.Fields(trimmed)
	if len(fields) < 2 || fields[0] != ssh.KeyAlgoED25519 {
		return nil, "", false
	}
	blob, err := base64.StdEncoding.DecodeString(fields[1])
	if err != nil || len(blob) != 51 {
		return nil, "", false
	}
	key, err := ssh.ParsePublicKey(blob)
	if err != nil || key.Type() != ssh.KeyAlgoED25519 {
		return nil, "", false
	}
	return key, fields[1], true
}

// sanitizeDeviceLabel is herdr's sanitize_device_label: whitespace made
// spaces, only ASCII letters, digits and space -_.' kept, spaces collapsed
// and trimmed, at most 48 characters.
func sanitizeDeviceLabel(raw string) string {
	var b strings.Builder
	for _, r := range raw {
		if unicode.IsSpace(r) {
			r = ' '
		}
		if 'a' <= r && r <= 'z' || 'A' <= r && r <= 'Z' || '0' <= r && r <= '9' || strings.ContainsRune(" -_.'", r) {
			b.WriteRune(r)
		}
	}
	label := strings.Join(strings.Fields(b.String()), " ")
	if len(label) > 48 {
		label = label[:48]
	}
	return label
}
