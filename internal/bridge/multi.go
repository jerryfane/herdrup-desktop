package bridge

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
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

// cancelGrace is how long cancelled requests holding every slot may take to
// come back cancelled before the channel is retired.
const cancelGrace = 2 * time.Second

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
	// frames: herdr advertises api_bridge_frames, so a new channel asks for
	// framed replies (bridge.hello). The hello's own reply decides.
	frames  bool
	probing bool
	ch      *multiChannel
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
// ErrNotSent when nothing was written, and the request must take the
// per-request path.
func (c *Client) viaMulti(ctx context.Context, method, id string, line []byte) ([]byte, error) {
	if !multiRoutable(method, line) {
		return nil, ErrNotSent
	}
	p := &c.pool
	p.mu.Lock()
	s := p.slot(c.cfg.Session)
	switch s.capability {
	case capUnsupported:
		p.mu.Unlock()
		return nil, ErrNotSent
	case capUnknown:
		// A ping learns the capability from its own reply.
		if method != "ping" && !s.probing {
			s.probing = true
			go c.probeCapability()
		}
		p.mu.Unlock()
		return nil, ErrNotSent
	}
	p.mu.Unlock()
	m := c.readyChannel(ctx)
	if m == nil {
		return nil, ErrNotSent
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
				APIBridgeMulti  bool `json:"api_bridge_multi"`
				APIBridgeFrames bool `json:"api_bridge_frames"`
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
	s.frames = supported && r.Result.Capabilities.APIBridgeFrames
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
	frames := s.frames
	go func() {
		m, err := openMulti(context.Background(), c, frames)
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

// OnOneChannel runs work with call, which sends each request on one --multi
// channel of the session, the same one throughout: one `herdr api-bridge
// --multi` process, so one herdr answers every one of them, and what one
// answer says (a ping's capabilities) holds for the next. A herdr that
// restarted or was rolled back comes with another channel. The channel is
// taken first, opening it as Call would (a session whose capability is not
// yet known is pinged per-request to learn it). A request goes on that
// channel or nowhere: with no channel to be had, or once it ended before
// the request was written, call fails with an error wrapping ErrNotSent,
// and herdr does not have the request. Each call is otherwise as Call's.
func (c *Client) OnOneChannel(ctx context.Context, work func(call func(ctx context.Context, method string, params, result any) error) error) error {
	m, err := c.heldChannel(ctx)
	if err != nil {
		return err
	}
	return work(func(ctx context.Context, method string, params, result any) error {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("%s: %w", method, err)
		}
		if _, ok := ctx.Deadline(); !ok {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, defaultCallTimeout)
			defer cancel()
		}
		id := c.nextID(method)
		line, err := EncodeRequest(id, method, params)
		if err != nil {
			return err
		}
		if !multiRoutable(method, line) {
			return fmt.Errorf("%s: %w", method, ErrNotSent)
		}
		reply, err := m.do(ctx, id, line)
		if err != nil {
			return fmt.Errorf("%s: %w", method, err)
		}
		if method == "ping" {
			c.learnCapability(reply)
		}
		return DecodeReply(reply, result)
	})
}

// heldChannel is the session's open channel for OnOneChannel. A session
// whose capability is not known yet is pinged per-request first, which
// learns it and starts the open; an error wrapping ErrNotSent when there is
// still no channel.
func (c *Client) heldChannel(ctx context.Context) (*multiChannel, error) {
	if m := c.readyChannel(ctx); m != nil {
		return m, nil
	}
	p := &c.pool
	p.mu.Lock()
	unknown := p.slot(c.cfg.Session).capability == capUnknown
	p.mu.Unlock()
	if unknown {
		line, err := EncodeRequest(c.nextID("ping"), "ping", nil)
		if err != nil {
			return nil, err
		}
		if reply, err := c.oneShot(ctx, line); err == nil {
			c.learnCapability(reply)
		}
		if m := c.readyChannel(ctx); m != nil {
			return m, nil
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("no herdr api-bridge --multi channel to hold: %w", ErrNotSent)
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

	// helloID is the bridge.hello sent first on a channel that asked for
	// frames; "" when none was. cancelOK: the hello's reply said the bridge
	// takes bridge.cancel.
	helloID  string
	cancelOK atomic.Bool
	cancelID func() string

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

func openMulti(ctx context.Context, c *Client, frames bool) (*multiChannel, error) {
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
		cancelID: func() string { return c.nextID("bridge.cancel") },
	}
	if frames {
		m.helloID = c.nextID("bridge.hello")
	}
	sess.Stderr = m.stderr
	if err := sess.Start(cmd); err != nil {
		sess.Close()
		return nil, err
	}
	if m.helloID != "" {
		// The first line, so the switch to frames is exactly the end of its
		// reply line (CONTRACT-net.md §1). Its reply is not waited for: the
		// opening ping below follows it on the same channel.
		// gzip rides on frames: a bridge that takes it compresses large
		// replies (herdr #414, capability compressed_replies); one that
		// does not ignores it.
		hello, _ := EncodeRequest(m.helloID, "bridge.hello", map[string]any{"frames": true, "compress": "gzip"})
		if _, err := stdin.Write(append(hello, '\n')); err != nil {
			sess.Close()
			return nil, err
		}
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
	// frameBytes > 0 once the bridge answered bridge.hello with frames: from
	// the end of that line on, every reply comes as frames.
	frameBytes := 0
	parts := map[string][]byte{}
	// gzipped: the ids of replies whose frames are gzip (enc), until delivered.
	gzipped := map[string]bool{}
	for {
		var line []byte
		var err error
		if frameBytes == 0 {
			line, err = readLine(r)
		} else {
			line, err = readFramedReply(r, frameBytes, parts, gzipped)
		}
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
		if line == nil {
			continue // a frame of a reply not complete yet
		}
		var head struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(line, &head) != nil || head.ID == "" {
			continue // a line not tied to a request; nothing waits for it
		}
		if m.helloID != "" && head.ID == m.helloID {
			// An older bridge forwards the hello to its server, which answers
			// with an error: no frames, no cancel, keep reading lines. Only
			// this reply's result is decoded (review of #217).
			var r struct {
				Result *struct {
					Frames     bool `json:"frames"`
					FrameBytes int  `json:"frame_bytes"`
					Cancel     bool `json:"cancel"`
				} `json:"result"`
			}
			if json.Unmarshal(line, &r) == nil && r.Result != nil {
				hello := r.Result
				m.cancelOK.Store(hello.Cancel)
				if hello.Frames && hello.FrameBytes > 0 {
					frameBytes = hello.FrameBytes
				}
			}
			continue
		}
		m.deliver(head.ID, line)
	}
}

// readFramedReply reads one frame and returns the reply it completes, or nil
// when that reply has frames still to come (herdr's bridge, #407):
// a JSON header line, then exactly len bytes of that reply's line. Frames
// with "enc":"gzip" carry the gzip of the line (#414): every frame of such a
// reply says so, and the whole is gunzipped when it ends.
func readFramedReply(r *bufio.Reader, frameBytes int, parts map[string][]byte, gzipped map[string]bool) ([]byte, error) {
	header, err := readLine(r)
	if err != nil {
		return nil, err
	}
	var h struct {
		Frame *string `json:"frame"`
		Len   int     `json:"len"`
		Last  bool    `json:"last"`
		Abort bool    `json:"abort"`
		Enc   string  `json:"enc"`
	}
	if json.Unmarshal(header, &h) != nil || h.Frame == nil || h.Len < 0 || h.Len > frameBytes {
		return nil, fmt.Errorf("herdr api-bridge: bad frame header %.80q", header)
	}
	body := make([]byte, h.Len)
	if _, err := io.ReadFull(r, body); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			err = io.EOF
		}
		return nil, err
	}
	id := *h.Frame
	if h.Abort {
		// A cancel stopped this reply part-way; its cancelled error follows.
		delete(parts, id)
		delete(gzipped, id)
		return nil, nil
	}
	switch h.Enc {
	case "":
	case "gzip":
		gzipped[id] = true
	default:
		return nil, fmt.Errorf("herdr api-bridge: unknown frame encoding %q", h.Enc)
	}
	buf := append(parts[id], body...)
	if len(buf) > MaxReplyLineBytes {
		return nil, fmt.Errorf("herdr reply over %d bytes", MaxReplyLineBytes)
	}
	if !h.Last {
		parts[id] = buf
		return nil, nil
	}
	delete(parts, id)
	if gzipped[id] {
		delete(gzipped, id)
		return gunzipReply(buf)
	}
	return buf, nil
}

// gunzipReply is a gzipped reply's line, held to MaxReplyLineBytes. Its
// errors never wrap io.EOF: an empty or cut gzip body is herdr sending a bad
// reply, not the channel closing (review of #219).
func gunzipReply(b []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("herdr api-bridge: bad gzip reply: %v", err)
	}
	line, err := io.ReadAll(io.LimitReader(zr, MaxReplyLineBytes+1))
	if err == nil {
		err = zr.Close()
	}
	if err != nil {
		return nil, fmt.Errorf("herdr api-bridge: bad gzip reply: %v", err)
	}
	if len(line) > MaxReplyLineBytes {
		return nil, fmt.Errorf("herdr reply over %d bytes", MaxReplyLineBytes)
	}
	return line, nil
}

// deliver hands a complete reply to the request waiting for it, and returns
// its slot.
func (m *multiChannel) deliver(id string, line []byte) {
	m.mu.Lock()
	ch, ok := m.pending[id]
	delete(m.pending, id)
	abandoned := m.abandoned[id]
	delete(m.abandoned, id)
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

// do sends one request and waits for its reply. It waits for a free slot
// when maxMultiInFlight requests are outstanding, and returns ErrNotSent
// when the channel ends before the request is written.
func (m *multiChannel) do(ctx context.Context, id string, line []byte) ([]byte, error) {
	select {
	case m.inFlight <- struct{}{}:
	case <-m.dead:
		return nil, ErrNotSent
	case <-m.retiredC:
		return nil, ErrNotSent
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	ch := make(chan reply, 1)
	m.mu.Lock()
	if m.err != nil {
		m.mu.Unlock()
		return nil, ErrNotSent
	}
	if m.retired {
		m.mu.Unlock()
		<-m.inFlight
		return nil, ErrNotSent
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
			return nil, ErrNotSent
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
	if m.cancelOK.Load() {
		// herdr stops the work and answers it cancelled, which returns its
		// slot at once rather than when the work would have finished.
		go m.cancel(id)
	}
	if len(m.abandoned) >= maxMultiInFlight {
		if !m.cancelOK.Load() {
			m.retireLocked()
			return
		}
		// The cancels should return these slots at once; a bridge that does
		// not answer them leaves every slot taken, so retire after all.
		time.AfterFunc(cancelGrace, func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			if len(m.abandoned) >= maxMultiInFlight {
				m.retireLocked()
			}
		})
	}
	time.AfterFunc(m.abandonGrace, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.abandoned[id] {
			m.retireLocked()
		}
	})
}

// cancel asks the bridge to stop request id (bridge.cancel). Its own reply
// is not waited for; the cancelled request's reply returns the slot.
func (m *multiChannel) cancel(id string) {
	line, _ := EncodeRequest(m.cancelID(), "bridge.cancel", map[string]string{"id": id})
	m.wmu.Lock()
	defer m.wmu.Unlock()
	_, _ = m.stdin.Write(append(line, '\n'))
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
