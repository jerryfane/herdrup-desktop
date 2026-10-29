package gramstore

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
)

// Translated from herdrup Tests/HerdrKitTests/GramAttachmentSenderTests.swift
// at 9876878, driven through Composer.Send (the Gram page's send). Uploads
// and posts are scripted and recorded as "upload <name>" / "post
// <name>@<upload id>"; a text-only post is "post text".

type rig struct {
	mu          sync.Mutex
	calls       []string
	uploads     int
	posts       int
	postErrors  map[string][]error
	uploadErrs  map[string][]error
	c           *Composer
	captionText []string
}

var (
	inProgress = &bridge.APIError{Code: "upload_in_progress", Message: "read the upload connection to EOF"}
	stale      = &bridge.APIError{Code: "invalid_params", Message: "no staged upload with that id; upload the file chunks first"}
)

func newRig() *rig {
	r := &rig{postErrors: map[string][]error{}, uploadErrs: map[string][]error{}}
	r.c = NewComposer(func(ctx context.Context, a Attachment, _ func(int64, int64)) (string, error) {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.calls = append(r.calls, "upload "+a.Name)
		if errs := r.uploadErrs[a.Name]; len(errs) > 0 {
			r.uploadErrs[a.Name] = errs[1:]
			return "", errs[0]
		}
		r.uploads++
		return fmt.Sprintf("u%d", r.uploads), nil
	}, nil, nil)
	r.c.RetryDelay = 1
	return r
}

func (r *rig) post(_ context.Context, text string, a *Attachment) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	name := "text"
	if a != nil {
		name = a.Name
		r.calls = append(r.calls, "post "+a.Name+"@"+a.UploadID)
	} else {
		r.calls = append(r.calls, "post text")
	}
	r.captionText = append(r.captionText, text)
	if errs := r.postErrors[name]; len(errs) > 0 {
		r.postErrors[name] = errs[1:]
		return "", errs[0]
	}
	r.posts++
	return fmt.Sprintf("m%d", r.posts), nil
}

// stage adds files and waits for their pre-uploads to settle, so the
// recorded calls are in a known order.
func (r *rig) stage(t *testing.T, names ...string) []string {
	t.Helper()
	var files []Attachment
	for _, n := range names {
		files = append(files, file(n))
	}
	r.c.Add(files)
	until(t, "pre-uploads settle", func() bool {
		for _, n := range names {
			if p, ok := r.c.up.Phase(n); ok && (p.Kind == PhaseQueued || p.Kind == PhaseUploading) {
				return false
			}
		}
		return true
	})
	return names
}

func (r *rig) take() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	c := r.calls
	r.calls = nil
	return c
}

// testUploadsAndPostsEachFileInOrderAndDropsItsStagedBytes (the text rides
// on the first file only).
func TestComposerPostsEachFileInOrderWithTheCaptionOnTheFirst(t *testing.T) {
	r := newRig()
	paths := r.stage(t, "a.txt", "b.png")
	if err := r.c.Send(context.Background(), "hello", paths, r.post); err != nil {
		t.Fatal(err)
	}
	if got := r.take(); !slices.Equal(got, []string{"upload a.txt", "upload b.png", "post a.txt@u1", "post b.png@u2"}) {
		t.Fatalf("calls %v", got)
	}
	if !slices.Equal(r.captionText, []string{"hello", ""}) {
		t.Fatalf("texts %q", r.captionText)
	}
	if st := r.c.Snapshot(); len(st.Chips) != 0 || st.DraftPosted != 1 {
		t.Fatalf("after send %+v", st)
	}
}

// testARetryAfterAPartialFailureResumesWhereTheBatchStopped
func TestComposerARetryResumesWhereTheBatchStopped(t *testing.T) {
	r := newRig()
	paths := r.stage(t, "a.txt", "b.txt", "c.txt")
	r.take()
	r.postErrors["b.txt"] = []error{errors.New("connection lost")}
	err := r.c.Send(context.Background(), "x", paths, r.post)
	var se *SendError
	if !errors.As(err, &se) || se.Note != "Sent 1 of 3. Couldn't send. Try again." {
		t.Fatalf("err %v", err)
	}
	st := r.c.Snapshot()
	if len(st.Chips) != 2 || st.Chips[0].Path != "b.txt" || st.Chips[0].State.Kind != ChipFailed || st.Chips[0].UploadID != "u2" {
		t.Fatalf("after failure %+v", st.Chips)
	}
	r.take()
	if err := r.c.Send(context.Background(), "", []string{"b.txt", "c.txt"}, r.post); err != nil {
		t.Fatal(err)
	}
	if got := r.take(); !slices.Equal(got, []string{"post b.txt@u2", "post c.txt@u3"}) {
		t.Fatalf("retry calls %v: a already posted, b and c already uploaded", got)
	}
}

// testAFailedUploadIsUploadedAgainOnTheRetry
func TestComposerAFailedUploadIsUploadedAgainOnTheRetry(t *testing.T) {
	r := newRig()
	r.uploadErrs["a.txt"] = []error{errors.New("timed out"), errors.New("timed out")}
	paths := r.stage(t, "a.txt")
	if err := r.c.Send(context.Background(), "", paths, r.post); err == nil {
		t.Fatal("the upload should fail")
	}
	if r.posts != 0 {
		t.Fatal("posted")
	}
	r.take()
	if err := r.c.Send(context.Background(), "", paths, r.post); err != nil {
		t.Fatal(err)
	}
	if got := r.take(); !slices.Equal(got, []string{"upload a.txt", "post a.txt@u1"}) {
		t.Fatalf("calls %v", got)
	}
}

// testAStaleUploadIsUploadedAgainAndPostedOnce / testAStalePreUploadIsUploadedAgainOnce
func TestComposerAStaleUploadIsUploadedAgainAndPostedOnce(t *testing.T) {
	r := newRig()
	paths := r.stage(t, "a.txt")
	r.take()
	r.postErrors["a.txt"] = []error{stale}
	if err := r.c.Send(context.Background(), "", paths, r.post); err != nil {
		t.Fatal(err)
	}
	if got := r.take(); !slices.Equal(got, []string{"post a.txt@u1", "upload a.txt", "post a.txt@u2"}) {
		t.Fatalf("calls %v", got)
	}
}

// testAStaleUploadIsUploadedAgainOnlyOnce
func TestComposerAStaleUploadIsUploadedAgainOnlyOnce(t *testing.T) {
	r := newRig()
	paths := r.stage(t, "a.txt")
	r.take()
	r.postErrors["a.txt"] = []error{stale, stale}
	err := r.c.Send(context.Background(), "", paths, r.post)
	if !IsStaleUpload(err) {
		t.Fatalf("err %v", err)
	}
	if got := r.take(); !slices.Equal(got, []string{"post a.txt@u1", "upload a.txt", "post a.txt@u2"}) {
		t.Fatalf("calls %v", got)
	}
}

// testAnInProgressPostIsAskedAgainNotUploadedAgain
func TestComposerAnInProgressPostIsAskedAgain(t *testing.T) {
	r := newRig()
	paths := r.stage(t, "a.txt")
	r.take()
	r.postErrors["a.txt"] = []error{inProgress, inProgress}
	if err := r.c.Send(context.Background(), "", paths, r.post); err != nil {
		t.Fatal(err)
	}
	if got := r.take(); !slices.Equal(got, []string{"post a.txt@u1", "post a.txt@u1", "post a.txt@u1"}) {
		t.Fatalf("calls %v", got)
	}
}

// testTheInProgressRetryIsBounded
func TestComposerTheInProgressRetryIsBounded(t *testing.T) {
	r := newRig()
	paths := r.stage(t, "a.txt")
	r.take()
	r.postErrors["a.txt"] = slices.Repeat([]error{inProgress}, 10)
	err := r.c.Send(context.Background(), "", paths, r.post)
	var se *SendError
	if !errors.As(err, &se) || se.Note != "Still finishing the last upload. Tap Send again." {
		t.Fatalf("err %v", err)
	}
	if got := r.take(); len(got) != PostAttempts || PostAttempts != 3 {
		t.Fatalf("calls %v", got)
	}
	if ch, _ := r.c.Chip("a.txt"); ch.UploadID != "u1" {
		t.Fatal("the retry must post these bytes rather than re-sending them")
	}
}

// testOtherPostRefusalsAreNotRetried
func TestComposerOtherPostRefusalsAreNotRetried(t *testing.T) {
	r := newRig()
	paths := r.stage(t, "a.txt")
	r.take()
	r.postErrors["a.txt"] = []error{&bridge.APIError{Code: "invalid_params", Message: "text too long"}}
	err := r.c.Send(context.Background(), "", paths, r.post)
	var se *SendError
	if !errors.As(err, &se) || se.Note != "text too long" {
		t.Fatalf("err %v", err)
	}
	if got := r.take(); !slices.Equal(got, []string{"post a.txt@u1"}) {
		t.Fatalf("calls %v", got)
	}
}

// testTheProgressNoteNamesHowMuchOfABatchLanded
func TestProgressNote(t *testing.T) {
	for _, c := range []struct {
		d, n int
		want string
	}{{2, 3, "Sent 2 of 3. x"}, {3, 3, "Sent 3 of 3. x"}, {0, 3, "x"}, {1, 1, "x"}} {
		if got := ProgressNote("x", c.d, c.n); got != c.want {
			t.Errorf("ProgressNote(%d, %d) = %q", c.d, c.n, got)
		}
	}
}

// testFinishedUploadsPostBeforeOnesStillUploading
func TestComposerFinishedUploadsPostFirst(t *testing.T) {
	r := newRig()
	r.uploadErrs["a.txt"] = []error{errors.New("lost")}
	paths := r.stage(t, "a.txt", "b.txt")
	r.take()
	if err := r.c.Send(context.Background(), "", paths, r.post); err != nil {
		t.Fatal(err)
	}
	if got := r.take(); !slices.Equal(got, []string{"post b.txt@u1", "upload a.txt", "post a.txt@u2"}) {
		t.Fatalf("calls %v", got)
	}
}

// Text alone is one post; an API refusal is its message (GramView.send).
func TestComposerTextOnly(t *testing.T) {
	r := newRig()
	if err := r.c.Send(context.Background(), "hi", nil, r.post); err != nil || r.c.Snapshot().DraftPosted != 1 {
		t.Fatalf("err %v", err)
	}
	r.postErrors["text"] = []error{&bridge.APIError{Code: "invalid_params", Message: "no live agent named 'x'"}}
	var se *SendError
	if err := r.c.Send(context.Background(), "hi", nil, r.post); !errors.As(err, &se) || se.Note != "no live agent named 'x'" {
		t.Fatalf("err %v", err)
	}
	if err := r.c.Send(context.Background(), "", nil, r.post); err != nil || len(r.take()) != 2 {
		t.Fatal("an empty send posted")
	}
}

// ComposerAttachmentState.for and label (App/ComposerView.swift).
func TestChipStateFor(t *testing.T) {
	a := file("a.txt")
	a.Size = 3 << 20
	up := &Phase{Kind: PhaseUploading, Sent: 1 << 20, Total: 3 << 20}
	for _, c := range []struct {
		a              Attachment
		p              *Phase
		sending        bool
		sendPath, fail string
		want           string
	}{
		{a, nil, false, "", "a.txt", "Failed · tap send to retry"},
		{Attachment{Path: "a.txt", MessageID: "m", Size: a.Size}, nil, false, "", "", "Sent · 3.0 MB"},
		{a, up, false, "", "", "33% · 3.0 MB"},
		{a, &Phase{Kind: PhaseUploading}, false, "", "", "Uploading…"},
		{a, &Phase{Kind: PhaseQueued}, false, "", "", "3.0 MB · Waiting"},
		{a, &Phase{Kind: PhasePaused}, false, "", "", "3.0 MB · Waiting"},
		{a, &Phase{Kind: PhaseFailed}, false, "", "", "Upload failed · tap to retry"},
		{a, &Phase{Kind: PhaseUploaded}, true, "a.txt", "", "Sending…"},
		{a, &Phase{Kind: PhaseUploaded}, true, "b.txt", "", "3.0 MB · Ready"},
		{a, nil, false, "", "", "3.0 MB · Ready"},
		{a, nil, true, "a.txt", "", "Sending…"},
		{a, nil, true, "b.txt", "", "3.0 MB · Waiting"},
	} {
		if got := ChipStateFor(c.a, c.p, c.sending, c.sendPath, c.fail).Label(c.a.Size); got != c.want {
			t.Errorf("%+v: %q, want %q", c, got, c.want)
		}
	}
}

// GramFile.displaySize and GramFileLabelTests.
func TestDisplaySizeAndDownloadedLabel(t *testing.T) {
	for n, want := range map[uint64]string{0: "0 B", 1023: "1023 B", 1024: "1 KB", 1048575: "1024 KB", 1048576: "1.0 MB", 1363148: "1.3 MB"} {
		if got := DisplaySize(n); got != want {
			t.Errorf("DisplaySize(%d) = %q, want %q", n, got, want)
		}
	}
	if got := DownloadedLabel(2000, 1000); got != "1000 B of 1000 B" {
		t.Errorf("done is capped at the size: %q", got)
	}
}

// SkipNote (ComposerAttachPicker.skipNote).
func TestSkipNote(t *testing.T) {
	if got := SkipNote([]string{"a.bin", "b.bin"}, 2); got != "Skipped: too large or unreadable: a.bin, b.bin; 2 over the 10-file limit." {
		t.Fatalf("%q", got)
	}
	if SkipNote(nil, 0) != "" {
		t.Fatal("a note for nothing skipped")
	}
}
