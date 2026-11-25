package fakeherdr

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

// #506 review: a bracketed write the paste policy allows goes the one
// write path a plain write goes, so the pane's output fixture echoes it:
// its text is the pane's first data frame, ahead of the plain write after
// it.
func TestABracketedWriteIsEchoedLikeAPlainOne(t *testing.T) {
	x := NewInteraction()
	writes := &PaneWrites{Bracketed: true}
	handle := writes.Serve(func(method string, raw json.RawMessage) (any, *APIError) {
		if value, err, ok := x.Handle(method, raw); ok {
			return value, err
		}
		return nil, &APIError{Code: "unknown_method", Message: method}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	frames := make(chan map[string]any, 16)
	go x.Stream(ctx, "s1", json.RawMessage(`{"pane_id":"w1:p1"}`), func(line []byte) error {
		var frame map[string]any
		_ = json.Unmarshal(line, &frame)
		select {
		case frames <- frame:
		case <-ctx.Done():
		}
		return ctx.Err()
	})
	next := func(what string) map[string]any {
		t.Helper()
		select {
		case frame := <-frames:
			return frame
		case <-time.After(5 * time.Second):
			t.Fatalf("no %s", what)
			return nil
		}
	}
	next("stream start")
	next("reset frame")
	if _, err := handle("pane.send_bracketed_text", json.RawMessage(`{"pane_id":"w1:p1","text":"a\nb"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := handle("pane.send_text", json.RawMessage(`{"pane_id":"w1:p1","text":"ls"}`)); err != nil {
		t.Fatal(err)
	}
	frame := next("data frame")
	data, _ := base64.StdEncoding.DecodeString(frame["data_b64"].(string))
	if frame["frame"] != "data" || string(data) != "a\nb" {
		t.Fatalf("first pane frame %v (%q), want the bracketed write's text", frame, data)
	}
}
