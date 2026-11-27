package pairing

import (
	"bytes"
	"crypto/ed25519"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestNewPairKeyIsOneEd25519KeyInEveryForm(t *testing.T) {
	k, err := NewPairKey("Studio PC")
	if err != nil {
		t.Fatal(err)
	}
	if len(k.Public) != ed25519.PublicKeySize || len(strings.Fields(k.PublicLine)) != 2 {
		t.Fatalf("public %x, line %q", k.Public, k.PublicLine)
	}
	line, _, _, _, err := ssh.ParseAuthorizedKey([]byte(k.PublicLine))
	if err != nil || !bytes.Equal(line.(ssh.CryptoPublicKey).CryptoPublicKey().(ed25519.PublicKey), k.Public) {
		t.Fatalf("line %q doesn't carry Public: %v", k.PublicLine, err)
	}
	signer, err := ssh.ParsePrivateKey(k.PrivatePEM)
	if err != nil || !bytes.Equal(signer.PublicKey().Marshal(), line.Marshal()) {
		t.Fatalf("the PEM isn't the key's private half: %v", err)
	}
	if s := fmt.Sprintf("%v %+v %#v", k, k, k); strings.Contains(s, "PRIVATE") {
		t.Fatalf("printing leaks the private key: %s", s)
	}
	other, err := NewPairKey("Studio PC")
	if err != nil || bytes.Equal(other.Public, k.Public) {
		t.Fatal("two requests share a key")
	}
}

func TestSaveIdentityWritesAPrivateFileUnderIdentities(t *testing.T) {
	dir := t.TempDir()
	first, err := SaveIdentity(dir, []byte("one"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := SaveIdentity(dir, []byte("two"))
	if err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{first: "one", second: "two"} {
		if ok, _ := filepath.Match(filepath.Join(dir, "identities", "herdr-pair-*.key"), path); !ok {
			t.Fatalf("path %s", path)
		}
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Fatalf("%s holds %q, %v", path, got, err)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode %v", path, info.Mode())
		}
	}
	if first == second {
		t.Fatal("the second identity overwrote the first")
	}
}
