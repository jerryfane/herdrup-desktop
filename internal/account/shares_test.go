package account

import (
	"encoding/json"
	"strings"
	"testing"
)

// A share's body is what sync.ts SCHEMAS.shares takes: the relay in its
// canonical form, never an invite link; the ids 16 bytes of base64url; a
// label the service would refuse left out.
func TestShareBodiesAsTheServiceTakesThem(t *testing.T) {
	host, guest := "AAAAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBBBA"
	pub := make([]byte, 32)
	b, ok := NewShareBody("https://Relay.Example/base/", host, pub, guest, "docs", strings.Repeat("o", 65), "studio")
	if !ok || b.Relay != "https://relay.example/base" || b.NodePub != strings.Repeat("A", 43) || b.OwnerName != "" || b.AgentName != "docs" || b.MachineLabel != "studio" {
		t.Fatalf("body %+v, %v", b, ok)
	}
	if !ValidShare(ShareID(host, guest), b) || ValidShare(ShareID(guest, host), b) {
		t.Fatal("a share is valid under its own id only")
	}
	for _, relay := range []string{"https://relay.example/i/abc", "https://relay.example/%69", "https://u@relay.example", "https://relay.example/?x=1", "ftp://relay.example"} {
		if _, ok := NewShareBody(relay, host, pub, guest, "", "", ""); ok {
			t.Errorf("relay %q taken", relay)
		}
	}
	if _, ok := NewShareBody("https://relay.example", "fake-guest-1", pub, guest, "", "", ""); ok {
		t.Error("a host id that isn't 16 bytes of base64url taken")
	}
	raw, _ := json.Marshal(b)
	var fields map[string]any
	_ = json.Unmarshal(raw, &fields)
	for k := range fields {
		switch k {
		case "relay", "host_id", "node_pub", "guest_id", "agent_name", "machine_label":
		default:
			t.Errorf("field %q sent", k)
		}
	}
}

// The mirror keeps the account's shares as it keeps hosts and prompts: a
// tombstone takes one out (and is returned), and a row whose body doesn't
// match its id is none the service would hold.
func TestTheMirrorFoldsShares(t *testing.T) {
	host, guest := "AAAAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBBBA"
	b, _ := NewShareBody("https://relay.example", host, make([]byte, 32), guest, "", "", "")
	raw, _ := json.Marshal(b)
	id := ShareID(host, guest)
	m, _ := Mirror{}.Apply(Pull{Rev: 2, Full: true, Items: []Item{
		{Collection: "shares", ID: id, Rev: 1, Body: raw},
		{Collection: "shares", ID: ShareID(guest, host), Rev: 2, Body: raw},
	}})
	if len(m.Shares) != 1 || m.Shares[0].ID != id || m.Shares[0].Body != b {
		t.Fatalf("shares %+v", m.Shares)
	}
	m, gone := m.Apply(Pull{Rev: 3, Items: []Item{{Collection: "shares", ID: id, Rev: 3, Deleted: true}}})
	if len(m.Shares) != 0 || gone.Shares[id] != 3 {
		t.Fatalf("after the delete: %+v, %v", m.Shares, gone.Shares)
	}
}
