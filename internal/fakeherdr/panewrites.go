package fakeherdr

import (
	"encoding/json"
	"sync"
)

// PaneWrite is one write to a pane as herdr received it: pane.send_text, or
// pane.send_bracketed_text (Bracketed).
type PaneWrite struct {
	Pane      string
	Text      string
	Bracketed bool
}

// PaneWrites is herdr's pane writes with pane.send_bracketed_text (herdr
// #517). It records every write that reaches a pane's program, or would
// have but for bracketed paste being off there.
type PaneWrites struct {
	mu sync.Mutex
	// Bracketed serves pane.send_bracketed_text and advertises
	// pane_send_bracketed_text on ping. Without it the method is refused
	// with invalid_request, nothing written, as a herdr that predates it
	// does (an unknown variant of its request enum).
	Bracketed bool
	// PasteOff is true when the pane's program has not turned bracketed paste
	// on: a bracketed write answers bracketed_paste_unavailable.
	PasteOff bool
	writes   []PaneWrite
}

// Writes returns the writes received, in order.
func (w *PaneWrites) Writes() []PaneWrite {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]PaneWrite(nil), w.writes...)
}

// Serve answers through w, then next: the pong gains the capability, and a
// write is recorded and, once the paste policy allows it, passed on to
// next as the one pane.send_text write path (a pane's output fixture
// echoes it), whichever method asked for it.
func (w *PaneWrites) Serve(next func(string, json.RawMessage) (any, *APIError)) func(string, json.RawMessage) (any, *APIError) {
	return func(method string, raw json.RawMessage) (any, *APIError) {
		switch method {
		case "pane.send_text", "pane.send_bracketed_text":
			bracketed := method == "pane.send_bracketed_text"
			if bracketed && !w.Bracketed {
				return nil, &APIError{Code: "invalid_request", Message: "unknown variant `pane.send_bracketed_text`, expected one of `ping`, `pane.send_text`"}
			}
			var p struct {
				Pane string `json:"pane_id"`
				Text string `json:"text"`
			}
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, &APIError{Code: "invalid_request", Message: err.Error()}
			}
			w.mu.Lock()
			w.writes = append(w.writes, PaneWrite{Pane: p.Pane, Text: p.Text, Bracketed: bracketed})
			w.mu.Unlock()
			if bracketed && w.PasteOff {
				return nil, &APIError{Code: "bracketed_paste_unavailable", Message: "the program in this pane has not turned on bracketed paste"}
			}
			return next("pane.send_text", raw)
		case "ping":
			value, err := next(method, raw)
			if err == nil && w.Bracketed {
				if caps, ok := value.(map[string]any)["capabilities"].(map[string]bool); ok {
					caps["pane_send_bracketed_text"] = true
				}
			}
			return value, err
		}
		return next(method, raw)
	}
}
