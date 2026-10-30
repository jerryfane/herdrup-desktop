package fakeherdr

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sync"
)

// Interaction is an opt-in development fixture. It exercises the same SSH
// streams and requests as herdr, without running commands or spending tokens.
type Interaction struct {
	mu        sync.Mutex
	entries   []map[string]any
	listeners map[chan map[string]any]string
	seq       uint64
	answered  bool
}

func NewInteraction() *Interaction {
	return &Interaction{listeners: make(map[chan map[string]any]string), entries: []map[string]any{
		{"kind": "user", "id": "u1", "ts_ms": 1, "author": "owner", "text": "Review the workspace and explain the plan."},
		{"kind": "thinking", "id": "t1", "ts_ms": 2, "text": "I will inspect the project, then check the implementation."},
		{"kind": "step", "id": "s1", "ts_ms": 3, "tool": "read", "intent": "Inspecting project", "detail": "src/main.ts", "status": "ok"},
		{"kind": "reply", "id": "r1", "ts_ms": 4, "final": true, "text": "## Workspace review\n\nThe **desktop client** has a live terminal and an agent conversation.\n\n| Surface | Transport |\n|---|---|\n| Terminal | PTY stream |\n| Chat | Transcript API |\n\n```mermaid\nflowchart LR\n  Desktop --> SSH\n  SSH --> Agent\n```\n\n```go\nfmt.Println(\"ready\")\n```"},
	}}
}
func (x *Interaction) Handle(method string, raw json.RawMessage) (any, *APIError, bool) {
	var p struct {
		Pane   string `json:"pane_id"`
		Target string `json:"target"`
		Text   string `json:"text"`
		Option string `json:"option"`
		Cols   int    `json:"cols"`
		Rows   int    `json:"rows"`
		After  string `json:"after"`
		Before string `json:"before"`
		Cursor string `json:"cursor"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, &APIError{Code: "invalid_request", Message: err.Error()}, true
	}
	x.mu.Lock()
	defer x.mu.Unlock()
	switch method {
	case "pane.send_text":
		x.output(p.Pane, p.Text)
		return map[string]any{"type": "ok"}, nil, true
	case "pane.set_pty_size":
		x.emit(p.Pane, map[string]any{"stream": "pane.bytes", "frame": "resize", "seq": x.seq, "epoch": 1, "cols": p.Cols, "rows": p.Rows})
		return map[string]any{"type": "pane_pty_size", "pane_id": p.Pane, "cols": p.Cols, "rows": p.Rows, "locked": true}, nil, true
	case "pane.history":
		return map[string]any{"type": "pane_history", "pane_id": p.Pane, "history_b64": base64.StdEncoding.EncodeToString([]byte("Older retained output\r\nfirst command completed\r\n")), "cursor": nil, "rows": 2}, nil, true
	case "agent.transcript":
		entries := x.entries
		if p.After == fmt.Sprint(len(x.entries)) {
			entries = nil
		}
		page := map[string]any{"type": "agent_transcript", "agent": "omp", "pane_id": p.Target, "session_id": "demo-session", "after": fmt.Sprint(len(x.entries)), "entries": entries}
		if p.Before == "" {
			page["before"] = "older"
		} else {
			page["entries"] = []any{map[string]any{"kind": "user", "id": "older", "ts_ms": 0, "author": "owner", "text": "Earlier conversation page."}}
		}
		if !x.answered {
			page["pending_ask"] = map[string]any{"id": "q1", "answerable": true, "questions": []any{map[string]any{"question": "Which verification should run?", "multi": false, "options": []string{"Run focused checks", "Inspect the diff"}}}}
		}
		return page, nil, true
	case "agent.prompt":
		n := len(x.entries)
		x.entries = append(x.entries, map[string]any{"kind": "user", "id": fmt.Sprintf("u%d", n), "ts_ms": n + 10, "author": "owner", "text": p.Text}, map[string]any{"kind": "reply", "id": fmt.Sprintf("r%d", n), "ts_ms": n + 11, "text": "Sample backend received your prompt. No live model was called.", "final": true})
		return map[string]any{"type": "agent_prompted", "agent": map[string]any{"pane_id": p.Target, "agent": "omp", "agent_status": "idle"}, "delivery": "submitted"}, nil, true
	case "agent.answer":
		x.answered = true
		return map[string]any{"type": "agent_answer", "status": "answered", "ask_id": "q1", "option": p.Option, "pane_id": p.Target}, nil, true
	}
	return nil, nil, false
}
func (x *Interaction) emit(pane string, frame map[string]any) {
	for ch, target := range x.listeners {
		if target == pane {
			select {
			case ch <- frame:
			default:
			}
		}
	}
}
func (x *Interaction) output(pane, text string) {
	x.seq += uint64(len(text))
	x.emit(pane, map[string]any{"stream": "pane.bytes", "frame": "data", "seq": x.seq, "epoch": 1, "data_b64": base64.StdEncoding.EncodeToString([]byte(text))})
}
func (x *Interaction) Stream(ctx context.Context, id string, raw json.RawMessage, emit func([]byte) error) {
	var p struct {
		Pane string `json:"pane_id"`
	}
	_ = json.Unmarshal(raw, &p)
	reply := func(v any) error { b, _ := json.Marshal(v); return emit(b) }
	x.mu.Lock()
	seq := x.seq
	ch := make(chan map[string]any, 128)
	x.listeners[ch] = p.Pane
	x.mu.Unlock()
	defer func() { x.mu.Lock(); delete(x.listeners, ch); x.mu.Unlock() }()
	if reply(map[string]any{"id": id, "result": map[string]any{"type": "stream_started", "pane_id": p.Pane, "base_seq": seq, "epoch": 1, "cols": 100, "rows": 30}}) != nil {
		return
	}
	seed := "\x1b[2J\x1b[H\x1b[1mHerdrup native terminal\x1b[0m\r\nSample SSH backend - input is echoed, not executed.\r\nTry typing, pasting multiple lines, resizing, searching and copying.\r\n$ "
	if reply(map[string]any{"stream": "pane.bytes", "frame": "reset", "seq": seq, "epoch": 1, "cols": 100, "rows": 30, "data_b64": base64.StdEncoding.EncodeToString([]byte(seed)), "history_b64": base64.StdEncoding.EncodeToString([]byte("Earlier retained terminal output\r\n")), "history_cursor": "older"}) != nil {
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case frame := <-ch:
			if reply(frame) != nil {
				return
			}
		}
	}
}
func (x *Interaction) Duplex(ctx context.Context, id, method string, raw json.RawMessage, read func() ([]byte, error), emit func([]byte) error) {
	reply := func(v any) error { b, _ := json.Marshal(v); return emit(b) }
	var p struct {
		Pane string `json:"pane_id"`
	}
	_ = json.Unmarshal(raw, &p)
	if reply(map[string]any{"id": id, "result": map[string]string{"type": "ok"}}) != nil {
		return
	}
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
		x.mu.Lock()
		x.output(p.Pane, frame.Text)
		x.mu.Unlock()
		if reply(map[string]any{"seq": frame.Seq, "ok": true}) != nil {
			return
		}
	}
}
