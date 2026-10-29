package bridge_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// TestStalledChannelOpenEndsWithContext opens a channel the server never
// confirms: every opener returns at its deadline, and the channel that
// opens once the server answers is closed.
func TestStalledChannelOpenEndsWithContext(t *testing.T) {
	openers := map[string]func(context.Context, *bridge.Client) error{
		"SetMachineFederation": func(ctx context.Context, c *bridge.Client) error {
			return c.SetMachineFederation(ctx, profile, true)
		},
		"ListSessions": func(ctx context.Context, c *bridge.Client) error {
			_, err := c.ListSessions(ctx)
			return err
		},
		"Call": func(ctx context.Context, c *bridge.Client) error {
			return c.Call(ctx, "echo", nil, nil)
		},
		"OpenStream": func(ctx context.Context, c *bridge.Client) error {
			s, err := c.OpenStream(ctx, "events.subscribe", nil)
			if err == nil {
				s.Close()
			}
			return err
		},
		"OpenDuplex": func(ctx context.Context, c *bridge.Client) error {
			d, err := c.OpenDuplex(ctx)
			if err == nil {
				d.Close()
			}
			return err
		},
	}
	for name, open := range openers {
		t.Run(name, func(t *testing.T) {
			m := startMachine(t, func(s *fakeherdr.Server) {
				withMachine(s)
				// Without --multi every Call opens its own channel.
				s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
					if method == "ping" {
						return fakeherdr.Pong(false), nil
					}
					return echoHandler(method, params)
				}
			})
			c := m.dial(t)
			eventually(t, "no open channels", func() bool { return m.srv.OpenChannels() == 0 })
			release := make(chan struct{})
			m.srv.StallChannelOpens(func() { <-release })
			released := false
			defer func() {
				if !released {
					close(release)
				}
			}()

			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
			defer cancel()
			start := time.Now()
			done := make(chan error, 1)
			go func() { done <- open(ctx, c) }()
			select {
			case err := <-done:
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("err %v, want the deadline", err)
				}
				if d := time.Since(start); d > 250*time.Millisecond {
					t.Fatalf("returned %v after a 50ms deadline", d)
				}
			case <-time.After(300 * time.Millisecond):
				t.Fatal("still blocked 250ms after the deadline")
			}

			close(release)
			released = true
			m.srv.StallChannelOpens(nil)
			// The server now confirms the channel; the client must close it.
			time.Sleep(100 * time.Millisecond)
			eventually(t, "the late channel closed", func() bool { return m.srv.OpenChannels() == 0 })
		})
	}
}
