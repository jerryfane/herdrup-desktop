package main

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// guestRelayAgent is the agent -guest-relay shares: docs, the sample omp
// agent, so the guest gets its Chat tab.
const guestRelayAgent = "t2"

// serveGuestRelay serves a guest relay and gate in front of s on addr and
// logs the one invitation it redeems. The shared agent waits on a select
// menu until a guest's committing key (Enter, Escape, 1-9, y, n) moves it on,
// so the guest's menu keys and answer buttons can be exercised; ownerOnly is
// a herdr older than guest answers, which refuses both.
func serveGuestRelay(s *fakeherdr.Server, addr string, ownerOnly bool) error {
	relay, err := fakeherdr.NewGuestRelay()
	if err != nil {
		return err
	}
	relay.TerminalID, relay.AgentName = guestRelayAgent, "docs"
	relay.OwnerName, relay.MachineLabel, relay.GuestName = "Fixture Owner", "fakeherdr", "visitor"
	relay.OwnerOnlyAnswers, relay.Streams = ownerOnly, s.Streams
	var mu sync.Mutex
	menuOpen, seq := true, 1.0
	relay.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
		switch method {
		case "agent.list":
			value, apiErr := s.Handle(method, params)
			if apiErr != nil {
				return nil, apiErr
			}
			b, _ := json.Marshal(value)
			var list map[string]any
			_ = json.Unmarshal(b, &list)
			agents, _ := list["agents"].([]any)
			mu.Lock()
			defer mu.Unlock()
			for _, value := range agents {
				if agent, _ := value.(map[string]any); agent["terminal_id"] == guestRelayAgent {
					agent["state_change_seq"] = seq
					if menuOpen {
						agent["agent_status"], agent["input_pending"], agent["input_prompt_kind"] = "blocked", true, "select"
					} else {
						agent["agent_status"], agent["input_pending"] = "working", false
						delete(agent, "input_prompt_kind")
					}
				}
			}
			return list, nil
		case "pane.send_keys":
			var p struct {
				Keys []string `json:"keys"`
			}
			_ = json.Unmarshal(params, &p)
			log.Printf("fakeherdr guest relay: pane.send_keys %v", p.Keys)
			mu.Lock()
			if len(p.Keys) > 0 && fakeherdr.CommitsMenu(p.Keys[len(p.Keys)-1]) {
				menuOpen, seq = false, seq+1
			}
			mu.Unlock()
			return map[string]any{"type": "ok"}, nil
		}
		return s.Handle(method, params)
	}
	base, err := relay.Listen(addr)
	if err != nil {
		return err
	}
	log.Printf("fakeherdr guest relay on %s; open this invitation in HerdrUp: %s", base, relay.InviteLink(base, time.Now().Add(24*time.Hour)))
	return nil
}
