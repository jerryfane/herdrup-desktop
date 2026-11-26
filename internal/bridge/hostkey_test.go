package bridge_test

import (
	"bytes"
	"net"
	"strconv"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
)

// HostKey is the key the handshake verified against the pin, the whole
// key and not only its digest, the same for every session view.
func TestHostKeyIsTheKeyTheConnectionVerified(t *testing.T) {
	m := startMachine(t, nil)
	c := m.dial(t)
	want := m.srv.HostKey.PublicKey()
	got := c.HostKey()
	if got == nil || !bytes.Equal(got.Marshal(), want.Marshal()) {
		t.Fatalf("host key %v, want the server's", got)
	}
	if c.PinAddress() != net.JoinHostPort(m.host, strconv.Itoa(m.port)) {
		t.Fatalf("pin address %q", c.PinAddress())
	}
	pin, ok, err := m.pins.Pin(c.PinAddress())
	if err != nil || !ok || pin != bridge.Fingerprint(got) {
		t.Fatalf("pin %q %v %v, want the verified key's", pin, ok, err)
	}
	other, err := c.ForSession("other")
	if err != nil || !bytes.Equal(other.HostKey().Marshal(), want.Marshal()) {
		t.Fatalf("session view's host key: %v", err)
	}
}
