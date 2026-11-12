package main

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/fakeherdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// A page can arrive after a head refresh has settled a read without changing
// the head rows. Its older count must not be certified by the settled digest.
func TestGramDelayedPageCountSettlesAfterHeadRead(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	g := fakeherdr.NewGram("store-1")
	for i := range 42 {
		m := agentMsg(fmt.Sprintf("m%02d", i), "note", true)
		m.CreatedUnixMs = uint64(i + 1)
		g.Add(m, nil)
	}
	built, release := make(chan struct{}, 1), make(chan struct{})
	d, _ := federatedDesk(t, func(s *fakeherdr.Server) {
		inner := s.Handle
		s.Handle = func(method string, params json.RawMessage) (any, *fakeherdr.APIError) {
			res, err, ok := g.Handle(method, params)
			if !ok {
				return inner(method, params)
			}
			var p herdrapi.GramListParams
			if method == "gram.list" && json.Unmarshal(params, &p) == nil && p.BeforeID != nil {
				select {
				case built <- struct{}{}:
				case <-ctx.Done():
				}
				select {
				case <-release:
				case <-ctx.Done():
				}
			}
			return res, err
		}
		s.Duplex = g.Duplex
	})
	d.cacheDir = t.TempDir()
	refresh := func(want int) {
		t.Helper()
		if err := d.GramRefresh(ctx); err != nil {
			t.Fatal(err)
		}
		if got := d.GramState().UnreadCount; got != want {
			t.Fatalf("after refresh: unread = %d, want %d", got, want)
		}
	}
	refresh(42)
	loaded := make(chan error, 1)
	go func() {
		grew, err := d.GramLoadOlder(ctx)
		if err == nil && !grew {
			err = fmt.Errorf("older page did not load")
		}
		loaded <- err
	}()
	select {
	case <-built:
	case <-ctx.Done():
		t.Fatal("older page was not built:", ctx.Err())
	}
	if err := d.GramMarkRead(ctx, "m41"); err != nil {
		t.Fatal(err)
	}
	refresh(41)
	close(release)
	select {
	case err := <-loaded:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("older page did not finish:", ctx.Err())
	}
	// The old count may briefly be published, but a normal head poll must
	// repair it rather than returning unchanged against the settled digest.
	refresh(41)
	if err := d.GramMarkRead(ctx, "m40"); err != nil {
		t.Fatal(err)
	}
	if got := d.GramState().UnreadCount; got != 40 {
		t.Fatalf("after second read: unread = %d, want 40", got)
	}
	refresh(40)
}
