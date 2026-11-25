package account

import (
	"context"
	"errors"
	"sync"
	"time"
)

// A statement (DESIGN #698 §3.3, AccountService src/statements.ts:60
// handleStatements) says this session's device key belongs to the account,
// for one host, for 600 seconds: POST /v1/statements {hosts} answers
// {statements: [{host, jws}], exp}, exp absolute (unix seconds). A guest
// presents one in its hello and refreshes it in its session (herdr
// src/guest/link/session.rs). The service refuses a session without a
// device (403 device_required) or whose device was removed (403
// device_removed) or withdrawn (403 device_withdrawn), as *APIError.

// HostStatement is one host's statement and when it expires.
type HostStatement struct {
	JWS string
	Exp time.Time
}

// ErrNoStatement is an answer without a statement for the host asked for.
var ErrNoStatement = errors.New("account: the account service gave no statement for this machine")

// StatementRefreshLead is how much of a statement is left when a client asks
// for a new one (DESIGN §3.3: "less than 2 minutes remain").
const StatementRefreshLead = 2 * time.Minute

// StatementCache holds the current session's statements by host, as the
// web's src/web/statements.ts statementCache does: one is reused while it has
// at least the time asked for left, and asked for again otherwise; callers
// that ask at once for a host share one request. A statement belongs to the
// session it was issued in: a sign-out or another sign-in drops them all,
// and an answer that comes after its session ended is not kept or given.
type StatementCache struct {
	client *Client

	mu      sync.Mutex
	session Round
	held    map[string]HostStatement
	asking  map[string]*statementFlight
}

type statementFlight struct {
	done chan struct{}
	got  HostStatement
	err  error
}

// NewStatementCache caches c's statements.
func NewStatementCache(c *Client) *StatementCache {
	return &StatementCache{client: c}
}

// Statement is host's statement with at least minLeft left, or the newest
// the service gives (which may have less: it is all there is). It fails with
// ErrSignedOut when signed out, and ErrAccountChanged when the session ended
// while it was asked for.
func (s *StatementCache) Statement(ctx context.Context, host string, minLeft time.Duration) (string, time.Time, error) {
	got, err := s.Get(ctx, host, minLeft)
	return got.JWS, got.Exp, err
}

// Get is Statement as a HostStatement.
func (s *StatementCache) Get(ctx context.Context, host string, minLeft time.Duration) (HostStatement, error) {
	r, ok, err := s.client.Round()
	if err != nil {
		return HostStatement{}, err
	}
	if !ok {
		return HostStatement{}, ErrSignedOut
	}
	s.mu.Lock()
	if s.session != r {
		s.session, s.held, s.asking = r, map[string]HostStatement{}, map[string]*statementFlight{}
	}
	if held, ok := s.held[host]; ok && held.Exp.Sub(s.client.now()) >= minLeft {
		s.mu.Unlock()
		return held, nil
	}
	flight := s.asking[host]
	if flight == nil {
		flight = &statementFlight{done: make(chan struct{})}
		s.asking[host] = flight
		held, asking := s.held, s.asking
		go func() {
			// The request is the flight's, not one caller's: a caller that
			// stops waiting leaves it to the others.
			got, err := s.ask(context.WithoutCancel(ctx), r, host)
			s.mu.Lock()
			if err == nil && s.session == r && s.client.Holds(r) {
				held[host] = got
			}
			delete(asking, host)
			s.mu.Unlock()
			flight.got, flight.err = got, err
			close(flight.done)
		}()
	}
	s.mu.Unlock()
	select {
	case <-flight.done:
	case <-ctx.Done():
		return HostStatement{}, ctx.Err()
	}
	if flight.err != nil {
		return HostStatement{}, flight.err
	}
	if !s.client.Holds(r) {
		return HostStatement{}, ErrAccountChanged
	}
	return flight.got, nil
}

// ask requests host's statement in session r.
func (s *StatementCache) ask(ctx context.Context, r Round, host string) (HostStatement, error) {
	statements, exp, err := s.client.statements(ctx, r, []string{host})
	if err != nil {
		return HostStatement{}, err
	}
	for _, st := range statements {
		if st.Host == host && st.JWS != "" && exp > 0 {
			return HostStatement{JWS: st.JWS, Exp: time.Unix(exp, 0)}, nil
		}
	}
	return HostStatement{}, ErrNoStatement
}
