package account

import (
	"context"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"testing"
)

// x25519Key is a DeviceKey over raw private bytes, as internal/guest
// Identity is.
type x25519Key struct{ priv *ecdh.PrivateKey }

func (k x25519Key) PublicKey() []byte { return k.priv.PublicKey().Bytes() }
func (k x25519Key) SharedSecret(peer []byte) ([]byte, error) {
	pub, err := ecdh.X25519().NewPublicKey(peer)
	if err != nil {
		return nil, err
	}
	return k.priv.ECDH(pub)
}

func b64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The Worker's own vectors (AccountService/test/vectors/enrol-v1.json at
// herdrup 434d0241): Desktop's proof must be byte-for-byte the Worker's.
func TestEnrolProofMatchesTheWorkersVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/enrol-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct{ LowOrder []string }
	var loose map[string]json.RawMessage
	_ = json.Unmarshal(raw, &loose)
	var cases []map[string]string
	_ = json.Unmarshal(loose["cases"], &cases)
	_ = json.Unmarshal(loose["low_order_device_pubs"], &v.LowOrder)
	if len(cases) == 0 {
		t.Fatal("no vectors")
	}
	for _, c := range cases {
		priv, err := ecdh.X25519().NewPrivateKey(b64(t, c["device_private"]))
		if err != nil {
			t.Fatal(err)
		}
		pub, mac, err := EnrolProof(x25519Key{priv}, Challenge{ChallengeID: c["challenge_id"], ServerPub: c["server_pub"], Salt: c["salt"], AccountID: c["account_id"]})
		if err != nil || pub != c["device_pub"] || mac != c["mac"] {
			t.Errorf("%s: pub %s mac %s err %v; want %s %s", c["name"], pub, mac, err, c["device_pub"], c["mac"])
		}
	}
	priv, _ := ecdh.X25519().NewPrivateKey(b64(t, cases[0]["device_private"]))
	for _, low := range v.LowOrder {
		if _, _, err := EnrolProof(x25519Key{priv}, Challenge{ChallengeID: "c", ServerPub: low, Salt: cases[0]["salt"], AccountID: "a"}); !errors.Is(err, ErrBadChallenge) {
			t.Errorf("low-order server key %s: %v", low, err)
		}
	}
}

func TestDeviceNameIsKeptAsTheServiceKeepsIt(t *testing.T) {
	long := ""
	for range 70 {
		long += "é"
	}
	for in, want := range map[string]string{"  Jerry's\tMac\n": "Jerry'sMac", "": "", long: long[:64*2]} {
		if got := DeviceName(in); got != want {
			t.Errorf("DeviceName(%q) = %q, want %q", in, got, want)
		}
	}
}

// Enrol runs the challenge and the enrolment with this session's account,
// and a challenge for another account is refused, not answered.
func TestEnrolSendsTheProofForThisAccount(t *testing.T) {
	f, c, _, _ := signedIn(t)
	key, _ := ecdh.X25519().NewPrivateKey(make32(7))
	server, _ := ecdh.X25519().NewPrivateKey(make32(9))
	salt := base64.RawURLEncoding.EncodeToString(make32(3))
	var enrolled map[string]string
	challengeAccount := "acct-1"
	f.extra = func(w http.ResponseWriter, r *http.Request, body map[string]string) bool {
		switch {
		case r.URL.Path == "/v1/devices/challenge":
			reply(w, 200, map[string]any{"challenge_id": "CCCCCCCCCCCCCCCCCCCCCC", "server_pub": base64.RawURLEncoding.EncodeToString(server.PublicKey().Bytes()), "salt": salt, "account_id": challengeAccount, "expires_in": 60})
		case r.URL.Path == "/v1/devices" && r.Method == http.MethodPost:
			enrolled = body
			reply(w, 201, map[string]any{"device": map[string]any{"id": "d1", "name": enrolled["name"], "platform": enrolled["platform"], "device_pub": enrolled["device_pub"], "created_ms": 1, "current": true}})
		default:
			return false
		}
		return true
	}
	d, err := c.Enrol(context.Background(), "acct-1", x25519Key{key}, "  my laptop ", "linux")
	if err != nil || !d.Current || d.Name != "my laptop" {
		t.Fatalf("enrol: %+v, %v", d, err)
	}
	// The Worker's check (devices.ts): k = X25519(e, D), then the same HKDF and HMAC over this
	// account, the device's key and the challenge.
	k, _ := x25519Key{server}.SharedSecret(key.PublicKey().Bytes())
	want := workerMAC(t, k, make32(3), "acct-1", base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()), "CCCCCCCCCCCCCCCCCCCCCC")
	if enrolled["mac"] != want || enrolled["platform"] != "linux" {
		t.Fatalf("sent %v; want mac %s", enrolled, want)
	}
	challengeAccount = "acct-2"
	if _, err := c.Enrol(context.Background(), "acct-1", x25519Key{key}, "x", "linux"); !errors.Is(err, ErrAccountChanged) {
		t.Fatalf("a challenge for another account: %v", err)
	}
}

func make32(seed byte) []byte {
	b := make([]byte, 32)
	for i := range b {
		b[i] = seed + byte(i)
	}
	return b
}

func reply(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// workerMAC is devices.ts's computation, written out on its own.
func workerMAC(t *testing.T, k, salt []byte, acct, devicePub, challengeID string) string {
	t.Helper()
	mk, err := hkdf.Key(sha256.New, k, salt, "herdrup account enrol v1", 32)
	if err != nil {
		t.Fatal(err)
	}
	h := hmac.New(sha256.New, mk)
	h.Write([]byte("herdrup-enrol-v1|" + acct + "|" + devicePub + "|" + challengeID))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}
