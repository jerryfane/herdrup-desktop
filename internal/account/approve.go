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
)

const (
	approveCommitLabel   = "herdrup-approve-v1|commit"
	approveCodeLabel     = "herdrup-approve-v1|sas"
	approveEnvelopeLabel = "herdrup-approve-v1|envelope"
	approveKeySize       = 32
	approveNonceSize     = 32
)

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

func checkSizes(keys [][]byte, nonces [][]byte) error {
	for _, k := range keys {
		if len(k) != approveKeySize {
			return fmt.Errorf("approve-v1: key is %d bytes, want %d", len(k), approveKeySize)
		}
	}
	for _, n := range nonces {
		if len(n) != approveNonceSize {
			return fmt.Errorf("approve-v1: nonce is %d bytes, want %d", len(n), approveNonceSize)
		}
	}
	return nil
}

// NewApproveNonce is a fresh 32-byte nonce; never reuse one.
func NewApproveNonce() ([]byte, error) {
	n := make([]byte, approveNonceSize)
	if _, err := io.ReadFull(rand.Reader, n); err != nil {
		return nil, err
	}
	return n, nil
}

// ApproveCommit is the browser's commitment to nonceB for its key browserPub.
func ApproveCommit(browserPub, nonceB []byte) ([]byte, error) {
	if err := checkSizes([][]byte{browserPub}, [][]byte{nonceB}); err != nil {
		return nil, err
	}
	return labelled(approveCommitLabel, browserPub, nonceB), nil
}

// ApproveOpen checks that nonceB opens commit for browserPub, the key and
// commit T was shown before it sent nonce_t. A mismatch is ErrApproveTampered.
func ApproveOpen(browserPub, commit, nonceB []byte) error {
	want, err := ApproveCommit(browserPub, nonceB)
	if err != nil {
		return err
	}
	if len(commit) != sha256.Size || subtle.ConstantTimeCompare(want, commit) != 1 {
		return ErrApproveTampered
	}
	return nil
}

// ApproveCode is the 4 digits both sides show: the browser displays it and the
// user types it on the approving device.
func ApproveCode(browserPub, approverPub, nonceB, nonceT []byte) (string, error) {
	if err := checkSizes([][]byte{browserPub, approverPub}, [][]byte{nonceB, nonceT}); err != nil {
		return "", err
	}
	h := labelled(approveCodeLabel, browserPub, approverPub, nonceB, nonceT)
	return fmt.Sprintf("%04d", binary.BigEndian.Uint32(h[:4])%10000), nil
}

// ApproveCodeMatches compares a typed code with the computed one in constant time.
func ApproveCodeMatches(typed, code string) bool {
	return len(typed) == 4 && subtle.ConstantTimeCompare([]byte(typed), []byte(code)) == 1
}

// envelopeKey derives the AES key between the approver's key and the browser's
// public key. key is the side that holds a private key: T on the approving
// device, B in tests (the browser side is TypeScript).
func envelopeAEAD(key DeviceKey, peerPub, browserPub, approverPub []byte) (cipher.AEAD, error) {
	if err := checkSizes([][]byte{peerPub, browserPub, approverPub}, nil); err != nil {
		return nil, err
	}
	ikm, err := key.SharedSecret(peerPub)
	if err != nil {
		return nil, err
	}
	if subtle.ConstantTimeCompare(ikm, make([]byte, len(ikm))) == 1 {
		return nil, errors.New("approve-v1: all-zero shared secret")
	}
	k, err := hkdf.Key(sha256.New, ikm, append(append([]byte(nil), browserPub...), approverPub...), approveEnvelopeLabel, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(k)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func envelopeAAD(browserPub, approverPub []byte, seq uint64) []byte {
	aad := append([]byte(approveEnvelopeLabel), 0)
	aad = append(aad, browserPub...)
	aad = append(aad, approverPub...)
	return binary.BigEndian.AppendUint64(aad, seq)
}

// SealEnvelope seals plaintext (the envelope JSON) from approver to the browser
// with key browserPub, at sequence seq.
func SealEnvelope(approver DeviceKey, browserPub []byte, seq uint64, plaintext []byte) (string, error) {
	approverPub := approver.PublicKey()
	aead, err := envelopeAEAD(approver, browserPub, browserPub, approverPub)
	if err != nil {
		return "", err
	}
	iv := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return "", err
	}
	out := aead.Seal(iv, iv, plaintext, envelopeAAD(browserPub, approverPub, seq))
	return base64.RawURLEncoding.EncodeToString(out), nil
}

// OpenEnvelope opens sealed as the browser (key holds b) from approverPub at seq.
func OpenEnvelope(browser DeviceKey, approverPub []byte, seq uint64, sealed string) ([]byte, error) {
	browserPub := browser.PublicKey()
	aead, err := envelopeAEAD(browser, approverPub, browserPub, approverPub)
	if err != nil {
		return nil, err
	}
	raw, err := base64.RawURLEncoding.DecodeString(sealed)
	if err != nil || len(raw) < aead.NonceSize()+aead.Overhead() {
		return nil, errors.New("approve-v1: malformed envelope")
	}
	iv, ct := raw[:aead.NonceSize()], raw[aead.NonceSize():]
	return aead.Open(nil, iv, ct, envelopeAAD(browserPub, approverPub, seq))
}
