package fakeherdr

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/flynn/noise"
)

// GuestRelay is a herdr guest relay and the host's guest gate in one, for
// exercising a HerdrUp guest without a real relay, grant or host. It serves
// the relay's guest socket (`/v1/guest/<host id>`, Noise IK with the host's
// key), redeems the one invitation InviteLink prints, and answers each
// authenticated request the way herdr's gate does
// (jerryfane/herdr src/api/server/guest_gate.rs at d78b91c, herdr #352):
// only the granted agent, forwarded to Handle (the owner's API), and
// guest_forbidden for everything else.
//
// A guest answers the agent's questions as the owner can: agent.answer, and
// menu keys through pane.send_keys while the agent waits on a menu.
// OwnerOnlyAnswers makes it a host older than that, which refuses both and
// withholds pending_ask.answerable from the guest.
type GuestRelay struct {
	// Handle answers the requests the gate forwards, as the owner's herdr.
	Handle func(method string, params json.RawMessage) (any, *APIError)
	// Streams answers streaming methods on the granted pane (pane.stream).
	Streams map[string]StreamFunc
	// Grant is the shared agent: its terminal id and name.
	TerminalID, AgentName string
	// Who shares it, from where, with whom.
	OwnerName, MachineLabel, GuestName string
	// OwnerOnlyAnswers is a herdr older than guest answers.
	OwnerOnlyAnswers bool
	// NoGuestRunning is a host older than guest_running, which leaves it out
	// of the agents it lists.
	NoGuestRunning bool
	// OnRequest hears every guest request's method as it arrives, refused
	// ones included.
	OnRequest func(method string)
	// Now is the relay's clock for LimitConnects and Connects; nil is the
	// wall clock.
	Now func() time.Time
	// OnConnect hears each guest connect as it is admitted or refused. It
	// runs with the relay locked.
	OnConnect func(GuestConnect)

	hostID   string
	host     noise.DHKey
	inviteID string
	secret   string
	srv      *http.Server

	mu       sync.Mutex
	guestID  string
	guestKey []byte
	calls    []GuestCall
	// connects are the guest's relay connects; past connectLimit in a minute
	// the relay refuses one with 429 rate_limited (LimitConnects).
	connects     []GuestConnect
	connectLimit int
	// paused is the share paused (Pause).
	paused bool
	// commit is the granted agent's state_change_seq when a guest batch last
	// committed a menu choice; committed says one has.
	commit    uint64
	committed bool
}

// GuestConnect is one guest connect to the relay: one WebSocket and Noise
// handshake, which a guest opens for every request.
type GuestConnect struct {
	At time.Time
	// Refused is the relay's 429 rate_limited.
	Refused bool
}

// GuestCall is one request a guest made: its method, its params as the gate
// forwarded them (nil when it was refused) and the refusal code, if any.
type GuestCall struct {
	Method  string
	Params  json.RawMessage
	Refusal string
}

// NewGuestRelay makes a relay with a fresh host key and one invitation.
func NewGuestRelay() (*GuestRelay, error) {
	host, err := noise.DH25519.GenerateKeypair(rand.Reader)
	if err != nil {
		return nil, err
	}
	random := func(n int) string {
		b := make([]byte, n)
		_, _ = rand.Read(b)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	return &GuestRelay{host: host, hostID: random(16), inviteID: random(16), secret: random(32)}, nil
}

// Listen serves the relay on addr and returns its http:// base URL, which
// HerdrUp accepts for a loopback relay.
func (r *GuestRelay) Listen(addr string) (string, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return "", err
	}
	r.srv = &http.Server{Handler: http.HandlerFunc(r.serve), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = r.srv.Serve(ln) }()
	return "http://" + ln.Addr().String(), nil
}

// Close stops the relay.
func (r *GuestRelay) Close() error {
	if r.srv == nil {
		return nil
	}
	return r.srv.Close()
}

// InviteLink is the invitation's app link (herdrup://guest-invite#…), v1 as
// herdr's guest.invite.create writes it.
func (r *GuestRelay) InviteLink(relay string, expires time.Time) string {
	payload, _ := json.Marshal(map[string]any{
		"v": 1, "relay": relay, "host_id": r.hostID,
		"host_pub":  base64.RawURLEncoding.EncodeToString(r.host.Public),
		"invite_id": r.inviteID, "secret": r.secret,
		"machine_label": r.MachineLabel, "owner_name": r.OwnerName,
		"agent_name": r.AgentName, "guest_name": r.GuestName,
		"expires_unix": expires.Unix(),
	})
	return "herdrup://guest-invite#" + base64.RawURLEncoding.EncodeToString(payload)
}

// Calls returns every request a guest made, in order.
func (r *GuestRelay) Calls() []GuestCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.calls)
}

// Connects returns every guest connect to the relay, refused ones included,
// in order.
func (r *GuestRelay) Connects() []GuestConnect {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.connects)
}

// LimitConnects makes the relay refuse a guest connect with 429 rate_limited
// once n connects (refused ones included) arrived in the minute before it,
// as the relay's GUEST_CONNECT_LIMIT does a network's; 0 lifts the limit.
func (r *GuestRelay) LimitConnects(n int) {
	r.mu.Lock()
	r.connectLimit = n
	r.mu.Unlock()
}

// admit records a guest connect and says whether the limit lets it through.
func (r *GuestRelay) admit() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	if r.Now != nil {
		now = r.Now()
	}
	recent := 0
	for _, earlier := range r.connects {
		if now.Sub(earlier.At) < time.Minute {
			recent++
		}
	}
	connect := GuestConnect{At: now, Refused: r.connectLimit > 0 && recent >= r.connectLimit}
	r.connects = append(r.connects, connect)
	if r.OnConnect != nil {
		r.OnConnect(connect)
	}
	return !connect.Refused
}

func (r *GuestRelay) serve(w http.ResponseWriter, req *http.Request) {
	if req.URL.Path != "/v1/guest/"+r.hostID {
		http.NotFound(w, req)
		return
	}
	if !r.admit() {
		w.Header().Set("X-Herdr-Guest-Error", "rate_limited")
		http.Error(w, `{"error":"rate_limited"}`, http.StatusTooManyRequests)
		return
	}
	socket, err := websocket.Accept(w, req, nil)
	if err != nil {
		return
	}
	defer socket.CloseNow()
	socket.SetReadLimit(65535)
	ctx := req.Context()
	handshake, err := noise.NewHandshakeState(noise.Config{
		CipherSuite: noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashSHA256),
		Pattern:     noise.HandshakeIK, Prologue: []byte("herdr-guest/1:" + r.hostID), StaticKeypair: r.host,
	})
	if err != nil {
		return
	}
	_, message, err := socket.Read(ctx)
	if err != nil {
		return
	}
	plain, _, _, err := handshake.ReadMessage(nil, message)
	if err != nil {
		return
	}
	var hello struct {
		InviteID string `json:"invite_id"`
		Secret   string `json:"secret"`
		GuestID  string `json:"guest_id"`
	}
	_ = json.Unmarshal(plain, &hello)
	reply, request := r.hello(hello.InviteID, hello.Secret, hello.GuestID, handshake.PeerStatic())
	answer, receive, send, err := handshake.WriteMessage(nil, reply)
	if err != nil || socket.Write(ctx, websocket.MessageBinary, answer) != nil || !request {
		return
	}
	var line []byte
	for !bytes.Contains(line, []byte{'\n'}) {
		_, message, err := socket.Read(ctx)
		if err != nil {
			return
		}
		chunk, err := receive.Decrypt(nil, nil, message)
		if err != nil {
			return
		}
		line = append(line, chunk...)
	}
	emit := func(out []byte) error {
		sealed, err := send.Encrypt(nil, nil, append(out, '\n'))
		if err != nil {
			return err
		}
		return socket.Write(ctx, websocket.MessageBinary, sealed)
	}
	r.request(ctx, bytes.TrimSpace(line[:bytes.IndexByte(line, '\n')]), emit)
	_ = socket.Close(websocket.StatusNormalClosure, "")
}

// hello answers the guest's handshake payload: an invitation redeemed once,
// then the returning guest by its id and device key. request says a request
// line follows (a returning guest's).
func (r *GuestRelay) hello(inviteID, secret, guestID string, key []byte) ([]byte, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	refuse := func(code string) ([]byte, bool) {
		b, _ := json.Marshal(map[string]any{"ok": false, "error": code})
		return b, false
	}
	switch {
	case inviteID != "":
		if inviteID != r.inviteID || secret != r.secret {
			return refuse("invite_invalid")
		}
		if r.guestID != "" {
			return refuse("invite_used")
		}
		r.guestID, r.guestKey = "fake-guest-1", slices.Clone(key)
	case guestID == "" || guestID != r.guestID || !bytes.Equal(key, r.guestKey):
		return refuse("unknown")
	}
	b, _ := json.Marshal(map[string]any{
		"ok": true, "guest_id": r.guestID, "name": r.GuestName, "machine_label": r.MachineLabel,
		"owner_name": r.OwnerName, "agent": map[string]string{"name": r.AgentName, "target": r.TerminalID},
		"features": map[string]bool{},
	})
	return b, inviteID == ""
}

// request answers one guest request as herdr's guest gate (serve_request,
// guest_gate.rs:703-1060), for the methods a HerdrUp guest uses.
func (r *GuestRelay) request(ctx context.Context, line []byte, emit func([]byte) error) {
	var req struct {
		ID     string          `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(line, &req); err != nil {
		return
	}
	if r.OnRequest != nil {
		r.OnRequest(req.Method)
	}
	if len(req.Params) == 0 {
		req.Params = json.RawMessage("{}")
	}
	var p struct {
		Target   string   `json:"target"`
		PaneID   string   `json:"pane_id"`
		Subagent *string  `json:"subagent"`
		Text     string   `json:"text"`
		Keys     []string `json:"keys"`
	}
	_ = json.Unmarshal(req.Params, &p)
	write := func(value any, apiErr *APIError) {
		out := map[string]any{"id": req.ID, "result": value}
		if apiErr != nil {
			out = map[string]any{"id": req.ID, "error": apiErr}
		}
		b, _ := json.Marshal(out)
		_ = emit(b)
	}
	refuse := func(code string) {
		r.record(GuestCall{Method: req.Method, Refusal: code})
		write(nil, &APIError{Code: code, Message: "guests can't do that"})
	}
	// forward sends the request on to the owner's herdr with the granted
	// pane in place of the guest's name for it.
	forward := func(params map[string]any) (map[string]any, *APIError) {
		raw, _ := json.Marshal(params)
		r.record(GuestCall{Method: req.Method, Params: raw})
		value, apiErr := r.Handle(req.Method, raw)
		if apiErr != nil {
			return nil, apiErr
		}
		b, _ := json.Marshal(value)
		var result map[string]any
		_ = json.Unmarshal(b, &result)
		return result, nil
	}
	params := func() map[string]any {
		var m map[string]any
		_ = json.Unmarshal(req.Params, &m)
		if m == nil {
			m = map[string]any{}
		}
		return m
	}
	agent, found := r.granted()
	r.mu.Lock()
	paused := r.paused
	r.mu.Unlock()
	live := found && !paused
	pane, _ := agent["pane_id"].(string)
	names := func(target string) bool {
		return target == r.TerminalID || target == r.AgentName || (live && target == pane)
	}
	switch req.Method {
	case "ping":
		// project_pong (guest_gate.rs:421-435): only what the gate serves.
		write(map[string]any{"type": "pong", "version": "fake", "protocol": 22,
			"capabilities": map[string]bool{"agent_transcript": true, "agent_avatar": true}}, nil)
	case "agent.list":
		agents := []any{}
		if live {
			agents = append(agents, r.guestView(agent))
		} else if found {
			// paused_view (guest_gate.rs:308-320): the grant alone, not running.
			agents = append(agents, map[string]any{"terminal_id": r.TerminalID, "pane_id": agent["pane_id"], "name": r.AgentName,
				"agent": agent["agent"], "display_agent": nil, "agent_status": "unknown", "guest_running": false})
		}
		write(map[string]any{"type": "agent_list", "agents": agents}, nil)
	case "agent.get":
		if !names(p.Target) {
			refuse("guest_forbidden")
		} else if !live {
			refuse("guest_paused")
		} else {
			write(map[string]any{"type": "agent_info", "agent": r.guestView(agent)}, nil)
		}
	case "agent.transcript":
		if p.Subagent != nil || !names(p.Target) {
			refuse("guest_forbidden")
			return
		}
		if !live {
			refuse("guest_paused")
			return
		}
		m := params()
		m["target"] = pane
		page, apiErr := forward(m)
		if apiErr == nil {
			projectTranscript(page, r.OwnerOnlyAnswers)
		}
		write(page, apiErr)
	case "agent.prompt":
		if !names(p.Target) {
			refuse("guest_forbidden")
			return
		}
		if !live {
			refuse("guest_paused")
			return
		}
		m := params()
		m["target"], m["text"] = pane, r.GuestName+" (via HerdrUp): "+p.Text
		write(forward(m))
	case "agent.answer":
		// guest_gate.rs:972-991; refused before herdr #352.
		if r.OwnerOnlyAnswers || !names(p.Target) {
			refuse("guest_forbidden")
			return
		}
		if !live {
			refuse("guest_paused")
			return
		}
		m := params()
		m["target"] = pane
		result, apiErr := forward(m)
		if apiErr == nil {
			result = map[string]any{"type": "agent_answer", "status": result["status"]}
		}
		write(result, apiErr)
	case "pane.send_keys":
		// guest_gate.rs:992-1038; refused before herdr #352.
		keys, ok := GuestMenuBatch(p.Keys)
		if r.OwnerOnlyAnswers || !ok || !names(p.PaneID) {
			refuse("guest_forbidden")
			return
		}
		if !live {
			refuse("guest_paused")
			return
		}
		seq, _ := agent["state_change_seq"].(float64)
		r.mu.Lock()
		stale := r.committed && uint64(seq) <= r.commit
		if stale || !awaitsMenuInput(agent) {
			r.mu.Unlock()
			refuse("guest_forbidden")
			return
		}
		r.committed = false
		if CommitsMenu(keys[len(keys)-1]) {
			r.commit, r.committed = uint64(seq), true
		}
		r.mu.Unlock()
		result, apiErr := forward(map[string]any{"pane_id": pane, "keys": keys})
		if apiErr == nil {
			result = map[string]any{"type": "ok"}
		}
		write(result, apiErr)
	default:
		stream, ok := r.Streams[req.Method]
		if !ok || !names(p.PaneID) {
			refuse("guest_forbidden")
			return
		}
		if !live {
			refuse("guest_paused")
			return
		}
		m := params()
		m["pane_id"] = pane
		raw, _ := json.Marshal(m)
		r.record(GuestCall{Method: req.Method, Params: raw})
		stream(ctx, req.ID, raw, emit)
	}
}

func (r *GuestRelay) record(call GuestCall) {
	r.mu.Lock()
	r.calls = append(r.calls, call)
	r.mu.Unlock()
}

// granted finds the shared agent in the owner's agent.list; found is false
// when it is gone.
func (r *GuestRelay) granted() (map[string]any, bool) {
	value, apiErr := r.Handle("agent.list", json.RawMessage("{}"))
	if apiErr != nil {
		return nil, false
	}
	b, _ := json.Marshal(value)
	var list struct {
		Agents []map[string]any `json:"agents"`
	}
	_ = json.Unmarshal(b, &list)
	for _, agent := range list.Agents {
		if agent["terminal_id"] == r.TerminalID {
			return agent, true
		}
	}
	return nil, false
}

// Pause pauses the share as herdr does when the agent leaves its pane's
// foreground (GrantState::Paused, guest_gate.rs:254): agent.list shows it
// with guest_running false, and the agent's methods refuse guest_paused.
func (r *GuestRelay) Pause(paused bool) {
	r.mu.Lock()
	r.paused = paused
	r.mu.Unlock()
}

// guestView is the only agent fields a guest sees (GuestAgentView,
// guest_gate.rs:282-306); input_pending is left out when false, and
// guest_running too for a host older than it (NoGuestRunning).
func (r *GuestRelay) guestView(agent map[string]any) map[string]any {
	view := map[string]any{}
	if !r.NoGuestRunning {
		view["guest_running"] = true
	}
	for _, key := range []string{"terminal_id", "pane_id", "name", "agent", "display_agent", "agent_status", "avatar"} {
		view[key] = agent[key]
	}
	if pending, _ := agent["input_pending"].(bool); pending {
		view["input_pending"] = true
	}
	return view
}

// projectTranscript leaves out what a guest may not see (project_transcript,
// guest_gate.rs:565-640): notes, step details and plan blockers. A host
// older than guest answers also withholds answerable.
func projectTranscript(page map[string]any, ownerOnly bool) {
	entries, _ := page["entries"].([]any)
	kept := make([]any, 0, len(entries))
	for _, value := range entries {
		entry, _ := value.(map[string]any)
		if entry["kind"] == "note" {
			continue
		}
		delete(entry, "detail")
		delete(entry, "blocker")
		kept = append(kept, entry)
	}
	page["entries"] = kept
	if plan, ok := page["plan"].([]any); ok {
		for _, item := range plan {
			if m, ok := item.(map[string]any); ok {
				delete(m, "blocker")
			}
		}
	}
	if ask, ok := page["pending_ask"].(map[string]any); ok && ownerOnly {
		ask["answerable"] = false
	}
}

// GuestMenuBatch is herdr's guest_menu_batch (guest_gate.rs:472-507): 1 to 32
// menu keys in the form herdr parses, named keys in any case and 1-9, y, n
// exactly, at most one of them committing the menu and that one last.
func GuestMenuBatch(keys []string) ([]string, bool) {
	if len(keys) < 1 || len(keys) > 32 {
		return nil, false
	}
	out := make([]string, len(keys))
	for i, key := range keys {
		named := slices.IndexFunc([]string{"up", "down", "left", "right", "enter", "tab", "escape", "space"}, func(name string) bool { return strings.EqualFold(name, key) })
		switch {
		case named >= 0:
			out[i] = strings.ToLower(key)
		case len(key) == 1 && (key[0] >= '1' && key[0] <= '9' || key == "y" || key == "n"):
			out[i] = key
		default:
			return nil, false
		}
		if i < len(keys)-1 && CommitsMenu(out[i]) {
			return nil, false
		}
	}
	return out, true
}

// CommitsMenu is a menu key, as GuestMenuBatch returns it, that chooses,
// confirms or dismisses the menu (guest_gate.rs:485-488).
func CommitsMenu(key string) bool {
	return !slices.Contains([]string{"up", "down", "left", "right", "tab", "space"}, key)
}

// awaitsMenuInput is herdr's awaits_menu_input (guest_gate.rs:509-518): a
// confirm or select prompt, or a blocked agent whose prompt kind is unknown.
func awaitsMenuInput(agent map[string]any) bool {
	switch agent["input_prompt_kind"] {
	case "confirm", "select":
		return true
	case "free_text":
		return false
	}
	return agent["agent_status"] == "blocked"
}
