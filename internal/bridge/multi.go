package bridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// Limits of herdr's `api-bridge --multi` (herdr src/remote.rs).
const (
	// maxMultiInFlight is API_BRIDGE_MULTI_MAX_IN_FLIGHT: herdr forwards at
	// most this many requests at once and stops reading stdin beyond it.
	// The client queues the rest itself.
	maxMultiInFlight = 16
	// maxMultiLineBytes is API_BRIDGE_MULTI_MAX_REQUEST_LINE_BYTES: herdr
	// refuses a longer request line, so it takes the per-request path.
	maxMultiLineBytes = 1 << 20
	// defaultOpenRetryAfter is how long a session whose --multi channel
	// failed to open sends every request per-request before trying again.
	defaultOpenRetryAfter = 30 * time.Second
)

// abandonGrace is how long a request whose caller gave up may hold its
// --multi slot waiting for herdr's answer before the channel is retired;
// the default Call timeout. A variable so tests can shorten it.
var abandonGrace = defaultCallTimeout

// multiStreamingMethods keep their connection open after the first reply,
// so herdr refuses them on --multi (API_BRIDGE_MULTI_STREAMING_METHODS).
var multiStreamingMethods = map[string]bool{
	"events.subscribe":          true,
	"pane.stream":               true,
	"pane.input.stream":         true,
	"gram.upload.stream":        true,
	"server.ssh_agent.register": true,
}

// multiRoutable reports whether a request can ride a --multi channel.
func multiRoutable(method string, line []byte) bool {
	return !multiStreamingMethods[method] && len(line) <= maxMultiLineBytes
}

// capability is what a session's herdr said about api_bridge_multi.
type capability uint8

const (
	capUnknown capability = iota
	capSupported
	capUnsupported
)

// pool holds the --multi channels of one SSH connection, at most one per
// herdr session, like herdrup's RequestChannelPool. Every session view of
// the connection shares it.
//
// Routing per session:
//   - capability unknown: per-request, while a background ping on the
//     per-request path reads capabilities.api_bridge_multi. A failed probe
//     leaves it unknown, to be probed again by the next request.
//   - unsupported (an older herdr): always per-request.
//   - supported: the session's channel, opened on demand and reopened after
//     it ends. A channel that fails to open sends requests per-request until
//     openRetryAfter has passed.
type pool struct {
	openRetryAfter time.Duration

	mu    sync.Mutex
	slots map[string]*slot
}

type slot struct {
	capability capability
	probing    bool
	ch         *multiChannel
	// opening is closed when the open in flight ends; nil when none is.
	opening chan struct{}
	retryAt time.Time
}

// slotKey is the session as herdr resolves it: "" and "default" are both
// the default session.
func slotKey(session string) string {
	if session == "default" {
		return ""
	}
	return session
}

// slot returns the session's slot. p.mu must be held.
func (p *pool) slot(session string) *slot {
	key := slotKey(session)
	s := p.slots[key]
	if s == nil {
		if p.slots == nil {
			p.slots = map[string]*slot{}
		}
		s = &slot{}
		p.slots[key] = s
	}
	return s
}

// viaMulti sends a request on the session's --multi channel. It returns
// errNotSent when nothing was written, and the request must take the
// per-request path.
func (c *Client) viaMulti(ctx context.Context, method, id string, line []byte) ([]byte, error) {
	if !multiRoutable(method, line) {
		return nil, errNotSent
	}
	p := &c.pool
	p.mu.Lock()
	s := p.slot(c.cfg.Session)
	switch s.capability {
	case capUnsupported:
		p.mu.Unlock()
		return nil, errNotSent
	case capUnknown:
		// A ping learns the capability from its own reply.
		if method != "ping" && !s.probing {
			s.probing = true
			go c.probeCapability()
		}
		p.mu.Unlock()
		return nil, errNotSent
	}
	p.mu.Unlock()
	m := c.readyChannel(ctx)
	if m == nil {
		return nil, errNotSent
	}
	return m.do(ctx, id, line)
}

// probeCapability pings the session per-request and records whether it
// advertises api_bridge_multi.
func (c *Client) probeCapability() {
	ctx, cancel := context.WithTimeout(context.Background(), openPingTimeout)
	defer cancel()
	line, _ := EncodeRequest(c.nextID("ping"), "ping", nil)
	reply, err := c.oneShot(ctx, line)
	p := &c.pool
	p.mu.Lock()
	p.slot(c.cfg.Session).probing = false
	p.mu.Unlock()
	if err == nil {
		c.learnCapability(reply)
	}
}

// learnCapability records api_bridge_multi from a ping reply. A reply that
// is not a ping result leaves the capability as it was. Learning support
// starts opening the channel, off the request path.
func (c *Client) learnCapability(reply []byte) {
	var r struct {
		Result *struct {
			Capabilities *struct {
				APIBridgeMulti bool `json:"api_bridge_multi"`
			} `json:"capabilities"`
		} `json:"result"`
	}
	if json.Unmarshal(reply, &r) != nil || r.Result == nil {
		return
	}
	supported := r.Result.Capabilities != nil && r.Result.Capabilities.APIBridgeMulti
	p := &c.pool
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.slot(c.cfg.Session)
	if !supported {
		s.capability = capUnsupported
		if s.ch != nil {
			// The session's herdr changed under a held channel.
			go s.ch.close()
			s.ch = nil
		}
		return
	}
	if s.capability == capSupported {
		return
	}
	s.capability = capSupported
	if s.opening == nil {
		c.startOpen(s)
	}
}

// startOpen opens the session's channel in the background. p.mu must be
// held. The open does not depend on any one caller's context, so a caller
// that gives up does not mark the channel as failing to open.
func (c *Client) startOpen(s *slot) {
	done := make(chan struct{})
	s.opening = done
	go func() {
		m, err := openMulti(context.Background(), c)
		p := &c.pool
		p.mu.Lock()
		defer p.mu.Unlock()
		s.opening = nil
		close(done)
		if err != nil {
			s.ch = nil
			s.retryAt = time.Now().Add(p.openRetryAfter)
			return
		}
		if s.capability != capSupported {
			// Learnt unsupported while opening.
			go m.close()
			return
		}
		s.ch = m
		s.retryAt = time.Time{}
	}()
}

// readyChannel returns the session's open channel, opening it when needed,
// or nil when there is none to use now.
func (c *Client) readyChannel(ctx context.Context) *multiChannel {
	p := &c.pool
	for {
		p.mu.Lock()
		s := p.slot(c.cfg.Session)
		if s.capability != capSupported {
			p.mu.Unlock()
			return nil
		}
		if s.ch != nil && s.ch.alive() {
			m := s.ch
			p.mu.Unlock()
			return m
		}
		if s.opening == nil {
			if s.ch == nil && time.Now().Before(s.retryAt) {
				p.mu.Unlock()
				return nil
			}
			// Never opened, or the last channel ended: reopen.
			s.ch = nil
			c.startOpen(s)
		}
		opening := s.opening
		p.mu.Unlock()
		select {
		case <-opening:
		case <-ctx.Done():
			return nil
		}
	}
}

// multiChannel is one `herdr api-bridge --multi` process. Requests are
// written one per line; replies may come back in any order and are matched
// by id.
type multiChannel struct {
	sess   *ssh.Session
	stdin  io.WriteCloser
	stderr *tailBuffer

	wmu sync.Mutex // serialises writes to stdin
	// inFlight holds a token for each request herdr has not answered yet,
	// so no more than maxMultiInFlight are ever outstanding.
	inFlight chan struct{}
	dead     chan struct{} // closed by fail
	// retiredC is closed by retire: the channel takes no new requests.
	retiredC chan struct{}
	// abandonGrace is how long an abandoned request may hold its slot.
	abandonGrace time.Duration

	mu      sync.Mutex
	pending map[string]chan reply
	// abandoned are requests whose caller gave up; their in-flight token
	// returns when herdr answers them.
	abandoned map[string]bool
	retired   bool
	err       error // set once the channel is closed
}

type reply struct {
	line []byte
	err  error
}

func openMulti(ctx context.Context, c *Client) (*multiChannel, error) {
	cmd, err := remoteCommand(c.cfg.Session, "api-bridge", "--multi")
	if err != nil {
		return nil, err
	}
	sess, err := c.newSession(ctx)
	if err != nil {
		return nil, err
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		sess.Close()
		return nil, err
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		sess.Close()
		return nil, err
	}
	m := &multiChannel{
		sess: sess, stdin: stdin, stderr: &tailBuffer{},
		inFlight: make(chan struct{}, maxMultiInFlight), dead: make(chan struct{}),
		retiredC: make(chan struct{}), abandonGrace: abandonGrace,
		pending: map[string]chan reply{}, abandoned: map[string]bool{},
	}
	sess.Stderr = m.stderr
	if err := sess.Start(cmd); err != nil {
		sess.Close()
		return nil, err
	}
	go m.readLoop(bufio.NewReaderSize(stdout, 64<<10))

	// The opening ping shows the channel answers: a herdr that advertises
	// api_bridge_multi may still find an older herdr binary first on PATH.
	pctx, cancel := context.WithTimeout(ctx, openPingTimeout)
	defer cancel()
	id := c.nextID("ping")
	line, _ := EncodeRequest(id, "ping", nil)
	if _, err := m.do(pctx, id, line); err != nil {
		m.close()
		return nil, fmt.Errorf("herdr api-bridge --multi did not answer: %w", err)
	}
	return m, nil
}

func (m *multiChannel) readLoop(r *bufio.Reader) {
	for {
		line, err := readLine(r)
		if err != nil {
			if errors.Is(err, io.EOF) {
				waitErr := m.sess.Wait()
				if waitErr == nil && m.stderr.String() == "" {
					err = errChannelClosed
				} else {
					err = classifyExit(m.stderr.String(), waitErr)
				}
			}
			m.fail(err)
			return
		}
		var head struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(line, &head) != nil || head.ID == "" {
			continue // a line not tied to a request; nothing waits for it
		}
		m.mu.Lock()
		ch, ok := m.pending[head.ID]
		delete(m.pending, head.ID)
		abandoned := m.abandoned[head.ID]
		delete(m.abandoned, head.ID)
		drained := m.drainedLocked()
		m.mu.Unlock()
		if ok || abandoned {
			<-m.inFlight
		}
		if ok {
			ch <- reply{line: line}
		}
		if drained {
			m.close()
		}
	}
}

// do sends one request and waits for its reply. It waits for a free slot
// when maxMultiInFlight requests are outstanding, and returns errNotSent
// when the channel ends before the request is written.
func (m *multiChannel) do(ctx context.Context, id string, line []byte) ([]byte, error) {
	select {
	case m.inFlight <- struct{}{}:
	case <-m.dead:
		return nil, errNotSent
	case <-m.retiredC:
		return nil, errNotSent
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	ch := make(chan reply, 1)
	m.mu.Lock()
	if m.err != nil {
		m.mu.Unlock()
		return nil, errNotSent
	}
	if m.retired {
		m.mu.Unlock()
		<-m.inFlight
		return nil, errNotSent
	}
	if _, dup := m.pending[id]; dup {
		m.mu.Unlock()
		<-m.inFlight
		return nil, fmt.Errorf("duplicate request id %q", id)
	}
	m.pending[id] = ch
	m.mu.Unlock()

	m.wmu.Lock()
	n, err := m.stdin.Write(append(line, '\n'))
	m.wmu.Unlock()
	if err != nil {
		if n == 0 {
			m.withdraw(id)
			return nil, errNotSent
		}
		// The remote process is gone. The read loop is about to fail every
		// pending request with the reason it exited, which says more than
		// this write error; wait for it.
		select {
		case r := <-ch:
			return r.line, r.err
		case <-ctx.Done():
			m.abandon(id)
			return nil, err
		}
	}
	select {
	case r := <-ch:
		return r.line, r.err
	case <-ctx.Done():
		m.abandon(id)
		return nil, ctx.Err()
	}
}

// withdraw removes a request that was never written, returning its slot.
func (m *multiChannel) withdraw(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.pending[id]; ok && m.err == nil {
		delete(m.pending, id)
		<-m.inFlight
	}
}

// abandon stops waiting for a request. herdr still answers it, and its
// slot returns then. A herdr that never answers would keep the slot
// forever, so the channel is retired when the request is still unanswered
// after abandonGrace, or at once when abandoned requests hold every slot.
func (m *multiChannel) abandon(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.pending[id]; !ok {
		return
	}
	delete(m.pending, id)
	if m.err != nil {
		return
	}
	if m.drainedLocked() {
		go m.close()
		return
	}
	m.abandoned[id] = true
	if len(m.abandoned) >= maxMultiInFlight {
		m.retireLocked()
		return
	}
	time.AfterFunc(m.abandonGrace, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.abandoned[id] {
			m.retireLocked()
		}
	})
}

// retireLocked stops the channel taking new requests, so the pool opens a
// fresh one. Requests still waiting on it keep waiting for their replies;
// the process is closed once none is left. m.mu must be held.
func (m *multiChannel) retireLocked() {
	if m.retired || m.err != nil {
		return
	}
	m.retired = true
	close(m.retiredC)
	if len(m.pending) == 0 {
		go m.close()
	}
}

// drainedLocked reports whether a retired channel has no request left
// waiting, so it can close. m.mu must be held.
func (m *multiChannel) drainedLocked() bool {
	return m.retired && m.err == nil && len(m.pending) == 0
}

// fail closes the channel for new requests and fails every waiting one.
func (m *multiChannel) fail(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.err != nil {
		return
	}
	m.err = err
	close(m.dead)
	for id, ch := range m.pending {
		ch <- reply{err: err}
		delete(m.pending, id)
	}
	clear(m.abandoned)
}

// alive reports whether the channel takes new requests.
func (m *multiChannel) alive() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.err == nil && !m.retired
}

func (m *multiChannel) close() {
	m.fail(errChannelClosed)
	m.sess.Close()
}
