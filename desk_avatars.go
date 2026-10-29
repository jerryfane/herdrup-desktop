package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// avatarStore keeps avatar photos the way herdrup's AgentAvatarDirectory
// and AgentAvatarImageCache do: by sha256, forever, since a content address
// never changes meaning. Bytes live on disk under <data dir>/agent-avatars
// and are checked against their sha256 when stored and on every read. Each
// sha is fetched at most once at a time, and a failed one is remembered for
// the rest of the connection and drawn as the initial tile.
type avatarStore struct {
	mu       sync.Mutex
	inflight map[string]*avatarFlight
	failed   map[string]bool
	// owner is the connection failed belongs to; a new one forgets them.
	owner any
}

type avatarFlight struct {
	done chan struct{}
	url  string
	err  error
}

var (
	errAvatarFailed = errors.New("avatar photo unavailable")
	// errNotConnected is not remembered as a failure: the photo is tried
	// again once the connection is back.
	errNotConnected = errors.New("not connected")
)

func avatarDir(dataDir string) string { return filepath.Join(dataDir, "agent-avatars") }

// readAvatar returns the cached bytes for sha, or nil when they are missing
// or no longer hash to sha (a damaged file is removed).
func readAvatar(dir, sha string) []byte {
	p := filepath.Join(dir, sha)
	data, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	if !matchesSHA(data, sha) {
		_ = os.Remove(p)
		return nil
	}
	return data
}

// storeAvatar writes data under sha when it hashes to sha.
func storeAvatar(dir, sha string, data []byte) error {
	if !matchesSHA(data, sha) {
		return fmt.Errorf("avatar bytes do not match sha256 %s", sha)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, sha+".*.tmp")
	if err != nil {
		return err
	}
	_, err = tmp.Write(data)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), filepath.Join(dir, sha))
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
	}
	return err
}

func matchesSHA(data []byte, sha string) bool {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]) == sha
}

// dataURL is the photo as the page draws it. The type is sniffed from the
// bytes, which must be an image.
func dataURL(data []byte) (string, error) {
	mime := http.DetectContentType(data)
	if !strings.HasPrefix(mime, "image/") {
		return "", fmt.Errorf("avatar is %s, not an image", mime)
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

// get returns sha's photo from dir, else fetches it once with fetch, which
// returns agent.avatar.get's base64 bytes. owner is the connection.
func (s *avatarStore) get(ctx context.Context, dir string, owner any, sha string, fetch func(context.Context) (string, error)) (string, error) {
	if !herdr.ValidSHA256(sha) {
		return "", fmt.Errorf("invalid avatar sha256 %q", sha)
	}
	s.mu.Lock()
	if s.owner != owner {
		s.owner, s.failed = owner, nil
	}
	if s.failed[sha] {
		s.mu.Unlock()
		return "", errAvatarFailed
	}
	f := s.inflight[sha]
	if f == nil {
		f = &avatarFlight{done: make(chan struct{})}
		if s.inflight == nil {
			s.inflight = map[string]*avatarFlight{}
		}
		s.inflight[sha] = f
		s.mu.Unlock()
		// The fetch outlives a caller that stops waiting, so the next asker
		// finds it done rather than starting over.
		f.url, f.err = loadAvatar(context.WithoutCancel(ctx), dir, sha, fetch)
		s.mu.Lock()
		delete(s.inflight, sha)
		if f.err != nil && !errors.Is(f.err, errNotConnected) && s.owner == owner {
			if s.failed == nil {
				s.failed = map[string]bool{}
			}
			s.failed[sha] = true
		}
		close(f.done)
	}
	s.mu.Unlock()
	select {
	case <-f.done:
		return f.url, f.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func loadAvatar(ctx context.Context, dir, sha string, fetch func(context.Context) (string, error)) (string, error) {
	if data := readAvatar(dir, sha); data != nil {
		return dataURL(data)
	}
	b64, err := fetch(ctx)
	if err != nil {
		return "", err
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", fmt.Errorf("avatar is not base64: %w", err)
	}
	url, err := dataURL(data)
	if err != nil {
		return "", err
	}
	if err := storeAvatar(dir, sha, data); err != nil {
		return "", err
	}
	return url, nil
}

// AvatarImage returns an agent's avatar photo as a data: URL: target is
// the row's Avatar.Target and sha256 its Avatar.SHA256. Photos come from
// the disk cache, else agent.avatar.get on the current session.
func (d *Desk) AvatarImage(ctx context.Context, target, sha256 string) (string, error) {
	d.mu.Lock()
	l := d.link
	var at boardSession
	var session string
	if l != nil {
		at = boardSession{link: l, client: l.client, gen: l.sessionGen}
		session = l.session
	}
	d.mu.Unlock()
	if at.client == nil {
		return "", errNotConnected
	}
	// Failures belong to this connection and session, as herdrup's
	// AgentAvatarDirectory does (one per connected home, made anew on each
	// reconnect or session switch): a reconnect asks again (#36).
	return d.avatars.get(ctx, avatarDir(d.dir), at, sha256, func(ctx context.Context) (string, error) {
		view, err := at.client.ForSession(session)
		if err != nil {
			return "", err
		}
		img, err := engine.New(engine.Bridge(view)).AgentAvatarGet(ctx, herdrapi.AgentAvatarGetParams{Target: target, SHA256: sha256})
		if err != nil {
			return "", err
		}
		return img.DataBase64, nil
	})
}
