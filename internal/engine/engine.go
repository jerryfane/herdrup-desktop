// Package engine is the typed herdr API client: one method per herdr
// method, with herdrapi's generated params and results, on top of a
// Transport (internal/bridge over SSH, or a test double).
//
// Every method looks up its entry in herdrapi.Methods and
//
//   - refuses with *ErrUnsupported, before sending, when the method's
//     capability is known to be missing (a ping answered without it);
//   - turns the answer of a herdr that predates the method (unknown_method,
//     or invalid_request naming an "unknown variant") into *ErrUnsupported
//     too;
//   - decodes the reply as a herdrapi.ResponseResult and fails with
//     *ResultTagError when its "type" is not one the table lists.
//
// Capabilities come from ping and are cached the way herdrup's HerdrClient
// caches them: unknown until a ping answers, then probed. A failed probe
// leaves the cache unknown, so a transient error never pins a client to
// "unsupported", and an unknown capability does not stop a call.
package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// Transport carries requests to one herdr session.
type Transport interface {
	// Call sends one request and decodes its result into result. An error
	// reply is a *bridge.APIError.
	Call(ctx context.Context, method string, params, result any) error
	// OpenStream sends a streaming request on its own channel; the channel
	// closes when ctx ends.
	OpenStream(ctx context.Context, method string, params any) (Stream, error)
	// Done is closed when the connection ends.
	Done() <-chan struct{}
}

// Stream is one open streaming request.
type Stream interface {
	// Next returns the next line herdr wrote, or io.EOF after a clean end.
	Next() ([]byte, error)
	Close() error
}

// Duplexer is a Transport that can also open a two-way channel, which
// gram.upload.stream needs. Without it uploads go chunk by chunk.
type Duplexer interface {
	OpenDuplex(ctx context.Context) (Duplex, error)
}

// Duplex is a two-way channel to herdr's API socket: the first line written
// is a request, and what follows is up to the method.
type Duplex interface {
	Stream
	WriteLine(line []byte) error
	// CloseWrite ends what the client sends; Next still reads.
	CloseWrite() error
}

// Bridge adapts a bridge.Client to Transport and Duplexer.
func Bridge(c *bridge.Client) Transport { return bridgeTransport{c} }

type bridgeTransport struct{ *bridge.Client }

func (b bridgeTransport) OpenStream(ctx context.Context, method string, params any) (Stream, error) {
	s, err := b.Client.OpenStream(ctx, method, params)
	if err != nil {
		return nil, err
	}
	return s, nil
}

func (b bridgeTransport) OpenDuplex(ctx context.Context) (Duplex, error) {
	d, err := b.Client.OpenDuplex(ctx)
	if err != nil {
		return nil, err
	}
	return d, nil
}

// Client is a typed client for one herdr session.
type Client struct {
	t Transport

	mu     sync.Mutex
	probed bool // a ping has answered; pong is its result
	pong   herdrapi.ResponseResultPong
}

// New returns a client over t.
func New(t Transport) *Client { return &Client{t: t} }

// Done is closed when the connection ends.
func (c *Client) Done() <-chan struct{} { return c.t.Done() }

// ErrDisconnected is returned when the connection to the machine ends.
var ErrDisconnected = errors.New("connection to the machine was lost")

// ErrUnsupported is returned for a method the connected herdr does not
// have: its ping does not advertise Capability, or it answered that it
// does not know Method.
type ErrUnsupported struct {
	Method string
	// Capability is the missing flag; "" when herdr refused the method
	// itself.
	Capability herdrapi.Capability
	// ServerVersion is herdr's version, "" when no ping has answered.
	ServerVersion string
}

func (e *ErrUnsupported) Error() string {
	server := "this herdr"
	if e.ServerVersion != "" {
		server = "herdr " + e.ServerVersion
	}
	if e.Capability != herdrapi.CapabilityNone {
		return fmt.Sprintf("%s does not support %s (no %s capability)", server, e.Method, e.Capability)
	}
	return fmt.Sprintf("%s does not know %s", server, e.Method)
}

// ResultTagError is a reply whose result "type" the method table does not
// list for the method.
type ResultTagError struct {
	Method string
	Got    string // "" when the reply had no result type
	Want   []string
}

func (e *ResultTagError) Error() string {
	return fmt.Sprintf("%s: herdr answered %q, want %s", e.Method, e.Got, strings.Join(e.Want, " or "))
}

// StreamError is an error envelope herdr wrote on a stream after its
// acknowledgement, which ends the stream (a guest paused or revoked, for
// example).
type StreamError struct {
	Method string
	*bridge.APIError
}

func (e *StreamError) Error() string { return e.Method + " ended: " + e.APIError.Error() }

func (e *StreamError) Unwrap() error { return e.APIError }

// isUnknownMethod is herdrup's HerdrClient.isUnknownMethod: a herdr parses
// "method" as an enum, so one that predates a method fails with
// invalid_request naming the unknown variant, or with unknown_method.
func isUnknownMethod(e *bridge.APIError, method string) bool {
	if e.Code == "unknown_method" {
		return true
	}
	return e.Code == "invalid_request" &&
		strings.Contains(strings.ToLower(e.Message), "unknown variant") &&
		strings.Contains(e.Message, method)
}

// mapError turns an older herdr's refusal of method into *ErrUnsupported.
func (c *Client) mapError(method string, err error) error {
	var api *bridge.APIError
	if errors.As(err, &api) && isUnknownMethod(api, method) {
		return &ErrUnsupported{Method: method, ServerVersion: c.serverVersion()}
	}
	return err
}

func (c *Client) serverVersion() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pong.Version
}

// method returns the table entry for name; every name this package uses
// is in it.
func method(name string) herdrapi.Method {
	m, ok := herdrapi.MethodByName(name)
	if !ok {
		panic("engine: " + name + " is not in herdrapi.Methods")
	}
	return m
}

// supports reports whether the server advertises capability, probing with
// ping when no ping has answered yet; known is false when that probe
// failed.
func (c *Client) supports(ctx context.Context, capability herdrapi.Capability) (ok, known bool) {
	c.mu.Lock()
	probed, pong := c.probed, c.pong
	c.mu.Unlock()
	if !probed {
		var err error
		if pong, err = c.Ping(ctx); err != nil {
			return false, false
		}
	}
	return capability.Supported(pong.Capabilities), true
}

// gate refuses m when its capability is known to be missing.
func (c *Client) gate(ctx context.Context, m herdrapi.Method) error {
	if m.Capability == herdrapi.CapabilityNone {
		return nil
	}
	if ok, known := c.supports(ctx, m.Capability); known && !ok {
		return &ErrUnsupported{Method: m.Name, Capability: m.Capability, ServerVersion: c.serverVersion()}
	}
	return nil
}

// checkTag fails unless r's type is one m lists.
func checkTag(m herdrapi.Method, r herdrapi.ResponseResult) error {
	got := r.Tag()
	want := make([]string, len(m.Results))
	for i, res := range m.Results {
		want[i] = res.Tag
	}
	if got == "" || !slices.Contains(want, got) {
		return &ResultTagError{Method: m.Name, Got: got, Want: want}
	}
	return nil
}

// do sends one request and returns its checked result.
func (c *Client) do(ctx context.Context, name string, params any) (herdrapi.ResponseResultVariant, error) {
	m := method(name)
	if err := c.gate(ctx, m); err != nil {
		return nil, err
	}
	var r herdrapi.ResponseResult
	if err := c.t.Call(ctx, name, params, &r); err != nil {
		return nil, c.mapError(name, err)
	}
	if err := checkTag(m, r); err != nil {
		return nil, err
	}
	return r.Value, nil
}

// call is do for a method with one result type.
func call[R herdrapi.ResponseResultVariant](ctx context.Context, c *Client, name string, params any) (R, error) {
	var zero R
	v, err := c.do(ctx, name, params)
	if err != nil {
		return zero, err
	}
	r, ok := v.(R)
	if !ok {
		// The table lists the tag but this package expects another type.
		return zero, fmt.Errorf("engine: %s result decoded as %T, want %T", name, v, zero)
	}
	return r, nil
}

// decodeAck reads the first line of a stream: m's acknowledgement, or the
// error herdr refused it with.
func (c *Client) decodeAck(m herdrapi.Method, line []byte) (herdrapi.ResponseResultVariant, error) {
	var env struct {
		Result json.RawMessage  `json:"result"`
		Error  *bridge.APIError `json:"error"`
	}
	if err := json.Unmarshal(line, &env); err != nil {
		return nil, fmt.Errorf("%s: decode acknowledgement: %w", m.Name, err)
	}
	if env.Error != nil {
		return nil, c.mapError(m.Name, fmt.Errorf("%s: %w", m.Name, env.Error))
	}
	var r herdrapi.ResponseResult
	if len(env.Result) > 0 {
		if err := json.Unmarshal(env.Result, &r); err != nil {
			return nil, fmt.Errorf("%s: decode acknowledgement: %w", m.Name, err)
		}
	}
	if err := checkTag(m, r); err != nil {
		return nil, err
	}
	return r.Value, nil
}

// decodeStreamError returns the error envelope line holds, if it is one.
func decodeStreamError(method string, line []byte) *StreamError {
	var env struct {
		Error *bridge.APIError `json:"error"`
	}
	if json.Unmarshal(line, &env) != nil || env.Error == nil {
		return nil
	}
	return &StreamError{Method: method, APIError: env.Error}
}
