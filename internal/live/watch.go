// Package live keeps a machine's agents current: one agent.list, then the
// rows events_v2 events patch, and a re-list when the panes change.
package live

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// Timing of the watcher. Tests shorten these.
type Timing struct {
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
	Backstop: 30 * time.Second,
	Poll:     5 * time.Second,
	Silence:  45 * time.Second,
}

// Update is what the watcher reports after each agent.list and each row
// an event patched.
type Update struct {
	// Agents is the latest agent.list with every live change since applied.
	Agents []herdrapi.AgentInfo
	Pong   herdrapi.ResponseResultPong
	Live   bool // true when events_v2 drives updates, false when polling
	Listed time.Time
	// Lifecycle alerts come from actual stream events, never a pane merely
	// disappearing from a filtered list or an unavailable federation peer.
	ExitedPaneID   string
	FinishedPaneID string
}

// Watch lists agents and keeps them current, calling update after every
// list and every patch. A status or turn event patches its listed row with
// no request; panes appearing or going away, missed events, a reopened
// stream and an agent pane the list lacks re-list, one list in flight and
// at most one queued (herdrup receiveLiveEvent and requestRosterReload).
// It returns when ctx ends or the connection fails.
func Watch(ctx context.Context, c *engine.Client, t Timing, update func(Update)) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	pong, err := c.Ping(ctx)
	if err != nil {
		return err
	}
	live := herdrapi.CapabilityEventsV2.Supported(pong.Capabilities)

	type listed struct {
		res   herdrapi.ResponseResultAgentList
		err   error
		mark  uint64
		start time.Time
	}
	var (
		agents   []herdrapi.AgentInfo
		changes  ledger
		unlisted = unlistedReloads{}
		loading  bool
		queued   bool
		results  = make(chan listed, 1)
	)
	load := func() {
		loading = true
		mark, start := changes.mark(), time.Now()
		go func() {
			res, err := c.AgentList(ctx, herdrapi.AgentListParams{})
			results <- listed{res, err, mark, start}
		}()
	}
	reload := func() {
		if loading {
			queued = true
			return
		}
		load()
	}
	publish := func(r listed) error {
		loading = false
		if r.err != nil {
			return r.err
		}
		changes.settle(r.mark)
		replayed, complete := changes.replay(r.res.Agents, r.mark)
		if !complete {
			// More changes came while the list was out than the ledger
			// keeps: the rows patched live stand, and a list begun now
			// replaces this one (#38).
			queued = false
			load()
			return nil
		}
		agents = replayed
		unlisted.published(r.start)
		update(Update{Agents: agents, Pong: pong, Live: live, Listed: time.Now()})
		if queued {
			queued = false
			load()
		}
		return nil
	}
	load()
	if err := publish(<-results); err != nil {
		return err
	}

	stream := make(chan streamMsg)
	streamErr := make(chan error, 1)
	if live {
		go func() { streamErr <- follow(ctx, c, t, stream) }()
	}
	interval := t.Poll
	if live {
		interval = t.Backstop
	}
	tick := time.NewTicker(interval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.Done():
			return engine.ErrDisconnected
		case err := <-streamErr:
			return err
		case r := <-results:
			if err := publish(r); err != nil {
				return err
			}
		case <-tick.C:
			reload()
		case m := <-stream:
			if m.exitedPaneID != "" {
				update(Update{Agents: agents, Pong: pong, Live: live, Listed: m.at, ExitedPaneID: m.exitedPaneID})
			}
			if m.change == nil {
				if m.reload {
					reload()
				}
				continue
			}
			changes.record(*m.change, m.at)
			switch effect, patched := m.change.EffectOf(agents, m.at); effect {
			case Patch:
				finished := ""
				if m.change.Turn {
					for _, a := range agents {
						if a.PaneID != m.change.PaneID || a.Archived != nil {
							continue
						}
						last := a.LastCompletedTurn
						if last == nil || *m.change.TurnEpoch > last.TurnEpoch || (*m.change.TurnEpoch == last.TurnEpoch && *m.change.TurnN > last.Turn) {
							finished = a.PaneID
						}
						break
					}
				}
				agents = patched
				update(Update{Agents: agents, Pong: pong, Live: live, Listed: m.at, FinishedPaneID: finished})
			case ReloadUnlisted:
				if unlisted.request(m.change.PaneID, m.at) {
					reload()
				}
			}
		}
	}
}

// streamMsg is one thing the stream says: a change, or that the agents
// must be re-listed.
type streamMsg struct {
	change       *Change
	reload       bool
	at           time.Time
	exitedPaneID string
}

// follow keeps an events.subscribe open (engine.Subscribe) and passes on
// every status change and finished turn, and a re-list for a lifecycle
// event, a lag notice and a reopened stream, since events may have been
// missed while it was down. The watcher lists itself, so Subscribe's own
// re-lists are off.
func follow(ctx context.Context, c *engine.Client, t Timing, out chan<- streamMsg) error {
	send := func(m streamMsg) {
		m.at = time.Now()
		select {
		case out <- m:
		case <-ctx.Done():
		}
	}
	first := true
	return c.Subscribe(ctx, engine.SubscribeOptions{Silence: t.Silence, Backoff: t.Reconnect, NoList: true}, func(e engine.Event) {
		switch e.Kind {
		case engine.EventStarted:
			if !first {
				send(streamMsg{reload: true})
			}
			first = false
		case engine.EventLine:
			if e.Line == nil {
				return
			}
			change, reload := Decode(*e.Line)
			exited := ""
			if strings.ReplaceAll(e.Line.Event, ".", "_") == "pane_exited" {
				var p herdrapi.EventDataPaneExited
				if json.Unmarshal(e.Line.Data, &p) == nil {
					exited = p.PaneID
				}
			}
			if change != nil || reload {
				send(streamMsg{change: change, reload: reload, exitedPaneID: exited})
			}
		case engine.EventLagged:
			send(streamMsg{reload: true})
		}
	})
}
