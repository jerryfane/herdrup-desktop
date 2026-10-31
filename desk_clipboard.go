package main

import (
	"errors"
	"mime"
	"slices"
	"strings"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/transfer"
	"github.com/jerryfane/herdrup-desktop/internal/gramstore"
)

// ReadGuestInvitationClipboard is invoked only by the explicit Paste invite
// action. Reading text never redeems an invitation or opens clipboard file paths.
func (d *Desk) ReadGuestInvitationClipboard() (string, error) {
	data, err := mygo.Clipboard.ReadFormat(transfer.Text)
	if err != nil {
		return "", err
	}
	if len(data) == 0 {
		return "", errors.New("the clipboard has no invitation link")
	}
	return string(data), nil
}

// HasGuestInvitationClipboardText inspects formats, not clipboard contents.
func (d *Desk) HasGuestInvitationClipboardText() bool {
	return slices.Contains(mygo.Clipboard.Formats(), transfer.Text)
}

// pasteClipboard reads OS-owned representations, never paths supplied in DOM text.
// File lists beat accompanying path text; otherwise plain text beats rich data,
// matching the native composer. PNG is preferred over alternate image encodings.
func (d *Desk) pasteClipboard(c *gramstore.Composer) (bool, string, error) {
	formats := mygo.Clipboard.Formats()
	if slices.Contains(formats, transfer.FileList) || slices.Contains(formats, transfer.URIList) {
		paths, err := mygo.Clipboard.ReadFiles()
		if err != nil {
			return false, "", err
		}
		if len(paths) > 0 {
			_, note := d.gramStage(c, paths)
			return true, note, nil
		}
	}
	if slices.Contains(formats, transfer.Text) {
		return false, "", nil
	}
	if slices.Contains(formats, transfer.PNG) {
		formats = []transfer.Format{transfer.PNG}
	}
	for _, format := range formats {
		mediaType, _, err := mime.ParseMediaType(string(format))
		if err != nil || strings.HasPrefix(mediaType, "text/") || mediaType == "application/rtf" || mediaType == "application/vcard" {
			continue
		}
		extensions, _ := mime.ExtensionsByType(mediaType)
		if len(extensions) == 0 {
			continue
		}
		if c.Room() == 0 {
			return true, gramstore.SkipNote(nil, 1), nil
		}
		data, err := mygo.Clipboard.ReadFormat(format)
		if err != nil {
			return true, "", err
		}
		a, err := gramstore.StageBytes("Pasted file"+extensions[0], mediaType, data)
		if err != nil {
			return true, "", err
		}
		c.Add([]gramstore.Attachment{a})
		if !c.Has(a.Path) {
			return true, "", errors.New("the attachment composer closed or filled before paste completed")
		}
		return true, "", nil
	}
	return false, "", nil
}

func (d *Desk) PanePasteClipboard(token string) (bool, error) {
	v, err := d.agentView(token)
	if err != nil {
		return false, err
	}
	if v.recipient == "" {
		return false, errors.New("choose a named agent to attach files")
	}
	if !v.sendMu.TryLock() {
		return false, gramstore.ErrSending
	}
	defer v.sendMu.Unlock()
	handled, note, err := d.pasteClipboard(v.composer)
	d.publishPaneAttachments(v, note)
	return handled, err
}

func (d *Desk) GramPasteClipboard() (bool, error) {
	l, c, err := d.gramComposer()
	if err != nil {
		return false, err
	}
	handled, note, err := d.pasteClipboard(c)
	if err != nil {
		note = err.Error()
	}
	d.gramNote(l, note)
	return handled, err
}
