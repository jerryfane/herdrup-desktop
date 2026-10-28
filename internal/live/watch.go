// Package live keeps a machine's status board current: one agent.list, then
// a re-list whenever an events_v2 event says the board changed.
package live

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/herdr"
)

// Caller is the part of bridge.Client the watcher needs.
type Caller interface {
	Call(ctx context.Context, method string, params, result any) error
	OpenStream(ctx context.Context, method string, params any) (Stream, error)
	Done() <-chan struct{}
}

// Stream is one open events.subscribe.
type Stream interface {
	Next() ([]byte, error)
	Close() error
}

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
	Board  herdr.Board
	Pong   herdr.Pong
	Live   bool // true when events_v2 drives updates, false when polling
	Listed time.Time
}

// ErrDisconnected is returned when the SSH connection ends.
var ErrDisconnected = errors.New("connection to the machine was lost")

// Watch lists agents and keeps listing as the board changes, calling update
// after every list. It returns when ctx ends or the connection fails.
func Watch(ctx context.Context, c Caller, t Timing, update func(Update)) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var pong herdr.Pong
	if err := c.Call(ctx, "ping", nil, &pong); err != nil {
		return err
	}
	live := pong.Capabilities.EventsV2
	list := func() error {
		var res herdr.AgentList
		if err := c.Call(ctx, "agent.list", nil, &res); err != nil {
			return err
		}
		update(Update{Board: herdr.BuildBoard(res.Agents), Pong: pong, Live: live, Listed: time.Now()})
		return nil
	}
	if err := list(); err != nil {
		return err
	}

	changed := make(chan struct{}, 1)
	streamErr := make(chan error, 1)
	if live {
		go func() { streamErr <- follow(ctx, c, t.Silence, changed) }()
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
			return ErrDisconnected
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

// maxFailedOpens is how many subscribe attempts in a row may fail before
// any line arrives before the watch gives up and reports the error.
const maxFailedOpens = 3

// follow keeps an events.subscribe open and signals changed on every event
// or lag notice. A stream that ended after it was established is reopened,
// followed by a re-list since events may have been missed. Attempts that
// fail before any line arrives do not re-list, and after maxFailedOpens in
// a row the error ends the watch.
func follow(ctx context.Context, c Caller, silence time.Duration, changed chan<- struct{}) error {
	signal := func() {
		select {
		case changed <- struct{}{}:
		default:
		}
	}
	failed := 0
	for {
		established, err := followOnce(ctx, c, silence, signal)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var fatal *fatalStreamError
		if errors.As(err, &fatal) {
			return fatal.err
		}
		if established {
			failed = 0
			signal()
		} else if failed++; failed >= maxFailedOpens {
			return fmt.Errorf("events.subscribe failed %d times in a row: %w", failed, err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.Done():
			return ErrDisconnected
		case <-time.After(time.Second):
		}
	}
}

type fatalStreamError struct{ err error }

func (e *fatalStreamError) Error() string { return e.err.Error() }

// followOnce runs one subscription until it ends. established reports
// whether any line arrived on it.
func followOnce(ctx context.Context, c Caller, silence time.Duration, signal func()) (established bool, err error) {
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s, err := c.OpenStream(sctx, "events.subscribe", herdr.SubscribeParams{
		Subscriptions: herdr.BoardSubscriptions, EventsV2: true,
	})
	if err != nil {
		return false, err
	}
	defer s.Close()
	// Close the stream when it goes silent; Next then returns an error.
	timer := time.AfterFunc(silence, cancel)
	defer timer.Stop()
	for {
		line, err := s.Next()
		if err != nil {
			return established, err
		}
		established = true
		timer.Reset(silence)
		var l herdr.StreamLine
		if err := json.Unmarshal(line, &l); err != nil {
			continue
		}
		switch {
		case l.Error != nil:
			// herdr refused the subscription itself; reopening would
			// fail the same way.
			return true, &fatalStreamError{fmt.Errorf("events.subscribe: %s: %s", l.Error.Code, l.Error.Message)}
		case l.Event != "", l.Control == "lagged":
			signal()
		}
	}
}
