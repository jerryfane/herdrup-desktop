package guest

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// Store holds grants, never invitation bearers or private device keys.
type Store struct {
	path string
	mu   sync.Mutex
}

func NewStore(path string) *Store { return &Store{path: path} }

func (a Access) validate() error {
	host, err := decode64(a.Endpoint.HostID)
	if err != nil || len(host) != 16 || len(a.Endpoint.HostPublicKey) != 32 || a.GuestID == "" || a.AgentTarget == "" || !validGuestName(a.GuestName) || !validLabel(a.MachineLabel) || !validLabel(a.OwnerName) || !validLabel(a.AgentName) {
		return errors.New("The saved shared connection is damaged. It was not changed.")
	}
	_, err = a.Endpoint.socketURL()
	return err
}
func (s *Store) load() ([]Access, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return []Access{}, nil
	}
	if err != nil {
		return nil, err
	}
	var list []Access
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, fmt.Errorf("read saved shared connections: %w", err)
	}
	seen := make(map[string]bool, len(list))
	for _, access := range list {
		if err := access.validate(); err != nil {
			return nil, err
		}
		if seen[access.ID()] {
			return nil, errors.New("Saved shared connections contain duplicate grants.")
		}
		seen[access.ID()] = true
	}
	if list == nil {
		list = []Access{}
	}
	return list, nil
}
func (s *Store) List() ([]Access, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.load() }
func (s *Store) Save(access Access) error {
	// How the share stands in the account is the desk's report, not the
	// grant's.
	access.AccountShare, access.AccountShareProblem = "", ""
	if err := access.validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	list, err := s.load()
	if err != nil {
		return err
	}
	index := slices.IndexFunc(list, func(item Access) bool { return item.ID() == access.ID() })
	if index < 0 {
		list = append(list, access)
	} else {
		list[index] = access
	}
	return s.save(list)
}

// Relabel saves label as the machine's name on the share id, as a hello's
// reply named it at at (Access.LabeledAt), an unchanged name too, in one
// write; nothing for a share no longer saved.
func (s *Store) Relabel(id, label string, at time.Time) error {
	if !validLabel(label) {
		return errors.New("not a machine label")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	list, err := s.load()
	if err != nil {
		return err
	}
	index := slices.IndexFunc(list, func(item Access) bool { return item.ID() == id })
	if index < 0 {
		return nil
	}
	list[index].MachineLabel, list[index].LabeledAt = label, &at
	return s.save(list)
}

// NamedAt is when a hello last named the share's machine: LabeledAt, else
// AcceptedAt.
func (a Access) NamedAt() time.Time {
	if a.LabeledAt != nil {
		return *a.LabeledAt
	}
	return a.AcceptedAt
}
func (s *Store) Remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	list, err := s.load()
	if err != nil {
		return err
	}
	index := slices.IndexFunc(list, func(item Access) bool { return item.ID() == id })
	if index < 0 {
		return nil
	}
	return s.save(slices.Delete(list, index, index+1))
}
func (s *Store) save(list []Access) error {
	data, err := json.Marshal(list)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(s.path), ".guest-access-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(temp.Name(), s.path)
}
