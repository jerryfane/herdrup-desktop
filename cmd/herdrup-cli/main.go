// Command herdrup-cli calls herdr's API on a machine over SSH, the way
// Herdrup Desktop does (internal/engine), and prints the results as JSON.
// It is the CLI smoke test of the engine.
//
//	herdrup-cli [-host -port -user -key -session -pins -for] <command> [json-params]
//
// Commands are herdr's method names (ping, agent.list, gram.send, ...),
// whose params are the method's JSON params, plus:
//
//	sessions               the machine's herdr sessions
//	watch [options]        events.subscribe with events_v2, one JSON event per line
//	pane-stream <pane_id> [params]  pane.stream frames, one per line
//	gram.upload <file>     stage a file for gram.send/gram.post
//
// -for bounds watch and pane-stream; they otherwise run until interrupted.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// handler runs one command with its raw JSON params.
type handler func(ctx context.Context, c *engine.Client, params []byte) (any, error)

// typed makes a handler of a method that takes params P.
func typed[P, R any](f func(*engine.Client, context.Context, P) (R, error)) handler {
	return func(ctx context.Context, c *engine.Client, raw []byte) (any, error) {
		var p P
		if err := decodeParams(raw, &p); err != nil {
			return nil, err
		}
		return f(c, ctx, p)
	}
}

// noParams makes a handler of a method that takes none.
func noParams[R any](f func(*engine.Client, context.Context) (R, error)) handler {
	return func(ctx context.Context, c *engine.Client, raw []byte) (any, error) {
		if err := decodeParams(raw, &struct{}{}); err != nil {
			return nil, err
		}
		return f(c, ctx)
	}
}

// okOnly makes a handler of a method whose result is just "ok".
func okOnly[P any](f func(*engine.Client, context.Context, P) error) handler {
	return typed(func(c *engine.Client, ctx context.Context, p P) (any, error) {
		if err := f(c, ctx, p); err != nil {
			return nil, err
		}
		return map[string]string{"type": "ok"}, nil
	})
}

// decodeParams decodes raw into p, refusing unknown fields so a typo is
// not silently dropped. Empty raw leaves p zero.
func decodeParams(raw []byte, p any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(p); err != nil {
		return fmt.Errorf("params: %w", err)
	}
	return nil
}

var calls = map[string]handler{
	"ping":                noParams((*engine.Client).Ping),
	"machine.status":      noParams((*engine.Client).MachineStatus),
	"agent.list":          typed((*engine.Client).AgentList),
	"agent.transcript":    typed((*engine.Client).AgentTranscript),
	"agent.prompt":        typed((*engine.Client).AgentPrompt),
	"agent.answer":        typed((*engine.Client).AgentAnswer),
	"agent.avatar.get":    typed((*engine.Client).AgentAvatarGet),
	"agent.avatar.set":    typed((*engine.Client).AgentAvatarSet),
	"agent.groups.get":    noParams((*engine.Client).AgentGroupsGet),
	"agent.groups.set":    typed((*engine.Client).AgentGroupsSet),
	"pane.history":        typed((*engine.Client).PaneHistory),
	"gram.send":           typed((*engine.Client).GramSend),
	"gram.post":           typed((*engine.Client).GramPost),
	"gram.list":           typed((*engine.Client).GramList),
	"gram.grab":           typed((*engine.Client).GramGrab),
	"gram.mark_read":      okOnly((*engine.Client).GramMarkRead),
	"gram.delete":         okOnly((*engine.Client).GramDelete),
	"gram.get_file":       typed((*engine.Client).GramGetFile),
	"gram.get_file_chunk": typed((*engine.Client).GramGetFileChunk),
	"gram.upload_chunk":   okOnly((*engine.Client).GramUploadChunk),
	"gram.upload.discard": typed((*engine.Client).GramUploadDiscard),
	"guest.invite.create": typed((*engine.Client).GuestInviteCreate),
	"guest.list":          typed((*engine.Client).GuestList),
	"guest.revoke":        typed((*engine.Client).GuestRevoke),
	"guest.update":        typed((*engine.Client).GuestUpdate),
	"guest.audit":         typed((*engine.Client).GuestAudit),
}

func usage() {
	names := []string{"sessions", "watch", "pane-stream", "gram.upload"}
	for n := range calls {
		names = append(names, n)
	}
	slices.Sort(names)
	fmt.Fprintf(os.Stderr, "usage: herdrup-cli [flags] <command> [json-params]\n\ncommands:\n  %s\n\nflags:\n", strings.Join(names, "\n  "))
	flag.PrintDefaults()
}

func main() {
	if err := run(); err != nil {
		out := map[string]any{"error": err.Error()}
		var conflict *engine.GroupsConflictError
		if errors.As(err, &conflict) {
			out["code"], out["current"] = "groups_conflict", conflict.Current
		}
		var api *bridge.APIError
		if errors.As(err, &api) {
			out["code"] = api.Code
		}
		var unsupported *engine.ErrUnsupported
		if errors.As(err, &unsupported) {
			out["unsupported"] = unsupported
		}
		_ = json.NewEncoder(os.Stderr).Encode(out)
		os.Exit(1)
	}
}

func run() error {
	home, _ := os.UserHomeDir()
	host := flag.String("host", "127.0.0.1", "SSH host")
	port := flag.Int("port", 22, "SSH port")
	user := flag.String("user", os.Getenv("USER"), "SSH user")
	key := flag.String("key", filepath.Join(home, ".ssh", "id_ed25519"), "private key file")
	session := flag.String("session", "", "herdr session name (default: the default session)")
	pins := flag.String("pins", filepath.Join(home, ".config", "herdrup-cli", "host-keys.json"), "host key pin file")
	limit := flag.Duration("for", 0, "how long watch and pane-stream run (0: until interrupted)")
	flag.Usage = usage
	flag.Parse()
	args := flag.Args()
	if len(args) == 0 {
		usage()
		os.Exit(2)
	}
	cmd, rest := args[0], args[1:]

	pem, err := os.ReadFile(*key)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	bc, err := bridge.Dial(ctx, bridge.Config{
		Host: *host, Port: *port, User: *user, KeyPEM: pem,
		Session: *session, Pins: bridge.NewFilePinStore(*pins),
	})
	if err != nil {
		return err
	}
	defer bc.Close()
	c := engine.New(engine.Bridge(bc))
	out := json.NewEncoder(os.Stdout)
	bounded := func() (context.Context, context.CancelFunc) {
		if *limit > 0 {
			return context.WithTimeout(ctx, *limit)
		}
		return context.WithCancel(ctx)
	}
	params := func(i int) []byte {
		if len(rest) > i {
			return []byte(rest[i])
		}
		return nil
	}

	switch cmd {
	case "sessions":
		s, err := bc.ListSessions(ctx)
		if err != nil {
			return err
		}
		return out.Encode(s)
	case "watch":
		var opts engine.SubscribeOptions
		if err := decodeParams(params(0), &opts); err != nil {
			return err
		}
		wctx, cancel := bounded()
		defer cancel()
		err := c.Subscribe(wctx, opts, func(e engine.Event) {
			line := struct {
				engine.Event
				Error string `json:"error,omitempty"`
			}{Event: e}
			if e.Err != nil {
				line.Error = e.Err.Error()
			}
			_ = out.Encode(line)
		})
		return ended(wctx, err)
	case "pane-stream":
		if len(rest) == 0 {
			return errors.New("usage: pane-stream <pane_id> [params]")
		}
		p := herdrapi.PaneStreamParams{PaneID: rest[0]}
		if err := decodeParams(params(1), &p); err != nil {
			return err
		}
		sctx, cancel := bounded()
		defer cancel()
		ps, err := c.PaneStream(sctx, p)
		if err != nil {
			return err
		}
		defer ps.Close()
		if err := out.Encode(map[string]any{"stream_started": ps.Started}); err != nil {
			return err
		}
		for {
			f, err := ps.Next()
			if err != nil {
				if errors.Is(err, io.EOF) {
					return nil
				}
				return ended(sctx, err)
			}
			if err := out.Encode(f); err != nil {
				return err
			}
		}
	case "gram.upload":
		if len(rest) != 1 {
			return errors.New("usage: gram.upload <file>")
		}
		data, err := os.ReadFile(rest[0])
		if err != nil {
			return err
		}
		id, path, err := c.GramUpload(ctx, data)
		if err != nil {
			return err
		}
		return out.Encode(map[string]any{"upload_id": id, "path": path, "bytes": len(data)})
	}
	h, ok := calls[cmd]
	if !ok {
		usage()
		return fmt.Errorf("unknown command %q", cmd)
	}
	if len(rest) > 1 {
		return errors.New("too many arguments: pass params as one JSON object")
	}
	cctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	res, err := h(cctx, c, params(0))
	if err != nil {
		return err
	}
	return out.Encode(res)
}

// ended treats the end of a -for bound as success.
func ended(ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil
	}
	return err
}
