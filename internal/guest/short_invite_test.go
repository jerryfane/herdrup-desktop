package guest

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// offline is a fetch for links that must not touch the network.
func offline(t *testing.T) sealedInviteFetch {
	return func(context.Context, *url.URL) ([]byte, error) {
		t.Error("a link that carries its payload was fetched")
		return nil, ErrInviteUnreachable
	}
}

// The known-answer vector the daemon, the relay page and herdrup check
// (short-invite-kat.json, herdrup GuestInviteTests.swift:294-321 at f2df68b).
const (
	katID        = "AQIDBAUGBwgJ"
	katKey       = "EBESExQVFhcYGRobHB0eHw"
	katLink      = "https://guest.herdrup.themartian.app/i/AQIDBAUGBwgJEBESExQVFhcYGRobHB0eHw"
	katNonceHex  = "303132333435363738393a3b"
	katBlob      = "MDEyMzQ1Njc4OTo76HmMcTjDzE3OdSaDaK9beuTqzPLVVEUBKIa8OWJbqs8XDxQL0uQJSTWFeZvgkikIe1wxOA3sk7Hb4x6wjfHjOvVi3zfizc3/SM6+90bB9XIi6BXSmuiq8Z6OGZXR7UrLkh6Inxwh/qbAALuB4Rutr24iIC1sU1lG5r7/RWTqMxLRqqDKR32zUCL9iDYu8gaErdUgZeTfpeik9cwTC2mS9pAAakSI/hIczZymbpBb/IrgIv1W3sHDAfC08BLtejXbbxeRGf9jCWTISaVmJu0US2YeF36Re83O9PTtHSl952NNjZtz9hsOMylQomFWeNSDDtRe9oRVNidH/AW4KZnvLpFPC8I0/kZw6IIj18rkR0tEUuZ6ftnsFbrAvQs7hsQn4o6LtYtbJsZ6qhrglLQsb2yiyz5ilcqpXIOl+XaAEjfijL7c8KyX2hbUvWFDH6GS2VWqnlXnKt0SW0rQEaZ4ZBTtBAhU9uehul9N9CJXoQq1"
	katPlaintext = `{"agent_name":"demo","expires_unix":4102444800,"guest_name":"guest","host_id":"QUFBQUFBQUFBQUFBQUFBQQ","host_pub":"QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI","invite_id":"Q0NDQ0NDQ0NDQ0NDQ0NDQw","machine_label":"test-box","owner_name":"Owner","relay":"https://guest.herdrup.themartian.app","secret":"REREREREREREREREREREREREREREREREREREREREREQ","v":1}`
)

var shortNow = time.Unix(1800000000, 0)

func TestShortInviteKnownAnswer(t *testing.T) {
	blob, err := base64.StdEncoding.DecodeString(katBlob)
	if err != nil {
		t.Fatal(err)
	}
	if nonce := hex.EncodeToString(blob[:12]); nonce != katNonceHex {
		t.Fatalf("vector nonce %s", nonce)
	}
	link, ok := linkParts(katLink)
	if !ok || link.payload != "" || link.id != katID || link.key != katKey {
		t.Fatalf("short link split as %+v %v", link, ok)
	}
	plaintext, err := openSealed(blob, katID, katKey)
	if err != nil || string(plaintext) != katPlaintext {
		t.Fatalf("opened %q %v", plaintext, err)
	}
	var fetched []string
	invite, err := resolve(context.Background(), katLink, shortNow, func(_ context.Context, target *url.URL) ([]byte, error) {
		fetched = append(fetched, target.String())
		return blob, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(fetched) != 1 || fetched[0] != "https://guest.herdrup.themartian.app/v1/invite/"+katID {
		t.Fatalf("fetched %v", fetched)
	}
	if invite.Endpoint.Relay != "https://guest.herdrup.themartian.app" || invite.Endpoint.HostID != "QUFBQUFBQUFBQUFBQUFBQQ" || !bytes.Equal(invite.Endpoint.HostPublicKey, bytes.Repeat([]byte("B"), 32)) ||
		invite.inviteID != "Q0NDQ0NDQ0NDQ0NDQ0NDQw" || invite.secret != "REREREREREREREREREREREREREREREREREREREREREQ" || invite.MachineLabel != "test-box" || invite.OwnerName != "Owner" ||
		invite.AgentName != "demo" || invite.GuestName != "guest" || invite.Expires.Unix() != 4102444800 {
		t.Fatalf("decoded %#v", invite)
	}
	// The key opens only its own id's invite, and only with the right key.
	for name, open := range map[string]func() ([]byte, error){
		"other id":  func() ([]byte, error) { return openSealed(blob, "AQIDBAUGBwgK", katKey) },
		"other key": func() ([]byte, error) { return openSealed(blob, katID, "EBESExQVFhcYGRobHB0eHg") },
		"tampered": func() ([]byte, error) {
			return openSealed(append(bytes.Clone(blob[:len(blob)-1]), blob[len(blob)-1]^1), katID, katKey)
		},
		"too short": func() ([]byte, error) { return openSealed(blob[:28], katID, katKey) },
		"too long":  func() ([]byte, error) { return openSealed(make([]byte, maxSealedInvite+1), katID, katKey) },
		"bad key":   func() ([]byte, error) { return openSealed(blob, katID, "EBESExQVFhcYGRobHB0eH") },
	} {
		if _, err := open(); !errors.Is(err, ErrNotInvite) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// Short iff the last path segment is exactly 34 base64url characters with no
// fragment or query (GuestInviteTests.swift:263-292 at f2df68b).
func TestShortLinkShapes(t *testing.T) {
	segment := katID + katKey
	base := "https://guest.herdrup.themartian.app/i/"
	link, ok := linkParts("https://example.org/herdr/i/" + segment)
	if !ok || link.id != katID || link.key != katKey || link.sealedURL().String() != "https://example.org/herdr/v1/invite/"+katID {
		t.Fatalf("relay with a path: %+v %v", link, ok)
	}
	for _, long := range []string{segment[:33], segment + "A", segment[:33] + "!", segment[:33] + "=", segment[:33] + ".", segment[:33] + "~"} {
		link, ok := linkParts(base + long)
		if !ok || link.payload != long || link.id != "" {
			t.Errorf("%q is the long form, got %+v %v", long, link, ok)
		}
	}
	for _, junk := range []string{base + katID + "#" + katKey, base + segment + "#x", base + segment + "?q=1", base + segment + "/", base + segment + "/x", "http://guest.herdrup.themartian.app/i/" + segment, "https://guest.herdrup.themartian.app/" + segment, "https://user@guest.herdrup.themartian.app/i/" + segment} {
		if link, ok := linkParts(junk); ok {
			t.Errorf("%q accepted as %+v", junk, link)
		}
	}
	// A short link is never read as a payload, and a link that is not one never fetches.
	if _, err := parse(katLink, shortNow); !errors.Is(err, ErrNotInvite) {
		t.Fatalf("sync parse of a short link: %v", err)
	}
	for _, junk := range []string{base + segment[:33], base + segment + "#", base + segment + "?"} {
		if _, err := resolve(context.Background(), junk, shortNow, offline(t)); !errors.Is(err, ErrNotInvite) {
			t.Errorf("%q: %v", junk, err)
		}
	}
}

// testRelay is a TLS relay holding sealed invites by id.
type testRelay struct {
	*httptest.Server
	mu       sync.Mutex
	requests []*http.Request
	handle   func(w http.ResponseWriter, r *http.Request)
}

func newTestRelay(t *testing.T) *testRelay {
	relay := &testRelay{}
	relay.Server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		relay.mu.Lock()
		relay.requests = append(relay.requests, r.Clone(context.Background()))
		handle := relay.handle
		relay.mu.Unlock()
		handle(w, r)
	}))
	t.Cleanup(relay.Close)
	return relay
}

func (r *testRelay) serve(handle func(w http.ResponseWriter, r *http.Request)) {
	r.mu.Lock()
	r.handle = handle
	r.requests = nil
	r.mu.Unlock()
}

func (r *testRelay) hits() []*http.Request {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.requests
}

func invitePayload(relay string, change func(map[string]any)) []byte {
	encoded := func(size int) string { return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{9}, size)) }
	fields := map[string]any{"v": 1, "relay": relay, "host_id": encoded(16), "host_pub": encoded(32), "invite_id": encoded(16), "secret": encoded(32), "machine_label": "Mac", "owner_name": "Owner", "agent_name": "Agent", "guest_name": "guest-1", "expires_unix": shortNow.Unix() + 60}
	if change != nil {
		change(fields)
	}
	raw, _ := json.Marshal(fields)
	return raw
}

// seal is what the daemon stores: nonce || ciphertext || tag, bound to id.
func seal(t *testing.T, plaintext []byte, id string, key []byte) []byte {
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	return aead.Seal(nonce, nonce, plaintext, []byte(id))
}

const testID = "k7Qp2xRmA1bC"

var testKey = []byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}

func shortLinkOn(base string) string {
	return base + "/i/" + testID + base64.RawURLEncoding.EncodeToString(testKey)
}

func blobHandler(blob []byte) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(blob)
	}
}

func TestShortLinkFetchesOnlyTheIDFromItsOwnRelay(t *testing.T) {
	relay := newTestRelay(t)
	relay.serve(blobHandler(seal(t, invitePayload(relay.URL, nil), testID, testKey)))
	key := base64.RawURLEncoding.EncodeToString(testKey)
	invite, err := Resolve(context.Background(), "Join my agent: "+shortLinkOn(relay.URL)+" thanks!", shortNow, relay.Client().Transport)
	if err != nil {
		t.Fatal(err)
	}
	if invite.Endpoint.Relay != relay.URL || invite.GuestName != "guest-1" || invite.AgentName != "Agent" {
		t.Fatalf("resolved %#v", invite)
	}
	hits := relay.hits()
	if len(hits) != 1 {
		t.Fatalf("%d requests", len(hits))
	}
	request := hits[0]
	if request.Method != http.MethodGet || request.URL.Path != "/v1/invite/"+testID || request.URL.RawQuery != "" {
		t.Fatalf("requested %s %s", request.Method, request.URL)
	}
	headers, _ := json.Marshal(request.Header)
	if strings.Contains(request.URL.String(), key) || strings.Contains(string(headers), key) {
		t.Fatal("the key left this device")
	}
}

func TestShortLinkOpensOnlyOnTheRelayItNames(t *testing.T) {
	relay := newTestRelay(t)
	for name, payload := range map[string][]byte{
		"another relay":      invitePayload("https://guest.herdrup.themartian.app", nil),
		"another relay path": invitePayload(relay.URL+"/base", nil),
		"another port":       invitePayload(strings.Replace(relay.URL, "127.0.0.1:", "127.0.0.1:1", 1), nil),
		"damaged v1 field":   invitePayload(relay.URL, func(f map[string]any) { f["secret"] = "short" }),
		"not json":           []byte("not an invite"),
		"needs a newer app":  invitePayload(relay.URL, func(f map[string]any) { f["v"] = 2 }),
	} {
		relay.serve(blobHandler(seal(t, payload, testID, testKey)))
		if _, err := Resolve(context.Background(), shortLinkOn(relay.URL), shortNow, relay.Client().Transport); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	relay.serve(blobHandler(seal(t, invitePayload(relay.URL, func(f map[string]any) { f["expires_unix"] = shortNow.Unix() }), testID, testKey)))
	if _, err := Resolve(context.Background(), shortLinkOn(relay.URL), shortNow, relay.Client().Transport); !errors.Is(err, ErrExpired) {
		t.Errorf("expired: %v", err)
	}
	relay.serve(blobHandler(seal(t, invitePayload(relay.URL, nil), "k7Qp2xRmA1bD", testKey)))
	if _, err := Resolve(context.Background(), shortLinkOn(relay.URL), shortNow, relay.Client().Transport); !errors.Is(err, ErrNotInvite) {
		t.Errorf("sealed for another id: %v", err)
	}
}

func TestShortLinkFetchFailures(t *testing.T) {
	relay := newTestRelay(t)
	resolveShort := func() error {
		_, err := Resolve(context.Background(), shortLinkOn(relay.URL), shortNow, relay.Client().Transport)
		return err
	}
	relay.serve(func(w http.ResponseWriter, _ *http.Request) { http.NotFound(w, nil) })
	if err := resolveShort(); !errors.Is(err, ErrInviteRevoked) || err.Error() != "This invite has expired or was revoked." {
		t.Errorf("404: %v", err)
	}
	for _, status := range []int{http.StatusInternalServerError, http.StatusTooManyRequests, http.StatusNoContent} {
		relay.serve(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) })
		if err := resolveShort(); !errors.Is(err, ErrInviteUnreachable) {
			t.Errorf("%d: %v", status, err)
		}
	}
	if ErrInviteUnreachable.Error() != "Couldn't reach the invite server; check your connection and try again" {
		t.Errorf("unreachable copy %q", ErrInviteUnreachable)
	}
	closed := httptest.NewTLSServer(http.NotFoundHandler())
	gone := closed.URL
	closed.Close()
	if _, err := Resolve(context.Background(), shortLinkOn(gone), shortNow, relay.Client().Transport); !errors.Is(err, ErrInviteUnreachable) {
		t.Errorf("no relay: %v", err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Resolve(cancelled, shortLinkOn(relay.URL), shortNow, relay.Client().Transport); !errors.Is(err, context.Canceled) {
		t.Errorf("a cancelled review reads as %v", err)
	}
}

// Every redirect is refused, so the GET never leaves the link's relay
// (GuestInvite.swift:521-525 at f2df68b).
func TestShortLinkFetchRefusesRedirects(t *testing.T) {
	elsewhere := newTestRelay(t)
	elsewhere.serve(blobHandler(seal(t, invitePayload(elsewhere.URL, nil), testID, testKey)))
	relay := newTestRelay(t)
	// httptest's TLS servers share one trusted certificate, so a followed
	// redirect to the other origin would succeed: only the refusal keeps it away.
	target := elsewhere.URL + "/v1/invite/" + testID
	relay.serve(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target, http.StatusFound) })
	if _, err := Resolve(context.Background(), shortLinkOn(relay.URL), shortNow, relay.Client().Transport); !errors.Is(err, ErrInviteUnreachable) {
		t.Fatalf("redirect: %v", err)
	}
	if len(elsewhere.hits()) != 0 {
		t.Fatal("the fetch followed a redirect to another host")
	}
}

// The body is capped while it streams: a relay that never stops sending is cut
// off after the cap, not at the deadline (GuestInvite.swift:150-179 at f2df68b).
func TestShortLinkFetchCapsTheBody(t *testing.T) {
	relay := newTestRelay(t)
	fetch := httpSealedInviteFetch(relay.Client().Transport, 10*time.Second)
	target, _ := url.Parse(relay.URL + "/v1/invite/" + testID)
	exact := bytes.Repeat([]byte{7}, maxSealedInvite)
	relay.serve(blobHandler(exact))
	if blob, err := fetch(context.Background(), target); err != nil || !bytes.Equal(blob, exact) {
		t.Fatalf("a %d-byte invite: %d %v", maxSealedInvite, len(blob), err)
	}
	// A body declared over the cap is refused from the head, before any of it
	// is read: this relay sends one byte and then stalls.
	relay.serve(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(maxSealedInvite+1))
		_, _ = w.Write([]byte{1})
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	if _, err := fetch(context.Background(), target); !errors.Is(err, ErrNotInvite) {
		t.Fatalf("declared over the cap: %v", err)
	}
	relay.serve(func(w http.ResponseWriter, r *http.Request) {
		chunk := make([]byte, 512)
		for r.Context().Err() == nil {
			if _, err := w.Write(chunk); err != nil {
				return
			}
			w.(http.Flusher).Flush()
		}
	})
	started := time.Now()
	if _, err := fetch(context.Background(), target); !errors.Is(err, ErrNotInvite) {
		t.Fatalf("endless body: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("endless body read for %v", elapsed)
	}
}

// The deadline covers the whole exchange: a relay that answers its head and
// then trickles is cut off too (GuestInvite.swift:181-220 at f2df68b).
func TestShortLinkFetchDeadline(t *testing.T) {
	relay := newTestRelay(t)
	fetch := httpSealedInviteFetch(relay.Client().Transport, 300*time.Millisecond)
	target, _ := url.Parse(relay.URL + "/v1/invite/" + testID)
	for name, handle := range map[string]func(http.ResponseWriter, *http.Request){
		"silent": func(_ http.ResponseWriter, r *http.Request) { <-r.Context().Done() },
		"trickling": func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			for r.Context().Err() == nil {
				_, _ = w.Write([]byte{1})
				w.(http.Flusher).Flush()
				time.Sleep(50 * time.Millisecond)
			}
		},
	} {
		relay.serve(handle)
		started := time.Now()
		_, err := fetch(context.Background(), target)
		if !errors.Is(err, ErrInviteUnreachable) {
			t.Errorf("%s: %v", name, err)
		}
		if elapsed := time.Since(started); elapsed > 3*time.Second {
			t.Errorf("%s: took %v", name, elapsed)
		}
	}
	if sealedInviteDeadline != 15*time.Second {
		t.Fatalf("the native deadline is 15 s, not %v", sealedInviteDeadline)
	}
}
