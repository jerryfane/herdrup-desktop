package fakeherdr

import (
	"crypto/ed25519"
	"encoding/json"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func pairKeyLine(t *testing.T, seed byte) string {
	t.Helper()
	pub, err := ssh.NewPublicKey(ed25519.NewKeyFromSeed([]byte(strings.Repeat(string(rune(seed)), 32))).Public())
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub)))
}

func addKey(p *PairKeys, owner bool, params map[string]any) (map[string]any, *APIError) {
	raw, _ := json.Marshal(params)
	out, e, ok := p.HandleFrom(owner, "pair.add_key", raw)
	if !ok {
		panic("pair.add_key not handled")
	}
	m, _ := out.(map[string]any)
	return m, e
}

func TestPairKeysAddsOnceAndValidates(t *testing.T) {
	p := &PairKeys{}
	if _, _, ok := p.Handle("ping", nil); ok {
		t.Fatal("handled ping")
	}
	line := pairKeyLine(t, 'a')
	out, e := addKey(p, true, map[string]any{"public_key": line + " studio@pc", "label": "Studio PC"})
	if e != nil || out["added"] != true || !strings.HasPrefix(out["fingerprint"].(string), "SHA256:") {
		t.Fatalf("add = %v, %v", out, e)
	}
	out, e = addKey(p, true, map[string]any{"public_key": line, "label": "Another"})
	if e != nil || out["added"] != false || out["already"] != true || out["label"] != "Studio PC" {
		t.Fatalf("again = %v, %v", out, e)
	}
	if keys := p.Keys(); len(keys) != 1 || keys[0].PublicKey != line || keys[0].Label != "Studio PC" {
		t.Fatalf("keys %+v", keys)
	}
	for name, params := range map[string]map[string]any{
		"two lines":    {"public_key": line + "\n" + pairKeyLine(t, 'b'), "label": "x"},
		"not ed25519":  {"public_key": "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC", "label": "x"},
		"empty label":  {"public_key": line, "label": ""},
		"long label":   {"public_key": line, "label": strings.Repeat("é", 81)},
		"control char": {"public_key": line, "label": "a\x07b"},
		"extra field":  {"public_key": line, "label": "x", "path": "/root"},
	} {
		if _, e := addKey(p, true, params); e == nil || e.Code != "invalid_params" {
			t.Errorf("%s: %v", name, e)
		}
	}
	if _, e := addKey(p, true, map[string]any{"public_key": line, "label": strings.Repeat("é", 80)}); e != nil {
		t.Fatalf("80 characters: %v", e)
	}
	if _, e := addKey(p, false, map[string]any{"public_key": pairKeyLine(t, 'c'), "label": "x"}); e == nil || e.Code != "forbidden" {
		t.Fatalf("not the owner: %v", e)
	}
	if n := len(p.Keys()); n != 1 {
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
