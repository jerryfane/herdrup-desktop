package bridge_test

import (
	"bytes"
	"net"
	"strconv"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
)

// HostKey is the key the handshake verified against the pin, the whole
// key and not only its digest, with the exact address dialled (the pin's),
// the same for every session view.
func TestHostKeyIsTheKeyTheConnectionVerified(t *testing.T) {
	m := startMachine(t, nil)
	c := m.dial(t)
	want := m.srv.HostKey.PublicKey()
	got, addr := c.HostKey()
	if got == nil || !bytes.Equal(got.Marshal(), want.Marshal()) {
		t.Fatalf("host key %v, want the server's", got)
	}
	if addr != net.JoinHostPort(m.host, strconv.Itoa(m.port)) {
		t.Fatalf("dial address %q", addr)
	}
	pin, ok, err := m.pins.Pin(addr)
	if err != nil || !ok || pin != bridge.Fingerprint(got) {
		t.Fatalf("pin %q %v %v, want the verified key's", pin, ok, err)
	}
	other, err := c.ForSession("other")
	if err != nil {
		t.Fatal(err)
	}
	if k, a := other.HostKey(); !bytes.Equal(k.Marshal(), want.Marshal()) || a != addr {
		t.Fatalf("session view's host key %v at %q", k, a)
	}
}
