package account

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

// pairInputs are fixed keys and nonces: B and T X25519 keys, S an ed25519
// public key, the two nonces.
func pairInputs(t *testing.T) (requester, approver x25519Key, S, nB, nT []byte) {
	t.Helper()
	pub := ed25519.NewKeyFromSeed(make32(0x5a)).Public().(ed25519.PublicKey)
	return fixedKey(t, 0xb0), fixedKey(t, 0x70), []byte(pub), make32(0x11), make32(0x22)
}

// spec is the contract's hash, written out on its own: SHA-256(label ‖ 0x00 ‖ parts…).
func spec(label string, parts ...[]byte) []byte {
	in := append([]byte(label), 0)
	for _, p := range parts {
		in = append(in, p...)
	}
	sum := sha256.Sum256(in)
	return sum[:]
}

// The commit and code are the contract's: the pair-v1 labels, with S after
// B in both. A wrong label or a missing S gives other bytes.
func TestPairCommitAndCodeAreTheContracts(t *testing.T) {
	requester, approver, S, nB, nT := pairInputs(t)
	B, T := requester.PublicKey(), approver.PublicKey()
	commit, err := PairCommit(B, S, nB)
	if err != nil || !bytes.Equal(commit, spec("herdrup-pair-v1|commit", B, S, nB)) {
		t.Fatalf("commit = %x, %v; want the contract's", commit, err)
	}
	h := spec("herdrup-pair-v1|sas", B, S, T, nB, nT)
	want := fmt.Sprintf("%04d", binary.BigEndian.Uint32(h[:4])%10000)
	code, err := PairCode(B, S, T, nB, nT)
	if err != nil || code != want || len(code) != 4 {
		t.Fatalf("code = %q, %v; want %q", code, err, want)
	}
	if err := PairOpen(B, S, commit, nB); err != nil {
		t.Fatalf("honest reveal refused: %v", err)
	}
	// approve-v1 over the same B and nonce is another commit: one protocol's
	// commit never opens as the other's.
	if browser, _ := ApproveCommit(B, nB); bytes.Equal(browser, commit) {
		t.Fatal("pair-v1 commit equals approve-v1's")
	}
}

// A service that swaps S or B (or the nonce) can't make the reveal open the
// commit, and the codes then differ.
func TestSwappingTheSSHKeyOrTheDeviceKeyChangesCommitAndCode(t *testing.T) {
	requester, approver, S, nB, nT := pairInputs(t)
	B, T := requester.PublicKey(), approver.PublicKey()
	commit, _ := PairCommit(B, S, nB)
	code, _ := PairCode(B, S, T, nB, nT)
	otherS := []byte(ed25519.NewKeyFromSeed(make32(0x6b)).Public().(ed25519.PublicKey))
	otherB := fixedKey(t, 0xc0).PublicKey()
	for name, c := range map[string][2][]byte{"S": {B, otherS}, "B": {otherB, S}} {
		swapped, err := PairCommit(c[0], c[1], nB)
		if err != nil || bytes.Equal(swapped, commit) {
			t.Errorf("a swapped %s gives the same commit (%v)", name, err)
		}
		if err := PairOpen(c[0], c[1], commit, nB); !errors.Is(err, ErrApproveTampered) {
			t.Errorf("a swapped %s opens the commit: %v", name, err)
		}
		if got, _ := PairCode(c[0], c[1], T, nB, nT); got == code {
			t.Errorf("the code ignores %s", name)
		}
	}
	if err := PairOpen(B, S, commit, nT); !errors.Is(err, ErrApproveTampered) {
		t.Errorf("another nonce_b opens the commit: %v", err)
	}
	for name, c := range map[string][2][]byte{"T": {otherB, nT}, "nonce_t": {T, nB}} {
		if got, _ := PairCode(B, S, c[0], nB, c[1]); got == code {
			t.Errorf("the code ignores %s", name)
		}
	}
	if _, err := PairCommit(B, S[:31], nB); err == nil {
		t.Error("a 31-byte S was taken")
	}
	if _, err := PairCode(B, nil, T, nB, nT); err == nil {
		t.Error("a code without S was made")
	}
}

// pairRequestID is a request id of the service's shape: 22 ASCII characters.
const pairRequestID = "p0123456789abcdefghijk"

// The envelope is approve-v1's construction under the pair-v1 label, with
// S and the request id bound in the AAD, checked against the contract
// written out here: HKDF over X25519(t, B) with salt B ‖ T, AES-256-GCM
// with aad label ‖ 0x00 ‖ B ‖ T ‖ S ‖ request_id ‖ u64be(seq).
func TestPairEnvelopeIsApproveV1sWithThePairLabelAndBinding(t *testing.T) {
	requester, approver, S, _, _ := pairInputs(t)
	B, T := requester.PublicKey(), approver.PublicKey()
	label := "herdrup-pair-v1|envelope"
	ikm, _ := approver.SharedSecret(B)
	k, err := hkdf.Key(sha256.New, ikm, append(append([]byte(nil), B...), T...), label, 32)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := aes.NewCipher(k)
	gcm, _ := cipher.NewGCM(block)
	aad := append(append([]byte(label), 0), B...)
	aad = append(append(append(aad, T...), S...), pairRequestID...)
	aad = binary.BigEndian.AppendUint64(aad, 9)

	sealed, err := SealPairEnvelope(approver, B, S, pairRequestID, 9, []byte(`{"v":1,"machines":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := base64.RawURLEncoding.DecodeString(sealed)
	plain, err := gcm.Open(nil, raw[:12], raw[12:], aad)
	if err != nil || string(plain) != `{"v":1,"machines":[]}` {
		t.Fatalf("the contract's key and aad don't open SealPairEnvelope's: %q, %v", plain, err)
	}
	iv := make([]byte, 12)
	theirs := base64.RawURLEncoding.EncodeToString(gcm.Seal(iv, iv, []byte(`{"v":1}`), aad))
	if plain, err := OpenPairEnvelope(requester, T, S, pairRequestID, 9, theirs); err != nil || string(plain) != `{"v":1}` {
		t.Fatalf("OpenPairEnvelope of the contract's = %q, %v", plain, err)
	}
	if _, err := OpenEnvelope(requester, T, 9, sealed); err == nil {
		t.Fatal("an approve-v1 opener opened a pair-v1 envelope")
	}
}

// The new device opens an envelope only for its own key B, from the
// approver T it computed the code with, for the SSH key S and request it
// made, at the seq it was sealed for, and only unmodified.
func TestPairEnvelopeRoundTripsAndIsBoundToBTSIDAndSeq(t *testing.T) {
	requester, approver, S, _, _ := pairInputs(t)
	T := approver.PublicKey()
	sealed, err := SealPairEnvelope(approver, requester.PublicKey(), S, pairRequestID, 3, []byte(`{"v":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if plain, err := OpenPairEnvelope(requester, T, S, pairRequestID, 3, sealed); err != nil || string(plain) != `{"v":1}` {
		t.Fatalf("round trip = %q, %v", plain, err)
	}
	otherS := []byte(ed25519.NewKeyFromSeed(make32(0x6b)).Public().(ed25519.PublicKey))
	impostor, _ := ecdh.X25519().GenerateKey(nil)
	for name, open := range map[string]func() ([]byte, error){
		"B": func() ([]byte, error) { return OpenPairEnvelope(fixedKey(t, 0xc0), T, S, pairRequestID, 3, sealed) },
		"T": func() ([]byte, error) {
			return OpenPairEnvelope(requester, impostor.PublicKey().Bytes(), S, pairRequestID, 3, sealed)
		},
		"S":   func() ([]byte, error) { return OpenPairEnvelope(requester, T, otherS, pairRequestID, 3, sealed) },
		"id":  func() ([]byte, error) { return OpenPairEnvelope(requester, T, S, "p0123456789abcdefghijK", 3, sealed) },
		"seq": func() ([]byte, error) { return OpenPairEnvelope(requester, T, S, pairRequestID, 4, sealed) },
	} {
		if _, err := open(); err == nil {
			t.Errorf("opened with another %s", name)
		}
	}
	for _, i := range []int{0, len(sealed) / 2, len(sealed) - 5} {
		raw := []byte(sealed)
		raw[i] ^= 1
		if _, err := OpenPairEnvelope(requester, T, S, pairRequestID, 3, string(raw)); err == nil {
			t.Errorf("opened an envelope modified at %d", i)
		}
	}
	if _, err := OpenPairEnvelope(requester, T, S, pairRequestID, 3, sealed[:20]); err == nil {
		t.Error("opened a cut envelope")
	}
}

// The request id the AAD binds is exactly 22 ASCII characters, and S 32
// bytes; approve-v1 binds neither.
func TestPairEnvelopeRefusesAMalformedBinding(t *testing.T) {
	requester, approver, S, _, _ := pairInputs(t)
	B, T := requester.PublicKey(), approver.PublicKey()
	for _, id := range []string{"", pairRequestID[:21], pairRequestID + "x", "p0123456789abcdefghié"} {
		if _, err := SealPairEnvelope(approver, B, S, id, 1, []byte(`{}`)); err == nil {
			t.Errorf("sealed for request id %q", id)
		}
		if _, err := OpenPairEnvelope(requester, T, S, id, 1, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"); err == nil || strings.Contains(err.Error(), "authentication") {
			t.Errorf("opened for request id %q: %v", id, err)
		}
	}
	if _, err := SealPairEnvelope(approver, B, S[:31], pairRequestID, 1, []byte(`{}`)); err == nil {
		t.Error("sealed for a 31-byte S")
	}
	if _, err := approveV1.seal(approver, B, nil, pairRequestID, 1, []byte(`{}`)); err == nil {
		t.Error("approve-v1 bound a request id")
	}
	if _, err := approveV1.seal(approver, B, S, "", 1, []byte(`{}`)); err == nil {
		t.Error("approve-v1 bound an SSH key")
	}
}

func hostKeyLine(t *testing.T, seed byte) string {
	t.Helper()
	key, err := ssh.NewPublicKey(ed25519.NewKeyFromSeed(make32(seed)).Public())
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
}

// The machine list is the contract's JSON and is checked both ways: a
// machine the new device couldn't save, or a list the service would refuse,
// isn't sent or taken.
func TestPairEnvelopeJSON(t *testing.T) {
	added := PairMachine{Nickname: "fleet-hel1", Host: "100.64.0.7", Port: 22, User: "jerry", HostKey: hostKeyLine(t, 1), Status: PairAdded}
	failed := PairMachine{Nickname: "build-box", Host: "build.local", Port: 2222, User: "ci", HostKey: hostKeyLine(t, 2), Status: PairFailed, Reason: "unreachable"}
	env := PairEnvelope{V: 1, Machines: []PairMachine{added, failed}}
	raw, err := env.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	var generic map[string]any
	_ = json.Unmarshal(raw, &generic)
	m0 := generic["machines"].([]any)[0].(map[string]any)
	if generic["v"] != 1.0 || m0["host_key"] != added.HostKey || m0["status"] != "added" || len(m0) != 6 {
		t.Fatalf("envelope JSON %s", raw)
	}
	back, err := ParsePairEnvelope(raw)
	if err != nil || len(back.Machines) != 2 || back.Machines[1] != failed {
		t.Fatalf("parse = %+v, %v", back, err)
	}
	if key, err := back.Machines[0].HostPublicKey(); err != nil || key.Type() != ssh.KeyAlgoED25519 {
		t.Fatalf("host key %v, %v", key, err)
	}
	if raw, _ := (PairEnvelope{V: 1}).Marshal(); string(raw) != `{"v":1,"machines":[]}` {
		t.Errorf("empty list = %s", raw)
	}

	bad := map[string]func(m *PairMachine){
		"status":         func(m *PairMachine) { m.Status = "maybe" },
		"port 0":         func(m *PairMachine) { m.Port = 0 },
		"port too big":   func(m *PairMachine) { m.Port = 65536 },
		"no host":        func(m *PairMachine) { m.Host = "" },
		"no user":        func(m *PairMachine) { m.User = "" },
		"no host key":    func(m *PairMachine) { m.HostKey = "" },
		"bad host key":   func(m *PairMachine) { m.HostKey = "ssh-ed25519 AAAA" },
		"two host keys":  func(m *PairMachine) { m.HostKey += "\n" + hostKeyLine(t, 3) },
		"long nickname":  func(m *PairMachine) { m.Nickname = strings.Repeat("n", 65) },
		"user with @":    func(m *PairMachine) { m.User = "a@b" },
		"host with nl":   func(m *PairMachine) { m.Host = "a\nb" },
		"long host name": func(m *PairMachine) { m.Host = strings.Repeat("h", 254) },
	}
	for name, change := range bad {
		m := added
		change(&m)
		if _, err := (PairEnvelope{V: 1, Machines: []PairMachine{m}}).Marshal(); err == nil {
			t.Errorf("%s: marshalled", name)
		}
		raw, _ := json.Marshal(PairEnvelope{V: 1, Machines: []PairMachine{m}})
		if _, err := ParsePairEnvelope(raw); err == nil {
			t.Errorf("%s: parsed", name)
		}
	}
	if _, err := ParsePairEnvelope([]byte(`{"v":2,"machines":[]}`)); err == nil {
		t.Error("a v2 envelope parsed")
	}
	if _, err := (PairEnvelope{V: 2}).Marshal(); err == nil {
		t.Error("a v2 envelope marshalled")
	}
	many := PairEnvelope{V: 1}
	for range 200 {
		many.Machines = append(many.Machines, added)
	}
	if _, err := many.Marshal(); !errors.Is(err, ErrPairEnvelopeTooLong) {
		t.Fatalf("200 machines: %v, want too long", err)
	}
}

func TestSSHAuthorizedKeyIsHerdrsLine(t *testing.T) {
	_, _, S, _, _ := pairInputs(t)
	line, err := SSHAuthorizedKey(S)
	if err != nil {
		t.Fatal(err)
	}
	key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(line))
	if err != nil || key.Type() != ssh.KeyAlgoED25519 || !bytes.Equal(key.(ssh.CryptoPublicKey).CryptoPublicKey().(ed25519.PublicKey), S) || strings.Count(line, " ") != 1 {
		t.Fatalf("line %q: %v", line, err)
	}
	if _, err := SSHAuthorizedKey(S[:31]); err == nil {
		t.Fatal("a 31-byte key made a line")
	}
}

// pairVector is AccountService's test/vectors/pair-v1.json.
type pairVector struct {
	RequesterPriv string `json:"requester_priv"`
	ApproverPriv  string `json:"approver_priv"`
	RequesterPub  string `json:"requester_pub"`
	ApproverPub   string `json:"approver_pub"`
	SSHPub        string `json:"ssh_pub"`
	NonceB        string `json:"nonce_b"`
	NonceT        string `json:"nonce_t"`
	Commit        string `json:"commit"`
	Code          string `json:"code"`
	Seq           uint64 `json:"seq"`
	EnvelopeJSON  string `json:"envelope_json"`
	Sealed        string `json:"sealed"`
	RequestID     string `json:"request_id"`
}

// testdata/pair-v1.json is AccountService's test/vectors/pair-v1.json
// (themartianapp/herdrup#870 at 90d7533c, made by test/pairs.test.ts from
// the RFC 7748 §6.1 keys and S = the RFC 8032 §7.1 test 1 key): another
// implementation's commit, code and envelope (its AAD binding S and the
// request id), matched byte for byte, the envelope both opened and sealed
// again with its IV.
func TestPairMatchesTheOfficialVector(t *testing.T) {
	raw, err := os.ReadFile("testdata/pair-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var v pairVector
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
	requester, approver := key(v.RequesterPriv), key(v.ApproverPriv)
	B, T, S := requester.PublicKey(), approver.PublicKey(), b64(t, v.SSHPub)
	if !bytes.Equal(B, b64(t, v.RequesterPub)) || !bytes.Equal(T, b64(t, v.ApproverPub)) {
		t.Fatal("vector keys don't derive their public halves")
	}
	if commit, err := PairCommit(B, S, b64(t, v.NonceB)); err != nil || !bytes.Equal(commit, b64(t, v.Commit)) {
		t.Fatalf("commit = %x, %v; want the vector's", commit, err)
	}
	if code, err := PairCode(B, S, T, b64(t, v.NonceB), b64(t, v.NonceT)); err != nil || code != v.Code {
		t.Fatalf("code = %q, %v; want %q", code, err, v.Code)
	}
	if len(v.RequestID) != pairRequestIDSize {
		t.Fatalf("vector request id %q", v.RequestID)
	}
	plain, err := OpenPairEnvelope(requester, T, S, v.RequestID, v.Seq, v.Sealed)
	if err != nil || string(plain) != v.EnvelopeJSON {
		t.Fatalf("open = %q, %v", plain, err)
	}
	if env, err := ParsePairEnvelope(plain); err != nil || len(env.Machines) != 1 || env.Machines[0].Status != PairAdded {
		t.Fatalf("envelope %+v, %v", env, err)
	}
	sealedRaw, _ := base64.RawURLEncoding.DecodeString(v.Sealed)
	saved := approveRand
	approveRand = bytes.NewReader(sealedRaw[:12])
	t.Cleanup(func() { approveRand = saved })
	if again, err := SealPairEnvelope(approver, B, S, v.RequestID, v.Seq, plain); err != nil || again != v.Sealed {
		t.Fatalf("sealed with the vector's IV = %s, %v; want the vector's", again, err)
	}
}
