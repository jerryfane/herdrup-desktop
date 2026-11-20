package account

import (
	"errors"
	"sync"
)

// SecretKey is the key the refresh token is kept under in the system's
// credential store (design #698 §2.5).
const SecretKey = "account-refresh"

// Secrets is the system credential store as mygo.Secrets offers it: the
// macOS Keychain, Windows Credential Manager or the Secret Service on Linux.
// Its errors wrap errors.ErrUnsupported where there is no store.
type Secrets interface {
	Get(key string) ([]byte, error)
	Set(key string, value []byte) error
	Delete(key string) error
}

// SecretsStore keeps the session in the credential store. Where there is
// none (errors.ErrUnsupported), it keeps it in memory only: never in a
// file, so the person signs in again at each launch (design #698 §2.5).
type SecretsStore struct {
	secrets  Secrets
	notFound error // the store's "no such secret" error

	mu     sync.Mutex
	memory []byte
	inMem  bool
}

// NewSecretsStore keeps the session in secrets; notFound is what its Get
// returns for a key it does not hold (mygo.ErrSecretNotFound).
func NewSecretsStore(secrets Secrets, notFound error) *SecretsStore {
	return &SecretsStore{secrets: secrets, notFound: notFound}
}

// Persistent reports whether the session outlives the app: false once the
// system was found to have no credential store.
func (s *SecretsStore) Persistent() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.inMem
}

func (s *SecretsStore) Get() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inMem {
		return s.memory, nil
	}
	raw, err := s.secrets.Get(SecretKey)
	switch {
	case err == nil:
		return raw, nil
	case errors.Is(err, s.notFound):
		return nil, nil
	case errors.Is(err, errors.ErrUnsupported):
		s.inMem = true
		return nil, nil
	}
	return nil, err
}

func (s *SecretsStore) Set(value []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.inMem {
		err := s.secrets.Set(SecretKey, value)
		if !errors.Is(err, errors.ErrUnsupported) {
			return err
		}
		s.inMem = true
	}
	s.memory = append([]byte(nil), value...)
	return nil
}

func (s *SecretsStore) Delete() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.memory = nil
	if s.inMem {
		return nil
	}
	err := s.secrets.Delete(SecretKey)
	if errors.Is(err, errors.ErrUnsupported) {
		s.inMem = true
		return nil
	}
	return err
}
