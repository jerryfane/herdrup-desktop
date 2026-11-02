package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// SavedTerminal is device-local metadata. Plain shells do not appear in
// agent.list; their pane identities must survive closing and reopening the app.
type SavedTerminal struct {
	ID            string `json:"id"`
	PaneID        string `json:"paneID"`
	Label         string `json:"label"`
	CreatedUnixMs int64  `json:"createdUnixMs"`
}

type terminalStore struct {
	mu     sync.Mutex
	path   string
	loaded bool
	scopes map[string][]SavedTerminal
}

func terminalScope(machineID, session string) string { return machineID + "\x00" + sessionKey(session) }

func (s *terminalStore) loadLocked() error {
	if s.loaded {
		return nil
	}
	data, err := os.ReadFile(s.path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var scopes map[string][]SavedTerminal
	if err == nil {
		if err := json.Unmarshal(data, &scopes); err != nil {
			return fmt.Errorf("reading saved terminals: %w", err)
		}
	}
	if scopes == nil {
		scopes = map[string][]SavedTerminal{}
	}
	s.scopes = scopes
	s.loaded = true
	return nil
}

func (s *terminalStore) saveLocked() error {
	data, err := json.MarshalIndent(s.scopes, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *terminalStore) list(scope string) ([]SavedTerminal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return nil, err
	}
	result := slices.Clone(s.scopes[scope])
	if result == nil {
		result = []SavedTerminal{}
	}
	return result, nil
}

func (s *terminalStore) find(scope, pane string) (SavedTerminal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return SavedTerminal{}, err
	}
	for _, entry := range s.scopes[scope] {
		if entry.PaneID == pane {
			return entry, nil
		}
	}
	return SavedTerminal{}, errors.New("terminal is no longer saved on this host and session")
}

func (s *terminalStore) add(scope, pane string) (SavedTerminal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return SavedTerminal{}, err
	}
	old := s.scopes[scope]
	used := make(map[int]bool, len(old))
	for _, entry := range old {
		if entry.PaneID == pane {
			return SavedTerminal{}, errors.New("terminal pane is already saved")
		}
		if strings.HasPrefix(entry.Label, "Terminal ") {
			if n, err := strconv.Atoi(strings.TrimPrefix(entry.Label, "Terminal ")); err == nil && n > 0 {
				used[n] = true
			}
		}
	}
	n := 1
	for used[n] {
		n++
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return SavedTerminal{}, err
	}
	entry := SavedTerminal{ID: hex.EncodeToString(id[:]), PaneID: pane, Label: fmt.Sprintf("Terminal %d", n), CreatedUnixMs: time.Now().UnixMilli()}
	s.scopes[scope] = append(slices.Clone(old), entry)
	if err := s.saveLocked(); err != nil {
		s.scopes[scope] = old
		return SavedTerminal{}, err
	}
	return entry, nil
}

func (s *terminalStore) rename(scope, pane, label string) error {
	label = strings.TrimSpace(label)
	if label == "" {
		return errors.New("terminal label is empty")
	}
	return s.modify(scope, pane, label, false)
}
func (s *terminalStore) remove(scope, pane string) error { return s.modify(scope, pane, "", true) }
func (s *terminalStore) modify(scope, pane, label string, remove bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return err
	}
	old := s.scopes[scope]
	index := slices.IndexFunc(old, func(entry SavedTerminal) bool { return entry.PaneID == pane })
	if index < 0 {
		return errors.New("terminal is no longer saved on this host and session")
	}
	next := slices.Clone(old)
	if remove {
		next = slices.Delete(next, index, index+1)
	} else {
		next[index].Label = label
	}
	s.scopes[scope] = next
	if err := s.saveLocked(); err != nil {
		s.scopes[scope] = old
		return err
	}
	return nil
}
