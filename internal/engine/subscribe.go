package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"sync/atomic"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// ErrSilent ends a subscription that sent no line, not even a heartbeat,
// for SubscribeOptions.Silence; Subscribe reconnects.
var ErrSilent = errors.New("events.subscribe went silent")

// BoardSubscriptions are the events that change the agent board: status
// changes, finished turns, and panes or agents appearing and going away,
// for every pane (herdrup HerdrClient.agentStatusSubscriptions).
func BoardSubscriptions() []herdrapi.Subscription {
	return []herdrapi.Subscription{
		{Value: herdrapi.SubscriptionPaneAgentStatusChanged{}},
		{Value: herdrapi.SubscriptionPaneTurnCompleted{}},
		{Value: herdrapi.SubscriptionPaneCreated{}},
		{Value: herdrapi.SubscriptionPaneClosed{}},
		{Value: herdrapi.SubscriptionPaneExited{}},
		{Value: herdrapi.SubscriptionPaneAgentDetected{}},
	}
}

// Backoff is an exponential reconnect delay: Initial, doubling, capped at
// Max, each scaled by a random factor in [JitterMin, JitterMax] (herdrup
// ReconnectBackoff). The zero value is 1 s to 30 s with 0.6 to 1.0 jitter.
type Backoff struct {
	Initial, Max         time.Duration
	JitterMin, JitterMax float64
	// Rand returns a number in [0, 1); math/rand when nil.
	Rand func() float64

	current time.Duration
}

func (b *Backoff) defaults() {
	if b.Initial == 0 {
		b.Initial = time.Second
	}
	if b.Max == 0 {
		b.Max = 30 * time.Second
	}
	if b.JitterMin == 0 && b.JitterMax == 0 {
		b.JitterMin, b.JitterMax = 0.6, 1.0
	}
	if b.Rand == nil {
		b.Rand = rand.Float64
	}
}

// Next returns the delay before the next attempt and doubles the one
// after it.
func (b *Backoff) Next() time.Duration {
	b.defaults()
	if b.current == 0 {
		b.current = b.Initial
	}
	step := min(b.current, b.Max)
	b.current = min(b.current*2, b.Max)
	f := b.JitterMin + (b.JitterMax-b.JitterMin)*b.Rand()
	return time.Duration(float64(step) * f)
}

// Reset starts the delays again from Initial.
func (b *Backoff) Reset() { b.current = 0 }

// EventKind says what an Event carries.
type EventKind string

const (
	// EventStarted: herdr acknowledged the subscription (Started).
	EventStarted EventKind = "started"
	// EventLine: one numbered event line (Line).
	EventLine EventKind = "event"
	// EventLagged: herdr dropped events for this subscriber (Lagged); a
	// re-list follows.
	EventLagged EventKind = "lagged"
	// EventHeartbeat: herdr's idle heartbeat (Heartbeat).
	EventHeartbeat EventKind = "heartbeat"
	// EventListed: a fresh agent.list (List), after every acknowledgement
	// and every lagged line, since events may have been missed.
	EventListed EventKind = "listed"
	// EventReconnecting: the stream ended (Err) and reopens after Delay.
	EventReconnecting EventKind = "reconnecting"
)

// Event is one thing that happened on a subscription.
type Event struct {
	Kind      EventKind                                   `json:"kind"`
	Started   *herdrapi.ResponseResultSubscriptionStarted `json:"started,omitempty"`
	Line      *herdrapi.SubscriptionStreamEvent           `json:"line,omitempty"`
	Lagged    *herdrapi.SubscriptionControlLineLagged     `json:"lagged,omitempty"`
	Heartbeat *herdrapi.SubscriptionControlLineHeartbeat  `json:"heartbeat,omitempty"`
	List      *herdrapi.ResponseResultAgentList           `json:"list,omitempty"`
	Err       error                                       `json:"-"`
	Delay     time.Duration                               `json:"delay,omitempty"`
}

// SubscribeOptions configure Subscribe. The zero value follows the board.
type SubscribeOptions struct {
	// Subscriptions default to BoardSubscriptions.
	Subscriptions []herdrapi.Subscription
	// Silence is how long the stream may go without a line before it is
	// reopened; herdr sends a heartbeat every 15 s. 45 s when zero.
	Silence time.Duration
	// Backoff spaces reconnects; it restarts once a reopened stream
	// delivers a line after its acknowledgement.
	Backoff Backoff
	// MaxFailedOpens is how many attempts in a row may end before any
	// acknowledgement before Subscribe gives up with the last error. 3
	// when zero.
	MaxFailedOpens int
	// NoList turns off the re-lists (EventListed).
	NoList bool
}

// Subscribe follows events.subscribe with events_v2 until ctx ends, the
// connection ends (ErrDisconnected), herdr refuses the subscription, or
// MaxFailedOpens attempts in a row fail; handle gets every event in order.
// A stream that ends, errs or goes silent is reopened with backoff, and
// every acknowledgement and lagged line is followed by an agent.list.
func (c *Client) Subscribe(ctx context.Context, opts SubscribeOptions, handle func(Event)) error {
	m := method("events.subscribe")
	if err := c.gate(ctx, m); err != nil {
		return err
	}
	if opts.Subscriptions == nil {
		opts.Subscriptions = BoardSubscriptions()
	}
	if opts.Silence == 0 {
		opts.Silence = 45 * time.Second
	}
	if opts.MaxFailedOpens == 0 {
		opts.MaxFailedOpens = 3
	}
	v2 := true
	params := herdrapi.EventsSubscribeParams{Subscriptions: opts.Subscriptions, EventsV2: &v2}
	failed := 0
	for {
		acked, err := c.subscribeOnce(ctx, params, &opts, handle)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var fatal *fatalError
		if errors.As(err, &fatal) {
			return fatal.err
		}
		if acked {
			failed = 0
		} else if failed++; failed >= opts.MaxFailedOpens {
			return fmt.Errorf("events.subscribe failed %d times in a row: %w", failed, err)
		}
		delay := opts.Backoff.Next()
		handle(Event{Kind: EventReconnecting, Err: err, Delay: delay})
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.t.Done():
			return ErrDisconnected
		case <-time.After(delay):
		}
	}
}

// fatalError ends Subscribe instead of reconnecting.
type fatalError struct{ err error }

func (e *fatalError) Error() string { return e.err.Error() }

// subscribeOnce runs one subscription until it ends. acked reports whether
// herdr acknowledged it.
func (c *Client) subscribeOnce(ctx context.Context, params herdrapi.EventsSubscribeParams, opts *SubscribeOptions, handle func(Event)) (acked bool, err error) {
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s, err := c.t.OpenStream(sctx, "events.subscribe", params)
	if err != nil {
		return false, err
	}
	defer s.Close()
	var silent atomic.Bool
	timer := time.AfterFunc(opts.Silence, func() { silent.Store(true); cancel() })
	defer timer.Stop()
	relist := func() error {
		if opts.NoList {
			return nil
		}
		list, err := c.AgentList(ctx, herdrapi.AgentListParams{})
		if err != nil {
			return fmt.Errorf("re-list: %w", err)
		}
		handle(Event{Kind: EventListed, List: &list})
		return nil
	}
	lines := 0
	for {
		line, err := s.Next()
		if err != nil {
			if silent.Load() {
				err = fmt.Errorf("%w (%s): %w", ErrSilent, opts.Silence, err)
			}
			return acked, err
		}
		timer.Reset(opts.Silence)
		if !acked {
			v, err := c.decodeAck(method("events.subscribe"), line)
			if err != nil {
				// herdr refused the subscription itself; reopening
				// would fail the same way.
				return false, &fatalError{err}
			}
			started := v.(herdrapi.ResponseResultSubscriptionStarted)
			acked = true
			handle(Event{Kind: EventStarted, Started: &started})
			if err := relist(); err != nil {
				return true, err
			}
			continue
		}
		if lines++; lines == 1 {
			opts.Backoff.Reset()
		}
		ev, err := decodeEventLine(line)
		if err != nil {
			return true, err
		}
		if ev.Kind == "" {
			continue // a line this pin does not know
		}
		handle(ev)
		if ev.Kind == EventLagged {
			if err := relist(); err != nil {
				return true, err
			}
		}
	}
}

// decodeEventLine decodes one line after the acknowledgement. An error
// envelope ends the stream with a *StreamError.
func decodeEventLine(line []byte) (Event, error) {
	var probe struct {
		Control *string         `json:"control"`
		Event   *string         `json:"event"`
		Error   json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(line, &probe); err != nil {
		return Event{}, fmt.Errorf("events.subscribe: decode line: %w", err)
	}
	switch {
	case probe.Error != nil:
		if se := decodeStreamError("events.subscribe", line); se != nil {
			return Event{}, se
		}
		return Event{}, fmt.Errorf("events.subscribe: bad error line")
	case probe.Control != nil:
		var cl herdrapi.SubscriptionControlLine
		if err := json.Unmarshal(line, &cl); err != nil {
			return Event{}, fmt.Errorf("events.subscribe: decode control line: %w", err)
		}
		switch v := cl.Value.(type) {
		case herdrapi.SubscriptionControlLineLagged:
			return Event{Kind: EventLagged, Lagged: &v}, nil
		case herdrapi.SubscriptionControlLineHeartbeat:
			return Event{Kind: EventHeartbeat, Heartbeat: &v}, nil
		}
		return Event{}, nil
	case probe.Event != nil:
		var e herdrapi.SubscriptionStreamEvent
		if err := json.Unmarshal(line, &e); err != nil {
			return Event{}, fmt.Errorf("events.subscribe: decode event: %w", err)
		}
		return Event{Kind: EventLine, Line: &e}, nil
	}
	return Event{}, nil
}
