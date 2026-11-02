package guest

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestInvitationOriginExpiryAndIdentityBoundaries(t *testing.T) {
	now := time.Unix(1800000000, 0)
	encoded := func(size int) string { return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, size)) }
	fields := map[string]any{"v": 1, "relay": "https://relay.example/base", "host_id": encoded(16), "host_pub": encoded(32), "invite_id": encoded(16), "secret": encoded(32), "machine_label": "Mac", "owner_name": "Owner", "agent_name": "Agent", "guest_name": "guest-1", "expires_unix": now.Unix() + 60}
	payload := func() string {
		raw, err := json.Marshal(fields)
		if err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	for _, link := range []string{AppLinkPrefix + payload(), "https://relay.example/base/i/" + payload(), "https://relay.example/base/i#" + payload(), "Join my agent: " + AppLinkPrefix + payload() + " Thanks!"} {
		invitation, err := Parse(link, now)
		if err != nil {
			t.Fatal(err)
		}
		if invitation.GuestName != "guest-1" || len(invitation.Endpoint.HostPublicKey) != 32 {
			t.Fatal("wrong invitation decoded")
		}
	}
	for _, prefix := range []string{"https://evil.example/base/i/", "https://relay.example/other/i/", "http://relay.example/base/i/", "https://relay.example:444/base/i/"} {
		if _, err := Parse(prefix+payload(), now); err == nil {
			t.Fatalf("untrusted origin/path accepted: %s", prefix)
		}
	}
	for _, change := range []struct {
		key   string
		value any
	}{{"host_pub", encoded(16)}, {"secret", encoded(16)}, {"host_id", encoded(32)}, {"invite_id", encoded(32)}, {"relay", "http://public.example"}, {"guest_name", "-guest"}, {"owner_name", "Owner\nInjected"}, {"machine_label", strings.Repeat("x", 129)}} {
		old := fields[change.key]
		fields[change.key] = change.value
		if _, err := Parse(AppLinkPrefix+payload(), now); err == nil {
			t.Fatalf("invalid %s accepted", change.key)
		}
		fields[change.key] = old
	}
	fields["expires_unix"] = now.Unix()
	if _, err := Parse(AppLinkPrefix+payload(), now); !errors.Is(err, ErrExpired) {
		t.Fatalf("expiry boundary: %v", err)
	}
}

func TestSavedGuestAccessSurvivesReloadWithoutInvitationSecret(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shares.json")
	store := NewStore(path)
	access := Access{GuestID: "grant", GuestName: "guest", MachineLabel: "Mac", OwnerName: "Owner", AgentName: "Agent", AgentTarget: "%2", Endpoint: Endpoint{Relay: "https://relay.example", HostID: base64.RawURLEncoding.EncodeToString(make([]byte, 16)), HostPublicKey: make([]byte, 32)}, AcceptedAt: time.Now()}
	if err := store.Save(access); err != nil {
		t.Fatal(err)
	}
	access.AgentName = "Renamed"
	if err := store.Save(access); err != nil {
		t.Fatal(err)
	}
	restored, err := NewStore(path).List()
	if err != nil {
		t.Fatal(err)
	}
	if len(restored) != 1 || restored[0].AgentName != "Renamed" || restored[0].ID() != access.ID() {
		t.Fatal("saved grant was lost or duplicated")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("secret")) || bytes.Contains(raw, []byte("private")) {
		t.Fatal("saved grant contains private credential fields")
	}
	if err := store.Remove(access.ID()); err != nil {
		t.Fatal(err)
	}
	restored, err = NewStore(path).List()
	if err != nil || len(restored) != 0 {
		t.Fatalf("forgotten access returned: %v %v", restored, err)
	}
	if err := os.WriteFile(path, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(access); err == nil {
		t.Fatal("save silently discarded corrupt grant store")
	}
	raw, _ = os.ReadFile(path)
	if string(raw) != "broken" {
		t.Fatal("corrupt store overwritten")
	}
}
