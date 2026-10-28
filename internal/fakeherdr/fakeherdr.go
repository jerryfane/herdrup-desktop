// Package fakeherdr is an SSH server that answers `herdr api-bridge`
// commands from canned data. Tests use it, and CI uses it (through
// cmd/fakeherdr) to show a board in the window on machines with no herdr.
package fakeherdr

import (
	"bufio"
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
}

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
	// Handle answers a request.
	Handle func(method string, params json.RawMessage) (any, *APIError)
	// Events is called for each events.subscribe stream and writes event
	// lines until ctx ends or it returns.
	Events func(ctx context.Context, emit func(line []byte) error)

	mu       sync.Mutex
	commands []string
	ln       net.Listener
	wg       sync.WaitGroup
}

// Commands returns every exec command received, in order.
func (s *Server) Commands() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.commands...)
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
	_, args, ok := strings.Cut(cmd, "api-bridge ")
	if !ok {
		fmt.Fprintln(ch.Stderr(), "unsupported command")
		return 2
	}
	if s.NoAPIBridge {
		fmt.Fprintln(ch.Stderr(), "error: unrecognized subcommand 'api-bridge'")
		return 2
	}
	arg := strings.TrimSuffix(strings.TrimSpace(args), "'")
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
		s.multi(ch)
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

type request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func (s *Server) reply(req request) map[string]any {
	if req.Method == "events.subscribe" {
		return map[string]any{"id": req.ID, "error": APIError{"unsupported_method", "open a dedicated channel"}}
	}
	result, apiErr := s.Handle(req.Method, req.Params)
	if apiErr != nil {
		return map[string]any{"id": req.ID, "error": apiErr}
	}
	return map[string]any{"id": req.ID, "result": result}
}

// multi answers newline-delimited requests concurrently, so replies can
// come back out of order as they do from herdr.
func (s *Server) multi(ch ssh.Channel) {
	var mu sync.Mutex
	var wg sync.WaitGroup
	r := bufio.NewReader(ch)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			var req request
			if json.Unmarshal(line, &req) != nil {
				writeLine(ch, &mu, map[string]any{"id": "", "error": APIError{"invalid_request", "bad json"}})
			} else {
				wg.Add(1)
				go func() {
					defer wg.Done()
					writeLine(ch, &mu, s.reply(req))
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
