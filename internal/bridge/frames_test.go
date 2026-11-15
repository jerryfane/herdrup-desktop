package bridge_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// framesHandler answers ping with api_bridge_frames, "big" with a reply of
// ~400 KB, "hang" never (until release), anything else at once.
func framesHandler(release <-chan struct{}) func(string, json.RawMessage) (any, *fakeherdr.APIError) {
	return func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
		switch method {
		case "ping":
			return fakeherdr.PongFrames(), nil
		case "big":
			return map[string]any{"blob": strings.Repeat("héllo ", 70_000)}, nil
		case "hang":
			<-release
		case "bridge.hello", "bridge.cancel":
			// An older bridge forwards these to its server, which does not know them.
			return nil, &fakeherdr.APIError{Code: "invalid_request", Message: "unknown method " + method}
		}
		return echoHandler(method, params)
	}
}

func count(methods []string, method string) (n int) {
	for _, m := range methods {
		if m == method {
			n++
		}
	}
	return n
}

// Slow-network fix 2 (herdr #407): with framed replies, a small request is not stuck behind
// a big reply that is still draining, and the big reply arrives whole. Against a bridge
// without frames (the hello forwarded and refused), the channel keeps working on lines.
func TestFramedRepliesLetASmallReplyPassABigOne(t *testing.T) {
	for _, framed := range []bool{true, false} {
		release := make(chan struct{})
		m := startMachine(t, func(s *fakeherdr.Server) {
			s.Handle = framesHandler(release)
			s.Frames, s.FrameBytes, s.FrameDelay = framed, 4096, 5*time.Millisecond
		})
		c := m.dial(t)
		ctx := context.Background()
		if err := c.Call(ctx, "ping", nil, nil); err != nil {
			t.Fatal(err)
		}
		eventually(t, "the --multi channel", func() bool { on, _ := routes(m); return slices.Contains(on, "ping") })

		var big struct{ Blob string }
		bigDone := make(chan time.Time, 1)
		go func() {
			if err := c.Call(ctx, "big", nil, &big); err != nil {
				t.Error(err)
			}
			bigDone <- time.Now()
		}()
		eventually(t, "the big request sent", func() bool { on, _ := routes(m); return slices.Contains(on, "big") })
		time.Sleep(20 * time.Millisecond) // the big reply is draining frame by frame
		if err := c.Call(ctx, "small", nil, nil); err != nil {
			t.Fatal(err)
		}
		smallAt := time.Now()
		bigAt := <-bigDone
		if big.Blob != strings.Repeat("héllo ", 70_000) {
			t.Fatalf("framed %v: the big reply came back changed (%d bytes)", framed, len(big.Blob))
		}
		onMulti, _ := routes(m)
		if count(onMulti, "bridge.hello") != 1 {
			t.Fatalf("framed %v: bridge.hello sent %d times, want once", framed, count(onMulti, "bridge.hello"))
		}
		if framed && !smallAt.Before(bigAt) {
			t.Fatalf("the small reply waited for the big one (small %v after big)", smallAt.Sub(bigAt))
		}
		close(release)
	}
}

// With bridge.cancel, requests whose callers gave up are stopped in herdr and give their
// slots back at once: sixteen of them no longer retire the channel and open a second one.
func TestCancelledRequestsFreeTheirSlotsOnTheSameChannel(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	m := startMachine(t, func(s *fakeherdr.Server) {
		s.Handle = framesHandler(release)
		s.Frames = true
	})
	c := m.dial(t)
	if err := c.Call(context.Background(), "ping", nil, nil); err != nil {
		t.Fatal(err)
	}
	eventually(t, "the --multi channel", func() bool { on, _ := routes(m); return slices.Contains(on, "ping") })
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			if err := c.Call(ctx, "hang", nil, nil); !errors.Is(err, context.DeadlineExceeded) {
				t.Errorf("hang: got %v, want its deadline", err)
			}
		}()
	}
	wg.Wait()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.Call(ctx, "agent.list", nil, nil); err != nil {
		t.Fatalf("a request after 16 cancelled ones: %v", err)
	}
	if n := multiOpens(m); n != 1 {
		t.Errorf("opened --multi %d times, want the same channel throughout", n)
	}
	// The cancels go out as each caller gives up; herdr stops every hung request.
	eventually(t, "16 cancels and nothing left running in herdr", func() bool {
		onMulti, _ := routes(m)
		now, _ := m.srv.MultiInFlight()
		return count(onMulti, "bridge.cancel") == 16 && now == 0
	})
}
