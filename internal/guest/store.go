package guest

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
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
