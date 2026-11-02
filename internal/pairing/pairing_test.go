package pairing

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
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
