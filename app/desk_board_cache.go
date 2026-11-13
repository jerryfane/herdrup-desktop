package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// boardCache keeps the last listed board of each saved machine and session,
// so connecting shows it at once and the first agent.list replaces it
// (herdrup slow-network fix 4). One file per machine and session under the
// user cache directory, 0600; at most boardCacheMax, the oldest dropped.
// Removing a machine deletes its boards. Guest connections keep none.
type boardCache struct {
	dir string
	mu  sync.Mutex
	// last is the JSON last written per file, so an unchanged board is not
	// written again on every list.
	last map[string][]byte
	// removed machines take no more boards, so a list accepted before the
	// removal cannot write one back after it; saving the machine again
	// allows them (allow).
	removed map[string]bool
}

const boardCacheMax = 16

func (c *boardCache) path(machineID, session string) string {
	sum := sha256.Sum256([]byte(machineID + "\x00" + sessionKey(session)))
	return filepath.Join(c.dir, "board-"+hex.EncodeToString(sum[:12])+".json")
}

// load returns the cached board of machineID's session, its ListedAt cleared
// so the page knows it is not yet a list; nil when there is none.
func (c *boardCache) load(machineID, session string) *BoardUpdate {
	if c == nil || c.dir == "" {
		return nil
	}
	data, err := os.ReadFile(c.path(machineID, session))
	if err != nil {
		return nil
	}
	var b BoardUpdate
	if json.Unmarshal(data, &b) != nil || b.MachineID != machineID || sessionKey(b.Session) != sessionKey(session) {
		return nil
	}
	b.ListedAt = ""
	b.Session = session
	return &b
}

// store keeps b, a board just listed, for its machine and session.
func (c *boardCache) store(b BoardUpdate) {
	if c == nil || c.dir == "" || b.ListedAt == "" || b.MachineID == "" {
		return
	}
	// The listed time changes every list; the cache keeps the board.
	keep := b
	keep.ListedAt = ""
	data, err := json.Marshal(keep)
	if err != nil {
		return
	}
	path := c.path(b.MachineID, b.Session)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.removed[b.MachineID] {
		return
	}
	if c.last == nil {
		c.last = map[string][]byte{}
	}
	if string(c.last[path]) == string(data) {
		return
	}
	if err := os.MkdirAll(c.dir, 0o700); err != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, data, 0o600) != nil || os.Rename(tmp, path) != nil {
		_ = os.Remove(tmp)
		return
	}
	c.last[path] = data
	c.pruneLocked()
}

// pruneLocked drops the oldest boards beyond boardCacheMax.
func (c *boardCache) pruneLocked() {
	files, _ := filepath.Glob(filepath.Join(c.dir, "board-*.json"))
	if len(files) <= boardCacheMax {
		return
	}
	type aged struct {
		path string
		at   time.Time
	}
	all := make([]aged, 0, len(files))
	for _, f := range files {
		if st, err := os.Stat(f); err == nil {
			all = append(all, aged{f, st.ModTime()})
		}
	}
	slices.SortFunc(all, func(a, b aged) int { return a.at.Compare(b.at) })
	for _, a := range all[:max(0, len(all)-boardCacheMax)] {
		_ = os.Remove(a.path)
		delete(c.last, a.path)
	}
}

// allow lets machineID, saved again, have boards.
func (c *boardCache) allow(machineID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.removed, machineID)
}

// forget deletes every cached board of machineID and refuses its later ones
// until it is saved again.
func (c *boardCache) forget(machineID string) {
	if c == nil || c.dir == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.removed == nil {
		c.removed = map[string]bool{}
	}
	c.removed[machineID] = true
	files, _ := filepath.Glob(filepath.Join(c.dir, "board-*.json"))
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var b BoardUpdate
		if json.Unmarshal(data, &b) != nil || b.MachineID == machineID || strings.TrimSpace(b.MachineID) == "" {
			_ = os.Remove(f)
			delete(c.last, f)
		}
	}
}
