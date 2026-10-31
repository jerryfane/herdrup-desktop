package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"path"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/gramstore"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// AgentView identifies one mounted detail view, not just a pane name. All writes
// require its token, and its lifetime ends on any connection/session change.
type AgentView struct {
	Token             string  `json:"token"`
	PaneID            string  `json:"paneID"`
	Name              string  `json:"name"`
	Harness           string  `json:"harness"`
	Heading           string  `json:"heading"`
	Group             string  `json:"group"`
	Status            string  `json:"status"`
	StatusSinceUnixMs *uint64 `json:"statusSinceUnixMs,omitempty"`
	PlainTerminal     bool    `json:"plainTerminal"`
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
	composer       *gramstore.Composer
	recipient      string
	sendMu         sync.Mutex
	guestShare     guestShareRoute
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
	var agent herdrapi.AgentInfo
	if i >= 0 {
		agent = l.agents[i]
	} else if created := d.creation; created != nil && d.currentLocked(created.at) && created.ctx.Err() == nil &&
		created.created != nil && created.created.PaneID == target.PaneID {
		agent = *created.created
	} else {
		d.mu.Unlock()
		return AgentView{}, errors.New("agent is no longer on this board")
	}
	at := boardSession{l, l.client, l.sessionGen}
	view, err := l.client.ForSession(l.session)
	if err != nil {
		d.mu.Unlock()
		return AgentView{}, err
	}
	ctx, cancel := context.WithCancel(l.ctx)
	name := herdr.DisplayName(agent)
	harness := ""
	if agent.Agent != nil {
		harness = *agent.Agent
	}
	parts := []string{name}
	if harness != "" && harness != name {
		parts = append(parts, harness)
	}
	if agent.Cwd != nil {
		folder := path.Base(*agent.Cwd)
		if folder != "" && folder != "/" && folder != "." && !slices.Contains(parts, folder) {
			parts = append(parts, folder)
		}
	}
	group := herdr.GroupOf(agent, true)
	v := &interaction{
		AgentView: AgentView{
			Token: token, PaneID: agent.PaneID, Name: name, Harness: harness,
			Heading: strings.Join(parts, " · "), Group: group.Key(), Status: group.Label(),
			StatusSinceUnixMs: agent.StatusSinceUnixMs,
		},
		at: at, ctx: ctx, cancel: cancel, client: engine.New(engine.Bridge(view)),
		guestShare: shareRoute(agent, name, d.state.Machine),
	}
	if agent.Name != nil {
		v.recipient = strings.TrimSpace(*agent.Name)
	}
	return d.mountInteractionLocked(v), nil
}

// mountInteractionLocked publishes the view and releases d.mu.
func (d *Desk) mountInteractionLocked(v *interaction) AgentView {
	v.composer = d.newPaneComposer(v)
	old := d.interaction
	d.interaction = v
	d.mu.Unlock()
	if old != nil {
		old.cancel()
	}
	return v.AgentView
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

// TerminalHistoryPage distinguishes an expired/unsupported server cursor from a
// transport failure. Only the latter may be retried with the same cursor.
type TerminalHistoryPage struct {
	Page        *herdrapi.ResponseResultPaneHistory `json:"page,omitempty"`
	Unavailable string                              `json:"unavailable,omitempty"`
}

func (d *Desk) TerminalHistory(ctx context.Context, token, cursor string) (TerminalHistoryPage, error) {
	v, err := d.agentView(token)
	if err != nil {
		return TerminalHistoryPage{}, err
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	page, err := v.client.PaneHistory(ctx, herdrapi.PaneHistoryParams{PaneID: v.PaneID, Cursor: cursor})
	var apiError *bridge.APIError
	if errors.As(err, &apiError) {
		return TerminalHistoryPage{Unavailable: apiError.Error()}, nil
	}
	var unsupported *engine.ErrUnsupported
	if errors.As(err, &unsupported) {
		return TerminalHistoryPage{Unavailable: unsupported.Error()}, nil
	}
	if err != nil {
		return TerminalHistoryPage{}, err
	}
	return TerminalHistoryPage{Page: &page}, nil
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
	if !v.sendMu.TryLock() {
		return "", gramstore.ErrSending
	}
	defer v.sendMu.Unlock()
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	chips := v.composer.Snapshot().Chips
	if len(chips) == 0 {
		if strings.TrimSpace(text) == "" {
			return "", errors.New("prompt is empty")
		}
		return submitPanePrompt(ctx, v, text)
	}
	if v.recipient == "" {
		return "", errors.New("choose a named agent to attach files")
	}
	paths := make([]string, len(chips))
	for i, chip := range chips {
		paths[i] = chip.Path
	}
	post := func(ctx context.Context, _ string, a *gramstore.Attachment) (string, error) {
		result, err := v.client.GramPost(ctx, herdrapi.GramPostParams{
			Text: "Attachment from the terminal composer.", To: &v.recipient,
			File: &herdrapi.GramFileUpload{UploadID: a.UploadID, Name: a.Name, Mime: a.Mime},
		})
		if err != nil {
			return "", err
		}
		return result.Message.ID, nil
	}
	var receipt string
	err = v.composer.SendPrompt(ctx, paths, post, func(files []gramstore.Attachment) (bool, error) {
		var submitErr error
		receipt, submitErr = submitPanePrompt(ctx, v, paneAttachmentPrompt(text, files))
		return submitErr == nil, submitErr
	})
	return receipt, err
}

type ChatAnswerReply struct {
	Status  herdrapi.AgentAnswerStatus `json:"status,omitempty"`
	Code    string                     `json:"code,omitempty"`
	Message string                     `json:"message,omitempty"`
}

func (d *Desk) ChatAnswer(ctx context.Context, token, askID, option string) (ChatAnswerReply, error) {
	v, err := d.agentView(token)
	if err != nil {
		return ChatAnswerReply{}, err
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	result, err := v.client.AgentAnswer(ctx, herdrapi.AgentAnswerParams{Target: v.PaneID, AskID: askID, Option: option})
	if err != nil {
		var api *bridge.APIError
		if errors.As(err, &api) {
			return ChatAnswerReply{Code: api.Code, Message: api.Message}, nil
		}
		return ChatAnswerReply{}, err
	}
	return ChatAnswerReply{Status: result.Status}, nil
}

// OpenExternalURL deliberately excludes executable/file URLs from model output.
func (d *Desk) OpenExternalURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http" && u.Scheme != "mailto") {
		return errors.New("unsupported link scheme")
	}
	return mygo.Shell.OpenExternal(raw)
}

// ReadAgentText powers the native pane menu's Copy screen / Copy recent output.
func (d *Desk) ReadAgentText(ctx context.Context, token string, recent bool) (string, error) {
	v, err := d.agentView(token)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	source := herdrapi.ReadSourceVisible
	if recent {
		source = herdrapi.ReadSourceRecentUnwrapped
	}
	format := herdrapi.ReadFormatText
	var result herdrapi.ResponseResultPaneRead
	if v.PlainTerminal {
		result, err = v.client.PaneRead(ctx, herdrapi.PaneReadParams{PaneID: v.PaneID, Source: source, Format: &format})
	} else {
		result, err = v.client.AgentRead(ctx, herdrapi.AgentReadParams{Target: v.PaneID, Source: source, Format: &format})
	}
	if err != nil {
		return "", err
	}
	if _, err := d.agentView(token); err != nil {
		return "", err
	}
	return result.Read.Text, nil
}

// ChatMenuChoice identifies a snapshot of a message, not a mutable transcript row.
type ChatMenuChoice struct {
	ID   string `json:"id"`
	Item string `json:"item"`
}

var ChatMenuChosen = mygo.NewEvent[ChatMenuChoice]("chat:menu")

// ChatMenu uses an OS menu so transcript polling cannot replace an open menu.
func (d *Desk) ChatMenu(ctx context.Context, id string, offersMarkdown bool) {
	labels := []string{"Copy"}
	if offersMarkdown {
		labels = append(labels, "Copy as Markdown")
	}
	labels = append(labels, "Select Text")
	items := make([]*mygo.MenuItem, 0, len(labels))
	for _, label := range labels {
		items = append(items, &mygo.MenuItem{Label: label, Click: func(*mygo.MenuItem, *mygo.Window) {
			ChatMenuChosen.Broadcast(ChatMenuChoice{ID: id, Item: label})
		}})
	}
	mygo.NewMenu(items).Popup(mygo.CallerWindow(ctx))
}
