package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/guest"
)

// The guest home tells an offline machine and a lost share from other failures, wrapped
// or not (App/GuestHomeView.swift 346-356).
func TestGuestAvailabilityClassifiesListingFailures(t *testing.T) {
	for _, c := range []struct {
		err  error
		want string
	}{
		{guest.ErrHostOffline, "offline"},
		{fmt.Errorf("agent.list: %w", guest.ErrHostOffline), "offline"},
		{guest.ErrRevoked, "lost"},
		{fmt.Errorf("agent.list: %w", guest.ErrRevoked), "lost"},
		{guest.ErrRateLimited, "reconnecting"},
		{errors.New("The shared machine is busy. Try again shortly."), ""},
	} {
		if got := guestAvailability(c.err); got != c.want {
			t.Errorf("guestAvailability(%v) = %q, want %q", c.err, got, c.want)
		}
	}
}

func TestGuestInvitationCannotReplaceLostIdentityOfSavedShares(t *testing.T) {
	dir := t.TempDir()
	desk := newDesk(dir)
	encode := func(size int) string { return base64.RawURLEncoding.EncodeToString(make([]byte, size)) }
	wire, err := json.Marshal(map[string]any{"v": 1, "relay": "https://relay.example", "host_id": encode(16), "host_pub": encode(32), "invite_id": encode(16), "secret": encode(32), "guest_name": "visitor", "machine_label": "Machine", "owner_name": "Owner", "agent_name": "Agent", "expires_unix": time.Now().Add(time.Hour).Unix()})
	if err != nil {
		t.Fatal(err)
	}
	link := guest.AppLinkPrefix + base64.RawURLEncoding.EncodeToString(wire)
	preview, err := desk.InspectGuestInvitation(context.Background(), link)
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
	again, err := desk.InspectGuestInvitation(context.Background(), link)
	if err != nil || again.Fingerprint != preview.Fingerprint {
		t.Fatalf("saved share changed identity: %+v %v", again, err)
	}
	if err := os.Remove(keyPath); err != nil {
		t.Fatal(err)
	}
	if _, err := desk.InspectGuestInvitation(context.Background(), link); err == nil {
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
	recovered, err := desk.InspectGuestInvitation(context.Background(), link)
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

// A short link pasted into the sheet (or opened from a scanned code) reaches the
// same review as the long link it stands for, and its relay's answers read as
// the native copy (herdrup GuestInvite.swift:53-54 at f2df68b).
func TestShortGuestInvitationReachesReview(t *testing.T) {
	desk := newDesk(t.TempDir())
	var gone atomic.Bool
	var blob []byte
	relay := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if gone.Load() || r.URL.Path != "/v1/invite/k7Qp2xRmA1bC" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(blob)
	}))
	defer relay.Close()
	desk.inviteTransport = relay.Client().Transport
	encode := func(size int) string { return base64.RawURLEncoding.EncodeToString(make([]byte, size)) }
	wire, err := json.Marshal(map[string]any{"v": 1, "relay": relay.URL, "host_id": encode(16), "host_pub": encode(32), "invite_id": encode(16), "secret": encode(32), "guest_name": "visitor", "machine_label": "Machine", "owner_name": "Owner", "agent_name": "Agent", "expires_unix": time.Now().Add(time.Hour).Unix()})
	if err != nil {
		t.Fatal(err)
	}
	key := []byte("0123456789abcdef")
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := []byte("twelve bytes")
	blob = aead.Seal(nonce, nonce, wire, []byte("k7Qp2xRmA1bC"))
	short := relay.URL + "/i/k7Qp2xRmA1bC" + base64.RawURLEncoding.EncodeToString(key)

	long, err := desk.InspectGuestInvitation(context.Background(), relay.URL+"/i/"+base64.RawURLEncoding.EncodeToString(wire))
	if err != nil {
		t.Fatal(err)
	}
	reviewed, err := desk.InspectGuestInvitation(context.Background(), "Here's the agent:\n"+short+"\n")
	if err != nil {
		t.Fatal(err)
	}
	if reviewed != long || reviewed.AgentName != "Agent" || reviewed.GuestName != "visitor" {
		t.Fatalf("short review %+v, long review %+v", reviewed, long)
	}

	gone.Store(true)
	for name, run := range map[string]func() error{
		"review": func() error { _, err := desk.InspectGuestInvitation(context.Background(), short); return err },
		"accept": func() error { _, err := desk.AcceptGuestInvitation(context.Background(), short); return err },
	} {
		if err := run(); !errors.Is(err, guest.ErrInviteRevoked) || err.Error() != "This invite has expired or was revoked." {
			t.Errorf("%s of a revoked short link: %v", name, err)
		}
	}
	relay.Close()
	if _, err := desk.InspectGuestInvitation(context.Background(), short); !errors.Is(err, guest.ErrInviteUnreachable) || err.Error() != "Couldn't reach the invite server; check your connection and try again" {
		t.Errorf("unreachable relay: %v", err)
	}
}
