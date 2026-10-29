package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"strconv"
	"sync"
	"time"
)

// agentSet is the agent.list result served. Replacing it tells every
// events.subscribe stream that the panes changed, so a watching app lists
// again at once.
type agentSet struct {
	mu   sync.Mutex
	data []byte
	seq  uint64
	subs map[chan struct{}]bool
}

func newAgentSet(data []byte) *agentSet {
	return &agentSet{data: data, subs: map[chan struct{}]bool{}}
}

func (s *agentSet) get() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data
}

func (s *agentSet) set(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data = data
	for c := range s.subs {
		select {
		case c <- struct{}{}:
		default:
		}
	}
}

// events serves one events.subscribe stream: a pane.created line, which
// makes the app list again, after each set.
func (s *agentSet) events(ctx context.Context, emit func([]byte) error) {
	c := make(chan struct{}, 1)
	s.mu.Lock()
	s.subs[c] = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.subs, c)
		s.mu.Unlock()
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case <-c:
			s.mu.Lock()
			s.seq++
			seq := s.seq
			s.mu.Unlock()
			if emit([]byte(`{"seq":`+strconv.FormatUint(seq, 10)+`,"event":"pane.created","data":{}}`)) != nil {
				return
			}
		}
	}
}

// follow sets the agents from path whenever the file changes, checking
// every interval, until ctx ends. A file that is not valid JSON is skipped
// until it is.
func (s *agentSet) follow(ctx context.Context, path string, every time.Duration) {
	var last time.Time
	var lastSize int64 = -1
	if fi, err := os.Stat(path); err == nil {
		last, lastSize = fi.ModTime(), fi.Size()
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		fi, err := os.Stat(path)
		if err != nil || (fi.ModTime().Equal(last) && fi.Size() == lastSize) {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil || !json.Valid(data) {
			continue
		}
		last, lastSize = fi.ModTime(), fi.Size()
		s.set(data)
		log.Printf("fakeherdr: agents reloaded from %s", path)
	}
}
