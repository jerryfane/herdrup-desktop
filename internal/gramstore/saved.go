package gramstore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sync"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// SavedFile is a saved copy's attachment metadata; the bytes are never kept.
type SavedFile struct {
	Name string `json:"name"`
	Size uint64 `json:"size"`
	Mime string `json:"mime"`
}

// SavedGram is a locally saved copy of a Gram message (herdrup SavedGram):
// a copy, not an id, since a deleted original cannot be fetched again.
type SavedGram struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	// From is the sender as shown when saved (SenderName).
	From          string     `json:"from"`
	FromAgent     bool       `json:"fromAgent"`
	CreatedUnixMs uint64     `json:"createdUnixMs"`
	File          *SavedFile `json:"file,omitempty"`
	// ExpiredFile is an attachment the store expired, with nothing to open.
	ExpiredFile *SavedFile `json:"expiredFile,omitempty"`
}

// Saved is the saved messages of this device, as JSON in one file
// (herdrup keeps them in UserDefaults, one set per device). Methods are safe
// for concurrent use.
type Saved struct {
	path   string
	mu     sync.Mutex
	loaded bool
	saved  []SavedGram // newest first
}

// NewSaved returns the saved messages kept in path; nothing is read until
// they are first used.
func NewSaved(path string) *Saved { return &Saved{path: path} }

// load reads the file once. A missing or unreadable file is no saved
// messages, as herdrup decodes a bad UserDefaults value. s.mu must be held.
func (s *Saved) load() {
	if s.loaded {
		return
	}
	s.loaded = true
	data, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var list []SavedGram
	if json.Unmarshal(data, &list) != nil {
		return
	}
	sortNewestFirst(list)
	s.saved = list
}

func sortNewestFirst(list []SavedGram) {
	slices.SortStableFunc(list, func(a, b SavedGram) int {
		switch {
		case a.CreatedUnixMs > b.CreatedUnixMs:
			return -1
		case a.CreatedUnixMs < b.CreatedUnixMs:
			return 1
		}
		return 0
	})
}

// List returns the saved messages, newest first.
func (s *Saved) List() []SavedGram {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	return slices.Clone(s.saved)
}

// IDs returns the saved messages' ids.
func (s *Saved) IDs() map[string]bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	ids := make(map[string]bool, len(s.saved))
	for _, g := range s.saved {
		ids[g.ID] = true
	}
	return ids
}

// Get returns the saved copy of id.
func (s *Saved) Get(id string) (SavedGram, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	for _, g := range s.saved {
		if g.ID == id {
			return g, true
		}
	}
	return SavedGram{}, false
}

func savedFile(f *herdrapi.GramFileInfo) *SavedFile {
	if f == nil {
		return nil
	}
	return &SavedFile{Name: f.Name, Size: f.Size, Mime: f.Mime}
}

// Save keeps a copy of m, whose sender reads as senderName. It reports
// whether anything changed; saving a saved message does nothing.
func (s *Saved) Save(m herdrapi.GramMessageInfo, senderName string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	if slices.ContainsFunc(s.saved, func(g SavedGram) bool { return g.ID == m.ID }) {
		return false, nil
	}
	kept := SavedGram{
		ID: m.ID, Text: m.Text, From: senderName, FromAgent: m.Direction == herdrapi.GramDirectionAgentToOwner,
		CreatedUnixMs: m.CreatedUnixMs, File: savedFile(m.File),
	}
	if m.File == nil {
		kept.ExpiredFile = savedFile(m.ExpiredFile)
	}
	next := append(slices.Clone(s.saved), kept)
	sortNewestFirst(next)
	if err := s.store(next); err != nil {
		return false, err
	}
	s.saved = next
	return true, nil
}

// Remove forgets the saved copy of id and reports whether there was one.
func (s *Saved) Remove(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	i := slices.IndexFunc(s.saved, func(g SavedGram) bool { return g.ID == id })
	if i < 0 {
		return false, nil
	}
	next := slices.Delete(slices.Clone(s.saved), i, i+1)
	if err := s.store(next); err != nil {
		return false, err
	}
	s.saved = next
	return true, nil
}

// ExpireFiles moves the file of every saved copy whose message in ms the
// store has expired to ExpiredFile, so Saved stops offering bytes that are
// gone (herdrup expireFiles). It writes only when something moved, and
// reports whether it did.
func (s *Saved) ExpireFiles(ms []herdrapi.GramMessageInfo) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	var next []SavedGram
	moved := false
	for _, m := range ms {
		if m.ExpiredFile == nil {
			continue
		}
		if next == nil {
			next = slices.Clone(s.saved)
		}
		i := slices.IndexFunc(next, func(g SavedGram) bool { return g.ID == m.ID })
		if i < 0 || next[i].File == nil {
			continue
		}
		moved = true
		next[i].ExpiredFile, next[i].File = next[i].File, nil
	}
	if !moved {
		return false, nil
	}
	if err := s.store(next); err != nil {
		return false, err
	}
	s.saved = next
	return true, nil
}

// store writes list atomically. s.mu must be held.
func (s *Saved) store(list []SavedGram) error {
	if list == nil {
		list = []SavedGram{}
	}
	data, err := json.Marshal(list)
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
