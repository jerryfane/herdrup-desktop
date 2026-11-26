package engine

// pair.add_key (jerryfane/herdr#529): the owner's own connection adds a new
// device's SSH key to the server user's ~/.ssh/authorized_keys, marked
// herdr-pair:<label>, so a device approved through the account (pair-v1)
// can sign in directly. The pinned schema (third_party/herdr) has neither
// the method nor the pair_add_key capability yet, so this file types them
// by hand, outside herdrapi.Methods and the generated ServerCapabilities.
// When #529 lands and the pin moves past it, they move to the generated
// types (a herdrapi.Methods entry and a Capability) and this file goes.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// PairAddKeyMethod is the wire method.
const PairAddKeyMethod = "pair.add_key"

// CapabilityPairAddKey is the ping capability of a herdr with pair.add_key.
const CapabilityPairAddKey = "pair_add_key"

// MaxPairKeyLabel is herdr's limit on the label pair.add_key takes, in
// characters; a longer one, an empty one, or one with a control character
// is refused with ErrPairLabelInvalid.
const MaxPairKeyLabel = 80

// MaxStoredPairKeyLabel is the longest label herdr stores: it keeps only
// letters, digits, space and -_.' of the one given, spaces collapsed, and
// cuts it to this many characters (as for herdr pair).
const MaxStoredPairKeyLabel = 48

// PairKeyError is a refusal of pair.add_key, compared by Code with
// errors.Is against the Err* values below; it wraps herdr's
// *bridge.APIError.
type PairKeyError struct {
	Code string
	api  error
}

// The refusals pair.add_key can answer (herdr#529).
var (
	// ErrPairKeyInvalid: the key isn't one ssh-ed25519 public key line.
	ErrPairKeyInvalid = &PairKeyError{Code: "pair_key_invalid"}
	// ErrPairLabelInvalid: the label is empty, over MaxPairKeyLabel
	// characters, or has a control character.
	ErrPairLabelInvalid = &PairKeyError{Code: "pair_label_invalid"}
	// ErrPairGuestForbidden: the connection is a guest's.
	ErrPairGuestForbidden = &PairKeyError{Code: "guest_forbidden"}
	// ErrPairOwnerForbidden: the connection is an owner browser's (owner
	// access), not the owner's own SSH session.
	ErrPairOwnerForbidden = &PairKeyError{Code: "owner_forbidden"}
	// ErrPairWriteFailed: herdr couldn't write authorized_keys.
	ErrPairWriteFailed = &PairKeyError{Code: "pair_write_failed"}
	// ErrPairUnsupportedOS: the machine isn't macOS or Linux.
	ErrPairUnsupportedOS = &PairKeyError{Code: "pair_unsupported"}
	// ErrPairReadFailed: the key was there already, and herdr couldn't
	// read authorized_keys back for its stored label (pair_io_failed).
	ErrPairReadFailed = &PairKeyError{Code: "pair_io_failed"}
)

var pairKeyErrors = []*PairKeyError{ErrPairKeyInvalid, ErrPairLabelInvalid, ErrPairGuestForbidden,
	ErrPairOwnerForbidden, ErrPairWriteFailed, ErrPairUnsupportedOS, ErrPairReadFailed}

func (e *PairKeyError) Error() string {
	switch e.Code {
	case ErrPairKeyInvalid.Code:
		return "herdr refused the new device's key"
	case ErrPairLabelInvalid.Code:
		return "herdr refused the key's name"
	case ErrPairGuestForbidden.Code, ErrPairOwnerForbidden.Code:
		return "only the owner's own connection can add a device key"
	case ErrPairWriteFailed.Code:
		return "herdr couldn't write authorized_keys"
	case ErrPairUnsupportedOS.Code:
		return "device keys need a macOS or Linux machine"
	case ErrPairReadFailed.Code:
		return "herdr couldn't read authorized_keys"
	}
	return "herdr refused the key: " + e.Code
}

func (e *PairKeyError) Unwrap() error { return e.api }

func (e *PairKeyError) Is(target error) bool {
	t, ok := target.(*PairKeyError)
	return ok && t.Code == e.Code
}

// PairKeyAddedType is pair.add_key's reply type.
const PairKeyAddedType = "pair_key_added"

// PairAddKeyParams is pair.add_key's params: PublicKey an "ssh-ed25519
// AAAA…" line, Label 1–80 characters with no control characters
// (PairKeyLabel).
type PairAddKeyParams struct {
	PublicKey string `json:"public_key"`
	Label     string `json:"label"`
}

// PairKeyAdded is pair.add_key's reply. Added is false, and Already true,
// when the key was there before (the call is idempotent). Fingerprint is
// OpenSSH's "SHA256:…". Label is the one herdr stored (MaxStoredPairKeyLabel),
// which is the one to show: when the key was there before, the label it
// was stored with then (empty for a line that isn't herdr's and has no
// comment), not the one this call asked for.
type PairKeyAdded struct {
	Added       bool   `json:"added"`
	Already     bool   `json:"already"`
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
// *ErrUnsupported; its refusals are *PairKeyError (ErrPairKeyInvalid …),
// any other error as the transport gave it. A reply of another type, or
// without a fingerprint, is a *DecodeError.
func (c *Client) PairAddKey(ctx context.Context, p PairAddKeyParams) (PairKeyAdded, error) {
	var out struct {
		Type string `json:"type"`
		PairKeyAdded
	}
	if err := c.t.Call(ctx, PairAddKeyMethod, p, &out); err != nil {
		var api *bridge.APIError
		if errors.As(err, &api) {
			for _, known := range pairKeyErrors {
				if api.Code == known.Code {
					return PairKeyAdded{}, &PairKeyError{Code: api.Code, api: err}
				}
			}
		}
		return PairKeyAdded{}, c.mapError(PairAddKeyMethod, err)
	}
	switch {
	case out.Type != PairKeyAddedType:
		return PairKeyAdded{}, &DecodeError{Method: PairAddKeyMethod, Err: fmt.Errorf("reply type %q, want %q", out.Type, PairKeyAddedType)}
	case out.Fingerprint == "":
		return PairKeyAdded{}, &DecodeError{Method: PairAddKeyMethod, Err: errors.New("no fingerprint")}
	}
	return out.PairKeyAdded, nil
}

// PairKeyLabel is the label to mark the key with: "<device> via
// <approver>" in the characters herdr stores, so the label it stores is
// this one; just the device when both don't fit MaxStoredPairKeyLabel.
func PairKeyLabel(device, approver string) string {
	device, approver = storedPairLabel(device), storedPairLabel(approver)
	if device == "" {
		device = "New device"
	}
	if label := device + " via " + approver; approver != "" && len(label) <= MaxStoredPairKeyLabel {
		return label
	}
	return device
}

// storedPairLabel is s as herdr stores a label (sanitize_device_label):
// whitespace made spaces, anything but ASCII letters, digits and space
// -_.' dropped, spaces collapsed and trimmed, cut to MaxStoredPairKeyLabel.
func storedPairLabel(s string) string {
	kept := strings.Map(func(r rune) rune {
		switch {
		case unicode.IsSpace(r):
			return ' '
		case r < utf8.RuneSelf && (unicode.IsLetter(r) || unicode.IsDigit(r) || strings.ContainsRune(" -_.'", r)):
			return r
		}
		return -1
	}, s)
	label := strings.Join(strings.Fields(kept), " ")
	if len(label) > MaxStoredPairKeyLabel {
		label = strings.TrimSpace(label[:MaxStoredPairKeyLabel])
	}
	return label
}
