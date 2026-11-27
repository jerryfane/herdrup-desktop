package bridge

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
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
// key afterwards. A host certificate is that machine when it certifies the
// pinned plain key (another device's approval pins the plain key); a pin of
// the certificate itself, set on first use, still holds as before.
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
		if pinned == offered {
			return nil
		}
		if cert, isCert := key.(*ssh.Certificate); isCert && Fingerprint(cert.Key) == pinned {
			return nil
		}
		return &HostKeyChangedError{HostPort: hostname, Pinned: pinned, Offered: offered}
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
	return s.write(pins)
}

// PinOutcome is what AddPins found at one address.
type PinOutcome int

const (
	// PinAdded: nothing was pinned there; the new pin is written with the rest.
	PinAdded PinOutcome = iota
	// PinExisting: the same key is pinned there already.
	PinExisting
	// PinConflicting: another key is pinned there; it stays.
	PinConflicting
)

// AddPins pins each of want's addresses (host:port to fingerprint) that has
// no pin yet, as one step with the caller's own writes: commit gets each
// address's outcome and a write that adds the PinAdded ones, and runs with
// the store held, so no other writer sets or reads a pin until it returns.
// When commit fails after write, the pins go back to what they were before
// it, still held: a pin no other writer could have touched in between.
func (s *FilePinStore) AddPins(want map[string]string, commit func(outcome map[string]PinOutcome, write func() error) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	before, err := s.load()
	if err != nil {
		return err
	}
	outcome := make(map[string]PinOutcome, len(want))
	after := maps.Clone(before)
	for hostPort, fingerprint := range want {
		switch fp, ok := before[hostPort]; {
		case ok && fp == fingerprint:
			outcome[hostPort] = PinExisting
		case ok:
			outcome[hostPort] = PinConflicting
		default:
			outcome[hostPort] = PinAdded
			after[hostPort] = fingerprint
		}
	}
	wrote := false
	write := func() error {
		if len(after) == len(before) {
			return nil
		}
		wrote = true
		return s.write(after)
	}
	if err := commit(outcome, write); err != nil {
		if wrote {
			if restore := s.write(before); restore != nil {
				return errors.Join(err, restore)
			}
		}
		return err
	}
	return nil
}

// write replaces the pins file with pins. s.mu is held.
func (s *FilePinStore) write(pins map[string]string) error {
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
