package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"golang.org/x/crypto/ssh"
)

const (
	piID     = "0123456789abcdef0123456789abcdef"
	studioID = "fedcba9876543210fedcba9876543210"
)

// federatedDesk connects a desk to a fake herdr with two saved machines,
// pi with two agents on the board and studio with none, plus one agent
// of a peer with no saved machine.
func federatedDesk(t *testing.T, configure func(*fakeherdr.Server)) (*Desk, *fakeherdr.Server) {
	t.Helper()
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
	srv := &fakeherdr.Server{
		HostKey: hostKey, Authorized: client.PublicKey(),
		Machines: []fakeherdr.Machine{
			{ProfileID: studioID, DisplayLabel: "studio", SavedState: "untrusted"},
			{ProfileID: piID, DisplayLabel: "pi", SavedState: "coordinated", FederationReachability: "reachable"},
		},
		Handle: func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "ping":
				return fakeherdr.Pong(true), nil
			case "agent.list":
				return map[string]any{"type": "agent_list", "agents": []any{
					map[string]any{"pane_id": "w1:p1", "agent_status": "working"},
					map[string]any{"pane_id": piID + "/w1:p1", "agent_status": "idle", "machine_id": piID, "machine_label": "pi", "reachability": "degraded"},
					map[string]any{"pane_id": piID + "/w1:p2", "agent_status": "idle", "machine_id": piID, "machine_label": "pi"},
					map[string]any{"pane_id": "legacy/w1:p1", "agent_status": "idle", "machine_id": "legacy"},
				}}, nil
			}
			return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
		},
	}
	if configure != nil {
		configure(srv)
	}
	addr, err := srv.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Close() })
	host, portStr, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portStr)
	d := newDesk(t.TempDir())
	t.Cleanup(d.Disconnect)
	if err := d.Connect(Machine{Host: host, Port: port, User: "dev", KeyPath: keyPath}, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "a board", func() bool { return d.Board() != nil })
	return d, srv
}

func statusReads(srv *fakeherdr.Server) int {
	n := 0
	for _, r := range srv.Requests() {
		if r.Method == "machine.status" {
			n++
		}
	}
	return n
}

func TestDeskMachineStatusesCarryTheirPeers(t *testing.T) {
	d, _ := federatedDesk(t, nil)
	peers := d.Peers()
	if len(peers) != 2 || peers[0].Alias != piID || peers[0].AgentCount != 2 ||
		peers[0].Reachability != engine.PeerDegraded || peers[1].Alias != "legacy" {
		t.Fatalf("peers %+v", peers)
	}
	got, err := d.MachineStatuses(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ProfileID != piID || got[1].ProfileID != studioID {
		t.Fatalf("statuses %+v", got)
	}
	if !got[0].HasFederationPolicy || got[0].Peer == nil || got[0].Peer.AgentCount != 2 {
		t.Fatalf("pi %+v peer %+v", got[0], got[0].Peer)
	}
	if got[1].HasFederationPolicy || got[1].Peer != nil {
		t.Fatalf("studio %+v", got[1])
	}
}

func TestDeskSetMachineFederationRereadsStatuses(t *testing.T) {
	d, srv := federatedDesk(t, nil)
	before := statusReads(srv)
	if err := d.SetMachineFederation(context.Background(), studioID, true); err != nil {
		t.Fatal(err)
	}
	if calls := srv.MachineCalls(); len(calls) != 1 || strings.Join(calls[0].Args, " ") != "federate "+studioID {
		t.Fatalf("machine calls %+v", calls)
	}
	if n := statusReads(srv) - before; n != 1 {
		t.Fatalf("%d machine.status reads after the change, want 1", n)
	}
}

func TestDeskSetMachineFederationErrors(t *testing.T) {
	t.Run("change failed", func(t *testing.T) {
		d, srv := federatedDesk(t, func(s *fakeherdr.Server) { s.MachineStderr = "federation coordinator is disabled\n" })
		before := statusReads(srv)
		err := d.SetMachineFederation(context.Background(), studioID, true)
		var change *FederationChangeError
		if !errors.As(err, &change) || change.Applied {
			t.Fatalf("got %v, want a failed change", err)
		}
		if err.Error() != "Change failed: federation coordinator is disabled" {
			t.Fatalf("message %q", err)
		}
		if n := statusReads(srv) - before; n != 0 {
			t.Fatalf("%d machine.status reads after a failed change", n)
		}
	})
	t.Run("applied but not refreshed", func(t *testing.T) {
		d, srv := federatedDesk(t, func(s *fakeherdr.Server) {
			s.MachineStatusError = &fakeherdr.APIError{Code: "server_unavailable", Message: "reloading"}
		})
		err := d.SetMachineFederation(context.Background(), studioID, false)
		var change *FederationChangeError
		if !errors.As(err, &change) || !change.Applied {
			t.Fatalf("got %v, want an applied change", err)
		}
		if !strings.HasPrefix(err.Error(), "Change applied, but status could not refresh: ") || !strings.Contains(err.Error(), "reloading") {
			t.Fatalf("message %q", err)
		}
		if calls := srv.MachineCalls(); len(calls) != 1 || calls[0].Args[0] != "unfederate" {
			t.Fatalf("machine calls %+v", calls)
		}
	})
	t.Run("not connected", func(t *testing.T) {
		err := newDesk(t.TempDir()).SetMachineFederation(context.Background(), studioID, true)
		var change *FederationChangeError
		if !errors.As(err, &change) || change.Applied {
			t.Fatalf("got %v", err)
		}
	})
}
