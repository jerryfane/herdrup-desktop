package main

import (
	"context"
	"crypto/dsa"
	"crypto/ed25519"
	"crypto/mldsa"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"golang.org/x/crypto/ssh"
)

func writeTestClientKey(t *testing.T, dir string) (string, ssh.PublicKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "id_ed25519")
	if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatal(err)
	}
	sshPub, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return path, sshPub
}

func startFakeHost(t *testing.T, key ssh.Signer, extra []ssh.Signer, clientPub ssh.PublicKey, password string) (string, int, *fakeherdr.Server) {
	t.Helper()
	srv := &fakeherdr.Server{
		HostKey:            key,
		AdditionalHostKeys: extra,
		Authorized:         clientPub,
		Password:           password,
		Handle: func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "ping":
				return fakeherdr.Pong(true), nil
			case "agent.list":
				return map[string]any{"type": "agent_list", "agents": []any{}}, nil
			case "group.list":
				return map[string]any{"type": "group_list", "groups": []any{}, "stars": []any{}}, nil
			default:
				return map[string]any{}, nil
			}
		},
		Events: func(ctx context.Context, _ func([]byte) error) {
			<-ctx.Done()
		},
	}
	addr, err := srv.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Close() })
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatal(err)
	}
	return host, port, srv
}

// A non-Paired host pinned while it offered only ed25519 that later adds an
// ECDSA host key (which Go prefers over ed25519 by default) still connects
// through both Desk.session and ownerClient without changing the stored pin.
func TestSessionConnectsToEd25519PinnedHostThatAddedECDSA(t *testing.T) {
	dir := t.TempDir()
	d := newDesk(dir)
	keyPath, clientPub := writeTestClientKey(t, dir)

	ed := ed25519HostKey(t)
	ec := ecdsaHostKey(t)
	host, port, _ := startFakeHost(t, ed, []ssh.Signer{ec}, clientPub, "")
	addr := net.JoinHostPort(host, strconv.Itoa(port))

	// Pin the host on its original ed25519 key (as if pinned before ECDSA was added).
	wantPin := bridge.Fingerprint(ed.PublicKey())
	if err := d.pins.SetPin(addr, wantPin); err != nil {
		t.Fatal(err)
	}

	m := Machine{Nickname: "box", Host: host, Port: port, User: "dev", KeyPath: keyPath}
	// Control: plain bridge.Dial with default HostKeyAlgorithms negotiates ECDSA
	// and hits HostKeyChangedError.
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	_, defaultErr := bridge.Dial(context.Background(), bridge.Config{
		Host: m.Host, Port: m.Port, User: m.User, KeyPEM: keyPEM, Pins: d.pinsFor(m),
	})
	var changed *bridge.HostKeyChangedError
	if !errors.As(defaultErr, &changed) {
		t.Fatalf("control default dial err = %v, want HostKeyChangedError", defaultErr)
	}

	// Ordinary connection path (Desk.session -> dialWithPinFallback): connects
	// by finding the pinned ed25519 key and delivers the first connected board.
	if err := d.Connect(m, ""); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	t.Cleanup(func() { d.Disconnect() })
	waitFor(t, "ed25519-pinned host connected board after adding ECDSA", func() bool {
		st := d.State()
		if st.Phase == "error" {
			t.Fatalf("session entered error state: %s", st.Message)
		}
		return st.Phase == "connected" && d.Board() != nil
	})
	live := d.liveBridge(m)
	if live == nil {
		t.Fatal("connected session has nil liveBridge")
	}
	gotKey, _ := live.HostKey()
	if got := bridge.Fingerprint(gotKey); got != wantPin {
		t.Fatalf("session connected with key %s, want pinned %s", got, wantPin)
	}

	// Disconnect and verify ownerClient (short dial for web access) also finds
	// the pinned ed25519 key without changing the pin.
	d.Disconnect()
	ecClient, done, err := d.ownerClient(context.Background(), m)
	if err != nil {
		t.Fatalf("ownerClient: %v", err)
	}
	defer done()
	if ecClient == nil {
		t.Fatal("ownerClient returned nil client")
	}

	gotPin, ok, err := d.pins.Pin(addr)
	if err != nil || !ok || gotPin != wantPin {
		t.Fatalf("pin changed: %q ok=%v err=%v, want %q", gotPin, ok, err, wantPin)
	}
}

// If a non-Paired host genuinely replaces its pinned key, dialWithPinFallback
// still returns HostKeyChangedError and never repins.
func TestSessionStillRejectsActuallyRotatedHostKey(t *testing.T) {
	dir := t.TempDir()
	d := newDesk(dir)
	keyPath, clientPub := writeTestClientKey(t, dir)

	oldEd := ed25519HostKey(t)
	newEd := ed25519HostKey(t)
	newEc := ecdsaHostKey(t)
	host, port, _ := startFakeHost(t, newEd, []ssh.Signer{newEc}, clientPub, "")
	addr := net.JoinHostPort(host, strconv.Itoa(port))

	wantPin := bridge.Fingerprint(oldEd.PublicKey())
	if err := d.pins.SetPin(addr, wantPin); err != nil {
		t.Fatal(err)
	}

	m := Machine{Nickname: "rotated", Host: host, Port: port, User: "dev", KeyPath: keyPath}
	_, _, err := d.ownerClient(context.Background(), m)
	var changed *bridge.HostKeyChangedError
	if !errors.As(err, &changed) {
		t.Fatalf("rotated host err = %v, want HostKeyChangedError", err)
	}
	gotPin, ok, err := d.pins.Pin(addr)
	if err != nil || !ok || gotPin != wantPin {
		t.Fatalf("pin changed on rotated host: %q ok=%v err=%v, want %q", gotPin, ok, err, wantPin)
	}
}

// When the pinned host key matches during fallback but credentials are
// rejected, ownerClient returns the auth failure instead of masking it as
// HostKeyChangedError.
func TestSessionSurfacesAuthFailureAfterPinFallback(t *testing.T) {
	dir := t.TempDir()
	d := newDesk(dir)
	wrongKeyPath, _ := writeTestClientKey(t, dir)
	_, authorizedPub := writeTestClientKey(t, t.TempDir())

	ed := ed25519HostKey(t)
	ec := ecdsaHostKey(t)
	host, port, _ := startFakeHost(t, ed, []ssh.Signer{ec}, authorizedPub, "")
	addr := net.JoinHostPort(host, strconv.Itoa(port))

	if err := d.pins.SetPin(addr, bridge.Fingerprint(ed.PublicKey())); err != nil {
		t.Fatal(err)
	}

	m := Machine{Nickname: "auth-fail", Host: host, Port: port, User: "dev", KeyPath: wrongKeyPath}
	_, _, err := d.ownerClient(context.Background(), m)
	if err == nil {
		t.Fatal("wrong key succeeded")
	}
	var changed *bridge.HostKeyChangedError
	if errors.As(err, &changed) {
		t.Fatalf("auth failure masked as HostKeyChangedError: %v", err)
	}
	if !isAuthError(err) {
		t.Fatalf("err = %v, want isAuthError == true", err)
	}
}

// A non-Paired host pinned on ML-DSA-44 that later adds ECDSA (which Go
// negotiates ahead of ML-DSA by default) still connects through both
// Desk.session and ownerClient without changing the pin.
func TestSessionConnectsToMLDSAPinnedHostThatAddedECDSA(t *testing.T) {
	dir := t.TempDir()
	d := newDesk(dir)
	keyPath, clientPub := writeTestClientKey(t, dir)

	priv, err := mldsa.GenerateKey(mldsa.MLDSA44())
	if err != nil {
		t.Fatal(err)
	}
	ml, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	ec := ecdsaHostKey(t)
	host, port, _ := startFakeHost(t, ml, []ssh.Signer{ec}, clientPub, "")
	addr := net.JoinHostPort(host, strconv.Itoa(port))

	wantPin := bridge.Fingerprint(ml.PublicKey())
	if err := d.pins.SetPin(addr, wantPin); err != nil {
		t.Fatal(err)
	}

	m := Machine{Nickname: "pq-box", Host: host, Port: port, User: "dev", KeyPath: keyPath}
	if err := d.Connect(m, ""); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	t.Cleanup(func() { d.Disconnect() })
	waitFor(t, "mldsa-pinned host connected board after adding ECDSA", func() bool {
		st := d.State()
		if st.Phase == "error" {
			t.Fatalf("session entered error state: %s", st.Message)
		}
		return st.Phase == "connected" && d.Board() != nil
	})
	live := d.liveBridge(m)
	if live == nil {
		t.Fatal("connected session has nil liveBridge")
	}
	gotKey, _ := live.HostKey()
	if got := bridge.Fingerprint(gotKey); got != wantPin {
		t.Fatalf("session connected with key %s, want pinned %s", got, wantPin)
	}

	d.Disconnect()
	ecClient, done, err := d.ownerClient(context.Background(), m)
	if err != nil {
		t.Fatalf("ownerClient: %v", err)
	}
	defer done()
	if ecClient == nil {
		t.Fatal("ownerClient returned nil client")
	}

	gotPin, ok, err := d.pins.Pin(addr)
	if err != nil || !ok || gotPin != wantPin {
		t.Fatalf("pin changed: %q ok=%v err=%v, want %q", gotPin, ok, err, wantPin)
	}
}

// A non-Paired host pinned on a legacy DSA key (which Go's default dial accepts
// and can pin) that later adds ECDSA still connects through both Desk.session
// and ownerClient without changing the pin.
func TestSessionConnectsToDSAPinnedHostThatAddedECDSA(t *testing.T) {
	dir := t.TempDir()
	d := newDesk(dir)
	keyPath, clientPub := writeTestClientKey(t, dir)

	var params dsa.Parameters
	if err := dsa.GenerateParameters(&params, rand.Reader, dsa.L1024N160); err != nil {
		t.Fatal(err)
	}
	priv := &dsa.PrivateKey{PublicKey: dsa.PublicKey{Parameters: params}}
	if err := dsa.GenerateKey(priv, rand.Reader); err != nil {
		t.Fatal(err)
	}
	dsaSigner, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	ec := ecdsaHostKey(t)
	host, port, _ := startFakeHost(t, dsaSigner, []ssh.Signer{ec}, clientPub, "")
	addr := net.JoinHostPort(host, strconv.Itoa(port))

	wantPin := bridge.Fingerprint(dsaSigner.PublicKey())
	if err := d.pins.SetPin(addr, wantPin); err != nil {
		t.Fatal(err)
	}

	m := Machine{Nickname: "dsa-box", Host: host, Port: port, User: "dev", KeyPath: keyPath}
	if err := d.Connect(m, ""); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	t.Cleanup(func() { d.Disconnect() })
	waitFor(t, "dsa-pinned host connected board after adding ECDSA", func() bool {
		st := d.State()
		if st.Phase == "error" {
			t.Fatalf("session entered error state: %s", st.Message)
		}
		return st.Phase == "connected" && d.Board() != nil
	})
	live := d.liveBridge(m)
	if live == nil {
		t.Fatal("connected session has nil liveBridge")
	}
	gotKey, _ := live.HostKey()
	if got := bridge.Fingerprint(gotKey); got != wantPin {
		t.Fatalf("session connected with key %s, want pinned %s", got, wantPin)
	}

	d.Disconnect()
	ecClient, done, err := d.ownerClient(context.Background(), m)
	if err != nil {
		t.Fatalf("ownerClient: %v", err)
	}
	defer done()
	if ecClient == nil {
		t.Fatal("ownerClient returned nil client")
	}

	gotPin, ok, err := d.pins.Pin(addr)
	if err != nil || !ok || gotPin != wantPin {
		t.Fatalf("pin changed: %q ok=%v err=%v, want %q", gotPin, ok, err, wantPin)
	}
}
