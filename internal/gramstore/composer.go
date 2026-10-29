package gramstore

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
)

// Composer limits (herdrup ComposerStaging): each file at most 100 MiB,
// inclusive like herdr's own check, and at most 10 staged at once.
const (
	MaxFileBytes   = 100 << 20
	MaxAttachments = 10
)

// PostAttempts is how many times a post refused with upload_in_progress is
// tried, DefaultRetryDelay apart (herdrup GramAttachmentSender.postAttempts
// and retryDelayNanoseconds).
const (
	PostAttempts      = 3
	DefaultRetryDelay = time.Second
)

// IsStaleUpload reports herdr refusing a post because it holds no upload
// under that id: already consumed, or never finished.
func IsStaleUpload(err error) bool {
	var api *bridge.APIError
	return errors.As(err, &api) && api.Code == "invalid_params" && strings.Contains(api.Message, "no staged upload")
}

func isUploadInProgress(err error) bool {
	var api *bridge.APIError
	return errors.As(err, &api) && api.Code == "upload_in_progress"
}

// ProgressNote says how much of a batch landed before a failure (herdrup
// GramAttachmentSender.progressNote).
func ProgressNote(reason string, delivered, total int) string {
	if total <= 1 || delivered <= 0 {
		return reason
	}
	return fmt.Sprintf("Sent %d of %d. %s", delivered, total, reason)
}

// SkipNote names the picks that did not stage (herdrup
// ComposerAttachPicker.skipNote); "" when all did.
func SkipNote(bad []string, capped int) string {
	var parts []string
	if len(bad) > 0 {
		parts = append(parts, "too large or unreadable: "+strings.Join(bad, ", "))
	}
	if capped > 0 {
		parts = append(parts, fmt.Sprintf("%d over the %d-file limit", capped, MaxAttachments))
	}
	if len(parts) == 0 {
		return ""
	}
	return "Skipped: " + strings.Join(parts, "; ") + "."
}

// PostFunc posts one Gram: text alone when a is nil, else a's uploaded
// file with text as its caption. It returns the posted message's id.
type PostFunc func(ctx context.Context, text string, a *Attachment) (string, error)

// SendError is a send that stopped; Note is what the banner says.
type SendError struct {
	Note string
	Err  error
}

func (e *SendError) Error() string { return e.Note }
func (e *SendError) Unwrap() error { return e.Err }

// Composer is the Gram composer's staged attachments and its send: the
// attachments upload from the moment they are added (Uploader) and Send
// posts one Gram per file, the text riding on the first, as herdrup's
// GramView.send with GramAttachmentSender does.
type Composer struct {
	// Keep is handed each posted file, to keep it in the download cache.
	Keep func(a Attachment)
	// RetryDelay separates upload_in_progress retries (DefaultRetryDelay
	// when 0).
	RetryDelay time.Duration
	// changed is told, without the lock, when anything the chips show
	// moved; path is "" for a change to the whole composer.
	changed func(path string)

	up *Uploader

	mu          sync.Mutex
	files       []Attachment
	sending     bool
	sendingPath string
	failedPath  string
	// draftPosted counts posts that carried the draft's text: the page
	// clears its draft when it moves, so a retry never posts it again.
	draftPosted int
}

// NewComposer returns a composer whose files upload with upload.
func NewComposer(upload UploadFunc, discard func(uploadID string), changed func(path string)) *Composer {
	if changed == nil {
		changed = func(string) {}
	}
	c := &Composer{changed: changed}
	c.up = NewUploader(upload, discard, changed, func(path, id string) {
		c.mu.Lock()
		if i := c.index(path); i >= 0 {
			c.files[i].UploadID = id
		}
		c.mu.Unlock()
	})
	return c
}

func (c *Composer) index(path string) int {
	return slices.IndexFunc(c.files, func(a Attachment) bool { return a.Path == path })
}

// Room is how many more files may be staged.
func (c *Composer) Room() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return MaxAttachments - len(c.files)
}

// Has reports whether path is staged.
func (c *Composer) Has(path string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.index(path) >= 0
}

// Add stages files not staged yet and starts their uploads.
func (c *Composer) Add(files []Attachment) {
	c.mu.Lock()
	var added []Attachment
	for _, a := range files {
		if c.index(a.Path) >= 0 || len(c.files) >= MaxAttachments {
			continue
		}
		c.files = append(c.files, a)
		added = append(added, a)
	}
	c.mu.Unlock()
	for _, a := range added {
		c.up.Start(a)
	}
	c.changed("")
}

// ErrSending refuses a change to the attachments while a send runs.
var ErrSending = errors.New("a send is running")

// Remove unstages path, cancelling its upload and discarding a finished
// one. herdrup disables the remove button while sending.
func (c *Composer) Remove(path string) error {
	c.mu.Lock()
	if c.sending {
		c.mu.Unlock()
		return ErrSending
	}
	i := c.index(path)
	if i < 0 {
		c.mu.Unlock()
		return nil
	}
	a := c.files[i]
	c.files = slices.Delete(c.files, i, i+1)
	if c.failedPath == path {
		c.failedPath = ""
	}
	c.mu.Unlock()
	c.up.Remove(a)
	c.changed("")
	return nil
}

// Retry uploads a failed or paused file again.
func (c *Composer) Retry(path string) { c.up.Retry(path) }

// Pause and Resume follow Gram going off and on screen.
func (c *Composer) Pause()  { c.up.Pause() }
func (c *Composer) Resume() { c.up.Resume() }

// Close abandons the draft.
func (c *Composer) Close() { c.up.Close() }

// Chip is one staged file as its chip draws it.
type Chip struct {
	Attachment
	State ChipState
}

// State is what the chips and Send show.
type State struct {
	Chips       []Chip
	Sending     bool
	DraftPosted int
	// Progress is byte progress over the uploads Send still waits on; ok
	// false when none is pending.
	Progress   float64
	ProgressOK bool
}

// Snapshot returns the composer as the page draws it.
func (c *Composer) Snapshot() State {
	c.mu.Lock()
	files := slices.Clone(c.files)
	sending, sendingPath, failedPath, posted := c.sending, c.sendingPath, c.failedPath, c.draftPosted
	c.mu.Unlock()
	st := State{Sending: sending, DraftPosted: posted}
	paths := make([]string, 0, len(files))
	for _, a := range files {
		paths = append(paths, a.Path)
		var phase *Phase
		if p, ok := c.up.Phase(a.Path); ok {
			phase = &p
		}
		st.Chips = append(st.Chips, Chip{Attachment: a, State: ChipStateFor(a, phase, sending, sendingPath, failedPath)})
	}
	st.Progress, st.ProgressOK = c.up.PendingProgress(paths)
	return st
}

// Chip returns path's chip.
func (c *Composer) Chip(path string) (Chip, bool) {
	for _, ch := range c.Snapshot().Chips {
		if ch.Path == path {
			return ch, true
		}
	}
	return Chip{}, false
}

// Send posts text and the staged files of paths, in that order (herdrup
// GramView.send). Text alone is one post. With files, each posts as its
// own Gram and the text rides on the first; the files that posted leave
// the composer and a failed one stays for a retry. Nothing is sent when
// there is neither text nor a staged file of paths.
func (c *Composer) Send(ctx context.Context, text string, paths []string, post PostFunc) error {
	c.mu.Lock()
	if c.sending {
		c.mu.Unlock()
		return ErrSending
	}
	var batch []Attachment
	for _, p := range paths {
		if i := c.index(p); i >= 0 {
			batch = append(batch, c.files[i])
		}
	}
	if text == "" && len(batch) == 0 {
		c.mu.Unlock()
		return nil
	}
	c.sending, c.failedPath = true, ""
	c.mu.Unlock()
	c.changed("")
	defer func() {
		c.mu.Lock()
		c.sending, c.sendingPath = false, ""
		c.mu.Unlock()
		c.changed("")
	}()

	if len(batch) == 0 {
		if _, err := post(ctx, text, nil); err != nil {
			var api *bridge.APIError
			if errors.As(err, &api) {
				return &SendError{Note: api.Message, Err: err}
			}
			return &SendError{Note: "Couldn't send. Try again.", Err: err}
		}
		c.mu.Lock()
		c.draftPosted++
		c.mu.Unlock()
		return nil
	}

	caption := batch[0].Path
	s := sender{upload: c.up.Upload, preUploaded: func(ctx context.Context, a Attachment) (string, bool, error) {
		return c.up.Wait(ctx, a.Path)
	}, keep: c.Keep, delay: c.RetryDelay, post: func(ctx context.Context, a Attachment) (string, error) {
		body := ""
		if a.Path == caption {
			body = text
		}
		id, err := post(ctx, body, &a)
		if err == nil && a.Path == caption {
			c.mu.Lock()
			c.draftPosted++
			c.mu.Unlock()
		}
		return id, err
	}}
	failure := s.send(ctx, batch, func(a Attachment) {
		c.mu.Lock()
		c.sendingPath = a.Path
		c.mu.Unlock()
		c.changed(a.Path)
	}, func(a Attachment) {
		c.mu.Lock()
		if i := c.index(a.Path); i >= 0 {
			c.files[i].UploadID, c.files[i].MessageID = a.UploadID, a.MessageID
		}
		c.mu.Unlock()
		c.changed(a.Path)
	})

	c.mu.Lock()
	var posted []string
	c.files = slices.DeleteFunc(c.files, func(a Attachment) bool {
		if a.MessageID != "" {
			posted = append(posted, a.Path)
			return true
		}
		return false
	})
	if failure != nil {
		c.failedPath = failure.attachment.Path
	}
	c.mu.Unlock()
	c.up.Forget(posted)
	if failure == nil {
		return nil
	}
	reason := "Couldn't send. Try again."
	var api *bridge.APIError
	switch {
	case isUploadInProgress(failure.err):
		// Still refused after the retries: the bytes are staged and whole,
		// so this is a retry, not a failure.
		reason = "Still finishing the last upload. Tap Send again."
	case errors.As(failure.err, &api):
		reason = api.Message
	}
	return &SendError{Note: ProgressNote(reason, failure.delivered, failure.total), Err: failure.err}
}

// sender delivers a batch of files (herdrup GramAttachmentSender): serial,
// resumable (each file's upload and message ids are handed to update the
// moment they are known), waiting on a pre-upload rather than uploading
// twice, retrying a post refused with upload_in_progress and uploading once
// more when herdr lost the upload.
type sender struct {
	// upload uploads a file now and returns herdr's upload_id.
	upload func(ctx context.Context, a Attachment) (string, error)
	// preUploaded is the composer's pre-upload of a file: its upload_id
	// once it finishes, or ok false when there is none to wait for.
	preUploaded func(ctx context.Context, a Attachment) (id string, ok bool, err error)
	post        func(ctx context.Context, a Attachment) (string, error)
	keep        func(a Attachment)
	delay       time.Duration
}

type sendFailure struct {
	attachment       Attachment
	delivered, total int
	err              error
}

func (s sender) send(ctx context.Context, batch []Attachment, sending, update func(Attachment)) *sendFailure {
	var order []int
	for i, a := range batch {
		if a.UploadID != "" || a.MessageID != "" {
			order = append(order, i)
		}
	}
	for i, a := range batch {
		if a.UploadID == "" && a.MessageID == "" {
			order = append(order, i)
		}
	}
	delivered := 0
	for _, i := range order {
		a := batch[i]
		if a.MessageID == "" {
			sending(a)
			if err := s.deliver(ctx, &a, update); err != nil {
				return &sendFailure{attachment: a, delivered: delivered, total: len(batch), err: err}
			}
		}
		delivered++
	}
	return nil
}

func (s sender) deliver(ctx context.Context, a *Attachment, update func(Attachment)) error {
	if a.UploadID == "" {
		id, ok, err := s.preUploaded(ctx, *a)
		if err != nil {
			return err
		}
		if !ok {
			if id, err = s.upload(ctx, *a); err != nil {
				return err
			}
		}
		a.UploadID = id
		update(*a)
	}
	id, err := s.postRetrying(ctx, *a)
	if IsStaleUpload(err) {
		a.UploadID = ""
		update(*a)
		if a.UploadID, err = s.upload(ctx, *a); err != nil {
			return err
		}
		update(*a)
		id, err = s.postRetrying(ctx, *a)
	}
	if err != nil {
		return err
	}
	a.MessageID = id
	update(*a)
	if s.keep != nil {
		s.keep(*a)
	}
	return nil
}

// postRetrying posts, asking again (never uploading again) while herdr
// still owns the upload_id.
func (s sender) postRetrying(ctx context.Context, a Attachment) (string, error) {
	delay := s.delay
	if delay <= 0 {
		delay = DefaultRetryDelay
	}
	for attempt := 1; ; attempt++ {
		id, err := s.post(ctx, a)
		if err == nil || !isUploadInProgress(err) || attempt >= PostAttempts {
			return id, err
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(delay):
		}
	}
}
