package bridge

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"
)

const (
	defaultConnectTimeout = 15 * time.Second
	defaultCallTimeout    = 60 * time.Second
	// openPingTimeout bounds the opening ping of a --multi channel. A herdr
	// without --multi exits instead of answering.
	openPingTimeout   = 10 * time.Second
	keepAliveInterval = 30 * time.Second
	// maxLineBytes bounds one reply line. agent.list on a busy machine runs
	// to megabytes; anything near this is a broken stream.
	maxLineBytes = 64 << 20
	// maxArgRequestBytes keeps a base64 request under Linux's 128 KiB limit
	// for one argument.
	maxArgRequestBytes = 90 << 10
)

// Config describes one machine and how to log in to it.
type Config struct {
	Host string
	Port int // 22 when zero
	User string
	// KeyPEM is an OpenSSH or PEM private key. Passphrase unlocks it when
	// it is encrypted.
	KeyPEM     []byte
	Passphrase []byte
	// Password is used when KeyPEM is empty.
	Password string
	// Session is the herdr session name; empty or "default" selects the
	// default session.
	Session string
	// Pins stores host key fingerprints. Required.
	Pins PinStore
	// ConnectTimeout bounds the TCP connect and SSH handshake (15 s when
	// zero).
	ConnectTimeout time.Duration
}

// APIError is an error reply from herdr.
type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	// Raw is the whole error object as herdr sent it, for the fields some
	// errors add beyond code and message (agent.groups.set's
	// groups_conflict carries "current").
	Raw json.RawMessage `json:"-"`
}

func (e *APIError) Error() string { return "herdr: " + e.Code + ": " + e.Message }

// UnmarshalJSON decodes code and message and keeps the object in Raw.
func (e *APIError) UnmarshalJSON(b []byte) error {
	type plain APIError
	if err := json.Unmarshal(b, (*plain)(e)); err != nil {
		return err
	}
	e.Raw = append(json.RawMessage(nil), b...)
	return nil
}

var (
	errChannelClosed = errors.New("herdr api-bridge channel closed")
	// errNotSent means a request was not written to the --multi channel, so
	// it may safely go down the per-request path instead.
	errNotSent = errors.New("herdr api-bridge --multi channel unavailable")
)

// Client is a view of one SSH connection to a machine running herdr,
// addressing one herdr session. ForSession makes views of other sessions
// that share the connection.
type Client struct {
	cfg Config
	*conn
}

// conn is the state every session view of one SSH connection shares.
type conn struct {
	ssh  *ssh.Client
	seq  atomic.Uint64
	done chan struct{}
	pool pool
}

// Dial connects and authenticates. The host key is pinned on first contact
// and must match afterwards.
func Dial(ctx context.Context, cfg Config) (*Client, error) {
	if cfg.Pins == nil {
		return nil, errors.New("bridge: Config.Pins is required")
	}
	if !ValidSession(cfg.Session) {
		return nil, fmt.Errorf("invalid herdr session name %q", cfg.Session)
	}
	auth, err := authMethods(cfg)
	if err != nil {
		return nil, err
	}
	port := cfg.Port
	if port == 0 {
		port = 22
	}
	timeout := cfg.ConnectTimeout
	if timeout == 0 {
		timeout = defaultConnectTimeout
	}
	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(port))
	dctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var d net.Dialer
	tcp, err := d.DialContext(dctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	deadline, _ := dctx.Deadline()
	_ = tcp.SetDeadline(deadline)
	sc, chans, reqs, err := ssh.NewClientConn(tcp, addr, &ssh.ClientConfig{
		User:            cfg.User,
		Auth:            auth,
		HostKeyCallback: pinningCallback(cfg.Pins),
	})
	if err != nil {
		tcp.Close()
		return nil, err
	}
	_ = tcp.SetDeadline(time.Time{})
	c := &Client{cfg: cfg, conn: &conn{
		ssh:  ssh.NewClient(sc, chans, reqs),
		done: make(chan struct{}),
		pool: pool{openRetryAfter: defaultOpenRetryAfter},
	}}
	go func() {
		_ = c.ssh.Wait()
		close(c.done)
	}()
	go c.keepAlive()
	return c, nil
}

func authMethods(cfg Config) ([]ssh.AuthMethod, error) {
	if len(cfg.KeyPEM) > 0 {
		var signer ssh.Signer
		var err error
		if len(cfg.Passphrase) > 0 {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(cfg.KeyPEM, cfg.Passphrase)
		} else {
			signer, err = ssh.ParsePrivateKey(cfg.KeyPEM)
		}
		if err != nil {
			return nil, fmt.Errorf("read private key: %w", err)
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	}
	if cfg.Password != "" {
		pw := cfg.Password
		return []ssh.AuthMethod{
			ssh.Password(pw),
			ssh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
				answers := make([]string, len(questions))
				for i := range answers {
					answers[i] = pw
				}
				return answers, nil
			}),
		}, nil
	}
	return nil, errors.New("bridge: a private key or a password is required")
}

// keepAlive closes the connection when the server stops answering, so a
// dead network shows up instead of hanging.
func (c *conn) keepAlive() {
	t := time.NewTicker(keepAliveInterval)
	defer t.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-t.C:
		}
		answered := make(chan error, 1)
		go func() {
			_, _, err := c.ssh.SendRequest("keepalive@openssh.com", true, nil)
			answered <- err
		}()
		select {
		case err := <-answered:
			if err != nil {
				c.ssh.Close()
				return
			}
		case <-time.After(keepAliveInterval / 2):
			c.ssh.Close()
			return
		case <-c.done:
			return
		}
	}
}

// Done is closed when the SSH connection ends.
func (c *Client) Done() <-chan struct{} { return c.done }

// Close ends the connection and every channel on it, for every session
// view of it.
func (c *Client) Close() error { return c.ssh.Close() }

// Session returns the herdr session this client addresses; "" is the
// default session.
func (c *Client) Session() string { return c.cfg.Session }

// ForSession returns a client for another herdr session on the same
// machine. It shares this client's SSH connection, so switching costs no
// handshake, but it can only ever address its own session. Closing either
// closes the shared connection.
func (c *Client) ForSession(session string) (*Client, error) {
	if !ValidSession(session) {
		return nil, fmt.Errorf("invalid herdr session name %q", session)
	}
	cfg := c.cfg
	cfg.Session = session
	return &Client{cfg: cfg, conn: c.conn}, nil
}

func (c *Client) nextID(method string) string {
	return "herdrup:" + method + ":" + strconv.FormatUint(c.seq.Add(1), 10)
}

func encodeRequest(id, method string, params any) ([]byte, error) {
	if params == nil {
		params = struct{}{}
	}
	return json.Marshal(struct {
		ID     string `json:"id"`
		Method string `json:"method"`
		Params any    `json:"params"`
	}{id, method, params})
}

type replyLine struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *APIError       `json:"error"`
}

func decodeReply(line []byte, result any) error {
	var r replyLine
	if err := json.Unmarshal(line, &r); err != nil {
		return fmt.Errorf("decode herdr reply: %w", err)
	}
	if r.Error != nil {
		return r.Error
	}
	if result == nil {
		return nil
	}
	if err := json.Unmarshal(r.Result, result); err != nil {
		return fmt.Errorf("decode herdr result: %w", err)
	}
	return nil
}

// Call sends one request and decodes its result into result.
//
// On a herdr that advertises api_bridge_multi, requests share one
// `api-bridge --multi` channel per session. Otherwise, while that is not
// yet known, when the channel cannot open, and for requests --multi cannot
// carry, each request gets its own exec channel. A request never fails only
// because the --multi channel is unavailable.
func (c *Client) Call(ctx context.Context, method string, params, result any) error {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, defaultCallTimeout)
		defer cancel()
	}
	id := c.nextID(method)
	line, err := encodeRequest(id, method, params)
	if err != nil {
		return err
	}
	reply, err := c.viaMulti(ctx, method, id, line)
	if errors.Is(err, errNotSent) {
		reply, err = c.oneShot(ctx, line)
	}
	if err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	if method == "ping" {
		c.learnCapability(reply)
	}
	return decodeReply(reply, result)
}

func (c *Client) oneShot(ctx context.Context, line []byte) ([]byte, error) {
	s, err := c.openStream(ctx, line)
	if err != nil {
		return nil, err
	}
	defer s.Close()
	return s.Next()
}

// Stream is a long-lived request, such as events.subscribe, on its own exec
// channel. Every line herdr writes is returned by Next.
type Stream struct {
	sess   *ssh.Session
	r      *bufio.Reader
	stderr *tailBuffer
	stop   func() bool
	once   sync.Once
}

// OpenStream starts a streaming request. The stream closes when ctx ends.
func (c *Client) OpenStream(ctx context.Context, method string, params any) (*Stream, error) {
	line, err := encodeRequest(c.nextID(method), method, params)
	if err != nil {
		return nil, err
	}
	return c.openStream(ctx, line)
}

func (c *Client) openStream(ctx context.Context, line []byte) (*Stream, error) {
	if len(line) > maxArgRequestBytes {
		return nil, fmt.Errorf("request of %d bytes is too large for an exec argument", len(line))
	}
	cmd, err := remoteCommand(c.cfg.Session, "api-bridge", base64.StdEncoding.EncodeToString(line))
	if err != nil {
		return nil, err
	}
	s, _, err := c.start(ctx, cmd, false)
	return s, err
}

// start runs cmd on a new exec channel, with a stdin pipe when stdin is
// set. The channel closes when ctx ends.
func (c *Client) start(ctx context.Context, cmd string, stdin bool) (*Stream, io.WriteCloser, error) {
	sess, err := c.ssh.NewSession()
	if err != nil {
		return nil, nil, err
	}
	var in io.WriteCloser
	if stdin {
		if in, err = sess.StdinPipe(); err != nil {
			sess.Close()
			return nil, nil, err
		}
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		sess.Close()
		return nil, nil, err
	}
	s := &Stream{sess: sess, r: bufio.NewReaderSize(stdout, 64<<10), stderr: &tailBuffer{}}
	sess.Stderr = s.stderr
	if err := sess.Start(cmd); err != nil {
		sess.Close()
		return nil, nil, err
	}
	// The callback may run at once on another goroutine, so it must not
	// read s.stop, which is assigned here.
	s.stop = context.AfterFunc(ctx, func() { sess.Close() })
	return s, in, nil
}

// Duplex is a two-way channel to the herdr API socket, `herdr
// remote-api-bridge`: what is written goes to the socket as is, and every
// line herdr writes back comes from Next. A streaming method that reads
// from the client after its acknowledgement, such as gram.upload.stream,
// needs one; api-bridge only forwards the one request.
type Duplex struct {
	*Stream
	in io.WriteCloser
}

// OpenDuplex starts a duplex channel. The caller writes the request line
// first. It closes when ctx ends.
func (c *Client) OpenDuplex(ctx context.Context) (*Duplex, error) {
	cmd, err := remoteCommand(c.cfg.Session, "remote-api-bridge")
	if err != nil {
		return nil, err
	}
	s, in, err := c.start(ctx, cmd, true)
	if err != nil {
		return nil, err
	}
	return &Duplex{Stream: s, in: in}, nil
}

// WriteLine writes line and a newline.
func (d *Duplex) WriteLine(line []byte) error {
	_, err := d.in.Write(append(line[:len(line):len(line)], '\n'))
	return err
}

// CloseWrite ends what the client sends; herdr sees end of file, and Next
// still returns what it writes after that.
func (d *Duplex) CloseWrite() error { return d.in.Close() }

// Next returns the next line. When the remote command ends it returns the
// classified exit error, or io.EOF after a clean exit.
func (s *Stream) Next() ([]byte, error) {
	line, err := readLine(s.r)
	if err == nil {
		return line, nil
	}
	if !errors.Is(err, io.EOF) {
		return nil, err
	}
	waitErr := s.sess.Wait()
	if waitErr == nil && s.stderr.String() == "" {
		return nil, io.EOF
	}
	return nil, classifyExit(s.stderr.String(), waitErr)
}

// Close ends the stream.
func (s *Stream) Close() error {
	s.once.Do(func() {
		s.stop()
		s.sess.Close()
	})
	return nil
}

// readLine reads one newline-terminated line without its terminator.
func readLine(r *bufio.Reader) ([]byte, error) {
	var buf []byte
	for {
		chunk, err := r.ReadSlice('\n')
		buf = append(buf, chunk...)
		if len(buf) > maxLineBytes {
			return nil, fmt.Errorf("herdr reply line over %d bytes", maxLineBytes)
		}
		switch {
		case err == nil:
			return buf[:len(buf)-1], nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF) && len(buf) > 0:
			return buf, nil
		default:
			return nil, err
		}
	}
}

// tailBuffer keeps the last few KiB written to it.
type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
}

const tailBytes = 8 << 10

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > tailBytes {
		t.buf = append(t.buf[:0], t.buf[len(t.buf)-tailBytes:]...)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}
