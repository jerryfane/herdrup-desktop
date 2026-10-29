package main

import (
	"strconv"
	"strings"
	"sync"

	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// startedNeedingYou compares an agent list with the panes that needed you
// in the watch's previous list. It returns the panes that need you now and
// the agents that started to: each once per move into needs you, again only
// after it has left (or gone from the list) and come back. A nil before is
// the baseline, the first list of a connection or session: its agents are
// not news, so it starts none.
func startedNeedingYou(before map[string]bool, agents []herdrapi.AgentInfo) (now map[string]bool, started []herdrapi.AgentInfo) {
	now = map[string]bool{}
	for _, a := range agents {
		if !needsYou(a) {
			continue
		}
		now[a.PaneID] = true
		if before != nil && !before[a.PaneID] {
			started = append(started, a)
		}
	}
	return now, started
}

// needingRows are the rows of b's needs-you section, the agents the tray
// lists.
func needingRows(b herdr.Board) []herdr.Row {
	for _, s := range b.Sections {
		if s.Key == herdr.NeedsYou.Key() {
			return s.Rows
		}
	}
	return nil
}

// needsYouText is the needs-you pill's count text (herdrup
// NeedsYouPill.countText, src/listExtras.ts), the tray's tooltip.
func needsYouText(n int) string {
	if n == 1 {
		return "1 agent needs you"
	}
	return strconv.Itoa(n) + " agents need you"
}

// attentionTitle is the title of herdr's push for an agent that needs you
// (herdr push_title_agent and push_event_text, which herdrup shows): the
// agent's name, or its tool ("claude") when unnamed, then "needs
// attention"; a federated agent's name is followed by "on <machine>".
func attentionTitle(a herdrapi.AgentInfo) string {
	name := strings.TrimSpace(deref(a.Name))
	machine := ""
	if id := deref(a.MachineID); id != "" {
		if rest, ok := strings.CutPrefix(name, id+"/"); ok {
			name, machine = rest, id
			if label := strings.TrimSpace(deref(a.MachineLabel)); label != "" {
				machine = label
			}
		}
	}
	if name == "" {
		name = deref(a.Agent)
	}
	if name == "" {
		name = herdr.DisplayName(a)
	}
	if machine != "" {
		name += " on " + machine
	}
	return name + " needs attention"
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// presence carries what needs you from the desk to the tray and the
// notifications (tray.go). The desk queues under d.mu, so its order is the
// boards' order; serve applies the queue on a goroutine of its own, as the
// tray waits for the main thread, which may itself be waiting for d.mu.
type presence struct {
	mu      sync.Mutex
	rows    []herdr.Row // the agents needing you, when changed
	changed bool
	started []herdrapi.AgentInfo
	wake    chan struct{}
}

func newPresence() *presence { return &presence{wake: make(chan struct{}, 1)} }

// show queues the agents that need you now. Only the latest is applied.
func (p *presence) show(rows []herdr.Row) {
	p.mu.Lock()
	p.rows, p.changed = rows, true
	p.mu.Unlock()
	p.poke()
}

// notify queues agents that started needing you.
func (p *presence) notify(agents []herdrapi.AgentInfo) {
	if len(agents) == 0 {
		return
	}
	p.mu.Lock()
	p.started = append(p.started, agents...)
	p.mu.Unlock()
	p.poke()
}

func (p *presence) poke() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// serve applies the queue for good: the latest rows to show, then each
// agent to notify of.
func (p *presence) serve(show func([]herdr.Row), notify func(herdrapi.AgentInfo)) {
	for range p.wake {
		p.mu.Lock()
		rows, changed, started := p.rows, p.changed, p.started
		p.rows, p.changed, p.started = nil, false, nil
		p.mu.Unlock()
		if changed {
			show(rows)
		}
		for _, a := range started {
			notify(a)
		}
	}
}
