package fakeherdr

import (
	"encoding/json"
	"strings"
	"testing"
)

// herdr#529's fixtures (81135aaf: src/pairing.rs, src/api/server/owner_gate/tests.rs).
const (
	pairFixtureKey         = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDYBEgq6QqJ3tTOxBY+efdRE3BnChf8Bpq2SozDhVhUF"
	pairFixtureFingerprint = "SHA256:vL7GMFHkifrUqP8D1g/8YJGKWxWjkvRaHfKjeLXytuc"
)

func addKey(p *PairKeys, caller PairCaller, publicKey, label string) (map[string]any, *APIError) {
	raw, _ := json.Marshal(map[string]string{"public_key": publicKey, "label": label})
	out, e, ok := p.HandleFrom(caller, "pair.add_key", raw)
	if !ok {
		panic("pair.add_key not handled")
	}
	m, _ := out.(map[string]any)
	return m, e
}

func TestPairKeysAddsOnceWithTheStoredLabel(t *testing.T) {
	p := &PairKeys{}
	if _, _, ok := p.Handle("ping", nil); ok {
		t.Fatal("handled ping")
	}
	out, e := addKey(p, PairOwner, pairFixtureKey+" jerry@phone", "Jerry's iPhone")
	if e != nil || out["type"] != "pair_key_added" || out["added"] != true || out["already"] != false ||
		out["fingerprint"] != pairFixtureFingerprint || out["label"] != "Jerry's iPhone" {
		t.Fatalf("add = %v, %v", out, e)
	}
	// A second add of the same material writes nothing and answers the label
	// stored for it (a_repeated_add_replies_with_the_stored_label).
	out, e = addKey(p, PairOwner, pairFixtureKey, "Another name")
	if e != nil || out["added"] != false || out["already"] != true || out["fingerprint"] != pairFixtureFingerprint || out["label"] != "Jerry's iPhone" {
		t.Fatalf("again = %v, %v", out, e)
	}
	retried := &PairKeys{}
	if out, e := addKey(retried, PairOwner, pairFixtureKey, "Old Name"); e != nil || out["added"] != true || out["label"] != "Old Name" {
		t.Fatalf("old name = %v, %v", out, e)
	}
	if out, e := addKey(retried, PairOwner, pairFixtureKey, "New Name"); e != nil || out["added"] != false || out["label"] != "Old Name" {
		t.Fatalf("a changed-label retry = %v, %v", out, e)
	}
	if keys := p.Keys(); len(keys) != 1 || keys[0].PublicKey != pairFixtureKey || keys[0].Label != "Jerry's iPhone" {
		t.Fatalf("keys %+v (the client's comment is dropped)", keys)
	}
	long := "Mac<b>" + strings.Repeat("y", 74)
	other := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb8L/Lx4VtiRK3T4NdDkBRT1ziVYddRSWSNqPDIVQVO"
	if out, e := addKey(p, PairOwner, other, long); e != nil || out["label"] != "Macb"+strings.Repeat("y", 44) {
		t.Fatalf("80 characters stored as %v, %v", out, e)
	}
}

func TestPairKeysRefusals(t *testing.T) {
	p := &PairKeys{}
	for _, label := range []string{"", "a\nb", "tab\there", strings.Repeat("x", 81)} {
		if _, e := addKey(p, PairOwner, pairFixtureKey, label); e == nil || e.Code != "pair_label_invalid" {
			t.Errorf("label %q: %v", label, e)
		}
	}
	for _, key := range []string{"ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 user@host", "ssh-ed25519", "ssh-ed25519 AAAA", pairFixtureKey + "\n" + pairFixtureKey} {
		if _, e := addKey(p, PairOwner, key, "Mac"); e == nil || e.Code != "pair_key_invalid" {
			t.Errorf("key %q: %v", key, e)
		}
	}
	if _, e := addKey(p, PairGuest, pairFixtureKey, "guest"); e == nil || e.Code != "guest_forbidden" {
		t.Errorf("guest: %v", e)
	}
	if _, e := addKey(p, PairOwnerBrowser, pairFixtureKey, "browser"); e == nil || e.Code != "owner_forbidden" {
		t.Errorf("owner browser: %v", e)
	}
	if _, e, _ := p.Handle("pair.add_key", json.RawMessage(`{"public_key":"`+pairFixtureKey+`","label":"x","path":"/root"}`)); e == nil {
		t.Error("took an unknown param")
	}
	if n := len(p.Keys()); n != 0 {
		t.Fatalf("%d keys after refusals", n)
	}
}

func TestPongPairAddKeyAdvertisesTheCapability(t *testing.T) {
	if caps := PongPairAddKey(false)["capabilities"].(map[string]bool); !caps["pair_add_key"] {
		t.Fatalf("capabilities %v", caps)
	}
	if caps := Pong(false)["capabilities"].(map[string]bool); caps["pair_add_key"] {
		t.Fatal("Pong shares the map")
	}
}
