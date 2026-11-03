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

// reuseIdleLimit is how long a Transport keeps a session idle for its next
// call. herdr ends one after 60 s without a request (guest_gate.rs
// SESSION_IDLE_TIMEOUT); leaving it 10 s sooner keeps a call from racing
// that close.
const reuseIdleLimit = 50 * time.Second

// Transport opens an authenticated Noise session for API requests. A host
// that answers further requests on a session (features.multi_request) keeps
// the one a call ends with for the next call, so polling stays under the
// relay's connect limit; otherwise every request has a fresh session.
// Streams always have one of their own. Closing it cancels both established
// streams and pending relay handshakes. After the relay's 429 every request
// that needs a connect fails with ErrRateLimited, without connecting, until
// the backoff ends.
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
	// once a connect goes through. refusals counts the 429s that started a
	// backoff, so a connect that began before one cannot end it.
	backoff  time.Duration
	retryAt  time.Time
	refusals uint64
	// idle is the session the last call left for the next one, if any. A
	// call takes it, so a session never carries two requests at once.
	idleMu sync.Mutex
	idle   *idleSession
}

// idleSession is a session waiting for a call since since; taken closes
// when it stops waiting.
type idleSession struct {
	session *session
	since   time.Time
	taken   chan struct{}
}

func NewTransport(access Access, identity Identity, clock Clock) *Transport {
	ctx, cancel := context.WithCancel(context.Background())
	return &Transport{access: access, identity: identity, clock: clock, ctx: ctx, cancel: cancel}
}
func (t *Transport) Done() <-chan struct{} { return t.ctx.Done() }
func (t *Transport) Close() error {
	t.cancel()
	t.idleMu.Lock()
	idle := t.idle
	t.idle = nil
	t.idleMu.Unlock()
	if idle != nil {
		close(idle.taken)
		idle.session.close()
	}
	return nil
}
func (t *Transport) Features() Features { t.mu.RLock(); defer t.mu.RUnlock(); return t.features }

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
	t.refusals++
}

// attempt says whether a connect may go out now, and the refusals so far:
// what admitted needs to know whether a 429 came while it was in flight.
func (t *Transport) attempt() (uint64, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.refusals, !t.clock.Now().Before(t.retryAt)
}

// admitted records a connect the relay let through, begun after refusals
// 429s. It ends the backoff only when no 429 came while it was in flight: a
// handshake the relay admitted before refusing a later connect says nothing
// about the relay now, and ending that cooldown would let the next request
// reach the relay and restart the escalation at 15 s.
func (t *Transport) admitted(refusals uint64, features Features) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.features = features
	if t.refusals == refusals {
		t.backoff, t.retryAt = 0, time.Time{}
	}
}

// Call sends one request and decodes its reply. It goes on the idle session
// if there is one; when that session was known to have ended before any
// write of the request was attempted, so herdr cannot have it, the request
// goes once more on a fresh session. Once a write was attempted the request
// is never sent again, whatever the write returned: herdr may have it, and it
// could be an agent.prompt (herdrup#612 review).
func (t *Transport) Call(ctx context.Context, method string, params, result any) error {
	ctx, cancel := context.WithTimeout(ctx, roundTripLimit)
	defer cancel()
	stop := context.AfterFunc(t.ctx, cancel)
	defer stop()
	if err := t.ctx.Err(); err != nil {
		return err
	}
	request, err := bridge.EncodeRequest("herdrup:guest:"+strconv.FormatUint(t.seq.Add(1), 10), method, params)
	if err != nil {
		return err
	}
	if reused := t.takeIdle(); reused != nil {
		line, sent, open, err := roundTrip(ctx, reused, request)
		if err == nil {
			return t.decode(reused, open, line, result)
		}
		if sent || ctx.Err() != nil {
			return err
		}
	}
	connected, err := t.connect(ctx)
	if err != nil {
		return err
	}
	if connected.reply.Features.MultiRequest {
		connected.startPump()
	}
	line, _, open, err := roundTrip(ctx, connected, request)
	if err != nil {
		return err
	}
	return t.decode(connected, open, line, result)
}

// roundTrip sends request on s and reads its reply line. sent says a write
// of the request was attempted, so herdr may have it. On an error s is
// closed; otherwise open says it is still open, for decode.
func roundTrip(ctx context.Context, s *session, request []byte) (line []byte, sent, open bool, err error) {
	cancelled := context.AfterFunc(ctx, s.close)
	defer cancelled()
	if sent, err = s.sendLine(ctx, request); err != nil {
		s.close()
		return nil, sent, false, err
	}
	reader := lineReader{session: s, ctx: ctx}
	if line, err = reader.Next(); err != nil {
		s.close()
		return nil, true, false, err
	}
	// Anything after the reply line, or a cancel that closed s meanwhile,
	// spends the session.
	if len(reader.pending) > 0 || !cancelled() {
		s.close()
		return line, true, false, nil
	}
	return line, true, true, nil
}

// decode decodes the reply line s carried, then leaves s idle for the next
// call when it is open and herdr keeps serving it, or closes it.
func (t *Transport) decode(s *session, open bool, line []byte, result any) error {
	err := bridge.DecodeReply(line, result)
	if open && s.frames != nil && keepsSession(err) {
		t.park(s)
	} else {
		s.close()
	}
	return err
}

// keepsSession says herdr serves further requests after a reply that
// decoded to err: it ends the session after guest_paused, guest_revoked and
// invalid_request (guest_gate.rs serve_session), and a reply that does not
// decode is not trusted.
func keepsSession(err error) bool {
	if err == nil {
		return true
	}
	var refused *bridge.APIError
	if !errors.As(err, &refused) {
		return false
	}
	switch refused.Code {
	case "guest_paused", "guest_revoked", "invalid_request":
		return false
	}
	return true
}

// takeIdle takes the idle session for a call, or nil when there is none
// fit to carry one: herdr ended it or sent on it, or it waited past
// reuseIdleLimit.
func (t *Transport) takeIdle() *session {
	t.idleMu.Lock()
	idle := t.idle
	t.idle = nil
	t.idleMu.Unlock()
	if idle == nil {
		return nil
	}
	close(idle.taken)
	if !idle.session.quiet() || !t.clock.Now().Before(idle.since.Add(reuseIdleLimit)) {
		idle.session.close()
		return nil
	}
	return idle.session
}

// park leaves s idle for the next call, in place of any session idle
// already, until reuseIdleLimit passes or herdr ends it.
func (t *Transport) park(s *session) {
	idle := &idleSession{session: s, since: t.clock.Now(), taken: make(chan struct{})}
	expiry := t.clock.After(reuseIdleLimit)
	t.idleMu.Lock()
	if t.ctx.Err() != nil {
		t.idleMu.Unlock()
		s.close()
		return
	}
	previous := t.idle
	t.idle = idle
	t.idleMu.Unlock()
	if previous != nil {
		close(previous.taken)
		previous.session.close()
	}
	go func() {
		select {
		case <-idle.taken:
			return
		case <-expiry:
		case <-s.dead:
		}
		t.idleMu.Lock()
		mine := t.idle == idle
		if mine {
			t.idle = nil
		}
		t.idleMu.Unlock()
		if mine {
			s.close()
		}
	}()
}

// connect opens a session for the access, unless the relay's backoff holds
// connects back.
func (t *Transport) connect(ctx context.Context) (*session, error) {
	refusals, ok := t.attempt()
	if !ok {
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
	if connected.reply.GuestID != t.access.GuestID {
		connected.close()
		return nil, ErrRevoked
	}
	t.admitted(refusals, connected.reply.Features)
	return connected, nil
}

// OpenStream sends one request on a fresh session of its own, whose reply
// lines are read until herdr closes it: pane.stream takes a session over.
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
	connected, err := t.connect(ctx)
	if err != nil {
		return nil, err
	}
	defer func() {
		if !succeeded {
			connected.close()
		}
	}()
	request, err := bridge.EncodeRequest("herdrup:guest:"+strconv.FormatUint(t.seq.Add(1), 10), method, params)
	if err != nil {
		return nil, err
	}
	if _, err := connected.sendLine(ctx, request); err != nil {
		return nil, err
	}
	stream := &relayStream{lineReader: lineReader{session: connected, ctx: ctx}, cancel: cancel, stopParent: stop}
	stream.stopSocket = context.AfterFunc(ctx, connected.close)
	succeeded = true
	return stream, nil
}

type relayStream struct {
	lineReader
	cancel     context.CancelFunc
	stopParent func() bool
	stopSocket func() bool
	once       sync.Once
}

// lineReader reads a session's reply lines; frame boundaries are unrelated
// to them.
type lineReader struct {
	session *session
	ctx     context.Context
	pending []byte
}

// Next owns its returned bytes; a following read cannot mutate them.
func (s *lineReader) Next() ([]byte, error) {
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
