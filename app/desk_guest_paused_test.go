package main

import (
	"encoding/json"
	"sync/atomic"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/guest"
)

// The guest's status poll says the shared agent is paused when the host
// lists it with guest_running false or not at all, and running again when it
// is back (App/GuestPaneView.swift:737-753); a host older than guest_running
// leaves it out, which is running (Wire.swift:360-361).
func TestGuestStatusPollFollowsPausedShare(t *testing.T) {
	for _, older := range []bool{true, false} {
		owner := &guestOwnerHost{status: "working", seq: 1}
		var gone atomic.Bool
		relay, err := fakeherdr.NewGuestRelay()
		if err != nil {
			t.Fatal(err)
		}
		relay.NoGuestRunning = older
		relay.Handle = func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "agent.list" && gone.Load() {
				return map[string]any{"type": "agent_list", "agents": []any{}}, nil
			}
			return owner.handle(method, raw)
		}
		d, _ := openGuestAgent(t, relay, guest.SystemClock)
		expect := func(what, want string) {
			t.Helper()
			d.mu.Lock()
			l := d.link
			d.mu.Unlock()
			l.pollGuestStatus()
			waitFor(t, what, func() bool {
				s := d.State()
				return s.Phase == "connected" && s.Guest != nil && s.Guest.Availability == want
			})
		}
		if older {
			expect("an older host's agent to count as running", "")
			continue
		}
		expect("the running agent", "")
		relay.Pause(true)
		expect("guest_running false to pause", "paused")
		relay.Pause(false)
		expect("guest_running true to resume", "")
		gone.Store(true)
		expect("a missing agent to pause", "paused")
		gone.Store(false)
		expect("the agent listed again to resume", "")
	}
}
