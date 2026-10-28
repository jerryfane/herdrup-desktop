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
}

func (e *APIError) Error() string { return "herdr: " + e.Code + ": " + e.Message }

var (
	errChannelClosed = errors.New("herdr api-bridge channel closed")
	// errNoMulti means the remote herdr has no `api-bridge --multi`.
	errNoMulti = errors.New("herdr api-bridge --multi unsupported")
)

// Client is one SSH connection to a machine running herdr.
type Client struct {
	cfg  Config
	conn *ssh.Client
	seq  atomic.Uint64
	done chan struct{}

	mu      sync.Mutex
	multi   *multiChannel
	noMulti bool
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
	c := &Client{cfg: cfg, conn: ssh.NewClient(sc, chans, reqs), done: make(chan struct{})}
	go func() {
		_ = c.conn.Wait()
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
func (c *Client) keepAlive() {
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
			_, _, err := c.conn.SendRequest("keepalive@openssh.com", true, nil)
			answered <- err
		}()
		select {
		case err := <-answered:
			if err != nil {
				c.conn.Close()
				return
			}
		case <-time.After(keepAliveInterval / 2):
			c.conn.Close()
			return
		case <-c.done:
			return
		}
	}
}

// Done is closed when the SSH connection ends.
func (c *Client) Done() <-chan struct{} { return c.done }

// Close ends the connection and every channel on it.
func (c *Client) Close() error { return c.conn.Close() }

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

// Call sends one request and decodes its result into result. Requests share
// one `api-bridge --multi` channel; on a herdr without --multi each request
// gets its own exec channel.
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
	m, err := c.channel(ctx)
	var reply []byte
	switch {
	case errors.Is(err, errNoMulti):
		reply, err = c.oneShot(ctx, line)
	case err == nil:
		reply, err = m.do(ctx, id, line)
	}
	if err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	return decodeReply(reply, result)
}

// channel returns the open --multi channel, opening one if needed.
func (c *Client) channel(ctx context.Context) (*multiChannel, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.noMulti {
		return nil, errNoMulti
	}
	if c.multi != nil && c.multi.alive() {
		return c.multi, nil
	}
	m, err := openMulti(ctx, c)
	if errors.Is(err, errNoMulti) {
		c.noMulti = true
	}
	if err != nil {
		return nil, err
	}
	c.multi = m
	return m, nil
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
	sess, err := c.conn.NewSession()
	if err != nil {
		return nil, err
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		sess.Close()
		return nil, err
	}
	s := &Stream{sess: sess, r: bufio.NewReaderSize(stdout, 64<<10), stderr: &tailBuffer{}}
	sess.Stderr = s.stderr
	if err := sess.Start(cmd); err != nil {
		sess.Close()
		return nil, err
	}
	s.stop = context.AfterFunc(ctx, func() { s.Close() })
	return s, nil
}

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
		if s.stop != nil {
			s.stop()
		}
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
