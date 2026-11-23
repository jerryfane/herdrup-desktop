//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// #388 review: Windows will not rename over a read-only file. A read-only
// cache entry is made writable through a handle on that very file and
// replaced by the verified photo.
func TestAvatarPublishReplacesAReadOnlyEntry(t *testing.T) {
	dir := t.TempDir()
	sha := shaOf(pngBytes)
	dst := filepath.Join(dir, sha)
	if err := os.WriteFile(dst, []byte("tampered"), 0o444); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Lstat(dst); err != nil || fi.Mode().Perm()&0o200 != 0 {
		t.Fatalf("the entry is %v, %v; want it read-only to start with", fi.Mode(), err)
	}
	if err := publishAvatar(dir, sha, pngBytes); err != nil {
		t.Fatal(err)
	}
	if got := readAvatar(dir, sha); string(got) != string(pngBytes) {
		t.Fatalf("read back %q, want the photo", got)
	}
}
