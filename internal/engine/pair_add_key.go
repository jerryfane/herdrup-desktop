package engine

// pair.add_key, pair.keys.list and pair.keys.remove (jerryfane/herdr#529,
// pinned at 35b59399): the owner's own connection adds a new device's SSH
// key to the server user's ~/.ssh/authorized_keys, marked
// herdr-pair:<label>, so a device approved through the account (pair-v1)
// can sign in directly, and lists or removes the keys it added that way.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// The wire methods.
const (
	PairAddKeyMethod     = "pair.add_key"
	pairKeysListMethod   = "pair.keys.list"
	pairKeysRemoveMethod = "pair.keys.remove"
)

// MaxPairKeyLabel is herdr's limit on the label pair.add_key takes, in
// characters; a longer one, an empty one, or one with a control character
// is refused with ErrPairLabelInvalid.
const MaxPairKeyLabel = 80

// MaxStoredPairKeyLabel is the longest label herdr stores: it keeps only
// letters, digits, space and -_.' of the one given, spaces collapsed, and
// cuts it to this many characters (as for herdr pair).
const MaxStoredPairKeyLabel = 48

// PairKeyError is a refusal of pair.add_key, pair.keys.list or
// pair.keys.remove, compared by Code with errors.Is against the Err* values
// below; it wraps herdr's *bridge.APIError.
type PairKeyError struct {
	Code string
	api  error
}

// The refusals pair.* can answer (herdr#529); list and remove answer only
// the forbidden ones, ErrPairUnsupportedOS and ErrPairReadFailed.
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
	// ErrPairReadFailed (pair_io_failed): herdr couldn't read
	// authorized_keys (a key there already, for its stored label; a list),
	// or rewrite it (a remove).
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
		return "only the owner's own connection can manage device keys"
	case ErrPairWriteFailed.Code:
		return "herdr couldn't write authorized_keys"
	case ErrPairUnsupportedOS.Code:
		return "device keys need a macOS or Linux machine"
	case ErrPairReadFailed.Code:
		return "herdr couldn't read or rewrite authorized_keys"
	}
	return "herdr refused the key: " + e.Code
}

func (e *PairKeyError) Unwrap() error { return e.api }

func (e *PairKeyError) Is(target error) bool {
	t, ok := target.(*PairKeyError)
	return ok && t.Code == e.Code
}

// PairAddKeyParams is pair.add_key's params: PublicKey an "ssh-ed25519
// AAAA…" line, Label 1–80 characters with no control characters
// (PairKeyLabel).
type PairAddKeyParams = herdrapi.PairAddKeyParams

// PairKeyAdded is pair.add_key's reply. Added is false, and Already true,
// when the key was there before (the call is idempotent). Fingerprint is
// OpenSSH's "SHA256:…". Label is the one herdr stored (MaxStoredPairKeyLabel),
// which is the one to show: when the key was there before, the label it
// was stored with then (empty for a line that isn't herdr's and has no
// comment), not the one this call asked for.
type PairKeyAdded = herdrapi.ResponseResultPairKeyAdded

// PairAddKeySupported reports whether this herdr advertises pair_add_key,
// from the cached ping (probing once).
func (c *Client) PairAddKeySupported(ctx context.Context) (bool, error) {
	pong, err := c.probe(ctx)
	if err != nil {
		return false, err
	}
	return herdrapi.CapabilityPairAddKey.Supported(pong.Capabilities), nil
}

// PairAddKey is pair.add_key. A herdr without it answers *ErrUnsupported;
// its refusals are *PairKeyError (ErrPairKeyInvalid …), any other error as
// the transport gave it. A reply of another type is a *ResultTagError, one
// missing a field (or with an empty fingerprint) a *DecodeError.
func (c *Client) PairAddKey(ctx context.Context, p PairAddKeyParams) (PairKeyAdded, error) {
	added, raw, err := callRaw[herdrapi.ResponseResultPairKeyAdded](ctx, c, PairAddKeyMethod, p)
	if err != nil {
		return PairKeyAdded{}, pairKeyError(err)
	}
	if _, err := requireFields(PairAddKeyMethod, raw, "added", "already", "fingerprint", "label"); err != nil {
		return PairKeyAdded{}, err
	}
	if added.Fingerprint == "" {
		return PairKeyAdded{}, &DecodeError{Method: PairAddKeyMethod, Err: errors.New("empty fingerprint")}
	}
	return added, nil
}

// PairKeysList is pair.keys.list: the herdr-pair keys in authorized_keys,
// in file order (never the user's own lines). Errors as PairAddKey's; a
// reply without its keys array is a *DecodeError.
func (c *Client) PairKeysList(ctx context.Context) ([]herdrapi.PairKeyInfo, error) {
	list, raw, err := callRaw[herdrapi.ResponseResultPairKeysList](ctx, c, pairKeysListMethod, herdrapi.PairKeysListParams{})
	if err != nil {
		return nil, pairKeyError(err)
	}
	if err := requireKeys(pairKeysListMethod, raw, "keys"); err != nil {
		return nil, err
	}
	return list.Keys, nil
}

// PairKeysRemove is pair.keys.remove: it removes the herdr-pair lines with
// fingerprint (OpenSSH "SHA256:…") and returns them, none when no
// herdr-pair line has it (a user's own line is never removed). Errors as
// PairAddKey's; a reply without its removed array is a *DecodeError.
func (c *Client) PairKeysRemove(ctx context.Context, fingerprint string) ([]herdrapi.PairKeyInfo, error) {
	removed, raw, err := callRaw[herdrapi.ResponseResultPairKeysRemoved](ctx, c, pairKeysRemoveMethod, herdrapi.PairKeysRemoveParams{Fingerprint: fingerprint})
	if err != nil {
		return nil, pairKeyError(err)
	}
	if err := requireKeys(pairKeysRemoveMethod, raw, "removed"); err != nil {
		return nil, err
	}
	return removed.Removed, nil
}

// requireFields is the object raw, or a *DecodeError unless it has each
// field, and not null: the generated types decode a missing or null one as
// its zero.
func requireFields(method string, raw json.RawMessage, fields ...string) (map[string]json.RawMessage, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, &DecodeError{Method: method, Err: err}
	}
	for _, field := range fields {
		if v, ok := object[field]; !ok || string(v) == "null" {
			return nil, &DecodeError{Method: method, Err: fmt.Errorf("no %s", field)}
		}
	}
	return object, nil
}

// requireKeys is requireFields for a reply whose field is an array of
// PairKeyInfo, each with every field.
func requireKeys(method string, raw json.RawMessage, field string) error {
	object, err := requireFields(method, raw, field)
	if err != nil {
		return err
	}
	var keys []json.RawMessage
	if err := json.Unmarshal(object[field], &keys); err != nil {
		return &DecodeError{Method: method, Err: err}
	}
	for _, key := range keys {
		if _, err := requireFields(method, key, "fingerprint", "label", "comment"); err != nil {
			return err
		}
	}
	return nil
}

// pairKeyError is err as a *PairKeyError when herdr refused with one of
// pairKeyErrors' codes.
func pairKeyError(err error) error {
	var api *bridge.APIError
	if errors.As(err, &api) {
		for _, known := range pairKeyErrors {
			if api.Code == known.Code {
				return &PairKeyError{Code: api.Code, api: err}
			}
		}
	}
	return err
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
