package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// A PNG signature is enough for the content sniffer.
var pngBytes = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR-fake-avatar")

func shaOf(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// The cache verifies on read. Publishing takes bytes loadAvatar has checked
// and hashes nothing again (#381): bytes published under another sha are
// written as given, and the read refuses them.
func TestAvatarCacheVerifiesOnRead(t *testing.T) {
	dir := t.TempDir()
	sha := shaOf(pngBytes)
	other := shaOf([]byte("other"))
	if err := publishAvatar(dir, other, pngBytes); err != nil {
		t.Fatal(err)
	}
	if got := readAvatar(dir, other); got != nil {
		t.Fatalf("served bytes under a sha they do not hash to: %q", got)
	}
	if err := publishAvatar(dir, sha, pngBytes); err != nil {
		t.Fatal(err)
	}
	if got := readAvatar(dir, sha); string(got) != string(pngBytes) {
		t.Fatalf("read back %q", got)
	}
	// A damaged file is not served; a publish replaces it.
	if err := os.WriteFile(filepath.Join(dir, sha), []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := readAvatar(dir, sha); got != nil {
		t.Fatalf("served a damaged file: %q", got)
	}
	if err := publishAvatar(dir, sha, pngBytes); err != nil {
		t.Fatal(err)
	}
	if got := readAvatar(dir, sha); string(got) != string(pngBytes) {
		t.Fatalf("read back %q after replacing a damaged file", got)
	}
}

// #381 review: a publish touches nothing but a regular cache entry. A
// directory where the photo would go keeps its mode, and a link there is
// replaced, its target neither followed nor changed. Modes are compared
// before and after, as each OS reports them (#388).
func TestAvatarPublishLeavesWhatIsNotARegularEntryAlone(t *testing.T) {
	dir := t.TempDir()
	sha := shaOf(pngBytes)
	if err := os.Mkdir(filepath.Join(dir, sha), 0o700); err != nil {
		t.Fatal(err)
	}
	before, err := os.Lstat(filepath.Join(dir, sha))
	if err != nil {
		t.Fatal(err)
	}
	if err := publishAvatar(dir, sha, pngBytes); err == nil {
		t.Fatal("published over a directory")
	}
	if after, err := os.Lstat(filepath.Join(dir, sha)); err != nil || !after.IsDir() || after.Mode() != before.Mode() {
		t.Fatalf("the directory is now %v, %v; want it left at %v", after.Mode(), err, before.Mode())
	}
	// Through the store the verified photo is shown all the same.
	var s avatarStore
	photo, err := s.get(context.Background(), dir, new(int), "t1", sha, func(context.Context) (string, error) {
		return base64.StdEncoding.EncodeToString(pngBytes), nil
	})
	if err != nil || !strings.HasPrefix(photo.URL, "data:image/png;base64,") {
		t.Fatalf("%+v, %v; want the photo", photo, err)
	}

	outside := filepath.Join(t.TempDir(), "elsewhere")
	if err := os.WriteFile(outside, []byte("keep"), 0o444); err != nil {
		t.Fatal(err)
	}
	target, err := os.Stat(outside)
	if err != nil {
		t.Fatal(err)
	}
	linked := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(linked, sha)); err != nil {
		t.Skipf("no symlinks here: %v", err)
	}
	_ = publishAvatar(linked, sha, pngBytes)
	if fi, err := os.Stat(outside); err != nil || fi.Mode() != target.Mode() {
		t.Fatalf("the link's target is now %v, %v; want it left at %v", fi.Mode(), err, target.Mode())
	}
	if got, err := os.ReadFile(outside); err != nil || string(got) != "keep" {
		t.Fatalf("the link's target now reads %q, %v", got, err)
	}
}

// #366 review: a reader that read damaged bytes just before another ask put
// verified ones in their place must not remove the verified file.
func TestAvatarStaleReadKeepsAVerifiedReplacement(t *testing.T) {
	dir := t.TempDir()
	sha := shaOf(pngBytes)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, sha), []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Only this read is staged: the other ask publishes while this reader
	// still holds the stale bytes.
	staged := func(name string) ([]byte, error) {
		stale, err := os.ReadFile(name)
		if err := publishAvatar(dir, sha, pngBytes); err != nil {
			t.Fatal(err)
		}
		return stale, err
	}
	if got := readAvatarWith(staged, dir, sha); got != nil {
		t.Fatalf("served the stale bytes: %q", got)
	}
	if got := readAvatar(dir, sha); string(got) != string(pngBytes) {
		t.Fatalf("the verified photo is gone: read %q", got)
	}
}

// #375 review: verified bytes are the photo even when the cache cannot take
// them (here its directory cannot be made): shown, logged, and nothing
// remembered as failed, so the next ask fetches again.
func TestAvatarGetReturnsVerifiedBytesTheCacheCouldNotTake(t *testing.T) {
	file := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(file, "agent-avatars")
	sha := shaOf(pngBytes)
	var s avatarStore
	owner := new(int)
	calls := 0
	fetch := func(context.Context) (string, error) {
		calls++
		return base64.StdEncoding.EncodeToString(pngBytes), nil
	}
	for range 2 {
		photo, err := s.get(context.Background(), dir, owner, "t1", sha, fetch)
		if err != nil || !strings.HasPrefix(photo.URL, "data:image/png;base64,") {
			t.Fatalf("%+v, %v; want the photo", photo, err)
		}
	}
	if calls != 2 || len(s.failed) != 0 {
		t.Fatalf("fetched %d times, failed %v; want 2 and nothing", calls, s.failed)
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
			p, err := s.get(context.Background(), dir, owner, "t1", sha, fetch)
			if err != nil {
				t.Error(err)
			}
			urls[i] = p.URL
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
	if p, err := fresh.get(context.Background(), dir, owner, "t1", sha, func(context.Context) (string, error) {
		t.Fatal("fetched a cached photo")
		return "", nil
	}); err != nil || p.URL == "" {
		t.Fatal(p, err)
	}
}

func TestAvatarGetRemembersFailuresPerConnection(t *testing.T) {
	dir := t.TempDir()
	sha := shaOf(pngBytes)
	var s avatarStore
	calls := 0
	failing := func(context.Context) (string, error) {
		calls++
		return "", &bridge.APIError{Code: "not_found", Message: "avatar not found"}
	}
	conn1, conn2 := new(int), new(int)
	for range 2 {
		if p, err := s.get(context.Background(), dir, conn1, "t1", sha, failing); err != nil || !p.Unavailable {
			t.Fatalf("%+v, %v; want herdr's refusal as Unavailable", p, err)
		}
	}
	if calls != 1 {
		t.Fatalf("a failed photo was fetched %d times on one connection, want 1", calls)
	}
	if p, err := s.get(context.Background(), dir, conn2, "t1", sha, failing); err != nil || !p.Unavailable || calls != 2 {
		t.Fatalf("a new connection did not retry (calls %d, %+v, %v)", calls, p, err)
	}
	// A failure on the way to herdr is not remembered: not being connected,
	// a dropped connection, a timeout.
	for _, cause := range []error{errNotConnected, errors.New("ssh: unexpected EOF"), context.DeadlineExceeded} {
		other := shaOf([]byte(cause.Error()))
		before := calls
		transient := func(context.Context) (string, error) { calls++; return "", cause }
		for range 2 {
			if p, err := s.get(context.Background(), dir, conn2, "t1", other, transient); err == nil || p != (AvatarPhoto{}) {
				t.Fatalf("%v: %+v, %v; want the error", cause, p, err)
			}
		}
		if calls != before+2 {
			t.Fatalf("%v was remembered as a failure", cause)
		}
	}
}

func TestDefinitiveAvatarFailure(t *testing.T) {
	api := &bridge.APIError{Code: "not_found", Message: "avatar not found"}
	_, notImage := dataURL([]byte("hello, not an image"))
	_, mismatch := loadAvatar(context.Background(), t.TempDir(), shaOf([]byte("other")), func(context.Context) (string, error) {
		return base64.StdEncoding.EncodeToString(pngBytes), nil
	})
	for _, err := range []error{
		api,
		fmt.Errorf("agent.avatar.get: %w", api),
		&engine.ErrUnsupported{Method: "agent.avatar.get", Capability: "agent_avatar"},
		&engine.ResultTagError{Method: "agent.avatar.get", Got: "pong", Want: []string{"agent_avatar_image"}},
		notImage,
		mismatch,
	} {
		if !definitiveAvatarFailure(err) {
			t.Errorf("%v is herdr's answer", err)
		}
	}
	for _, err := range []error{errNotConnected, errors.New("ssh: unexpected EOF"), context.DeadlineExceeded, context.Canceled, os.ErrPermission} {
		if definitiveAvatarFailure(err) {
			t.Errorf("%v is not herdr's answer", err)
		}
	}
}

func TestAvatarGetRefusesWrongBytes(t *testing.T) {
	dir := t.TempDir()
	var s avatarStore
	owner := new(int)
	// Bytes that do not hash to the sha asked for: refused, and not cached.
	expected := shaOf([]byte("expected"))
	p, err := s.get(context.Background(), dir, owner, "t1", expected, func(context.Context) (string, error) {
		return base64.StdEncoding.EncodeToString(pngBytes), nil
	})
	if err != nil || !p.Unavailable {
		t.Fatalf("bytes that do not match their sha256: %+v, %v", p, err)
	}
	if _, err := os.Lstat(filepath.Join(dir, expected)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cached bytes that do not match their sha256: %v", err)
	}
	// Not an image.
	text := []byte("hello, not an image")
	p, err = s.get(context.Background(), dir, owner, "t1", shaOf(text), func(context.Context) (string, error) {
		return base64.StdEncoding.EncodeToString(text), nil
	})
	if err != nil || !p.Unavailable {
		t.Fatalf("a non-image: %+v, %v", p, err)
	}
	if p, err := s.get(context.Background(), dir, owner, "t1", "nope", nil); err != nil || !p.Unavailable {
		t.Fatalf("an invalid sha: %+v, %v", p, err)
	}
}

// #335: a list can move a photo to another pane, and herdr answers not_found
// for the old one. One agent's failed or pending ask never stands for
// another's; a photo loaded from any agent is every agent's.
func TestAvatarGetAsksEachAgentAndSharesWhatLoaded(t *testing.T) {
	dir := t.TempDir()
	sha := shaOf(pngBytes)
	var s avatarStore
	owner := new(int)
	notFound := &bridge.APIError{Code: "not_found", Message: "avatar not found"}
	var asked []string
	ask := func(target string, answer func() (string, error)) (AvatarPhoto, error) {
		return s.get(context.Background(), dir, owner, target, sha, func(context.Context) (string, error) {
			asked = append(asked, target)
			return answer()
		})
	}
	photo := func() (string, error) { return base64.StdEncoding.EncodeToString(pngBytes), nil }
	// t2 no longer has it, and that is remembered.
	for range 2 {
		if p, err := ask("t2", func() (string, error) { return "", notFound }); err != nil || !p.Unavailable {
			t.Fatalf("t2: %+v, %v; want Unavailable", p, err)
		}
	}
	// t4 has it now: asked all the same, and it loads.
	if p, err := ask("t4", photo); err != nil || !strings.HasPrefix(p.URL, "data:image/png;base64,") {
		t.Fatalf("t4: %+v, %v", p, err)
	}
	if strings.Join(asked, ",") != "t2,t4" {
		t.Fatalf("asked %v, want t2 then t4", asked)
	}
	// Loaded, it is any agent's without an ask, t2's included.
	for _, target := range []string{"t2", "t9"} {
		if p, err := ask(target, func() (string, error) { t.Fatalf("asked %s for a loaded photo", target); return "", nil }); err != nil || p.URL == "" {
			t.Fatal(p, err)
		}
	}
}

// An ask of one agent does not wait on another's still pending: t2's has not
// answered when t4's is asked and loads. t2's then fails, and returns the
// photo t4's loaded.
func TestAvatarGetDoesNotJoinAnotherAgentsAsk(t *testing.T) {
	dir := t.TempDir()
	sha := shaOf(pngBytes)
	var s avatarStore
	owner := new(int)
	hang := make(chan struct{})
	release := sync.OnceFunc(func() { close(hang) })
	defer release()
	started := make(chan struct{})
	type result struct {
		photo AvatarPhoto
		err   error
	}
	t2 := make(chan result, 1)
	go func() {
		p, err := s.get(context.Background(), dir, owner, "t2", sha, func(context.Context) (string, error) {
			close(started)
			<-hang
			return "", &bridge.APIError{Code: "not_found", Message: "avatar not found"}
		})
		t2 <- result{p, err}
	}()
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	asked := false
	p, err := s.get(ctx, dir, owner, "t4", sha, func(context.Context) (string, error) {
		asked = true
		return base64.StdEncoding.EncodeToString(pngBytes), nil
	})
	if err != nil || !asked || !strings.HasPrefix(p.URL, "data:image/png;base64,") {
		t.Fatalf("t4: asked %v, %+v, %v", asked, p, err)
	}
	release()
	if late := <-t2; late.err != nil || late.photo != p {
		t.Fatalf("t2 after t4 loaded: %+v, %v; want t4's photo", late.photo, late.err)
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
	for _, when := range []string{"first", "same connection"} {
		if photo, err := d.AvatarImage(context.Background(), "t1", sha); err != nil || !photo.Unavailable {
			t.Fatalf("%s: %+v, %v; want herdr's refusal as Unavailable", when, photo, err)
		}
	}
	if n := gets.Load(); n != 1 {
		t.Fatalf("%d agent.avatar.get on one connection, want the refusal remembered", n)
	}
	srv.DropConns()
	waitFor(t, "a second connection with a board", func() bool {
		d.mu.Lock()
		defer d.mu.Unlock()
		return srv.Conns() == 2 && d.link != nil && d.link.client != nil && d.board != nil
	})
	photo, err := d.AvatarImage(context.Background(), "t1", sha)
	if err != nil || !strings.HasPrefix(photo.URL, "data:image/png;base64,") {
		t.Fatalf("after reconnecting: %+v, %v", photo, err)
	}
	if n := gets.Load(); n != 2 {
		t.Fatalf("%d agent.avatar.get, want 2", n)
	}
}

// #366/#369 reviews: the page tells herdr's answer (Unavailable, remembered)
// from a failure on the way to it (an error, asked again) by AvatarImage's
// result, never by an error's words. A whole reply with a numeric
// data_base64, which the decoder refuses before any byte is checked, is
// herdr's answer as much as a result of another type: asked for once.
func TestDeskAvatarImageAnswersWithAnOutcome(t *testing.T) {
	var mu sync.Mutex
	gets := map[string]int{}
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
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
			var p struct {
				Target string `json:"target"`
			}
			_ = json.Unmarshal(params, &p)
			mu.Lock()
			gets[p.Target]++
			mu.Unlock()
			if p.Target == "numeric" {
				return map[string]any{"type": "agent_avatar_image", "mime": "image/png", "data_base64": 12345}, nil
			}
			return fakeherdr.Pong(true), nil
		}
	})
	sha := shaOf(pngBytes)
	for _, target := range []string{"numeric", "wrong-type"} {
		for range 2 {
			if photo, err := d.AvatarImage(context.Background(), target, sha); err != nil || !photo.Unavailable || photo.URL != "" {
				t.Fatalf("%s: %+v, %v; want Unavailable", target, photo, err)
			}
		}
	}
	mu.Lock()
	asked := fmt.Sprint(gets)
	mu.Unlock()
	if asked != "map[numeric:1 wrong-type:1]" {
		t.Fatalf("agent.avatar.get %s, want each once", asked)
	}
	if photo, err := d.AvatarImage(context.Background(), "t1", "nope"); err != nil || !photo.Unavailable {
		t.Fatalf("invalid sha256: %+v, %v", photo, err)
	}
	// Not connected: an error, which the page asks again for.
	var off Desk
	if photo, err := off.AvatarImage(context.Background(), "t1", sha); !errors.Is(err, errNotConnected) || photo != (AvatarPhoto{}) {
		t.Fatalf("not connected: %+v, %v", photo, err)
	}
}
