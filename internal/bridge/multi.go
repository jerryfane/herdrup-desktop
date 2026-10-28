package bridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"

	"golang.org/x/crypto/ssh"
)

// multiChannel is one `herdr api-bridge --multi` process. Requests are
// written one per line; replies may come back in any order and are matched
// by id.
type multiChannel struct {
	sess   *ssh.Session
	stdin  io.WriteCloser
	stderr *tailBuffer

	wmu sync.Mutex // serialises writes to stdin

	mu      sync.Mutex
	pending map[string]chan reply
	err     error // set once the channel is closed
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
	sess, err := c.conn.NewSession()
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
	m := &multiChannel{sess: sess, stdin: stdin, stderr: &tailBuffer{}, pending: map[string]chan reply{}}
	sess.Stderr = m.stderr
	if err := sess.Start(cmd); err != nil {
		sess.Close()
		return nil, err
	}
	go m.readLoop(bufio.NewReaderSize(stdout, 64<<10))

	pctx, cancel := context.WithTimeout(ctx, openPingTimeout)
	defer cancel()
	id := c.nextID("ping")
	line, _ := encodeRequest(id, "ping", nil)
	if _, err := m.do(pctx, id, line); err != nil {
		m.close()
		var exit *ssh.ExitError
		switch {
		case errors.Is(err, ErrHerdrNotInstalled), errors.Is(err, ErrHerdrIncompatible):
			return nil, err
		case errors.Is(err, context.DeadlineExceeded):
			return nil, fmt.Errorf("herdr api-bridge --multi did not answer: %w", err)
		case errors.As(err, &exit):
			// The process exited before answering: a herdr that predates
			// --multi reads it as an encoded request and fails.
			return nil, fmt.Errorf("%w (%v)", errNoMulti, err)
		}
		return nil, err
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
		m.mu.Unlock()
		if ok {
			ch <- reply{line: line}
		}
	}
}

func (m *multiChannel) do(ctx context.Context, id string, line []byte) ([]byte, error) {
	ch := make(chan reply, 1)
	m.mu.Lock()
	if m.err != nil {
		err := m.err
		m.mu.Unlock()
		return nil, err
	}
	if _, dup := m.pending[id]; dup {
		m.mu.Unlock()
		return nil, fmt.Errorf("duplicate request id %q", id)
	}
	m.pending[id] = ch
	m.mu.Unlock()

	m.wmu.Lock()
	_, err := m.stdin.Write(append(line, '\n'))
	m.wmu.Unlock()
	if err != nil {
		// The remote process is gone. The read loop is about to fail every
		// pending request with the reason it exited, which says more than
		// this write error; wait for it.
		select {
		case r := <-ch:
			return r.line, r.err
		case <-ctx.Done():
			m.forget(id)
			return nil, err
		}
	}
	select {
	case r := <-ch:
		return r.line, r.err
	case <-ctx.Done():
		m.forget(id)
		return nil, ctx.Err()
	}
}

func (m *multiChannel) forget(id string) {
	m.mu.Lock()
	delete(m.pending, id)
	m.mu.Unlock()
}

// fail closes the channel for new requests and fails every waiting one.
func (m *multiChannel) fail(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.err != nil {
		return
	}
	m.err = err
	for id, ch := range m.pending {
		ch <- reply{err: err}
		delete(m.pending, id)
	}
}

func (m *multiChannel) alive() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.err == nil
}

func (m *multiChannel) close() {
	m.fail(errChannelClosed)
	m.sess.Close()
}
