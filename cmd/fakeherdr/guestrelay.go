package main

import (
	"encoding/json"
	"log"
	"os"
	"strings"
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
// a herdr older than guest answers, which refuses both. multiRequest serves
// a guest's requests in turn on one session (herdr #356); every session's
// end is logged. connectLimit is the relay's guest connects a minute (0:
// none); every connect is logged, so a guest's connect rate can be counted.
// While pauseFile exists the share is paused (GuestRelay.Pause); every
// change is logged.
func serveGuestRelay(s *fakeherdr.Server, addr string, ownerOnly, gram, multiRequest bool, connectLimit int, pauseFile string, webOrigin string) error {
	relay, err := fakeherdr.NewGuestRelay()
	if err != nil {
		return err
	}
	if webOrigin != "" {
		relay.WebOrigins = []string{webOrigin}
	}
	relay.TerminalID, relay.AgentName = guestRelayAgent, "docs"
	relay.OwnerName, relay.MachineLabel, relay.GuestName = "Fixture Owner", "fakeherdr", "visitor"
	relay.OwnerOnlyAnswers, relay.Streams, relay.Gram, relay.MultiRequest = ownerOnly, s.Streams, gram, multiRequest
	relay.LimitConnects(connectLimit)
	relay.OnRequest = func(method string) { log.Printf("fakeherdr guest relay: request %s", method) }
	connects := 0
	relay.OnConnect = func(c fakeherdr.GuestConnect) {
		connects++
		outcome := "admitted"
		if c.Refused {
			outcome = "refused 429 rate_limited"
		}
		log.Printf("fakeherdr guest relay: connect %d %s", connects, outcome)
	}
	relay.OnSessionEnd = func(index int, c fakeherdr.GuestConnect) {
		log.Printf("fakeherdr guest relay: session %d ended (%s) after %d requests", index+1, c.End, c.Requests)
	}
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
		case "agent.transcript":
			// Working once a key moved the menu on, as agent.list says: the
			// guest's chat polls at its working pace.
			value, apiErr := s.Handle(method, params)
			mu.Lock()
			defer mu.Unlock()
			if page, ok := value.(map[string]any); ok && !menuOpen {
				page["working"] = map[string]any{"intent": "Running the chosen verification"}
			}
			return value, apiErr
		}
		return s.Handle(method, params)
	}
	base, err := relay.Listen(addr)
	if err != nil {
		return err
	}
	log.Printf("fakeherdr guest relay on %s; open this invitation in HerdrUp: %s", base, relay.InviteLink(base, time.Now().Add(24*time.Hour)))
	if pauseFile != "" {
		go func() {
			paused := false
			for range time.Tick(500 * time.Millisecond) {
				_, err := os.Stat(pauseFile)
				if now := err == nil; now != paused {
					paused = now
					relay.Pause(paused)
					log.Printf("fakeherdr guest relay: paused %v", paused)
				}
			}
		}()
	}
	return nil
}

// guestSharePane is the docs agent's pane in agents.json: every -guest-shares
// grant's agent stands on it, so a guest's transcript and pane streams
// through any grant are docs'.
const guestSharePane = "w1:p2"

// serveGuestShares serves the grants spec names (fakeherdr.ParseGuestShares)
// on one relay listener in front of s and logs each one's invitation. While
// injectFile exists, each of its `agent|text` lines becomes a new unread
// message from agent in its grant's Gram, and the file is removed; checked
// every 300 ms.
func serveGuestShares(s *fakeherdr.Server, addr, spec, injectFile, webOrigin string) error {
	grants, err := fakeherdr.ParseGuestShares(spec)
	if err != nil {
		return err
	}
	shares, err := fakeherdr.NewGuestShares(grants, func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
		return s.Handle(method, params)
	}, guestSharePane, time.Now())
	if err != nil {
		return err
	}
	for _, grant := range shares.Grants {
		agent, relay := grant.Agent, grant.Relay
		if webOrigin != "" {
			relay.WebOrigins = []string{webOrigin}
		}
		relay.Streams = s.Streams
		relay.OnRequest = func(method string) { log.Printf("fakeherdr guest relay: %s request %s", agent, method) }
		relay.OnSessionEnd = func(index int, c fakeherdr.GuestConnect) {
			log.Printf("fakeherdr guest relay: %s session %d ended (%s) after %d requests", agent, index+1, c.End, c.Requests)
		}
	}
	base, err := shares.Listen(addr)
	if err != nil {
		return err
	}
	log.Printf("fakeherdr guest relay on %s; %d guest shares", base, len(shares.Grants))
	expires := time.Now().Add(24 * time.Hour)
	for _, grant := range shares.Grants {
		link := grant.Relay.InviteLink(base, expires)
		log.Printf("fakeherdr guest relay: invite %s %s", grant.Agent, link)
		if webOrigin != "" {
			// The web guest's own form: its page with the payload as fragment.
			_, payload, _ := strings.Cut(link, "#")
			log.Printf("fakeherdr guest relay: web invite %s http://%s/web/#%s", grant.Agent, webOrigin, payload)
		}
	}
	if injectFile != "" {
		go func() {
			for range time.Tick(300 * time.Millisecond) {
				injected, err := shares.InjectFile(injectFile)
				for _, line := range injected {
					log.Printf("fakeherdr guest relay: injected %s", line)
				}
				if err != nil {
					log.Printf("fakeherdr guest relay: inject: %v", err)
				}
			}
		}()
	}
	return nil
}
