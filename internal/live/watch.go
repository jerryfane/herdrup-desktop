// Package live keeps a machine's status board current: one agent.list, then
// a re-list whenever an events_v2 event says the board changed.
package live

import (
	"context"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// Timing of the watcher. Tests shorten these.
type Timing struct {
	// Debounce coalesces a burst of events into one agent.list.
	Debounce time.Duration
	// Backstop re-lists even when no event arrived.
	Backstop time.Duration
	// Poll is the re-list interval on a herdr without events_v2.
	Poll time.Duration
	// Silence is how long a stream may go without a line (herdr sends a
	// heartbeat every 15 s) before it is reopened.
	Silence time.Duration
	// Reconnect spaces the reopening of a stream that ended.
	Reconnect engine.Backoff
}

// DefaultTiming matches the iOS app.
var DefaultTiming = Timing{
	Debounce: 150 * time.Millisecond,
	Backstop: 30 * time.Second,
	Poll:     5 * time.Second,
	Silence:  45 * time.Second,
}

// Update is what the watcher reports after each agent.list.
type Update struct {
	Board herdr.Board
	// Agents is the agent.list the board was built from.
	Agents []herdrapi.AgentInfo
	Pong   herdrapi.ResponseResultPong
	Live   bool // true when events_v2 drives updates, false when polling
	Listed time.Time
}

// Watch lists agents and keeps listing as the board changes, calling update
// after every list. It returns when ctx ends or the connection fails.
func Watch(ctx context.Context, c *engine.Client, t Timing, update func(Update)) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	pong, err := c.Ping(ctx)
	if err != nil {
		return err
	}
	live := herdrapi.CapabilityEventsV2.Supported(pong.Capabilities)
	list := func() error {
		res, err := c.AgentList(ctx, herdrapi.AgentListParams{})
		if err != nil {
			return err
		}
		update(Update{Board: herdr.BuildBoard(res.Agents), Agents: res.Agents, Pong: pong, Live: live, Listed: time.Now()})
		return nil
	}
	if err := list(); err != nil {
		return err
	}

	changed := make(chan struct{}, 1)
	streamErr := make(chan error, 1)
	if live {
		go func() { streamErr <- follow(ctx, c, t, changed) }()
	}
	interval := t.Poll
	if live {
		interval = t.Backstop
	}
	tick := time.NewTicker(interval)
	defer tick.Stop()
	var debounce <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.Done():
			return engine.ErrDisconnected
		case err := <-streamErr:
			return err
		case <-changed:
			if debounce == nil {
				debounce = time.After(t.Debounce)
			}
			continue
		case <-debounce:
		case <-tick.C:
		}
		debounce = nil
		if err := list(); err != nil {
			return err
		}
	}
}

// follow keeps an events.subscribe open (engine.Subscribe) and signals
// changed on every event or lag notice, and when a stream is reopened,
// since events may have been missed while it was down. The watcher lists
// itself, debounced, so Subscribe's own re-lists are off.
func follow(ctx context.Context, c *engine.Client, t Timing, changed chan<- struct{}) error {
	signal := func() {
		select {
		case changed <- struct{}{}:
		default:
		}
	}
	first := true
	return c.Subscribe(ctx, engine.SubscribeOptions{Silence: t.Silence, Backoff: t.Reconnect, NoList: true}, func(e engine.Event) {
		switch e.Kind {
		case engine.EventStarted:
			if !first {
				signal()
			}
			first = false
		case engine.EventLine, engine.EventLagged:
			signal()
		}
	})
}
