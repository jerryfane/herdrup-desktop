package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/gramstore"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
	"github.com/jerryfane/herdrup-desktop/internal/live"
)

// Machine is a saved connection. It holds no secret: the key stays in its
// file and a password is never written down.
type Machine struct {
	Nickname string `json:"nickname"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	KeyPath  string `json:"keyPath"`
	Session  string `json:"session"`
	// Paired hosts prefer the plain ed25519/RSA keys advertised by herdr pair,
	// rather than an unrelated ECDSA key or certificate served by the same sshd.
	Paired bool `json:"paired,omitempty"`
}

// SavedMachine is one machine in the saved set.
type SavedMachine struct {
	// ID is user@host:port, which identifies a machine in the set.
	ID string `json:"id"`
	Machine
	// Active marks the machine the desk connects to.
	Active bool `json:"active"`
}

// machineID identifies m in the saved set. The session is not part of it:
// it is the session last chosen on that machine.
func machineID(m Machine) string {
	port := m.Port
	if port == 0 {
		port = 22
	}
	return m.User + "@" + net.JoinHostPort(m.Host, strconv.Itoa(port))
}

// machineStore is machines.json: every saved machine and the active one.
type machineStore struct {
	Active   string    `json:"active"`
	Machines []Machine `json:"machines"`
}

func (s *machineStore) find(id string) int {
	for i, m := range s.Machines {
		if machineID(m) == id {
			return i
		}
	}
	return -1
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
	// Session is the herdr session the board shows, "" for the default.
	// The page forgets photos that failed when it changes (#42).
	Session string `json:"session"`
	// MachineID identifies the saved SSH connection that owns this board.
	MachineID string `json:"machineID"`
}

var (
	// BoardChanged is sent after every agent.list.
	BoardChanged = mygo.NewEvent[BoardUpdate]("board:changed")
	// StateChanged is sent when the connection changes.
	StateChanged = mygo.NewEvent[ConnState]("state:changed")
	// MachineStatusChanged is sent with the saved machines' statuses when
	// SetMachineFederation has re-read them.
	MachineStatusChanged = mygo.NewEvent[[]SavedMachineStatus]("machine-status:changed")
)

// Desk keeps a set of saved machines, connects to the active one and keeps
// its board current. One machine is connected at a time.
type Desk struct {
	dir string // per-user data directory

	storeMu       sync.Mutex // serialises reads and writes of machines.json
	notifications notificationSettings
	pairingMu     sync.Mutex
	pins          *bridge.FilePinStore

	mu    sync.Mutex
	state ConnState
	board *BoardUpdate
	// peers are the federation peers of board's agents.
	peers       []engine.PeerSummary
	cancel      context.CancelFunc
	link        *link // the current connection; nil when disconnected
	interaction *interaction
	settings    *settingsSession
	creation    *creationSession
	terminals   *terminalStore
	// onBoard observes boards for the CI smoke capture.
	onBoard func(BoardUpdate)
	// presence takes the agents needing you to the tray and notifications
	// (presence.go, tray.go).
	presence     *presence
	pendingAgent *AgentTarget
	// openFolders keeps the folders open on this device; alert shows a
	// folder save that failed.
	openFolders *openFolders
	alert       func(string)

	avatars  avatarStore  // desk_avatars.go
	sessions sessionWatch // desk_sessions.go

	gram gramDesk // desk_gram.go
	// saved is this device's saved Gram messages, read on first use.
	saved     *gramstore.Saved
	savedOnce sync.Once
	// cacheDir holds downloaded Gram files; "" is <dir>/cache.
	cacheDir string
	// The system's file dialogs, opener and clipboard (mygo), replaced in
	// tests.
	openDialog     func(ctx context.Context) ([]string, error)
	saveDialog     func(ctx context.Context, name string) (string, error)
	openPath       func(path string) error
	writeClipboard func(text string)
}

// link is the connection to the active machine. Its fields are guarded by
// Desk.mu.
type link struct {
	id string // machineID of the machine
	// session is the herdr session the board shows. Switching it keeps the
	// SSH connection.
	session string
	// sessionGen counts session switches, so a read begun on one session
	// is not taken for the session it switched back to.
	sessionGen uint64
	client     *bridge.Client // nil until connected
	// restart ends the current watch so the next one addresses session.
	restart context.CancelFunc
	// ctx is the current watch's; it ends when the session or connection
	// is replaced.
	ctx context.Context
	// agents are the latest list the board was built from, and groups the
	// session's folders and stars.
	agents []herdrapi.AgentInfo
	groups *groupsStore
	// needing are the panes that needed you in the watch's last list, nil
	// before its first: startedNeedingYou's baseline.
	needing map[string]bool
}

func newDesk(dir string) *Desk {
	return &Desk{
		dir: dir, state: ConnState{Phase: "idle"},
		openFolders: &openFolders{path: filepath.Join(dir, "open-folders.json")},
		terminals:   &terminalStore{path: filepath.Join(dir, "terminals.json")},
		pins:        bridge.NewFilePinStore(filepath.Join(dir, "host-keys.json")),
		alert:       alertGroups,
		openDialog:  mygoOpenDialog, saveDialog: mygoSaveDialog, openPath: mygoOpenPath, writeClipboard: mygoWriteText,
		presence: newPresence(),
	}
}

func (d *Desk) machinesPath() string { return filepath.Join(d.dir, "machines.json") }

// legacyMachinePath is the single machine saved before the desk kept a set.
func (d *Desk) legacyMachinePath() string { return filepath.Join(d.dir, "machine.json") }

// load reads the saved machines. Before machines.json exists it imports the
// single machine.json as the active machine. d.storeMu must be held.
func (d *Desk) load() (machineStore, error) {
	var st machineStore
	data, err := os.ReadFile(d.machinesPath())
	if err == nil {
		err = json.Unmarshal(data, &st)
		return st, err
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return st, err
	}
	data, err = os.ReadFile(d.legacyMachinePath())
	if errors.Is(err, fs.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	var m Machine
	if err := json.Unmarshal(data, &m); err != nil {
		return st, err
	}
	if m.Port == 0 {
		m.Port = 22
	}
	return machineStore{Active: machineID(m), Machines: []Machine{m}}, nil
}

// store writes the saved machines. d.storeMu must be held. machine.json is
// left as it was, so an older build still finds its machine.
func (d *Desk) store(st machineStore) error {
	if st.Machines == nil {
		st.Machines = []Machine{}
	}
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(d.dir, 0o700); err != nil {
		return err
	}
	tmp := d.machinesPath() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, d.machinesPath())
}

// Machine returns the active saved machine, if any.
func (d *Desk) Machine() (*Machine, error) {
	d.storeMu.Lock()
	defer d.storeMu.Unlock()
	st, err := d.load()
	if err != nil {
		return nil, err
	}
	i := st.find(st.Active)
	if st.Active == "" || i < 0 {
		return nil, nil
	}
	return &st.Machines[i], nil
}

// Machines returns every saved machine, in the order they were added.
func (d *Desk) Machines() ([]SavedMachine, error) {
	d.storeMu.Lock()
	defer d.storeMu.Unlock()
	st, err := d.load()
	if err != nil {
		return nil, err
	}
	out := make([]SavedMachine, 0, len(st.Machines))
	for _, m := range st.Machines {
		id := machineID(m)
		out = append(out, SavedMachine{ID: id, Machine: m, Active: st.Active != "" && id == st.Active})
	}
	return out, nil
}

// SaveMachine updates the saved profile without opening a connection. A running
// connection keeps its existing credentials until the user reconnects.
func (d *Desk) SaveMachine(m Machine, replacing string) error {
	m.Nickname = strings.TrimSpace(m.Nickname)
	m.Host = strings.TrimSpace(m.Host)
	m.User = strings.TrimSpace(m.User)
	m.KeyPath = expandHome(strings.TrimSpace(m.KeyPath))
	if m.Port == 0 {
		m.Port = 22
	}
	if m.Host == "" || m.User == "" {
		return errors.New("host and user are required")
	}
	if !bridge.ValidSession(m.Session) {
		return fmt.Errorf("invalid herdr session name %q", m.Session)
	}
	d.storeMu.Lock()
	defer d.storeMu.Unlock()
	st, err := d.load()
	if err != nil {
		return err
	}
	id := machineID(m)
	index := st.find(replacing)
	if replacing != "" && index < 0 {
		return errors.New("the saved host no longer exists")
	}
	if duplicate := st.find(id); duplicate >= 0 && duplicate != index {
		return errors.New("that host and user are already saved")
	}
	if index < 0 {
		st.Machines = append(st.Machines, m)
	} else {
		st.Machines[index] = m
		if st.Active == replacing {
			st.Active = id
		}
	}
	return d.store(st)
}

// SelectMachine makes a saved machine the active one and connects to it,
// replacing any current connection. password is used only when the
// machine has no key file.
func (d *Desk) SelectMachine(id, password string) error {
	d.storeMu.Lock()
	st, err := d.load()
	if err != nil {
		d.storeMu.Unlock()
		return err
	}
	i := st.find(id)
	if i < 0 {
		d.storeMu.Unlock()
		return fmt.Errorf("no saved machine %q", id)
	}
	m := st.Machines[i]
	if m.KeyPath == "" && password == "" {
		d.storeMu.Unlock()
		return errors.New("a password is required")
	}
	st.Active = id
	err = d.store(st)
	d.storeMu.Unlock()
	if err != nil {
		return err
	}
	d.start(m, password)
	return nil
}

// RemoveMachine forgets a saved machine. Removing the active machine
// disconnects it and leaves no machine active.
func (d *Desk) RemoveMachine(id string) error {
	d.storeMu.Lock()
	st, err := d.load()
	if err != nil {
		d.storeMu.Unlock()
		return err
	}
	i := st.find(id)
	if i < 0 {
		d.storeMu.Unlock()
		return nil
	}
	st.Machines = append(st.Machines[:i], st.Machines[i+1:]...)
	wasActive := st.Active == id
	if wasActive {
		st.Active = ""
	}
	err = d.store(st)
	d.storeMu.Unlock()
	if err != nil {
		return err
	}
	d.mu.Lock()
	connected := d.link != nil && d.link.id == id
	d.mu.Unlock()
	if wasActive || connected {
		d.Disconnect()
	}
	return nil
}

// Sessions lists the herdr sessions on the connected machine. A herdr
// without named sessions has only the default one.
func (d *Desk) Sessions(ctx context.Context) ([]bridge.Session, error) {
	d.mu.Lock()
	var c *bridge.Client
	if d.link != nil {
		c = d.link.client
	}
	d.mu.Unlock()
	if c == nil {
		return nil, errors.New("not connected")
	}
	return c.ListSessions(ctx)
}

// SelectSession switches the active machine to another herdr session and
// remembers it. A connected machine keeps its SSH connection; only the
// board changes. The window is sent an empty board at once, with no
// ListedAt, so it stops showing the old session's agents before the new
// session's list arrives.
func (d *Desk) SelectSession(name string) error {
	return d.selectSession(name, nil)
}

// selectSession is SelectSession. When at is not nil the switch is made
// only if the board still shows the link and session generation at names;
// that is checked under d.storeMu and d.mu and they are held until the
// switch is saved and made, so no other switch can come in between.
func (d *Desk) selectSession(name string, at *boardSession) error {
	if !bridge.ValidSession(name) {
		return fmt.Errorf("invalid herdr session name %q", name)
	}
	d.storeMu.Lock()
	defer d.storeMu.Unlock()
	d.mu.Lock()
	if at != nil && !d.currentLocked(*at) {
		d.mu.Unlock()
		return nil
	}
	st, err := d.load()
	if err != nil {
		d.mu.Unlock()
		return err
	}
	i := st.find(st.Active)
	if st.Active == "" || i < 0 {
		d.mu.Unlock()
		return errors.New("no active machine")
	}
	st.Machines[i].Session = name
	if err := d.store(st); err != nil {
		d.mu.Unlock()
		return err
	}
	l := d.link
	if l == nil || l.id != st.Active || l.session == name {
		d.mu.Unlock()
		return nil
	}
	from := l.session
	l.session = name
	// A board of the new session seen in the last minute stands in until
	// its list arrives, as herdrup's SessionSwitchCache does.
	seeded := d.sessionSwitched(from, name, d.board, time.Now())
	l.sessionGen++
	if d.settings != nil {
		d.settings.cancel()
	}
	d.board, d.peers = nil, nil
	if l.restart != nil {
		l.restart()
	}
	// Under d.mu, like every board publish, so the new session's first
	// board cannot be overtaken by this cleared one.
	l.agents, l.groups = nil, nil
	cleared := BoardUpdate{Board: herdr.BuildBoard(nil, herdr.View{}), Session: name, MachineID: l.id}
	if seeded != nil {
		cleared.Board = *seeded
	}
	BoardChanged.Broadcast(cleared)
	d.presence.show(needingRows(cleared.Board), l.id, name)
	observe := d.onBoard
	d.mu.Unlock()
	if observe != nil {
		observe(cleared)
	}
	return nil
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
	m.Nickname = strings.TrimSpace(m.Nickname)
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
	if err := d.remember(m); err != nil {
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
	d.link = nil
	d.board, d.peers = nil, nil
	d.presence.show(nil, "", "")
	d.mu.Unlock()
	d.gramReset(nil, "")
	d.gramWipeCacheUnlessOwner("")
	d.setState(context.Background(), ConnState{Phase: "idle"})
}

// remember saves m, replacing the saved machine with its ID, and makes it
// the active machine.
func (d *Desk) remember(m Machine) error {
	d.storeMu.Lock()
	defer d.storeMu.Unlock()
	st, err := d.load()
	if err != nil {
		return err
	}
	id := machineID(m)
	if i := st.find(id); i >= 0 {
		st.Machines[i] = m
	} else {
		st.Machines = append(st.Machines, m)
	}
	st.Active = id
	return d.store(st)
}

func (d *Desk) start(m Machine, password string) {
	ctx, cancel := context.WithCancel(context.Background())
	l := &link{id: machineID(m), session: m.Session}
	d.mu.Lock()
	if d.cancel != nil {
		d.cancel()
	}
	d.cancel = cancel
	d.link = l
	d.board, d.peers = nil, nil
	d.presence.show(nil, "", "")
	d.mu.Unlock()
	// Gram belongs to the connection; its downloads to the machine.
	d.gramReset(l, m.Host)
	d.gramWipeCacheUnlessOwner(l.id)
	go d.run(ctx, l, m, password)
}

// run connects and watches until ctx ends, reconnecting with backoff.
func (d *Desk) run(ctx context.Context, l *link, m Machine, password string) {
	label := m.User + "@" + m.Host
	if m.Port != 22 {
		label = m.User + "@" + net.JoinHostPort(m.Host, strconv.Itoa(m.Port))
	}
	backoff := 2 * time.Second
	for ctx.Err() == nil {
		d.setState(ctx, ConnState{Phase: "connecting", Machine: label})
		listed, err := d.session(ctx, l, m, password, label)
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
// Switching session (SelectSession) restarts the watch on a view of the
// same connection.
func (d *Desk) session(ctx context.Context, l *link, m Machine, password, label string) (listed bool, err error) {
	cfg := bridge.Config{
		Host: m.Host, Port: m.Port, User: m.User, Session: m.Session,
		Pins: d.pins,
	}
	if m.Paired {
		cfg.HostKeyAlgorithms = pairingHostKeyAlgorithms
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
	d.mu.Lock()
	l.client = c
	d.mu.Unlock()
	sctx, stopSessions := context.WithCancel(ctx)
	defer stopSessions()
	go d.watchSessions(sctx, l, c)
	go d.watchGram(sctx, l)
	defer func() {
		d.mu.Lock()
		l.client, l.restart = nil, nil
		d.mu.Unlock()
	}()
	for {
		wctx, restart := context.WithCancel(ctx)
		d.mu.Lock()
		l.restart = restart
		name := l.session
		d.mu.Unlock()
		view, err := c.ForSession(name)
		if err != nil {
			restart()
			return listed, err
		}
		ec := engine.New(engine.Bridge(view))
		groups := newGroupsStore(d.openFolders, openFoldersKey(m.Host, m.Port, name),
			func() { d.republish(wctx, l) }, d.alert)
		d.mu.Lock()
		// A new watch, on a new connection or session, starts from a new
		// baseline: what needs you as it connects is not news.
		l.ctx, l.groups, l.agents, l.needing = wctx, groups, nil, nil
		d.mu.Unlock()
		shown := false
		err = live.Watch(wctx, ec, live.DefaultTiming, func(u live.Update) {
			if u.ExitedPaneID != "" {
				d.mu.Lock()
				if wctx.Err() == nil {
					for _, a := range l.agents {
						if a.PaneID == u.ExitedPaneID && a.Archived == nil {
							d.presence.notifyEvent(a, l.id, l.session, "dies")
							break
						}
					}
				}
				d.mu.Unlock()
				return
			}
			if !shown {
				shown, listed = true, true
				groups.attach(ec, u.Pong)
				d.setState(wctx, ConnState{
					Phase: "connected", Machine: label, Live: u.Live,
					Herdr: fmt.Sprintf("herdr %s · protocol %d", u.Pong.Version, u.Pong.Protocol),
				})
			}
			// The first list loads the folders, later ones refresh them at
			// most once a minute, never holding up the list.
			go groups.refresh(wctx, false)
			peers := engine.PeerSummaries(u.Agents)
			d.mu.Lock()
			if wctx.Err() != nil { // replaced by a newer connection or session
				d.mu.Unlock()
				return
			}
			l.agents, d.peers = u.Agents, peers
			var started []herdrapi.AgentInfo
			l.needing, started = startedNeedingYou(l.needing, u.Agents)
			d.presence.notify(started, l.id, l.session)
			if u.FinishedPaneID != "" {
				for _, a := range u.Agents {
					if a.PaneID == u.FinishedPaneID {
						d.presence.notifyEvent(a, l.id, l.session, "finishes")
						break
					}
				}
			}
			d.publishLocked(BoardUpdate{Board: herdr.BuildBoard(u.Agents, groups.view()), ListedAt: u.Listed.Format(time.RFC3339), Session: l.session, MachineID: l.id})
		})
		switched := ctx.Err() == nil && wctx.Err() != nil
		restart()
		if !switched {
			return listed, err
		}
	}
}

// publishLocked shows b and unlocks d.mu. Broadcast only queues the
// message, so it runs under d.mu: a Disconnect, new Connect or session
// switch cannot slip in between the caller's check and the publish and be
// overtaken by this stale board.
func (d *Desk) publishLocked(b BoardUpdate) {
	d.board = &b
	BoardChanged.Broadcast(b)
	d.presence.show(needingRows(b.Board), b.MachineID, b.Session)
	observe := d.onBoard
	d.mu.Unlock()
	if observe != nil {
		observe(b)
	}
}

// republish rebuilds the board of watch ctx from its last list, after its
// folders, stars or open folders changed.
func (d *Desk) republish(ctx context.Context, l *link) {
	d.mu.Lock()
	if ctx.Err() != nil || d.link != l || l.groups == nil || d.board == nil {
		d.mu.Unlock()
		return
	}
	d.publishLocked(BoardUpdate{Board: herdr.BuildBoard(l.agents, l.groups.view()), ListedAt: d.board.ListedAt, Session: l.session, MachineID: l.id})
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
