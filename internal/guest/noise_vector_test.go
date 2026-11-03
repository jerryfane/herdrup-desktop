package guest

import (
	"bytes"
	"crypto/ecdh"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"github.com/flynn/noise"
)

// herdr's Noise IK transcript (testdata/README.md), which herdr's snow
// responder and the web guest's initiator also reproduce. The guest's half
// runs with openSession's configuration (session.go:133), the fixed keys in
// place of fresh ones.
func TestNoiseHandshakeMatchesHerdrVector(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/noise_ik_vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		Protocol         string `json:"protocol_name"`
		HostID           string `json:"host_id"`
		InitPrologue     string `json:"init_prologue"`
		InitStatic       string `json:"init_static"`
		InitEphemeral    string `json:"init_ephemeral"`
		InitRemoteStatic string `json:"init_remote_static"`
		RespStatic       string `json:"resp_static"`
		RespEphemeral    string `json:"resp_ephemeral"`
		HandshakeHash    string `json:"handshake_hash"`
		Messages         []struct {
			Payload    string `json:"payload"`
			Ciphertext string `json:"ciphertext"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(raw, &vector); err != nil {
		t.Fatal(err)
	}
	unhex := func(s string) []byte {
		b, err := hex.DecodeString(s)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	keypair := func(private string) noise.DHKey {
		key, err := ecdh.X25519().NewPrivateKey(unhex(private))
		if err != nil {
			t.Fatal(err)
		}
		return noise.DHKey{Private: key.Bytes(), Public: key.PublicKey().Bytes()}
	}
	if len(vector.Messages) != 4 {
		t.Fatalf("%d messages", len(vector.Messages))
	}
	if name := "Noise_IK_" + string(cipherSuite.Name()); vector.Protocol != name {
		t.Fatalf("vector is %s, the guest speaks %s", vector.Protocol, name)
	}
	prologue := []byte("herdr-guest/1:" + vector.HostID)
	if !bytes.Equal(prologue, unhex(vector.InitPrologue)) {
		t.Fatalf("prologue %q", prologue)
	}
	host := keypair(vector.RespStatic)
	if !bytes.Equal(host.Public, unhex(vector.InitRemoteStatic)) {
		t.Fatal("the vector's host key is not its responder's")
	}
	guest, err := noise.NewHandshakeState(noise.Config{CipherSuite: cipherSuite, Pattern: noise.HandshakeIK, Initiator: true, Prologue: prologue, StaticKeypair: keypair(vector.InitStatic), PeerStatic: host.Public, Random: bytes.NewReader(unhex(vector.InitEphemeral))})
	if err != nil {
		t.Fatal(err)
	}
	responder, err := noise.NewHandshakeState(noise.Config{CipherSuite: cipherSuite, Pattern: noise.HandshakeIK, Prologue: prologue, StaticKeypair: host, Random: bytes.NewReader(unhex(vector.RespEphemeral))})
	if err != nil {
		t.Fatal(err)
	}

	hello, _, _, err := guest.WriteMessage(nil, unhex(vector.Messages[0].Payload))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(hello, unhex(vector.Messages[0].Ciphertext)) {
		t.Fatalf("message 1\n got %x\nwant %s", hello, vector.Messages[0].Ciphertext)
	}
	if _, _, _, err := responder.ReadMessage(nil, hello); err != nil {
		t.Fatal(err)
	}
	reply, hostReceive, hostSend, err := responder.WriteMessage(nil, unhex(vector.Messages[1].Payload))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(reply, unhex(vector.Messages[1].Ciphertext)) {
		t.Fatalf("message 2\n got %x\nwant %s", reply, vector.Messages[1].Ciphertext)
	}
	payload, send, receive, err := guest.ReadMessage(nil, unhex(vector.Messages[1].Ciphertext))
	if err != nil || send == nil || receive == nil {
		t.Fatalf("reading herdr's reply: %v", err)
	}
	if !bytes.Equal(payload, unhex(vector.Messages[1].Payload)) {
		t.Fatalf("reply payload %q", payload)
	}
	if hash := hex.EncodeToString(guest.ChannelBinding()); hash != vector.HandshakeHash {
		t.Fatalf("handshake hash %s", hash)
	}

	request, err := send.Encrypt(nil, nil, unhex(vector.Messages[2].Payload))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(request, unhex(vector.Messages[2].Ciphertext)) {
		t.Fatalf("request\n got %x\nwant %s", request, vector.Messages[2].Ciphertext)
	}
	if _, err := hostReceive.Decrypt(nil, nil, request); err != nil {
		t.Fatal(err)
	}
	if answer, err := hostSend.Encrypt(nil, nil, unhex(vector.Messages[3].Payload)); err != nil || !bytes.Equal(answer, unhex(vector.Messages[3].Ciphertext)) {
		t.Fatalf("answer %x %v", answer, err)
	}
	answer, err := receive.Decrypt(nil, nil, unhex(vector.Messages[3].Ciphertext))
	if err != nil || !bytes.Equal(answer, unhex(vector.Messages[3].Payload)) {
		t.Fatalf("decrypted answer %q %v", answer, err)
	}
}
