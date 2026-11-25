package bridge

import (
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
