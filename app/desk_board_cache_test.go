package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"golang.org/x/crypto/ssh"
)

// Slow-network fix 4: connecting shows the machine's last listed board at once,
// unlisted, and the first agent.list replaces it. Removing the machine deletes it.
func TestConnectShowsTheLastBoardUntilTheFirstList(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	hostKey, _ := ssh.NewSignerFromKey(priv)
	_, clientPriv, _ := ed25519.GenerateKey(rand.Reader)
	client, _ := ssh.NewSignerFromKey(clientPriv)
	block, err := ssh.MarshalPrivateKey(clientPriv, "")
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(t.TempDir(), "id")
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatal(err)
	}
	var stall atomic.Bool
	release := make(chan struct{})
	srv := &fakeherdr.Server{
		HostKey: hostKey, Authorized: client.PublicKey(),
		Handle: func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "ping":
				return fakeherdr.Pong(true), nil
			case "agent.list":
				if stall.Load() {
					<-release
				}
				return map[string]any{"type": "agent_list", "agents": []any{
					map[string]any{"pane_id": "w1:p1", "agent_status": "working", "name": "builder"},
				}}, nil
			}
			return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
		},
	}
	addr, err := srv.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	host, portStr, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portStr)
	m := Machine{Host: host, Port: port, User: "dev", KeyPath: keyPath}

	dir := t.TempDir()
	d := newDesk(dir)
	if err := d.Connect(m, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the first list", func() bool { b := d.Board(); return b != nil && b.ListedAt != "" && b.Board.Total == 1 })
	d.Disconnect()

	// The next launch, on a link whose agent.list does not come back yet.
	stall.Store(true)
	d = newDesk(dir)
	defer d.Disconnect()
	if err := d.Connect(m, ""); err != nil {
		t.Fatal(err)
	}
	b := d.Board()
	if b == nil || b.ListedAt != "" || b.MachineID != machineID(m) || b.Board.Total != 1 {
		t.Fatalf("connecting showed %+v, want the cached board, unlisted", b)
	}
	// The list may not have been asked for yet: closing lets it through whenever it is.
	close(release)
	waitFor(t, "the list to replace it", func() bool { b := d.Board(); return b != nil && b.ListedAt != "" })

	if err := d.RemoveMachine(machineID(m)); err != nil {
		t.Fatal(err)
	}
	if files, _ := filepath.Glob(filepath.Join(dir, "cache", "boards", "board-*.json")); len(files) != 0 {
		t.Fatalf("removing the machine kept %v", files)
	}
}

// Review of #210: a list accepted before RemoveMachine must not write the
// machine's board back after it; saving the machine again allows boards.
func TestARemovedMachineTakesNoLateBoard(t *testing.T) {
	c := boardCache{dir: t.TempDir()}
	b := BoardUpdate{MachineID: "m1", Session: "", ListedAt: "2026-11-13T00:00:00Z"}
	b.Board.Total = 1
	c.store(b)
	c.forget("m1")
	c.store(b) // the late write of a list accepted before the removal
	if got := c.load("m1", ""); got != nil {
		t.Fatalf("a removed machine's board came back: %+v", got)
	}
	c.allow("m1")
	c.store(b)
	if got := c.load("m1", ""); got == nil || got.Board.Total != 1 || got.ListedAt != "" {
		t.Fatalf("saved again: %+v", got)
	}
}

// Review of #210, round 2: the cache takes boards exactly while the machine is saved, and
// replacing a machine with another host forgets the old one's boards. (The removal's forget now
// runs inside storeMu, as the saves' allow do, so a concurrent remove and re-save end as the
// saved machines do; that ordering is structural, not tested by timing.)
func TestBoardCacheFollowsTheSavedMachine(t *testing.T) {
	d := newDesk(t.TempDir())
	m := Machine{Host: "h", Port: 22, User: "u", KeyPath: "/k"}
	id := machineID(m)
	b := BoardUpdate{MachineID: id, ListedAt: "2026-11-13T00:00:00Z"}
	b.Board.Total = 1
	stored := func() bool { d.boards.store(b); return d.boards.load(id, "") != nil }
	for _, step := range []struct {
		name  string
		do    func() error
		takes bool
	}{
		{"saved", func() error { return d.SaveMachine(m, "") }, true},
		{"removed", func() error { return d.RemoveMachine(id) }, false},
		{"saved again", func() error { return d.SaveMachine(m, "") }, true},
		{"replaced by another host", func() error { return d.SaveMachine(Machine{Host: "h2", Port: 22, User: "u", KeyPath: "/k"}, id) }, false},
	} {
		if err := step.do(); err != nil {
			t.Fatalf("%s: %v", step.name, err)
		}
		if got := stored(); got != step.takes {
			t.Fatalf("%s: the cache takes boards %v, want %v", step.name, got, step.takes)
		}
	}
}
