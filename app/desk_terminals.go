package main

import (
	"context"
	"errors"
	"strings"

	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
)

type TerminalCreationResult struct {
	Phase    string         `json:"phase"`
	Terminal *SavedTerminal `json:"terminal,omitempty"`
	Message  string         `json:"message"`
}

func (d *Desk) terminalClient(target AgentTarget) (*engine.Client, boardSession, error) {
	client, at, err := d.herdrClient()
	if err != nil {
		return nil, at, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.currentLocked(at) || at.link.id != target.MachineID || sessionKey(at.link.session) != sessionKey(target.Session) {
		return nil, at, ErrSessionChanged
	}
	return client, at, nil
}

func (d *Desk) SavedTerminals(machineID, session string) ([]SavedTerminal, error) {
	if _, _, err := d.terminalClient(AgentTarget{MachineID: machineID, Session: session}); err != nil {
		return nil, err
	}
	return d.terminals.list(terminalScope(machineID, session))
}

func (d *Desk) CreateTerminal(ctx context.Context, token string) (TerminalCreationResult, error) {
	v, err := d.creationView(token)
	if err != nil {
		return TerminalCreationResult{}, err
	}
	if !v.mu.TryLock() {
		return TerminalCreationResult{}, errors.New("creation is already in progress")
	}
	defer v.mu.Unlock()
	if v.used {
		return TerminalCreationResult{}, errors.New("this creation request was already sent; inspect its result before creating another")
	}
	scope := v.scope
	if _, err := d.terminals.list(scope); err != nil {
		return TerminalCreationResult{}, err
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return TerminalCreationResult{}, err
	}
	v.used = true
	pane, err := v.client.SplitPane(ctx, nil)
	if err != nil {
		var api *bridge.APIError
		var unsupported *engine.ErrUnsupported
		if errors.As(err, &api) || errors.As(err, &unsupported) {
			v.used = false
			return TerminalCreationResult{Phase: "failed", Message: err.Error()}, nil
		}
		return TerminalCreationResult{Phase: "uncertain", Message: "The new-terminal result is unknown. Inspect the original machine before creating another: " + err.Error()}, nil
	}
	saved, err := d.terminals.add(scope, pane.PaneID)
	if err != nil {
		cleanup := cleanupCreatedPane(v, pane.PaneID, err)
		return TerminalCreationResult{Phase: cleanup.Phase, Message: cleanup.Message}, nil
	}
	// Preserve this record even if the host switched while the split was pending.
	// It belongs to the original scope and will be available when that host returns.
	return TerminalCreationResult{Phase: "started", Terminal: &saved}, nil
}

func (d *Desk) OpenTerminalView(target AgentTarget, token string) (AgentView, error) {
	if token == "" || len(token) > 128 {
		return AgentView{}, errors.New("invalid view token")
	}
	client, at, err := d.terminalClient(target)
	if err != nil {
		return AgentView{}, err
	}
	saved, err := d.terminals.find(terminalScope(target.MachineID, target.Session), target.PaneID)
	if err != nil {
		return AgentView{}, err
	}
	d.mu.Lock()
	if !d.currentLocked(at) {
		d.mu.Unlock()
		return AgentView{}, ErrSessionChanged
	}
	ctx, cancel := context.WithCancel(at.link.ctx)
	v := &interaction{AgentView: AgentView{Token: token, PaneID: saved.PaneID, Name: saved.Label, Heading: saved.Label, Group: "terminal", Status: "Terminal", PlainTerminal: true}, at: at, ctx: ctx, cancel: cancel, client: client}
	return d.mountInteractionLocked(v), nil
}

func (d *Desk) RenameTerminal(ctx context.Context, target AgentTarget, label string) error {
	label = strings.TrimSpace(label)
	if label == "" {
		return errors.New("terminal label is empty")
	}
	client, at, err := d.terminalClient(target)
	if err != nil {
		return err
	}
	if _, err := d.terminals.find(terminalScope(target.MachineID, target.Session), target.PaneID); err != nil {
		return err
	}
	d.mu.Lock()
	if !d.currentLocked(at) {
		d.mu.Unlock()
		return ErrSessionChanged
	}
	lifetime := at.link.ctx
	d.mu.Unlock()
	ctx, cancel := viewRequest(ctx, lifetime)
	defer cancel()
	if err := client.PaneRename(ctx, target.PaneID, label); err != nil {
		return err
	}
	return d.terminals.rename(terminalScope(target.MachineID, target.Session), target.PaneID, label)
}

func (d *Desk) ForgetTerminal(target AgentTarget) error {
	_, at, err := d.terminalClient(target)
	if err != nil {
		return err
	}
	return d.forgetTerminal(target, at)
}

func (d *Desk) CloseTerminal(ctx context.Context, target AgentTarget) error {
	client, at, err := d.terminalClient(target)
	if err != nil {
		return err
	}
	scope := terminalScope(target.MachineID, target.Session)
	if _, err := d.terminals.find(scope, target.PaneID); err != nil {
		return err
	}
	d.mu.Lock()
	if !d.currentLocked(at) {
		d.mu.Unlock()
		return ErrSessionChanged
	}
	lifetime := at.link.ctx
	d.mu.Unlock()
	ctx, cancel := viewRequest(ctx, lifetime)
	defer cancel()
	if err := client.PaneClose(ctx, target.PaneID); err != nil {
		return err
	}
	// Forget only after acknowledged closure. A lost response retains the record
	// so the reader can inspect the pane instead of silently losing its handle.
	return d.forgetTerminal(target, at)
}

func (d *Desk) forgetTerminal(target AgentTarget, at boardSession) error {
	if err := d.terminals.remove(terminalScope(target.MachineID, target.Session), target.PaneID); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if v := d.interaction; v != nil && v.PlainTerminal && v.PaneID == target.PaneID && v.at == at {
		v.cancel()
		d.interaction = nil
	}
	return nil
}
