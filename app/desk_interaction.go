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
	Guest             bool    `json:"guest"`
	GuestGram         bool    `json:"guestGram"`
	// GuestOwner names who shared a guest's agent: the question banner and
	// the answer card wait for them when the host keeps answers for the owner
	// (herdrup GuestPaneView.swift:557-575, ChatView.swift:1755-1758).
	GuestOwner string `json:"guestOwner,omitempty"`
	// GuestSelf is the name a guest's prompts carry: the chat names other
	// people's prompts, never the reader's own (ChatView.swift byline).
	GuestSelf     string `json:"guestSelf,omitempty"`
	PlainTerminal bool   `json:"plainTerminal"`
	// AskForm: the host answers omp's HTML-form asks (capabilities.ask_form).
	// A guest's gate advertises no capabilities, so for a guest herdr's
	// form_answerable on the pending ask decides alone.
	AskForm bool `json:"askForm"`
	// TranscriptAgy: the host serves Antigravity CLI (agy) transcripts
	// (capabilities.agent_transcript && capabilities.transcript_agy).
	TranscriptAgy bool `json:"transcriptAgy,omitempty"`
	// TopicSessions: the topics the agent's session file already holds
	// (topic_sessions, read from disk): the page offers Topics before or
	// without a list answer (herdrup #745 topicsAvailable), and lists them
	// until the agent's first list answers.
	TopicSessions []TopicSession `json:"topicSessions"`
}

// TopicSession is one topic as the agent's session file records it: its id,
// its newest title and when it started (0 when the file doesn't say).
type TopicSession struct {
	TopicID   string `json:"topicID"`
	Title     string `json:"title"`
	CreatedMs uint64 `json:"createdMs"`
}

// topicSessions are an agent's topic_sessions as the page lists them, one
// without an id left out; never null (the page reads a list).
func topicSessions(sessions []herdrapi.AgentTopicSession) []TopicSession {
	out := []TopicSession{}
	for _, s := range sessions {
		if s.TopicID == "" {
			continue
		}
		session := TopicSession{TopicID: s.TopicID}
		if s.Title != nil {
			session.Title = *s.Title
		}
		if s.CreatedUnixMs != nil {
			session.CreatedMs = *s.CreatedUnixMs
		}
		out = append(out, session)
	}
	return out
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
	// pageBudget: herdr takes agent.transcript max_bytes (read with the view's link, under d.mu).
	pageBudget bool
	// topics is the agent's Topics watch (desk_topics.go).
	topics topicsState
}

type TerminalEvent struct {
	Token    string                    `json:"token"`
	StreamID string                    `json:"streamID"`
	Frame    *herdrapi.PaneStreamFrame `json:"frame,omitempty"`
	Error    string                    `json:"error,omitempty"`
	// Reconnect: herdr ended the stream on purpose (stream_stalled,
	// stream_failed; herdr #410) and expects the app to open a new one.
	Reconnect bool `json:"reconnect,omitempty"`
}

// streamEndedForReconnect reports whether herdr ended a pane stream on
// purpose for a slow or failed reader, asking the app to reconnect (#410).
func streamEndedForReconnect(err error) bool {
	var api *bridge.APIError
	return errors.As(err, &api) && (api.Code == "stream_stalled" || api.Code == "stream_failed")
}

var TerminalChanged = mygo.NewEvent[TerminalEvent]("terminal:changed")

func (d *Desk) OpenAgentView(target AgentTarget, token string) (AgentView, error) {
	if token == "" || len(token) > 128 {
		return AgentView{}, errors.New("invalid view token")
	}
	d.mu.Lock()
	l := d.link
	if l == nil || (l.client == nil && l.guest == nil) || l.ctx == nil || l.id != target.MachineID || sessionKey(l.session) != sessionKey(target.Session) {
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
	client, err := l.engineLocked()
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
			Guest:             l.guest != nil, GuestGram: l.guest != nil && l.guest.Features().Gram,
			GuestOwner: guestOwner(l), GuestSelf: guestSelf(l),
			AskForm: l.guest != nil || herdrapi.CapabilityAskForm.Supported(l.caps),
			TranscriptAgy: l.guest == nil &&
				herdrapi.CapabilityAgentTranscript.Supported(l.caps) &&
				l.transcriptAgy,
			TopicSessions: topicSessions(agent.TopicSessions),
		},
		at: at, ctx: ctx, cancel: cancel, client: client,
		// The machine as its guests see it (link.shareLabel), not the
		// connection's user@host that ConnState.Machine shows.
		guestShare: linkShareRoute(l, agent, name),
		pageBudget: l.guest == nil && herdrapi.CapabilityTranscriptMaxBytes.Supported(l.caps),
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
				TerminalChanged.Broadcast(TerminalEvent{Token: token, StreamID: streamID, Error: err.Error(), Reconnect: streamEndedForReconnect(err)})
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

// transcriptPageBytes is the budget for a newest or older transcript page where herdr supports it
// (CONTRACT-net.md §3's suggested first page). The newest turn is always sent whole.
const transcriptPageBytes = 32 * 1024

// ChatTranscript returns protocol JSON so unknown transcript variants survive the
// binding generator; the frontend renders them as explicit unsupported entries.
// heldFrom goes with after: the before cursor of the oldest page the chat holds, "" when it holds
// the session from its start, so herdr re-sends changed origin marks for the history the reader
// scrolled in too (herdr #430). Older servers ignore it.
func (d *Desk) ChatTranscript(ctx context.Context, token, after, before, subagent, heldFrom string) (string, error) {
	return d.transcript(ctx, token, after, before, subagent, heldFrom, "")
}

// topicGone is herdrup #745's words for a topic transcript herdr can't find
// (ChatModel topicNotFound).
const topicGone = "This topic's conversation can't be found."

// TopicTranscript is ChatTranscript for one of an omp agent's topics (herdr
// #475 agent.transcript topic). A server without agent_transcript_topic
// would page the agent's main conversation instead, so topic is refused
// here rather than sent.
func (d *Desk) TopicTranscript(ctx context.Context, token, topic, after, before, heldFrom string) (string, error) {
	if topic == "" {
		return "", errors.New("no topic")
	}
	return d.transcript(ctx, token, after, before, "", heldFrom, topic)
}

func (d *Desk) transcript(ctx context.Context, token, after, before, subagent, heldFrom, topic string) (string, error) {
	v, err := d.agentView(token)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	p := herdrapi.AgentTranscriptParams{Target: v.PaneID}
	if after != "" {
		p.After = &after
		p.HeldFrom = &heldFrom
	}
	if before != "" {
		p.Before = &before
	}
	if subagent != "" {
		p.Subagent = &subagent
	}
	if topic != "" {
		if ok, _ := v.client.Supports(ctx, herdrapi.CapabilityAgentTranscriptTopic); !ok {
			return "", errors.New("This server can't show a topic's conversation.")
		}
		p.Topic = &topic
	}
	// A newest or older page is held to transcriptPageBytes where herdr can (slow-network fix 5,
	// herdr #409): one turn can be 130 KB, and the first page on a slow link waits for all of it.
	// A tail read (after) ignores it, so it is not sent there.
	if after == "" && v.pageBudget {
		budget := uint32(transcriptPageBytes)
		p.MaxBytes = &budget
	}
	// Handovers between the Inbox and its topics as `relay` entries (herdr #521), drawn as
	// chatRelay.ts's "From Inbox" / "From topic <title>" rows. Only where herdr serves them: an
	// older one keeps today's user/note shape. A subagent's page has no handovers.
	if subagent == "" {
		if ok, _ := v.client.Supports(ctx, herdrapi.CapabilityTranscriptRelayEntries); ok {
			p.RelayEntries = new(true)
		}
	}
	page, err := v.client.AgentTranscript(ctx, p)
	if apiErr := (*bridge.APIError)(nil); topic != "" && errors.As(err, &apiErr) && apiErr.Code == "topic_not_found" {
		return "", errors.New(topicGone)
	}
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
	defer v.at.link.pollGuestStatus()
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	if len(v.composer.Snapshot().Chips) == 0 {
		if strings.TrimSpace(text) == "" {
			return "", errors.New("prompt is empty")
		}
		return submitPanePrompt(ctx, v, text)
	}
	return d.sendAttached(ctx, v, text, func(prompt string) (string, error) { return submitPanePrompt(ctx, v, prompt) })
}

// sendAttached is a send with the pane composer's files, to the Inbox
// (ChatPrompt) or one of its topics (TopicsSend): each file is posted to the
// agent as a Gram, then submit sends text with the files named in it
// (paneAttachmentPrompt). The files leave once submit reports the message
// reached (or may have reached) the agent; a rejection keeps them for a retry
// without posting their Grams twice. v.sendMu is held.
func (d *Desk) sendAttached(ctx context.Context, v *interaction, text string, submit func(prompt string) (string, error)) (string, error) {
	chips := v.composer.Snapshot().Chips
	if _, err := d.paneRecipient(v); err != nil {
		return "", err
	}
	paths := make([]string, len(chips))
	for i, chip := range chips {
		paths[i] = chip.Path
	}
	post := func(ctx context.Context, _ string, a *gramstore.Attachment) (string, error) {
		recipient, err := d.paneRecipient(v)
		if err != nil {
			return "", err
		}
		if v.at.link.guest != nil {
			return v.at.link.guest.GramPost(ctx, herdrapi.GramPostParams{
				Text: "Attachment from " + v.at.link.access.GuestName + ".", To: &recipient,
				File: &herdrapi.GramFileUpload{UploadID: a.UploadID, Name: a.Name, Mime: a.Mime},
			})
		}
		result, err := v.client.GramPost(ctx, herdrapi.GramPostParams{
			Text: "Attachment from the terminal composer.", To: &recipient,
			File: &herdrapi.GramFileUpload{UploadID: a.UploadID, Name: a.Name, Mime: a.Mime},
		})
		if err != nil {
			return "", err
		}
		return result.Message.ID, nil
	}
	var receipt string
	err := v.composer.SendPrompt(ctx, paths, post, func(files []gramstore.Attachment) (bool, error) {
		var submitErr error
		receipt, submitErr = submit(paneAttachmentPrompt(text, files))
		return submitErr == nil, submitErr
	})
	return receipt, err
}

type ChatAnswerReply struct {
	Status  herdrapi.AgentAnswerStatus `json:"status,omitempty"`
	Code    string                     `json:"code,omitempty"`
	Message string                     `json:"message,omitempty"`
	// OwnerAnswers: a guest's host keeps answers for the owner (an older
	// herdr's guest_forbidden); the page waits for the owner from then on
	// (herdrup ChatView.swift:153-155).
	OwnerAnswers bool `json:"ownerAnswers,omitempty"`
}

func (d *Desk) ChatAnswer(ctx context.Context, token, askID, option string) (ChatAnswerReply, error) {
	v, err := d.agentView(token)
	if err != nil {
		return ChatAnswerReply{}, err
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	defer v.at.link.pollGuestStatus()
	params := herdrapi.AgentAnswerParams{Target: v.PaneID, AskID: askID, Option: option}
	var result herdrapi.ResponseResultAgentAnswer
	if guestLink := v.at.link.guest; guestLink != nil {
		result, err = guestLink.AgentAnswer(ctx, params)
	} else {
		result, err = v.client.AgentAnswer(ctx, params)
	}
	if err != nil {
		var api *bridge.APIError
		if errors.As(err, &api) {
			return ChatAnswerReply{Code: api.Code, Message: api.Message, OwnerAnswers: v.Guest && api.Code == guestForbidden}, nil
		}
		return ChatAnswerReply{}, err
	}
	return ChatAnswerReply{Status: result.Status}, nil
}

type ChatAnswerFormReply struct {
	// Status: answered once the tool result matched; sent_unconfirmed when
	// the keys went in but no result arrived in time (Answers then empty).
	Status  herdrapi.AgentAnswerStatus `json:"status,omitempty"`
	Answers []herdrapi.AskFormAnswer   `json:"answers,omitempty"`
	Code    string                     `json:"code,omitempty"`
	Message string                     `json:"message,omitempty"`
	// OwnerAnswers: as ChatAnswerReply's.
	OwnerAnswers bool `json:"ownerAnswers,omitempty"`
}

// ChatAnswerForm answers an omp HTML-form ask with agent.answer_form; values
// holds only the fields that differ from the agent's recommendation.
func (d *Desk) ChatAnswerForm(ctx context.Context, token, askID string, values map[string]herdrapi.AskFormValue) (ChatAnswerFormReply, error) {
	v, err := d.agentView(token)
	if err != nil {
		return ChatAnswerFormReply{}, err
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	defer v.at.link.pollGuestStatus()
	params := herdrapi.AgentAnswerFormParams{Target: v.PaneID, AskID: askID, Values: values}
	var result herdrapi.ResponseResultAskFormAnswered
	if guestLink := v.at.link.guest; guestLink != nil {
		result, err = guestLink.AgentAnswerForm(ctx, params)
	} else {
		result, err = v.client.AgentAnswerForm(ctx, params)
	}
	if err != nil {
		var api *bridge.APIError
		if errors.As(err, &api) {
			return ChatAnswerFormReply{Code: api.Code, Message: api.Message, OwnerAnswers: v.Guest && api.Code == guestForbidden}, nil
		}
		var unsupported *engine.ErrUnsupported
		if errors.As(err, &unsupported) {
			return ChatAnswerFormReply{Code: "ask_unsupported", Message: unsupported.Error()}, nil
		}
		return ChatAnswerFormReply{}, err
	}
	return ChatAnswerFormReply{Status: result.Status, Answers: result.Answers}, nil
}

// ChatDismissReply is how a Dismiss ended: Dismissed once herdr confirmed
// the ask cancelled, else herdr's refusal (Code ask_not_pending or
// ask_mismatch: the ask is already gone, nothing was sent to the pane).
type ChatDismissReply struct {
	Dismissed bool   `json:"dismissed,omitempty"`
	Code      string `json:"code,omitempty"`
	Message   string `json:"message,omitempty"`
}

// ChatDismissAsk closes the agent's pending ask as cancelled with
// agent.dismiss_ask (herdr #484), owner or guest; the page offers it only
// where the ask is dismissable for this caller.
func (d *Desk) ChatDismissAsk(ctx context.Context, token, askID string) (ChatDismissReply, error) {
	v, err := d.agentView(token)
	if err != nil {
		return ChatDismissReply{}, err
	}
	ctx, cancel := viewRequest(ctx, v.ctx)
	defer cancel()
	defer v.at.link.pollGuestStatus()
	params := herdrapi.AgentDismissAskParams{Target: v.PaneID, AskID: askID}
	var result herdrapi.ResponseResultAskDismissed
	if guestLink := v.at.link.guest; guestLink != nil {
		result, err = guestLink.AgentDismissAsk(ctx, params)
	} else {
		result, err = v.client.AgentDismissAsk(ctx, params)
	}
	if err != nil {
		var api *bridge.APIError
		if errors.As(err, &api) {
			return ChatDismissReply{Code: api.Code, Message: api.Message}, nil
		}
		var unsupported *engine.ErrUnsupported
		if errors.As(err, &unsupported) {
			return ChatDismissReply{Code: "ask_unsupported", Message: unsupported.Error()}, nil
		}
		return ChatDismissReply{}, err
	}
	return ChatDismissReply{Dismissed: result.Dismissed}, nil
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
