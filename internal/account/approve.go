package account

// Browser approval, protocol approve-v1 (web owner access WIRE-PLAN §2.2, §2.3):
// a browser B asks a trusted device T to let it reach the owner's machines.
// Each side commits before it learns the other's randomness, and both show a
// 4-digit code over both keys, which the user types on T. T then sends the
// machine list to B sealed between the two verified keys, so the account
// service can neither swap a key nor a machine's node_pub.
//
//	commit = SHA-256("herdrup-approve-v1|commit" ‖ 0x00 ‖ B ‖ nonce_b)
//	h      = SHA-256("herdrup-approve-v1|sas" ‖ 0x00 ‖ B ‖ T ‖ nonce_b ‖ nonce_t)
//	code   = uint32_be(h[0:4]) mod 10000, 4 digits, zero-padded
//	ikm    = X25519(t, B)
//	k      = HKDF-SHA256(ikm, salt = B ‖ T, info = "herdrup-approve-v1|envelope", 32)
//	aad    = "herdrup-approve-v1|envelope" ‖ 0x00 ‖ B ‖ T ‖ uint64_be(seq)
//	sealed = b64url(iv(12) ‖ AES-256-GCM(k, iv, aad, json))
//
// pair-v1 (pair.go) is the same with its own labels, the new device's SSH
// key S after B in both hashes, and S and the request id after T in the
// envelope's AAD; protocol carries the difference.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"
)

const (
	approveKeySize   = 32
	approveNonceSize = 32
)

// protocol is one commit-then-reveal protocol: its labels, and whether the
// requester binds an SSH key S (32 bytes, after B) into the commit and code.
type protocol struct {
	name, commit, sas, envelope string
	ssh                         bool
}

var approveV1 = protocol{
	name:     "approve-v1",
	commit:   "herdrup-approve-v1|commit",
	sas:      "herdrup-approve-v1|sas",
	envelope: "herdrup-approve-v1|envelope",
}

// ErrApproveTampered is a reveal that doesn't open the commit T saw before it
// sent nonce_t: the request must be denied, never approved.
var ErrApproveTampered = errors.New("this request was tampered with")

func labelled(label string, parts ...[]byte) []byte {
	h := sha256.New()
	h.Write([]byte(label))
	h.Write([]byte{0})
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

func (p protocol) checkSizes(keys [][]byte, nonces [][]byte) error {
	for _, k := range keys {
		if len(k) != approveKeySize {
			return fmt.Errorf("%s: key is %d bytes, want %d", p.name, len(k), approveKeySize)
		}
	}
	for _, n := range nonces {
		if len(n) != approveNonceSize {
			return fmt.Errorf("%s: nonce is %d bytes, want %d", p.name, len(n), approveNonceSize)
		}
	}
	return nil
}

// bound is what the hashes take after B: S for pair-v1, nothing for
// approve-v1 (which must be given none).
func (p protocol) bound(sshPub []byte) ([][]byte, error) {
	switch {
	case p.ssh && len(sshPub) != approveKeySize:
		return nil, fmt.Errorf("%s: SSH key is %d bytes, want %d", p.name, len(sshPub), approveKeySize)
	case !p.ssh && sshPub != nil:
		return nil, fmt.Errorf("%s: binds no SSH key", p.name)
	case p.ssh:
		return [][]byte{sshPub}, nil
	}
	return nil, nil
}

// commitOf is the requester's commitment to nonceB for its key requesterPub
// (and sshPub, for pair-v1).
func (p protocol) commitOf(requesterPub, sshPub, nonceB []byte) ([]byte, error) {
	if err := p.checkSizes([][]byte{requesterPub}, [][]byte{nonceB}); err != nil {
		return nil, err
	}
	s, err := p.bound(sshPub)
	if err != nil {
		return nil, err
	}
	parts := append([][]byte{requesterPub}, s...)
	return labelled(p.commit, append(parts, nonceB)...), nil
}

// open checks that nonceB opens commit, the one T was shown before it sent
// nonce_t. A mismatch is ErrApproveTampered.
func (p protocol) open(requesterPub, sshPub, commit, nonceB []byte) error {
	want, err := p.commitOf(requesterPub, sshPub, nonceB)
	if err != nil {
		return err
	}
	if len(commit) != sha256.Size || subtle.ConstantTimeCompare(want, commit) != 1 {
		return ErrApproveTampered
	}
	return nil
}

// code is the 4 digits both sides show.
func (p protocol) code(requesterPub, sshPub, approverPub, nonceB, nonceT []byte) (string, error) {
	if err := p.checkSizes([][]byte{requesterPub, approverPub}, [][]byte{nonceB, nonceT}); err != nil {
		return "", err
	}
	s, err := p.bound(sshPub)
	if err != nil {
		return "", err
	}
	parts := append([][]byte{requesterPub}, s...)
	h := labelled(p.sas, append(parts, approverPub, nonceB, nonceT)...)
	return fmt.Sprintf("%04d", binary.BigEndian.Uint32(h[:4])%10000), nil
}

// aead derives the AES-GCM key between the approver's key and the
// requester's public key. key is the side that holds a private key: T on the
// approving device, B on a requesting device (or in tests).
func (p protocol) aead(key DeviceKey, peerPub, requesterPub, approverPub []byte) (cipher.AEAD, error) {
	if err := p.checkSizes([][]byte{peerPub, requesterPub, approverPub}, nil); err != nil {
		return nil, err
	}
	ikm, err := key.SharedSecret(peerPub)
	if err != nil {
		return nil, err
	}
	if subtle.ConstantTimeCompare(ikm, make([]byte, len(ikm))) == 1 {
		return nil, fmt.Errorf("%s: all-zero shared secret", p.name)
	}
	k, err := hkdf.Key(sha256.New, ikm, append(append([]byte(nil), requesterPub...), approverPub...), p.envelope, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(k)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// checkBinding checks what the envelope's AAD binds after T: S (32 bytes)
// and the request id (22 ASCII characters) for pair-v1; nothing for
// approve-v1, which must be given neither.
func (p protocol) checkBinding(sshPub []byte, requestID string) error {
	switch {
	case !p.ssh && sshPub != nil:
		return fmt.Errorf("%s: binds no SSH key", p.name)
	case !p.ssh && requestID != "":
		return fmt.Errorf("%s: binds no request id", p.name)
	case !p.ssh:
		return nil
	case len(sshPub) != approveKeySize:
		return fmt.Errorf("%s: SSH key is %d bytes, want %d", p.name, len(sshPub), approveKeySize)
	case len(requestID) != pairRequestIDSize:
		return fmt.Errorf("%s: request id is %d characters, want %d", p.name, len(requestID), pairRequestIDSize)
	}
	for i := range len(requestID) {
		if requestID[i] >= utf8.RuneSelf {
			return fmt.Errorf("%s: request id isn't ASCII", p.name)
		}
	}
	return nil
}

// aad is label ‖ 0 ‖ B ‖ T ‖ (S ‖ request id, pair-v1) ‖ uint64_be(seq),
// for a binding checkBinding took.
func (p protocol) aad(requesterPub, approverPub, sshPub []byte, requestID string, seq uint64) []byte {
	aad := make([]byte, 0, len(p.envelope)+1+len(requesterPub)+len(approverPub)+len(sshPub)+len(requestID)+8)
	aad = append(aad, p.envelope...)
	aad = append(aad, 0)
	aad = append(aad, requesterPub...)
	aad = append(aad, approverPub...)
	aad = append(aad, sshPub...)
	aad = append(aad, requestID...)
	return binary.BigEndian.AppendUint64(aad, seq)
}

// seal seals plaintext from approver to the requester's key at seq, bound to
// sshPub and requestID for pair-v1.
func (p protocol) seal(approver DeviceKey, requesterPub, sshPub []byte, requestID string, seq uint64, plaintext []byte) (string, error) {
	approverPub := approver.PublicKey()
	if err := p.checkBinding(sshPub, requestID); err != nil {
		return "", err
	}
	aead, err := p.aead(approver, requesterPub, requesterPub, approverPub)
	if err != nil {
		return "", err
	}
	iv := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(approveRand, iv); err != nil {
		return "", err
	}
	out := aead.Seal(iv, iv, plaintext, p.aad(requesterPub, approverPub, sshPub, requestID, seq))
	return base64.RawURLEncoding.EncodeToString(out), nil
}

// openSealed opens sealed as the requester from approverPub at seq, bound to
// sshPub and requestID for pair-v1.
func (p protocol) openSealed(requester DeviceKey, approverPub, sshPub []byte, requestID string, seq uint64, sealed string) ([]byte, error) {
	requesterPub := requester.PublicKey()
	if err := p.checkBinding(sshPub, requestID); err != nil {
		return nil, err
	}
	aead, err := p.aead(requester, approverPub, requesterPub, approverPub)
	if err != nil {
		return nil, err
	}
	raw, err := base64.RawURLEncoding.DecodeString(sealed)
	if err != nil || len(raw) < aead.NonceSize()+aead.Overhead() {
		return nil, fmt.Errorf("%s: malformed envelope", p.name)
	}
	iv, ct := raw[:aead.NonceSize()], raw[aead.NonceSize():]
	return aead.Open(nil, iv, ct, p.aad(requesterPub, approverPub, sshPub, requestID, seq))
}

// approveRand supplies nonces and IVs; tests make it deterministic.
var approveRand io.Reader = rand.Reader

// NewApproveNonce is a fresh 32-byte nonce; never reuse one.
func NewApproveNonce() ([]byte, error) {
	n := make([]byte, approveNonceSize)
	if _, err := io.ReadFull(approveRand, n); err != nil {
		return nil, err
	}
	return n, nil
}

// ApproveCommit is the browser's commitment to nonceB for its key browserPub.
func ApproveCommit(browserPub, nonceB []byte) ([]byte, error) {
	return approveV1.commitOf(browserPub, nil, nonceB)
}

// ApproveOpen checks that nonceB opens commit for browserPub, the key and
// commit T was shown before it sent nonce_t. A mismatch is ErrApproveTampered.
func ApproveOpen(browserPub, commit, nonceB []byte) error {
	return approveV1.open(browserPub, nil, commit, nonceB)
}

// ApproveCode is the 4 digits both sides show: the browser displays it and the
// user types it on the approving device.
func ApproveCode(browserPub, approverPub, nonceB, nonceT []byte) (string, error) {
	return approveV1.code(browserPub, nil, approverPub, nonceB, nonceT)
}

// ApproveCodeMatches compares a typed code with the computed one in constant time.
func ApproveCodeMatches(typed, code string) bool {
	return len(typed) == 4 && subtle.ConstantTimeCompare([]byte(typed), []byte(code)) == 1
}

// SealEnvelope seals plaintext (the envelope JSON) from approver to the browser
// with key browserPub, at sequence seq.
func SealEnvelope(approver DeviceKey, browserPub []byte, seq uint64, plaintext []byte) (string, error) {
	return approveV1.seal(approver, browserPub, nil, "", seq, plaintext)
}

// MaxSealedLength is the longest sealed envelope the account service takes
// (herdrup AccountService MAX_SEALED_LENGTH); a longer one is refused with 400.
const MaxSealedLength = 16 * 1024

// SealedLength is the length of SealEnvelope's result for an n-byte
// plaintext: base64url of the AES-GCM nonce, ciphertext and tag.
func SealedLength(n int) int {
	const gcmNonce, gcmTag = 12, 16
	return base64.RawURLEncoding.EncodedLen(gcmNonce + n + gcmTag)
}

// OpenEnvelope opens sealed as the browser (key holds b) from approverPub at seq.
func OpenEnvelope(browser DeviceKey, approverPub []byte, seq uint64, sealed string) ([]byte, error) {
	return approveV1.openSealed(browser, approverPub, nil, "", seq, sealed)
}
