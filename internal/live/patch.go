package live

import (
	"encoding/json"
	"slices"
	"strings"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// Patching listed rows from the event stream instead of re-listing, as
// herdrup does (HerdrKit AgentStatusStream.swift: AgentInfo.applying,
// effect(of:), UnlistedPaneReloads, AgentLiveUpdateLedger).

// Change is a status change or a finished turn for one pane.
type Change struct {
	// Turn is true for pane.turn_completed, false for
	// pane.agent_status_changed.
	Turn   bool
	PaneID string
	// Status is "" when a finished turn's snapshot carries none.
	Status       herdrapi.AgentStatus
	InputPending bool
	PromptKind   *herdrapi.InputPromptKind
	// Agent is the pane's agent; nil for a plain shell.
	Agent     *string
	TurnN     *uint64
	TurnEpoch *uint64
	// CompletedUnixMs is the finished turn's time, 0 when absent.
	CompletedUnixMs uint64
}

// Effect is what one stream line does to the listed agents.
type Effect int

const (
	// Ignore: a heartbeat, an unknown kind, or a pane with no agent.
	Ignore Effect = iota
	// Patch: the line changed a listed row.
	Patch
	// Reload: panes appeared or went away, or events were missed.
	Reload
	// ReloadUnlisted: an agent pane the list does not show yet; reload,
	// once per pane until a later list publishes.
	ReloadUnlisted
)

// Decode reads one stream event: a Change for a status or turn event, or
// whether the event means the panes changed (reload). Both spellings of a
// kind ("pane.created", "pane_created") are accepted.
func Decode(e herdrapi.SubscriptionStreamEvent) (c *Change, reload bool) {
	switch strings.ReplaceAll(e.Event, ".", "_") {
	case "pane_agent_status_changed":
		var p herdrapi.EventDataPaneAgentStatusChanged
		if json.Unmarshal(e.Data, &p) != nil {
			return nil, false
		}
		return &Change{
			PaneID: p.PaneID, Status: p.AgentStatus, InputPending: p.InputPending != nil && *p.InputPending,
			PromptKind: p.InputPromptKind, Agent: p.Agent, TurnN: p.Turn, TurnEpoch: p.TurnEpoch,
		}, false
	case "pane_turn_completed":
		var p herdrapi.EventDataPaneTurnCompleted
		if json.Unmarshal(e.Data, &p) != nil {
			return nil, false
		}
		turn, epoch := p.Turn, p.TurnEpoch
		return &Change{
			Turn: true, PaneID: p.Pane.PaneID, Status: p.Pane.AgentStatus,
			InputPending: p.Pane.InputPending != nil && *p.Pane.InputPending,
			PromptKind:   p.Pane.InputPromptKind, Agent: p.Pane.Agent,
			TurnN: &turn, TurnEpoch: &epoch, CompletedUnixMs: p.CompletedUnixMs,
		}, false
	case "pane_created", "pane_closed", "pane_exited", "pane_agent_detected":
		return nil, true
	}
	return nil, false
}

// Apply returns a with c applied. at stands in for the status-change time,
// which the event does not carry, and is used only when the status really
// changes, so an event the row already reflects leaves its age alone.
func (c Change) Apply(a herdrapi.AgentInfo, at time.Time) herdrapi.AgentInfo {
	setStatus := func() {
		if c.Status == a.AgentStatus {
			return
		}
		a.AgentStatus = c.Status
		ms := uint64(max(0, at.UnixMilli()))
		a.StatusSinceUnixMs = &ms
	}
	pending := c.InputPending
	if !c.Turn {
		setStatus()
		a.InputPending, a.InputPromptKind = &pending, c.PromptKind
		if c.TurnN != nil {
			a.Turn = c.TurnN
		}
		if c.TurnEpoch != nil {
			a.TurnEpoch = c.TurnEpoch
		}
		return a
	}
	if c.Status != "" {
		// A snapshot with a status is the pane's whole state, its input
		// prompt included: a turn that finished done ends a blocked prompt.
		setStatus()
		a.InputPending, a.InputPromptKind = &pending, c.PromptKind
	}
	a.Turn, a.TurnEpoch = c.TurnN, c.TurnEpoch
	done := c.CompletedUnixMs
	if done == 0 && a.LastCompletedTurn != nil {
		done = a.LastCompletedTurn.CompletedUnixMs
	}
	a.LastCompletedTurn = &herdrapi.LastCompletedTurn{Turn: *c.TurnN, TurnEpoch: *c.TurnEpoch, CompletedUnixMs: done}
	return a
}

// ApplyTo returns agents with c applied to its pane's row, or nil when no
// row has the pane.
func (c Change) ApplyTo(agents []herdrapi.AgentInfo, at time.Time) []herdrapi.AgentInfo {
	if c.PaneID == "" {
		return nil
	}
	i := slices.IndexFunc(agents, func(a herdrapi.AgentInfo) bool { return a.PaneID == c.PaneID })
	if i < 0 {
		return nil
	}
	next := slices.Clone(agents)
	next[i] = c.Apply(agents[i], at)
	return next
}

// EffectOf is what c does to agents: Patch (with the patched list), or
// ReloadUnlisted for an agent pane the list lacks, or Ignore for a pane
// with no agent (agent.list never lists a plain shell).
func (c Change) EffectOf(agents []herdrapi.AgentInfo, at time.Time) (Effect, []herdrapi.AgentInfo) {
	if patched := c.ApplyTo(agents, at); patched != nil {
		return Patch, patched
	}
	if c.PaneID == "" || c.Agent == nil {
		return Ignore, nil
	}
	return ReloadUnlisted, nil
}

// unlistedReloads allows one reload per unlisted pane until a list that
// started after the request publishes.
type unlistedReloads map[string]time.Time

func (u unlistedReloads) request(pane string, now time.Time) bool {
	if _, ok := u[pane]; ok {
		return false
	}
	u[pane] = now
	return true
}

// published forgets every request made before the list that started at
// start, which answered them.
func (u unlistedReloads) published(start time.Time) {
	for p, at := range u {
		if at.Before(start) {
			delete(u, p)
		}
	}
}

// ledgerCapacity bounds the ledger when lists keep failing.
const ledgerCapacity = 256

// ledger keeps the changes that arrived while an agent.list was in flight,
// so its possibly older snapshot cannot undo them. Take mark when a list
// starts; when it publishes, settle through the mark, then replay the rest
// onto the list.
type ledger struct {
	entries []ledgerEntry
	counter uint64
	// evicted is the index of the newest change dropped for capacity.
	evicted uint64
}

type ledgerEntry struct {
	index uint64
	c     Change
	at    time.Time
}

func (l *ledger) mark() uint64 { return l.counter }

func (l *ledger) record(c Change, at time.Time) {
	l.counter++
	l.entries = append(l.entries, ledgerEntry{l.counter, c, at})
	if n := len(l.entries) - ledgerCapacity; n > 0 {
		l.evicted = l.entries[n-1].index
		l.entries = slices.Delete(l.entries, 0, n)
	}
}

// replay applies every change recorded after mark, in arrival order;
// changes for panes absent from agents are skipped. complete is false
// when a change recorded after mark was dropped for capacity: the list
// cannot be brought up to date, and publishing it could undo that change
// (#38).
func (l *ledger) replay(agents []herdrapi.AgentInfo, mark uint64) (_ []herdrapi.AgentInfo, complete bool) {
	if l.evicted > mark {
		return agents, false
	}
	for _, e := range l.entries {
		if e.index <= mark {
			continue
		}
		if next := e.c.ApplyTo(agents, e.at); next != nil {
			agents = next
		}
	}
	return agents, true
}

// settle forgets the changes recorded at or before mark.
func (l *ledger) settle(mark uint64) {
	l.entries = slices.DeleteFunc(l.entries, func(e ledgerEntry) bool { return e.index <= mark })
}
