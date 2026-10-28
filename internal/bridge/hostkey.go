package bridge

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/crypto/ssh"
)

// Fingerprint is the lowercase hex SHA-256 of a host key's SSH wire form,
// the same value the iOS app pins.
func Fingerprint(key ssh.PublicKey) string {
	sum := sha256.Sum256(key.Marshal())
	return hex.EncodeToString(sum[:])
}

// PinStore remembers the host key fingerprint of every machine by
// "host:port".
type PinStore interface {
	Pin(hostPort string) (fingerprint string, ok bool, err error)
	SetPin(hostPort, fingerprint string) error
}

// HostKeyChangedError reports a machine whose host key differs from the one
// pinned on first contact. The connection is refused.
type HostKeyChangedError struct {
	HostPort string
	Pinned   string
	Offered  string
}

func (e *HostKeyChangedError) Error() string {
	return fmt.Sprintf("the host key of %s changed (pinned SHA-256 %s, offered %s); refusing to connect",
		e.HostPort, e.Pinned, e.Offered)
}

// pinningCallback trusts a machine's key on first use and refuses any other
// key afterwards.
func pinningCallback(pins PinStore) ssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		offered := Fingerprint(key)
		pinned, ok, err := pins.Pin(hostname)
		if err != nil {
			return fmt.Errorf("read host key pin: %w", err)
		}
		if !ok {
			return pins.SetPin(hostname, offered)
		}
		if pinned != offered {
			return &HostKeyChangedError{HostPort: hostname, Pinned: pinned, Offered: offered}
		}
		return nil
	}
}

// FilePinStore keeps pins in a JSON file. It is safe for concurrent use.
type FilePinStore struct {
	path string
	mu   sync.Mutex
}

// NewFilePinStore returns a store backed by path. The file is created on the
// first pin.
func NewFilePinStore(path string) *FilePinStore { return &FilePinStore{path: path} }

func (s *FilePinStore) load() (map[string]string, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	pins := map[string]string{}
	if err := json.Unmarshal(data, &pins); err != nil {
		return nil, fmt.Errorf("%s: %w", s.path, err)
	}
	return pins, nil
}

// Pin implements PinStore.
func (s *FilePinStore) Pin(hostPort string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pins, err := s.load()
	if err != nil {
		return "", false, err
	}
	fp, ok := pins[hostPort]
	return fp, ok, nil
}

// SetPin implements PinStore.
func (s *FilePinStore) SetPin(hostPort, fingerprint string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	pins, err := s.load()
	if err != nil {
		return err
	}
	pins[hostPort] = fingerprint
	data, err := json.MarshalIndent(pins, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
