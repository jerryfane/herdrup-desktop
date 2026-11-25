package engine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

func (c *Client) PaneSendText(ctx context.Context, pane, text string) error {
	_, err := c.do(ctx, "pane.send_text", herdrapi.PaneSendTextParams{PaneID: pane, Text: text, InputSource: c.inputSource()})
	return err
}

// ErrBracketedUnsupported: the host's ping does not advertise
// pane_send_text_bracketed, so PaneSendBracketedText sent nothing.
var ErrBracketedUnsupported = errors.New("this herdr cannot write a bracketed paste (no pane_send_text_bracketed capability)")

// PaneSendBracketedText writes text as one bracketed paste (herdr #512), so
// a line break in it does not run the text before it. It sends only on
// positive evidence from the herdr the write reaches: one without
// pane_send_text_bracketed may ignore bracketed and write the text raw, and
// a cached pong may be another herdr process's (one restarted or rolled
// back since, issue #476). So the transport holds one channel (OneChannel)
// and a ping, then the write, go on it back to back; the pong is never
// taken from the cache. Without the capability it answers
// ErrBracketedUnsupported; when no channel can be held, the ping fails, or
// the channel ends before the write is sent, ErrProbeFailed. Either way
// nothing was written. herdr itself refuses with bracketed_paste_unavailable,
// writing nothing, when the pane's program has not turned bracketed paste
// on.
func (c *Client) PaneSendBracketedText(ctx context.Context, pane, text string) error {
	unchecked := func(err error) error {
		return &ErrProbeFailed{Capability: herdrapi.CapabilityPaneSendTextBracketed, Err: err}
	}
	one, ok := c.t.(OneChannel)
	if !ok {
		return unchecked(errors.New("this connection can't hold one channel to herdr"))
	}
	sent := false // the write went out on the held channel
	err := one.OnOneChannel(ctx, func(h Held) error {
		// The ping is the one request that may move to a fresh channel
		// (Held.Ping); the write goes at most once.
		pong, err := c.pingWith(ctx, func(ctx context.Context, _ string, _, result any) error { return h.Ping(ctx, result) })
		if err != nil {
			return err
		}
		if !herdrapi.CapabilityPaneSendTextBracketed.Supported(pong.Capabilities) {
			return ErrBracketedUnsupported
		}
		bracketed := true
		_, _, err = c.callWith(ctx, h.Call, "pane.send_text", herdrapi.PaneSendTextParams{PaneID: pane, Text: text, Bracketed: &bracketed, InputSource: c.inputSource()})
		sent = !errors.Is(err, bridge.ErrNotSent)
		return err
	})
	if err != nil && !sent && !errors.Is(err, ErrBracketedUnsupported) {
		return unchecked(err)
	}
	return err
}

func (c *Client) PaneSize(ctx context.Context, p herdrapi.PaneSetPtySizeParams) error {
	_, err := c.do(ctx, "pane.set_pty_size", p)
	return err
}

// PaneInput is bound to one pane and session. Once a write is attempted it is
// never replayed through the fallback: a missing ack does not prove non-delivery.
type PaneInput struct {
	mu     sync.Mutex
	c      *Client
	pane   string
	stream Duplex
	seq    uint64
	failed error
}

func (c *Client) OpenPaneInput(ctx context.Context, pane string) *PaneInput {
	p := &PaneInput{c: c, pane: pane}
	if strings.Contains(pane, "/") {
		return p
	}
	dx, ok := c.t.(Duplexer)
	if !ok {
		return p
	}
	pong, err := c.Ping(ctx)
	if err != nil {
		return p
	}
	if pong.Capabilities == nil || !pong.Capabilities.PaneInputStream {
		return p
	}
	opening, cancel := context.WithCancel(ctx)
	timer := time.AfterFunc(10*time.Second, cancel)
	d, err := dx.OpenDuplex(opening)
	if err != nil {
		timer.Stop()
		cancel()
		return p
	}
	// herdr's schema does not list pane.input.stream's open params (herdr
	// src/api/schema/panes.rs PaneInputStreamParams at bbfb1b3); the stream's
	// input_source applies to every frame written on it.
	params := struct {
		PaneID      string                `json:"pane_id"`
		InputSource *herdrapi.InputSource `json:"input_source,omitempty"`
	}{pane, c.inputSource()}
	line, _ := json.Marshal(map[string]any{"id": "desktop:input", "method": "pane.input.stream", "params": params})
	err = d.WriteLine(line)
	if err == nil {
		var ack []byte
		ack, err = d.Next()
		if err == nil {
			var r struct {
				Result struct {
					Type string `json:"type"`
				} `json:"result"`
			}
			if json.Unmarshal(ack, &r) != nil || r.Result.Type != "ok" {
				err = errors.New("input stream refused")
			}
		}
	}
	if !timer.Stop() || err != nil {
		cancel()
		d.Close()
		return p
	}
	p.stream = &inputDuplex{Duplex: d, cancel: cancel}
	return p
}

type inputDuplex struct {
	Duplex
	cancel context.CancelFunc
}

func (d *inputDuplex) Close() error { d.cancel(); return d.Duplex.Close() }

func (p *PaneInput) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stream != nil {
		p.stream.Close()
		p.stream = nil
	}
	p.failed = errors.New("terminal input closed")
}

func (p *PaneInput) Send(ctx context.Context, text string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.failed != nil {
		return p.failed
	}
	if !utf8.ValidString(text) {
		return errors.New("terminal input is not UTF-8")
	}
	for len(text) > 0 {
		// At most 48 KiB even when every byte is JSON-escaped. Never split UTF-8.
		n := min(len(text), 8*1024)
		for n < len(text) && !utf8.RuneStart(text[n]) {
			n--
		}
		part := text[:n]
		text = text[n:]
		var err error
		if p.stream == nil {
			err = p.c.PaneSendText(ctx, p.pane, part)
		} else {
			p.seq++
			frame, _ := json.Marshal(struct {
				Seq  uint64 `json:"seq"`
				Text string `json:"text"`
				Ack  bool   `json:"ack"`
			}{p.seq, part, true})
			stream := p.stream
			stop := context.AfterFunc(ctx, func() { stream.Close() })
			err = p.stream.WriteLine(frame)
			if err == nil {
				var line []byte
				line, err = p.stream.Next()
				if err == nil {
					var ack struct {
						Seq   uint64           `json:"seq"`
						OK    bool             `json:"ok"`
						Error *bridge.APIError `json:"error"`
					}
					if json.Unmarshal(line, &ack) != nil || !ack.OK || ack.Seq != p.seq {
						err = fmt.Errorf("terminal input acknowledgement missing for frame %d", p.seq)
					}
					if ack.Error != nil {
						err = ack.Error
					}
				}
			}
			stop()
		}
		if err != nil {
			p.failed = fmt.Errorf("input delivery uncertain; not resent: %w", err)
			return p.failed
		}
	}
	return nil
}
