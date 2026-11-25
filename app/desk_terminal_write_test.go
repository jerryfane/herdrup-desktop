package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"golang.org/x/crypto/ssh"
)

// A bracketed write herdr refused, writing nothing, keeps the draft with
// its reason; any other error passes through, a write never sent with its
// own reason.
func TestBracketedWriteErrorNamesWhyNothingWasWritten(t *testing.T) {
	other := &bridge.APIError{Code: "pane_not_found", Message: "no pane"}
	notSent := fmt.Errorf("pane.send_bracketed_text: %w: %w", bridge.ErrNotSent, context.Canceled)
	for _, c := range []struct {
		err, want error
	}{
		{&bridge.APIError{Code: "invalid_request", Message: "bad request"}, errTerminalLineBreak},
		{&bridge.APIError{Code: "unknown_method", Message: "pane.send_bracketed_text"}, errTerminalLineBreak},
		{&engine.ErrUnsupported{Method: "pane.send_bracketed_text"}, errTerminalLineBreak},
		{&bridge.APIError{Code: "bracketed_paste_unavailable"}, errTerminalPasteRefused},
		{notSent, notSent},
		{other, other},
		{nil, nil},
	} {
		if got := bracketedWriteError(c.err); got != c.want {
			t.Errorf("bracketedWriteError(%v) = %v, want %v", c.err, got, c.want)
		}
	}
}

// answering is a transport that answers every call with err, or ok.
type answering struct {
	engine.Transport
	err error
}

func (a answering) Call(_ context.Context, _ string, _, result any) error {
	if a.err != nil {
		return a.err
	}
	return json.Unmarshal([]byte(`{"type":"ok"}`), result)
}

// A plain terminal's write, by how it failed: herdr's refusals keep the
// draft with "one line at a time" (or the pasted-block variant); a write
// never sent keeps it with errTerminalNotSent, one line or a block alike,
// whatever the cause (the transport, a cancellation), or with
// errTerminalTooLong when it was too large to send; a timeout after the
// write is unconfirmed; ok is written.
func TestTerminalWriteOutcomeByError(t *testing.T) {
	lost := fmt.Errorf("pane.send_text: %w: %w", bridge.ErrNotSent, errors.New("ssh: connection closed"))
	cancelled := fmt.Errorf("pane.send_bracketed_text: %w: %w", bridge.ErrNotSent, context.Canceled)
	tooLarge := fmt.Errorf("pane.send_bracketed_text: %w: request of 98304 bytes: %w", bridge.ErrNotSent, bridge.ErrRequestTooLarge)
	for _, c := range []struct {
		name     string
		text     string
		err      error
		kept     string // the error a kept draft shows; "" when not kept
		delivery string
	}{
		{"invalid_request", twoLines, &bridge.APIError{Code: "invalid_request", Message: "bad request"}, string(errTerminalLineBreak), ""},
		{"unknown_method", twoLines, &bridge.APIError{Code: "unknown_method", Message: "pane.send_bracketed_text"}, string(errTerminalLineBreak), ""},
		{"bracketed paste off", twoLines, &bridge.APIError{Code: "bracketed_paste_unavailable", Message: "off"}, string(errTerminalPasteRefused), ""},
		{"a block never sent", twoLines, lost, string(errTerminalNotSent), ""},
		{"a line never sent", "printf hello", lost, string(errTerminalNotSent), ""},
		{"a block never sent, cancelled", twoLines, cancelled, string(errTerminalNotSent), ""},
		{"a block too large to send", twoLines, tooLarge, string(errTerminalTooLong), ""},
		{"a timeout after the write", twoLines, &bridge.APIError{Code: "timeout", Message: "no answer"}, "", "unconfirmed"},
		{"ok", twoLines, nil, "", "written"},
	} {
		t.Run(c.name, func(t *testing.T) {
			v := &interaction{AgentView: AgentView{PaneID: "w1:p1", PlainTerminal: true}, client: engine.New(answering{err: c.err})}
			receipt, err := submitPanePrompt(context.Background(), v, c.text)
			if c.kept != "" {
				if receipt != "" || err == nil || err.Error() != c.kept {
					t.Fatalf("%q %v; want the draft kept with %q", receipt, err, c.kept)
				}
				return
			}
			if err != nil || !strings.Contains(receipt, `"delivery":"`+c.delivery+`"`) {
				t.Fatalf("%q %v; want delivery %q", receipt, err, c.delivery)
			}
		})
	}
}

// #506 review: a draft too large for the per-request route (a herdr
// without --multi) is never sent: the composer keeps it, saying it is too
// long, and nothing reaches the pane.
func TestTerminalKeepsADraftTooLongToSend(t *testing.T) {
	writes := &fakeherdr.PaneWrites{Bracketed: true}
	d, _ := terminalDesk(t, writes.Serve, func(s *fakeherdr.Server) { s.NoMulti = true })
	draft := strings.Repeat(strings.Repeat("x", 1023)+"\n", 96) // 96 KiB, multiline
	receipt, err := d.ChatPrompt(context.Background(), "shell", draft)
	if receipt != "" || err == nil || err.Error() != string(errTerminalTooLong) {
		t.Fatalf("%q %v; want the draft kept with %q", receipt, err, errTerminalTooLong)
	}
	if got := writes.Writes(); len(got) != 0 {
		t.Fatalf("%d pane writes of a draft too long to send", len(got))
	}
}

// #506 review: a draft sent on a terminal view whose SSH connection has
// closed (the view still open: the desk has not yet replaced its link) is
// never sent: the composer keeps it, saying nothing was sent, and nothing
// reaches the pane. The view's client is a real bridge client, closed
// first, so the order is fixed.
func TestTerminalKeepsADraftSentAfterTheConnectionClosed(t *testing.T) {
	writes := &fakeherdr.PaneWrites{Bracketed: true}
	_, hostPriv, _ := ed25519.GenerateKey(rand.Reader)
	hostKey, _ := ssh.NewSignerFromKey(hostPriv)
	_, clientPriv, _ := ed25519.GenerateKey(rand.Reader)
	client, _ := ssh.NewSignerFromKey(clientPriv)
	block, err := ssh.MarshalPrivateKey(clientPriv, "")
	if err != nil {
		t.Fatal(err)
	}
	srv := &fakeherdr.Server{HostKey: hostKey, Authorized: client.PublicKey(),
		Handle: writes.Serve(func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "ping":
				return fakeherdr.Pong(true), nil
			case "pane.send_text":
				return map[string]any{"type": "ok"}, nil
			}
			return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
		})}
	addr, err := srv.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { srv.Close() })
	host, portStr, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portStr)
	c, err := bridge.Dial(context.Background(), bridge.Config{Host: host, Port: port, User: "dev", KeyPEM: pem.EncodeToMemory(block),
		Pins: bridge.NewFilePinStore(filepath.Join(t.TempDir(), "pins.json"))})
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	select {
	case <-c.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the closed connection never ended")
	}
	v := &interaction{AgentView: AgentView{PaneID: "w1:p1", PlainTerminal: true}, client: engine.New(engine.Bridge(c))}
	receipt, err := submitPanePrompt(context.Background(), v, twoLines)
	if receipt != "" || err == nil || err.Error() != string(errTerminalNotSent) {
		t.Fatalf("%q %v; want the draft kept with %q", receipt, err, errTerminalNotSent)
	}
	if got := writes.Writes(); len(got) != 0 {
		t.Fatalf("%d pane writes after the connection closed", len(got))
	}
}

// terminalDesk opens a plain terminal view, "shell", on a host whose
// handler serve wraps (issue #392), and that configure sets up further.
func terminalDesk(t *testing.T, serve func(next func(string, json.RawMessage) (any, *fakeherdr.APIError)) func(string, json.RawMessage) (any, *fakeherdr.APIError), configure ...func(*fakeherdr.Server)) (*Desk, string) {
	t.Helper()
	fixture := fakeherdr.NewCreation(nil)
	d, _ := federatedDesk(t, func(server *fakeherdr.Server) {
		previous := server.Handle
		server.Handle = serve(func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "pane.send_text" {
				return map[string]any{"type": "ok"}, nil
			}
			if value, err, handled := fixture.Handle(method, raw); handled {
				return value, err
			}
			return previous(method, raw)
		})
		for _, set := range configure {
			set(server)
		}
	})
	t.Cleanup(d.Disconnect)
	board := d.Board()
	if err := d.OpenCreation(board.MachineID, board.Session, "terminal"); err != nil {
		t.Fatal(err)
	}
	result, err := d.CreateTerminal(context.Background(), "terminal")
	if err != nil || result.Terminal == nil {
		t.Fatalf("create: %+v %v", result, err)
	}
	target := AgentTarget{MachineID: board.MachineID, Session: board.Session, PaneID: result.Terminal.PaneID}
	if _, err := d.OpenTerminalView(target, "shell"); err != nil {
		t.Fatal(err)
	}
	return d, target.PaneID
}

// terminalWriteDesk is terminalDesk on a host whose pane writes are writes.
func terminalWriteDesk(t *testing.T, writes *fakeherdr.PaneWrites) (*Desk, string) {
	t.Helper()
	return terminalDesk(t, writes.Serve)
}

// A multiline draft's outcome by what herdr answers pane.send_bracketed_text
// (herdr #517): kept, with "one line at a time", where nothing was written
// (a herdr without the method, or bracketed paste off); "unconfirmed" where
// the write may have happened; "written" on ok.
func TestTerminalBracketedWriteOutcomeByAnswer(t *testing.T) {
	for _, c := range []struct {
		name     string
		answer   *fakeherdr.APIError
		kept     string // the error a kept draft shows; "" when not kept
		delivery string
	}{
		{"an older herdr's invalid_request", &fakeherdr.APIError{Code: "invalid_request", Message: "bad request"}, string(errTerminalLineBreak), ""},
		{"an older herdr's unknown variant", &fakeherdr.APIError{Code: "invalid_request", Message: "unknown variant `pane.send_bracketed_text`"}, string(errTerminalLineBreak), ""},
		{"unknown_method", &fakeherdr.APIError{Code: "unknown_method", Message: "pane.send_bracketed_text"}, string(errTerminalLineBreak), ""},
		{"bracketed paste off", &fakeherdr.APIError{Code: "bracketed_paste_unavailable", Message: "off"}, string(errTerminalPasteRefused), ""},
		{"a timeout after the write", &fakeherdr.APIError{Code: "timeout", Message: "no answer"}, "", "unconfirmed"},
		{"ok", nil, "", "written"},
	} {
		t.Run(c.name, func(t *testing.T) {
			d, _ := terminalDesk(t, func(next func(string, json.RawMessage) (any, *fakeherdr.APIError)) func(string, json.RawMessage) (any, *fakeherdr.APIError) {
				return func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
					if method != "pane.send_bracketed_text" {
						return next(method, raw)
					}
					if c.answer != nil {
						return nil, c.answer
					}
					return map[string]any{"type": "ok"}, nil
				}
			})
			receipt, err := d.ChatPrompt(context.Background(), "shell", twoLines)
			if c.kept != "" {
				if receipt != "" || err == nil || err.Error() != c.kept {
					t.Fatalf("%q %v; want the draft kept with %q", receipt, err, c.kept)
				}
				return
			}
			if err != nil || !strings.Contains(receipt, `"delivery":"`+c.delivery+`"`) {
				t.Fatalf("%q %v; want delivery %q", receipt, err, c.delivery)
			}
		})
	}
}

const twoLines = "cat <<EOF\nfirst line\r\nsecond line\nEOF"

func TestTerminalWritesALineBreakAsOneBracketedPaste(t *testing.T) {
	writes := &fakeherdr.PaneWrites{Bracketed: true}
	d, pane := terminalWriteDesk(t, writes)
	receipt, err := d.ChatPrompt(context.Background(), "shell", twoLines)
	if err != nil || !strings.Contains(receipt, `"delivery":"written"`) {
		t.Fatalf("write: %s %v", receipt, err)
	}
	if got := writes.Writes(); len(got) != 1 || got[0] != (fakeherdr.PaneWrite{Pane: pane, Text: twoLines, Bracketed: true}) {
		t.Fatalf("writes %+v, want one bracketed write of the whole draft", got)
	}
}

func TestTerminalKeepsADraftTheProgramCannotPaste(t *testing.T) {
	writes := &fakeherdr.PaneWrites{Bracketed: true, PasteOff: true}
	d, pane := terminalWriteDesk(t, writes)
	receipt, err := d.ChatPrompt(context.Background(), "shell", twoLines)
	// A failed send keeps the draft in the composer and shows the error.
	if receipt != "" || err == nil || err.Error() != "This program can't take a pasted block. Write one line at a time." {
		t.Fatalf("refused paste: %q %v", receipt, err)
	}
	if got := writes.Writes(); len(got) != 1 || got[0] != (fakeherdr.PaneWrite{Pane: pane, Text: twoLines, Bracketed: true}) {
		t.Fatalf("writes %+v, want the one refused bracketed write and no retry", got)
	}
}

func TestTerminalWithoutBracketedWriteRefusesALineBreak(t *testing.T) {
	for _, text := range []string{"make\nmake install", "make\rmake install"} {
		writes := &fakeherdr.PaneWrites{}
		d, _ := terminalWriteDesk(t, writes)
		receipt, err := d.ChatPrompt(context.Background(), "shell", text)
		if receipt != "" || err == nil || err.Error() != "Write one line at a time: a line break would run the text before it." {
			t.Fatalf("%q without the capability: %q %v", text, receipt, err)
		}
		if got := writes.Writes(); len(got) != 0 {
			t.Fatalf("%q without the capability reached the terminal: %+v", text, got)
		}
	}
}

func TestTerminalWritesOneLineAsItIs(t *testing.T) {
	writes := &fakeherdr.PaneWrites{Bracketed: true}
	d, pane := terminalWriteDesk(t, writes)
	receipt, err := d.ChatPrompt(context.Background(), "shell", "printf hello")
	if err != nil || !strings.Contains(receipt, `"delivery":"written"`) {
		t.Fatalf("write: %s %v", receipt, err)
	}
	if got := writes.Writes(); len(got) != 1 || got[0] != (fakeherdr.PaneWrite{Pane: pane, Text: "printf hello"}) {
		t.Fatalf("writes %+v, want one plain write", got)
	}
}
