package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
)

// terminalWriteDesk opens a plain terminal view, "shell", on a host whose
// pane.send_text is writes (issue #392).
func terminalWriteDesk(t *testing.T, writes *fakeherdr.PaneWrites) (*Desk, string) {
	t.Helper()
	fixture := fakeherdr.NewCreation(nil)
	d, _ := federatedDesk(t, func(server *fakeherdr.Server) {
		previous := server.Handle
		server.Handle = writes.Serve(func(method string, raw json.RawMessage) (any, *fakeherdr.APIError) {
			if method == "pane.send_text" {
				return map[string]any{"type": "ok"}, nil
			}
			if value, err, handled := fixture.Handle(method, raw); handled {
				return value, err
			}
			return previous(method, raw)
		})
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
