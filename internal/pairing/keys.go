package pairing

import (
	"crypto/ed25519"
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/crypto/ssh"
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
	identity, err := GenerateIdentity(device)
	if err != nil {
		return PairKey{}, err
	}
	public, _, _, _, err := ssh.ParseAuthorizedKey([]byte(identity.PublicLine))
	if err != nil {
		return PairKey{}, err
	}
	crypto, ok := public.(ssh.CryptoPublicKey)
	if !ok {
		return PairKey{}, errors.New("pairing: generated key has no public half")
	}
	raw, ok := crypto.CryptoPublicKey().(ed25519.PublicKey)
	if !ok || len(raw) != ed25519.PublicKeySize {
		return PairKey{}, errors.New("pairing: generated key is not ed25519")
	}
	return PairKey{Identity: identity, Public: []byte(raw)}, nil
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
