package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

type creationSession struct {
	token  string
	at     boardSession
	client *engine.Client
	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex
	used   bool
	// created is guarded by Desk.mu. The start reply authorizes opening before
	// the board's next agent.list has caught up; no invented roster entry is used.
	created *herdrapi.AgentInfo
}

type AgentCreationResult struct {
	Phase   string `json:"phase"`
	PaneID  string `json:"paneID"`
	Name    string `json:"name"`
	Message string `json:"message"`
}

func (d *Desk) OpenCreation(machineID, session, token string) error {
	if token == "" || len(token) > 128 {
		return errors.New("invalid creation token")
	}
	client, at, err := d.herdrClient()
	if err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.currentLocked(at) || at.link.id != machineID || sessionKey(at.link.session) != sessionKey(session) {
		return ErrSessionChanged
	}
	ctx, cancel := context.WithCancel(at.link.ctx)
	if d.creation != nil {
		d.creation.cancel()
	}
	d.creation = &creationSession{token: token, at: at, client: client, ctx: ctx, cancel: cancel}
	return nil
}

func (d *Desk) creationView(token string) (*creationSession, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	v := d.creation
	if v == nil || v.token != token || !d.currentLocked(v.at) || v.ctx.Err() != nil {
		return nil, errors.New("creation connection or session changed; request was not sent")
	}
	return v, nil
}

func (d *Desk) CloseCreation(token string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.creation != nil && d.creation.token == token {
		d.creation.cancel()
		d.creation = nil
	}
}

func (d *Desk) CreationKinds(ctx context.Context, token string) (string, error) {
	v, err := d.creationView(token)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	kinds, err := v.client.AgentKinds(ctx)
	var old *engine.ErrUnsupported
	if errors.As(err, &old) {
		kinds = []herdrapi.AgentKindInfo{{Kind: "claude", Installed: true}, {Kind: "codex", Installed: true}, {Kind: "gemini", Installed: true}}
	} else if err != nil {
		return "", err
	}
	data, err := json.Marshal(kinds)
	return string(data), err
}

func (d *Desk) CreationDirectory(ctx context.Context, token, folder string) (string, error) {
	v, err := d.creationView(token)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	var target *string
	if folder != "" {
		target = &folder
	}
	listing, err := v.client.ListDirectory(ctx, target)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(listing)
	return string(data), err
}

func (d *Desk) CreateAgent(ctx context.Context, token, folder, kind string) (AgentCreationResult, error) {
	v, err := d.creationView(token)
	if err != nil {
		return AgentCreationResult{}, err
	}
	if !v.mu.TryLock() {
		return AgentCreationResult{}, errors.New("an agent is already starting")
	}
	defer v.mu.Unlock()
	if _, err = d.creationView(token); err != nil {
		return AgentCreationResult{}, err
	}
	if v.used {
		return AgentCreationResult{}, errors.New("this creation already started or has an uncertain result; inspect the board before creating another agent")
	}
	folder, kind = strings.TrimSpace(folder), strings.TrimSpace(kind)
	if kind == "" || (folder != "" && !strings.HasPrefix(folder, "/")) {
		return AgentCreationResult{}, errors.New("choose an agent kind and an absolute folder path, or leave the folder empty")
	}
	name := kind
	if folder != "" && folder != "/" {
		name = path.Base(folder)
	}
	name = normalizeAgentName(name)
	v.used = true
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	var cwd *string
	if folder != "" {
		cwd = &folder
	}
	if err := ctx.Err(); err != nil {
		return AgentCreationResult{}, err
	}
	pane, err := v.client.SplitPane(ctx, cwd)
	if err != nil {
		var refused *bridge.APIError
		if errors.As(err, &refused) {
			v.used = false
			return AgentCreationResult{Phase: "failed", Message: err.Error()}, nil
		}
		return AgentCreationResult{Phase: "uncertain", Message: "The new-pane result is unknown. Inspect the machine before creating another pane: " + err.Error()}, nil
	}
	if err := ctx.Err(); err != nil {
		return cleanupCreatedPane(v, pane.PaneID, err), nil
	}
	agent, startErr := v.client.StartAgentWhenShellReady(ctx, name, kind, pane.PaneID)
	if startErr != nil {
		var refused *bridge.APIError
		var unsupported *engine.ErrUnsupported
		if errors.As(startErr, &refused) || errors.As(startErr, &unsupported) {
			return cleanupCreatedPane(v, pane.PaneID, startErr), nil
		}
		return AgentCreationResult{Phase: "uncertain", PaneID: pane.PaneID, Message: fmt.Sprintf("Start outcome is unknown for pane %s. It was not closed or retried; inspect the machine: %v", pane.PaneID, startErr)}, nil
	}
	d.mu.Lock()
	if d.creation != v || !d.currentLocked(v.at) || v.ctx.Err() != nil {
		d.mu.Unlock()
		return AgentCreationResult{}, ErrSessionChanged
	}
	v.created = &agent
	d.mu.Unlock()
	return AgentCreationResult{Phase: "started", PaneID: agent.PaneID, Name: name}, nil
}

// A failed split/start may be cancelled while the user changes host. Cleanup
// addresses only the pane this request created on its original immutable client.
func cleanupCreatedPane(v *creationSession, pane string, cause error) AgentCreationResult {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := v.client.PaneClose(ctx, pane); err != nil {
		return AgentCreationResult{Phase: "uncertain", PaneID: pane, Message: fmt.Sprintf("Agent did not start: %v. Could not close empty pane %s: %v", cause, pane, err)}
	}
	v.used = false
	return AgentCreationResult{Phase: "failed", Message: cause.Error()}
}

func normalizeAgentName(raw string) string {
	var result strings.Builder
	result.Grow(32)
	for _, r := range raw {
		r = unicode.ToLower(r)
		if result.Len() == 0 {
			if r >= 'a' && r <= 'z' {
				result.WriteByte(byte(r))
			}
		} else if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			result.WriteByte(byte(r))
		} else {
			result.WriteByte('-')
		}
		if result.Len() == 32 {
			break
		}
	}
	if result.Len() == 0 {
		return "agent"
	}
	return result.String()
}
