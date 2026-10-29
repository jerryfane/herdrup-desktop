package gramstore

import (
	"context"
	"slices"
	"sync"
)

// Attachment is one file staged in the composer on its way to an agent as
// its own Gram message (herdrup ComposerAttachment). Path, the local file,
// identifies it: a path staged twice is one attachment.
type Attachment struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Mime    string `json:"mime"`
	IsImage bool   `json:"isImage"`
	Size    int64  `json:"size"`
	// UploadID is herdr's id for the uploaded bytes, kept so a retry posts
	// them without uploading again.
	UploadID string `json:"-"`
	// MessageID is the posted Gram, kept so a retry skips this file.
	MessageID string `json:"-"`
}

// PhaseKind is where one attachment's upload stands.
type PhaseKind int

const (
	// PhaseQueued waits behind another file's upload.
	PhaseQueued PhaseKind = iota + 1
	PhaseUploading
	// PhaseUploaded is on herdr, ready to post.
	PhaseUploaded
	// PhasePaused stopped because Gram went off screen.
	PhasePaused
	// PhaseFailed failed; Retry (or Send) uploads it again.
	PhaseFailed
)

// Phase is an attachment's upload (herdrup ComposerUploader.Phase).
type Phase struct {
	Kind        PhaseKind
	Sent, Total int64
	UploadID    string
}

// UploadFunc uploads one file, reporting bytes sent, and returns herdr's
// upload_id.
type UploadFunc func(ctx context.Context, a Attachment, progress func(sent, total int64)) (string, error)

// Uploader uploads a composer's attachments one at a time, in the order
// added, as soon as each is added (herdrup ComposerUploader): serial
// because every staged upload counts against herdr's shared staging
// budget. Removing a file cancels its upload and discards a finished one.
type Uploader struct {
	upload UploadFunc
	// discard drops an upload nothing will post (gram.upload.discard, best
	// effort).
	discard func(uploadID string)
	// changed is told, without the lock held, when path's phase changed;
	// uploaded, when its upload landed.
	changed  func(path string)
	uploaded func(path, uploadID string)

	mu       sync.Mutex
	jobs     map[string]*uploadJob
	order    []string
	running  *runningUpload
	pumping  bool
	attempts int
	closed   bool
}

type uploadResult struct {
	id  string
	err error
}

type uploadJob struct {
	file    Attachment
	phase   Phase
	waiters []chan uploadResult
}

type runningUpload struct {
	path    string
	attempt int
	cancel  context.CancelFunc
	// discardOnLanding is set when the file was removed mid-upload: an
	// upload that completes anyway is discarded when it lands.
	discardOnLanding bool
}

// NewUploader returns an uploader; changed and uploaded may be nil.
func NewUploader(upload UploadFunc, discard func(uploadID string), changed func(path string), uploaded func(path, uploadID string)) *Uploader {
	if discard == nil {
		discard = func(string) {}
	}
	if changed == nil {
		changed = func(string) {}
	}
	if uploaded == nil {
		uploaded = func(string, string) {}
	}
	return &Uploader{upload: upload, discard: discard, changed: changed, uploaded: uploaded, jobs: map[string]*uploadJob{}}
}

// Phase returns path's upload, ok false for a file it does not know.
func (u *Uploader) Phase(path string) (Phase, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if j := u.jobs[path]; j != nil {
		return j.phase, true
	}
	return Phase{}, false
}

// Start queues a's upload behind any running and starts it if the line is
// free. A file already known is left as it is.
func (u *Uploader) Start(a Attachment) {
	u.mu.Lock()
	if u.closed || u.jobs[a.Path] != nil {
		u.mu.Unlock()
		return
	}
	u.jobs[a.Path] = &uploadJob{file: a, phase: Phase{Kind: PhaseQueued}}
	u.order = append(u.order, a.Path)
	u.pumpLocked()
	u.mu.Unlock()
	u.changed(a.Path)
}

// Retry uploads a failed or paused file again (the chip's tap to retry).
func (u *Uploader) Retry(path string) {
	u.mu.Lock()
	j := u.jobs[path]
	if j == nil || (j.phase.Kind != PhaseFailed && j.phase.Kind != PhasePaused) {
		u.mu.Unlock()
		return
	}
	j.phase = Phase{Kind: PhaseQueued}
	u.pumpLocked()
	u.mu.Unlock()
	u.changed(path)
}

// Wait returns herdr's id for path's pre-upload: at once when it has
// finished, once it finishes when it is queued or running (with its
// failure), or ok false when there is none to wait for and the caller must
// upload now (herdrup waitForUpload).
func (u *Uploader) Wait(ctx context.Context, path string) (uploadID string, ok bool, err error) {
	u.mu.Lock()
	j := u.jobs[path]
	if j == nil {
		u.mu.Unlock()
		return "", false, nil
	}
	switch j.phase.Kind {
	case PhaseUploaded:
		u.mu.Unlock()
		return j.phase.UploadID, true, nil
	case PhaseQueued, PhaseUploading:
		ch := make(chan uploadResult, 1)
		j.waiters = append(j.waiters, ch)
		u.mu.Unlock()
		r, err := await(ctx, ch)
		return r, true, err
	}
	u.mu.Unlock()
	return "", false, nil
}

// Upload uploads a now, in line behind any running upload, and returns
// herdr's id; it waits for an upload of it already queued or running
// rather than starting a second one. Send uses it for a file with no
// pre-upload, and for one whose upload herdr lost.
func (u *Uploader) Upload(ctx context.Context, a Attachment) (string, error) {
	u.mu.Lock()
	if u.closed {
		u.mu.Unlock()
		return "", context.Canceled
	}
	j := u.jobs[a.Path]
	if j == nil {
		j = &uploadJob{file: a}
		u.jobs[a.Path] = j
		u.order = append(u.order, a.Path)
	}
	if j.phase.Kind != PhaseQueued && j.phase.Kind != PhaseUploading {
		j.file.UploadID = ""
		j.phase = Phase{Kind: PhaseQueued}
		u.pumpLocked()
	}
	ch := make(chan uploadResult, 1)
	j.waiters = append(j.waiters, ch)
	u.mu.Unlock()
	u.changed(a.Path)
	return await(ctx, ch)
}

func await(ctx context.Context, ch chan uploadResult) (string, error) {
	select {
	case r := <-ch:
		return r.id, r.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// Remove is a file leaving the draft: its upload is cancelled, and a
// finished one nothing posted is discarded on herdr.
func (u *Uploader) Remove(a Attachment) {
	u.mu.Lock()
	var phase Phase
	if j := u.jobs[a.Path]; j != nil {
		phase = j.phase
	}
	u.dropLocked(a.Path, a.MessageID == "")
	u.mu.Unlock()
	if a.MessageID == "" && phase.Kind == PhaseUploaded {
		go u.discard(phase.UploadID)
	}
	u.changed(a.Path)
}

// Forget drops sent files without a discard: each post consumed its
// upload.
func (u *Uploader) Forget(paths []string) {
	u.mu.Lock()
	for _, p := range paths {
		u.dropLocked(p, false)
	}
	u.mu.Unlock()
}

// Pause stops every upload no Send waits on (Gram went off screen);
// finished uploads stay. Resume picks them up again.
func (u *Uploader) Pause() {
	u.mu.Lock()
	var paused []string
	for _, p := range u.order {
		j := u.jobs[p]
		if len(j.waiters) > 0 || (j.phase.Kind != PhaseQueued && j.phase.Kind != PhaseUploading) {
			continue
		}
		j.phase = Phase{Kind: PhasePaused}
		paused = append(paused, p)
		if u.running != nil && u.running.path == p {
			u.running.cancel()
		}
	}
	u.mu.Unlock()
	for _, p := range paused {
		u.changed(p)
	}
}

// Resume queues the uploads Pause stopped.
func (u *Uploader) Resume() {
	u.mu.Lock()
	var resumed []string
	for _, p := range u.order {
		if j := u.jobs[p]; j.phase.Kind == PhasePaused {
			j.phase = Phase{Kind: PhaseQueued}
			resumed = append(resumed, p)
		}
	}
	if len(resumed) > 0 {
		u.pumpLocked()
	}
	u.mu.Unlock()
	for _, p := range resumed {
		u.changed(p)
	}
}

// Close abandons the draft: the running upload is cancelled and nothing
// more starts. Its uploads are left to herdr's 24 h staging sweep, as the
// connection they were made on is going away.
func (u *Uploader) Close() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.closed = true
	for _, p := range slices.Clone(u.order) {
		u.dropLocked(p, false)
	}
}

// PendingProgress is byte progress over the uploads still to finish among
// paths, for the Send button while it waits on them; ok is false when
// none is pending.
func (u *Uploader) PendingProgress(paths []string) (fraction float64, ok bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	var sent, total int64
	for _, p := range paths {
		j := u.jobs[p]
		if j == nil {
			continue
		}
		switch j.phase.Kind {
		case PhaseQueued:
			ok = true
			total += j.file.Size
		case PhaseUploading:
			ok = true
			sent += j.phase.Sent
			total += max(j.phase.Total, j.phase.Sent)
		}
	}
	if !ok {
		return 0, false
	}
	if total <= 0 {
		return 0, true
	}
	return min(1, float64(sent)/float64(total)), true
}

func (u *Uploader) dropLocked(path string, discardIfItLands bool) {
	j := u.jobs[path]
	if j == nil {
		return
	}
	delete(u.jobs, path)
	u.order = slices.DeleteFunc(u.order, func(p string) bool { return p == path })
	if u.running != nil && u.running.path == path {
		u.running.discardOnLanding = discardIfItLands
		u.running.cancel()
	}
	for _, w := range j.waiters {
		w <- uploadResult{err: context.Canceled}
	}
}

// pumpLocked starts the one goroutine that works the line, if none runs.
func (u *Uploader) pumpLocked() {
	if u.pumping || u.closed {
		return
	}
	u.pumping = true
	go u.work()
}

func (u *Uploader) work() {
	for {
		u.mu.Lock()
		next, file, ctx := u.startNextLocked()
		if next == nil {
			u.pumping = false
			u.mu.Unlock()
			return
		}
		u.mu.Unlock()
		u.changed(next.path)
		attempt := next.attempt
		id, err := u.upload(ctx, file, func(sent, total int64) { u.progress(file.Path, attempt, sent, total) })
		next.cancel()
		u.complete(next, id, err)
	}
}

func (u *Uploader) startNextLocked() (*runningUpload, Attachment, context.Context) {
	for _, p := range u.order {
		j := u.jobs[p]
		if j.phase.Kind != PhaseQueued {
			continue
		}
		u.attempts++
		ctx, cancel := context.WithCancel(context.Background())
		j.phase = Phase{Kind: PhaseUploading, Total: j.file.Size}
		u.running = &runningUpload{path: p, attempt: u.attempts, cancel: cancel}
		return u.running, j.file, ctx
	}
	return nil, Attachment{}, nil
}

func (u *Uploader) progress(path string, attempt int, sent, total int64) {
	u.mu.Lock()
	j := u.jobs[path]
	if u.running == nil || u.running.attempt != attempt || j == nil || j.phase.Kind != PhaseUploading {
		u.mu.Unlock()
		return
	}
	j.phase.Sent, j.phase.Total = sent, total
	u.mu.Unlock()
	u.changed(path)
}

func (u *Uploader) complete(started *runningUpload, id string, err error) {
	u.mu.Lock()
	discardOnLanding := u.running != nil && u.running.discardOnLanding
	u.running = nil
	j := u.jobs[started.path]
	if j == nil {
		// Removed mid-upload; one that landed anyway would hold staging
		// until the sweep.
		u.mu.Unlock()
		if err == nil && discardOnLanding {
			go u.discard(id)
		}
		return
	}
	waiters := j.waiters
	if err == nil {
		j.waiters = nil
		j.file.UploadID = id
		j.phase = Phase{Kind: PhaseUploaded, UploadID: id}
		u.mu.Unlock()
		u.uploaded(started.path, id)
		for _, w := range waiters {
			w <- uploadResult{id: id}
		}
		u.changed(started.path)
		return
	}
	if j.phase.Kind != PhaseUploading {
		// Paused (and maybe queued again since): the stop was ours.
		u.mu.Unlock()
		return
	}
	j.waiters = nil
	j.phase = Phase{Kind: PhaseFailed}
	u.mu.Unlock()
	for _, w := range waiters {
		w <- uploadResult{err: err}
	}
	u.changed(started.path)
}
