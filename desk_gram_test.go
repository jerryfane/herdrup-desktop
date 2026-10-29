package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
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
	d.cacheDir = t.TempDir()
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
	// A program is never handed to the opener.
	exe := agentMsg("x1", "", false)
	exe.File = &herdrapi.GramFileInfo{Name: "setup.exe", Mime: "application/octet-stream"}
	g.Add(exe, []byte("MZ"))
	_ = d.GramRefresh(ctx)
	opened = ""
	if err := d.GramOpenFile(ctx, "x1"); err == nil || opened != "" {
		t.Fatalf("opened a program: %v %q", err, opened)
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
