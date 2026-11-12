package main

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/guest"
)

// manualClock is a guest.Clock the test moves. Its one sleeper is the
// guest's status poll (runGuest): After replaces the sleep a wake cut
// short, and fires once Advance passes its deadline.
type manualClock struct {
	mu    sync.Mutex
	now   time.Time
	sleep *clockWaiter
}

type clockWaiter struct {
	at time.Time
	ch chan time.Time
}

func newManualClock() *manualClock {
	return &manualClock{now: time.Date(2026, 11, 2, 20, 40, 0, 0, time.UTC)}
}

func (c *manualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *manualClock) After(d time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sleep = &clockWaiter{at: c.now.Add(d), ch: make(chan time.Time, 1)}
	return c.sleep.ch
}

// sleeping says the status poll waits on the clock.
func (c *manualClock) sleeping() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sleep != nil
}

func (c *manualClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	if c.sleep != nil && !c.sleep.at.After(c.now) {
		c.sleep.ch <- c.now
		c.sleep = nil
	}
}

// guestPage drives a guest's open agent page over simulated time: Go's
// status poll (runGuest) on the clock, and the page's chat poll at the
// delay src/chatPoll.ts chatPollDelay gives a guest (pinned by
// test/chatPoll.test.ts): 3 s while omp works, 30 s while it is idle.
type guestPage struct {
	t      *testing.T
	d      *Desk
	view   AgentView
	clock  *manualClock
	relay  *fakeherdr.GuestRelay
	nextAt time.Time
}

const (
	pageChatPollWorking = 3 * time.Second
	pageChatPollIdle    = 30 * time.Second
)

// openGuestPage opens the agent page and reads its chat once, as the page
// does on open (after which the host's engine has pinged once), so run
// measures the page's steady polling.
func openGuestPage(t *testing.T, owner *guestOwnerHost) *guestPage {
	t.Helper()
	relay, err := fakeherdr.NewGuestRelay()
	if err != nil {
		t.Fatal(err)
	}
	relay.Handle = owner.handle
	clock := newManualClock()
	relay.Now = clock.Now
	d, view := openGuestAgent(t, relay, clock)
	p := &guestPage{t: t, d: d, view: view, clock: clock, relay: relay}
	p.settle()
	p.readChat()
	return p
}

// settle waits for the status poll to sleep on the clock again.
func (p *guestPage) settle() {
	p.t.Helper()
	waitFor(p.t, "the guest status poll to wait", p.clock.sleeping)
}

// readChat reads the transcript and schedules the next read.
func (p *guestPage) readChat() {
	wait := pageChatPollIdle
	raw, err := p.d.ChatTranscript(context.Background(), p.view.Token, "", "", "")
	if err == nil && strings.Contains(raw, `"working"`) {
		wait = pageChatPollWorking
	}
	p.nextAt = p.clock.Now().Add(wait)
}

// run moves the clock through d a second at a time, reading the chat when
// the page would, and returns the relay connects made meanwhile.
func (p *guestPage) run(d time.Duration) []fakeherdr.GuestConnect {
	p.t.Helper()
	before := len(p.relay.Connects())
	end := p.clock.Now().Add(d)
	for p.clock.Now().Before(end) {
		p.clock.Advance(time.Second)
		p.settle()
		if !p.clock.Now().Before(p.nextAt) {
			p.readChat()
		}
	}
	return p.relay.Connects()[before:]
}

// The relay refuses a network past 30 guest connects a minute (wrangler
// GUEST_CONNECT_LIMIT), and every guest request is one connect. A guest
// whose agent is idle lists it every 15 s and reads its chat every 30 s
// (herdrup ChatView.swift:207-213); one whose agent works reads the chat
// every 3 s. Before, it listed every 3 s and read the chat every 1.5 s:
// about 60 a minute (herdr-app message 386025).
func TestGuestOpenAgentStaysUnderTheRelayConnectLimit(t *testing.T) {
	owner := &guestOwnerHost{status: "idle", seq: 1}
	page := openGuestPage(t, owner)
	idle := page.run(time.Minute)
	if len(idle) >= 30 {
		t.Fatalf("idle agent: %d relay connects in a minute, the relay allows 30", len(idle))
	}
	// 4 lists (every 15 s) and 2 chat reads (every 30 s).
	if len(idle) > 6 {
		t.Errorf("idle agent: %d relay connects in a minute, want at most 6", len(idle))
	}
	owner.mu.Lock()
	owner.status = "working"
	owner.mu.Unlock()
	page.readChat()
	working := page.run(time.Minute)
	// 4 lists and 20 chat reads.
	if len(working) >= 30 {
		t.Fatalf("working agent: %d relay connects in a minute, the relay allows 30", len(working))
	}
	t.Logf("relay connects in a minute: idle %d, working %d", len(idle), len(working))
}

// A send, an answer or a menu key lists the agent again at once rather
// than at the next 15 s poll, so its new state shows. The clock stands
// still here: only the wake can list it.
func TestGuestMenuKeyListsTheAgentAtOnce(t *testing.T) {
	owner := &guestOwnerHost{status: "blocked", seq: 4}
	page := openGuestPage(t, owner)
	if _, err := page.d.GuestMenuKey(context.Background(), page.view.Token, "Enter"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the board to show the agent working after the key", func() bool {
		page.d.mu.Lock()
		defer page.d.mu.Unlock()
		agents := page.d.link.agents
		return len(agents) == 1 && agents[0].AgentStatus == "working"
	})
}

// The relay's 429: the guest stops connecting for 15 s, then 30 s, then
// 60 s (relayBackoff's cap, internal/guest) while it keeps refusing, and
// says it is reconnecting rather than "Can't reach". The page stays open, and
// the first connect that goes through starts the backoff over.
func TestGuestBacksOffWhileTheRelayRateLimits(t *testing.T) {
	owner := &guestOwnerHost{status: "idle", seq: 1}
	page := openGuestPage(t, owner)
	page.nextAt = page.clock.Now().Add(time.Hour) // the status poll alone
	// Refused once a connect came in the minute before: every connect until
	// the relay's minute has passed since the last.
	page.relay.LimitConnects(1)
	start := page.clock.Now()
	connects := page.run(16 * time.Second)
	if len(connects) != 1 || !connects[0].Refused || connects[0].At.Sub(start) != 15*time.Second {
		t.Fatalf("connects at the first refusal: %+v", connects)
	}
	state := page.d.State()
	if state.Phase != "connected" || state.Guest == nil || state.Guest.Availability != "reconnecting" ||
		!strings.Contains(state.Message, "Trying again in 15 s") {
		t.Fatalf("state while rate limited: %+v", state)
	}
	// The page's requests during the backoff fail without connecting.
	before := len(page.relay.Connects())
	if _, err := page.d.ChatTranscript(context.Background(), page.view.Token, "", "", ""); !errors.Is(err, guest.ErrRateLimited) {
		t.Fatalf("chat during the backoff: %v", err)
	}
	if n := len(page.relay.Connects()) - before; n != 0 {
		t.Fatalf("%d connects during the backoff", n)
	}
	// Refused at 15 s; tries at 30 s (refused, 30 s), 60 s (refused, 60 s)
	// and 120 s, a minute after the last connect, when the relay lets it in.
	connects = append(connects, page.run(105*time.Second)...)
	var at []time.Duration
	for _, c := range connects {
		at = append(at, c.At.Sub(start))
	}
	want := []time.Duration{15 * time.Second, 30 * time.Second, 60 * time.Second, 120 * time.Second}
	if !slices.Equal(at, want) || !connects[2].Refused || connects[3].Refused {
		t.Fatalf("connects at %v (%+v), want at %v with the last let in", at, connects, want)
	}
	if state := page.d.State(); state.Phase != "connected" || state.Guest.Availability != "" || state.Message != "" {
		t.Fatalf("state after the relay let the guest back in: %+v", state)
	}
	// Recovered: the next refusal (the list at 135 s, a connect came at
	// 120 s) backs off 15 s again, not 120 s.
	connects = page.run(31 * time.Second)
	at = at[:0]
	for _, c := range connects {
		at = append(at, c.At.Sub(start))
	}
	if want := []time.Duration{135 * time.Second, 150 * time.Second}; !slices.Equal(at, want) {
		t.Fatalf("connects after recovering at %v, want %v", at, want)
	}
}
