package main

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/herdr"
)

// SearchBoard must not read the link's groups store after releasing d.mu:
// SelectSession replaces it (with nil) under that lock, and a search racing
// the switch then dereferenced nil (post-merge review of #33, F1).
func TestSearchBoardSurvivesASessionSwitch(t *testing.T) {
	d := newDesk(t.TempDir())
	store := func() *groupsStore { return newGroupsStore(d.openFolders, "k", func() {}, func(string) {}) }
	l := &link{id: "m", groups: store()}
	u := BoardUpdate{Board: herdr.BuildBoard(nil, herdr.View{})}
	d.mu.Lock()
	d.link, d.board = l, &u
	d.mu.Unlock()

	stop := make(chan struct{})
	var wg sync.WaitGroup
	// What SelectSession and a new session's watch do to the store, under d.mu.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			d.mu.Lock()
			l.groups = nil
			d.mu.Unlock()
			d.mu.Lock()
			l.groups = store()
			d.mu.Unlock()
		}
	}()
	panics := make(chan string, 8)
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					panics <- fmt.Sprint(r)
				}
			}()
			for deadline := time.Now().Add(300 * time.Millisecond); time.Now().Before(deadline); {
				d.SearchBoard("re")
			}
		}()
	}
	time.Sleep(350 * time.Millisecond)
	close(stop)
	wg.Wait()
	close(panics)
	for p := range panics {
		t.Fatalf("SearchBoard panicked during a session switch: %s", p)
	}
}
