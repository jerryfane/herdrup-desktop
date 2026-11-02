package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/guest"
)

func TestGuestInvitationCannotReplaceLostIdentityOfSavedShares(t *testing.T) {
	dir := t.TempDir()
	desk := newDesk(dir)
	encode := func(size int) string { return base64.RawURLEncoding.EncodeToString(make([]byte, size)) }
	wire, err := json.Marshal(map[string]any{"v": 1, "relay": "https://relay.example", "host_id": encode(16), "host_pub": encode(32), "invite_id": encode(16), "secret": encode(32), "guest_name": "visitor", "machine_label": "Machine", "owner_name": "Owner", "agent_name": "Agent", "expires_unix": time.Now().Add(time.Hour).Unix()})
	if err != nil {
		t.Fatal(err)
	}
	link := guest.AppLinkPrefix + base64.RawURLEncoding.EncodeToString(wire)
	preview, err := desk.InspectGuestInvitation(link)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(dir, "guest-identity")
	before, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	access := guest.Access{GuestID: "saved-grant", GuestName: "visitor", MachineLabel: "Machine", OwnerName: "Owner", AgentName: "Agent", AgentTarget: "%3", Endpoint: guest.Endpoint{Relay: "https://relay.example", HostID: encode(16), HostPublicKey: make([]byte, 32)}, AcceptedAt: time.Now()}
	if err := desk.guestStore.Save(access); err != nil {
		t.Fatal(err)
	}
	again, err := desk.InspectGuestInvitation(link)
	if err != nil || again.Fingerprint != preview.Fingerprint {
		t.Fatalf("saved share changed identity: %+v %v", again, err)
	}
	if err := os.Remove(keyPath); err != nil {
		t.Fatal(err)
	}
	if _, err := desk.InspectGuestInvitation(link); err == nil {
		t.Fatal("a new invitation silently replaced a missing key needed by saved shares")
	}
	if _, err := os.Stat(keyPath); !os.IsNotExist(err) {
		t.Fatalf("a replacement key was written: %v", err)
	}
	if err := desk.ConnectGuest(access.ID()); err == nil {
		t.Fatal("saved share connected with a replacement identity")
	}
	if err := os.WriteFile(keyPath, before, 0600); err != nil {
		t.Fatal(err)
	}
	recovered, err := desk.InspectGuestInvitation(link)
	if err != nil || recovered.Fingerprint != preview.Fingerprint {
		t.Fatalf("restored original key did not restore identity: %+v %v", recovered, err)
	}
	if err := desk.ForgetGuestConnection(access.ID()); err != nil {
		t.Fatal(err)
	}
	retained, err := os.ReadFile(keyPath)
	if err != nil || string(retained) != string(before) {
		t.Fatal("leaving the share removed or replaced the device identity")
	}
}
