package main

import (
	"context"
	"maps"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// SessionPill is one of the session pills over the agent list (herdrup
// App/SessionPills.swift): a running herdr session and how many of its
// agents need you.
type SessionPill struct {
	Name    string `json:"name"`
	Default bool   `json:"default"`
	// Selected marks the session the board shows.
	Selected bool `json:"selected"`
	// NeedsYou counts the session's agents that need you. The window uses
	// the board's own count for the selected session, which is live.
	NeedsYou int `json:"needsYou"`
}

var (
	// SessionsChanged is sent with the session pills: none while fewer than
	// two sessions run, as herdrup hides them then.
	SessionsChanged = mygo.NewEvent[[]SessionPill]("sessions:changed")
	// AccountsChanged is sent with the credential accounts' labels by id,
	// which name the account on an agent row.
	AccountsChanged = mygo.NewEvent[map[string]string]("accounts:changed")
)

// Session timing, as herdrup's: sessions are re-read every 15 s
// (watchSessions, App/HerdrApp.swift), and a session's roster is kept for
// 60 s so switching to it does not blank the list (SessionSwitchCache).
var (
	sessionPoll     = 15 * time.Second
	sessionCacheTTL = 60 * time.Second
)

type cachedBoard struct {
	board herdr.Board
	at    time.Time
}

// sessionWatch is the session pills' state for the connected machine.
type sessionWatch struct {
	mu       sync.Mutex
	pills    []SessionPill
	accounts map[string]string
	boards   map[string]cachedBoard // by sessionKey
	wake     chan struct{}
}

// sessionKey names the default session "" however it is spelled.
func sessionKey(name string) string {
	if name == "default" {
		return ""
	}
	return name
}

// SessionPills returns the current session pills.
func (d *Desk) SessionPills() []SessionPill {
	d.sessions.mu.Lock()
	defer d.sessions.mu.Unlock()
	return slices.Clone(d.sessions.pills)
}

// Accounts returns the credential accounts' labels by id.
func (d *Desk) Accounts() map[string]string {
	d.sessions.mu.Lock()
	defer d.sessions.mu.Unlock()
	return maps.Clone(d.sessions.accounts)
}

// sessionSwitched is called under d.mu when the board moves from session
// from to session to. It keeps from's board for a quick way back, wakes the
// watcher so the pills follow at once, and returns to's board if one was
// seen in the last 60 s.
func (d *Desk) sessionSwitched(from, to string, shown *BoardUpdate, now time.Time) *herdr.Board {
	s := &d.sessions
	s.mu.Lock()
	defer s.mu.Unlock()
	if shown != nil {
		s.remember(from, shown.Board, now)
	}
	for i := range s.pills {
		p := &s.pills[i]
		p.Selected = isSelected(*p, to)
	}
	SessionsChanged.Broadcast(slices.Clone(s.pills))
	if s.wake != nil {
		select {
		case s.wake <- struct{}{}:
		default:
		}
	}
	if c, ok := s.boards[sessionKey(to)]; ok && now.Sub(c.at) <= sessionCacheTTL {
		return &c.board
	}
	return nil
}

func (s *sessionWatch) remember(session string, b herdr.Board, now time.Time) {
	if s.boards == nil {
		s.boards = map[string]cachedBoard{}
	}
	s.boards[sessionKey(session)] = cachedBoard{board: b, at: now}
}

// watchSessions keeps the session pills and account labels current while
// the connection lasts.
func (d *Desk) watchSessions(ctx context.Context, l *link, c *bridge.Client) {
	wake := make(chan struct{}, 1)
	d.sessions.mu.Lock()
	d.sessions.wake = wake
	d.sessions.mu.Unlock()
	defer func() {
		d.sessions.mu.Lock()
		if d.sessions.wake == wake {
			d.sessions.wake = nil
			d.sessions.pills, d.sessions.boards = nil, nil
			SessionsChanged.Broadcast([]SessionPill{})
		}
		d.sessions.mu.Unlock()
	}()
	for {
		d.pollSessions(ctx, l, c)
		select {
		case <-ctx.Done():
			return
		case <-wake:
		case <-time.After(sessionPoll):
		}
	}
}

func (d *Desk) pollSessions(ctx context.Context, l *link, c *bridge.Client) {
	d.mu.Lock()
	current := l.session
	at := boardSession{link: l, client: c, gen: l.sessionGen}
	d.mu.Unlock()
	view, err := c.ForSession(current)
	if err != nil {
		return
	}
	if res, err := engine.New(engine.Bridge(view)).AccountsList(ctx); err == nil {
		d.setAccounts(accountLabels(res.Accounts))
	}
	sessions, err := c.ListSessions(ctx)
	if err != nil {
		return
	}
	running := runningSessions(sessions)
	if sessionGone(running, current) {
		// herdrup falls back to the default session when the chosen one
		// stops (watchSessions); only if it is still the one shown, so a
		// switch made meanwhile stands (#35).
		_ = d.selectSession("", &at)
		return
	}
	counts := map[string]int{}
	if len(running) >= 2 {
		for _, s := range running {
			if isSelected(SessionPill{Name: s.Name, Default: s.Default}, current) {
				continue
			}
			agents, err := listSession(ctx, c, s)
			if err != nil {
				continue
			}
			counts[s.Name] = needsYouCount(agents)
			d.sessions.mu.Lock()
			// Seeds the list on a switch until that session's folders load
			// (herdrup remounts the folder store per session), so no folders.
			d.sessions.remember(sessionName(s), herdr.BuildBoard(agents, herdr.View{}), time.Now())
			d.sessions.mu.Unlock()
		}
	}
	d.mu.Lock()
	stillCurrent := d.currentLocked(at)
	d.mu.Unlock()
	if !stillCurrent || ctx.Err() != nil {
		return
	}
	d.setPills(pillsOf(running, current, counts))
}

func listSession(ctx context.Context, c *bridge.Client, s bridge.Session) ([]herdrapi.AgentInfo, error) {
	view, err := c.ForSession(sessionName(s))
	if err != nil {
		return nil, err
	}
	res, err := engine.New(engine.Bridge(view)).AgentList(ctx, herdrapi.AgentListParams{})
	if err != nil {
		return nil, err
	}
	return res.Agents, nil
}

// sessionName is what --session takes for s: "" for the default one.
func sessionName(s bridge.Session) string {
	if s.Default {
		return ""
	}
	return s.Name
}

func (d *Desk) setPills(p []SessionPill) {
	d.sessions.mu.Lock()
	defer d.sessions.mu.Unlock()
	if slices.Equal(p, d.sessions.pills) {
		return
	}
	d.sessions.pills = p
	SessionsChanged.Broadcast(slices.Clone(p))
}

func (d *Desk) setAccounts(a map[string]string) {
	d.sessions.mu.Lock()
	defer d.sessions.mu.Unlock()
	if maps.Equal(a, d.sessions.accounts) {
		return
	}
	d.sessions.accounts = a
	AccountsChanged.Broadcast(maps.Clone(a))
}

func accountLabels(accounts []herdrapi.AccountInfo) map[string]string {
	out := make(map[string]string, len(accounts))
	for _, a := range accounts {
		if _, seen := out[a.ID]; !seen { // herdrup takes the first match
			out[a.ID] = a.Label
		}
	}
	return out
}

// runningSessions keeps the running sessions in pill order: named ones by
// herdrup's localizedStandardCompare, then the default one.
func runningSessions(all []bridge.Session) []bridge.Session {
	var out []bridge.Session
	for _, s := range all {
		if s.Running {
			out = append(out, s)
		}
	}
	slices.SortStableFunc(out, func(a, b bridge.Session) int {
		switch {
		case a.Default != b.Default:
			if a.Default {
				return 1
			}
			return -1
		case standardLess(a.Name, b.Name):
			return -1
		case standardLess(b.Name, a.Name):
			return 1
		}
		return 0
	})
	return out
}

// sessionGone reports whether current is a named session that no longer
// runs.
func sessionGone(running []bridge.Session, current string) bool {
	if sessionKey(current) == "" {
		return false
	}
	return !slices.ContainsFunc(running, func(s bridge.Session) bool { return !s.Default && s.Name == current })
}

func isSelected(p SessionPill, current string) bool {
	if p.Default {
		return sessionKey(current) == ""
	}
	return p.Name == current
}

// pillsOf is the pills for the running sessions, none for fewer than two.
func pillsOf(running []bridge.Session, current string, counts map[string]int) []SessionPill {
	if len(running) < 2 {
		return []SessionPill{}
	}
	out := make([]SessionPill, 0, len(running))
	for _, s := range running {
		p := SessionPill{Name: s.Name, Default: s.Default, NeedsYou: counts[s.Name]}
		p.Selected = isSelected(p, current)
		out = append(out, p)
	}
	return out
}

// needsYouCount is herdrup's AgentList.needsYouCount: live agents in the
// needs-you group.
func needsYouCount(agents []herdrapi.AgentInfo) int {
	n := 0
	for _, a := range agents {
		if a.Archived == nil && herdr.GroupOf(a, true) == herdr.NeedsYou {
			n++
		}
	}
	return n
}

// standardLess orders like Foundation's localizedStandardCompare for the
// names herdr allows: case-insensitive, with runs of digits compared as
// numbers ("s2" before "s10").
func standardLess(a, b string) bool {
	ra, rb := []rune(a), []rune(b)
	i, j := 0, 0
	for i < len(ra) && j < len(rb) {
		if unicode.IsDigit(ra[i]) && unicode.IsDigit(rb[j]) {
			si := i
			for i < len(ra) && unicode.IsDigit(ra[i]) {
				i++
			}
			sj := j
			for j < len(rb) && unicode.IsDigit(rb[j]) {
				j++
			}
			na := strings.TrimLeft(string(ra[si:i]), "0")
			nb := strings.TrimLeft(string(rb[sj:j]), "0")
			if len(na) != len(nb) {
				return len(na) < len(nb)
			}
			if na != nb {
				return na < nb
			}
			continue
		}
		ca, cb := unicode.ToLower(ra[i]), unicode.ToLower(rb[j])
		if ca != cb {
			return ca < cb
		}
		i++
		j++
	}
	if len(ra)-i != len(rb)-j {
		return len(ra)-i < len(rb)-j
	}
	return a < b
}
