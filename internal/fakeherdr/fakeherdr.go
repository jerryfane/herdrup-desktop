// Package fakeherdr is an SSH server that answers `herdr api-bridge`
// commands from canned data. Tests use it, and CI uses it (through
// cmd/fakeherdr) to show a board in the window on machines with no herdr.
package fakeherdr

import (
	"bufio"
	"bytes"
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
	HostKey ssh.Signer
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
	// Handle answers a request. Whether a herdr advertises api_bridge_multi
	// is up to the pong it returns for "ping"; see Pong.
	Handle func(method string, params json.RawMessage) (any, *APIError)
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
	// `session` subcommand.
	SessionList string
	// Machines, when not nil, are the saved SSH machines: machine.status
	// answers with them before Handle is asked, and `herdr machine
	// federate|unfederate <id>` opts one in or out. When nil, Handle
	// answers machine.status and there is no machine subcommand.
	Machines []Machine
	// MachineStatusError, when set, makes machine.status fail with it.
	MachineStatusError *APIError
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
	maxInFlight  int
	conns        int
	ln           net.Listener
	wg           sync.WaitGroup
}

// Request is one request the fake received.
type Request struct {
	Method  string
	Session string // "" for the default session
	// Multi is true for a request on an `api-bridge --multi` channel and
	// false for one exec per request.
	Multi bool
	// Bytes is the length of the request line.
	Bytes int
}

// Pong is a ping result; multi says whether it advertises
// api_bridge_multi.
func Pong(multi bool) map[string]any {
	return map[string]any{"type": "pong", "version": "0.9.5", "protocol": 22,
		"capabilities": map[string]bool{"api_bridge_multi": multi, "events_v2": true}}
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
func (s *Server) Conns() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conns
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
	s.mu.Unlock()
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		if nc.ChannelType() != "session" {
			_ = nc.Reject(ssh.UnknownChannelType, "only sessions")
			continue
		}
		ch, creqs, err := nc.Accept()
		if err != nil {
			continue
		}
		go s.serveSession(ch, creqs)
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
	writeLine(ch, nil, s.reply(req))
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
	if s.SessionList == "" {
		fmt.Fprintln(ch.Stderr(), "error: unrecognized subcommand 'session'")
		return 2
	}
	if session != "" || len(args) != 2 || args[0] != "list" || args[1] != "--json" {
		fmt.Fprintln(ch.Stderr(), "usage: herdr session list [--json]")
		return 2
	}
	fmt.Fprintln(ch, s.SessionList)
	return 0
}

type request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func (s *Server) reply(req request) map[string]any {
	result, apiErr, ok := s.machineStatus()
	if req.Method != "machine.status" || !ok {
		result, apiErr = s.Handle(req.Method, req.Params)
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
	var mu sync.Mutex
	var wg sync.WaitGroup
	r := bufio.NewReader(ch)
	for {
		line, err := r.ReadBytes('\n')
		line = bytes.TrimSuffix(line, []byte("\n"))
		if len(line) > 0 {
			var req request
			switch {
			case len(line) > multiMaxLineBytes:
				// herdr reads the id from the line's head; the fake can
				// parse it whole.
				_ = json.Unmarshal(line, &req)
				s.record(Request{Method: req.Method, Session: session, Multi: true, Bytes: len(line)})
				writeLine(ch, &mu, map[string]any{"id": req.ID, "error": APIError{Code: "invalid_request",
					Message: fmt.Sprintf("api-bridge: request line exceeds %d bytes", multiMaxLineBytes)}})
			case json.Unmarshal(line, &req) != nil:
				writeLine(ch, &mu, map[string]any{"id": "", "error": APIError{Code: "invalid_request", Message: "bad json"}})
			case multiStreamingMethods[req.Method]:
				s.record(Request{Method: req.Method, Session: session, Multi: true, Bytes: len(line)})
				writeLine(ch, &mu, map[string]any{"id": req.ID, "error": APIError{Code: "unsupported_method",
					Message: "api-bridge --multi does not forward streaming method " + req.Method}})
			default:
				s.record(Request{Method: req.Method, Session: session, Multi: true, Bytes: len(line)})
				s.mu.Lock()
				s.inFlight++
				s.maxInFlight = max(s.maxInFlight, s.inFlight)
				s.mu.Unlock()
				wg.Add(1)
				go func() {
					defer wg.Done()
					rep := s.reply(req)
					s.mu.Lock()
					s.inFlight--
					s.mu.Unlock()
					writeLine(ch, &mu, rep)
				}()
			}
		}
		if err != nil {
			wg.Wait()
			return
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
