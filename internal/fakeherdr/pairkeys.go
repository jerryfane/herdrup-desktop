package fakeherdr

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
	"golang.org/x/crypto/ssh"
)

// PairKeys serves pair.add_key, pair.keys.list and pair.keys.remove as
// herdr does (jerryfane/herdr#529, merged as 35b59399: src/pairing.rs,
// src/api/server/pair_keys.rs), over an authorized_keys held in memory.
// A herdr-pair line is one whose comment has the herdr-pair marker token
// ("herdr-pair" or "herdr-pair:<label>"); every other line is the user's.
//
// pair.add_key takes a label of 1–80 characters with no control character
// (else pair_label_invalid), then one ssh-ed25519 key line (else
// pair_key_invalid). The label is stored reduced by sanitize_device_label
// and the reply carries the stored one (cut to 48 characters, so it can end
// in a space); the line written is marked_authorized_key's, the label
// trimmed. A key whose material is there already, on any line, changes
// nothing and answers added false, already true, with stored_label: a
// herdr-pair line's label, else the first line's comment as written.
//
// pair.keys.list answers the herdr-pair lines (paired_key: the label is the
// marker's text and the words after it, trimmed; the comment its words
// joined by one space), in file order; pair.keys.remove {fingerprint}
// removes the herdr-pair lines with that fingerprint and answers them ([]
// when none), never a user's line, one with the same material included.
// Guests get guest_forbidden and owner browsers owner_forbidden for each.
type PairKeys struct {
	mu    sync.Mutex
	lines []keyLine
}

// pairMarker is AUTHORIZED_KEYS_MARKER.
const pairMarker = "herdr-pair"

// keyLine is one authorized_keys line as parse_key_line reads it: key type,
// material, its fingerprint (key_fingerprint; empty when the material isn't
// base64), and the comment as written, blanks trimmed at its ends only.
type keyLine struct {
	kind, material, fingerprint, comment string
}

// PairKey is one herdr-pair key: its "<type> AAAA…" key (without options
// or comment), its label as herdr reads it back, and its OpenSSH SHA256
// fingerprint.
type PairKey struct {
	PublicKey, Label, Fingerprint string
}

// PairCaller is who sends pair.*.
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

// AddLine puts a line in authorized_keys as it would be on disk: options,
// key type, material and comment, a herdr-pair line when the comment has
// the marker. It panics on a line sshd would not read a key from.
func (p *PairKeys) AddLine(line string) {
	l, ok := parseKeyLine(line)
	if !ok {
		panic("fakeherdr: not an authorized_keys key line: " + line)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.lines = append(p.lines, l)
}

// Keys are the herdr-pair keys, in file order.
func (p *PairKeys) Keys() []PairKey {
	p.mu.Lock()
	defer p.mu.Unlock()
	var keys []PairKey
	for _, l := range p.lines {
		if info, ok := l.paired(); ok {
			keys = append(keys, PairKey{PublicKey: l.kind + " " + l.material, Label: info.Label, Fingerprint: l.fingerprint})
		}
	}
	return keys
}

// Handle answers pair.* on the owner's own connection; handled is false for
// other methods.
func (p *PairKeys) Handle(method string, raw json.RawMessage) (any, *APIError, bool) {
	return p.HandleFrom(PairOwner, method, raw)
}

// HandleFrom answers pair.* from caller.
func (p *PairKeys) HandleFrom(caller PairCaller, method string, raw json.RawMessage) (any, *APIError, bool) {
	switch method {
	case "pair.add_key", "pair.keys.list", "pair.keys.remove":
	default:
		return nil, nil, false
	}
	switch caller {
	case PairGuest:
		return nil, &APIError{Code: "guest_forbidden", Message: "guests cannot call " + method}, true
	case PairOwnerBrowser:
		return nil, &APIError{Code: "owner_forbidden", Message: "owner access cannot call " + method}, true
	}
	switch method {
	case "pair.keys.list":
		if _, e := closedParams(raw); e != nil {
			return nil, e, true
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		keys := []herdrapi.PairKeyInfo{}
		for _, l := range p.lines {
			if info, ok := l.paired(); ok {
				keys = append(keys, info)
			}
		}
		return map[string]any{"type": "pair_keys_list", "keys": keys}, nil, true
	case "pair.keys.remove":
		params, e := closedParams(raw, "fingerprint")
		if e != nil {
			return nil, e, true
		}
		fingerprint, ok := params["fingerprint"].(string)
		if !ok {
			return nil, &APIError{Code: "invalid_params", Message: "missing field `fingerprint`"}, true
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		removed := []herdrapi.PairKeyInfo{}
		p.lines = slices.DeleteFunc(p.lines, func(l keyLine) bool {
			if info, ok := l.paired(); ok && l.fingerprint == fingerprint {
				removed = append(removed, info)
				return true
			}
			return false
		})
		return map[string]any{"type": "pair_keys_removed", "removed": removed}, nil, true
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
	material, ok := ed25519Line(line)
	if !ok {
		return nil, &APIError{Code: "pair_key_invalid", Message: "expected an ssh-ed25519 key"}, true
	}
	fingerprint := keyFingerprint(material)
	stored := sanitizeDeviceLabel(label)
	reply := map[string]any{"type": "pair_key_added", "added": true, "already": false, "fingerprint": fingerprint, "label": stored}
	p.mu.Lock()
	defer p.mu.Unlock()
	if i := slices.IndexFunc(p.lines, func(l keyLine) bool { return l.material == material }); i >= 0 {
		read := p.lines[i].comment
		for _, l := range p.lines[i:] {
			if info, ok := l.paired(); ok && l.material == material {
				read = info.Label
				break
			}
		}
		reply["added"], reply["already"], reply["label"] = false, true, read
		return reply, nil, true
	}
	comment := pairMarker
	if trimmed := strings.TrimSpace(stored); trimmed != "" {
		comment += ":" + trimmed
	}
	p.lines = append(p.lines, keyLine{kind: ssh.KeyAlgoED25519, material: material, fingerprint: fingerprint, comment: comment})
	return reply, nil, true
}

// paired is l as paired_key reads it: ok when its comment has the marker
// (and its material a fingerprint), the label the marker's text and the
// words after it, trimmed, the comment its words joined by one space.
func (l keyLine) paired() (herdrapi.PairKeyInfo, bool) {
	words := strings.Fields(l.comment)
	i := slices.IndexFunc(words, func(w string) bool { return w == pairMarker || strings.HasPrefix(w, pairMarker+":") })
	if i < 0 || l.fingerprint == "" {
		return herdrapi.PairKeyInfo{}, false
	}
	first, _ := strings.CutPrefix(words[i], pairMarker+":")
	if words[i] == pairMarker {
		first = ""
	}
	label := strings.TrimSpace(strings.Join(append([]string{first}, words[i+1:]...), " "))
	return herdrapi.PairKeyInfo{Fingerprint: l.fingerprint, Label: label, Comment: strings.Join(words, " ")}, true
}

// keyFingerprint is key_fingerprint: OpenSSH's SHA256 fingerprint of the
// base64 material, empty when it isn't base64.
func keyFingerprint(material string) string {
	blob, err := base64.StdEncoding.DecodeString(material)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(blob)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

// parseKeyLine is parse_key_line, as sshd reads authorized_keys: the key
// at the start of the line, else after the options; fields are separated
// by spaces and tabs. Blank lines, # comments and lines without a key
// type and material are not key lines.
func parseKeyLine(line string) (keyLine, bool) {
	line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
	line = strings.TrimLeft(line, " \t")
	if line == "" || line[0] == '#' {
		return keyLine{}, false
	}
	key := line
	if first, _ := splitToken(line); !isKeyType(first) {
		var ok bool
		if key, ok = afterOptions(line); !ok {
			return keyLine{}, false
		}
	}
	kind, rest := splitToken(key)
	material, comment := splitToken(rest)
	if !isKeyType(kind) || material == "" {
		return keyLine{}, false
	}
	return keyLine{kind: kind, material: material, fingerprint: keyFingerprint(material),
		comment: strings.TrimRight(strings.TrimLeft(comment, " \t"), " \t\n\f\r")}, true
}

func isKeyType(token string) bool {
	return strings.HasPrefix(token, "ssh-") || strings.HasPrefix(token, "ecdsa-") || strings.HasPrefix(token, "sk-")
}

// splitToken is the first field of text (after leading blanks) and what
// follows it.
func splitToken(text string) (string, string) {
	text = strings.TrimLeft(text, " \t")
	if end := strings.IndexAny(text, " \t"); end >= 0 {
		return text[:end], text[end:]
	}
	return text, ""
}

// afterOptions is sshkey_advance_past_options: the options end at the
// first blank outside quotes; a backslash before a quote skips both. An
// unterminated quote makes the line unusable.
func afterOptions(line string) (string, bool) {
	quoted, at := false, 0
	for at < len(line) && (quoted || line[at] != ' ' && line[at] != '\t') {
		if line[at] == '\\' && at+1 < len(line) && line[at+1] == '"' {
			at++
		} else if line[at] == '"' {
			quoted = !quoted
		}
		at++
	}
	if at >= len(line) && quoted {
		return "", false
	}
	return line[min(at, len(line)):], true
}

// ed25519Line is validate_public_key_line: one line, ssh-ed25519, its
// material standard base64 of the 51-byte ed25519 wire key; a comment
// after it is allowed.
func ed25519Line(line string) (string, bool) {
	trimmed := strings.TrimSpace(line)
	if strings.ContainsAny(trimmed, "\r\n") {
		return "", false
	}
	fields := strings.Fields(trimmed)
	if len(fields) < 2 || fields[0] != ssh.KeyAlgoED25519 {
		return "", false
	}
	blob, err := base64.StdEncoding.DecodeString(fields[1])
	if err != nil || len(blob) != 51 {
		return "", false
	}
	if key, err := ssh.ParsePublicKey(blob); err != nil || key.Type() != ssh.KeyAlgoED25519 {
		return "", false
	}
	return fields[1], true
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
