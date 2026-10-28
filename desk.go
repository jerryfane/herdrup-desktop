package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/live"
)

// Machine is a saved connection. It holds no secret: the key stays in its
// file and a password is never written down.
type Machine struct {
	Host    string `json:"host"`
	Port    int    `json:"port"`
	User    string `json:"user"`
	KeyPath string `json:"keyPath"`
	Session string `json:"session"`
}

// ConnState is the connection as the window shows it.
type ConnState struct {
	// Phase is "idle", "connecting", "connected" or "error".
	Phase   string `json:"phase"`
	Message string `json:"message"`
	Machine string `json:"machine"`
	// Herdr is the version and protocol of the connected herdr.
	Herdr string `json:"herdr"`
	// Live is true when events_v2 drives updates, false when polling.
	Live bool `json:"live"`
}

// BoardUpdate is a new status board.
type BoardUpdate struct {
	Board    herdr.Board `json:"board"`
	ListedAt string      `json:"listedAt"`
}

var (
	// BoardChanged is sent after every agent.list.
	BoardChanged = mygo.NewEvent[BoardUpdate]("board:changed")
	// StateChanged is sent when the connection changes.
	StateChanged = mygo.NewEvent[ConnState]("state:changed")
)

// Desk connects to one machine and keeps its board current.
type Desk struct {
	dir string // per-user data directory

	mu     sync.Mutex
	state  ConnState
	board  *BoardUpdate
	cancel context.CancelFunc
	// onBoard observes boards for the CI smoke capture.
	onBoard func(BoardUpdate)
}

func newDesk(dir string) *Desk {
	return &Desk{dir: dir, state: ConnState{Phase: "idle"}}
}

func (d *Desk) machinePath() string { return filepath.Join(d.dir, "machine.json") }

// Machine returns the saved connection, if any.
func (d *Desk) Machine() (*Machine, error) {
	data, err := os.ReadFile(d.machinePath())
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var m Machine
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

// State returns the current connection state.
func (d *Desk) State() ConnState {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.state
}

// Board returns the latest board, or nil before the first list.
func (d *Desk) Board() *BoardUpdate {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.board
}

// Connect saves the machine and connects to it, replacing any current
// connection. password is used only when the machine has no key file.
func (d *Desk) Connect(m Machine, password string) error {
	m.Host = strings.TrimSpace(m.Host)
	m.User = strings.TrimSpace(m.User)
	m.KeyPath = expandHome(strings.TrimSpace(m.KeyPath))
	if m.Port == 0 {
		m.Port = 22
	}
	switch {
	case m.Host == "" || m.User == "":
		return errors.New("host and user are required")
	case m.KeyPath == "" && password == "":
		return errors.New("a key file or a password is required")
	case !bridge.ValidSession(m.Session):
		return fmt.Errorf("invalid herdr session name %q", m.Session)
	}
	if err := d.save(m); err != nil {
		return err
	}
	d.start(m, password)
	return nil
}

// Disconnect closes the connection and forgets its board.
func (d *Desk) Disconnect() {
	d.mu.Lock()
	if d.cancel != nil {
		d.cancel()
		d.cancel = nil
	}
	d.board = nil
	d.mu.Unlock()
	d.setState(context.Background(), ConnState{Phase: "idle"})
}

func (d *Desk) save(m Machine) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(d.dir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(d.machinePath(), data, 0o600)
}

func (d *Desk) start(m Machine, password string) {
	ctx, cancel := context.WithCancel(context.Background())
	d.mu.Lock()
	if d.cancel != nil {
		d.cancel()
	}
	d.cancel = cancel
	d.board = nil
	d.mu.Unlock()
	go d.run(ctx, m, password)
}

// run connects and watches until ctx ends, reconnecting with backoff.
func (d *Desk) run(ctx context.Context, m Machine, password string) {
	label := fmt.Sprintf("%s@%s", m.User, m.Host)
	if m.Port != 22 {
		label += fmt.Sprintf(":%d", m.Port)
	}
	backoff := 2 * time.Second
	for ctx.Err() == nil {
		d.setState(ctx, ConnState{Phase: "connecting", Machine: label})
		listed, err := d.session(ctx, m, password, label)
		if ctx.Err() != nil {
			return
		}
		if listed {
			backoff = 2 * time.Second
		}
		var changed *bridge.HostKeyChangedError
		permanent := errors.As(err, &changed) || errors.Is(err, bridge.ErrHerdrNotInstalled) ||
			errors.Is(err, bridge.ErrHerdrIncompatible) || isAuthError(err)
		msg := err.Error()
		if !permanent {
			msg += fmt.Sprintf(" — retrying in %s", backoff)
		}
		d.setState(ctx, ConnState{Phase: "error", Machine: label, Message: msg})
		if permanent {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

// session runs one connection. listed reports whether a board arrived.
func (d *Desk) session(ctx context.Context, m Machine, password, label string) (listed bool, err error) {
	cfg := bridge.Config{
		Host: m.Host, Port: m.Port, User: m.User, Session: m.Session,
		Pins: bridge.NewFilePinStore(filepath.Join(d.dir, "host-keys.json")),
	}
	if m.KeyPath != "" {
		if cfg.KeyPEM, err = os.ReadFile(m.KeyPath); err != nil {
			return false, err
		}
	} else {
		cfg.Password = password
	}
	c, err := bridge.Dial(ctx, cfg)
	if err != nil {
		return false, err
	}
	defer c.Close()
	err = live.Watch(ctx, live.BridgeCaller{Client: c}, live.DefaultTiming, func(u live.Update) {
		if !listed {
			listed = true
			d.setState(ctx, ConnState{
				Phase: "connected", Machine: label, Live: u.Live,
				Herdr: fmt.Sprintf("herdr %s · protocol %d", u.Pong.Version, u.Pong.Protocol),
			})
		}
		b := BoardUpdate{Board: u.Board, ListedAt: u.Listed.Format(time.RFC3339)}
		// Broadcast only queues the message, so it runs under d.mu: a
		// Disconnect or new Connect cannot slip in between the check and
		// the publish and be overtaken by this stale board.
		d.mu.Lock()
		if ctx.Err() != nil { // replaced by a newer connection
			d.mu.Unlock()
			return
		}
		d.board = &b
		BoardChanged.Broadcast(b)
		observe := d.onBoard
		d.mu.Unlock()
		if observe != nil {
			observe(b)
		}
	})
	return listed, err
}

// setState publishes s unless ctx, the connection it describes, has been
// replaced. Connections are replaced under d.mu, and the publish happens
// under it too, so a replaced connection never overtakes its successor.
func (d *Desk) setState(ctx context.Context, s ConnState) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if ctx.Err() != nil {
		return
	}
	d.state = s
	StateChanged.Broadcast(s)
}

func isAuthError(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "unable to authenticate") ||
		strings.Contains(err.Error(), "read private key"))
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, p[1:])
		}
	}
	return p
}
