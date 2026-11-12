package pairing

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
)

func code(fp string) string {
	return fmt.Sprintf(`{"v":1,"host":"192.0.2.10","port":22,"user":"demo","token":"t","fp":%q}`, fp)
}

// Native PairingCoordinator (herdrup PR589) requires the 43-character
// OpenSSH base64 to re-encode identically, so one digest has one spelling
// and the hex pin cannot be reached through an alternate encoding.
func TestFingerprintRequiresCanonicalSpelling(t *testing.T) {
	digest := sha256.Sum256([]byte("host key"))
	canonical := base64.RawStdEncoding.EncodeToString(digest[:])
	p, err := Parse(code("SHA256:" + canonical))
	if err != nil {
		t.Fatalf("canonical fingerprint rejected: %v", err)
	}
	if p.Fingerprint != hex.EncodeToString(digest[:]) {
		t.Fatalf("pin = %s, want %x", p.Fingerprint, digest)
	}
	// The last character carries 4 data bits and 2 padding bits; set a padding bit.
	alphabet := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	last := canonical[len(canonical)-1]
	index := -1
	for i := range alphabet {
		if alphabet[i] == last {
			index = i
		}
	}
	alternate := canonical[:len(canonical)-1] + string(alphabet[index^1])
	decoded, err := base64.RawStdEncoding.DecodeString(alternate)
	if err != nil || hex.EncodeToString(decoded) != hex.EncodeToString(digest[:]) {
		t.Fatalf("test setup: %q must decode to the same digest (err %v)", alternate, err)
	}
	if _, err := Parse(code("SHA256:" + alternate)); err == nil {
		t.Fatalf("non-canonical spelling %q of the same digest was accepted", alternate)
	}
}

// The app link herdrup://pair#<base64url JSON> (agreed with herdrup iOS and
// Deimos Forge) carries the same code as the QR: every spelling a system or
// a person hands over reads as that code, and anything else is refused.
func TestAppLinkCarriesTheSameCode(t *testing.T) {
	digest := sha256.Sum256([]byte("host key"))
	fp := "SHA256:" + base64.RawStdEncoding.EncodeToString(digest[:])
	json := `{"v":1,"host":"192.0.2.10","port":2222,"user":"demo","token":"tok>>>???","fp":"` + fp + `"}`
	raw := base64.RawURLEncoding.EncodeToString([]byte(json))
	padded := base64.URLEncoding.EncodeToString([]byte(json))
	std := base64.StdEncoding.EncodeToString([]byte(json))
	if raw == padded || !strings.ContainsAny(std, "+/") {
		t.Fatalf("test setup: want padding and alphabet-specific characters (%s, %s)", padded, std)
	}
	for name, text := range map[string]string{
		"json":           json,
		"link":           "herdrup://pair#" + raw,
		"windows link":   "herdrup://pair/#" + raw,
		"padded":         "herdrup://pair#" + padded,
		"percent padded": "herdrup://pair#" + strings.ReplaceAll(padded, "=", "%3D"),
		"std alphabet":   "herdrup://pair#" + std,
		"pasted":         "  herdrup://pair#" + raw + "\n",
	} {
		p, err := Parse(text)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if p.Host != "192.0.2.10" || p.Port != 2222 || p.User != "demo" || p.token != "tok>>>???" || p.SSHFingerprint() != fp {
			t.Errorf("%s: %+v token %q fp %s", name, p, p.token, p.SSHFingerprint())
		}
	}
	for name, text := range map[string]string{
		"not base64":    "herdrup://pair#***",
		"not json":      "herdrup://pair#" + base64.RawURLEncoding.EncodeToString([]byte("hello")),
		"empty":         "herdrup://pair#",
		"guest invite":  "herdrup://guest-invite#" + raw,
		"other scheme":  "https://pair#" + raw,
		"missing token": "herdrup://pair#" + base64.RawURLEncoding.EncodeToString([]byte(strings.Replace(json, `"token":"tok>>>???",`, "", 1))),
	} {
		if p, err := Parse(text); err == nil {
			t.Errorf("%s: accepted as %v", name, p)
		}
	}
	for text, want := range map[string]bool{"herdrup://pair#x": true, "herdrup://pair/#x": true, "herdrup://guest-invite#x": false, "{}": false} {
		if _, ok := AppLink(text); ok != want {
			t.Errorf("AppLink(%q) = %v", text, ok)
		}
	}
}
