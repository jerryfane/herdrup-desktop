package fakeherdr

import (
	"encoding/json"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"golang.org/x/crypto/ssh"
)

// PairKeys serves herdr's pair.add_key (herdr-app PLAN, 26 Nov 2026): the
// owner's own connection adds an ssh-ed25519 key, labelled 1–80 printable
// characters, to authorized_keys. Adding a key that is there already
// changes nothing and answers already. Keys records what it added, in
// memory; nothing is written.
type PairKeys struct {
	mu   sync.Mutex
	keys []PairKey
}

// PairKey is one key pair.add_key added: its "ssh-ed25519 AAAA…" line,
// label and OpenSSH SHA256 fingerprint.
type PairKey struct {
	PublicKey, Label, Fingerprint string
}

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
	return p.HandleFrom(true, method, raw)
}

// HandleFrom answers pair.add_key for a caller that is the owner's own
// connection (owner) or not (a guest, an owner browser, a federation
// peer), which herdr refuses with forbidden.
func (p *PairKeys) HandleFrom(owner bool, method string, raw json.RawMessage) (any, *APIError, bool) {
	if method != "pair.add_key" {
		return nil, nil, false
	}
	if !owner {
		return nil, &APIError{Code: "forbidden", Message: "pair.add_key is for the owner's own connection"}, true
	}
	params, e := closedParams(raw, "public_key", "label")
	if e != nil {
		return nil, e, true
	}
	line, _ := params["public_key"].(string)
	label, _ := params["label"].(string)
	if strings.ContainsAny(line, "\r\n") {
		return nil, &APIError{Code: "invalid_params", Message: "public_key must be one line"}, true
	}
	key, _, _, rest, err := ssh.ParseAuthorizedKey([]byte(line))
	if err != nil || len(rest) != 0 || key.Type() != ssh.KeyAlgoED25519 {
		return nil, &APIError{Code: "invalid_params", Message: "public_key must be an ssh-ed25519 key"}, true
	}
	if n := utf8.RuneCountInString(label); n < 1 || n > 80 || strings.IndexFunc(label, func(r rune) bool { return !unicode.IsPrint(r) }) >= 0 {
		return nil, &APIError{Code: "invalid_params", Message: "label must be 1 to 80 printable characters"}, true
	}
	fingerprint := ssh.FingerprintSHA256(key)
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, k := range p.keys {
		if k.Fingerprint == fingerprint {
			return map[string]any{"type": "pair_key_added", "added": false, "already": true, "fingerprint": fingerprint, "label": k.Label}, nil, true
		}
	}
	marshalled := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
	p.keys = append(p.keys, PairKey{PublicKey: marshalled, Label: label, Fingerprint: fingerprint})
	return map[string]any{"type": "pair_key_added", "added": true, "fingerprint": fingerprint, "label": label}, nil, true
}
