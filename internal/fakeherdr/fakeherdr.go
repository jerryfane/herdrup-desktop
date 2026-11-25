// Package fakeherdr is an SSH server that answers `herdr api-bridge`
// commands from canned data. Tests use it, and CI uses it (through
// cmd/fakeherdr) to show a board in the window on machines with no herdr.
package fakeherdr

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// APIError is an error reply.
type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	// Current is the stored document agent.groups.set's groups_conflict
	// carries.
	Current any `json:"current,omitempty"`
}

// StreamFunc answers one streaming request on its own channel: it writes
// every line, the acknowledgement included, until ctx ends or it returns.
type StreamFunc func(ctx context.Context, id string, params json.RawMessage, emit func(line []byte) error)

// DuplexFunc answers a `remote-api-bridge` channel whose first line was a
// request: read returns each later line the client writes (io.EOF once it
// closes its side) and emit writes a line back.
type DuplexFunc func(ctx context.Context, id, method string, params json.RawMessage, read func() ([]byte, error), emit func(line []byte) error)

// Server is one fake machine.
type Server struct {
	HostKey            ssh.Signer
	AdditionalHostKeys []ssh.Signer
	// Authorized is the only client key accepted. Password, when set, is
	// accepted too.
	Authorized ssh.PublicKey
	Password   string
	// NotInstalled makes every command fail as if herdr were missing.
	NotInstalled bool
	// NoMulti emulates a herdr from before `api-bridge --multi`: it exits
	// 1 with NoMultiStderr ("Error: invalid base64 request" when empty).
	NoMulti       bool
	NoMultiStderr string
	// NoAPIBridge emulates a herdr with no api-bridge subcommand at all.
	NoAPIBridge bool
	// Frames emulates herdr's bridge from #407: `api-bridge --multi` answers
	// bridge.hello itself, then writes every reply as frames of at most
	// FrameBytes (16384 when 0), and honours bridge.cancel. FrameDelay, when
	// set, is slept between a reply's frames, as a slow link drains them.
	// Without Frames, bridge.hello and bridge.cancel go to Handle, as an older
	// bridge forwards them to its server.
	Frames     bool
	FrameBytes int
	FrameDelay time.Duration
	// Gzip: with Frames, a hello asking compress:"gzip" gets it, and replies
	// of 1024 bytes or more are framed gzipped (herdr #414).
	Gzip bool
	// EndMultiOn, when set, is asked of each request a --multi channel
	// reads: true records the request, then ends that channel there,
	// unanswered, as a herdr that restarted under it does.
	EndMultiOn func(method string) bool
	// Handle answers a request. Whether a herdr advertises api_bridge_multi
	// is up to the pong it returns for "ping"; see Pong.
	Handle func(method string, params json.RawMessage) (any, *APIError)
	// HandleSession optionally routes immutable reference replies by the SSH
	// session selected in the command. Handle remains the default for fixtures.
	HandleSession func(session, method string, params json.RawMessage) (any, *APIError)
	// Events is called for each events.subscribe stream and writes event
	// lines until ctx ends or it returns.
	Events func(ctx context.Context, emit func(line []byte) error)
	// Streams answers streaming methods by name, overriding Events for
	// events.subscribe.
	Streams map[string]StreamFunc
	// Duplex answers `herdr remote-api-bridge`. When nil the fake is a
	// herdr without that subcommand.
	Duplex DuplexFunc
	// SessionList is the output of `herdr session list --json`. When empty
	// the fake is a herdr from before named sessions, which has no
	// `session` subcommand. Change it while serving with SetSessionList.
	SessionList string
	// Machines, when not nil, are the saved SSH machines: machine.status
	// answers with them before Handle is asked, and `herdr machine
	// federate|unfederate <id>` opts one in or out. When nil, Handle
	// answers machine.status and there is no machine subcommand.
	Machines []Machine
	// MachineStatusError, when set, makes machine.status fail with it.
	MachineStatusError *APIError
	// MachineStatusDelay, when set, is called before each machine.status
	// is answered, which waits for it to return.
	MachineStatusDelay func()
	// MachineStdout is written to stdout by every `herdr machine` command.
	MachineStdout string
	// MachineStderr, when set, makes `herdr machine federate|unfederate`
	// write it to stderr and exit 1 without changing anything.
	MachineStderr string

	mu           sync.Mutex
	commands     []string
	requests     []Request
	machineCalls []MachineCall
	inFlight     int // --multi requests being answered now
	multiSeq     int // --multi channels opened so far
	multiOpen    map[int]ssh.Channel
	maxInFlight  int
	gzipReplies  int // replies sent gzipped (Gzip)
	conns        int
	live         map[*ssh.ServerConn]bool // logged-in connections still open
	ln           net.Listener
	wg           sync.WaitGroup
	channelOpen  func()
	openChannels int
}

// StallChannelOpens makes every later session channel open wait for hook
// to return before the fake answers it, as a server that stalls the
// channel-open confirmation does; nil answers at once again.
func (s *Server) StallChannelOpens(hook func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.channelOpen = hook
}

// Request is one request the fake received.
type Request struct {
	Method  string
	Session string // "" for the default session
	// Multi is true for a request on an `api-bridge --multi` channel and
	// false for one exec per request.
	Multi bool
	// Channel numbers the --multi channel the request came on (1 for the
	// first opened); 0 for one exec per request.
	Channel int
	// Bytes is the length of the request line.
	Bytes int
}

// Pong is a ping result; multi says whether it advertises
// api_bridge_multi.
func Pong(multi bool) map[string]any {
	return map[string]any{"type": "pong", "version": "0.9.5", "protocol": 22,
		"capabilities": map[string]bool{"api_bridge_multi": multi, "events_v2": true}}
}

// PongFrames is a ping result that also advertises api_bridge_frames.
func PongFrames() map[string]any {
	p := Pong(true)
	p["capabilities"].(map[string]bool)["api_bridge_frames"] = true
	return p
}

// Commands returns every exec command received, in order.
func (s *Server) Commands() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.commands...)
}

// Requests returns every request received, in the order they arrived.
// Lines --multi cannot parse as JSON are left out.
func (s *Server) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Request(nil), s.requests...)
}

// MultiInFlight returns how many --multi requests are being answered now,
// and the most there have been at once.
func (s *Server) MultiInFlight() (now, max int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.inFlight, s.maxInFlight
}

// Conns returns how many SSH connections have logged in.
// GzipReplies is how many replies went out gzipped (Gzip).
func (s *Server) GzipReplies() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.gzipReplies
}

func (s *Server) Conns() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conns
}

// OpenChannels returns how many session channels are open now.
func (s *Server) OpenChannels() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.openChannels
}

// DropConns closes every open SSH connection, as a network drop does.
func (s *Server) DropConns() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for sc := range s.live {
		sc.Close()
	}
}

// EndMultiChannels closes every open `api-bridge --multi` channel, as a
// herdr that restarted or was rolled back ends its bridge processes; the
// SSH connection stays.
func (s *Server) EndMultiChannels() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for n, ch := range s.multiOpen {
		ch.Close()
		delete(s.multiOpen, n)
	}
}

func (s *Server) record(r Request) {
	s.mu.Lock()
	s.requests = append(s.requests, r)
	s.mu.Unlock()
}

// Listen starts serving on addr ("127.0.0.1:0" for any port) and returns
// the address.
func (s *Server) Listen(addr string) (string, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return "", err
	}
	s.ln = ln
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if s.Authorized != nil && string(key.Marshal()) == string(s.Authorized.Marshal()) {
				return nil, nil
			}
			return nil, fmt.Errorf("unknown key")
		},
		PasswordCallback: func(_ ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			if s.Password != "" && string(pw) == s.Password {
				return nil, nil
			}
			return nil, fmt.Errorf("wrong password")
		},
	}
	cfg.AddHostKey(s.HostKey)
	for _, key := range s.AdditionalHostKeys {
		cfg.AddHostKey(key)
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			s.wg.Add(1)
			go func() {
				defer s.wg.Done()
				s.serveConn(c, cfg)
			}()
		}
	}()
	return ln.Addr().String(), nil
}

// Close stops listening. Open connections end when their clients close.
func (s *Server) Close() error { return s.ln.Close() }

func (s *Server) serveConn(c net.Conn, cfg *ssh.ServerConfig) {
	sc, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		c.Close()
		return
	}
	defer sc.Close()
	s.mu.Lock()
	s.conns++
	if s.live == nil {
		s.live = map[*ssh.ServerConn]bool{}
	}
	s.live[sc] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.live, sc)
		s.mu.Unlock()
	}()
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		if nc.ChannelType() != "session" {
			_ = nc.Reject(ssh.UnknownChannelType, "only sessions")
			continue
		}
		go func() {
			s.mu.Lock()
			hook := s.channelOpen
			s.mu.Unlock()
			if hook != nil {
				hook()
			}
			ch, creqs, err := nc.Accept()
			if err != nil {
				return
			}
			s.mu.Lock()
			s.openChannels++
			s.mu.Unlock()
			s.serveSession(ch, creqs)
			s.mu.Lock()
			s.openChannels--
			s.mu.Unlock()
		}()
	}
}

func (s *Server) serveSession(ch ssh.Channel, reqs <-chan *ssh.Request) {
	defer ch.Close()
	for req := range reqs {
		if req.Type != "exec" {
			_ = req.Reply(false, nil)
			continue
		}
		var payload struct{ Command string }
		if err := ssh.Unmarshal(req.Payload, &payload); err != nil {
			_ = req.Reply(false, nil)
			return
		}
		_ = req.Reply(true, nil)
		s.mu.Lock()
		s.commands = append(s.commands, payload.Command)
		s.mu.Unlock()
		go ssh.DiscardRequests(reqs)
		// The request channel closes on the client's stdin EOF, which herdr
		// does not treat as cancellation. A stream ends when the client
		// closes the channel; probe for that with a request it refuses.
		ctx, cancel := context.WithCancel(context.Background())
		go func() {
			t := time.NewTicker(50 * time.Millisecond)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-t.C:
				}
				if _, err := ch.SendRequest("fakeherdr-alive@herdrup", true, nil); err != nil {
					cancel()
					return
				}
			}
		}()
		code := s.exec(ctx, payload.Command, ch)
		cancel()
		_, _ = ch.SendRequest("exit-status", false, binary.BigEndian.AppendUint32(nil, uint32(code)))
		return
	}
}

// exec runs one command and returns its exit status.
func (s *Server) exec(ctx context.Context, cmd string, ch ssh.Channel) int {
	if s.NotInstalled {
		fmt.Fprintln(ch.Stderr(), "__HERDR_NOT_INSTALLED__")
		return 127
	}
	_, rest, ok := strings.Cut(cmd, `exec "$HERDR"`)
	if !ok {
		fmt.Fprintln(ch.Stderr(), "unsupported command")
		return 2
	}
	args := strings.Fields(strings.TrimSuffix(strings.TrimSpace(rest), "'"))
	session := ""
	if len(args) >= 2 && args[0] == "--session" {
		session, args = args[1], args[2:]
	}
	if len(args) == 0 {
		fmt.Fprintln(ch.Stderr(), "unsupported command")
		return 2
	}
	switch args[0] {
	case "machine":
		return s.machineCommand(ch, session, args[1:])
	case "session":
		return s.sessionCommand(ch, session, args[1:])
	case "api-bridge":
	case "remote-api-bridge":
		if s.Duplex != nil && len(args) == 1 {
			return s.duplex(ctx, ch, session)
		}
		fallthrough
	default:
		fmt.Fprintf(ch.Stderr(), "error: unrecognized subcommand '%s'\n", args[0])
		return 2
	}
	if s.NoAPIBridge {
		fmt.Fprintln(ch.Stderr(), "error: unrecognized subcommand 'api-bridge'")
		return 2
	}
	if len(args) != 2 {
		fmt.Fprintln(ch.Stderr(), "Error: api-bridge accepts at most one encoded request")
		return 1
	}
	arg := args[1]
	if arg == "--multi" {
		if s.NoMulti {
			msg := s.NoMultiStderr
			if msg == "" {
				// An old herdr reads --multi as a base64 request.
				msg = "Error: invalid base64 request"
			}
			fmt.Fprintln(ch.Stderr(), msg)
			return 1
		}
		s.multi(ch, session)
		return 0
	}
	raw, err := base64.StdEncoding.DecodeString(arg)
	if err != nil {
		fmt.Fprintln(ch.Stderr(), "Error: invalid base64 request")
		return 1
	}
	var req request
	if err := json.Unmarshal(raw, &req); err != nil {
		fmt.Fprintln(ch.Stderr(), "Error: invalid request")
		return 1
	}
	s.record(Request{Method: req.Method, Session: session, Bytes: len(raw)})
	if f, ok := s.Streams[req.Method]; ok {
		var mu sync.Mutex
		f(ctx, req.ID, req.Params, func(line []byte) error { return writeRaw(ch, &mu, line) })
		return 0
	}
	if req.Method == "events.subscribe" {
		writeLine(ch, nil, map[string]any{"id": req.ID, "result": map[string]any{"type": "subscription_started"}})
		if s.Events != nil {
			var mu sync.Mutex
			s.Events(ctx, func(line []byte) error { return writeRaw(ch, &mu, line) })
		}
		return 0
	}
	writeLine(ch, nil, s.reply(session, req))
	return 0
}

// duplex answers `remote-api-bridge`: its first line is a request, and
// Duplex reads the rest of what the client writes.
func (s *Server) duplex(ctx context.Context, ch ssh.Channel, session string) int {
	r := bufio.NewReader(ch)
	read := func() ([]byte, error) {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			return bytes.TrimSuffix(line, []byte("\n")), nil
		}
		return nil, err
	}
	first, err := read()
	if err != nil {
		return 0
	}
	var req request
	if err := json.Unmarshal(first, &req); err != nil {
		writeLine(ch, nil, map[string]any{"id": "", "error": APIError{Code: "invalid_request", Message: "bad json"}})
		return 0
	}
	s.record(Request{Method: req.Method, Session: session, Bytes: len(first)})
	var mu sync.Mutex
	s.Duplex(ctx, req.ID, req.Method, req.Params, read, func(line []byte) error { return writeRaw(ch, &mu, line) })
	return 0
}

// sessionCommand answers `herdr session list --json`, which is
// machine-level: herdr refuses it with --session.
func (s *Server) sessionCommand(ch ssh.Channel, session string, args []string) int {
	s.mu.Lock()
	list := s.SessionList
	s.mu.Unlock()
	if list == "" {
		fmt.Fprintln(ch.Stderr(), "error: unrecognized subcommand 'session'")
		return 2
	}
	if session != "" || len(args) != 2 || args[0] != "list" || args[1] != "--json" {
		fmt.Fprintln(ch.Stderr(), "usage: herdr session list [--json]")
		return 2
	}
	fmt.Fprintln(ch, list)
	return 0
}

// SetSessionList changes SessionList while the fake is serving, as sessions
// starting and stopping on a machine do.
func (s *Server) SetSessionList(list string) {
	s.mu.Lock()
	s.SessionList = list
	s.mu.Unlock()
}

type request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func (s *Server) reply(session string, req request) map[string]any {
	if req.Method == "machine.status" && s.MachineStatusDelay != nil {
		s.MachineStatusDelay()
	}
	result, apiErr, ok := s.machineStatus()
	if req.Method != "machine.status" || !ok {
		if s.HandleSession != nil {
			result, apiErr = s.HandleSession(session, req.Method, req.Params)
		} else {
			result, apiErr = s.Handle(req.Method, req.Params)
		}
	}
	if apiErr != nil {
		return map[string]any{"id": req.ID, "error": apiErr}
	}
	return map[string]any{"id": req.ID, "result": result}
}

// multiMaxLineBytes is herdr's API_BRIDGE_MULTI_MAX_REQUEST_LINE_BYTES.
const multiMaxLineBytes = 1 << 20

// multiStreamingMethods are refused on --multi, as herdr does
// (API_BRIDGE_MULTI_STREAMING_METHODS).
var multiStreamingMethods = map[string]bool{
	"events.subscribe":          true,
	"pane.stream":               true,
	"pane.input.stream":         true,
	"gram.upload.stream":        true,
	"server.ssh_agent.register": true,
}

// multi answers newline-delimited requests concurrently, so replies can
// come back out of order as they do from herdr. Unlike herdr it does not
// stop reading at 16 requests in flight: it counts them (MultiInFlight),
// so a test sees a client that sends more.
func (s *Server) multi(ch ssh.Channel, session string) {
	s.mu.Lock()
	s.multiSeq++
	channel := s.multiSeq
	if s.multiOpen == nil {
		s.multiOpen = map[int]ssh.Channel{}
	}
	s.multiOpen[channel] = ch
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.multiOpen, channel)
		s.mu.Unlock()
	}()
	var wg sync.WaitGroup
	out := &bridgeOut{w: ch, frameBytes: s.FrameBytes, delay: s.FrameDelay}
	out.onGzip = func() { s.mu.Lock(); s.gzipReplies++; s.mu.Unlock() }
	if out.frameBytes <= 0 {
		out.frameBytes = 16384
	}
	// cancels holds a channel per request a bridge.cancel can still stop.
	var cmu sync.Mutex
	cancels := map[string]chan struct{}{}
	r := bufio.NewReader(ch)
	for {
		line, err := r.ReadBytes('\n')
		line = bytes.TrimSuffix(line, []byte("\n"))
		if len(line) > 0 && s.EndMultiOn != nil {
			var head request
			if json.Unmarshal(line, &head) == nil && s.EndMultiOn(head.Method) {
				s.record(Request{Method: head.Method, Session: session, Multi: true, Channel: channel, Bytes: len(line)})
				wg.Wait()
				ch.Close()
				return
			}
		}
		if len(line) > 0 {
			var req request
			switch {
			case len(line) > multiMaxLineBytes:
				// herdr reads the id from the line's head; the fake can
				// parse it whole.
				_ = json.Unmarshal(line, &req)
				s.record(Request{Method: req.Method, Session: session, Multi: true, Channel: channel, Bytes: len(line)})
				out.reply(req.ID, map[string]any{"id": req.ID, "error": APIError{Code: "invalid_request",
					Message: fmt.Sprintf("api-bridge: request line exceeds %d bytes", multiMaxLineBytes)}})
			case json.Unmarshal(line, &req) != nil:
				out.reply("", map[string]any{"id": "", "error": APIError{Code: "invalid_request", Message: "bad json"}})
			case s.Frames && req.Method == "bridge.hello":
				s.record(Request{Method: req.Method, Session: session, Multi: true, Channel: channel, Bytes: len(line)})
				var p struct {
					Compress string `json:"compress"`
				}
				_ = json.Unmarshal(req.Params, &p)
				out.hello(req.ID, s.Gzip && p.Compress == "gzip")
			case s.Frames && req.Method == "bridge.cancel":
				s.record(Request{Method: req.Method, Session: session, Multi: true, Channel: channel, Bytes: len(line)})
				var p struct {
					ID string `json:"id"`
				}
				_ = json.Unmarshal(req.Params, &p)
				cmu.Lock()
				stop, ok := cancels[p.ID]
				delete(cancels, p.ID)
				cmu.Unlock()
				if ok {
					close(stop)
				}
				out.reply(req.ID, map[string]any{"id": req.ID, "result": map[string]any{"type": "bridge_cancel", "cancelled": ok}})
			case multiStreamingMethods[req.Method]:
				s.record(Request{Method: req.Method, Session: session, Multi: true, Channel: channel, Bytes: len(line)})
				out.reply(req.ID, map[string]any{"id": req.ID, "error": APIError{Code: "unsupported_method",
					Message: "api-bridge --multi does not forward streaming method " + req.Method}})
			default:
				s.record(Request{Method: req.Method, Session: session, Multi: true, Channel: channel, Bytes: len(line)})
				s.mu.Lock()
				s.inFlight++
				s.maxInFlight = max(s.maxInFlight, s.inFlight)
				s.mu.Unlock()
				stop := make(chan struct{})
				if s.Frames {
					cmu.Lock()
					cancels[req.ID] = stop
					cmu.Unlock()
				}
				wg.Add(1)
				go func() {
					defer wg.Done()
					done := make(chan map[string]any, 1)
					go func() { done <- s.reply(session, req) }()
					var rep map[string]any
					select {
					case rep = <-done:
					case <-stop:
						rep = map[string]any{"id": req.ID, "error": APIError{Code: "cancelled",
							Message: "api-bridge: request cancelled by bridge.cancel"}}
					}
					cmu.Lock()
					delete(cancels, req.ID)
					cmu.Unlock()
					s.mu.Lock()
					s.inFlight--
					s.mu.Unlock()
					out.reply(req.ID, rep)
				}()
			}
		}
		if err != nil {
			wg.Wait()
			return
		}
	}
}

// bridgeOut writes a --multi channel's replies: whole lines, or after the
// bridge.hello reply, frames that interleave across replies.
type bridgeOut struct {
	w          io.Writer
	mu         sync.Mutex
	framed     bool
	gzip       bool
	frameBytes int
	delay      time.Duration
	// onGzip is called for each reply sent gzipped.
	onGzip func()
}

func (o *bridgeOut) hello(id string, gzip bool) {
	result := map[string]any{"type": "bridge_hello", "frames": true, "frame_bytes": o.frameBytes, "cancel": true}
	if gzip {
		result["compress"] = "gzip"
	}
	data, _ := json.Marshal(map[string]any{"id": id, "result": result})
	o.mu.Lock()
	defer o.mu.Unlock()
	_, _ = o.w.Write(append(data, '\n'))
	o.framed, o.gzip = true, gzip
}

func (o *bridgeOut) reply(id string, v any) {
	data, _ := json.Marshal(v)
	o.mu.Lock()
	framed := o.framed
	enc := ""
	if framed && o.gzip && len(data) >= 1024 {
		var buf bytes.Buffer
		zw := gzip.NewWriter(&buf)
		_, _ = zw.Write(data)
		_ = zw.Close()
		if buf.Len() < len(data) {
			data, enc = buf.Bytes(), "gzip"
			if o.onGzip != nil {
				o.onGzip()
			}
		}
	}
	if !framed {
		_, _ = o.w.Write(append(data, '\n'))
	}
	o.mu.Unlock()
	if !framed {
		return
	}
	// One frame per lock: frames of replies written at once interleave.
	for off := 0; ; {
		n := min(o.frameBytes, len(data)-off)
		last := off+n == len(data)
		header := map[string]any{"frame": id, "len": n, "last": last}
		if enc != "" {
			header["enc"] = enc
		}
		head, _ := json.Marshal(header)
		o.mu.Lock()
		_, _ = o.w.Write(append(head, '\n'))
		_, _ = o.w.Write(data[off : off+n])
		o.mu.Unlock()
		off += n
		if last {
			return
		}
		if o.delay > 0 {
			time.Sleep(o.delay)
		}
	}
}

func writeLine(w io.Writer, mu *sync.Mutex, v any) {
	data, _ := json.Marshal(v)
	_ = writeRaw(w, mu, data)
}

func writeRaw(w io.Writer, mu *sync.Mutex, line []byte) error {
	if mu != nil {
		mu.Lock()
		defer mu.Unlock()
	}
	_, err := w.Write(append(line, '\n'))
	return err
}
