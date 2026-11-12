package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// A PNG signature is enough for the content sniffer.
var pngBytes = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR-fake-avatar")

func shaOf(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestAvatarCacheVerifiesOnStoreAndRead(t *testing.T) {
	dir := t.TempDir()
	sha := shaOf(pngBytes)
	if err := storeAvatar(dir, shaOf([]byte("other")), pngBytes); err == nil {
		t.Fatal("stored bytes under a sha they do not hash to")
	}
	if err := storeAvatar(dir, sha, pngBytes); err != nil {
		t.Fatal(err)
	}
	if got := readAvatar(dir, sha); string(got) != string(pngBytes) {
		t.Fatalf("read back %q", got)
	}
	// A damaged file is not served, and is removed.
	if err := os.WriteFile(filepath.Join(dir, sha), []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := readAvatar(dir, sha); got != nil {
		t.Fatalf("served a damaged file: %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, sha)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("damaged file kept: %v", err)
	}
}

func TestAvatarGetFetchesOnceAndCaches(t *testing.T) {
	dir := t.TempDir()
	sha := shaOf(pngBytes)
	var s avatarStore
	var calls atomic.Int32
	release := make(chan struct{})
	fetch := func(context.Context) (string, error) {
		calls.Add(1)
		<-release
		return base64.StdEncoding.EncodeToString(pngBytes), nil
	}
	owner := new(int)
	var wg sync.WaitGroup
	urls := make([]string, 4)
	for i := range urls {
		wg.Add(1)
		go func() {
			defer wg.Done()
			u, err := s.get(context.Background(), dir, owner, sha, fetch)
			if err != nil {
				t.Error(err)
			}
			urls[i] = u
		}()
	}
	waitFor(t, "a fetch in flight", func() bool { return calls.Load() >= 1 })
	close(release)
	wg.Wait()
	if n := calls.Load(); n != 1 {
		t.Fatalf("fetched %d times, want once", n)
	}
	for _, u := range urls {
		if !strings.HasPrefix(u, "data:image/png;base64,") {
			t.Fatalf("url %q", u)
		}
	}
	// From disk afterwards, on a fresh store (a new launch).
	var fresh avatarStore
	if _, err := fresh.get(context.Background(), dir, owner, sha, func(context.Context) (string, error) {
		t.Fatal("fetched a cached photo")
		return "", nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestAvatarGetRemembersFailuresPerConnection(t *testing.T) {
	dir := t.TempDir()
	sha := shaOf(pngBytes)
	var s avatarStore
	calls := 0
	failing := func(context.Context) (string, error) { calls++; return "", errors.New("boom") }
	conn1, conn2 := new(int), new(int)
	for range 2 {
		if _, err := s.get(context.Background(), dir, conn1, sha, failing); err == nil {
			t.Fatal("no error")
		}
	}
	if calls != 1 {
		t.Fatalf("a failed photo was fetched %d times on one connection, want 1", calls)
	}
	if _, err := s.get(context.Background(), dir, conn2, sha, failing); err == nil || calls != 2 {
		t.Fatalf("a new connection did not retry (calls %d)", calls)
	}
	// Not being connected is not remembered.
	offline := func(context.Context) (string, error) { calls++; return "", errNotConnected }
	other := shaOf([]byte("x"))
	s.get(context.Background(), dir, conn2, other, offline)
	s.get(context.Background(), dir, conn2, other, offline)
	if calls != 4 {
		t.Fatalf("not connected was remembered as a failure (calls %d)", calls)
	}
}

func TestAvatarGetRejectsWrongBytes(t *testing.T) {
	dir := t.TempDir()
	var s avatarStore
	owner := new(int)
	// Bytes that do not hash to the sha asked for.
	_, err := s.get(context.Background(), dir, owner, shaOf([]byte("expected")), func(context.Context) (string, error) {
		return base64.StdEncoding.EncodeToString(pngBytes), nil
	})
	if err == nil {
		t.Fatal("accepted bytes that do not match their sha256")
	}
	// Not an image.
	text := []byte("hello, not an image")
	_, err = s.get(context.Background(), dir, owner, shaOf(text), func(context.Context) (string, error) {
		return base64.StdEncoding.EncodeToString(text), nil
	})
	if err == nil {
		t.Fatal("accepted a non-image")
	}
	if _, err := s.get(context.Background(), dir, owner, "nope", nil); err == nil {
		t.Fatal("accepted an invalid sha")
	}
}

// #36: a photo whose fetch failed on one SSH connection is asked for again
// once the desk has reconnected, not drawn as the initial tile for good.
func TestDeskAvatarFailureIsForgottenOnReconnect(t *testing.T) {
	var gets atomic.Int32
	d, srv := federatedDesk(t, func(s *fakeherdr.Server) {
		handle := s.Handle
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "ping":
				pong := fakeherdr.Pong(true)
				pong["capabilities"].(map[string]bool)["agent_avatar"] = true
				return pong, nil
			case "agent.avatar.get":
			default:
				return handle(method, params)
			}
			if gets.Add(1) == 1 {
				return nil, &fakeherdr.APIError{Code: "server_unavailable", Message: "reloading"}
			}
			return map[string]any{"type": "agent_avatar_image", "mime": "image/png",
				"data_base64": base64.StdEncoding.EncodeToString(pngBytes)}, nil
		}
	})
	sha := shaOf(pngBytes)
	if _, err := d.AvatarImage(context.Background(), "t1", sha); err == nil {
		t.Fatal("the first fetch succeeded")
	}
	if _, err := d.AvatarImage(context.Background(), "t1", sha); !errors.Is(err, errAvatarFailed) {
		t.Fatalf("same connection: %v, want the failure remembered", err)
	}
	srv.DropConns()
	waitFor(t, "a second connection with a board", func() bool {
		d.mu.Lock()
		defer d.mu.Unlock()
		return srv.Conns() == 2 && d.link != nil && d.link.client != nil && d.board != nil
	})
	url, err := d.AvatarImage(context.Background(), "t1", sha)
	if err != nil || !strings.HasPrefix(url, "data:image/png;base64,") {
		t.Fatalf("after reconnecting: %q, %v", url, err)
	}
	if n := gets.Load(); n != 2 {
		t.Fatalf("%d agent.avatar.get, want 2", n)
	}
}
