package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/gramstore"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// Gram files: downloaded once into a cache by message id (herdrup
// GramFileCache, 512 MiB, least recently used out), one transfer per id
// shared by whoever asks, and pictures fetched unasked only when at most
// 8 MiB and two at a time (GramImagePreview).
//
// herdrup's owner downloads with one gram.get_file reply; the desk reads
// gram.get_file_chunk pieces of 512 KiB instead. A whole 100 MiB file in one
// reply is 133 MiB of base64, over the bridge's 64 MiB reply line, and the
// pieces give real progress and never hold the file in memory.

const gramPreviewMaxBytes = 8 << 20

// gramChunkBytes is herdr's cap on one gram.get_file_chunk reply.
const gramChunkBytes = 512 << 10

func (d *Desk) gramCacheBase() string {
	if d.cacheDir != "" {
		return d.cacheDir
	}
	return filepath.Join(d.dir, "cache")
}

// gramCache is the download cache.
func (d *Desk) gramCache() gramstore.FileCache {
	return gramstore.FileCache{Root: filepath.Join(d.gramCacheBase(), "gram-downloads")}
}

func (d *Desk) gramPartialDir() string { return filepath.Join(d.gramCacheBase(), "gram-partial") }

func (d *Desk) gramOwnerPath() string { return filepath.Join(d.gramCacheBase(), "gram-owner") }

// gramWipeCacheUnlessOwner drops every downloaded file unless they were
// downloaded from owner, then records owner: the bytes must not outlive the
// machine that could read them. "" wipes them for good (a disconnect).
func (d *Desk) gramWipeCacheUnlessOwner(owner string) {
	if owner != "" {
		if b, err := os.ReadFile(d.gramOwnerPath()); err == nil && string(b) == owner {
			return
		}
	}
	d.gramCache().RemoveAll()
	_ = os.RemoveAll(d.gramPartialDir())
	_ = os.Remove(d.gramOwnerPath())
	if owner != "" {
		if err := os.MkdirAll(d.gramCacheBase(), 0o700); err == nil {
			_ = os.WriteFile(d.gramOwnerPath(), []byte(owner), 0o600)
		}
	}
}

// gramFileMeta is what a download needs of a message's file: from the
// held messages, else a saved copy (which can open while the original
// still exists).
func (d *Desk) gramFileMeta(id string) (name, mime string, size uint64, err error) {
	g := &d.gram
	g.mu.Lock()
	m, ok := g.findLocked(id)
	g.mu.Unlock()
	if ok {
		if m.File == nil {
			return "", "", 0, errors.New("that message has no file")
		}
		return m.File.Name, m.File.Mime, m.File.Size, nil
	}
	if s, ok := d.savedGrams().Get(id); ok && s.File != nil {
		return s.File.Name, s.File.Mime, s.File.Size, nil
	}
	return "", "", 0, errors.New("that message has no file")
}

type gramFlight struct {
	done chan struct{}
	path string
	mime string
	err  error
}

// gramFetch returns a local path holding the file of message id: the
// cached copy, else one downloaded now (or already being downloaded).
func (d *Desk) gramFetch(ctx context.Context, l *link, id string, size uint64) (path, mime string, err error) {
	if hit, ok := d.gramCache().Cached(id); ok {
		return hit.Path, hit.Mime, nil
	}
	g := &d.gram
	g.mu.Lock()
	if g.link != l {
		g.mu.Unlock()
		return "", "", errNotConnected
	}
	f := g.flights[id]
	if f == nil {
		f = &gramFlight{done: make(chan struct{})}
		g.flights[id] = f
		go d.gramDownload(g.ctx, l, g.epoch, id, size, f)
	}
	g.mu.Unlock()
	select {
	case <-f.done:
		return f.path, f.mime, f.err
	case <-ctx.Done():
		return "", "", ctx.Err()
	}
}

var errGramFileData = errors.New("the server returned file data that could not be decoded")

func (d *Desk) gramDownload(ctx context.Context, l *link, epoch int, id string, size uint64, f *gramFlight) {
	progress := func(done uint64, state string) {
		GramDownloadChanged.Broadcast(GramDownloadProgress{ID: id, Done: done, Size: size, State: state,
			Label: gramstore.DownloadedLabel(done, size)})
	}
	finish := func() {
		g := &d.gram
		g.mu.Lock()
		if g.flights[id] == f {
			delete(g.flights, id)
		}
		g.mu.Unlock()
		close(f.done)
		state := "done"
		if f.err != nil {
			state = "failed"
		}
		progress(size, state)
	}
	defer finish()
	if size > gramstore.MaxFileBytes {
		f.err = errGramFileData
		return
	}
	ec, err := d.gramEngine(l)
	if err != nil {
		f.err = err
		return
	}
	if err := os.MkdirAll(d.gramPartialDir(), 0o700); err != nil {
		f.err = err
		return
	}
	tmp, err := os.CreateTemp(d.gramPartialDir(), "download-*")
	if err != nil {
		f.err = err
		return
	}
	keepTmp := false
	defer func() {
		if !keepTmp {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	progress(0, "downloading")
	name, mime, err := gramReadChunks(ctx, func(off uint64) (herdrapi.ResponseResultGramFileChunk, error) {
		return ec.GramGetFileChunk(ctx, herdrapi.GramGetFileChunkParams{ID: id, Offset: off})
	}, size, tmp, func(done uint64) { progress(done, "downloading") })
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		f.err = err
		return
	}
	g := &d.gram
	cache := d.gramCache()
	hit, ok := cache.StoreMoving(tmp.Name(), id, name, mime)
	g.mu.Lock()
	stale := g.epoch != epoch
	g.mu.Unlock()
	if stale {
		cache.Remove(id)
		f.err = errNotConnected
		return
	}
	if ok {
		f.path, f.mime = hit.Path, hit.Mime
		return
	}
	// Not cacheable (an empty file): use the download where it is; the
	// partial directory goes with the next reset.
	keepTmp = true
	f.path, f.mime = tmp.Name(), mime
}

// gramReadChunks downloads a file in gram.get_file_chunk pieces into w
// with herdrup's gramGetFileChunked checks: the listed size on every
// piece (the first piece's when none is listed), exact offsets, at most
// 512 KiB a piece and never past the size.
func gramReadChunks(ctx context.Context, chunk func(off uint64) (herdrapi.ResponseResultGramFileChunk, error),
	expected uint64, w io.Writer, progress func(done uint64)) (name, mime string, err error) {
	if expected > gramstore.MaxFileBytes {
		return "", "", errGramFileData
	}
	maxEncoded := (gramChunkBytes + 2) / 3 * 4
	size := expected
	known := expected > 0
	var done uint64
	for {
		if err := ctx.Err(); err != nil {
			return "", "", err
		}
		c, err := chunk(done)
		if err != nil {
			return "", "", err
		}
		if c.Size > gramstore.MaxFileBytes || (known && c.Size != size) || c.Offset != done || len(c.DataBase64) > maxEncoded {
			return "", "", errGramFileData
		}
		b, err := base64.StdEncoding.DecodeString(c.DataBase64)
		if err != nil || (len(b) == 0 && c.Size != done) || len(b) > gramChunkBytes || uint64(len(b)) > c.Size-done {
			return "", "", errGramFileData
		}
		if !known {
			size, known = c.Size, true
		}
		if _, err := w.Write(b); err != nil {
			return "", "", err
		}
		done += uint64(len(b))
		progress(done)
		if done == size {
			return c.Name, c.Mime, nil
		}
	}
}

// gramFileError is the banner for a failed open or save: verb is "open"
// or "save".
func gramFileError(verb string, err error) string {
	var api *bridge.APIError
	if errors.As(err, &api) {
		return fmt.Sprintf("Couldn't %s the file: %s", verb, api.Message)
	}
	return fmt.Sprintf("Couldn't %s the file.", verb)
}

func (d *Desk) gramNote(l *link, text string) {
	g := &d.gram
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.link == l {
		g.sendError = text
		d.publishGramLocked()
	}
}

// GramOpenFile opens a message's file with the system's default app,
// downloading it the first time. herdrup's QuickLook and in-app HTML/SVG
// viewer have no desktop counterpart; a program or script is not opened
// at all, since the system opener would run it.
func (d *Desk) GramOpenFile(ctx context.Context, id string) error {
	l, err := d.gramLink()
	if err != nil {
		return err
	}
	name, _, size, err := d.gramFileMeta(id)
	if err != nil {
		d.gramNote(l, gramFileError("open", err))
		return err
	}
	if !gramstore.Openable(name) {
		err := fmt.Errorf("%s is a program or script: save it to open it", name)
		d.gramNote(l, "Couldn't open the file: programs and scripts can only be saved.")
		return err
	}
	path, _, err := d.gramFetch(ctx, l, id, size)
	if err == nil {
		err = d.openPath(path)
	}
	if err != nil {
		d.gramNote(l, gramFileError("open", err))
		return err
	}
	return nil
}

// GramSaveFile saves a message's file where the save dialog says, from the
// cache when it was downloaded before.
func (d *Desk) GramSaveFile(ctx context.Context, id string) error {
	l, err := d.gramLink()
	if err != nil {
		return err
	}
	name, _, size, err := d.gramFileMeta(id)
	if err != nil {
		d.gramNote(l, gramFileError("save", err))
		return err
	}
	dest, err := d.saveDialog(ctx, gramstore.SafeFileName(name))
	if err != nil || dest == "" {
		return err
	}
	src, _, err := d.gramFetch(ctx, l, id, size)
	if err == nil {
		err = copyFileAtomic(src, dest)
	}
	if err != nil {
		d.gramNote(l, gramFileError("save", err))
		return err
	}
	return nil
}

// copyFileAtomic copies src to dest through a temporary file beside dest.
func copyFileAtomic(src, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.CreateTemp(filepath.Dir(dest), ".herdrup-save-*")
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(out.Name(), dest)
	}
	if err != nil {
		os.Remove(out.Name())
	}
	return err
}

// GramImage returns a picture attachment as a data: URL for the feed's
// card: only an image of at most 8 MiB, fetched at most two at a time.
// The page decides when a card has shown long enough to ask.
func (d *Desk) GramImage(ctx context.Context, id string) (string, error) {
	l, err := d.gramLink()
	if err != nil {
		return "", err
	}
	name, mime, size, err := d.gramFileMeta(id)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(strings.ToLower(mime), "image/") || size > gramPreviewMaxBytes {
		return "", fmt.Errorf("%s has no preview", name)
	}
	path, cachedMime, ok := "", "", false
	if hit, hitOK := d.gramCache().Cached(id); hitOK {
		path, cachedMime, ok = hit.Path, hit.Mime, true
	}
	if !ok {
		g := &d.gram
		select {
		case g.slots <- struct{}{}:
		case <-ctx.Done():
			return "", ctx.Err()
		}
		path, cachedMime, err = d.gramFetch(ctx, l, id, size)
		<-g.slots
		if err != nil {
			return "", err
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(strings.ToLower(cachedMime), "image/") {
		mime = cachedMime
	}
	return "data:" + imageMime(mime) + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

// imageMime is mime as a data: URL may carry it: lower case, without
// parameters, and only the characters a media type has.
func imageMime(mime string) string {
	mime = strings.ToLower(strings.TrimSpace(strings.SplitN(mime, ";", 2)[0]))
	for _, r := range mime {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || strings.ContainsRune("/.+-", r)) {
			return "application/octet-stream"
		}
	}
	return mime
}
