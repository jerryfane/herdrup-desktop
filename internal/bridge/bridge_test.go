package bridge_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"golang.org/x/crypto/ssh"
)

func newSigner(t *testing.T) (ssh.Signer, []byte) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	return s, pem.EncodeToMemory(block)
}

type machine struct {
	srv  *fakeherdr.Server
	host string
	port int
	key  []byte
	pins *bridge.FilePinStore
}

// echoHandler answers ping, and any other method with its own name after
// a delay taken from params, so replies can overtake each other.
func echoHandler(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
	if method == "ping" {
		return map[string]any{"type": "pong", "version": "test", "protocol": 22}, nil
	}
	if method == "fail" {
		return nil, &fakeherdr.APIError{Code: "not_found", Message: "pane not found"}
	}
	var p struct{ DelayMs int }
	_ = json.Unmarshal(params, &p)
	time.Sleep(time.Duration(p.DelayMs) * time.Millisecond)
	return map[string]any{"method": method}, nil
}

func startMachine(t *testing.T, configure func(*fakeherdr.Server)) *machine {
	t.Helper()
	hostKey, _ := newSigner(t)
	client, pemKey := newSigner(t)
	srv := &fakeherdr.Server{HostKey: hostKey, Authorized: client.PublicKey(), Handle: echoHandler}
	if configure != nil {
		configure(srv)
	}
	addr, err := srv.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Close() })
	host, portStr, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portStr)
	return &machine{srv: srv, host: host, port: port, key: pemKey,
		pins: bridge.NewFilePinStore(filepath.Join(t.TempDir(), "pins.json"))}
}

func (m *machine) dial(t *testing.T) *bridge.Client {
	t.Helper()
	c, err := bridge.Dial(context.Background(), bridge.Config{
		Host: m.host, Port: m.port, User: "dev", KeyPEM: m.key, Pins: m.pins,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func TestCallsShareOneMultiChannelAndMatchRepliesByID(t *testing.T) {
	m := startMachine(t, nil)
	c := m.dial(t)
	ctx := context.Background()

	// Earlier requests answer later, so replies arrive out of order.
	var wg sync.WaitGroup
	errs := make(chan error, 5)
	for i := range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			method := fmt.Sprintf("m%d", i)
			var res struct{ Method string }
			if err := c.Call(ctx, method, map[string]int{"DelayMs": (5 - i) * 40}, &res); err != nil {
				errs <- err
				return
			}
			if res.Method != method {
				errs <- fmt.Errorf("call %s got the reply for %s", method, res.Method)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}

	var multi int
	for _, cmd := range m.srv.Commands() {
		if strings.Contains(cmd, "api-bridge --multi") {
			multi++
		} else {
			t.Errorf("unexpected exec %q", cmd)
		}
	}
	if multi != 1 {
		t.Errorf("opened %d --multi channels, want 1", multi)
	}
}

func TestErrorReplyIsAPIError(t *testing.T) {
	c := startMachine(t, nil).dial(t)
	err := c.Call(context.Background(), "fail", nil, nil)
	var apiErr *bridge.APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "not_found" {
		t.Fatalf("got %v, want APIError not_found", err)
	}
}

func TestHerdrWithoutMultiFallsBackToOneExecPerRequest(t *testing.T) {
	m := startMachine(t, func(s *fakeherdr.Server) { s.NoMulti = true })
	c := m.dial(t)
	for _, method := range []string{"agent.list", "agent.list"} {
		var res struct{ Method string }
		if err := c.Call(context.Background(), method, nil, &res); err != nil {
			t.Fatal(err)
		}
		if res.Method != method {
			t.Fatalf("got %q", res.Method)
		}
	}
	cmds := m.srv.Commands()
	if len(cmds) != 3 || !strings.Contains(cmds[0], "--multi") {
		t.Fatalf("want one --multi attempt then two one-shot execs, got %q", cmds)
	}
	for _, cmd := range cmds[1:] {
		if strings.Contains(cmd, "--multi") {
			t.Fatalf("retried --multi after it was refused: %q", cmds)
		}
	}
}

func TestMissingHerdrIsReported(t *testing.T) {
	c := startMachine(t, func(s *fakeherdr.Server) { s.NotInstalled = true }).dial(t)
	err := c.Call(context.Background(), "agent.list", nil, nil)
	if !errors.Is(err, bridge.ErrHerdrNotInstalled) {
		t.Fatalf("got %v, want ErrHerdrNotInstalled", err)
	}
}

func TestHostKeyIsPinnedAndAChangedKeyRefused(t *testing.T) {
	m := startMachine(t, nil)
	m.dial(t).Close()
	pinned, ok, err := m.pins.Pin(net.JoinHostPort(m.host, strconv.Itoa(m.port)))
	if err != nil || !ok {
		t.Fatalf("no pin after first connect: %v", err)
	}
	if want := bridge.Fingerprint(m.srv.HostKey.PublicKey()); pinned != want {
		t.Fatalf("pinned %s, want %s", pinned, want)
	}

	// The same address now presents another host key.
	m.srv.Close()
	other, _ := newSigner(t)
	srv2 := &fakeherdr.Server{HostKey: other, Authorized: m.srv.Authorized, Handle: echoHandler}
	if _, err := srv2.Listen(net.JoinHostPort(m.host, strconv.Itoa(m.port))); err != nil {
		t.Skipf("port reuse failed: %v", err)
	}
	defer srv2.Close()
	_, err = bridge.Dial(context.Background(), bridge.Config{
		Host: m.host, Port: m.port, User: "dev", KeyPEM: m.key, Pins: m.pins,
	})
	var changed *bridge.HostKeyChangedError
	if !errors.As(err, &changed) {
		t.Fatalf("got %v, want HostKeyChangedError", err)
	}
	if len(srv2.Commands()) != 0 {
		t.Fatal("ran a command on a machine with a changed host key")
	}
}

func TestPasswordLogin(t *testing.T) {
	m := startMachine(t, func(s *fakeherdr.Server) { s.Password = "s3cret" })
	c, err := bridge.Dial(context.Background(), bridge.Config{
		Host: m.host, Port: m.port, User: "dev", Password: "s3cret", Pins: m.pins,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Call(context.Background(), "ping", nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := bridge.Dial(context.Background(), bridge.Config{
		Host: m.host, Port: m.port, User: "dev", Password: "wrong", Pins: m.pins,
	}); err == nil {
		t.Fatal("wrong password logged in")
	}
}

func TestStreamDeliversLinesAndEndsWithContext(t *testing.T) {
	m := startMachine(t, func(s *fakeherdr.Server) {
		s.Events = func(ctx context.Context, emit func([]byte) error) {
			for i := 1; i <= 3; i++ {
				if emit([]byte(fmt.Sprintf(`{"seq":%d,"event":"pane.agent_status_changed"}`, i))) != nil {
					return
				}
			}
			<-ctx.Done()
		}
	})
	c := m.dial(t)
	ctx, cancel := context.WithCancel(context.Background())
	s, err := c.OpenStream(ctx, "events.subscribe", map[string]any{"subscriptions": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	ack, err := s.Next()
	if err != nil || !strings.Contains(string(ack), "subscription_started") {
		t.Fatalf("ack %q, %v", ack, err)
	}
	for i := 1; i <= 3; i++ {
		line, err := s.Next()
		if err != nil || !strings.Contains(string(line), fmt.Sprintf(`"seq":%d`, i)) {
			t.Fatalf("line %d: %q, %v", i, line, err)
		}
	}
	cancel()
	done := make(chan error, 1)
	go func() { _, err := s.Next(); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Next returned a line after cancel")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stream did not end after its context was cancelled")
	}
}

func TestDialRejectsUnsafeSessionName(t *testing.T) {
	m := startMachine(t, nil)
	_, err := bridge.Dial(context.Background(), bridge.Config{
		Host: m.host, Port: m.port, User: "dev", KeyPEM: m.key, Pins: m.pins,
		Session: "x'; rm -rf ~; '",
	})
	if err == nil {
		t.Fatal("accepted a session name with shell syntax")
	}
}
