package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// gramDeskFor connects a desk to a fake herdr whose Gram is g.
func gramDeskFor(t *testing.T, g *fakeherdr.Gram) *Desk {
	t.Helper()
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		inner := s.Handle
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if res, err, ok := g.Handle(method, params); ok {
				return res, err
			}
			return inner(method, params)
		}
		s.Duplex = g.Duplex
	})
	// Under a name filepath.Glob reads as a pattern (#547 review): the cache
	// takes the path as it is.
	d.cacheDir = filepath.Join(t.TempDir(), "herdrup-cache-[review]")
	// Before cacheDir's cleanup, which runs first: nothing downloads into it
	// once it goes.
	t.Cleanup(d.Disconnect)
	return d
}

func agentMsg(id, text string, unread bool) herdrapi.GramMessageInfo {
	return herdrapi.GramMessageInfo{ID: id, Direction: herdrapi.GramDirectionAgentToOwner, From: "vetrina",
		Text: text, CreatedUnixMs: uint64(time.Now().UnixMilli()), ReadByOwner: !unread}
}

func snapIDs(s GramSnapshot) []string {
	var out []string
	for _, m := range s.Messages {
		out = append(out, m.ID)
	}
	return out
}

func TestGramLoadsPostsMarksAndDeletes(t *testing.T) {
	g := fakeherdr.NewGram("store-1")
	g.Add(agentMsg("a1", "first", false), nil)
	g.Add(agentMsg("a2", "second", true), nil)
	d := gramDeskFor(t, g)
	ctx := context.Background()

	if err := d.GramRefresh(ctx); err != nil {
		t.Fatal(err)
	}
	s := d.GramState()
	if s.Phase != "loaded" || !slices.Equal(snapIDs(s), []string{"a2", "a1"}) || s.UnreadCount != 1 || s.Status != "Refreshed" {
		t.Fatalf("after load: %+v", s)
	}
	if s.Messages[0].Machine != "127.0.0.1" || len(s.Agents) != 1 || s.Agents[0].From != "vetrina" {
		t.Fatalf("local sender machine %q agents %+v", s.Messages[0].Machine, s.Agents)
	}
	// A second refresh is answered unchanged against the digest.
	if err := d.GramRefresh(ctx); err != nil {
		t.Fatal(err)
	}
	if s := d.GramState(); s.Status != "Up to date" {
		t.Fatalf("status %q", s.Status)
	}
	calls := g.Calls()
	var last herdrapi.GramListParams
	_ = json.Unmarshal(calls[len(calls)-1].Params, &last)
	if last.IfUnchangedDigest == nil || last.Limit == nil || *last.Limit != 40 {
		t.Fatalf("second head poll %+v", last)
	}

	if err := d.GramMarkRead(ctx, "a2"); err != nil {
		t.Fatal(err)
	}
	if s := d.GramState(); s.UnreadCount != 0 || s.Messages[0].Unread {
		t.Fatalf("after mark: %+v", s.Messages[0])
	}

	// A post shows at once, before any list has it.
	if err := d.GramPost(ctx, "  ship it  ", []string{"vetrina"}, nil); err != nil {
		t.Fatal(err)
	}
	s = d.GramState()
	if len(s.Messages) != 3 || !s.Messages[0].Pending || s.Messages[0].Text != "ship it" ||
		s.Messages[0].StatusVerb != "Delivered" || s.Messages[0].StatusRest != "to vetrina" || s.DraftPosted != 1 {
		t.Fatalf("after post: %+v", s.Messages[0])
	}
	if err := d.GramRefresh(ctx); err != nil {
		t.Fatal(err)
	}
	if s := d.GramState(); s.Messages[0].Pending {
		t.Fatal("a listed post still pending")
	}

	if err := d.GramDelete(ctx, "a1"); err != nil {
		t.Fatal(err)
	}
	if s := d.GramState(); slices.Contains(snapIDs(s), "a1") {
		t.Fatal("deleted row still shown")
	}
	// A poll that raced the delete still lists the row: it stays hidden.
	g.Add(agentMsg("a1", "first", false), nil)
	_ = d.GramRefresh(ctx)
	if s := d.GramState(); slices.Contains(snapIDs(s), "a1") {
		t.Fatal("a racing poll brought back a deleted row")
	}
	if err := d.GramDelete(ctx, "nope"); err == nil || !strings.HasPrefix(d.GramState().Status, "Couldn't delete: ") {
		t.Fatalf("delete of an unknown id: %v, status %q", err, d.GramState().Status)
	}
}

func TestGramAttachmentUploadsPostsAndOpensFromTheCache(t *testing.T) {
	g := fakeherdr.NewGram("store-1")
	d := gramDeskFor(t, g)
	ctx := context.Background()
	if err := d.GramRefresh(ctx); err != nil {
		t.Fatal(err)
	}
	data := bytes.Repeat([]byte("gram "), 300_000) // 1.5 MB: several stream frames
	path := filepath.Join(t.TempDir(), "notes.txt")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	big := filepath.Join(t.TempDir(), "big.bin")
	if err := os.WriteFile(big, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(big, 100<<20+1); err != nil {
		t.Fatal(err)
	}
	if err := d.GramPost(ctx, "", nil, []string{big}); err == nil || d.GramState().Status != "Skipped: too large or unreadable: big.bin." {
		t.Fatalf("over-limit file: %v, status %q", err, d.GramState().Status)
	}
	if err := d.GramPost(ctx, "the notes", nil, []string{path}); err != nil {
		t.Fatal(err)
	}
	msgs := g.Messages()
	if len(msgs) != 1 || msgs[0].File == nil || msgs[0].File.Size != uint64(len(data)) || msgs[0].Text != "the notes" || msgs[0].To != nil {
		t.Fatalf("posted %+v", msgs)
	}
	if s := d.GramState(); len(s.Attachments) != 0 || s.Messages[0].StatusVerb != "Unclaimed" {
		t.Fatalf("after send: %+v", s)
	}
	// Opening it reads the copy kept at post time: no download.
	var opened string
	d.openPath = func(p string) error { opened = p; return nil }
	if err := d.GramOpenFile(ctx, msgs[0].ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(opened); !bytes.Equal(got, data) {
		t.Fatal("opened the wrong bytes")
	}
	for _, c := range g.Calls() {
		if strings.HasPrefix(c.Method, "gram.get_file") {
			t.Fatalf("own upload downloaded with %s", c.Method)
		}
	}
	// Another message's file is downloaded in chunks and saved.
	g.Add(agentMsg("f1", "", false), data)
	if err := d.GramRefresh(ctx); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "saved.txt")
	d.saveDialog = func(context.Context, string) (string, error) { return dest, nil }
	if err := d.GramSaveFile(ctx, "f1"); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(dest); !bytes.Equal(got, data) {
		t.Fatal("saved the wrong bytes")
	}
	chunks := 0
	for _, c := range g.Calls() {
		if c.Method == "gram.get_file_chunk" {
			chunks++
		}
	}
	if chunks != 3 {
		t.Fatalf("%d chunk reads for a 1.5 MB file, want 3", chunks)
	}
	// Owner 2026-11-08: a received HTML file opens in the default browser, through the
	// system opener like any other document, not in an in-app preview window.
	page := agentMsg("h1", "", false)
	page.File = &herdrapi.GramFileInfo{Name: "report.html", Mime: "text/html"}
	g.Add(page, []byte("<!doctype html><title>report</title>"))
	_ = d.GramRefresh(ctx)
	opened = ""
	if err := d.GramOpenFile(ctx, "h1"); err != nil || filepath.Ext(opened) != ".html" {
		t.Fatalf("an HTML file opened as %q, %v; want the system opener on the .html copy", opened, err)
	}
	// A program is never handed to the opener.
	exe := agentMsg("x1", "", false)
	exe.File = &herdrapi.GramFileInfo{Name: "setup.exe", Mime: "application/octet-stream"}
	g.Add(exe, []byte("MZ"))
	_ = d.GramRefresh(ctx)
	opened = ""
	if err := d.GramOpenFile(ctx, "x1"); err == nil || opened != "" {
		t.Fatalf("opened a program: %v %q", err, opened)
	}
	// The downloads go with the connection, moved aside and then deleted.
	d.Disconnect()
	if left, _ := os.ReadDir(d.gramCacheBase()); len(left) != 0 {
		var names []string
		for _, e := range left {
			names = append(names, e.Name())
		}
		t.Fatalf("left in the download cache after Disconnect: %v", names)
	}
}

// activeMachine is d's active saved machine, read under d.storeMu as every
// read of the desk's files is: a connected desk's work (the guest relabel
// sender on a connection's first list, desk_guest_relabel.go) holds it too.
func activeMachine(t *testing.T, d *Desk) Machine {
	t.Helper()
	d.storeMu.Lock()
	defer d.storeMu.Unlock()
	st, err := d.load()
	if err != nil {
		t.Fatal(err)
	}
	return st.Machines[st.find(st.Active)]
}

// #547 review: downloads that cannot move aside (a cache directory that
// refuses renames) are deleted in place once the owner marker is gone, so a
// reconnect of the same machine never finds the old attachment.
func TestDisconnectDropsDownloadsThatCannotMoveAside(t *testing.T) {
	g := fakeherdr.NewGram("store-1")
	g.Add(agentMsg("f1", "", false), []byte("the old bytes"))
	d := gramDeskFor(t, g)
	m := activeMachine(t, d)
	// The machine owns the downloads, as its connection's claim records.
	if err := os.MkdirAll(d.gramCacheBase(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(d.gramOwnerPath(), []byte(machineID(m)), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := d.GramRefresh(ctx); err != nil {
		t.Fatal(err)
	}
	d.saveDialog = func(context.Context, string) (string, error) { return filepath.Join(t.TempDir(), "f1"), nil }
	if err := d.GramSaveFile(ctx, "f1"); err != nil {
		t.Fatal(err)
	}
	if _, ok := d.gramCache().Cached("f1"); !ok {
		t.Fatal("the attachment is not in the download cache")
	}
	d.mu.Lock()
	d.gramRename = func(string, string) error { return errors.New("this directory refuses renames") }
	d.mu.Unlock()
	d.Disconnect()
	if _, ok := d.gramCache().Cached("f1"); ok {
		t.Fatal("the old attachment is still in the download cache after Disconnect")
	}
	if owner, err := os.ReadFile(d.gramOwnerPath()); err == nil && string(owner) == machineID(m) {
		t.Fatal("the owner marker still names the disconnected machine")
	}
	if err := d.Connect(m, ""); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the reconnect", func() bool { return d.State().Phase == "connected" })
	if _, ok := d.gramCache().Cached("f1"); ok {
		t.Fatal("a reconnect of the same machine finds the old attachment")
	}
}

// A Chat attachment names its file by Gram message id only: it opens even when Gram has not
// loaded that message (Gram never opened, or the message is past its loaded pages), taking the
// name from herdr's own chunks. Review of #201: it failed with "that message has no file".
func TestChatAttachmentOpensAMessageGramHasNotLoaded(t *testing.T) {
	g := fakeherdr.NewGram("store-1")
	d := gramDeskFor(t, g)
	ctx := context.Background()
	data := bytes.Repeat([]byte("plan "), 200_000) // 1 MB: two chunks
	doc := agentMsg("c1", "", false)
	doc.File = &herdrapi.GramFileInfo{Name: "plan.txt", Mime: "text/plain", Size: uint64(len(data))}
	g.Add(doc, data)
	exe := agentMsg("c2", "", false)
	exe.File = &herdrapi.GramFileInfo{Name: "setup.exe", Mime: "application/octet-stream", Size: 2}
	g.Add(exe, []byte("MZ"))
	var opened string
	d.openPath = func(p string) error { opened = p; return nil }
	if err := d.GramOpenAttachment(ctx, "c1"); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(opened); !bytes.Equal(got, data) || filepath.Base(opened) != "plan.txt" {
		t.Fatalf("opened %q (%d bytes), want plan.txt with the posted bytes", opened, len(got))
	}
	// The program is downloaded to learn its name, and never handed to the opener.
	opened = ""
	if err := d.GramOpenAttachment(ctx, "c2"); err != errSaveOnly || opened != "" {
		t.Fatalf("a program: %v, opened %q", err, opened)
	}
	// A message herdr does not have: herdr's refusal, nothing opened.
	if err := d.GramOpenAttachment(ctx, "gram-missing"); err == nil || opened != "" {
		t.Fatalf("a missing message: %v, opened %q", err, opened)
	}
	if s := d.GramState(); s.Status != "" {
		t.Fatalf("Gram's banner shows a Chat error: %q", s.Status)
	}
}

func TestGramStoreChangeDropsTheList(t *testing.T) {
	g := fakeherdr.NewGram("store-1")
	g.Add(agentMsg("a1", "first", true), nil)
	d := gramDeskFor(t, g)
	ctx := context.Background()
	_ = d.GramRefresh(ctx)
	g.SetStoreID("store-2")
	g.Update("a1", func(m *herdrapi.GramMessageInfo) { m.ID = "b1" })
	_ = d.GramRefresh(ctx)
	if s := d.GramState(); !slices.Equal(snapIDs(s), []string{"b1"}) {
		t.Fatalf("after a store swap: %v", snapIDs(s))
	}
}

func TestGramSavedCopies(t *testing.T) {
	g := fakeherdr.NewGram("store-1")
	g.Add(agentMsg("a1", "keep me", false), nil)
	d := gramDeskFor(t, g)
	_ = d.GramRefresh(context.Background())
	if err := d.GramSetSaved("a1", true); err != nil {
		t.Fatal(err)
	}
	if s := d.GramState(); !s.Messages[0].Saved || len(s.Saved) != 1 || s.Saved[0].Text != "keep me" {
		t.Fatalf("%+v", s)
	}
	if err := d.GramSetSaved("a1", false); err != nil || len(d.GramSaved()) != 0 {
		t.Fatalf("unsave: %v %v", err, d.GramSaved())
	}
}

// heldRefresh holds a desk's queued Gram refresh, which has its answer (it
// expires a saved copy's file), before it writes it, until release.
type heldRefresh struct {
	release func()
	// serve stops the server holding head lists.
	serve func()
	// disconnected is set once Disconnect returned; late reports a head load
	// after that.
	disconnected, late *atomic.Bool
}

// within waits for c, failing the test after 10 s.
func within(t *testing.T, what string, c <-chan struct{}) {
	t.Helper()
	select {
	case <-c:
	case <-time.After(10 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

// gramDeskWithHeldRefresh connects a desk whose saved copy of a1 has a file,
// queues a refresh behind a load (it runs on whatever its connection does),
// and holds it where its answer would expire that file.
func gramDeskWithHeldRefresh(t *testing.T) (*Desk, heldRefresh) {
	t.Helper()
	g := fakeherdr.NewGram("store-1")
	report := agentMsg("a1", "the report", false)
	report.File = &herdrapi.GramFileInfo{Name: "report.pdf", Mime: "application/pdf", Size: 3}
	g.Add(report, []byte("pdf"))
	// Every head list after the first waits at the server for its answer.
	asked, answer, ended := make(chan struct{}, 4), make(chan struct{}, 4), make(chan struct{})
	var heads atomic.Int32
	g.Fail = func(method string, raw json.RawMessage) *fakeherdr.APIError {
		var p herdrapi.GramListParams
		if method != "gram.list" || json.Unmarshal(raw, &p) != nil || p.UnreadOnly || heads.Add(1) == 1 {
			return nil
		}
		asked <- struct{}{}
		select {
		case <-answer:
		case <-ended:
		}
		return nil
	}
	d := gramDeskFor(t, g)
	// Once armed, a head load waits before expiring saved copies' files.
	var armed atomic.Bool
	held := heldRefresh{disconnected: new(atomic.Bool), late: new(atomic.Bool)}
	atExpiry, expire := make(chan struct{}, 1), make(chan struct{})
	d.gramListed = func() {
		if !armed.Load() {
			return
		}
		if held.disconnected.Load() {
			held.late.Store(true)
			return
		}
		select {
		case atExpiry <- struct{}{}:
		default:
		}
		<-expire
	}
	var once sync.Once
	held.release = func() { once.Do(func() { close(expire) }) }
	var served sync.Once
	held.serve = func() { served.Do(func() { close(ended) }) }
	t.Cleanup(func() { held.release(); held.serve() })
	ctx := context.Background()
	if err := d.GramRefresh(ctx); err != nil {
		t.Fatal(err)
	}
	if err := d.GramSetSaved("a1", true); err != nil {
		t.Fatal(err)
	}

	// A refresh tapped while a load runs is queued, and runs once it ends.
	loaded := make(chan struct{})
	go func() {
		defer close(loaded)
		_ = d.GramRefresh(ctx)
	}()
	within(t, "the load's list at the server", asked)
	if err := d.GramRefresh(ctx); err != nil {
		t.Fatal(err)
	}
	if s := d.GramState(); s.Status != "Refreshing…" {
		t.Fatalf("a refresh during a load: status %q, want it queued", s.Status)
	}
	answer <- struct{}{}
	within(t, "the load to end", loaded)
	within(t, "the queued refresh's list at the server", asked)
	// Its answer expires the saved copy's file.
	g.Update("a1", func(m *herdrapi.GramMessageInfo) { m.ExpiredFile, m.File = m.File, nil })
	armed.Store(true)
	answer <- struct{}{}
	within(t, "the queued refresh to reach the saved copies", atExpiry)
	return d, held
}

// disconnectAsync runs Disconnect; the channel closes as it returns.
func disconnectAsync(d *Desk, held heldRefresh) <-chan struct{} {
	returned := make(chan struct{})
	go func() {
		defer close(returned)
		d.Disconnect()
		held.disconnected.Store(true)
	}()
	return returned
}

// #540: a Gram refresh of the connection, still running as the desk
// disconnects, holds Disconnect until it ends, so its write (a saved copy's
// file expiring) never lands after Disconnect returns, where a test's TempDir
// cleanup met it.
func TestDisconnectWaitsForTheConnectionsGramRefresh(t *testing.T) {
	d, held := gramDeskWithHeldRefresh(t)
	returned := disconnectAsync(d, held)
	select {
	case <-returned:
		t.Fatal("Disconnect returned while a refresh of its connection had yet to write the saved copies")
	case <-time.After(500 * time.Millisecond):
	}
	held.release()
	within(t, "Disconnect to return once the refresh ended", returned)
	saved := d.GramSaved()
	if len(saved) != 1 || saved[0].File != nil || saved[0].ExpiredFile == nil {
		t.Fatalf("the refresh's write did not land before Disconnect returned: %+v", saved)
	}
	if held.late.Load() {
		t.Fatal("a head load ran after Disconnect returned")
	}
}

// #547 review: a connection made while Disconnect waits for the old one's
// work keeps what it claimed: its Gram, its download cache (the owner marker)
// and its connected state, which an idle published after the wait would
// clear.
func TestDisconnectWaitingKeepsAReconnectsGramCacheAndState(t *testing.T) {
	d, held := gramDeskWithHeldRefresh(t)
	m := activeMachine(t, d)
	returned := disconnectAsync(d, held)
	waitFor(t, "Disconnect to take the connection", func() bool { return d.State().Phase == "idle" })
	if err := d.Connect(m, ""); err != nil {
		t.Fatal(err)
	}
	// Listed by the new connection: a cached board shows unlisted.
	waitFor(t, "the reconnect", func() bool {
		b := d.Board()
		return d.State().Phase == "connected" && b != nil && b.ListedAt != ""
	})
	select {
	case <-returned:
		t.Fatal("Disconnect returned before the reconnect: the old refresh no longer held it")
	default:
	}
	held.release()
	within(t, "Disconnect to return once the refresh ended", returned)
	if s := d.State(); s.Phase != "connected" {
		t.Fatalf("the reconnected desk shows %q after the old Disconnect returned", s.Phase)
	}
	if owner, err := os.ReadFile(d.gramOwnerPath()); err != nil || string(owner) != machineID(m) {
		t.Fatalf("the reconnect's download cache owner: %q, %v; want %q", owner, err, machineID(m))
	}
	if d.Board() == nil {
		t.Fatal("the reconnected desk lost its board")
	}
	held.serve()
	if err := d.GramRefresh(context.Background()); err != nil {
		t.Fatalf("the reconnected desk's Gram: %v", err)
	}
	if s := d.GramState(); s.Phase != "loaded" || !slices.Equal(snapIDs(s), []string{"a1"}) {
		t.Fatalf("the reconnected desk's Gram after a refresh: phase %q, %v", s.Phase, snapIDs(s))
	}
}

// #547 review: a connection's Gram and download cache claim go in with its
// link, in one d.mu section. A Disconnect right after the link went in (here
// as Connect shows the machine's cached board, which it does once d.mu is
// free) takes them out too: no Gram is left for the closed link.
func TestDisconnectRacingConnectLeavesNoGramForTheClosedLink(t *testing.T) {
	d := gramDeskFor(t, fakeherdr.NewGram("store-1"))
	m := activeMachine(t, d)
	waitFor(t, "the machine's board in the cache", func() bool { return d.boards.load(machineID(m), m.Session) != nil })
	d.Disconnect()
	var once sync.Once
	d.mu.Lock()
	d.onBoard = func(BoardUpdate) { once.Do(d.Disconnect) }
	d.mu.Unlock()
	if err := d.Connect(m, ""); err != nil {
		t.Fatal(err)
	}
	if s := d.State(); s.Phase != "idle" {
		t.Fatalf("the desk shows %q after the Disconnect", s.Phase)
	}
	if l, err := d.gramLink(); err == nil {
		t.Fatalf("Gram is left on the closed link %q (phase %q)", l.id, d.GramState().Phase)
	}
	if owner, err := os.ReadFile(d.gramOwnerPath()); err == nil {
		t.Fatalf("the download cache is left claimed by the closed link's machine %q", owner)
	}
}

// Owner bug 2026-11-12 (herdr-app 462142): Gram's agents were only the ones
// that had written in the loaded page. Every agent herdr would deliver a
// gram.post to is offered after them, once each, by its routing name.
func TestGramOffersEveryAgentHerdrDeliversTo(t *testing.T) {
	g := fakeherdr.NewGram("store-1")
	g.Add(agentMsg("a1", "done", false), nil)
	d := gramRosterDesk(t, g, false, []any{
		map[string]any{"pane_id": "w1:p1", "agent_status": "working", "name": "vetrina"},
		map[string]any{"pane_id": "w1:p2", "agent_status": "idle", "name": "docs"},
		map[string]any{"pane_id": "w1:p3", "agent_status": "idle"},
		map[string]any{"pane_id": "w1:p4", "agent_status": "idle", "name": "old", "archived": map[string]any{"at": "2026-11-01T10:00:00Z", "by": "owner"}},
		map[string]any{"pane_id": "studio/w1:p1", "agent_status": "idle", "name": "studio/docs", "machine_id": "studio", "machine_label": "mac-studio", "reachability": "reachable"},
		map[string]any{"pane_id": "pi/w1:p1", "agent_status": "idle", "name": "pi/scout", "machine_id": "pi", "reachability": "degraded"},
	})
	ctx := context.Background()
	gramAgentsBecome(t, d, []GramAgent{
		{From: "vetrina", Name: "vetrina", Machine: "127.0.0.1"},
		{From: "docs", Name: "docs", Machine: "127.0.0.1"},
		{From: "studio/docs", Name: "docs", Machine: "mac-studio"},
	})
	// An agent that never wrote is reached by its routing name. Gram's own
	// polls run alongside, so the post is looked for among the calls.
	for _, to := range []string{"docs", "studio/docs"} {
		if err := d.GramPost(ctx, "hello", []string{to}, nil); err != nil {
			t.Fatal(err)
		}
		var p herdrapi.GramPostParams
		calls := g.Calls()
		for i := len(calls) - 1; i >= 0; i-- {
			if calls[i].Method == "gram.post" {
				_ = json.Unmarshal(calls[i].Params, &p)
				break
			}
		}
		if p.To == nil || *p.To != to {
			t.Fatalf("post to %s: last gram.post %+v", to, p)
		}
	}
}

// herdr #403: a herdr advertising capabilities.gram_reachable marks each
// federated agent whether its machine's Gram relay is allowed; one marked
// false is not offered, even when it wrote before (its message stays).
// Without the capability every reachable one is, as before (herdr refuses a
// post it can't relay).
func TestGramLeavesOutFederatedAgentsHerdrCannotRelayTo(t *testing.T) {
	roster := []any{
		map[string]any{"pane_id": "w1:p1", "agent_status": "idle", "name": "docs"},
		map[string]any{"pane_id": "studio/w1:p1", "agent_status": "idle", "name": "studio/docs", "machine_id": "studio", "machine_label": "mac-studio", "reachability": "reachable", "gram_reachable": true},
		map[string]any{"pane_id": "lab/w1:p1", "agent_status": "idle", "name": "lab/scout", "machine_id": "lab", "reachability": "reachable", "gram_reachable": false},
	}
	local := GramAgent{From: "docs", Name: "docs", Machine: "127.0.0.1"}
	studio := GramAgent{From: "studio/docs", Name: "docs", Machine: "mac-studio"}
	lab := GramAgent{From: "lab/scout", Name: "scout", Machine: "lab"}
	for _, c := range []struct {
		capability bool
		want       []GramAgent
	}{{true, []GramAgent{local, studio}}, {false, []GramAgent{lab, local, studio}}} {
		g := fakeherdr.NewGram("store-1")
		m := agentMsg("l1", "from the lab", false)
		m.From = "lab/scout"
		g.Add(m, nil)
		d := gramRosterDesk(t, g, c.capability, roster)
		gramAgentsBecome(t, d, c.want)
		if ids := snapIDs(d.GramState()); !slices.Equal(ids, []string{"l1"}) {
			t.Errorf("capability %v: messages %v, want the lab's kept", c.capability, ids)
		}
	}
}

// gramRosterDesk is a desk on a fake herdr serving g and agents, whose ping
// advertises capabilities.gram_reachable when gramReachable, with Gram loaded.
func gramRosterDesk(t *testing.T, g *fakeherdr.Gram, gramReachable bool, agents []any) *Desk {
	t.Helper()
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		inner := s.Handle
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			if res, err, ok := g.Handle(method, params); ok {
				return res, err
			}
			switch method {
			case "agent.list":
				return map[string]any{"type": "agent_list", "agents": agents}, nil
			case "ping":
				res, err := inner(method, params)
				if pong, ok := res.(map[string]any); ok && gramReachable {
					pong["capabilities"].(map[string]bool)["gram_reachable"] = true
				}
				return res, err
			}
			return inner(method, params)
		}
		s.Duplex = g.Duplex
	})
	d.cacheDir = t.TempDir()
	if err := d.GramRefresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	return d
}

// gramAgentsBecome waits for Gram to offer want.
func gramAgentsBecome(t *testing.T, d *Desk, want []GramAgent) {
	t.Helper()
	var got []GramAgent
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if got = d.GramState().Agents; slices.Equal(got, want) {
			return
		}
	}
	t.Fatalf("agents %+v, want %+v", got, want)
}

func TestGramSenderAvatarFallsBackToTheInitialTile(t *testing.T) {
	d := newDesk(t.TempDir())
	f := d.GramSenderAvatar("8195/w1:p2/scout")
	if f.Avatar.Kind != "initial" || f.Initial != "S" {
		t.Fatalf("%+v", f)
	}
}

// #44: a file changed on disk after its upload finished is not taken for
// the posted attachment: Open shows what herdr holds.
func TestGramOpenShowsThePostedBytesNotTheFilesLaterContents(t *testing.T) {
	g := fakeherdr.NewGram("store-1")
	d := gramDeskFor(t, g)
	ctx := context.Background()
	if err := d.GramRefresh(ctx); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "plan.txt")
	if err := os.WriteFile(path, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	d.openDialog = func(context.Context) ([]string, error) { return []string{path}, nil }
	if _, err := d.GramPickFiles(ctx); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the upload", func() bool {
		a := d.GramState().Attachments
		return len(a) == 1 && a[0].State == "uploaded"
	})
	if err := os.WriteFile(path, []byte("modified"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := d.GramPost(ctx, "", nil, []string{path}); err != nil {
		t.Fatal(err)
	}
	msgs := g.Messages()
	if len(msgs) != 1 || msgs[0].File == nil {
		t.Fatalf("posted %+v", msgs)
	}
	var opened string
	d.openPath = func(p string) error { opened = p; return nil }
	if err := d.GramOpenFile(ctx, msgs[0].ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(opened); string(got) != "original" {
		t.Fatalf("opened %q, but herdr holds %q", got, "original")
	}
}

// Mark all read whose unread list fails is not a success: with nothing held
// it cannot mark the unread the badge counts, so the badge stays and the
// banner says some may still be unread.
func TestGramMarkAllReadReportsAnIncompleteList(t *testing.T) {
	g := fakeherdr.NewGram("store-1")
	g.Add(agentMsg("a1", "older", true), nil)
	var listFails atomic.Bool
	g.Fail = func(method string, params json.RawMessage) *fakeherdr.APIError {
		if method == "gram.list" && listFails.Load() {
			return &fakeherdr.APIError{Code: "internal", Message: "list failed"}
		}
		return nil
	}
	d := gramDeskFor(t, g)
	ctx := context.Background()
	l, err := d.gramLink()
	if err != nil {
		t.Fatal(err)
	}
	d.gramBadge(ctx, l)
	if s := d.GramState(); s.UnreadCount != 1 {
		t.Fatalf("badge before: %d", s.UnreadCount)
	}
	listFails.Store(true)
	if err := d.GramMarkAllRead(ctx); err != nil {
		t.Fatal(err)
	}
	if s := d.GramState(); s.UnreadCount != 1 || !strings.Contains(s.Status, "Some may still be unread") {
		t.Fatalf("an unlisted unread message was reported read: badge %d, status %q", s.UnreadCount, s.Status)
	}
}

// Review P3 on #197: when only a past sender's eligibility changes (its
// machine's Gram relay is turned off while the peer is degraded, so no
// roster recipient changes), the agent list is published again without it.
func TestGramRepublishesWhenOnlyASendersEligibilityChanges(t *testing.T) {
	lab := func(reachable bool) []any {
		return []any{map[string]any{"pane_id": "lab/w1:p1", "agent_status": "idle", "name": "lab/scout", "machine_id": "lab", "reachability": "degraded", "gram_reachable": reachable}}
	}
	g := fakeherdr.NewGram("store-1")
	m := agentMsg("l1", "from the lab", false)
	m.From = "lab/scout"
	g.Add(m, nil)
	d := gramRosterDesk(t, g, true, lab(true))
	gramAgentsBecome(t, d, []GramAgent{{From: "lab/scout", Name: "scout", Machine: "lab"}})
	var published []GramAgent
	d.gram.mu.Lock()
	d.gram.onPublish = func(s GramSnapshot) { published = s.Agents }
	l := d.gram.link
	d.gram.mu.Unlock()
	var roster []herdrapi.AgentInfo
	raw, _ := json.Marshal(lab(false))
	if err := json.Unmarshal(raw, &roster); err != nil {
		t.Fatal(err)
	}
	d.gramRoster(l, roster, &herdrapi.ServerCapabilities{GramReachable: true})
	d.gram.mu.Lock()
	got := published
	d.gram.onPublish = nil
	d.gram.mu.Unlock()
	if got == nil || len(got) != 0 {
		t.Fatalf("published agents %+v, want a publish with none", got)
	}
}
