package pairing

import (
	"os"
	"path/filepath"
)

// PairKey is the SSH key a new device makes for one pair-v1 request (S):
// the identity it saves and signs in with, and the 32 raw bytes of its
// public half that the request carries and binds.
type PairKey struct {
	Identity
	Public []byte
}

func (PairKey) String() string     { return "pair key (private key redacted)" }
func (k PairKey) GoString() string { return k.String() }

// NewPairKey makes a request's key, as GenerateIdentity makes a key for
// herdr pair: one ed25519 key, its private half commented device.
func NewPairKey(device string) (PairKey, error) {
	identity, public, err := generateIdentity(device)
	if err != nil {
		return PairKey{}, err
	}
	return PairKey{Identity: identity, Public: []byte(public)}, nil
}

// SaveIdentity writes private (an OpenSSH private key) to a new file
// <dir>/identities/herdr-pair-*.key, readable by this user only, and
// returns its path: the file a paired machine's KeyPath names.
func SaveIdentity(dir string, private []byte) (string, error) {
	dir = filepath.Join(dir, "identities")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	file, err := os.CreateTemp(dir, "herdr-pair-*.key")
	if err != nil {
		return "", err
	}
	name := file.Name()
	if _, err := file.Write(private); err != nil {
		_ = file.Close()
		_ = os.Remove(name)
		return "", err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(name)
		return "", err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(name)
		return "", err
	}
	return name, nil
}
