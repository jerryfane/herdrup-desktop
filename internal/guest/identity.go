package guest

import (
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Identity is the device's X25519 key, shared by its guest connections. It is
// persisted before acceptance: losing it after a grant would sever that share.
type Identity struct {
	private []byte
	public  []byte
}

func (Identity) String() string     { return "guest device identity (private key redacted)" }
func (i Identity) GoString() string { return i.String() }

func identityFromBytes(raw []byte) (Identity, error) {
	if len(raw) != 32 {
		return Identity{}, errors.New("The saved guest identity is damaged. It was not replaced; replacing it would disconnect existing shares.")
	}
	key, err := ecdh.X25519().NewPrivateKey(raw)
	if err != nil {
		return Identity{}, errors.New("The saved guest identity cannot be read. It was not replaced.")
	}
	return Identity{private: raw, public: key.PublicKey().Bytes()}, nil
}

// ExistingIdentity never replaces a lost device key with an unrelated one.
func ExistingIdentity(path string) (Identity, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Identity{}, fmt.Errorf("read the existing guest identity (not replaced): %w", err)
	}
	return identityFromBytes(raw)
}

func LoadIdentity(path string) (Identity, error) {
	raw, err := os.ReadFile(path)
	if err == nil {
		return identityFromBytes(raw)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Identity{}, fmt.Errorf("read guest identity: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return Identity{}, err
	}
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return Identity{}, err
	}
	raw = key.Bytes()
	temp, err := os.CreateTemp(filepath.Dir(path), ".guest-identity-*")
	if err != nil {
		clear(raw)
		return Identity{}, err
	}
	defer os.Remove(temp.Name())
	if _, err := temp.Write(raw); err != nil {
		temp.Close()
		clear(raw)
		return Identity{}, err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		clear(raw)
		return Identity{}, err
	}
	if err := temp.Close(); err != nil {
		clear(raw)
		return Identity{}, err
	}
	// Publish complete bytes without replacing an identity won by another process.
	// Unlike creating the final file and then writing it, readers never see a
	// partial key. The app data directory is on the local filesystem.
	if err := os.Link(temp.Name(), path); err != nil {
		clear(raw)
		if !errors.Is(err, os.ErrExist) {
			return Identity{}, fmt.Errorf("save guest identity: %w", err)
		}
		persisted, err := os.ReadFile(path)
		if err != nil {
			return Identity{}, err
		}
		return identityFromBytes(persisted)
	}
	return identityFromBytes(raw)
}

func (i Identity) Fingerprint() string {
	digest := sha256.Sum256(i.public)
	var encoded [16]byte
	hex.Encode(encoded[:], digest[:8])
	var result strings.Builder
	result.Grow(len("SHA256:") + 16 + 3*len("·"))
	result.WriteString("SHA256:")
	for n := 0; n < len(encoded); n += 4 {
		if n > 0 {
			result.WriteString("·")
		}
		result.Write(encoded[n : n+4])
	}
	return result.String()
}
