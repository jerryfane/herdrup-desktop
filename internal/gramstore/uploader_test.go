package gramstore

import (
	"context"
	"errors"
	"math"
	"slices"
	"sync"
	"testing"
	"time"
)

// Translated case by case from herdrup Tests/HerdrKitTests/ComposerUploaderTests.swift
// at 9876878; each test names its Swift original. The upload is scripted:
// it stays open until the test finishes, fails or cancels it.

type script struct {
	mu        sync.Mutex
	pending   map[string]chan uploadResult
	reporters map[string]func(sent, total int64)
	started   []string
	cancelled []string
	running   int
	most      int
	written   map[string]string
	discarded []string
}

func newScript() *script {
	return &script{pending: map[string]chan uploadResult{}, reporters: map[string]func(int64, int64){}, written: map[string]string{}}
}

func (s *script) upload(ctx context.Context, a Attachment, progress func(sent, total int64)) (string, error) {
	ch := make(chan uploadResult, 1)
	s.mu.Lock()
	s.started = append(s.started, a.Path)
	s.reporters[a.Path] = progress
	s.running++
	s.most = max(s.most, s.running)
	s.pending[a.Path] = ch
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.running--
		s.mu.Unlock()
	}()
	select {
	case r := <-ch:
		return r.id, r.err
	case <-ctx.Done():
		s.mu.Lock()
		s.cancelled = append(s.cancelled, a.Path)
		delete(s.pending, a.Path)
		s.mu.Unlock()
		return "", ctx.Err()
	}
}

func (s *script) uploader() *Uploader {
	return NewUploader(s.upload, func(id string) {
		s.mu.Lock()
		s.discarded = append(s.discarded, id)
		s.mu.Unlock()
	}, nil, func(path, id string) {
		s.mu.Lock()
		s.written[path] = id
		s.mu.Unlock()
	})
}

func (s *script) end(path string, r uploadResult) {
	s.mu.Lock()
	ch := s.pending[path]
	delete(s.pending, path)
	s.mu.Unlock()
	if ch != nil {
		ch <- r
	}
}

func (s *script) finish(path, id string) { s.end(path, uploadResult{id: id}) }
func (s *script) fail(path string) {
	s.end(path, uploadResult{err: errors.New("network connection lost")})
}

func (s *script) startedIs(want ...string) func() bool {
	return func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return slices.Equal(s.started, want)
	}
}

func (s *script) snapshot() (started, cancelled, discarded []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.started), slices.Clone(s.cancelled), slices.Clone(s.discarded)
}

func until(t *testing.T, msg string, cond func() bool) {
	t.Helper()
	for range 2000 {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal(msg)
}

// settle is a short wait, for asserting something did NOT happen.
func settle() { time.Sleep(20 * time.Millisecond) }

func file(path string) Attachment {
	return Attachment{Path: path, Name: path, Mime: "text/plain", Size: 8}
}

func phaseIs(u *Uploader, path string, want Phase) func() bool {
	return func() bool { p, ok := u.Phase(path); return ok && p == want }
}

// testStartsEachUploadAsItIsAddedOneAtATimeInOrder
func TestUploaderOneAtATimeInOrder(t *testing.T) {
	s := newScript()
	u := s.uploader()
	for _, p := range []string{"a.txt", "b.txt", "c.txt"} {
		u.Start(file(p))
	}
	until(t, "the first file starts uploading at once", s.startedIs("a.txt"))
	settle()
	if started, _, _ := s.snapshot(); !slices.Equal(started, []string{"a.txt"}) {
		t.Fatalf("the others must wait their turn: %v", started)
	}
	for _, p := range []string{"b.txt", "c.txt"} {
		if ph, _ := u.Phase(p); ph.Kind != PhaseQueued {
			t.Fatalf("%s phase %+v", p, ph)
		}
	}
	s.finish("a.txt", "u-a")
	until(t, "the next file starts once the first lands", s.startedIs("a.txt", "b.txt"))
	s.finish("b.txt", "u-b")
	until(t, "then the last", s.startedIs("a.txt", "b.txt", "c.txt"))
	s.finish("c.txt", "u-c")
	until(t, "every upload lands", phaseIs(u, "c.txt", Phase{Kind: PhaseUploaded, UploadID: "u-c"}))
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.most != 1 {
		t.Errorf("%d uploads at once", s.most)
	}
	if len(s.written) != 3 || s.written["a.txt"] != "u-a" || s.written["b.txt"] != "u-b" || s.written["c.txt"] != "u-c" {
		t.Errorf("written %v", s.written)
	}
	if len(s.discarded) != 0 {
		t.Errorf("discarded %v", s.discarded)
	}
}

// testRemovingAFileCancelsItsUploadDeletesItsCopyAndFreesTheLine (the
// desk uploads the picked file itself, so there is no copy to delete).
func TestUploaderRemovingAFileCancelsItsUploadAndFreesTheLine(t *testing.T) {
	s := newScript()
	u := s.uploader()
	a, b, c := file("a.txt"), file("b.txt"), file("c.txt")
	u.Start(a)
	u.Start(b)
	u.Start(c)
	until(t, "a starts", s.startedIs("a.txt"))
	u.Remove(c)
	u.Remove(a)
	until(t, "removing the running file cancels its upload", func() bool { _, cancelled, _ := s.snapshot(); return slices.Equal(cancelled, []string{"a.txt"}) })
	if _, ok := u.Phase("a.txt"); ok {
		t.Error("a still known")
	}
	if _, ok := u.Phase("c.txt"); ok {
		t.Error("c still known")
	}
	until(t, "the next file takes the line", s.startedIs("a.txt", "b.txt"))
	s.finish("b.txt", "u-b")
	until(t, "b lands", phaseIs(u, "b.txt", Phase{Kind: PhaseUploaded, UploadID: "u-b"}))
	settle()
	started, _, discarded := s.snapshot()
	if !slices.Equal(started, []string{"a.txt", "b.txt"}) {
		t.Errorf("a removed file that was waiting uploaded: %v", started)
	}
	if len(discarded) != 0 {
		t.Errorf("nothing landed for the removed files, yet %v discarded", discarded)
	}
}

// testPublishesProgressPerAttachment
func TestUploaderPublishesProgressPerAttachment(t *testing.T) {
	s := newScript()
	u := s.uploader()
	u.Start(file("a.txt"))
	u.Start(file("b.txt"))
	reporter := func(p string) func(int64, int64) {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.reporters[p]
	}
	until(t, "a starts", func() bool { return reporter("a.txt") != nil })
	if ph, _ := u.Phase("a.txt"); ph != (Phase{Kind: PhaseUploading, Total: 8}) {
		t.Fatalf("a %+v", ph)
	}
	reporter("a.txt")(3, 8)
	if ph, _ := u.Phase("a.txt"); ph != (Phase{Kind: PhaseUploading, Sent: 3, Total: 8}) {
		t.Fatalf("a %+v", ph)
	}
	if ph, _ := u.Phase("b.txt"); ph.Kind != PhaseQueued {
		t.Fatal("only the running file moves")
	}
	if f, ok := u.PendingProgress([]string{"a.txt", "b.txt"}); !ok || math.Abs(f-3.0/16) > 1e-4 {
		t.Fatalf("pending progress %v %v, want 3/16 over every file still to land", f, ok)
	}
	s.finish("a.txt", "u-a")
	until(t, "b starts", func() bool { return reporter("b.txt") != nil })
	reporter("b.txt")(6, 8)
	reporter("a.txt")(1, 8)
	if ph, _ := u.Phase("a.txt"); ph != (Phase{Kind: PhaseUploaded, UploadID: "u-a"}) {
		t.Fatalf("a finished upload's late report changed it: %+v", ph)
	}
	if f, ok := u.PendingProgress([]string{"a.txt", "b.txt"}); !ok || math.Abs(f-6.0/8) > 1e-4 {
		t.Fatalf("pending progress %v %v", f, ok)
	}
	s.finish("b.txt", "u-b")
	until(t, "b lands", phaseIs(u, "b.txt", Phase{Kind: PhaseUploaded, UploadID: "u-b"}))
	if _, ok := u.PendingProgress([]string{"a.txt", "b.txt"}); ok {
		t.Error("nothing left to wait for")
	}
}

// testRemovingAFinishedUploadDiscardsItOnTheHost
func TestUploaderRemovingAFinishedUploadDiscardsIt(t *testing.T) {
	s := newScript()
	u := s.uploader()
	a, b := file("a.txt"), file("b.txt")
	u.Start(a)
	u.Start(b)
	until(t, "a starts", s.startedIs("a.txt"))
	s.finish("a.txt", "u-a")
	until(t, "b starts", s.startedIs("a.txt", "b.txt"))
	s.finish("b.txt", "u-b")
	until(t, "both land", phaseIs(u, "b.txt", Phase{Kind: PhaseUploaded, UploadID: "u-b"}))
	u.Remove(a)
	until(t, "the removed file's upload is discarded", func() bool { _, _, d := s.snapshot(); return slices.Equal(d, []string{"u-a"}) })
	posted := b
	posted.MessageID = "m1"
	u.Remove(posted)
	settle()
	if _, _, d := s.snapshot(); !slices.Equal(d, []string{"u-a"}) {
		t.Fatalf("a posted file's upload was consumed by the post, yet discarded: %v", d)
	}
}

// testSentFilesAreForgottenWithoutADiscard
func TestUploaderSentFilesAreForgottenWithoutADiscard(t *testing.T) {
	s := newScript()
	u := s.uploader()
	u.Start(file("a.txt"))
	until(t, "a starts", s.startedIs("a.txt"))
	s.finish("a.txt", "u-a")
	until(t, "a lands", phaseIs(u, "a.txt", Phase{Kind: PhaseUploaded, UploadID: "u-a"}))
	u.Forget([]string{"a.txt"})
	if _, ok := u.Phase("a.txt"); ok {
		t.Error("still known")
	}
	u.Close()
	settle()
	if _, _, d := s.snapshot(); len(d) != 0 {
		t.Fatalf("discarded %v", d)
	}
}

// testReleasingTheUploaderCancelsAndDiscardsEverything: Close cancels the
// running upload. Unlike herdrup it discards nothing, since the desk closes
// a composer when its connection goes, with nothing left to ask.
func TestUploaderCloseCancelsTheRunningUpload(t *testing.T) {
	s := newScript()
	u := s.uploader()
	u.Start(file("a.txt"))
	u.Start(file("b.txt"))
	until(t, "a starts", s.startedIs("a.txt"))
	s.finish("a.txt", "u-a")
	until(t, "b starts", s.startedIs("a.txt", "b.txt"))
	u.Close()
	until(t, "b's upload is cancelled", func() bool { _, c, _ := s.snapshot(); return slices.Equal(c, []string{"b.txt"}) })
	u.Start(file("c.txt"))
	settle()
	if started, _, _ := s.snapshot(); len(started) != 2 {
		t.Fatalf("a closed uploader started %v", started)
	}
}

// testSendWaitsForTheRunningUploadAndAFailureCanBeRetried
func TestUploaderSendWaitsAndAFailureCanBeRetried(t *testing.T) {
	s := newScript()
	u := s.uploader()
	u.Start(file("a.txt"))
	until(t, "a starts", s.startedIs("a.txt"))
	type waited struct {
		id  string
		ok  bool
		err error
	}
	got := make(chan waited, 1)
	go func() {
		id, ok, err := u.Wait(context.Background(), "a.txt")
		got <- waited{id, ok, err}
	}()
	settle()
	s.finish("a.txt", "u-a")
	if w := <-got; w.id != "u-a" || !w.ok || w.err != nil {
		t.Fatalf("waited %+v", w)
	}
	if id, ok, _ := u.Wait(context.Background(), "a.txt"); id != "u-a" || !ok {
		t.Fatal("a landed upload answers at once")
	}
	u.Start(file("b.txt"))
	until(t, "b starts", s.startedIs("a.txt", "b.txt"))
	s.fail("b.txt")
	until(t, "b fails", phaseIs(u, "b.txt", Phase{Kind: PhaseFailed}))
	if _, ok, _ := u.Wait(context.Background(), "b.txt"); ok {
		t.Fatal("a failed upload is not waited for: Send uploads it itself")
	}
	u.Retry("b.txt")
	until(t, "tap to retry uploads it again", s.startedIs("a.txt", "b.txt", "b.txt"))
	s.finish("b.txt", "u-b")
	until(t, "b lands", phaseIs(u, "b.txt", Phase{Kind: PhaseUploaded, UploadID: "u-b"}))
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.written["b.txt"] != "u-b" {
		t.Fatalf("written %v", s.written)
	}
}

// testSendsOwnUploadQueuesBehindTheRunningOne
func TestUploaderSendsOwnUploadQueuesBehindTheRunningOne(t *testing.T) {
	s := newScript()
	u := s.uploader()
	u.Start(file("a.txt"))
	until(t, "a starts", s.startedIs("a.txt"))
	got := make(chan string, 1)
	go func() {
		id, _ := u.Upload(context.Background(), file("b.txt"))
		got <- id
	}()
	settle()
	if started, _, _ := s.snapshot(); !slices.Equal(started, []string{"a.txt"}) {
		t.Fatalf("b did not wait for a: %v", started)
	}
	s.finish("a.txt", "u-a")
	until(t, "b starts after a", s.startedIs("a.txt", "b.txt"))
	s.finish("b.txt", "u-b")
	if id := <-got; id != "u-b" {
		t.Fatalf("upload id %q", id)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.most != 1 {
		t.Fatalf("%d at once", s.most)
	}
}

// testLeavingPausesUploadsNoSendWaitsOnAndComingBackResumesThem
func TestUploaderLeavingPausesAndComingBackResumes(t *testing.T) {
	s := newScript()
	u := s.uploader()
	u.Start(file("a.txt"))
	until(t, "a starts", s.startedIs("a.txt"))
	u.Pause()
	until(t, "leaving cancels the running upload", func() bool { _, c, _ := s.snapshot(); return slices.Equal(c, []string{"a.txt"}) })
	settle()
	if ph, _ := u.Phase("a.txt"); ph.Kind != PhasePaused {
		t.Fatalf("phase %+v", ph)
	}
	u.Resume()
	until(t, "coming back starts it again", s.startedIs("a.txt", "a.txt"))
	got := make(chan string, 1)
	go func() {
		id, _, _ := u.Wait(context.Background(), "a.txt")
		got <- id
	}()
	settle()
	u.Pause()
	settle()
	if _, c, _ := s.snapshot(); !slices.Equal(c, []string{"a.txt"}) {
		t.Fatalf("an upload a Send waits on was stopped: %v", c)
	}
	s.finish("a.txt", "u-a")
	if id := <-got; id != "u-a" {
		t.Fatalf("waited %q", id)
	}
}

// #45: a removed upload that lands anyway belongs to the removed file. A
// file attached again at the same path uploads its own bytes, and the
// removed upload is discarded.
func TestUploaderARemovedUploadNeverLandsOnItsReplacement(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	var calls int
	var discarded []string
	u := NewUploader(func(ctx context.Context, a Attachment, _ func(int64, int64)) (string, error) {
		mu.Lock()
		calls++
		n := calls
		mu.Unlock()
		if n == 1 {
			<-release // version A ignores the cancel and lands late
			return "upload-A", nil
		}
		return "upload-B", nil
	}, func(id string) {
		mu.Lock()
		discarded = append(discarded, id)
		mu.Unlock()
	}, nil, nil)
	u.Start(file("p.txt"))
	until(t, "A starts", func() bool { mu.Lock(); defer mu.Unlock(); return calls == 1 })
	u.Remove(file("p.txt"))
	u.Start(file("p.txt"))
	close(release)
	id, ok, err := u.Wait(context.Background(), "p.txt")
	if err != nil || !ok || id != "upload-B" {
		t.Fatalf("the replacement waited %q %v %v, want its own upload-B", id, ok, err)
	}
	until(t, "the removed upload is discarded", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return slices.Equal(discarded, []string{"upload-A"})
	})
}
