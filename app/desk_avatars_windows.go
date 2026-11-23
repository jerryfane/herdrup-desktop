//go:build windows

package main

import (
	"os"
	"syscall"
)

// replaceAvatar renames tmp over dst. Windows will not rename over a
// read-only file, which an old cache entry may be: when the rename fails,
// dst is opened without following a link (FILE_FLAG_OPEN_REPARSE_POINT),
// and only if that handle is a read-only regular file (no directory, no
// reparse point) is the read-only attribute cleared through the same handle,
// and the rename tried once more. Nothing found by another lookup of the
// path is changed (#381, #388).
func replaceAvatar(tmp, dst string) error {
	err := os.Rename(tmp, dst)
	if err == nil || !clearReadOnlyEntry(dst) {
		return err
	}
	return os.Rename(tmp, dst)
}

// clearReadOnlyEntry makes dst writable when it is a read-only regular file,
// and reports whether it did.
func clearReadOnlyEntry(dst string) bool {
	name, err := syscall.UTF16PtrFromString(dst)
	if err != nil {
		return false
	}
	const fileReadAttributes = 0x80 // FILE_READ_ATTRIBUTES, which package syscall leaves out
	const access = fileReadAttributes | syscall.FILE_WRITE_ATTRIBUTES
	h, err := syscall.CreateFile(name, access, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT|syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return false
	}
	f := os.NewFile(uintptr(h), dst)
	defer f.Close()
	var info syscall.ByHandleFileInformation
	if syscall.GetFileInformationByHandle(h, &info) != nil {
		return false
	}
	const notRegular = syscall.FILE_ATTRIBUTE_DIRECTORY | syscall.FILE_ATTRIBUTE_REPARSE_POINT
	if info.FileAttributes&notRegular != 0 || info.FileAttributes&syscall.FILE_ATTRIBUTE_READONLY == 0 {
		return false
	}
	// File.Chmod on Windows clears FILE_ATTRIBUTE_READONLY through this handle.
	return f.Chmod(0o600) == nil
}
