package engine

import (
	"context"
	"io"
	"runtime"
	"testing"
	"time"
)

// A failed read cancels the send while its AfterFunc is registered. With one
// processor, Send and the owning view can finish before the callback is scheduled.
// No network timing is needed to exercise this terminal-close ordering.
type cancelledInputDuplex struct {
	cancel context.CancelFunc
	closed chan struct{}
}

func (d *cancelledInputDuplex) WriteLine([]byte) error { return nil }
func (d *cancelledInputDuplex) CloseWrite() error      { return nil }
func (d *cancelledInputDuplex) Next() ([]byte, error)  { d.cancel(); return nil, io.EOF }
func (d *cancelledInputDuplex) Close() error           { d.closed <- struct{}{}; return nil }

func TestTerminalCancellationClosesCapturedStream(t *testing.T) {
	previous := runtime.GOMAXPROCS(1)
	defer runtime.GOMAXPROCS(previous)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream := &cancelledInputDuplex{cancel: cancel, closed: make(chan struct{}, 2)}
	input := &PaneInput{stream: stream}
	if err := input.Send(ctx, "pending input"); err == nil {
		t.Fatal("unacknowledged cancelled input reported success")
	}
	input.Close()
	for range 2 {
		select {
		case <-stream.closed:
		case <-time.After(time.Second):
			t.Fatal("view close and cancellation did not both release the captured stream")
		}
	}
	if err := input.Send(context.Background(), "must not replay"); err == nil {
		t.Fatal("closed terminal accepted input")
	}
}
