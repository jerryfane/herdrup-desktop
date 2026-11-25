package bridge

import (
	"context"
	"testing"
	"time"
)

// SetAbandonGrace shortens abandonGrace for one test.
func SetAbandonGrace(t *testing.T, d time.Duration) {
	old := abandonGrace
	abandonGrace = d
	t.Cleanup(func() { abandonGrace = old })
}

// GunzipReply exposes gunzipReply to the bridge_test package.
var GunzipReply = gunzipReply

// MultiAlive reports whether c's session holds a --multi channel that
// takes new requests.
func MultiAlive(c *Client) bool {
	p := &c.pool
	p.mu.Lock()
	m := p.slot(c.cfg.Session).ch
	p.mu.Unlock()
	return m != nil && m.alive()
}

// SessionChannel is c's session's --multi channel as it is now, for a test
// to drive; nil inside when there is none.
type SessionChannel struct{ m *multiChannel }

func ChannelOf(c *Client) SessionChannel {
	p := &c.pool
	p.mu.Lock()
	defer p.mu.Unlock()
	return SessionChannel{p.slot(c.cfg.Session).ch}
}

// LockWrites takes the channel's write lock until the returned func runs.
func (s SessionChannel) LockWrites() (unlock func()) {
	s.m.wmu.Lock()
	return s.m.wmu.Unlock
}

// Pending is how many requests wait on the channel.
func (s SessionChannel) Pending() int {
	s.m.mu.Lock()
	defer s.m.mu.Unlock()
	return len(s.m.pending)
}

// Retire retires the channel, as an abandoned request herdr never answers
// does.
func (s SessionChannel) Retire() {
	s.m.mu.Lock()
	defer s.m.mu.Unlock()
	s.m.retireLocked()
}

// Dead is closed once the channel is closed.
func (s SessionChannel) Dead() <-chan struct{} { return s.m.dead }

// Do sends one request with no params on the channel itself.
func (s SessionChannel) Do(ctx context.Context, method string) error {
	id := method + "-test"
	line, err := EncodeRequest(id, method, nil)
	if err != nil {
		return err
	}
	_, err = s.m.do(ctx, id, line)
	return err
}
