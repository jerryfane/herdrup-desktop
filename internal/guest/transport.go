package guest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
)

// Clock is a Transport's time, and its owner's status poll's.
type Clock interface {
	Now() time.Time
	After(time.Duration) <-chan time.Time
}

type systemClock struct{}

func (systemClock) Now() time.Time                         { return time.Now() }
func (systemClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

// SystemClock is the wall clock.
var SystemClock Clock = systemClock{}

// The relay allows a network 30 guest connects a minute and answers more with
// 429 rate_limited. After one, a Transport connects again only after
// relayBackoffFirst, doubling to relayBackoffMax while the relay keeps
// refusing; a connect that goes through starts over.
const (
	relayBackoffFirst = 15 * time.Second
	relayBackoffMax   = 60 * time.Second
)

// relayBackoff is the wait after the relay's next 429, given the last.
func relayBackoff(last time.Duration) time.Duration {
	if last == 0 {
		return relayBackoffFirst
	}
	return min(2*last, relayBackoffMax)
}

// Transport opens a fresh authenticated Noise session for each API request.
// Closing it cancels both established streams and pending relay handshakes.
// After the relay's 429 every request fails with ErrRateLimited, without
// connecting, until the backoff ends.
type Transport struct {
	access   Access
	identity Identity
	clock    Clock
	ctx      context.Context
	cancel   context.CancelFunc
	seq      atomic.Uint64
	mu       sync.RWMutex
	features Features
	// backoff is the wait after the last 429 and retryAt its end; both zero
	// once a connect goes through.
	backoff time.Duration
	retryAt time.Time
}

func NewTransport(access Access, identity Identity, clock Clock) *Transport {
	ctx, cancel := context.WithCancel(context.Background())
	return &Transport{access: access, identity: identity, clock: clock, ctx: ctx, cancel: cancel}
}
func (t *Transport) Done() <-chan struct{} { return t.ctx.Done() }
func (t *Transport) Close() error          { t.cancel(); return nil }
func (t *Transport) Features() Features    { t.mu.RLock(); defer t.mu.RUnlock(); return t.features }

// RateLimitedUntil is when the transport connects again after the relay's
// 429; zero when it is not waiting.
func (t *Transport) RateLimitedUntil() time.Time {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if !t.clock.Now().Before(t.retryAt) {
		return time.Time{}
	}
	return t.retryAt
}

// limited starts the next backoff after a 429, unless one started while this
// connect was in flight: the requests the page and the status poll had out at
// once all hear the same refusal.
func (t *Transport) limited() {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.clock.Now()
	if now.Before(t.retryAt) {
		return
	}
	t.backoff = relayBackoff(t.backoff)
	t.retryAt = now.Add(t.backoff)
}

func (t *Transport) Call(ctx context.Context, method string, params, result any) error {
	ctx, cancel := context.WithTimeout(ctx, roundTripLimit)
	defer cancel()
	stream, err := t.OpenStream(ctx, method, params)
	if err != nil {
		return err
	}
	defer stream.Close()
	line, err := stream.Next()
	if err != nil {
		return err
	}
	return bridge.DecodeReply(line, result)
}

func (t *Transport) OpenStream(parent context.Context, method string, params any) (engine.Stream, error) {
	ctx, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(t.ctx, cancel)
	succeeded := false
	defer func() {
		if !succeeded {
			stop()
			cancel()
		}
	}()
	if err := t.ctx.Err(); err != nil {
		return nil, err
	}
	if !t.RateLimitedUntil().IsZero() {
		return nil, ErrRateLimited
	}
	hello, err := json.Marshal(struct {
		Version int    `json:"v"`
		GuestID string `json:"guest_id"`
	}{1, t.access.GuestID})
	if err != nil {
		return nil, err
	}
	connected, err := openSession(ctx, t.access.Endpoint, t.identity, hello)
	if errors.Is(err, ErrRateLimited) {
		t.limited()
	}
	if err != nil {
		return nil, err
	}
	defer func() {
		if !succeeded {
			connected.close()
		}
	}()
	if connected.reply.GuestID != t.access.GuestID {
		return nil, ErrRevoked
	}
	t.mu.Lock()
	t.features = connected.reply.Features
	t.backoff, t.retryAt = 0, time.Time{}
	t.mu.Unlock()
	request, err := bridge.EncodeRequest("herdrup:guest:"+strconv.FormatUint(t.seq.Add(1), 10), method, params)
	if err != nil {
		return nil, err
	}
	if err := connected.sendLine(ctx, request); err != nil {
		return nil, err
	}
	stream := &relayStream{session: connected, ctx: ctx, cancel: cancel, stopParent: stop}
	stream.stopSocket = context.AfterFunc(ctx, connected.close)
	succeeded = true
	return stream, nil
}

type relayStream struct {
	session    *session
	ctx        context.Context
	cancel     context.CancelFunc
	stopParent func() bool
	stopSocket func() bool
	once       sync.Once
	pending    []byte
}

// Next owns its returned bytes; a following read cannot mutate them.
func (s *relayStream) Next() ([]byte, error) {
	var line []byte
	for {
		if at := bytes.IndexByte(s.pending, '\n'); at >= 0 {
			if len(line)+at > bridge.MaxReplyLineBytes {
				return nil, errors.New("Shared-machine reply exceeds the maximum line size.")
			}
			if len(line) == 0 {
				line = s.pending[:at:at]
			} else {
				line = append(line, s.pending[:at]...)
			}
			s.pending = s.pending[at+1:]
			return line, nil
		}
		if len(line)+len(s.pending) > bridge.MaxReplyLineBytes {
			return nil, errors.New("Shared-machine reply exceeds the maximum line size.")
		}
		line = append(line, s.pending...)
		s.pending = nil
		chunk, err := s.session.readChunk(s.ctx)
		if err != nil {
			if errors.Is(err, io.EOF) && len(line) > 0 {
				return nil, io.ErrUnexpectedEOF
			}
			return nil, err
		}
		s.pending = chunk
	}
}
func (s *relayStream) Close() error {
	s.once.Do(func() { s.stopParent(); s.stopSocket(); s.cancel(); s.session.close() })
	return nil
}

var _ engine.Transport = (*Transport)(nil)
