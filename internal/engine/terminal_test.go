package engine_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// A bracketed write goes out only on a ping that advertises
// pane_send_text_bracketed (issue #392): a failed probe and a host without
// the flag are told apart, and neither sends anything.
func TestBracketedWriteNeedsTheAdvertisedCapability(t *testing.T) {
	writes := &fakeherdr.PaneWrites{}
	ok := func(string, json.RawMessage) (any, *fakeherdr.APIError) { return map[string]string{"type": "ok"}, nil }
	h, c := start(t, map[string]bool{"events_v2": true, "api_bridge_multi": true}, writes.Serve(ok), nil)
	h.pingErr.Store(true)
	err := c.PaneSendBracketedText(ctx(t), "w1:p1", "a\nb")
	var probe *engine.ErrProbeFailed
	if !errors.As(err, &probe) || probe.Capability != herdrapi.CapabilityPaneSendTextBracketed || errors.Is(err, engine.ErrBracketedUnsupported) {
		t.Fatalf("with the probe failing: %v, want ErrProbeFailed", err)
	}
	h.pingErr.Store(false)
	if err := c.PaneSendBracketedText(ctx(t), "w1:p1", "a\nb"); !errors.Is(err, engine.ErrBracketedUnsupported) {
		t.Fatalf("without the capability: %v, want ErrBracketedUnsupported", err)
	}
	if got := writes.Writes(); len(got) != 0 {
		t.Fatalf("a bracketed write went out without the capability: %+v", got)
	}
	_, c = start(t, map[string]bool{"pane_send_text_bracketed": true, "api_bridge_multi": true}, writes.Serve(ok), nil)
	if err := c.PaneSendBracketedText(ctx(t), "w1:p1", "a\nb"); err != nil {
		t.Fatal(err)
	}
	if got := writes.Writes(); len(got) != 1 || got[0] != (fakeherdr.PaneWrite{Pane: "w1:p1", Text: "a\nb", Bracketed: true}) {
		t.Fatalf("writes %+v, want one bracketed write", got)
	}
}

// switchableHerdr is a fake herdr whose ping advertises api_bridge_multi,
// and pane_send_text_bracketed while bracketed is set: a herdr that can be
// rolled back to a build without it.
func switchableHerdr(t *testing.T, writes *fakeherdr.PaneWrites) (*herdr, *engine.Client, *atomic.Bool) {
	t.Helper()
	var bracketed atomic.Bool
	bracketed.Store(true)
	ok := func(string, json.RawMessage) (any, *fakeherdr.APIError) { return map[string]string{"type": "ok"}, nil }
	h, c := start(t, map[string]bool{"api_bridge_multi": true}, writes.Serve(ok), func(s *fakeherdr.Server) {
		inner := s.Handle
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "ping" {
				return map[string]any{"type": "pong", "version": "0.9.5", "protocol": 22, "capabilities": map[string]bool{
					"api_bridge_multi": true, "pane_send_text_bracketed": bracketed.Load()}}, nil
			}
			return inner(method, params)
		}
	})
	return h, c, &bracketed
}

// #476: a bracketed write is checked against the herdr that takes it, not
// a cached pong. The first goes on a herdr with the capability. herdr is
// then rolled back (its bridge channel ends, and the next one serves a
// build without the capability): the second write pings that one and is
// refused, nothing written.
func TestABracketedWriteChecksTheHerdrThatTakesIt(t *testing.T) {
	writes := &fakeherdr.PaneWrites{}
	h, c, bracketed := switchableHerdr(t, writes)
	if err := c.PaneSendBracketedText(ctx(t), "w1:p1", "a\nb"); err != nil {
		t.Fatal(err)
	}
	bracketed.Store(false)
	h.srv.EndMultiChannels()
	if err := c.PaneSendBracketedText(ctx(t), "w1:p1", "c\nd"); !errors.Is(err, engine.ErrBracketedUnsupported) {
		t.Fatalf("the write to the rolled-back herdr: %v, want ErrBracketedUnsupported", err)
	}
	if got := writes.Writes(); len(got) != 1 || got[0].Text != "a\nb" {
		t.Fatalf("writes %+v, want only the first", got)
	}
}

// channelEndsAfterPing is a transport whose held channel answers a ping
// advertising pane_send_text_bracketed and then ends: every later request
// on it is unsent (bridge.ErrNotSent). Requests sent any other way are
// recorded in elsewhere.
type channelEndsAfterPing struct {
	engine.Transport
	mu        sync.Mutex
	elsewhere []string
}

func (e *channelEndsAfterPing) Call(_ context.Context, method string, _, _ any) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.elsewhere = append(e.elsewhere, method)
	return nil
}

func (e *channelEndsAfterPing) OnOneChannel(_ context.Context, work func(call engine.CallFunc) error) error {
	answered := false
	return work(func(_ context.Context, method string, _, result any) error {
		if answered {
			return fmt.Errorf("%s: %w", method, bridge.ErrNotSent)
		}
		answered = true
		return json.Unmarshal([]byte(`{"type":"pong","version":"0.9.5","protocol":22,"capabilities":{"pane_send_text_bracketed":true}}`), result)
	})
}

// #476: a held channel that ends between its pong and the write sends the
// write nowhere else (another channel may reach another herdr): it is
// refused unchecked, nothing written.
func TestABracketedWriteWhoseChannelEndsAfterItsPingIsNotSent(t *testing.T) {
	tr := &channelEndsAfterPing{}
	err := engine.New(tr).PaneSendBracketedText(ctx(t), "w1:p1", "a\nb")
	var probe *engine.ErrProbeFailed
	if !errors.As(err, &probe) {
		t.Fatalf("%v, want ErrProbeFailed", err)
	}
	if len(tr.elsewhere) != 0 {
		t.Fatalf("sent elsewhere: %v, want nothing", tr.elsewhere)
	}
}

// #476: a bracketed write's ping and the write itself go on one --multi
// channel, back to back, and the write is bracketed.
func TestABracketedWritePingsOnItsOwnChannel(t *testing.T) {
	writes := &fakeherdr.PaneWrites{}
	h, c, _ := switchableHerdr(t, writes)
	for _, text := range []string{"a\nb", "c\nd"} {
		if err := c.PaneSendBracketedText(ctx(t), "w1:p1", text); err != nil {
			t.Fatal(err)
		}
	}
	if got := writes.Writes(); len(got) != 2 || !got[0].Bracketed || !got[1].Bracketed {
		t.Fatalf("writes %+v, want two bracketed writes", got)
	}
	var multi []fakeherdr.Request
	for _, r := range h.srv.Requests() {
		if r.Multi {
			multi = append(multi, r)
		}
	}
	// The channel's opening ping, then a ping and its write for each.
	want := []string{"ping", "ping", "pane.send_text", "ping", "pane.send_text"}
	if len(multi) != len(want) {
		t.Fatalf("on --multi %+v, want %v", multi, want)
	}
	for i, r := range multi {
		if r.Method != want[i] || r.Channel != multi[0].Channel {
			t.Fatalf("on --multi %+v, want %v on one channel", multi, want)
		}
	}
}

func TestTerminalInputPreservesUnicodeAndNeverReplaysLostAck(t *testing.T) {
	var mu sync.Mutex
	var received strings.Builder
	var fallback int
	_, client := start(t, map[string]bool{"pane_input_stream": true}, func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
		if method == "pane.send_text" {
			mu.Lock()
			fallback++
			mu.Unlock()
			return map[string]string{"type": "ok"}, nil
		}
		return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
	}, func(s *fakeherdr.Server) {
		s.Duplex = func(_ context.Context, id, method string, _ json.RawMessage, read func() ([]byte, error), emit func([]byte) error) {
			b, _ := json.Marshal(map[string]any{"id": id, "result": map[string]string{"type": "ok"}})
			_ = emit(b)
			for {
				line, err := read()
				if err != nil {
					return
				}
				var frame struct {
					Seq  uint64 `json:"seq"`
					Text string `json:"text"`
				}
				if json.Unmarshal(line, &frame) != nil {
					return
				}
				mu.Lock()
				received.WriteString(frame.Text)
				mu.Unlock()
				if frame.Text == "\r" {
					return
				} // delivered, but the connection lost its acknowledgement
				b, _ = json.Marshal(map[string]any{"seq": frame.Seq, "ok": true})
				if emit(b) != nil {
					return
				}
			}
		}
	})
	input := client.OpenPaneInput(context.Background(), "w1:p1")
	defer input.Close()
	text := strings.Repeat("a", 8191) + "界🙂\n" + strings.Repeat("z", 9000)
	if err := input.Send(context.Background(), text); err != nil {
		t.Fatal(err)
	}
	if err := input.Send(context.Background(), "\r"); err == nil {
		t.Fatal("lost acknowledgement was treated as success")
	}
	if err := input.Send(context.Background(), "next"); err == nil {
		t.Fatal("failed input channel kept accepting keys")
	}
	mu.Lock()
	defer mu.Unlock()
	if received.String() != text+"\r" {
		t.Fatalf("delivered data changed: got %d bytes, want %d", received.Len(), len(text)+1)
	}
	if fallback != 0 {
		t.Fatalf("uncertain input replayed %d times", fallback)
	}
}

func TestFederatedTerminalUsesOrderedTextFallback(t *testing.T) {
	var delivered []string
	_, client := start(t, map[string]bool{"pane_input_stream": true}, func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
		if method != "pane.send_text" {
			return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
		}
		var p struct {
			Pane string `json:"pane_id"`
			Text string `json:"text"`
		}
		_ = json.Unmarshal(raw, &p)
		if p.Pane != "peer/w1:p1" {
			t.Errorf("wrong pane %q", p.Pane)
		}
		delivered = append(delivered, p.Text)
		return map[string]string{"type": "ok"}, nil
	}, nil)
	input := client.OpenPaneInput(context.Background(), "peer/w1:p1")
	defer input.Close()
	for _, text := range []string{"first", "\r", "second"} {
		if err := input.Send(context.Background(), text); err != nil {
			t.Fatal(err)
		}
	}
	if strings.Join(delivered, "") != "first\rsecond" {
		t.Fatalf("input out of order: %q", delivered)
	}
}
