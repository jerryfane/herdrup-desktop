package main

import (
	"context"
	"errors"
	"mime"
	"os"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/gramstore"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// The Gram composer: files upload one at a time from the moment they are
// attached (herdrup ComposerUploader), and Send posts one Gram per file,
// the text on the first, retrying a post herdr refuses while it still
// reads the upload and uploading once more when it has lost it
// (GramAttachmentSender).

// newGramComposer is the composer of connection l. The desk uploads the
// picked file itself rather than a staged copy, so nothing is removed
// after a post; a posted file is copied into the download cache so
// opening it never downloads the bytes this device sent.
func (d *Desk) newGramComposer(l *link) *gramstore.Composer {
	upload := func(ctx context.Context, a gramstore.Attachment, progress func(sent, total int64)) (string, error) {
		ec, err := d.gramEngine(l)
		if err != nil {
			return "", err
		}
		f, err := os.Open(a.Path)
		if err != nil {
			return "", err
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil {
			return "", err
		}
		if st.Size() > gramstore.MaxFileBytes {
			return "", errors.New(a.Name + " is over the 100 MB limit")
		}
		progress(0, st.Size())
		id, _, err := ec.GramUploadFrom(ctx, f, st.Size(), func(sent int64) { progress(sent, st.Size()) })
		return id, err
	}
	discard := func(uploadID string) {
		ec, err := d.gramEngine(l)
		if err != nil {
			return
		}
		g := &d.gram
		g.mu.Lock()
		ctx := g.ctx
		g.mu.Unlock()
		_, _ = ec.GramUploadDiscard(ctx, herdrapi.GramUploadDiscardParams{UploadID: uploadID})
	}
	c := gramstore.NewComposer(upload, discard, func(path string) { d.gramComposerChanged(l, path) })
	c.RetryDelay = gramPostRetryDelay
	g := &d.gram
	epoch := g.epoch // built under g.mu by the reset that set it
	c.Keep = func(a gramstore.Attachment) {
		cache := d.gramCache()
		if _, ok := cache.StoreCopy(a.Path, a.MessageID, a.Name, a.Mime); !ok {
			return
		}
		g.mu.Lock()
		stale := g.epoch != epoch
		g.mu.Unlock()
		if stale {
			cache.Remove(a.MessageID)
		}
	}
	return c
}

// gramPostRetryDelay separates the tries of a post refused with
// upload_in_progress (herdrup retryDelayNanoseconds: 1 s).
var gramPostRetryDelay = gramstore.DefaultRetryDelay

// gramComposerChanged follows a change to the composer: path's upload
// moved ("" for the whole composer). The upload event goes out at most
// once a percent; the snapshot only when a chip's state changes.
func (d *Desk) gramComposerChanged(l *link, path string) {
	g := &d.gram
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.link != l || g.composer == nil {
		return
	}
	if path == "" {
		d.publishGramLocked()
		return
	}
	ev := GramUploadProgress{Path: path, State: "removed"}
	if chip, ok := g.composer.Chip(path); ok {
		a := gramChip(chip)
		ev = GramUploadProgress{Path: path, Fraction: a.Fraction, State: a.State, Label: a.Label}
	}
	last, seen := g.lastUpload[path]
	if seen && last.State == ev.State && ev.Fraction < 1 && ev.Fraction-last.Fraction < 0.01 {
		return
	}
	if ev.State == "removed" {
		delete(g.lastUpload, path)
	} else {
		g.lastUpload[path] = ev
	}
	GramUploadChanged.Broadcast(ev)
	if !seen || last.State != ev.State {
		d.publishGramLocked()
	}
}

// gramStage attaches the files at paths not attached yet, as herdrup's
// picker does: each must be a regular file of 1 byte to 100 MiB, and at
// most 10 are staged. It returns the paths attached, the ones already
// attached included, and a note naming those skipped ("" when none).
func (d *Desk) gramStage(c *gramstore.Composer, paths []string) (staged []string, note string) {
	room := c.Room()
	var add []gramstore.Attachment
	var bad []string
	capped := 0
	for _, p := range paths {
		if c.Has(p) {
			staged = append(staged, p)
			continue
		}
		if len(add) >= room {
			capped++
			continue
		}
		st, err := os.Stat(p)
		if err != nil || !st.Mode().IsRegular() || st.Size() <= 0 || st.Size() > gramstore.MaxFileBytes {
			bad = append(bad, filepath.Base(p))
			continue
		}
		name := gramstore.SafeFileName(filepath.Base(p))
		mt := "application/octet-stream"
		if t := mime.TypeByExtension(filepath.Ext(name)); t != "" {
			if mediatype, _, err := mime.ParseMediaType(t); err == nil {
				mt = mediatype
			}
		}
		add = append(add, gramstore.Attachment{Path: p, Name: name, Mime: mt, IsImage: strings.HasPrefix(mt, "image/"), Size: st.Size()})
		staged = append(staged, p)
	}
	c.Add(add)
	return staged, gramstore.SkipNote(bad, capped)
}

func (d *Desk) gramComposer() (*link, *gramstore.Composer, error) {
	g := &d.gram
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.link == nil || g.composer == nil {
		return nil, nil, errNotConnected
	}
	return g.link, g.composer, nil
}

// GramPickFiles shows the open dialog for files to attach, several at
// once, and attaches them; their uploads start at once. It returns the
// attached paths; any skipped are named in the banner.
func (d *Desk) GramPickFiles(ctx context.Context) ([]string, error) {
	l, c, err := d.gramComposer()
	if err != nil {
		return nil, err
	}
	paths, err := d.openDialog(ctx)
	if err != nil || len(paths) == 0 {
		return nil, err
	}
	staged, note := d.gramStage(c, paths)
	d.gramNote(l, note)
	return staged, nil
}

// GramCancelAttachment removes an attached file: its upload stops, and one
// that finished is discarded on herdr.
func (d *Desk) GramCancelAttachment(path string) error {
	_, c, err := d.gramComposer()
	if err != nil {
		return err
	}
	return c.Remove(path)
}

// GramRetryAttachment uploads a file whose upload failed again (its
// chip's "tap to retry").
func (d *Desk) GramRetryAttachment(path string) error {
	_, c, err := d.gramComposer()
	if err != nil {
		return err
	}
	c.Retry(path)
	return nil
}

// GramPost sends a Gram: text alone, or each attached file of attachments
// as its own Gram with text on the first. to is the agent's routing name,
// or empty for the shared queue. A file not attached yet is attached
// first. The post shows at once and stays until a list has it; on failure
// the banner says why and the files not sent stay attached for a retry.
func (d *Desk) GramPost(ctx context.Context, text string, to []string, attachments []string) error {
	if len(to) > 1 {
		return errors.New("a Gram goes to one agent or to the shared queue")
	}
	var recipient *string
	if len(to) == 1 && to[0] != "" {
		recipient = &to[0]
	}
	l, c, err := d.gramComposer()
	if err != nil {
		return err
	}
	text = strings.TrimSpace(text)
	staged, note := d.gramStage(c, attachments)
	if note != "" {
		d.gramNote(l, note)
		return errors.New(note)
	}
	if text == "" && len(staged) == 0 {
		return nil
	}
	g := &d.gram
	g.mu.Lock()
	if g.link == l {
		g.sendError = ""
		d.publishGramLocked()
	}
	g.mu.Unlock()
	post := func(ctx context.Context, body string, a *gramstore.Attachment) (string, error) {
		ec, err := d.gramEngine(l)
		if err != nil {
			return "", err
		}
		p := herdrapi.GramPostParams{Text: body, To: recipient}
		if a != nil {
			p.File = &herdrapi.GramFileUpload{UploadID: a.UploadID, Name: a.Name, Mime: a.Mime}
		}
		res, err := ec.GramPost(ctx, p)
		if err != nil {
			return "", err
		}
		g.mu.Lock()
		if g.link == l {
			id := res.Message.ID
			g.pending = append([]herdrapi.GramMessageInfo{res.Message}, deleteByID(g.pending, id)...)
			d.publishGramLocked()
		}
		g.mu.Unlock()
		return res.Message.ID, nil
	}
	err = c.Send(ctx, text, staged, post)
	var se *gramstore.SendError
	if errors.As(err, &se) {
		d.gramNote(l, se.Note)
	}
	return err
}

func deleteByID(ms []herdrapi.GramMessageInfo, id string) []herdrapi.GramMessageInfo {
	out := make([]herdrapi.GramMessageInfo, 0, len(ms))
	for _, m := range ms {
		if m.ID != id {
			out = append(out, m)
		}
	}
	return out
}

// The system dialogs, opener and clipboard, replaced in tests.

func mygoOpenDialog(ctx context.Context) ([]string, error) {
	return mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: mygo.CallerWindow(ctx), Title: "Attach", ButtonLabel: "Attach", Multiple: true})
}

func mygoSaveDialog(ctx context.Context, name string) (string, error) {
	return mygo.Dialog.Save(mygo.SaveDialogOptions{Parent: mygo.CallerWindow(ctx), DefaultPath: name, CreateDirectories: true})
}

func mygoOpenPath(path string) error { return mygo.Shell.OpenPath(path) }

func mygoWriteText(text string) { mygo.Clipboard.WriteText(text) }
