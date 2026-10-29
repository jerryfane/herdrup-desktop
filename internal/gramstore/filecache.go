package gramstore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"
)

// DefaultCacheBytes is the download cache's ceiling (herdrup
// GramFileCache.defaultMaxBytes).
const DefaultCacheBytes = 512 << 20

const (
	metaName = "meta.json"
	// The payload has its own directory so an attachment named meta.json
	// cannot overwrite the metadata.
	payloadDir = "payload"
)

// CachedFile is a downloaded file kept on disk.
type CachedFile struct {
	Path string
	Name string
	Mime string
	Size int64
}

type cacheMeta struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Mime string `json:"mime"`
	Size int64  `json:"size"`
}

// FileCache keeps downloaded Gram files under Root by message id, as
// herdrup's GramFileCache does: a message is immutable, so its id names one
// set of bytes forever. An entry is a hit only once its metadata, written
// last, exists and the payload still has the recorded size. Entries are
// evicted least recently used past MaxBytes (DefaultCacheBytes when 0).
type FileCache struct {
	Root     string
	MaxBytes int64
}

func (c FileCache) max() int64 {
	if c.MaxBytes > 0 {
		return c.MaxBytes
	}
	return DefaultCacheBytes
}

// Key is the entry directory's name for id: its sha256, so distinct ids
// never share one and no id can leave the root.
func Key(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:])
}

// Dir is the entry directory of id.
func (c FileCache) Dir(id string) string { return filepath.Join(c.Root, Key(id)) }

// Cached returns the cached file of id, touching it so eviction spares the
// file in use.
func (c FileCache) Cached(id string) (CachedFile, bool) {
	dir := c.Dir(id)
	data, err := os.ReadFile(filepath.Join(dir, metaName))
	if err != nil {
		return CachedFile{}, false
	}
	var m cacheMeta
	if json.Unmarshal(data, &m) != nil || m.ID != id {
		return CachedFile{}, false
	}
	p := filepath.Join(dir, payloadDir, m.Name)
	st, err := os.Stat(p)
	if err != nil || !st.Mode().IsRegular() || st.Size() != m.Size || st.Size() <= 0 {
		return CachedFile{}, false
	}
	now := time.Now()
	_ = os.Chtimes(dir, now, now)
	return CachedFile{Path: p, Name: m.Name, Mime: m.Mime, Size: m.Size}, true
}

// StoreData stores data for id. ok is false when it was not cached: empty,
// over the whole budget, or a failed write.
func (c FileCache) StoreData(data []byte, id, name, mime string) (CachedFile, bool) {
	if len(data) == 0 {
		return CachedFile{}, false
	}
	return c.place(id, name, mime, int64(len(data)), func(dst string) error {
		return os.WriteFile(dst, data, 0o600)
	}, nil)
}

// StoreMoving stores the file at src for id by moving it in; src is gone
// on success.
func (c FileCache) StoreMoving(src, id, name, mime string) (CachedFile, bool) {
	st, err := os.Stat(src)
	if err != nil || !st.Mode().IsRegular() || st.Size() <= 0 {
		return CachedFile{}, false
	}
	// A move that cannot be committed is moved back: the file is the
	// caller's download, not the cache's.
	return c.place(id, name, mime, st.Size(), func(dst string) error { return os.Rename(src, dst) },
		func(dst string) { _ = os.Rename(dst, src) })
}

// StoreCopy stores a copy of the file at src for id; src is left as it
// is. The desk keeps a file it just posted this way, so opening it never
// downloads bytes this device uploaded.
func (c FileCache) StoreCopy(src, id, name, mime string) (CachedFile, bool) {
	in, err := os.Open(src)
	if err != nil {
		return CachedFile{}, false
	}
	defer in.Close()
	st, err := in.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() <= 0 {
		return CachedFile{}, false
	}
	return c.place(id, name, mime, st.Size(), func(dst string) error {
		out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		n, err := io.Copy(out, in)
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		if err == nil && n != st.Size() {
			err = errors.New("file changed while it was copied")
		}
		return err
	}, nil)
}

// place writes one entry: the payload through write, then its metadata.
// When the metadata fails, undo (if any) is handed the written payload
// before the entry is removed.
func (c FileCache) place(id, name, mime string, size int64, write func(dst string) error, undo func(dst string)) (CachedFile, bool) {
	if size > c.max() {
		return CachedFile{}, false
	}
	dir := c.Dir(id)
	_ = os.RemoveAll(dir)
	safe := SafeFileName(name)
	payload := filepath.Join(dir, payloadDir)
	fail := func() (CachedFile, bool) {
		_ = os.RemoveAll(dir)
		return CachedFile{}, false
	}
	if err := os.MkdirAll(payload, 0o700); err != nil {
		return fail()
	}
	dst := filepath.Join(payload, safe)
	if err := write(dst); err != nil {
		return fail()
	}
	if undo != nil {
		removeEntry := fail
		fail = func() (CachedFile, bool) {
			undo(dst)
			return removeEntry()
		}
	}
	meta, _ := json.Marshal(cacheMeta{ID: id, Name: safe, Mime: mime, Size: size})
	tmp := filepath.Join(dir, metaName+".tmp")
	if err := writeMeta(tmp, meta, 0o600); err != nil {
		return fail()
	}
	if err := os.Rename(tmp, filepath.Join(dir, metaName)); err != nil {
		return fail()
	}
	c.Evict(c.max())
	return CachedFile{Path: dst, Name: safe, Mime: mime, Size: size}, true
}

// writeMeta writes an entry's metadata; tests make it fail.
var writeMeta = os.WriteFile

// Remove drops the entry of id: on delete only, never on unsave.
func (c FileCache) Remove(id string) { _ = os.RemoveAll(c.Dir(id)) }

// RemoveAll drops every entry.
func (c FileCache) RemoveAll() { _ = os.RemoveAll(c.Root) }

type cacheEntry struct {
	dir     string
	size    int64
	touched time.Time
}

func (c FileCache) entries() []cacheEntry {
	des, err := os.ReadDir(c.Root)
	if err != nil {
		return nil
	}
	var out []cacheEntry
	for _, de := range des {
		dir := filepath.Join(c.Root, de.Name())
		var touched time.Time
		if info, err := de.Info(); err == nil {
			touched = info.ModTime()
		}
		out = append(out, cacheEntry{dir: dir, size: payloadBytes(dir), touched: touched})
	}
	return out
}

// payloadBytes is the entry's recorded size, not a sum of its files.
func payloadBytes(dir string) int64 {
	data, err := os.ReadFile(filepath.Join(dir, metaName))
	if err != nil {
		return 0
	}
	var m cacheMeta
	if json.Unmarshal(data, &m) != nil {
		return 0
	}
	return m.Size
}

// TotalBytes is the payload bytes held.
func (c FileCache) TotalBytes() int64 {
	var total int64
	for _, e := range c.entries() {
		total += e.size
	}
	return total
}

// Evict drops least recently used entries until the cache fits maxBytes.
func (c FileCache) Evict(maxBytes int64) {
	all := c.entries()
	var total int64
	for _, e := range all {
		total += e.size
	}
	if total <= maxBytes {
		return
	}
	slices.SortFunc(all, func(a, b cacheEntry) int { return a.touched.Compare(b.touched) })
	for _, e := range all {
		if total <= maxBytes {
			break
		}
		_ = os.RemoveAll(e.dir)
		total -= e.size
	}
}

// SafeFileName reduces a sender-supplied name to one safe path component
// as herdrup's GramStaging.safeFileName does: the last "/" component, with
// any backslash replaced, and never "", "." or "..". On Windows the
// characters its file names cannot hold are replaced too.
func SafeFileName(name string) string {
	base := strings.TrimRight(name, "/")
	if i := strings.LastIndex(base, "/"); i >= 0 {
		base = base[i+1:]
	}
	base = strings.ReplaceAll(base, `\`, "_")
	if runtime.GOOS == "windows" {
		base = strings.Map(func(r rune) rune {
			if r < 32 || strings.ContainsRune(`<>:"|?*`, r) {
				return '_'
			}
			return r
		}, base)
	}
	base = strings.TrimSpace(base)
	if base == "" || base == "." || base == ".." {
		return "file"
	}
	return base
}
