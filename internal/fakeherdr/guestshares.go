package fakeherdr

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// GuestShare is one guest grant GuestShares serves: Agent, shared by Owner
// from Machine. Gram is features.gram, MultiRequest features.multi_request,
// and Pages seeds its Gram with GuestSharePagesSeed messages instead of
// GuestShareSeed, so gram.list pages.
type GuestShare struct {
	Agent, Owner, Machine     string
	Gram, MultiRequest, Pages bool
}

// The messages a grant's Gram store is seeded with, without and with Pages.
const (
	GuestShareSeed      = 6
	GuestSharePagesSeed = 120
)

// guestShareStep is the time between two seeded messages, across grants.
const guestShareStep = 3 * time.Minute

// ParseGuestShares parses semicolon-separated grants `agent|owner|machine|options`,
// options a comma-separated set of gram, multi and pages (or none). Agent
// names are unique: an injected message names its grant by its agent.
func ParseGuestShares(spec string) ([]GuestShare, error) {
	var shares []GuestShare
	seen := map[string]bool{}
	for grant := range strings.SplitSeq(spec, ";") {
		if strings.TrimSpace(grant) == "" {
			continue
		}
		fields := strings.Split(grant, "|")
		if len(fields) != 4 {
			return nil, fmt.Errorf("guest share %q: want agent|owner|machine|options", grant)
		}
		for i := range fields {
			fields[i] = strings.TrimSpace(fields[i])
		}
		share := GuestShare{Agent: fields[0], Owner: fields[1], Machine: fields[2]}
		if share.Agent == "" || share.Owner == "" || share.Machine == "" {
			return nil, fmt.Errorf("guest share %q: agent, owner and machine are required", grant)
		}
		if seen[share.Agent] {
			return nil, fmt.Errorf("guest share %q: agent %q is shared twice", grant, share.Agent)
		}
		seen[share.Agent] = true
		for option := range strings.SplitSeq(fields[3], ",") {
			switch strings.TrimSpace(option) {
			case "":
			case "gram":
				share.Gram = true
			case "multi":
				share.MultiRequest = true
			case "pages":
				share.Pages = true
			default:
				return nil, fmt.Errorf("guest share %q: unknown option %q: want gram, multi or pages", grant, option)
			}
		}
		shares = append(shares, share)
	}
	if len(shares) == 0 {
		return nil, errors.New("guest shares: no grant")
	}
	return shares, nil
}

// GuestShares serves several guest grants on one relay listener, as several
// owners' herdrs behind one relay: grants with the same owner and machine are
// one host (one host id and key, the relay path /v1/guest/<host id>), each
// with its own invitation, guest id and Gram store.
type GuestShares struct {
	Grants []*GuestGrant

	hosts    map[string]*GuestRelay // by host id: the host's first grant
	srv      *http.Server
	mu       sync.Mutex
	injected int
}

// GuestGrant is one grant GuestShares serves: its relay (gate) and its Gram.
type GuestGrant struct {
	GuestShare
	Relay *GuestRelay
	Gram  *Gram
}

// NewGuestShares makes the grants' hosts, relays and seeded Gram stores.
// Each grant's agent stands on the owner's pane ownerPane: agent.list
// through its gate lists that agent alone, working; its gram.* go to its own
// store; anything else goes to owner, the owner's herdr, as the gate
// forwards it. Seeded message times interleave across grants, newest at now.
func NewGuestShares(shares []GuestShare, owner func(method string, params json.RawMessage) (any, *APIError), ownerPane string, now time.Time) (*GuestShares, error) {
	s := &GuestShares{hosts: map[string]*GuestRelay{}}
	byHost := map[[2]string]*GuestRelay{}
	for i, share := range shares {
		relay, err := NewGuestRelay()
		if err != nil {
			return nil, err
		}
		n := i + 1
		grant := &GuestGrant{GuestShare: share, Relay: relay, Gram: NewGram(fmt.Sprintf("fake-guest-store-%d", n))}
		if first, ok := byHost[[2]string{share.Owner, share.Machine}]; ok {
			relay.hostID, relay.host = first.hostID, first.host
		} else {
			byHost[[2]string{share.Owner, share.Machine}] = relay
			s.hosts[relay.hostID] = relay
		}
		relay.issues = fmt.Sprintf("fake-guest-%d", n)
		relay.TerminalID, relay.AgentName = fmt.Sprintf("g%d", n), share.Agent
		relay.OwnerName, relay.MachineLabel, relay.GuestName = share.Owner, share.Machine, "visitor"
		relay.Gram, relay.MultiRequest = share.Gram, share.MultiRequest
		agent := map[string]any{"terminal_id": relay.TerminalID, "pane_id": ownerPane, "name": share.Agent,
			"agent": "omp", "agent_status": "working"}
		relay.Handle = func(method string, params json.RawMessage) (any, *APIError) {
			if method == "agent.list" {
				return map[string]any{"type": "agent_list", "agents": []any{agent}}, nil
			}
			if value, apiErr, ok := grant.Gram.Handle(method, params); ok {
				return value, apiErr
			}
			if owner == nil {
				return nil, &APIError{Code: "unknown_method", Message: method}
			}
			return owner(method, params)
		}
		grant.seed(i, len(shares), now)
		s.Grants = append(s.Grants, grant)
	}
	return s, nil
}

// seed fills the grant's store, grant i of n: newest first, two unread agent
// messages, the guest's post to the agent, then read agent messages. The
// k-th newest message of every grant is older than every grant's (k-1)-th,
// so a merged feed alternates between grants.
func (g *GuestGrant) seed(i, n int, now time.Time) {
	count := GuestShareSeed
	if g.Pages {
		count = GuestSharePagesSeed
	}
	notes := []string{"draft is ready for review", "found two issues in the latest run", "waiting on your go-ahead",
		"summary is below", "all checks passed", "need one more detail from you"}
	for age := count - 1; age >= 0; age-- {
		at := now.Add(-time.Duration(age*n+i) * guestShareStep)
		m := herdrapi.GramMessageInfo{
			ID: fmt.Sprintf("g%d-gram-%d", i+1, count-age), CreatedUnixMs: uint64(at.UnixMilli()),
			Direction: herdrapi.GramDirectionAgentToOwner, From: g.Agent, ReadByOwner: age > 2,
			Text: fmt.Sprintf("%s: %s (#%d)", g.Agent, notes[age%len(notes)], count-age),
		}
		if age == 2 {
			to := g.Agent
			m.Direction, m.From, m.To, m.ReadByOwner = herdrapi.GramDirectionOwnerToAgent, "owner", &to, false
			m.Text = fmt.Sprintf("Thanks %s, please go ahead.", g.Agent)
		}
		g.Gram.Add(m, nil)
	}
}

// Listen serves every host's relay on addr and returns its http:// base URL.
func (s *GuestShares) Listen(addr string) (string, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return "", err
	}
	s.srv = &http.Server{Handler: http.HandlerFunc(s.serve), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = s.srv.Serve(ln) }()
	return "http://" + ln.Addr().String(), nil
}

// Close stops the relay.
func (s *GuestShares) Close() error {
	if s.srv == nil {
		return nil
	}
	return s.srv.Close()
}

// serve answers a guest connect to a host: the grant its hello names (its
// invitation or guest id) admits and serves it. A hello naming none of the
// host's grants gets the host's first grant's refusal.
func (s *GuestShares) serve(w http.ResponseWriter, req *http.Request) {
	id, ok := strings.CutPrefix(req.URL.Path, "/v1/guest/")
	first := s.hosts[id]
	if !ok || first == nil {
		http.NotFound(w, req)
		return
	}
	socket, handshake, hello, ok := acceptGuest(w, req, first.hostID, first.host, first.WebOrigins)
	if !ok {
		return
	}
	defer socket.CloseNow()
	r := first
	for _, grant := range s.Grants {
		if grant.Relay.hostID == id && grant.Relay.claims(hello) {
			r = grant.Relay
			break
		}
	}
	index, admitted := r.admit()
	if !admitted {
		return
	}
	end, stop := context.WithCancel(req.Context())
	defer stop()
	served, overlapped, ended := r.session(index, stop)
	ended(r.converse(req.Context(), end, socket, handshake, hello, served, overlapped))
}

// Inject appends text as a new unread message from agent to its grant's
// store, and returns its id.
func (s *GuestShares) Inject(agent, text string) (string, error) {
	for _, grant := range s.Grants {
		if grant.Agent != agent {
			continue
		}
		s.mu.Lock()
		s.injected++
		id := fmt.Sprintf("%s-inject-%d", grant.Relay.TerminalID, s.injected)
		s.mu.Unlock()
		grant.Gram.Add(herdrapi.GramMessageInfo{ID: id, CreatedUnixMs: uint64(time.Now().UnixMilli()),
			Direction: herdrapi.GramDirectionAgentToOwner, From: agent, Text: text}, nil)
		return id, nil
	}
	return "", fmt.Errorf("no guest share of agent %q", agent)
}

// InjectFile injects every `agent|text` line of the file at path, if it
// exists, then removes it; injected says what it added, as `agent id`.
func (s *GuestShares) InjectFile(path string) (injected []string, err error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := os.Remove(path); err != nil {
		return nil, err
	}
	for line := range strings.SplitSeq(string(raw), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		agent, text, ok := strings.Cut(line, "|")
		if !ok {
			return injected, fmt.Errorf("inject %q: want agent|text", line)
		}
		agent = strings.TrimSpace(agent)
		id, err := s.Inject(agent, strings.TrimSpace(text))
		if err != nil {
			return injected, err
		}
		injected = append(injected, agent+" "+id)
	}
	return injected, nil
}
