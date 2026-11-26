package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

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

// gramClaimCache gives the downloads to owner, a connection's machine, under
// d.mu (start, ConnectGuest): the bytes must not outlive the machine that
// could read them. Unless they are owner's already, it detaches them
// (gramDetachCache) and records owner, but only once nothing of another
// connection stays in place: else the next connection detaches them again.
// The caller drops what it returns once d.mu is free.
func (d *Desk) gramClaimCache(owner string) gramDiscard {
	if b, err := os.ReadFile(d.gramOwnerPath()); err == nil && string(b) == owner {
		return gramDiscard{}
	}
	c := d.gramDetachCache()
	if len(c.stuck) == 0 {
		if err := os.MkdirAll(d.gramCacheBase(), 0o700); err == nil {
			_ = os.WriteFile(d.gramOwnerPath(), []byte(owner), 0o600)
		}
	}
	return c
}

// gramDetachCache takes every downloaded file out of use for good, cheaply
// enough for d.mu (a connection change): the owner marker goes first, so no
// connection trusts what stays, then the files move aside, renamed
// gram-discarded-*. The caller drops what it returns once d.mu is free.
func (d *Desk) gramDetachCache() gramDiscard {
	base := d.gramCacheBase()
	d.gramDisown()
	// An earlier run's, left by a crash between the move and the delete.
	c := gramDiscard{d: d, moved: entriesNamed(base, "gram-discarded-", ""), gen: d.gramCacheGen.Add(1)}
	rename := d.gramRename
	if rename == nil {
		rename = os.Rename
	}
	stamp := strconv.FormatInt(time.Now().UnixNano(), 36) + "-" + strconv.FormatUint(gramDetaches.Add(1), 36)
	for _, p := range []string{d.gramCache().Root, d.gramPartialDir()} {
		to := filepath.Join(base, "gram-discarded-"+stamp+"-"+filepath.Base(p))
		switch err := rename(p, to); {
		case err == nil:
			c.moved = append(c.moved, to)
		case !errors.Is(err, os.ErrNotExist):
			c.stuck = append(c.stuck, p)
		}
	}
	return c
}

// gramDisown makes the downloads no connection's: the owner marker goes,
// or, where the directory refuses that, is emptied, "" being no machine.
func (d *Desk) gramDisown() {
	p := d.gramOwnerPath()
	err := os.Remove(p)
	if err == nil || errors.Is(err, os.ErrNotExist) {
		return
	}
	if werr := os.WriteFile(p, nil, 0o600); werr != nil {
		log.Printf("gram cache: the owner marker %s stays: %v; emptying it: %v", p, err, werr)
	}
}

// gramDetaches tells apart the directories gramDetachCache moves aside.
var gramDetaches atomic.Uint64

// gramDiscard is what a connection change took off the download cache under
// d.mu, for drop once d.mu is free.
type gramDiscard struct {
	d *Desk
	// moved: the directories moved aside (exact paths), and an earlier run's.
	moved []string
	// stuck: download directories a move failed to take (a directory that
	// refuses renames). They are deleted in place, the old recursive delete,
	// while they are still the detached connection's: the marker is gone and
	// no later change (gen) took the cache.
	stuck []string
	gen   uint64
}

// drop deletes what c took off the cache, as far as it can; it logs what
// stays.
func (c gramDiscard) drop() {
	for _, dir := range c.moved {
		if err := os.RemoveAll(dir); err != nil {
			log.Printf("gram cache: %s stays: %v", dir, err)
		}
	}
	for _, dir := range c.stuck {
		if c.d.gramCacheGen.Load() != c.gen {
			log.Printf("gram cache: %s could not move aside and a later connection took it", dir)
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			log.Printf("gram cache: %s could not move aside, and deleting it in place left some: %v", dir, err)
		}
	}
}

// gramFileMeta is what a download needs of a message's file: from l's held
// messages (id there), else a saved copy (key, the id the page knows, which
// can open while the original still exists).
func (d *Desk) gramFileMeta(l *link, id, key string) (name, mime string, size uint64, err error) {
	g := d.gramFor(l)
	g.mu.Lock()
	m, ok := g.findLocked(id)
	g.mu.Unlock()
	if ok {
		if m.File == nil {
			return "", "", 0, errors.New("that message has no file")
		}
		return m.File.Name, m.File.Mime, m.File.Size, nil
	}
	if s, ok := d.savedGrams().Get(key); ok && s.File != nil {
		return s.File.Name, s.File.Mime, s.File.Size, nil
	}
	return "", "", 0, errors.New("that message has no file")
}

type gramFlight struct {
	done chan struct{}
	path string
	name string
	mime string
	err  error
}

// gramFetch returns a local path holding the file of l's message id, and the
// file's name and type as herdr gave them: the cached copy, else one
// downloaded now (or already being downloaded). size 0: the first chunk
// tells it. The cache, the flight and the progress events use the id the
// page knows (a shared agent's "<grant>\x1f<id>").
func (d *Desk) gramFetch(ctx context.Context, l *link, id string, size uint64) (path, name, mime string, err error) {
	g := d.gramFor(l)
	key := g.prefix + id
	if hit, ok := d.gramCache().Cached(key); ok {
		return hit.Path, hit.Name, hit.Mime, nil
	}
	g.mu.Lock()
	if g.link != l {
		g.mu.Unlock()
		return "", "", "", errNotConnected
	}
	f := g.flights[key]
	if f == nil {
		f = &gramFlight{done: make(chan struct{})}
		dctx, epoch := g.ctx, g.epoch
		if !l.work.Go(func() { d.gramDownload(dctx, l, epoch, id, key, size, f) }) {
			g.mu.Unlock()
			return "", "", "", errNotConnected
		}
		g.flights[key] = f
	}
	g.mu.Unlock()
	select {
	case <-f.done:
		return f.path, f.name, f.mime, f.err
	case <-ctx.Done():
		return "", "", "", ctx.Err()
	}
}

var errGramFileData = errors.New("the server returned file data that could not be decoded")

func (d *Desk) gramDownload(ctx context.Context, l *link, epoch int, id, key string, size uint64, f *gramFlight) {
	progress := func(done uint64, state string) {
		GramDownloadChanged.Broadcast(GramDownloadProgress{ID: key, Done: done, Size: size, State: state,
			Label: gramstore.DownloadedLabel(done, size)})
	}
	finish := func() {
		g := d.gramFor(l)
		g.mu.Lock()
		if g.flights[key] == f {
			delete(g.flights, key)
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
	g := d.gramFor(l)
	cache := d.gramCache()
	hit, ok := cache.StoreMoving(tmp.Name(), key, name, mime)
	g.mu.Lock()
	stale := g.epoch != epoch
	g.mu.Unlock()
	if stale {
		cache.Remove(key)
		f.err = errNotConnected
		return
	}
	if ok {
		f.path, f.name, f.mime = hit.Path, hit.Name, hit.Mime
		return
	}
	// Not cached (an empty file, or the cache could not commit it, which
	// gives the download back): use it where it is; the partial directory
	// goes with the next reset.
	if _, err := os.Stat(tmp.Name()); err != nil {
		f.err = err
		return
	}
	keepTmp = true
	f.path, f.name, f.mime = tmp.Name(), name, mime
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
	g := d.gramFor(l)
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.link == l {
		g.sendError = text
		d.publishGramLocked(g)
	}
}

// GramOpenFile opens a received file with the system's default app for its
// type, HTML in the default browser (owner, 2026-11-08); programs and scripts
// remain save-only.
func (d *Desk) GramOpenFile(ctx context.Context, key string) error {
	l, id, err := d.gramLinkFor(key)
	if err != nil {
		return err
	}
	name, _, size, err := d.gramFileMeta(l, id, key)
	if err != nil {
		d.gramNote(l, gramFileError("open", err))
		return err
	}
	if !gramstore.Openable(name) {
		err := fmt.Errorf("%s is a program or script: save it to open it", name)
		d.gramNote(l, "Couldn't open the file: programs and scripts can only be saved.")
		return err
	}
	path, _, _, err := d.gramFetch(ctx, l, id, size)
	if err == nil {
		err = d.openPath(path)
	}
	if err != nil {
		d.gramNote(l, gramFileError("open", err))
		return err
	}
	return nil
}

// GramOpenAttachment opens the file of a Chat attachment by its Gram message
// id, as GramOpenFile does, through the same download cache (herdrup
// ChatAttachmentBundle, GramFileCache.open). Its message need not be in the
// loaded Gram feed: herdr decides access, and the first chunk gives the name
// and size. Programs and scripts stay save-only. Errors go back to the chat,
// not to Gram's banner.
func (d *Desk) GramOpenAttachment(ctx context.Context, id string) error {
	l, err := d.attachmentLink()
	if err != nil {
		return err
	}
	// A saved copy is keyed as the page knows the message: a shared agent's
	// carries its grant prefix, so it never matches the owner's same raw id.
	name, _, size, metaErr := d.gramFileMeta(l, id, d.gramFor(l).prefix+id)
	if metaErr == nil && !gramstore.Openable(name) {
		return errSaveOnly
	}
	if metaErr != nil {
		size = 0
	}
	path, name, _, err := d.gramFetch(ctx, l, id, size)
	if err != nil {
		var api *bridge.APIError
		if errors.As(err, &api) {
			return errors.New(api.Message)
		}
		return err
	}
	if !gramstore.Openable(name) {
		return errSaveOnly
	}
	return d.openPath(path)
}

var errSaveOnly = errors.New("programs and scripts can only be saved")

// GramSaveFile saves a message's file where the save dialog says, from the
// cache when it was downloaded before.
func (d *Desk) GramSaveFile(ctx context.Context, key string) error {
	l, id, err := d.gramLinkFor(key)
	if err != nil {
		return err
	}
	name, _, size, err := d.gramFileMeta(l, id, key)
	if err != nil {
		d.gramNote(l, gramFileError("save", err))
		return err
	}
	dest, err := d.saveDialog(ctx, gramstore.SafeFileName(name))
	if err != nil || dest == "" {
		return err
	}
	src, _, _, err := d.gramFetch(ctx, l, id, size)
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
func (d *Desk) GramImage(ctx context.Context, key string) (string, error) {
	l, id, err := d.gramLinkFor(key)
	if err != nil {
		return "", err
	}
	name, mime, size, err := d.gramFileMeta(l, id, key)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(strings.ToLower(mime), "image/") || size > gramPreviewMaxBytes {
		return "", fmt.Errorf("%s has no preview", name)
	}
	path, cachedMime, ok := "", "", false
	if hit, hitOK := d.gramCache().Cached(key); hitOK {
		path, cachedMime, ok = hit.Path, hit.Mime, true
	}
	if !ok {
		g := d.gramFor(l)
		select {
		case g.slots <- struct{}{}:
		case <-ctx.Done():
			return "", ctx.Err()
		}
		path, _, cachedMime, err = d.gramFetch(ctx, l, id, size)
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
