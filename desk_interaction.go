package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// AgentView identifies one mounted detail view, not just a pane name. All writes
// require its token, and its lifetime ends on any connection/session change.
type AgentView struct {
	Token   string `json:"token"`
	PaneID  string `json:"paneID"`
	Name    string `json:"name"`
	Harness string `json:"harness"`
}

type interaction struct {
	AgentView
	at             boardSession
	ctx            context.Context
	cancel         context.CancelFunc
	client         *engine.Client
	mu             sync.Mutex
	stream         *engine.PaneStream
	input          *engine.PaneInput
	terminalCancel context.CancelFunc
	terminalID     string
	terminalCtx    context.Context
}

type TerminalEvent struct {
	Token    string                    `json:"token"`
	StreamID string                    `json:"streamID"`
	Frame    *herdrapi.PaneStreamFrame `json:"frame,omitempty"`
	Error    string                    `json:"error,omitempty"`
}

var TerminalChanged = mygo.NewEvent[TerminalEvent]("terminal:changed")

func (d *Desk) OpenAgentView(target AgentTarget, token string) (AgentView, error) {
	if token == "" || len(token) > 128 {
		return AgentView{}, errors.New("invalid view token")
	}
	d.mu.Lock()
	l := d.link
	if l == nil || l.client == nil || l.ctx == nil || l.id != target.MachineID || sessionKey(l.session) != sessionKey(target.Session) {
		d.mu.Unlock()
		return AgentView{}, errors.New("agent belongs to another connection or session")
	}
	i := slices.IndexFunc(l.agents, func(a herdrapi.AgentInfo) bool { return a.PaneID == target.PaneID })
	if i < 0 {
		d.mu.Unlock()
		return AgentView{}, errors.New("agent is no longer on this board")
	}
	agent := l.agents[i]
	at := boardSession{l, l.client, l.sessionGen}
	view, err := l.client.ForSession(l.session)
	if err != nil {
		d.mu.Unlock()
		return AgentView{}, err
	}
	ctx, cancel := context.WithCancel(l.ctx)
	name := agent.PaneID
	if agent.Name != nil {
		name = *agent.Name
	}
	harness := ""
	if agent.Agent != nil {
		harness = *agent.Agent
	}
	v := &interaction{AgentView: AgentView{token, agent.PaneID, name, harness}, at: at, ctx: ctx, cancel: cancel, client: engine.New(engine.Bridge(view))}
	old := d.interaction
	d.interaction = v
	d.mu.Unlock()
	if old != nil {
		old.cancel()
	}
	return v.AgentView, nil
}

func (d *Desk) agentView(token string) (*interaction, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	v := d.interaction
	if v == nil || v.Token != token || !d.currentLocked(v.at) || v.ctx.Err() != nil {
		return nil, errors.New("agent view changed; request was not sent")
	}
	return v, nil
}

func (d *Desk) CloseAgentView(token string) {
	d.mu.Lock()
	v := d.interaction
	if v != nil && v.Token == token {
		d.interaction = nil
	} else {
		v = nil
	}
	d.mu.Unlock()
	if v != nil {
		v.cancel()
	}
}

func viewRequest(parent, view context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(view, cancel)
	return ctx, func() { stop(); cancel() }
}

func (d *Desk) StartTerminal(token, streamID string) error {
	if streamID == "" || len(streamID) > 128 {
		return errors.New("invalid terminal identity")
	}
	v, err := d.agentView(token)
	if err != nil {
		return err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.stream != nil {
		if v.terminalID == streamID {
			return nil
		}
		return errors.New("another terminal surface is already open")
	}
	ctx, cancel := context.WithCancel(v.ctx)
	history := uint64(1000)
	stream, err := v.client.PaneStream(ctx, herdrapi.PaneStreamParams{PaneID: v.PaneID, ScrollbackLines: &history, ViewerID: &streamID})
	if err != nil {
		cancel()
		return err
	}
	v.stream = stream
	v.terminalID, v.terminalCtx = streamID, ctx
	v.terminalCancel = cancel
	v.input = v.client.OpenPaneInput(ctx, v.PaneID)
	go func() {
		defer stream.Close()
		for {
			frame, err := stream.Next()
			if ctx.Err() != nil {
				return
			}
			if err != nil {
				TerminalChanged.Broadcast(TerminalEvent{Token: token, StreamID: streamID, Error: err.Error()})
				return
			}
			TerminalChanged.Broadcast(TerminalEvent{Token: token, StreamID: streamID, Frame: frame})
		}
	}()
	return nil
}

func (d *Desk) StopTerminal(token, streamID string) {
	v, err := d.agentView(token)
	if err != nil {
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.terminalID != streamID {
		return
	}
	if v.terminalCancel != nil {
		v.terminalCancel()
		v.terminalCancel = nil
	}
	v.stream = nil
	v.terminalID, v.terminalCtx = "", nil
	if v.input != nil {
		v.input.Close()
		v.input = nil
	}
}

func (d *Desk) TerminalInput(ctx context.Context, token, streamID, text string) error {
	v, err := d.agentView(token)
	if err != nil {
		return err
	}
	if len(text) > 256*1024 {
		return errors.New("paste exceeds 256 KiB; paste smaller sections")
	}
	v.mu.Lock()
	input := v.input
	terminalCtx := v.terminalCtx
	if streamID != v.terminalID {
		input = nil
	}
	v.mu.Unlock()
	if input == nil {
		return errors.New("terminal input is not connected")
	}
	ctx, cancel := viewRequest(ctx, terminalCtx)
	defer cancel()
	ctx, timeout := context.WithTimeout(ctx, 30*time.Second)
	defer timeout()
	return input.Send(ctx, text)
}

func (d *Desk) TerminalSize(ctx context.Context, token, streamID string, cols, rows int) error {
	v, err := d.agentView(token)
	if err != nil {
		return err
	}
	if cols < 2 || cols > 1000 || rows < 1 || rows > 500 {
		return errors.New("invalid terminal size")
	}
	v.mu.Lock()
	terminalCtx := v.terminalCtx
	if streamID != v.terminalID {
		terminalCtx = nil
	}
	v.mu.Unlock()
	if terminalCtx == nil {
		return errors.New("terminal surface changed")
	}
	ctx, cancel := viewRequest(ctx, terminalCtx)
	defer cancel()
	return v.client.PaneSize(ctx, herdrapi.PaneSetPtySizeParams{PaneID: &v.PaneID, Cols: uint16(cols), Rows: uint16(rows), Lock: true, ViewerID: &streamID})
}

func (d *Desk) TerminalHistory(ctx context.Context, token, cursor string) (herdrapi.ResponseResultPaneHistory, error) {
	v, err := d.agentView(token)
	if err != nil {
		return herdrapi.ResponseResultPaneHistory{}, err
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	return v.client.PaneHistory(ctx, herdrapi.PaneHistoryParams{PaneID: v.PaneID, Cursor: cursor})
}

// ChatTranscript returns protocol JSON so unknown transcript variants survive the
// binding generator; the frontend renders them as explicit unsupported entries.
func (d *Desk) ChatTranscript(ctx context.Context, token, after, before, subagent string) (string, error) {
	v, err := d.agentView(token)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	p := herdrapi.AgentTranscriptParams{Target: v.PaneID}
	if after != "" {
		p.After = &after
	}
	if before != "" {
		p.Before = &before
	}
	if subagent != "" {
		p.Subagent = &subagent
	}
	page, err := v.client.AgentTranscript(ctx, p)
	if err != nil {
		return "", err
	}
	if _, err = d.agentView(token); err != nil {
		return "", err
	}
	raw, err := json.Marshal(page)
	return string(raw), err
}

func (d *Desk) ChatPrompt(ctx context.Context, token, text string) (string, error) {
	v, err := d.agentView(token)
	if err != nil {
		return "", err
	}
	if text == "" {
		return "", errors.New("prompt is empty")
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	result, err := v.client.AgentPrompt(ctx, herdrapi.AgentPromptParams{Target: v.PaneID, Text: text})
	if err != nil {
		return "", fmt.Errorf("prompt delivery could not be confirmed; not retried: %w", err)
	}
	raw, err := json.Marshal(result)
	return string(raw), err
}

func (d *Desk) ChatAnswer(ctx context.Context, token, askID, option string) (string, error) {
	v, err := d.agentView(token)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	result, err := v.client.AgentAnswer(ctx, herdrapi.AgentAnswerParams{Target: v.PaneID, AskID: askID, Option: option})
	if err != nil {
		return "", err
	}
	raw, err := json.Marshal(result)
	return string(raw), err
}

// OpenExternalURL deliberately excludes executable/file URLs from model output.
func (d *Desk) OpenExternalURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http" && u.Scheme != "mailto") {
		return errors.New("unsupported link scheme")
	}
	return d.openPath(raw)
}
