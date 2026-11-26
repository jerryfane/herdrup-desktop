package engine_test

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
	"github.com/jerryfane/herdrup-desktop/internal/pairing"
	"golang.org/x/crypto/ssh"
)

// pairCaps is the ping capabilities of a herdr with pair.*.
var pairCaps = map[string]bool{engine.CapabilityPairAddKey: true}

// keysHandler serves pair.* from keys to caller.
func keysHandler(keys *fakeherdr.PairKeys, caller fakeherdr.PairCaller) func(string, json.RawMessage) (any, *fakeherdr.APIError) {
	return func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
		if out, e, ok := keys.HandleFrom(caller, method, params); ok {
			return out, e
		}
		return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
	}
}

func TestPairAddKeyAddsTheKeyOnceAndIsIdempotent(t *testing.T) {
	keys := &fakeherdr.PairKeys{}
	_, c := start(t, pairCaps, keysHandler(keys, fakeherdr.PairOwner), nil)
	if ok, err := c.PairAddKeySupported(ctx(t)); !ok || err != nil {
		t.Fatalf("supported = %v, %v", ok, err)
	}
	k, err := pairing.NewPairKey("Studio PC")
	if err != nil {
		t.Fatal(err)
	}
	p := engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: engine.PairKeyLabel("Studio PC", "Jerry's Mac")}
	first, err := c.PairAddKey(ctx(t), p)
	if err != nil || !first.Added || first.Already || !strings.HasPrefix(first.Fingerprint, "SHA256:") || first.Label != "Studio PC via Jerry's Mac" {
		t.Fatalf("first add = %+v, %v", first, err)
	}
	again, err := c.PairAddKey(ctx(t), engine.PairAddKeyParams{PublicKey: p.PublicKey, Label: engine.PairKeyLabel("Studio PC", "iPhone")})
	if err != nil || again.Added || !again.Already || again.Fingerprint != first.Fingerprint || again.Label != first.Label {
		t.Fatalf("second add, under another name = %+v, %v (want the stored label %q)", again, err, first.Label)
	}
	if got := keys.Keys(); len(got) != 1 || got[0].Fingerprint != first.Fingerprint || got[0].Label != p.Label {
		t.Fatalf("keys %+v", got)
	}
}

// The reply's label is the one herdr stored, which a label PairKeyLabel
// didn't make can differ from.
func TestPairAddKeyAnswersTheStoredLabel(t *testing.T) {
	_, c := start(t, pairCaps, keysHandler(&fakeherdr.PairKeys{}, fakeherdr.PairOwner), nil)
	k, err := pairing.NewPairKey("Studio PC")
	if err != nil {
		t.Fatal(err)
	}
	got, err := c.PairAddKey(ctx(t), engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: "Studio  PC <é> on " + strings.Repeat("y", 60)})
	if want := ("Studio PC on " + strings.Repeat("y", 60))[:engine.MaxStoredPairKeyLabel]; err != nil || got.Label != want {
		t.Fatalf("add = %+v, %v; want label %q", got, err, want)
	}
}

func TestPairAddKeyRefusals(t *testing.T) {
	k, err := pairing.NewPairKey("Studio PC")
	if err != nil {
		t.Fatal(err)
	}
	refused := func(t *testing.T, err, want error) {
		t.Helper()
		var api *bridge.APIError
		var typed *engine.PairKeyError
		if !errors.Is(err, want) || !errors.As(err, &typed) || !errors.As(err, &api) || api.Code != typed.Code {
			t.Fatalf("err = %v, want %v wrapping herdr's", err, want)
		}
	}
	t.Run("bad params", func(t *testing.T) {
		_, c := start(t, map[string]bool{engine.CapabilityPairAddKey: true}, keysHandler(&fakeherdr.PairKeys{}, fakeherdr.PairOwner), nil)
		for _, tc := range []struct {
			p    engine.PairAddKeyParams
			want error
		}{
			{engine.PairAddKeyParams{PublicKey: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC", Label: "x"}, engine.ErrPairKeyInvalid},
			{engine.PairAddKeyParams{PublicKey: k.PublicLine + "\n" + k.PublicLine, Label: "x"}, engine.ErrPairKeyInvalid},
			{engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: ""}, engine.ErrPairLabelInvalid},
			{engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: strings.Repeat("x", engine.MaxPairKeyLabel+1)}, engine.ErrPairLabelInvalid},
			{engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: "tab\there"}, engine.ErrPairLabelInvalid},
			// herdr checks the label first.
			{engine.PairAddKeyParams{PublicKey: "nope", Label: ""}, engine.ErrPairLabelInvalid},
		} {
			_, err := c.PairAddKey(ctx(t), tc.p)
			refused(t, err, tc.want)
		}
		if _, err := c.PairAddKey(ctx(t), engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: strings.Repeat("é", engine.MaxPairKeyLabel)}); err != nil {
			t.Fatalf("80 characters: %v", err)
		}
	})
	t.Run("not the owner's own connection", func(t *testing.T) {
		for caller, want := range map[fakeherdr.PairCaller]error{
			fakeherdr.PairGuest:        engine.ErrPairGuestForbidden,
			fakeherdr.PairOwnerBrowser: engine.ErrPairOwnerForbidden,
		} {
			_, c := start(t, map[string]bool{engine.CapabilityPairAddKey: true}, keysHandler(&fakeherdr.PairKeys{}, caller), nil)
			_, err := c.PairAddKey(ctx(t), engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: "x"})
			refused(t, err, want)
			if errors.Is(err, engine.ErrPairKeyInvalid) {
				t.Fatalf("%v matches another code", err)
			}
		}
	})
	t.Run("herdr's other refusals", func(t *testing.T) {
		for _, want := range []*engine.PairKeyError{engine.ErrPairWriteFailed, engine.ErrPairUnsupportedOS, engine.ErrPairReadFailed} {
			_, c := start(t, pairCaps, func(string, json.RawMessage) (any, *fakeherdr.APIError) {
				return nil, &fakeherdr.APIError{Code: want.Code, Message: "no"}
			}, nil)
			_, err := c.PairAddKey(ctx(t), engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: "x"})
			refused(t, err, want)
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
	t.Run("older herdr whose ping failed", func(t *testing.T) {
		h, c := start(t, nil, nil, nil)
		h.pingErr.Store(true)
		if _, err := c.PairAddKeySupported(ctx(t)); err == nil {
			t.Fatal("supported without a ping")
		}
		var unsupported *engine.ErrUnsupported
		if _, err := c.PairAddKey(ctx(t), engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: "x"}); !errors.As(err, &unsupported) {
			t.Fatalf("old herdr: %v", err)
		}
	})
	t.Run("reply without a fingerprint", func(t *testing.T) {
		_, c := start(t, pairCaps, func(string, json.RawMessage) (any, *fakeherdr.APIError) {
			return map[string]any{"type": engine.PairKeyAddedType, "added": true, "already": false}, nil
		}, nil)
		var decode *engine.DecodeError
		if _, err := c.PairAddKey(ctx(t), engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: "x"}); !errors.As(err, &decode) {
			t.Fatalf("%v", err)
		}
	})
	t.Run("reply of another type", func(t *testing.T) {
		_, c := start(t, pairCaps, func(string, json.RawMessage) (any, *fakeherdr.APIError) {
			return map[string]any{"type": "ok"}, nil
		}, nil)
		var tag *engine.ResultTagError
		if _, err := c.PairAddKey(ctx(t), engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: "x"}); !errors.As(err, &tag) {
			t.Fatalf("%v", err)
		}
	})
}

// pair.keys.list and pair.keys.remove see only the herdr-pair lines: a
// user's own line for the same server is never listed or removed.
func TestPairKeysListAndRemove(t *testing.T) {
	keys := &fakeherdr.PairKeys{}
	own, err := pairing.NewPairKey("laptop")
	if err != nil {
		t.Fatal(err)
	}
	ownLine := "ssh-ed25519 " + strings.Fields(own.PublicLine)[1] + " jerry@laptop"
	keys.AddLine(ownLine)
	ownKey, _, _, _, err := ssh.ParseAuthorizedKey([]byte(ownLine))
	if err != nil {
		t.Fatal(err)
	}
	_, c := start(t, pairCaps, keysHandler(keys, fakeherdr.PairOwner), nil)
	if got, err := c.PairKeysList(ctx(t)); err != nil || len(got) != 0 {
		t.Fatalf("list before any add = %+v, %v", got, err)
	}
	var added []engine.PairKeyAdded
	for _, label := range []string{"Jerry's iPhone", "Tablet  "} {
		k, err := pairing.NewPairKey(label)
		if err != nil {
			t.Fatal(err)
		}
		a, err := c.PairAddKey(ctx(t), engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: label})
		if err != nil {
			t.Fatal(err)
		}
		added = append(added, a)
	}
	phone := herdrapi.PairKeyInfo{Fingerprint: added[0].Fingerprint, Label: "Jerry's iPhone", Comment: "herdr-pair:Jerry's iPhone"}
	tablet := herdrapi.PairKeyInfo{Fingerprint: added[1].Fingerprint, Label: "Tablet", Comment: "herdr-pair:Tablet"}
	if got, err := c.PairKeysList(ctx(t)); err != nil || !slices.Equal(got, []herdrapi.PairKeyInfo{phone, tablet}) {
		t.Fatalf("list = %+v, %v", got, err)
	}
	if got, err := c.PairKeysRemove(ctx(t), ssh.FingerprintSHA256(ownKey)); err != nil || len(got) != 0 {
		t.Fatalf("removing the user's own key = %+v, %v", got, err)
	}
	if again, err := c.PairAddKey(ctx(t), engine.PairAddKeyParams{PublicKey: ownLine, Label: "x"}); err != nil || !again.Already || again.Label != "jerry@laptop" {
		t.Fatalf("the user's own key after a remove = %+v, %v", again, err)
	}
	if got, err := c.PairKeysRemove(ctx(t), phone.Fingerprint); err != nil || !slices.Equal(got, []herdrapi.PairKeyInfo{phone}) {
		t.Fatalf("remove phone = %+v, %v", got, err)
	}
	if got, err := c.PairKeysRemove(ctx(t), phone.Fingerprint); err != nil || len(got) != 0 {
		t.Fatalf("remove phone again = %+v, %v", got, err)
	}
	if got, err := c.PairKeysList(ctx(t)); err != nil || !slices.Equal(got, []herdrapi.PairKeyInfo{tablet}) {
		t.Fatalf("list after remove = %+v, %v", got, err)
	}
}

func TestPairKeysListAndRemoveRefusals(t *testing.T) {
	calls := map[string]func(*engine.Client) error{
		"list":   func(c *engine.Client) error { _, err := c.PairKeysList(ctx(t)); return err },
		"remove": func(c *engine.Client) error { _, err := c.PairKeysRemove(ctx(t), "SHA256:x"); return err },
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) {
			for caller, want := range map[fakeherdr.PairCaller]error{
				fakeherdr.PairGuest:        engine.ErrPairGuestForbidden,
				fakeherdr.PairOwnerBrowser: engine.ErrPairOwnerForbidden,
			} {
				_, c := start(t, pairCaps, keysHandler(&fakeherdr.PairKeys{}, caller), nil)
				var api *bridge.APIError
				if err := call(c); !errors.Is(err, want) || !errors.As(err, &api) {
					t.Fatalf("err = %v, want %v", err, want)
				}
			}
			for _, want := range []*engine.PairKeyError{engine.ErrPairReadFailed, engine.ErrPairUnsupportedOS} {
				_, c := start(t, pairCaps, func(string, json.RawMessage) (any, *fakeherdr.APIError) {
					return nil, &fakeherdr.APIError{Code: want.Code, Message: "no"}
				}, nil)
				if err := call(c); !errors.Is(err, want) {
					t.Fatalf("err = %v, want %v", err, want)
				}
			}
			_, c := start(t, map[string]bool{"agent_groups": true}, nil, nil)
			var unsupported *engine.ErrUnsupported
			if err := call(c); !errors.As(err, &unsupported) {
				t.Fatalf("old herdr: %v", err)
			}
		})
	}
}

func TestPairKeyLabel(t *testing.T) {
	for _, tc := range []struct{ device, approver, want string }{
		{"Studio PC", "Jerry's Mac", "Studio PC via Jerry's Mac"},
		{" Studio\n\tPC ", "", "Studio PC"},
		{"", "iPhone", "New device via iPhone"},
		{"Café <PC>", "Mac", "Caf PC via Mac"},
		{"ééé", "Mac", "New device via Mac"},
		{strings.Repeat("a", 40), "Jerry's Mac", strings.Repeat("a", 40)},
		{strings.Repeat("a", 60), "Mac", strings.Repeat("a", engine.MaxStoredPairKeyLabel)},
	} {
		got := engine.PairKeyLabel(tc.device, tc.approver)
		if got != tc.want {
			t.Errorf("PairKeyLabel(%q, %q) = %q, want %q", tc.device, tc.approver, got, tc.want)
		}
		if len(got) > engine.MaxStoredPairKeyLabel {
			t.Errorf("PairKeyLabel(%q, %q) is %d long", tc.device, tc.approver, len(got))
		}
	}
}

// PairKeyLabel's labels are stored as they are.
func TestPairKeyLabelIsStoredAsIs(t *testing.T) {
	_, c := start(t, pairCaps, keysHandler(&fakeherdr.PairKeys{}, fakeherdr.PairOwner), nil)
	for _, devices := range [][2]string{{"Studio PC", "Jerry's Mac"}, {"Café <PC>", "Mac"}, {strings.Repeat("a", 60), "Mac"}, {"", "iPhone"}} {
		k, err := pairing.NewPairKey(devices[0])
		if err != nil {
			t.Fatal(err)
		}
		label := engine.PairKeyLabel(devices[0], devices[1])
		if got, err := c.PairAddKey(ctx(t), engine.PairAddKeyParams{PublicKey: k.PublicLine, Label: label}); err != nil || got.Label != label {
			t.Fatalf("%q stored as %+v, %v", label, got, err)
		}
	}
}
