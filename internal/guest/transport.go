package guest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
)

// Transport opens a fresh authenticated Noise session for each API request.
// Closing it cancels both established streams and pending relay handshakes.
type Transport struct {
	access   Access
	identity Identity
	ctx      context.Context
	cancel   context.CancelFunc
	seq      atomic.Uint64
	mu       sync.RWMutex
	features Features
}

func NewTransport(access Access, identity Identity) *Transport {
	ctx, cancel := context.WithCancel(context.Background())
	return &Transport{access: access, identity: identity, ctx: ctx, cancel: cancel}
}
func (t *Transport) Done() <-chan struct{} { return t.ctx.Done() }
func (t *Transport) Close() error          { t.cancel(); return nil }
func (t *Transport) Features() Features    { t.mu.RLock(); defer t.mu.RUnlock(); return t.features }

func (t *Transport) Call(ctx context.Context, method string, params, result any) error {
	ctx, cancel := context.WithTimeout(ctx, roundTripLimit)
	defer cancel()
	stream, err := t.OpenStream(ctx, method, params)
	if err != nil {
		return err
	}
	defer stream.Close()
	line, err := stream.Next()
	if err != nil {
		return err
	}
	return bridge.DecodeReply(line, result)
}

func (t *Transport) OpenStream(parent context.Context, method string, params any) (engine.Stream, error) {
	ctx, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(t.ctx, cancel)
	succeeded := false
	defer func() {
		if !succeeded {
			stop()
			cancel()
		}
	}()
	if err := t.ctx.Err(); err != nil {
		return nil, err
	}
	hello, err := json.Marshal(struct {
		Version int    `json:"v"`
		GuestID string `json:"guest_id"`
	}{1, t.access.GuestID})
	if err != nil {
		return nil, err
	}
	connected, err := openSession(ctx, t.access.Endpoint, t.identity, hello)
	if err != nil {
		return nil, err
	}
	defer func() {
		if !succeeded {
			connected.close()
		}
	}()
	if connected.reply.GuestID != t.access.GuestID {
		return nil, ErrRevoked
	}
	t.mu.Lock()
	t.features = connected.reply.Features
	t.mu.Unlock()
	request, err := bridge.EncodeRequest("herdrup:guest:"+strconv.FormatUint(t.seq.Add(1), 10), method, params)
	if err != nil {
		return nil, err
	}
	if err := connected.sendLine(ctx, request); err != nil {
		return nil, err
	}
	stream := &relayStream{session: connected, ctx: ctx, cancel: cancel, stopParent: stop}
	stream.stopSocket = context.AfterFunc(ctx, connected.close)
	succeeded = true
	return stream, nil
}

type relayStream struct {
	session    *session
	ctx        context.Context
	cancel     context.CancelFunc
	stopParent func() bool
	stopSocket func() bool
	once       sync.Once
	pending    []byte
}

// Next owns its returned bytes; a following read cannot mutate them.
func (s *relayStream) Next() ([]byte, error) {
	var line []byte
	for {
		if at := bytes.IndexByte(s.pending, '\n'); at >= 0 {
			if len(line)+at > bridge.MaxReplyLineBytes {
				return nil, errors.New("Shared-machine reply exceeds the maximum line size.")
			}
			if len(line) == 0 {
				line = s.pending[:at:at]
			} else {
				line = append(line, s.pending[:at]...)
			}
			s.pending = s.pending[at+1:]
			return line, nil
		}
		if len(line)+len(s.pending) > bridge.MaxReplyLineBytes {
			return nil, errors.New("Shared-machine reply exceeds the maximum line size.")
		}
		line = append(line, s.pending...)
		s.pending = nil
		chunk, err := s.session.readChunk(s.ctx)
		if err != nil {
			if errors.Is(err, io.EOF) && len(line) > 0 {
				return nil, io.ErrUnexpectedEOF
			}
			return nil, err
		}
		s.pending = chunk
	}
}
func (s *relayStream) Close() error {
	s.once.Do(func() { s.stopParent(); s.stopSocket(); s.cancel(); s.session.close() })
	return nil
}

var _ engine.Transport = (*Transport)(nil)
