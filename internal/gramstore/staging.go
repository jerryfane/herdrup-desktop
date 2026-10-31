package gramstore

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// stagedSource owns only a file created from clipboard bytes. Files selected by
// path remain borrowed. Retirement waits for uploads/cache copies to close their
// readers; this also permits deletion on Windows.
type stagedSource struct {
	mu      sync.Mutex
	path    string
	readers int
	retired bool
}

// StageBytes transfers clipboard bytes into a private, temporary attachment.
// Add takes ownership even if the composer is full or has closed.
func StageBytes(name, mediaType string, data []byte) (Attachment, error) {
	if len(data) == 0 || len(data) > MaxFileBytes {
		return Attachment{}, fmt.Errorf("clipboard file must contain 1 byte to 100 MB")
	}
	dir, err := os.MkdirTemp("", "herdrup-paste-")
	if err != nil {
		return Attachment{}, err
	}
	name = SafeFileName(name)
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0600); err != nil {
		_ = os.Remove(path)
		_ = os.Remove(dir)
		return Attachment{}, err
	}
	return Attachment{Path: path, Name: name, Mime: mediaType, IsImage: strings.HasPrefix(mediaType, "image/"), Size: int64(len(data)), source: &stagedSource{path: path}}, nil
}

// RetainSource must precede opening a staged source for an upload/cache copy.
// False means the draft already retired it. A true return must be paired with
// ReleaseSource after closing the file. Both are no-ops for borrowed files.
func (a Attachment) RetainSource() bool {
	s := a.source
	if s == nil {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.retired {
		return false
	}
	s.readers++
	return true
}

func (a Attachment) ReleaseSource() {
	s := a.source
	if s == nil {
		return
	}
	s.mu.Lock()
	s.readers--
	remove := s.retired && s.readers == 0
	s.mu.Unlock()
	if remove {
		s.remove()
	}
}

func (a Attachment) retireSource() {
	s := a.source
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.retired {
		s.mu.Unlock()
		return
	}
	s.retired = true
	remove := s.readers == 0
	s.mu.Unlock()
	if remove {
		s.remove()
	}
}

func (s *stagedSource) remove() {
	_ = os.Remove(s.path)
	_ = os.Remove(filepath.Dir(s.path))
}
