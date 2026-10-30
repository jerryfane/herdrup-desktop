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
	_, err := c.do(ctx, "pane.send_text", herdrapi.PaneSendTextParams{PaneID: pane, Text: text})
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
	line, _ := json.Marshal(map[string]any{"id": "desktop:input", "method": "pane.input.stream", "params": map[string]string{"pane_id": pane}})
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
			stop := context.AfterFunc(ctx, func() { p.stream.Close() })
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
