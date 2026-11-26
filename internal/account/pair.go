package account

// Pair from another device, protocol pair-v1 (herdr-app PLAN, 26 Nov 2026):
// approve-v1 (approve.go, DESIGN §12) generalised to a native requester. A new
// device N, enrolled with X25519 key B, makes an ed25519 SSH key S for one
// request and asks the account's other devices; an approver T types N's
// code, adds S to the machines it ticks over its own SSH sessions (herdr
// pair.add_key), and seals the machine list to N. S is bound in the commit
// and the code, so the service can't swap it.
//
//	commit = SHA-256("herdrup-pair-v1|commit" ‖ 0x00 ‖ B ‖ S ‖ nonce_b)
//	h      = SHA-256("herdrup-pair-v1|sas" ‖ 0x00 ‖ B ‖ S ‖ T ‖ nonce_b ‖ nonce_t)
//	code   = uint32_be(h[0:4]) mod 10000, 4 digits, zero-padded
//	envelope: approve-v1's, with "herdrup-pair-v1|envelope" for its label
//
// S is the 32 raw bytes of the ed25519 public key.

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/ssh"
)

var pairV1 = protocol{
	name:     "pair-v1",
	commit:   "herdrup-pair-v1|commit",
	sas:      "herdrup-pair-v1|sas",
	envelope: "herdrup-pair-v1|envelope",
	ssh:      true,
}

// PairCommit is the new device's commitment to nonceB for its device key
// requesterPub (B) and the request's SSH key sshPub (S).
func PairCommit(requesterPub, sshPub, nonceB []byte) ([]byte, error) {
	return pairV1.commitOf(requesterPub, sshPub, nonceB)
}

// PairOpen checks that nonceB opens commit for requesterPub and sshPub, the
// keys and commit the approver was shown before it sent nonce_t. A mismatch
// is ErrApproveTampered.
func PairOpen(requesterPub, sshPub, commit, nonceB []byte) error {
	return pairV1.open(requesterPub, sshPub, commit, nonceB)
}

// PairCode is the 4 digits both sides show: the new device displays it and
// the user types it on the approver.
func PairCode(requesterPub, sshPub, approverPub, nonceB, nonceT []byte) (string, error) {
	return pairV1.code(requesterPub, sshPub, approverPub, nonceB, nonceT)
}

// SealPairEnvelope seals plaintext (PairEnvelope JSON) from approver to the
// new device's key requesterPub at seq.
func SealPairEnvelope(approver DeviceKey, requesterPub []byte, seq uint64, plaintext []byte) (string, error) {
	return pairV1.seal(approver, requesterPub, seq, plaintext)
}

// OpenPairEnvelope opens sealed as the new device (key holds b) from
// approverPub at seq.
func OpenPairEnvelope(requester DeviceKey, approverPub []byte, seq uint64, sealed string) ([]byte, error) {
	return pairV1.openSealed(requester, approverPub, seq, sealed)
}

// A machine's status in the envelope: the approver added S to it, S was
// there already, or adding it failed (Reason says why).
const (
	PairAdded   = "added"
	PairAlready = "already"
	PairFailed  = "failed"
)

// PairEnvelopeVersion is the envelope's "v".
const PairEnvelopeVersion = 1

// PairEnvelope is the machine list sealed to the new device: only the
// machines the approver ticked.
type PairEnvelope struct {
	V        int           `json:"v"`
	Machines []PairMachine `json:"machines"`
}

// PairMachine is one ticked machine: where to reach it, its host key as the
// approver pinned it (an OpenSSH public key line), and what adding S did.
type PairMachine struct {
	Nickname string `json:"nickname"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	HostKey  string `json:"host_key"`
	Status   string `json:"status"`
	Reason   string `json:"reason,omitempty"`
}

// ErrPairEnvelopeTooLong is a machine list whose sealed envelope the service
// would refuse (MaxSealedLength).
var ErrPairEnvelopeTooLong = errors.New("pair-v1: too many machines for one envelope")

// The hosts collection's limits (DESIGN §5.1: nickname ≤64, host ≤253,
// username ≤64), so a machine from the envelope syncs as any other.
const (
	maxPairHost     = 253
	maxPairNickname = 64
	maxPairUser     = 64
)

// HostPublicKey parses HostKey. Its pin (bridge.Fingerprint) is what the
// new device pins for the machine before it connects.
func (m PairMachine) HostPublicKey() (ssh.PublicKey, error) {
	if strings.ContainsAny(m.HostKey, "\r\n") {
		return nil, errors.New("pair-v1: host key spans lines")
	}
	key, _, _, rest, err := ssh.ParseAuthorizedKey([]byte(m.HostKey))
	if err != nil {
		return nil, fmt.Errorf("pair-v1: host key: %w", err)
	}
	if len(rest) != 0 {
		return nil, errors.New("pair-v1: host key spans lines")
	}
	return key, nil
}

func (m PairMachine) check() error {
	switch {
	case m.Host == "" || len(m.Host) > maxPairHost || strings.ContainsAny(m.Host, " \t\r\n@"):
		return fmt.Errorf("pair-v1: machine host %q", m.Host)
	case m.Port < 1 || m.Port > 65535:
		return fmt.Errorf("pair-v1: machine port %d", m.Port)
	case m.User == "" || utf8.RuneCountInString(m.User) > maxPairUser || strings.ContainsAny(m.User, " \t\r\n@"):
		return fmt.Errorf("pair-v1: machine user %q", m.User)
	case utf8.RuneCountInString(m.Nickname) > maxPairNickname:
		return fmt.Errorf("pair-v1: machine nickname %q", m.Nickname)
	}
	switch m.Status {
	case PairAdded, PairAlready:
		if _, err := m.HostPublicKey(); err != nil {
			return err
		}
	case PairFailed:
		if m.HostKey != "" {
			if _, err := m.HostPublicKey(); err != nil {
				return err
			}
		}
	default:
		return fmt.Errorf("pair-v1: machine status %q", m.Status)
	}
	return nil
}

// Marshal is e's JSON, checked: version 1, every machine well formed, and
// short enough that its sealed envelope fits the service.
func (e PairEnvelope) Marshal() ([]byte, error) {
	if e.V != PairEnvelopeVersion {
		return nil, fmt.Errorf("pair-v1: envelope version %d", e.V)
	}
	if e.Machines == nil {
		e.Machines = []PairMachine{}
	}
	for _, m := range e.Machines {
		if err := m.check(); err != nil {
			return nil, err
		}
	}
	raw, err := json.Marshal(e)
	if err != nil {
		return nil, err
	}
	if SealedLength(len(raw)) > MaxSealedLength {
		return nil, ErrPairEnvelopeTooLong
	}
	return raw, nil
}

// ParsePairEnvelope reads an opened envelope, with Marshal's checks.
func ParsePairEnvelope(plain []byte) (PairEnvelope, error) {
	var e PairEnvelope
	if err := json.Unmarshal(plain, &e); err != nil {
		return PairEnvelope{}, fmt.Errorf("pair-v1: envelope: %w", err)
	}
	if e.V != PairEnvelopeVersion {
		return PairEnvelope{}, fmt.Errorf("pair-v1: envelope version %d", e.V)
	}
	for _, m := range e.Machines {
		if err := m.check(); err != nil {
			return PairEnvelope{}, err
		}
	}
	return e, nil
}

// SSHAuthorizedKey is S as the "ssh-ed25519 AAAA…" line herdr's
// pair.add_key takes.
func SSHAuthorizedKey(sshPub []byte) (string, error) {
	if len(sshPub) != ed25519.PublicKeySize {
		return "", fmt.Errorf("pair-v1: SSH key is %d bytes, want %d", len(sshPub), ed25519.PublicKeySize)
	}
	key, err := ssh.NewPublicKey(ed25519.PublicKey(sshPub))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))), nil
}
