package account

import (
	"bytes"
	"crypto/ecdh"
	"encoding/json"
	"errors"
	"os"
	"testing"
)

type approveVector struct {
	BrowserPriv  string `json:"browser_priv"`
	ApproverPriv string `json:"approver_priv"`
	BrowserPub   string `json:"browser_pub"`
	ApproverPub  string `json:"approver_pub"`
	NonceB       string `json:"nonce_b"`
	NonceT       string `json:"nonce_t"`
	Commit       string `json:"commit"`
	Code         string `json:"code"`
	Seq          uint64 `json:"seq"`
	EnvelopeJSON string `json:"envelope_json"`
	Sealed       string `json:"sealed"`
}

func loadApproveVector(t *testing.T) (approveVector, x25519Key, x25519Key) {
	t.Helper()
	// AccountService's test/vectors/approve-v1.json, made with node:crypto alone from
	// WIRE-PLAN §2.2-2.3 (RFC 7748 §6.1 keys), so the Go code is checked against a second
	// implementation; the browser's (test/webguestApprove.test.ts) reads the same file.
	raw, err := os.ReadFile("testdata/approve-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var v approveVector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	key := func(s string) x25519Key {
		priv, err := ecdh.X25519().NewPrivateKey(b64(t, s))
		if err != nil {
			t.Fatal(err)
		}
		return x25519Key{priv}
	}
	return v, key(v.BrowserPriv), key(v.ApproverPriv)
}

func TestApproveMatchesTheIndependentVector(t *testing.T) {
	v, browser, approver := loadApproveVector(t)
	B, T := b64(t, v.BrowserPub), b64(t, v.ApproverPub)
	if !bytes.Equal(browser.PublicKey(), B) || !bytes.Equal(approver.PublicKey(), T) {
		t.Fatal("vector keys don't derive their public halves")
	}
	commit, err := ApproveCommit(B, b64(t, v.NonceB))
	if err != nil || !bytes.Equal(commit, b64(t, v.Commit)) {
		t.Fatalf("commit = %x, %v; want the vector's", commit, err)
	}
	code, err := ApproveCode(B, T, b64(t, v.NonceB), b64(t, v.NonceT))
	if err != nil || code != v.Code {
		t.Fatalf("code = %q, %v; want %q", code, err, v.Code)
	}
	// The browser opens what the other implementation sealed, as the approver.
	plain, err := OpenEnvelope(browser, T, v.Seq, v.Sealed)
	if err != nil || string(plain) != v.EnvelopeJSON {
		t.Fatalf("open = %q, %v", plain, err)
	}
}

// A compromised service swaps the browser key or the nonce the browser reveals:
// the approver must refuse, and the codes must differ.
func TestApproveRefusesASwappedKeyOrNonce(t *testing.T) {
	v, _, _ := loadApproveVector(t)
	B, T, nB, nT := b64(t, v.BrowserPub), b64(t, v.ApproverPub), b64(t, v.NonceB), b64(t, v.NonceT)
	commit, _ := ApproveCommit(B, nB)
	if err := ApproveOpen(B, commit, nB); err != nil {
		t.Fatalf("honest reveal refused: %v", err)
	}
	other := bytes.Repeat([]byte{0x44}, 32)
	if err := ApproveOpen(other, commit, nB); !errors.Is(err, ErrApproveTampered) {
		t.Fatalf("swapped browser key: %v, want tampered", err)
	}
	if err := ApproveOpen(B, commit, other); !errors.Is(err, ErrApproveTampered) {
		t.Fatalf("swapped nonce_b: %v, want tampered", err)
	}
	code, _ := ApproveCode(B, T, nB, nT)
	for name, c := range map[string][4][]byte{
		"browser key":  {other, T, nB, nT},
		"approver key": {B, other, nB, nT},
		"nonce_t":      {B, T, nB, other},
	} {
		got, _ := ApproveCode(c[0], c[1], c[2], c[3])
		if got == code {
			t.Errorf("code ignores the %s", name)
		}
	}
	if ApproveCodeMatches("721", code) || ApproveCodeMatches("0000", code) || !ApproveCodeMatches(code, code) {
		t.Error("code comparison")
	}
}

// The browser accepts an envelope only from the approver it verified, at the
// sequence it was sealed for, and only unmodified.
func TestEnvelopeOpensOnlyForItsApproverAndSeq(t *testing.T) {
	_, browser, approver := loadApproveVector(t)
	sealed, err := SealEnvelope(approver, browser.PublicKey(), 3, []byte(`{"v":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if plain, err := OpenEnvelope(browser, approver.PublicKey(), 3, sealed); err != nil || string(plain) != `{"v":1}` {
		t.Fatalf("round trip = %q, %v", plain, err)
	}
	if _, err := OpenEnvelope(browser, approver.PublicKey(), 4, sealed); err == nil {
		t.Error("opened at another seq")
	}
	impostor, _ := ecdh.X25519().GenerateKey(nil)
	if _, err := OpenEnvelope(browser, impostor.PublicKey().Bytes(), 3, sealed); err == nil {
		t.Error("opened as from another approver")
	}
	raw := []byte(sealed)
	raw[len(raw)-5] ^= 1
	if _, err := OpenEnvelope(browser, approver.PublicKey(), 3, string(raw)); err == nil {
		t.Error("opened a modified envelope")
	}
}

// SealedLength is exactly what SealEnvelope produces, so a list measured
// with it is refused by the service only when it would really be too long.
func TestSealedLengthIsTheSealedEnvelopesLength(t *testing.T) {
	approver, browser := fixedKey(t, 0x70), fixedKey(t, 0xb0)
	for _, n := range []int{0, 1, 2, 3, 100, 12_000} {
		sealed, err := SealEnvelope(approver, browser.PublicKey(), 1, make([]byte, n))
		if err != nil {
			t.Fatal(err)
		}
		if got := SealedLength(n); got != len(sealed) {
			t.Fatalf("SealedLength(%d) = %d, sealed %d", n, got, len(sealed))
		}
	}
}
