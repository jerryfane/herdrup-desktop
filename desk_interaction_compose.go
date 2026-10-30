package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
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
	if v.recipient == "" {
		return errors.New("choose a named agent to attach files")
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
	if v.recipient == "" {
		return errors.New("choose a named agent to attach files")
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

// Delivery uncertainty consumes the draft, just as native PromptRejection does:
// resending a timeout or a lost response can duplicate a PTY write.
func submitPanePrompt(ctx context.Context, v *interaction, text string) (string, error) {
	result, err := v.client.AgentPrompt(ctx, herdrapi.AgentPromptParams{Target: v.PaneID, Text: text})
	delivery, note := "submitted", ""
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
	} else if result.Delivery != nil {
		delivery = string(*result.Delivery)
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
