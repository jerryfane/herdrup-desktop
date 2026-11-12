package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
	"golang.org/x/crypto/ssh"
)

// groupsServer is a herdr's agent.groups store. set answers a set with
// the stored document or an error; by default it stores the document at
// the next revision, refusing a stale one with groups_conflict.
type groupsServer struct {
	mu    sync.Mutex
	caps  bool
	doc   herdr.Groups
	gets  int
	sets  []herdrapi.AgentGroupsSetParams
	err   map[string]*bridge.APIError // by method, for every call
	other func()                      // runs before each set: another device saving first
	// refuse, when set, may refuse a set that is not stale, as herdr
	// refuses an invalid document.
	refuse func(herdrapi.AgentGroupsSetParams) *bridge.APIError
}

func (g *groupsServer) Call(_ context.Context, method string, params, result any) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	reply := func(v any) error {
		b, _ := json.Marshal(v)
		return json.Unmarshal(b, result)
	}
	if e := g.err[method]; e != nil {
		return e
	}
	switch method {
	case "ping":
		return reply(map[string]any{"type": "pong", "protocol": 22, "capabilities": map[string]bool{"agent_groups": g.caps}})
	case "agent.groups.get":
		g.gets++
		return reply(map[string]any{"type": "agent_groups", "revision": g.doc.Revision, "folders": g.doc.Folders, "stars": g.doc.Stars})
	case "agent.groups.set":
		var p herdrapi.AgentGroupsSetParams
		b, _ := json.Marshal(params)
		_ = json.Unmarshal(b, &p)
		if g.other != nil {
			g.other()
		}
		g.sets = append(g.sets, p)
		if p.Revision != g.doc.Revision {
			current, _ := json.Marshal(map[string]any{"type": "agent_groups", "revision": g.doc.Revision, "folders": g.doc.Folders, "stars": g.doc.Stars})
			raw, _ := json.Marshal(map[string]any{"code": "groups_conflict", "message": "stale", "current": json.RawMessage(current)})
			return &bridge.APIError{Code: "groups_conflict", Message: "stale", Raw: raw}
		}
		if g.refuse != nil {
			if e := g.refuse(p); e != nil {
				return e
			}
		}
		g.doc = herdr.Groups{Revision: p.Revision + 1, Folders: p.Folders, Stars: p.Stars}
		return reply(map[string]any{"type": "agent_groups", "revision": g.doc.Revision, "folders": g.doc.Folders, "stars": g.doc.Stars})
	}
	return &bridge.APIError{Code: "unknown_method", Message: method}
}

func (g *groupsServer) OpenStream(context.Context, string, any) (engine.Stream, error) {
	return nil, errors.New("no streams")
}

func (g *groupsServer) Done() <-chan struct{} { return nil }

type storeHarness struct {
	srv     *groupsServer
	store   *groupsStore
	changes chan struct{}
	alerts  chan string
	clock   time.Time
}

func newStoreHarness(t *testing.T, caps bool, doc herdr.Groups) *storeHarness {
	t.Helper()
	h := &storeHarness{srv: &groupsServer{caps: caps, doc: doc}, changes: make(chan struct{}, 64), alerts: make(chan string, 8), clock: time.Unix(1000, 0)}
	open := &openFolders{path: filepath.Join(t.TempDir(), "open-folders.json")}
	h.store = newGroupsStore(open, "host:22", func() { h.changes <- struct{}{} }, func(m string) { h.alerts <- m })
	h.store.now = func() time.Time { return h.clock }
	c := engine.New(h.srv)
	pong, err := c.Ping(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	h.store.attach(c, pong)
	return h
}

// settle waits for the store to finish sending.
func (h *storeHarness) settle(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		h.store.mu.Lock()
		busy := h.store.sending
		h.store.mu.Unlock()
		if !busy {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("edits never finished sending")
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func stars(g *herdr.Groups) []string {
	if g == nil {
		return nil
	}
	return g.Stars
}

func TestGroupsHiddenWithoutTheCapability(t *testing.T) {
	h := newStoreHarness(t, false, herdr.Groups{Revision: 1, Stars: []string{"a"}})
	h.store.refresh(context.Background(), false)
	if h.store.document() != nil || h.srv.gets != 0 {
		t.Fatalf("document %+v after %d gets on a herdr without agent_groups", h.store.document(), h.srv.gets)
	}
}

func TestGroupsRefreshAtMostEveryMinute(t *testing.T) {
	h := newStoreHarness(t, true, herdr.Groups{Revision: 1, Stars: []string{"a"}})
	ctx := context.Background()
	h.store.refresh(ctx, false)
	if !reflect.DeepEqual(stars(h.store.document()), []string{"a"}) {
		t.Fatalf("after the first refresh: %+v", h.store.document())
	}
	h.srv.doc = herdr.Groups{Revision: 2, Stars: []string{"b"}}
	h.clock = h.clock.Add(59 * time.Second)
	h.store.refresh(ctx, false)
	if h.srv.gets != 1 {
		t.Fatalf("refreshed again within a minute (%d gets)", h.srv.gets)
	}
	h.clock = h.clock.Add(time.Second)
	h.store.refresh(ctx, false)
	if !reflect.DeepEqual(stars(h.store.document()), []string{"b"}) {
		t.Fatalf("a minute later: %+v", h.store.document())
	}
	// An older revision than the one shown is ignored.
	h.srv.doc = herdr.Groups{Revision: 1, Stars: []string{"old"}}
	h.store.refresh(ctx, true)
	if !reflect.DeepEqual(stars(h.store.document()), []string{"b"}) {
		t.Fatalf("an older document replaced a newer one: %+v", h.store.document())
	}
}

func TestGroupsGuestOrOldServerTurnsFoldersOff(t *testing.T) {
	h := newStoreHarness(t, true, herdr.Groups{Revision: 1})
	h.srv.err = map[string]*bridge.APIError{"agent.groups.get": {Code: "guest_forbidden", Message: "owner only"}}
	h.store.refresh(context.Background(), false)
	if h.store.document() != nil || h.store.supported {
		t.Fatal("a guest sees folders")
	}
}

func TestGroupsEditShowsAtOnceAndIsSent(t *testing.T) {
	h := newStoreHarness(t, true, herdr.Groups{Revision: 4})
	ctx := context.Background()
	h.store.refresh(ctx, false)
	h.srv.mu.Lock() // hold the server so the edit is still pending
	h.store.apply(ctx, herdr.Edit{Kind: herdr.EditSetStar, Name: "a", Star: true})
	if got := stars(h.store.document()); !reflect.DeepEqual(got, []string{"a"}) {
		h.srv.mu.Unlock()
		t.Fatalf("pending edit not shown: %q", got)
	}
	h.srv.mu.Unlock()
	h.settle(t)
	if len(h.srv.sets) != 1 || h.srv.sets[0].Revision != 4 || !reflect.DeepEqual(h.srv.sets[0].Stars, []string{"a"}) {
		t.Fatalf("sets %+v", h.srv.sets)
	}
	if g := h.store.document(); g.Revision != 5 {
		t.Fatalf("confirmed revision %d, want 5", g.Revision)
	}
	// Starring again changes nothing and is not sent.
	h.store.apply(ctx, herdr.Edit{Kind: herdr.EditSetStar, Name: "a", Star: true})
	h.settle(t)
	if len(h.srv.sets) != 1 {
		t.Fatalf("a no-op edit was sent: %+v", h.srv.sets)
	}
}

func TestGroupsConflictReplaysOnceThenGivesUp(t *testing.T) {
	h := newStoreHarness(t, true, herdr.Groups{Revision: 1})
	ctx := context.Background()
	h.store.refresh(ctx, false)
	// Another device starred b first: the edit is replayed onto it.
	h.srv.doc = herdr.Groups{Revision: 2, Stars: []string{"b"}}
	h.store.apply(ctx, herdr.Edit{Kind: herdr.EditSetStar, Name: "a", Star: true})
	h.settle(t)
	if len(h.srv.sets) != 2 || h.srv.sets[1].Revision != 2 || !reflect.DeepEqual(h.srv.sets[1].Stars, []string{"b", "a"}) {
		t.Fatalf("sets %+v", h.srv.sets)
	}
	if got := stars(h.store.document()); !reflect.DeepEqual(got, []string{"b", "a"}) {
		t.Fatalf("after the replay: %q", got)
	}
	select {
	case m := <-h.alerts:
		t.Fatalf("alert %q after a replay that saved", m)
	default:
	}

	// Another device saves before every set: the second conflict is shown
	// and the newest document kept.
	h.srv.other = func() { h.srv.doc.Revision++ }
	h.store.apply(ctx, herdr.Edit{Kind: herdr.EditSetStar, Name: "c", Star: true})
	h.settle(t)
	if m := <-h.alerts; m != groupsConflictMessage {
		t.Fatalf("alert %q", m)
	}
	if got := h.store.document(); got.Revision != h.srv.doc.Revision || !reflect.DeepEqual(got.Stars, []string{"b", "a"}) {
		t.Fatalf("after giving up: %+v, server at %d", got, h.srv.doc.Revision)
	}
}

func TestGroupsRefusedEditIsDropped(t *testing.T) {
	h := newStoreHarness(t, true, herdr.Groups{Revision: 1})
	ctx := context.Background()
	h.store.refresh(ctx, false)
	h.srv.err = map[string]*bridge.APIError{"agent.groups.set": {Code: "invalid_groups", Message: "name too long"}}
	h.store.apply(ctx, herdr.Edit{Kind: herdr.EditSetStar, Name: "a", Star: true})
	h.settle(t)
	if m := <-h.alerts; m != "The server refused the change: name too long" {
		t.Fatalf("alert %q", m)
	}
	if got := stars(h.store.document()); len(got) != 0 {
		t.Fatalf("a refused edit is still shown: %q", got)
	}
}

// #37: another device fills the stars to the limit before this device's
// conflicting star is replayed, and the replay is refused. The document the
// conflict reported is what the server has: the store keeps it, rather
// than the one from before the conflict.
func TestGroupsRefusedReplayKeepsTheConflictDocument(t *testing.T) {
	for _, tc := range []struct {
		name  string
		err   *bridge.APIError
		alert string
	}{
		{"invalid_groups", &bridge.APIError{Code: "invalid_groups", Message: "too many stars"}, "The server refused the change: too many stars"},
		{"other error", &bridge.APIError{Code: "server_unavailable", Message: "reloading"}, "Couldn't save folders: "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newStoreHarness(t, true, herdr.Groups{Revision: 1})
			ctx := context.Background()
			h.store.refresh(ctx, false)
			h.srv.doc = herdr.Groups{Revision: 2, Stars: []string{"b", "c"}}
			h.srv.refuse = func(herdrapi.AgentGroupsSetParams) *bridge.APIError { return tc.err }
			h.store.apply(ctx, herdr.Edit{Kind: herdr.EditSetStar, Name: "a", Star: true})
			h.settle(t)
			if len(h.srv.sets) != 2 {
				t.Fatalf("sets %+v, want the edit and its replay", h.srv.sets)
			}
			if m := <-h.alerts; !strings.HasPrefix(m, tc.alert) {
				t.Fatalf("alert %q", m)
			}
			got := h.store.document()
			if got == nil || got.Revision != 2 || !reflect.DeepEqual(got.Stars, []string{"b", "c"}) {
				t.Fatalf("after the refused replay: %+v, want the server's revision 2 with b and c", got)
			}
		})
	}
}

func TestCreateFolderOpensItAndPersistsOpenFolders(t *testing.T) {
	h := newStoreHarness(t, true, herdr.Groups{Revision: 1})
	ctx := context.Background()
	h.store.refresh(ctx, false)
	h.store.createFolder(ctx, "   ", "a")
	if g := h.store.document(); len(g.Folders) != 0 {
		t.Fatalf("a blank name made a folder: %+v", g.Folders)
	}
	h.store.createFolder(ctx, "  Review ", "a")
	h.settle(t)
	g := h.store.document()
	if len(g.Folders) != 1 || g.Folders[0].Name != "Review" || !reflect.DeepEqual(g.Folders[0].Members, []string{"a"}) {
		t.Fatalf("folders %+v", g.Folders)
	}
	id := g.Folders[0].ID
	if !h.store.view().Open[id] {
		t.Fatal("a new folder is not open")
	}
	// Another store for the same machine (a restart) finds it open; one for
	// another session does not.
	again := &openFolders{path: h.store.open.path}
	if !again.get("host:22")[id] || again.get("host:22#work")[id] {
		t.Fatalf("persisted %v", again.get("host:22"))
	}
	h.store.setOpen(id, false)
	data, _ := os.ReadFile(h.store.open.path)
	if string(data) != "{}" {
		t.Fatalf("after closing: %s", data)
	}
}

func TestOpenFoldersKey(t *testing.T) {
	for _, tc := range []struct {
		host    string
		port    int
		session string
		want    string
	}{
		{" Box.Example. ", 22, "", "box.example:22"},
		{"[::1]", 2222, "default", "::1:2222"},
		{"box", 22, "work", "box:22#work"},
	} {
		if got := openFoldersKey(tc.host, tc.port, tc.session); got != tc.want {
			t.Errorf("%q %d %q: %q, want %q", tc.host, tc.port, tc.session, got, tc.want)
		}
	}
}

// labels flattens menu entries, a submenu as "Label>[…]".
func labels(es []menuEntry) []string {
	var out []string
	for _, e := range es {
		if e.Sub != nil {
			out = append(out, e.Label+">"+join(labels(e.Sub)))
			continue
		}
		out = append(out, e.Label)
	}
	return out
}

func join(s []string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func TestAgentAndFolderMenus(t *testing.T) {
	g := &herdr.Groups{Stars: []string{"a"}, Folders: []herdrapi.AgentGroupFolder{
		{ID: "y", Name: "Second", Order: 1},
		{ID: "x", Name: "First", Order: 0, Members: []string{"a"}},
		{ID: "z", Name: "Third", Order: 2},
	}}
	if got, want := labels(agentMenu(g, "a")), []string{"Unstar", `Move to folder>["Second","Third","New folder…","Remove from First"]`}; !reflect.DeepEqual(got, want) {
		t.Errorf("starred agent in a folder: %q", got)
	}
	if got, want := labels(agentMenu(g, "b")), []string{"Star", `Move to folder>["First","Second","Third","New folder…"]`}; !reflect.DeepEqual(got, want) {
		t.Errorf("loose agent: %q", got)
	}
	if agentMenu(g, "") != nil || agentMenu(nil, "a") != nil {
		t.Error("menu for an agent with no name or without folders")
	}
	if e := agentMenu(g, "b")[1].Sub[3]; e.Naming == nil || e.Naming.Kind != "new" || e.Naming.Member != "b" {
		t.Errorf("New folder… entry %+v", e)
	}
	for id, want := range map[string][]string{
		"x": {"Rename", "Move down", "Delete folder"},
		"y": {"Rename", "Move up", "Move down", "Delete folder"},
		"z": {"Rename", "Move up", "Delete folder"},
	} {
		if got := labels(folderMenu(g, id)); !reflect.DeepEqual(got, want) {
			t.Errorf("folder %s: %q", id, got)
		}
	}
	if folderMenu(g, "gone") != nil {
		t.Error("menu for a folder that is gone")
	}
}

func TestDeskBoardShowsFoldersAndOpensThem(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	hostKey, _ := ssh.NewSignerFromKey(priv)
	_, clientPriv, _ := ed25519.GenerateKey(rand.Reader)
	client, _ := ssh.NewSignerFromKey(clientPriv)
	block, _ := ssh.MarshalPrivateKey(clientPriv, "")
	keyPath := filepath.Join(t.TempDir(), "id")
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatal(err)
	}
	srv := &fakeherdr.Server{
		HostKey: hostKey, Authorized: client.PublicKey(),
		Handle: func(method string, _ json.RawMessage) (any, *fakeherdr.APIError) {
			switch method {
			case "ping":
				return map[string]any{"type": "pong", "version": "t", "protocol": 22,
					"capabilities": map[string]bool{"api_bridge_multi": true, "agent_groups": true}}, nil
			case "agent.list":
				return map[string]any{"type": "agent_list", "agents": []any{
					map[string]any{"pane_id": "p1", "name": "rev", "agent_status": "blocked"},
					map[string]any{"pane_id": "p2", "name": "web", "agent_status": "working"},
				}}, nil
			case "agent.groups.get":
				return map[string]any{"type": "agent_groups", "revision": 1, "stars": []string{"web"},
					"folders": []any{map[string]any{"id": "f1", "name": "Review", "order": 0, "members": []string{"rev"}}}}, nil
			}
			return nil, &fakeherdr.APIError{Code: "unknown_method", Message: method}
		},
	}
	addr, err := srv.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	host, portStr, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portStr)
	d := newDesk(t.TempDir())
	d.alert = func(m string) { t.Errorf("alert %q", m) }
	defer d.Disconnect()
	if err := d.Connect(Machine{Host: host, Port: port, User: "dev", KeyPath: keyPath}, ""); err != nil {
		t.Fatal(err)
	}
	shape := func() string {
		b := d.Board()
		if b == nil {
			return ""
		}
		var s string
		for _, sec := range b.Board.Sections {
			for _, it := range sec.Items {
				if it.Folder != nil {
					s += "[" + it.Folder.ID + " " + strconv.FormatBool(it.Folder.Open) + "]"
				} else {
					s += it.Row.ID + strconv.FormatBool(it.Row.Starred) + it.Row.FolderID + " "
				}
			}
		}
		return s
	}
	waitFor(t, "the folder on the board", func() bool { return shape() == "[f1 false]p2true " })
	d.SetFolderOpen("f1", true)
	waitFor(t, "the folder open", func() bool { return shape() == "[f1 true]p1falsef1 p2true " })
	if sb := d.SearchBoard("we"); sb == nil || len(sb.Sections) != 1 || sb.Sections[0].Items[0].Row.ID != "p2" || len(sb.EmptyFolders) != 0 {
		t.Fatalf("search board %+v", sb)
	}
}
