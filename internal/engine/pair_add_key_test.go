package engine_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/pairing"
)

// keysHandler serves pair.add_key from keys, as the owner (owner) or not.
func keysHandler(keys *fakeherdr.PairKeys, owner bool) func(string, json.RawMessage) (any, *fakeherdr.APIError) {
	return func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
		if out, e, ok := keys.HandleFrom(owner, method, params); ok {
			return out, e
		}
		return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
	}
}

func TestPairAddKeyAddsTheKeyOnceAndIsIdempotent(t *testing.T) {
	keys := &fakeherdr.PairKeys{}
	_, c := start(t, map[string]bool{engine.CapabilityPairAddKey: true}, keysHandler(keys, true), nil)
	if ok, err := c.PairAddKeySupported(ctx(t)); !ok || err != nil {
		t.Fatalf("supported = %v, %v", ok, err)
	}
	k, err := pairing.NewPairKey("Studio PC")
	if err != nil {
		t.Fatal(err)
	}
	p := engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: engine.PairKeyLabel("Studio PC", "Jerry's Mac")}
	first, err := c.PairAddKey(ctx(t), p)
	if err != nil || !first.Added || first.Already || !strings.HasPrefix(first.Fingerprint, "SHA256:") || first.Label != "Studio PC (approved on Jerry's Mac)" {
		t.Fatalf("first add = %+v, %v", first, err)
	}
	again, err := c.PairAddKey(ctx(t), p)
	if err != nil || again.Added || !again.Already || again.Fingerprint != first.Fingerprint {
		t.Fatalf("second add = %+v, %v", again, err)
	}
	if got := keys.Keys(); len(got) != 1 || got[0].Fingerprint != first.Fingerprint {
		t.Fatalf("keys %+v", got)
	}
}

func TestPairAddKeyRefusals(t *testing.T) {
	k, err := pairing.NewPairKey("Studio PC")
	if err != nil {
		t.Fatal(err)
	}
	t.Run("bad params", func(t *testing.T) {
		_, c := start(t, map[string]bool{engine.CapabilityPairAddKey: true}, keysHandler(&fakeherdr.PairKeys{}, true), nil)
		for _, p := range []engine.PairAddKeyParams{
			{PublicKey: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC", Label: "x"},
			{PublicKey: k.PublicLine, Label: ""},
			{PublicKey: k.PublicLine, Label: strings.Repeat("x", engine.MaxPairKeyLabel+1)},
			{PublicKey: k.PublicLine, Label: "tab\there"},
		} {
			var api *bridge.APIError
			if _, err := c.PairAddKey(ctx(t), p); !errors.As(err, &api) || api.Code != "invalid_params" {
				t.Fatalf("%+v: %v", p, err)
			}
		}
	})
	t.Run("not the owner", func(t *testing.T) {
		_, c := start(t, map[string]bool{engine.CapabilityPairAddKey: true}, keysHandler(&fakeherdr.PairKeys{}, false), nil)
		var api *bridge.APIError
		if _, err := c.PairAddKey(ctx(t), engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: "x"}); !errors.As(err, &api) || api.Code != "forbidden" {
			t.Fatalf("guest: %v", err)
		}
	})
	t.Run("older herdr", func(t *testing.T) {
		_, c := start(t, map[string]bool{"agent_groups": true}, nil, nil)
		if ok, err := c.PairAddKeySupported(ctx(t)); ok || err != nil {
			t.Fatalf("supported = %v, %v", ok, err)
		}
		var unsupported *engine.ErrUnsupported
		if _, err := c.PairAddKey(ctx(t), engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: "x"}); !errors.As(err, &unsupported) {
			t.Fatalf("old herdr: %v", err)
		}
	})
	t.Run("reply without a fingerprint", func(t *testing.T) {
		_, c := start(t, nil, func(string, json.RawMessage) (any, *fakeherdr.APIError) {
			return map[string]any{"type": "pair_key_added", "added": true}, nil
		}, nil)
		var decode *engine.DecodeError
		if _, err := c.PairAddKey(ctx(t), engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: "x"}); !errors.As(err, &decode) {
			t.Fatalf("no fingerprint: %v", err)
		}
	})
}

func TestPairKeyLabel(t *testing.T) {
	for _, tc := range []struct{ device, approver, want string }{
		{"Studio PC", "Jerry's Mac", "Studio PC (approved on Jerry's Mac)"},
		{" Studio\n\tPC ", "", "Studio PC"},
		{"", "iPhone", "New device (approved on iPhone)"},
		{strings.Repeat("é", 90), "Mac", strings.Repeat("é", engine.MaxPairKeyLabel)},
		{strings.Repeat("a", 70), "Mac", strings.Repeat("a", 70) + " (approved"},
	} {
		if got := engine.PairKeyLabel(tc.device, tc.approver); got != tc.want {
			t.Errorf("PairKeyLabel(%q, %q) = %q, want %q", tc.device, tc.approver, got, tc.want)
		}
	}
}
