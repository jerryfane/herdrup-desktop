package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"golang.org/x/crypto/ssh"
)

// unreachable is a machine the desk tries and fails to reach; the tests
// that use it only look at what is saved.
func unreachable(host string) Machine {
	return Machine{Host: host, Port: 1, User: "dev"}
}

func machineIDs(t *testing.T, d *Desk) (ids []string, active string) {
	t.Helper()
	ms, err := d.Machines()
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range ms {
		ids = append(ids, m.ID)
		if m.Active {
			active = m.ID
		}
	}
	return ids, active
}

func TestMachinesMigrateFromSingleMachineJSON(t *testing.T) {
	dir := t.TempDir()
	legacy := []byte(`{"host":"old.example","port":2222,"user":"me","keyPath":"/keys/id","session":"work"}`)
	if err := os.WriteFile(filepath.Join(dir, "machine.json"), legacy, 0o600); err != nil {
		t.Fatal(err)
	}
	d := newDesk(dir)
	want := Machine{Host: "old.example", Port: 2222, User: "me", KeyPath: "/keys/id", Session: "work"}
	got, err := d.Machine()
	if err != nil || got == nil || *got != want {
		t.Fatalf("Machine() = %+v, %v; want the machine from machine.json", got, err)
	}
	ids, active := machineIDs(t, d)
	if !slices.Equal(ids, []string{"me@old.example:2222"}) || active != ids[0] {
		t.Fatalf("machines %q, active %q", ids, active)
	}

	// Adding a machine keeps the migrated one.
	if err := d.Connect(unreachable("new.example"), "pw"); err != nil {
		t.Fatal(err)
	}
	d.Disconnect()
	d = newDesk(dir) // as after a restart
	ids, active = machineIDs(t, d)
	if !slices.Equal(ids, []string{"me@old.example:2222", "dev@new.example:1"}) || active != "dev@new.example:1" {
		t.Fatalf("after adding: machines %q, active %q", ids, active)
	}
	if left, _ := os.ReadFile(filepath.Join(dir, "machine.json")); string(left) != string(legacy) {
		t.Errorf("machine.json changed to %s", left)
	}
}

func TestMachinesSelectReplaceAndRemove(t *testing.T) {
	dir := t.TempDir()
	d := newDesk(dir)
	if m, err := d.Machine(); m != nil || err != nil {
		t.Fatalf("fresh desk has machine %+v, %v", m, err)
	}
	a, b := unreachable("a.example"), unreachable("b.example")
	for _, m := range []Machine{a, b} {
		if err := d.Connect(m, "pw"); err != nil {
			t.Fatal(err)
		}
	}
	// Connecting to a saved machine again updates it in place.
	a.Session = "work"
	if err := d.Connect(a, "pw"); err != nil {
		t.Fatal(err)
	}
	ids, active := machineIDs(t, d)
	if !slices.Equal(ids, []string{"dev@a.example:1", "dev@b.example:1"}) || active != "dev@a.example:1" {
		t.Fatalf("machines %q, active %q", ids, active)
	}
	if m, _ := d.Machine(); m == nil || m.Session != "work" {
		t.Fatalf("active machine %+v, want a.example in session work", m)
	}

	if err := d.SelectMachine("dev@b.example:1", "pw"); err != nil {
		t.Fatal(err)
	}
	if m, _ := newDesk(dir).Machine(); m == nil || m.Host != "b.example" {
		t.Fatalf("after select the saved active machine is %+v", m)
	}
	if err := d.SelectMachine("dev@nowhere:1", "pw"); err == nil {
		t.Error("selected a machine that was never saved")
	}

	if err := d.RemoveMachine("dev@b.example:1"); err != nil {
		t.Fatal(err)
	}
	if s := d.State(); s.Phase != "idle" {
		t.Errorf("removing the active machine left the state %+v", s)
	}
	d = newDesk(dir)
	ids, active = machineIDs(t, d)
	if !slices.Equal(ids, []string{"dev@a.example:1"}) || active != "" {
		t.Fatalf("after remove: machines %q, active %q", ids, active)
	}
	if m, err := d.Machine(); m != nil || err != nil {
		t.Fatalf("after removing the active machine Machine() = %+v, %v", m, err)
	}
}

func TestSelectSessionKeepsTheConnection(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
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
	srv := &fakeherdr.Server{
		HostKey: hostKey, Authorized: client.PublicKey(),
		SessionList: `{"sessions":[{"name":"default","default":true,"running":true},{"name":"work","default":false,"running":true}]}`,
		Handle: func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "ping":
				return fakeherdr.Pong(true), nil
			case "agent.list":
				return map[string]any{"type": "agent_list", "agents": []any{
					map[string]any{"pane_id": "w1:p1", "agent_status": "working"},
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

	dir := t.TempDir()
	d := newDesk(dir)
	defer d.Disconnect()
	var boardsMu sync.Mutex
	var boards []BoardUpdate
	d.onBoard = func(b BoardUpdate) {
		boardsMu.Lock()
		boards = append(boards, b)
		boardsMu.Unlock()
	}
	if err := d.Connect(Machine{Host: host, Port: port, User: "dev", KeyPath: keyPath}, ""); err != nil {
		t.Fatal(err)
	}
	listedIn := func(session string) bool {
		for _, r := range srv.Requests() {
			if r.Method == "agent.list" && r.Session == session {
				return true
			}
		}
		return false
	}
	waitFor(t, "a board from the default session", func() bool { return d.Board() != nil && listedIn("") })

	sessions, err := d.Sessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, s := range sessions {
		names = append(names, s.Name)
	}
	if !reflect.DeepEqual(names, []string{"work", "default"}) {
		t.Fatalf("sessions %+v", sessions)
	}

	boardsMu.Lock()
	before := len(boards)
	boardsMu.Unlock()
	if err := d.SelectSession("work"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "a board from session work", func() bool { return d.Board() != nil && listedIn("work") })
	// The default session's agent must not stay on screen until the new
	// list arrives: the switch itself publishes an empty, unlisted board.
	boardsMu.Lock()
	cleared := slices.ContainsFunc(boards[before:], func(b BoardUpdate) bool {
		return b.ListedAt == "" && b.Board.Total == 0 && len(b.Board.Sections) == 0
	})
	boardsMu.Unlock()
	if !cleared {
		t.Error("switching session published no cleared board")
	}
	if n := srv.Conns(); n != 1 {
		t.Errorf("%d SSH connections, want the one kept across the session switch", n)
	}
	if m, _ := newDesk(dir).Machine(); m == nil || m.Session != "work" {
		t.Errorf("saved machine %+v, want session work remembered", m)
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
