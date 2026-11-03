package guest

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/flynn/noise"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

func TestIdentitySurvivesConcurrentCreationAndRejectsCorruption(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity")
	identities := make(chan Identity, 12)
	var group sync.WaitGroup
	for range 12 {
		group.Add(1)
		go func() {
			defer group.Done()
			identity, err := LoadIdentity(path)
			if err != nil {
				t.Error(err)
				return
			}
			identities <- identity
		}()
	}
	group.Wait()
	close(identities)
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for identity := range identities {
		if !bytes.Equal(identity.private, saved) {
			t.Fatal("concurrent creation returned a discarded identity")
		}
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0077 != 0 {
		t.Fatal("identity readable by other users")
	}
	if err := os.WriteFile(path, []byte("damaged"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadIdentity(path); err == nil {
		t.Fatal("corrupt identity replaced")
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != "damaged" {
		t.Fatal("corrupt identity was overwritten")
	}
}

func TestGuestAcceptanceAndReturningTrafficAuthenticateBothPeers(t *testing.T) {
	host, err := noise.DH25519.GenerateKeypair(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := LoadIdentity(filepath.Join(t.TempDir(), "identity"))
	if err != nil {
		t.Fatal(err)
	}
	hostID := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1}, 16))
	var sessions atomic.Int32
	var mode atomic.Int32
	requests := make(chan string, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer socket.CloseNow()
		socket.SetReadLimit(maxNoiseMessage)
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		handshake, err := noise.NewHandshakeState(noise.Config{CipherSuite: cipherSuite, Pattern: noise.HandshakeIK, Prologue: []byte("herdr-guest/1:" + hostID), StaticKeypair: host})
		if err != nil {
			t.Error(err)
			return
		}
		_, encrypted, err := socket.Read(ctx)
		if err != nil {
			return
		}
		hello, _, _, err := handshake.ReadMessage(nil, encrypted)
		if err != nil {
			return
		}
		if !bytes.Equal(handshake.PeerStatic(), identity.public) {
			t.Error("device identity changed")
			return
		}
		sessions.Add(1)
		var payload map[string]any
		if err := json.Unmarshal(hello, &payload); err != nil {
			t.Error(err)
			return
		}
		reply := `{"ok":true,"guest_id":"grant-1","agent":{"name":"Worker","target":"%42"},"features":{"gram":true}}`
		switch mode.Load() {
		case 1:
			reply = `{"ok":true,"guest_id":"wrong-grant"}`
		case 2:
			reply = `{"ok":false,"error":"revoked"}`
		case 3:
			reply = `{"ok":true,"guest_id":"grant-1"}`
		case 4:
			<-ctx.Done()
			return
		}
		message, receive, send, err := handshake.WriteMessage(nil, []byte(reply))
		if err != nil {
			t.Error(err)
			return
		}
		if err := socket.Write(ctx, websocket.MessageBinary, message); err != nil {
			return
		}
		if payload["invite_id"] != nil {
			if payload["secret"] != "one-use-bearer" {
				t.Error("missing encrypted invite secret")
			}
			return
		}
		if payload["guest_id"] != "grant-1" || payload["secret"] != nil {
			t.Error("returning hello leaked invitation or changed grant")
			return
		}
		var request []byte
		for !bytes.Contains(request, []byte{'\n'}) {
			_, encrypted, err = socket.Read(ctx)
			if err != nil {
				return
			}
			plain, err := receive.Decrypt(nil, nil, encrypted)
			if err != nil {
				t.Error(err)
				return
			}
			request = append(request, plain...)
		}
		var envelope struct {
			Method string `json:"method"`
			Params struct {
				Text string `json:"text"`
			} `json:"params"`
		}
		if err := json.Unmarshal(bytes.TrimSpace(request), &envelope); err != nil {
			t.Error(err)
			return
		}
		if strings.HasPrefix(envelope.Method, "gram.") {
			var wire struct {
				Params map[string]json.RawMessage `json:"params"`
			}
			if err := json.Unmarshal(bytes.TrimSpace(request), &wire); err != nil {
				t.Error(err)
				return
			}
			reply := ""
			switch envelope.Method {
			case "gram.list":
				if len(wire.Params) != 2 || string(wire.Params["limit"]) != "500" || string(wire.Params["before_id"]) != `"cursor"` {
					t.Errorf("guest paging wire: %s", request)
					return
				}
				reply = `{"result":{"messages":[{"id":"agent-note","direction":"agent_to_owner","from":"Worker","text":"Shared note","created_unix_ms":17,"read":true}],"has_more":true}}`
			case "gram.post":
				reply = `{"result":{"message":{"id":"receipt-only"}}}`
			case "gram.mark_read":
				if len(wire.Params) != 1 || string(wire.Params["ids"]) != `["agent-note"]` {
					t.Errorf("guest read marks must use ids, not owner id/all: %s", request)
					return
				}
				reply = `{"result":null}`
			}
			encrypted, err := send.Encrypt(nil, nil, []byte(reply+"\n"))
			if err != nil {
				t.Error(err)
				return
			}
			_ = socket.Write(ctx, websocket.MessageBinary, encrypted)
			return
		}
		requests <- envelope.Params.Text
		// Split one API line between frames, then put two lines in a frame.
		for _, plain := range []string{`{"result":{"text":"hel`, `lo"}}` + "\n" + `{"result":{"text":"second"}}` + "\n"} {
			encrypted, err = send.Encrypt(nil, nil, []byte(plain))
			if err != nil {
				t.Error(err)
				return
			}
			if err := socket.Write(ctx, websocket.MessageBinary, encrypted); err != nil {
				return
			}
		}
		_ = socket.Close(websocket.StatusNormalClosure, "")
	}))
	defer server.Close()
	endpoint := Endpoint{Relay: server.URL, HostID: hostID, HostPublicKey: host.Public}
	invite := Invite{Endpoint: endpoint, inviteID: "invitation", secret: "one-use-bearer", Expires: time.Now().Add(time.Minute), MachineLabel: "Machine", OwnerName: "Owner", GuestName: "visitor", AgentName: "Worker"}
	access, err := Accept(context.Background(), invite, identity, "Desktop", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if access.AgentTarget != "%42" || access.GuestID != "grant-1" || access.OwnerName != "Owner" {
		t.Fatalf("incomplete access: %+v", access)
	}
	transport := NewTransport(access, identity, SystemClock)
	defer transport.Close()
	longText := strings.Repeat("x", maxNoisePlaintext*2)
	var result struct {
		Text string `json:"text"`
	}
	if err := transport.Call(context.Background(), "pane.send_text", map[string]string{"text": longText}, &result); err != nil {
		t.Fatal(err)
	}
	if result.Text != "hello" || <-requests != longText {
		t.Fatal("chunked request/reply corrupted")
	}
	if !transport.Features().Gram {
		t.Fatal("authenticated capability missing")
	}
	stream, err := transport.OpenStream(context.Background(), "events.subscribe", nil)
	if err != nil {
		t.Fatal(err)
	}
	first, err := stream.Next()
	if err != nil {
		t.Fatal(err)
	}
	second, err := stream.Next()
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != `{"result":{"text":"hello"}}` || string(second) != `{"result":{"text":"second"}}` {
		t.Fatal("stream line boundaries corrupted")
	}
	if _, err := stream.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("normal close: %v", err)
	}
	stream.Close()
	<-requests
	if sessions.Load() != 3 {
		t.Fatal("requests reused an authenticated session")
	}
	t.Run("GuestGramProjection", func(t *testing.T) {
		cursor := "cursor"
		page, err := transport.GramList(context.Background(), 999, &cursor)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Messages) != 1 || !page.Messages[0].Read || page.Messages[0].ID != "agent-note" || !page.HasMore {
			t.Fatalf("guest projection lost its own read mark or page cursor: %+v", page)
		}
		id, err := transport.GramPost(context.Background(), herdrapi.GramPostParams{Text: "A guest post", To: new("Worker")})
		if err != nil || id != "receipt-only" {
			t.Fatalf("minimal guest receipt: %q %v", id, err)
		}
		if err := transport.GramMarkRead(context.Background(), []string{"agent-note"}); err != nil {
			t.Fatal(err)
		}
	})
	mode.Store(3)
	if err := transport.Call(context.Background(), "ping", nil, &result); err != nil {
		t.Fatal(err)
	}
	<-requests
	if transport.Features().Gram {
		t.Fatal("omitted capability reused from previous handshake")
	}
	for _, value := range []int32{1, 2} {
		mode.Store(value)
		if err := transport.Call(context.Background(), "ping", nil, &result); !errors.Is(err, ErrRevoked) {
			t.Fatalf("grant refusal %d: %v", value, err)
		}
	}
	wrong := access
	wrong.Endpoint.HostPublicKey = bytes.Repeat([]byte{9}, 32)
	untrusted := NewTransport(wrong, identity, SystemClock)
	defer untrusted.Close()
	if err := untrusted.Call(context.Background(), "ping", nil, &result); err == nil {
		t.Fatal("wrong host identity accepted")
	}
	mode.Store(4)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := transport.OpenStream(ctx, "events.subscribe", nil); err == nil {
		t.Fatal("cancelled handshake succeeded")
	}
	if err := transport.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := transport.OpenStream(context.Background(), "ping", nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("closed transport reopened: %v", err)
	}
}

// After the relay's 429 a transport waits 15 s, then twice as long while
// the relay keeps refusing, at most a minute.
func TestRelayBackoffDoublesToAMinute(t *testing.T) {
	var got []time.Duration
	for last := time.Duration(0); len(got) < 5; {
		last = relayBackoff(last)
		got = append(got, last)
	}
	want := []time.Duration{15 * time.Second, 30 * time.Second, time.Minute, time.Minute, time.Minute}
	if !slices.Equal(got, want) {
		t.Fatalf("backoffs %v, want %v", got, want)
	}
}

// The relay's 429, as its header or its status alone, is ErrRateLimited.
func TestRelayRateLimitIsErrRateLimited(t *testing.T) {
	header := &http.Response{StatusCode: 429, Header: http.Header{"X-Herdr-Guest-Error": {"rate_limited"}}}
	bare := &http.Response{StatusCode: 429, Header: http.Header{}}
	for _, response := range []*http.Response{header, bare} {
		if err := upgradeError(response, nil); !errors.Is(err, ErrRateLimited) {
			t.Fatalf("429 %v: %v", response.Header, err)
		}
	}
}

// Request A passes the relay's admission and waits for the host's Noise
// reply; B is refused with 429 meanwhile. A's late success must not end the
// cooldown B started: the next request stays off the relay, so the
// escalation does not restart at 15 s (post-merge review of #103, F1).
func TestAnAdmittedHandshakeBegunBeforeA429KeepsItsCooldown(t *testing.T) {
	host, err := noise.DH25519.GenerateKeypair(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := LoadIdentity(filepath.Join(t.TempDir(), "identity"))
	if err != nil {
		t.Fatal(err)
	}
	hostID := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{2}, 16))
	var connects atomic.Int32
	helloA, releaseA := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if connects.Add(1) != 1 {
			w.Header().Set("X-Herdr-Guest-Error", "rate_limited")
			http.Error(w, `{"error":"rate_limited"}`, http.StatusTooManyRequests)
			return
		}
		socket, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer socket.CloseNow()
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		handshake, err := noise.NewHandshakeState(noise.Config{CipherSuite: cipherSuite, Pattern: noise.HandshakeIK, Prologue: []byte("herdr-guest/1:" + hostID), StaticKeypair: host})
		if err != nil {
			t.Error(err)
			return
		}
		_, encrypted, err := socket.Read(ctx)
		if err != nil {
			return
		}
		if _, _, _, err := handshake.ReadMessage(nil, encrypted); err != nil {
			t.Error(err)
			return
		}
		close(helloA)
		<-releaseA
		message, receive, send, err := handshake.WriteMessage(nil, []byte(`{"ok":true,"guest_id":"grant-1"}`))
		if err != nil {
			t.Error(err)
			return
		}
		if err := socket.Write(ctx, websocket.MessageBinary, message); err != nil {
			return
		}
		var line []byte
		for !bytes.Contains(line, []byte{'\n'}) {
			_, encrypted, err := socket.Read(ctx)
			if err != nil {
				return
			}
			plain, err := receive.Decrypt(nil, nil, encrypted)
			if err != nil {
				t.Error(err)
				return
			}
			line = append(line, plain...)
		}
		reply, err := send.Encrypt(nil, nil, []byte(`{"result":{"type":"pong"}}`+"\n"))
		if err != nil {
			t.Error(err)
			return
		}
		_ = socket.Write(ctx, websocket.MessageBinary, reply)
		_ = socket.Close(websocket.StatusNormalClosure, "")
	}))
	defer server.Close()
	access := Access{GuestID: "grant-1", Endpoint: Endpoint{Relay: server.URL, HostID: hostID, HostPublicKey: host.Public}}
	transport := NewTransport(access, identity, SystemClock)
	defer transport.Close()
	ctx := context.Background()

	done := make(chan error, 1)
	go func() {
		var pong map[string]any
		done <- transport.Call(ctx, "ping", nil, &pong)
	}()
	<-helloA
	if err := transport.Call(ctx, "ping", nil, nil); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("B while the relay refuses: %v", err)
	}
	cooldown := transport.RateLimitedUntil()
	if cooldown.IsZero() {
		t.Fatal("B's 429 started no cooldown")
	}
	close(releaseA)
	if err := <-done; err != nil {
		t.Fatalf("A, admitted before B's 429: %v", err)
	}
	if got := transport.RateLimitedUntil(); !got.Equal(cooldown) {
		t.Fatalf("A's late success moved the cooldown from %v to %v", cooldown, got)
	}
	if err := transport.Call(ctx, "ping", nil, nil); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("C during the cooldown: %v", err)
	}
	if n := connects.Load(); n != 2 {
		t.Fatalf("%d connects reached the relay, want 2 (A and B)", n)
	}
}

// themartianapp/herdrup#610: the relay accepts a guest upgrade it refuses and
// closes with 4429 rate_limited, 4503 host_offline or 4504 host_busy, which
// a page can read (an HTTP status it cannot). 4429 starts the backoff like
// the HTTP 429 does.
func TestRelayRefusalCloseCodes(t *testing.T) {
	identity, err := LoadIdentity(filepath.Join(t.TempDir(), "identity"))
	if err != nil {
		t.Fatal(err)
	}
	host, err := noise.DH25519.GenerateKeypair(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var code atomic.Int32
	var connects atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connects.Add(1)
		socket, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		reasons := map[int32]string{4429: "rate_limited", 4503: "host_offline", 4504: "host_busy"}
		_ = socket.Close(websocket.StatusCode(code.Load()), reasons[code.Load()])
	}))
	defer server.Close()
	hostID := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{3}, 16))
	access := Access{GuestID: "grant-1", Endpoint: Endpoint{Relay: server.URL, HostID: hostID, HostPublicKey: host.Public}}
	clock := &fakeClock{now: time.Unix(1_000_000, 0)}
	transport := NewTransport(access, identity, clock)
	defer transport.Close()
	ctx := context.Background()

	code.Store(4429)
	if err := transport.Call(ctx, "ping", nil, nil); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("4429: %v", err)
	}
	if got, want := transport.RateLimitedUntil(), clock.Now().Add(15*time.Second); !got.Equal(want) {
		t.Fatalf("4429 backoff until %v, want %v", got, want)
	}
	if err := transport.Call(ctx, "ping", nil, nil); !errors.Is(err, ErrRateLimited) || connects.Load() != 1 {
		t.Fatalf("during the backoff: %v after %d connects", err, connects.Load())
	}
	clock.advance(15 * time.Second)
	code.Store(4503)
	if err := transport.Call(ctx, "ping", nil, nil); !errors.Is(err, ErrHostOffline) {
		t.Fatalf("4503: %v", err)
	}
	code.Store(4504)
	if err := transport.Call(ctx, "ping", nil, nil); err == nil || err.Error() != "The shared machine is busy. Try again shortly." {
		t.Fatalf("4504: %v", err)
	}
}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *fakeClock) After(d time.Duration) <-chan time.Time {
	return time.After(d)
}
func (c *fakeClock) advance(d time.Duration) { c.mu.Lock(); c.now = c.now.Add(d); c.mu.Unlock() }
