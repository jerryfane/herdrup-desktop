package fakeherdr

import (
	"encoding/json"
	"sync"
)

// PaneWrite is one pane.send_text request as herdr received it.
type PaneWrite struct {
	Pane      string
	Text      string
	Bracketed bool
}

// PaneWrites is herdr's pane.send_text with bracketed paste (herdr #512).
// It records every request; a bracketed one is refused, with nothing
// written, where the pane's program has not turned bracketed paste on.
type PaneWrites struct {
	mu sync.Mutex
	// Bracketed advertises pane_send_text_bracketed on ping. Without it a
	// bracketed request goes on to next as a plain write, as a herdr that
	// predates the flag would take it.
	Bracketed bool
	// PasteOff is true when the pane's program has not turned bracketed paste
	// on: a bracketed request answers bracketed_paste_unavailable.
	PasteOff bool
	writes   []PaneWrite
}

// Writes returns the pane.send_text requests received, in order.
func (w *PaneWrites) Writes() []PaneWrite {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]PaneWrite(nil), w.writes...)
}

// Serve answers through w, then next: the pong gains the capability, and a
// pane.send_text is recorded, refused or passed on.
func (w *PaneWrites) Serve(next func(string, json.RawMessage) (any, *APIError)) func(string, json.RawMessage) (any, *APIError) {
	return func(method string, raw json.RawMessage) (any, *APIError) {
		switch method {
		case "pane.send_text":
			var p struct {
				Pane      string `json:"pane_id"`
				Text      string `json:"text"`
				Bracketed bool   `json:"bracketed"`
			}
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, &APIError{Code: "invalid_request", Message: err.Error()}
			}
			w.mu.Lock()
			w.writes = append(w.writes, PaneWrite{Pane: p.Pane, Text: p.Text, Bracketed: p.Bracketed})
			refused := p.Bracketed && w.Bracketed && w.PasteOff
			w.mu.Unlock()
			if refused {
				return nil, &APIError{Code: "bracketed_paste_unavailable", Message: "the program in this pane has not turned on bracketed paste"}
			}
		case "ping":
			value, err := next(method, raw)
			if err == nil && w.Bracketed {
				if caps, ok := value.(map[string]any)["capabilities"].(map[string]bool); ok {
					caps["pane_send_text_bracketed"] = true
				}
			}
			return value, err
		}
		return next(method, raw)
	}
}
