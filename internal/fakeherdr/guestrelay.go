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
	// WebOrigins are page origins (host[:port] patterns) whose WebSockets the
	// relay accepts besides its own: the web guest served from another local
	// port. The real relay serves /web/ from its own origin.
	WebOrigins []string
	// NoGuestRunning is a host older than guest_running, which leaves it out
	// of the agents it lists.
	NoGuestRunning bool
	// Gram is the share-gram switch: features.gram, and the gate serves the
	// guest Gram methods (gram.list's guest projection, gram.mark_read,
	// gram.post to the granted agent, uploads and file chunks).
	Gram bool
	// OnRequest hears every guest request's method as it arrives, refused
	// ones included.
	OnRequest func(method string)
	// Now is the relay's clock for LimitConnects and Connects; nil is the
	// wall clock.
	Now func() time.Time
	// OnConnect hears each guest connect as it is admitted or refused. It
	// runs with the relay locked.
	OnConnect func(GuestConnect)
	// OnSessionEnd hears each admitted session end, with its connect's
	// index in Connects. It runs with the relay locked.
	OnSessionEnd func(index int, c GuestConnect)
	// MultiRequest is a herdr that serves requests in turn on one guest
	// session (jerryfane/herdr#356, guest_gate.rs serve_session) and says so
	// as features.multi_request; without it a session answers one request.
	MultiRequest bool
	// IdleLimit is how long a MultiRequest session waits for its next
	// request (herdr's SESSION_IDLE_TIMEOUT); 0 is herdr's 60 s.
	IdleLimit time.Duration
	// DropReply makes the gate serve a request and then end the session
	// without its reply, as a connection lost after herdr acted on it.
	DropReply func(method string) bool

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
	// ends ends each live session as herdr does on a revoke or its stop
	// (EndSessions), by connect index.
	ends map[int]context.CancelFunc
	// paused is the share paused (Pause).
	paused bool
	// commit is the granted agent's state_change_seq when a guest batch last
	// committed a menu choice; committed says one has.
	commit    uint64
	committed bool
}

// GuestConnect is one guest connect to the relay: one WebSocket and Noise
// handshake, which a guest opens for every request unless the host serves
// several on one (MultiRequest).
type GuestConnect struct {
	At time.Time
	// Refused is the relay's 429 rate_limited.
	Refused bool
	// Requests counts the request lines its session served.
	Requests int
	// Overlapped says the guest sent on the session while a request was
	// still being answered, which herdr reads as the guest leaving.
	Overlapped bool
	// End says why an admitted session ended, once it has: "guest" (the
	// guest closed it), "reply" (one request answered, no MultiRequest),
	// "idle", "guest_paused", "guest_revoked", "invalid_request", "stream",
	// "dropped" (DropReply), "ended" (EndSessions) or "handshake".
	End string
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

// admit records a guest connect and says whether the limit lets it through,
// and its index in Connects.
func (r *GuestRelay) admit() (int, bool) {
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
	return len(r.connects) - 1, !connect.Refused
}

// EndSessions ends every live guest session as herdr does when it stops or
// the guest is revoked while idle: the host closes it.
func (r *GuestRelay) EndSessions() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, end := range r.ends {
		end()
	}
}

// session tracks the connect at index while its session lives: its requests
// and, when it is over, why it ended.
func (r *GuestRelay) session(index int, end context.CancelFunc) (served, overlapped func(), ended func(string)) {
	r.mu.Lock()
	if r.ends == nil {
		r.ends = map[int]context.CancelFunc{}
	}
	r.ends[index] = end
	r.mu.Unlock()
	served = func() {
		r.mu.Lock()
		r.connects[index].Requests++
		r.mu.Unlock()
	}
	overlapped = func() {
		r.mu.Lock()
		r.connects[index].Overlapped = true
		r.mu.Unlock()
	}
	ended = func(why string) {
		r.mu.Lock()
		delete(r.ends, index)
		r.connects[index].End = why
		if r.OnSessionEnd != nil {
			r.OnSessionEnd(index, r.connects[index])
		}
		r.mu.Unlock()
	}
	return served, overlapped, ended
}

func (r *GuestRelay) serve(w http.ResponseWriter, req *http.Request) {
	if req.URL.Path != "/v1/guest/"+r.hostID {
		http.NotFound(w, req)
		return
	}
	index, admitted := r.admit()
	if !admitted {
		w.Header().Set("X-Herdr-Guest-Error", "rate_limited")
		http.Error(w, `{"error":"rate_limited"}`, http.StatusTooManyRequests)
		return
	}
	end, stop := context.WithCancel(req.Context())
	defer stop()
	served, overlapped, ended := r.session(index, stop)
	why := "guest"
	defer func() { ended(why) }()
	socket, err := websocket.Accept(w, req, &websocket.AcceptOptions{OriginPatterns: r.WebOrigins})
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
	if err != nil || socket.Write(ctx, websocket.MessageBinary, answer) != nil {
		return
	}
	if !request {
		why = "handshake"
		_ = socket.Close(websocket.StatusNormalClosure, "")
		return
	}
	// The guest's frames, decrypted in order, until it leaves.
	chunks := make(chan []byte)
	go func() {
		defer close(chunks)
		for {
			_, message, err := socket.Read(ctx)
			if err != nil {
				return
			}
			chunk, err := receive.Decrypt(nil, nil, message)
			if err != nil {
				return
			}
			select {
			case chunks <- chunk:
			case <-ctx.Done():
				return
			}
		}
	}()
	var buffer []byte
	// A reply line goes out in Noise messages of at most 65535 bytes, as herdr's gate and
	// internal/guest/session.go write them (a Gram file chunk's line is larger).
	emit := func(out []byte) error {
		// A guest sends its next request only after the reply: a line, or a
		// frame waiting, before the reply goes out overlaps this request.
		select {
		case chunk, open := <-chunks:
			if open {
				buffer = append(buffer, chunk...)
			}
		default:
		}
		if len(buffer) > 0 {
			overlapped()
		}
		for line := append(out, '\n'); len(line) > 0; {
			n := min(len(line), 65535-16)
			sealed, err := send.Encrypt(nil, nil, line[:n])
			if err != nil {
				return err
			}
			if err := socket.Write(ctx, websocket.MessageBinary, sealed); err != nil {
				return err
			}
			line = line[n:]
		}
		return nil
	}
	idle := r.IdleLimit
	if idle == 0 {
		idle = 60 * time.Second
	}
	for {
		timer := time.NewTimer(idle)
		for bytes.IndexByte(buffer, '\n') < 0 && why == "guest" {
			select {
			case chunk, open := <-chunks:
				if !open {
					timer.Stop()
					return
				}
				buffer = append(buffer, chunk...)
			case <-timer.C:
				why = "idle"
			case <-end.Done():
				why = "ended"
			}
		}
		timer.Stop()
		if why != "guest" {
			break
		}
		at := bytes.IndexByte(buffer, '\n')
		line := bytes.TrimSpace(buffer[:at])
		buffer = buffer[at+1:]
		served()
		if why = r.request(ctx, line, emit); why == "dropped" {
			return
		}
		if why == "" && !r.MultiRequest {
			why = "reply"
		}
		if why != "" {
			break
		}
		why = "guest"
	}
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
	// An older herdr says nothing of multi_request.
	features := map[string]bool{"gram": r.Gram}
	if r.MultiRequest {
		features["multi_request"] = true
	}
	b, _ := json.Marshal(map[string]any{
		"ok": true, "guest_id": r.guestID, "name": r.GuestName, "machine_label": r.MachineLabel,
		"owner_name": r.OwnerName, "agent": map[string]string{"name": r.AgentName, "target": r.TerminalID},
		"features": features,
	})
	return b, inviteID == ""
}

// request answers one guest request as herdr's guest gate (serve_request,
// guest_gate.rs:703-1060), for the methods a HerdrUp guest uses. ends says
// why the session ends after it, or is empty when the session may go on
// (serve_session in jerryfane/herdr#356): a guest_paused refusal, a line
// that is not a request, a stream, or DropReply's lost reply.
func (r *GuestRelay) request(ctx context.Context, line []byte, emit func([]byte) error) (ends string) {
	var req struct {
		ID     string          `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(line, &req); err != nil {
		b, _ := json.Marshal(map[string]any{"id": "", "error": APIError{Code: "invalid_request", Message: "invalid request: " + err.Error()}})
		_ = emit(b)
		return "invalid_request"
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
		if r.DropReply != nil && r.DropReply(req.Method) {
			ends = "dropped"
			return
		}
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
		if code == "guest_paused" && ends == "" {
			ends = code
		}
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
	case "gram.list", "gram.mark_read", "gram.post", "gram.upload_chunk", "gram.upload.discard", "gram.get_file_chunk":
		if !r.Gram {
			refuse("guest_forbidden")
			return
		}
		if paused {
			refuse("guest_paused")
			return
		}
		m := params()
		switch req.Method {
		case "gram.list":
			limit, _ := m["limit"].(float64)
			if limit < 1 || limit > 500 {
				write(nil, &APIError{Code: "invalid_params", Message: "limit must be 1 to 500"})
				return
			}
			m = map[string]any{"limit": limit, "before_id": m["before_id"]}
		case "gram.mark_read":
			m = map[string]any{"ids": m["ids"]}
		case "gram.post":
			m["to"] = r.AgentName
		}
		result, apiErr := forward(m)
		if apiErr != nil || req.Method != "gram.list" {
			write(result, apiErr)
			return
		}
		// The guest projection: no owner read mark, claim or recipient.
		listed, _ := result["messages"].([]any)
		messages := make([]any, 0, len(listed))
		for _, v := range listed {
			o, _ := v.(map[string]any)
			read, _ := o["read_by_owner"].(bool)
			if o["direction"] != "agent_to_owner" {
				read = true
			}
			g := map[string]any{"id": o["id"], "direction": o["direction"], "from": o["from"], "text": o["text"], "created_unix_ms": o["created_unix_ms"], "read": read}
			for _, k := range []string{"file", "expired_file"} {
				if o[k] != nil {
					g[k] = o[k]
				}
			}
			messages = append(messages, g)
		}
		write(map[string]any{"messages": messages, "has_more": result["has_more"] == true}, nil)
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
	case "agent.answer", "agent.answer_form":
		// guest_gate.rs:972-991; refused before herdr #352. agent.answer_form
		// follows agent.answer's rules (herdr ask-form contract).
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
		if apiErr == nil && req.Method == "agent.answer" {
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
		ends = "stream"
	}
	return ends
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
// guest_gate.rs:565-640): notes, step details, plan blockers and subagents'
// assignments and conversations. A host older than guest answers also
// withholds answerable.
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
	if subagents, ok := page["subagents"].([]any); ok {
		for _, value := range subagents {
			if m, ok := value.(map[string]any); ok {
				delete(m, "task")
				m["has_transcript"] = false
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
