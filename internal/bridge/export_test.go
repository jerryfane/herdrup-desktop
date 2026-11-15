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
