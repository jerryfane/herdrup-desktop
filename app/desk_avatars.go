package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// avatarStore keeps avatar photos the way herdrup's AgentAvatarDirectory
// and AgentAvatarImageCache do: by sha256, forever, since a content address
// never changes meaning. Bytes live on disk under <data dir>/agent-avatars
// and are checked against their sha256 before they are stored and on every read, and
// any agent with that sha is shown them. Asks are by agent and sha: each is
// fetched at most once at a time, and a failed one is remembered for the
// rest of the connection and drawn as the initial tile. An agent's failure
// never stands for another's, nor does one agent's ask wait on another's: a
// list can move a photo to another pane, and herdr answers not_found for the
// old one (#335).
type avatarStore struct {
	mu sync.Mutex
	// inflight and failed are keyed by target and sha (get).
	inflight map[string]*avatarFlight
	failed   map[string]bool
	// owner is the connection failed belongs to; a new one forgets them.
	owner any
}

// avatarFlight is one ask in flight and then its outcome, classified once
// (avatarOutcome) for whoever waits on it.
type avatarFlight struct {
	done  chan struct{}
	photo AvatarPhoto
	err   error
}

// errNotConnected is not remembered as a failure: the photo is tried again
// once the connection is back.
var errNotConnected = errors.New("not connected")

// avatarBytesError is a reply that is not the photo asked for: not base64,
// not an image, or not the bytes of its sha256. Its text is unchanged.
type avatarBytesError struct{ error }

// definitiveAvatarFailure reports whether err is herdr's answer for that
// agent and photo (an API error such as not_found, a herdr without
// agent_avatar, a reply of another type or one that does not decode, bytes
// that are not the photo), which is remembered for the connection, rather
// than the way to herdr failing (a dropped connection, a timeout), which the
// next ask tries again.
func definitiveAvatarFailure(err error) bool {
	var api *bridge.APIError
	var unsupported *engine.ErrUnsupported
	var tag *engine.ResultTagError
	var decode *engine.DecodeError
	var bytes avatarBytesError
	return errors.As(err, &api) || errors.As(err, &unsupported) || errors.As(err, &tag) ||
		errors.As(err, &decode) || errors.As(err, &bytes)
}

// avatarOutcome is a photo's url or failure as AvatarImage answers it: the
// photo, Unavailable for herdr's answer that there is none, or the error of
// a failure on the way to herdr.
func avatarOutcome(url string, err error) (AvatarPhoto, error) {
	switch {
	case err == nil:
		return AvatarPhoto{URL: url}, nil
	case definitiveAvatarFailure(err):
		return AvatarPhoto{Unavailable: true}, nil
	default:
		return AvatarPhoto{}, err
	}
}

func avatarDir(dataDir string) string { return filepath.Join(dataDir, "agent-avatars") }

// readAvatar returns the cached bytes for sha, or nil when they are missing
// or do not hash to sha. A damaged file is a miss and stays: it is never
// removed here, since by the time the bytes are checked another ask may have
// put verified bytes in its place (publishAvatar renames over it), and a path
// removed then would be theirs (#366).
func readAvatar(dir, sha string) []byte { return readAvatarWith(os.ReadFile, dir, sha) }

// readAvatarWith is readAvatar reading with read, which a test stands in for
// to interleave a write with one read.
func readAvatarWith(read func(string) ([]byte, error), dir, sha string) []byte {
	data, err := read(filepath.Join(dir, sha))
	if err != nil || !matchesSHA(data, sha) {
		return nil
	}
	return data
}

// publishAvatar puts data, bytes loadAvatar has already checked are sha's
// photo, in the cache under sha in place of what is there (replaceAvatar: a
// rename, with a repair on Windows only). Nothing else in the cache
// directory is touched (#381).
func publishAvatar(dir, sha string, data []byte) error {
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
		err = replaceAvatar(tmp.Name(), filepath.Join(dir, sha))
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
		return "", avatarBytesError{fmt.Errorf("avatar is %s, not an image", mime)}
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

// get returns sha's photo from dir, else asks target for it once with fetch,
// which returns agent.avatar.get's base64 bytes. owner is the connection. The
// outcome is classified once, in the flight (avatarOutcome): Unavailable,
// herdr's answer, is remembered for the connection and is what later asks
// of that agent get; an error is only a failure on the way to herdr.
func (s *avatarStore) get(ctx context.Context, dir string, owner any, target, sha string, fetch func(context.Context) (string, error)) (AvatarPhoto, error) {
	if !herdr.ValidSHA256(sha) {
		return AvatarPhoto{Unavailable: true}, nil
	}
	// Loaded already, from whichever agent: no ask, and no failure of this
	// agent's stands against it.
	if data := readAvatar(dir, sha); data != nil {
		return avatarOutcome(dataURL(data))
	}
	key := target + " " + sha
	s.mu.Lock()
	if s.owner != owner {
		s.owner, s.failed = owner, nil
	}
	if s.failed[key] {
		s.mu.Unlock()
		return AvatarPhoto{Unavailable: true}, nil
	}
	f := s.inflight[key]
	if f == nil {
		f = &avatarFlight{done: make(chan struct{})}
		if s.inflight == nil {
			s.inflight = map[string]*avatarFlight{}
		}
		s.inflight[key] = f
		s.mu.Unlock()
		// The fetch outlives a caller that stops waiting, so the next asker
		// finds it done rather than starting over.
		url, err := loadAvatar(context.WithoutCancel(ctx), dir, sha, fetch)
		if err != nil {
			// Another agent's ask may have loaded the same photo meanwhile.
			if data := readAvatar(dir, sha); data != nil {
				url, err = dataURL(data)
			}
		}
		// Classified once, the result this flight hands its waiters.
		f.photo, f.err = avatarOutcome(url, err)
		s.mu.Lock()
		delete(s.inflight, key)
		// Only herdr's answer is remembered; a failure on the way to it
		// (errNotConnected among them) is asked again.
		if f.photo.Unavailable && s.owner == owner {
			if s.failed == nil {
				s.failed = map[string]bool{}
			}
			s.failed[key] = true
		}
		close(f.done)
	}
	s.mu.Unlock()
	select {
	case <-f.done:
		return f.photo, f.err
	case <-ctx.Done():
		return AvatarPhoto{}, ctx.Err()
	}
}

// loadAvatar returns sha's photo from the disk cache, else fetches it, checks
// the bytes are its sha256's and an image, and publishes them to the cache.
// Publishing is the cache's business: verified bytes are the photo whether or
// not the file could be written, so a failed write is logged and is no
// failure of the ask (#375). The publisher gets the checked bytes and hashes
// nothing again.
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
		return "", avatarBytesError{fmt.Errorf("avatar is not base64: %w", err)}
	}
	if !matchesSHA(data, sha) {
		return "", avatarBytesError{fmt.Errorf("avatar bytes do not match sha256 %s", sha)}
	}
	url, err := dataURL(data)
	if err != nil {
		return "", err
	}
	if err := publishAvatar(dir, sha, data); err != nil {
		log.Printf("avatar %s: cache: %v", sha, err)
	}
	return url, nil
}

// AvatarPhoto is AvatarImage's answer: the photo as a data: URL, or
// Unavailable when herdr's answer was that there is none to draw for that
// agent and sha256 (definitiveAvatarFailure), which the page remembers for
// the connection. A failure on the way to herdr is AvatarImage's error
// instead, and the page asks again on its next render: so the page never
// reads an error's words to decide.
type AvatarPhoto struct {
	URL         string `json:"url,omitempty"`
	Unavailable bool   `json:"unavailable,omitempty"`
}

// AvatarImage returns an agent's avatar photo: target is the row's
// Avatar.Target and sha256 its Avatar.SHA256. Photos come from the disk
// cache, else agent.avatar.get on the current session.
func (d *Desk) AvatarImage(ctx context.Context, target, sha256 string) (AvatarPhoto, error) {
	if !herdr.ValidSHA256(sha256) {
		return AvatarPhoto{Unavailable: true}, nil
	}
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
		return AvatarPhoto{}, errNotConnected
	}
	// Failures belong to this connection and session, as herdrup's
	// AgentAvatarDirectory does (one per connected home, made anew on each
	// reconnect or session switch): a reconnect asks again (#36).
	return d.avatars.get(ctx, avatarDir(d.dir), at, target, sha256, func(ctx context.Context) (string, error) {
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
