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

// reuseAgeLimit is the most a session is reused after its handshake. The
// handshake is the only place herdr tells the guest its features, so a
// session kept busy forever would never hear the owner turn Gram sharing on
// or off; past this age a parked session is closed and the next call
// handshakes again. A call in flight is never cut (herdr-app, message
// 388428, as herdrup#612 does on iOS).
const reuseAgeLimit = 120 * time.Second

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

	// statements gives a bound share's statements (connect).
	statements StatementSource

	// label is the machine's name as the share last heard it (under mu):
	// the access's, then each hello reply's. onLabel hears it change.
	label   string
	onLabel func(label string)
}

// idleSession is a session waiting for a call since since; taken closes
// when it stops waiting.
type idleSession struct {
	session *session
	since   time.Time
	taken   chan struct{}
}

// NewTransport makes a Transport for access. statements gives a bound
// share's statements (Access.AccountBound); a plain share never asks.
// onLabel, when not nil, hears the machine's name when a connect's hello
// reply names it differently from the share (the owner relabeled the
// machine, herdr #519): a valid label, never an absent one (an older
// herdr's). It runs on the connecting goroutine.
func NewTransport(access Access, identity Identity, clock Clock, statements StatementSource, onLabel func(label string)) *Transport {
	ctx, cancel := context.WithCancel(context.Background())
	return &Transport{access: access, identity: identity, clock: clock, statements: statements, ctx: ctx, cancel: cancel, label: access.MachineLabel, onLabel: onLabel}
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
// could be an agent.prompt (herdrup#612 review). A request that fails
// before any write of it was attempted because its context ended, or the
// transport closed, fails unsent (bridge.Unsent).
func (t *Transport) Call(ctx context.Context, method string, params, result any) error {
	if ctx.Err() != nil {
		// Never sent: a cancelled request must not race its session's close.
		return bridge.Unsent(ctx, nil)
	}
	ctx, cancel := context.WithTimeout(ctx, roundTripLimit)
	defer cancel()
	stop := context.AfterFunc(t.ctx, cancel)
	defer stop()
	if err := t.ctx.Err(); err != nil {
		return bridge.Unsent(ctx, err)
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
		if sent {
			return err
		}
		if ctx.Err() != nil {
			return bridge.Unsent(ctx, err)
		}
	}
	connected, err := t.connect(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return bridge.Unsent(ctx, err)
		}
		return err
	}
	if connected.reply.Features.MultiRequest {
		connected.startPump()
	}
	connected.startRefresh(t.clock)
	line, sent, open, err := roundTrip(ctx, connected, request)
	if err != nil {
		if !sent && ctx.Err() != nil {
			return bridge.Unsent(ctx, err)
		}
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
// fit to carry one: herdr ended it or sent on it, it waited past
// reuseIdleLimit, or its handshake is older than reuseAgeLimit.
func (t *Transport) takeIdle() *session {
	t.idleMu.Lock()
	idle := t.idle
	t.idle = nil
	t.idleMu.Unlock()
	if idle == nil {
		return nil
	}
	close(idle.taken)
	now := t.clock.Now()
	if !idle.session.quiet() || !now.Before(idle.since.Add(reuseIdleLimit)) || !now.Before(idle.session.handshook.Add(reuseAgeLimit)) {
		idle.session.close()
		return nil
	}
	return idle.session
}

// park leaves s idle for the next call, in place of any session idle
// already, until reuseIdleLimit passes or herdr ends it.
func (t *Transport) park(s *session) {
	if !t.clock.Now().Before(s.handshook.Add(reuseAgeLimit)) {
		s.close()
		return
	}
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
// connects back. A bound share's hello carries a statement for its account
// (herdr src/guest/store.rs:1121-1128 refuses one without), and the session
// it opens keeps it fresh once started (startRefresh). A hello refused for
// its statement (statement_invalid, statement_expired) goes once more with
// a fresh one, in the sign-in of the first: past a change of sign-in,
// nothing goes out (ErrSignInChanged). Each connect starts in the current
// sign-in; herdr checks it is the share's account (account_mismatch).
func (t *Transport) connect(ctx context.Context) (*session, error) {
	var earlier func() bool
	for attempt := 0; ; attempt++ {
		connected, bound, err := t.connectOnce(ctx, earlier)
		if err == nil {
			return connected, nil
		}
		if attempt == 0 && bound != nil && freshStatementMayAdmit(err) {
			t.statements.Drop(bound.host, bound.jws)
			earlier = bound.admitted
			continue
		}
		return nil, err
	}
}

// connectOnce is one attempt of connect; earlier is the liveness of the
// attempt before it in this handshake, nil for the first. bound is the
// statement the attempt's hello carried, nil for a plain share or none
// sent.
func (t *Transport) connectOnce(ctx context.Context, earlier func() bool) (*session, *boundStatement, error) {
	var bound *boundStatement
	stale := errHelloStale
	if t.access.AccountBound {
		if t.statements == nil {
			return nil, nil, ErrAccountRequired
		}
		if earlier != nil {
			// The retry stays in the sign-in of the attempt before it.
			if !earlier() {
				return nil, nil, ErrSignInChanged
			}
			stale = ErrSignInChanged
		}
		host := t.access.Endpoint.accountHost()
		st, err := t.statements.Statement(ctx, host, statementLead)
		if err != nil {
			// A lookup the change of sign-in spoiled is that change; any
			// other failure in the same sign-in is itself.
			if earlier != nil && !earlier() {
				return nil, nil, ErrSignInChanged
			}
			return nil, nil, err
		}
		admitted := st.Live
		if earlier != nil {
			admitted = func() bool { return earlier() && st.Live() }
		}
		bound = &boundStatement{statements: t.statements, host: host, cutoff: st.Exp, jws: st.JWS, admitted: admitted}
	}
	refusals, ok := t.attempt()
	if !ok {
		return nil, nil, ErrRateLimited
	}
	hello := struct {
		Version int    `json:"v"`
		GuestID string `json:"guest_id"`
		Account string `json:"account,omitempty"`
	}{Version: 1, GuestID: t.access.GuestID}
	var live func() bool
	if bound != nil {
		hello.Account, live = bound.jws, bound.admitted
	}
	payload, err := json.Marshal(hello)
	if err != nil {
		return nil, nil, err
	}
	connected, err := openSession(ctx, t.access.Endpoint, t.identity, payload, live, stale)
	if errors.Is(err, ErrRateLimited) {
		t.limited()
	}
	if err != nil {
		return nil, bound, err
	}
	if connected.reply.GuestID != t.access.GuestID {
		connected.close()
		return nil, nil, ErrRevoked
	}
	if bound != nil && connected.reply.Account != nil {
		// The host's deadline for the session is its first cutoff.
		if deadline := connected.reply.Account.DeadlineUnix; deadline > 0 {
			bound.cutoff = time.Unix(deadline, 0)
		}
		connected.bound = bound
	}
	t.admitted(refusals, connected.reply.Features)
	if label := connected.reply.MachineLabel; label != "" && validLabel(label) {
		t.mu.Lock()
		changed, heard := label != t.label, t.onLabel
		t.label = label
		t.mu.Unlock()
		if changed && heard != nil {
			heard(label)
		}
	}
	connected.handshook = t.clock.Now()
	return connected, nil, nil
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
		return nil, bridge.Unsent(ctx, err)
	}
	connected, err := t.connect(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return nil, bridge.Unsent(ctx, err)
		}
		return nil, err
	}
	connected.startRefresh(t.clock)
	defer func() {
		if !succeeded {
			connected.close()
		}
	}()
	request, err := bridge.EncodeRequest("herdrup:guest:"+strconv.FormatUint(t.seq.Add(1), 10), method, params)
	if err != nil {
		return nil, err
	}
	if sent, err := connected.sendLine(ctx, request); err != nil {
		if !sent && ctx.Err() != nil {
			return nil, bridge.Unsent(ctx, err)
		}
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
