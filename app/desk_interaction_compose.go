package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/gramstore"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

type PaneAttachments struct {
	Token string           `json:"token"`
	Files []GramAttachment `json:"files"`
	Note  string           `json:"note"`
}

var PaneAttachmentsChanged = mygo.NewEvent[PaneAttachments]("pane:attachments")

func (d *Desk) newPaneComposer(v *interaction) *gramstore.Composer {
	upload := func(ctx context.Context, a gramstore.Attachment, progress func(int64, int64)) (string, error) {
		if _, err := d.paneRecipient(v); err != nil {
			return "", err
		}
		ctx, cancel := viewRequest(ctx, v.ctx)
		defer cancel()
		return uploadComposerFile(ctx, v.client, a, progress)
	}
	discard := func(id string) {
		_, _ = v.client.GramUploadDiscard(v.ctx, herdrapi.GramUploadDiscardParams{UploadID: id})
	}
	c := gramstore.NewComposer(upload, discard, func(string) { d.publishPaneAttachments(v, "") })
	context.AfterFunc(v.ctx, c.Close)
	return c
}

func (d *Desk) publishPaneAttachments(v *interaction, note string) {
	if _, err := d.agentView(v.Token); err != nil {
		return
	}
	files := make([]GramAttachment, 0)
	for _, chip := range v.composer.Snapshot().Chips {
		files = append(files, gramChip(chip))
	}
	PaneAttachmentsChanged.Broadcast(PaneAttachments{Token: v.Token, Files: files, Note: note})
}

func (d *Desk) PanePickFiles(ctx context.Context, token string) error {
	v, err := d.agentView(token)
	if err != nil {
		return err
	}
	if _, err := d.paneRecipient(v); err != nil {
		return err
	}
	if !v.sendMu.TryLock() {
		return gramstore.ErrSending
	}
	defer v.sendMu.Unlock()
	paths, err := d.openDialog(ctx)
	if err != nil {
		return err
	}
	if _, err = d.agentView(token); err != nil {
		return err
	}
	_, note := d.gramStage(v.composer, paths)
	d.publishPaneAttachments(v, note)
	return nil
}

// PaneAttachFiles uses the same staging path as the picker for native file drops.
func (d *Desk) PaneAttachFiles(token string, paths []string) error {
	v, err := d.agentView(token)
	if err != nil {
		return err
	}
	if _, err := d.paneRecipient(v); err != nil {
		return err
	}
	if !v.sendMu.TryLock() {
		return gramstore.ErrSending
	}
	defer v.sendMu.Unlock()
	_, note := d.gramStage(v.composer, paths)
	d.publishPaneAttachments(v, note)
	return nil
}

func (d *Desk) PaneRemoveAttachment(token, path string) error {
	v, err := d.agentView(token)
	if err != nil {
		return err
	}
	if !v.sendMu.TryLock() {
		return gramstore.ErrSending
	}
	defer v.sendMu.Unlock()
	return v.composer.Remove(path)
}

func (d *Desk) PaneRetryAttachment(token, path string) error {
	v, err := d.agentView(token)
	if err != nil {
		return err
	}
	v.composer.Retry(path)
	return nil
}

// promptWait is native submitPrompt's wait (HerdrApp.swift: waitUntil
// anyAgentStatus, timeoutMs 6000). Without it herdr answers every prompt
// written_to_pty, unverified, and the composer warned on every send.
var promptWait = func() herdrapi.AgentPromptWaitOptions {
	timeout := uint64(6000)
	return herdrapi.AgentPromptWaitOptions{TimeoutMs: &timeout, Until: []herdrapi.AgentStatus{
		herdrapi.AgentStatusWorking, herdrapi.AgentStatusIdle, herdrapi.AgentStatusBlocked,
		herdrapi.AgentStatusDone, herdrapi.AgentStatusUnknown}}
}()

// unwritten refuses a draft before anything reached the terminal, so the
// composer keeps it. A draft with a line break, written raw to a plain
// terminal, would run the text before the break.
type unwritten string

func (e unwritten) Error() string { return string(e) }

const (
	errTerminalLineBreak    unwritten = "Write one line at a time: a line break would run the text before it."
	errTerminalPasteRefused unwritten = "This program can't take a pasted block. Write one line at a time."
	errTerminalNotSent      unwritten = "Nothing was sent: the connection to this machine was lost. Your draft is kept."
	errTerminalTooLong      unwritten = "Nothing was sent: this draft is too long to send. Your draft is kept."
)

// writeToTerminal writes a draft to a plain terminal without running it. One
// line goes as it is. A draft with a line break goes as one bracketed paste
// (pane.send_bracketed_text), and where it can't, not at all.
func writeToTerminal(ctx context.Context, v *interaction, text string) error {
	if !strings.ContainsAny(text, "\r\n") {
		return v.client.PaneSendText(ctx, v.PaneID, text)
	}
	return bracketedWriteError(v.client.PaneSendBracketedText(ctx, v.PaneID, text))
}

// bracketedWriteError is the composer's reason for a bracketed write that
// herdr refused, writing nothing, so the draft is kept: a herdr without the
// method (it refuses it with invalid_request or unknown_method, which the
// engine may have read as *ErrUnsupported), or a program with bracketed
// paste off. Other errors pass through, a write never sent
// (bridge.ErrNotSent) for writeKept.
func bracketedWriteError(err error) error {
	var unsupported *engine.ErrUnsupported
	var api *bridge.APIError
	switch {
	case errors.As(err, &api) && api.Code == "bracketed_paste_unavailable":
		return errTerminalPasteRefused
	case errors.As(err, &api) && (api.Code == "invalid_request" || api.Code == "unknown_method"),
		errors.As(err, &unsupported):
		return errTerminalLineBreak
	}
	return err
}

// writeKept is the error a plain terminal's write that failed with nothing
// written fails the send with, so the composer keeps the draft and shows
// it; nil when the write may have reached the terminal. A refusal before
// anything reached it (unwritten, *ErrUnsupported) is itself. A write
// never sent (bridge.ErrNotSent), one line or a block alike, is the
// request's own cancellation when ctx ended on it because the page closed
// the view (viewClosed; the page that would show it is gone). Otherwise
// its error is logged, and it is errTerminalTooLong for a request too
// large to send (bridge.ErrRequestTooLarge), else errTerminalNotSent: the
// transport or the channel failed, or the connection ended under the
// view (its context ends with the link's).
func writeKept(ctx context.Context, err error, viewClosed func() bool) error {
	var unsupported *engine.ErrUnsupported
	var kept unwritten
	switch {
	case errors.As(err, &unsupported), errors.As(err, &kept):
		return err
	case !errors.Is(err, bridge.ErrNotSent):
		return nil
	case ctx.Err() != nil && errors.Is(err, context.Canceled) && viewClosed():
		return context.Canceled
	}
	log.Printf("terminal write: %v", err)
	if errors.Is(err, bridge.ErrRequestTooLarge) {
		return errTerminalTooLong
	}
	return errTerminalNotSent
}

// Delivery uncertainty consumes the draft, just as native PromptRejection does:
// resending a timeout or a lost response can duplicate a PTY write.
// viewClosed reports whether the page has closed v (writeKept).
func submitPanePrompt(ctx context.Context, v *interaction, text string, viewClosed func() bool) (string, error) {
	delivery, note := "submitted", ""
	var err error
	if v.PlainTerminal {
		err = writeToTerminal(ctx, v, text)
		delivery, note = "written", "Written to terminal; press Enter to run it."
		if kept := writeKept(ctx, err, viewClosed); kept != nil {
			return "", kept
		}
	} else {
		result, promptErr := v.client.AgentPrompt(ctx, herdrapi.AgentPromptParams{Target: v.PaneID, Text: text, Wait: &promptWait})
		err = promptErr
		if result.Delivery != nil {
			delivery = string(*result.Delivery)
		}
		if delivery == string(herdrapi.AgentPromptDeliveryWrittenToPTY) {
			note = "Sent to terminal; agent submission not verified" // HerdrApp.swift submitPrompt
		}
	}
	if err != nil {
		var api *bridge.APIError
		if errors.As(err, &api) {
			switch api.Code {
			case "timeout", "agent_prompt_unverifiable", "agent_prompt_stalled", "agent_status_unobserved_after_submit", "agent_prompt_unsubmitted":
			default:
				return "", err
			}
		}
		delivery, note = "unconfirmed", "Couldn't confirm delivery — check the terminal before sending again."
	}
	raw, err := json.Marshal(struct {
		Delivery string `json:"delivery"`
		Note     string `json:"note,omitempty"`
	}{delivery, note})
	return string(raw), err
}

func paneAttachmentPrompt(text string, files []gramstore.Attachment) string {
	paths := make([]string, len(files))
	for i, file := range files {
		ext := strings.Map(func(r rune) rune {
			if unicode.IsLetter(r) || unicode.IsNumber(r) {
				return r
			}
			return -1
		}, strings.ToLower(strings.TrimPrefix(filepath.Ext(file.Name), ".")))
		stem := "file"
		if file.IsImage {
			stem = "photo"
		}
		paths[i] = "/tmp/herdr-" + stem + "-" + file.MessageID
		if ext != "" {
			paths[i] += "." + ext
		}
	}
	reference := ""
	if len(files) == 1 {
		file := files[0]
		noun := "File " + file.Name
		if file.IsImage {
			noun = "Photo"
		}
		reference = fmt.Sprintf("[%s attached via Herdr Gram message %s. Download it with `herdr gram get-file %s -o %s`, then inspect %s.]", noun, file.MessageID, file.MessageID, paths[0], paths[0])
	} else {
		lines := make([]string, len(files))
		for i, file := range files {
			lines[i] = fmt.Sprintf("`herdr gram get-file %s -o %s`  (%s)", file.MessageID, paths[i], file.Name)
		}
		reference = fmt.Sprintf("[%d files attached via Herdr Gram. Download them with:\n%s\nthen inspect %s.]", len(files), strings.Join(lines, "\n"), strings.Join(paths, ", "))
	}
	if strings.TrimSpace(text) == "" {
		return reference
	}
	return text + "\n\n" + reference
}
