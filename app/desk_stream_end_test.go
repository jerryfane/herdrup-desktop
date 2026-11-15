package main

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
)

// herdr #410: a pane stream herdr ends on purpose for a slow or failed reader asks the app to
// reconnect; any other end shows as an error, as before.
func TestOnlyHerdrsDeliberateStreamEndsReconnect(t *testing.T) {
	end := func(code string) error {
		return &engine.StreamError{Method: "pane.stream", APIError: &bridge.APIError{Code: code, Message: "x"}}
	}
	for _, c := range []struct {
		err  error
		want bool
	}{
		{end("stream_stalled"), true},
		{end("stream_failed"), true},
		{fmt.Errorf("wrapped: %w", end("stream_stalled")), true},
		{end("pane_not_found"), false},
		{end("guest_forbidden"), false},
		{errors.New("ssh: disconnect"), false},
	} {
		if got := streamEndedForReconnect(c.err); got != c.want {
			t.Errorf("%v: reconnect %v, want %v", c.err, got, c.want)
		}
	}
}
