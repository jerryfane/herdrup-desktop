package engine_test

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

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
