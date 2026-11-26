package engine

// pair.add_key (herdr-app PLAN, 26 Nov 2026): the owner's own connection
// adds a new device's SSH key to the server user's ~/.ssh/authorized_keys,
// marked herdr-pair:<label>, so a device approved through the account
// (pair-v1) can sign in directly. The pinned schema (third_party/herdr) has
// neither the method nor the pair_add_key capability yet, so this file
// types them by hand, outside herdrapi.Methods and the generated
// ServerCapabilities. When herdr's PR lands and the pin moves past it, they
// move to the generated types (a herdrapi.Methods entry and a Capability)
// and this file goes.

import (
	"context"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// PairAddKeyMethod is the wire method.
const PairAddKeyMethod = "pair.add_key"

// CapabilityPairAddKey is the ping capability of a herdr with pair.add_key.
const CapabilityPairAddKey = "pair_add_key"

// MaxPairKeyLabel is herdr's limit on a pair key's label, in characters.
const MaxPairKeyLabel = 80

// PairAddKeyParams is pair.add_key's params: PublicKey an "ssh-ed25519
// AAAA…" line, Label 1–80 printable characters (PairKeyLabel).
type PairAddKeyParams struct {
	PublicKey string `json:"public_key"`
	Label     string `json:"label"`
}

// PairKeyAdded is pair.add_key's reply. Added is false, and Already true,
// when the key was there before (the call is idempotent). Fingerprint is
// OpenSSH's "SHA256:…".
type PairKeyAdded struct {
	Added       bool   `json:"added"`
	Already     bool   `json:"already,omitempty"`
	Fingerprint string `json:"fingerprint"`
	Label       string `json:"label"`
}

// PairAddKeySupported reports whether this herdr advertises pair_add_key.
// It pings each time: the cached ping (Supports) decodes the pinned
// schema's capabilities, which don't have the flag.
func (c *Client) PairAddKeySupported(ctx context.Context) (bool, error) {
	var pong struct {
		Capabilities map[string]any `json:"capabilities"`
	}
	if err := c.t.Call(ctx, "ping", herdrapi.PingParams{}, &pong); err != nil {
		return false, err
	}
	ok, _ := pong.Capabilities[CapabilityPairAddKey].(bool)
	return ok, nil
}

// PairAddKey is pair.add_key. A herdr without the method answers
// *ErrUnsupported; one that refuses the caller (a guest, an owner browser,
// a federation peer) a *bridge.APIError with code forbidden.
func (c *Client) PairAddKey(ctx context.Context, p PairAddKeyParams) (PairKeyAdded, error) {
	var out PairKeyAdded
	if err := c.t.Call(ctx, PairAddKeyMethod, p, &out); err != nil {
		return PairKeyAdded{}, c.mapError(PairAddKeyMethod, err)
	}
	if out.Fingerprint == "" {
		return PairKeyAdded{}, &DecodeError{Method: PairAddKeyMethod, Err: errors.New("no fingerprint")}
	}
	return out, nil
}

// PairKeyLabel is the label herdr marks the key with: "<device> (approved
// on <approver>)", control characters and runs of spaces made one space,
// cut to MaxPairKeyLabel characters.
func PairKeyLabel(device, approver string) string {
	clean := func(s string) string {
		return strings.Join(strings.FieldsFunc(strings.Map(func(r rune) rune {
			if !unicode.IsPrint(r) {
				return ' '
			}
			return r
		}, s), unicode.IsSpace), " ")
	}
	device, approver = clean(device), clean(approver)
	if device == "" {
		device = "New device"
	}
	label := device
	if approver != "" {
		label += " (approved on " + approver + ")"
	}
	if utf8.RuneCountInString(label) <= MaxPairKeyLabel {
		return label
	}
	return strings.TrimSpace(string([]rune(label)[:MaxPairKeyLabel]))
}
