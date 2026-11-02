package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"runtime"
	"slices"
	"strings"
	"sync"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// The agent menus: an agent row's context menu and the agent page's •••
// menu, as herdrup's (App/HerdrApp.swift:4294-4392 and 6227-6281,
// App/PaneHeaderControls.swift:66-119). Items that need a dialog ask the
// page (AgentActionRequested); the page's ••• items it carries out itself
// (PaneActionChosen).

// AgentAction is an agent row menu item. The page shows its dialog for
// Kind rename, avatar, restart, swap or transfer, then calls the Desk
// method; stop and archive are carried out here and never sent.
type AgentAction struct {
	Kind   string `json:"kind"`
	PaneID string `json:"paneID"`
	// Title is the row's title as shown.
	Title string `json:"title"`
	// Name is the daemon name, "" without one.
	Name string `json:"name"`
	// Agent is the harness kind.
	Agent string `json:"agent"`
	// TerminalID finds the agent again after a transfer moves it.
	TerminalID string `json:"terminalID"`
	// Account is swap's account.
	Account *AgentActionAccount `json:"account,omitempty"`
	// Source and Target are transfer's harnesses.
	Source string             `json:"source,omitempty"`
	Target *AgentActionTarget `json:"target,omitempty"`
}

type AgentActionAccount struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type AgentActionTarget struct {
	// ID is the harness: claude, codex or omp.
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

// PaneAction is an agent page ••• item the page carries out. Action is
// copy-screen, copy-recent, copy-selection, text-increase, text-decrease,
// text-reset, share, avatar, mute, unmute or close. mute and unmute are
// stored before it is sent, close is sent once the pane closed.
type PaneAction struct {
	PaneID string `json:"paneID"`
	Action string `json:"action"`
}

var (
	// AgentActionRequested asks the page for a row menu item's dialog.
	AgentActionRequested = mygo.NewEvent[AgentAction]("agentActionRequested")
	// PaneActionChosen is a ••• item the page carries out.
	PaneActionChosen = mygo.NewEvent[PaneAction]("paneActionChosen")
)

// PaneMenuOptions describe the agent page the ••• menu is for.
type PaneMenuOptions struct {
	PaneID string `json:"paneID"`
	// Plain is a plain terminal: Copy… and Text size only.
	Plain bool `json:"plain"`
	// HasSelection enables Copy selection.
	HasSelection bool `json:"hasSelection"`
	// CanShare is the owner's agent, not a guest's.
	CanShare bool `json:"canShare"`
}

// AvatarChoice is a picture from the avatar sheet: Kind default, mascot
// (Mascot) or image (ImageBase64 of Mime).
type AvatarChoice struct {
	Kind        string `json:"kind"`
	Mascot      string `json:"mascot,omitempty"`
	ImageBase64 string `json:"imageBase64,omitempty"`
	Mime        string `json:"mime,omitempty"`
}

// herdrup's archive attribution (Sources/HerdrKit/HerdrClient.swift:2015-2016).
const (
	appArchiveActor  = "herdrup"
	appArchiveReason = "user action"
)

// agentMenuInput is what an agent row's menu is built from.
type agentMenuInput struct {
	Info herdrapi.AgentInfo
	// Caps are the server's; nil before its ping.
	Caps *herdrapi.ServerCapabilities
	// Groups are the folders, nil without agent_groups.
	Groups *herdr.Groups
	// Accounts are the last accounts.list.
	Accounts []herdrapi.AccountInfo
}

// agentRowMenu is an agent row's context menu, in herdrup's order
// (App/HerdrApp.swift:4294-4392): Stop agent, Rename, Avatar…, Star and
// Move to folder, Restart agent, Switch harness, Swap subscription,
// Archive.
func agentRowMenu(in agentMenuInput) []menuEntry {
	a := in.Info
	action := func(kind string) *AgentAction {
		return &AgentAction{Kind: kind, PaneID: a.PaneID, Title: herdr.DisplayName(a), Name: deref(a.Name), Agent: deref(a.Agent), TerminalID: a.TerminalID}
	}
	// HerdrApp.swift:4297 (Stop = pane.close) and 4302.
	out := []menuEntry{
		{Label: "Stop agent", Icon: "stop.circle", Action: action("stop")},
		{Label: "Rename", Icon: "pencil", Action: action("rename")},
	}
	// HerdrApp.swift:4306-4311: owner on a daemon that stores avatars
	// (avatars.canEdit = agent_avatar, 4901).
	if herdrapi.CapabilityAgentAvatar.Supported(in.Caps) {
		out = append(out, menuEntry{Label: "Avatar…", Icon: "person.crop.circle", Action: action("avatar")})
	}
	// HerdrApp.swift:4314-4321: with a name, on a server with folders.
	out = append(out, agentMenu(in.Groups, deref(a.Name))...)
	// HerdrApp.swift:4325.
	out = append(out, menuEntry{Label: "Restart agent", Icon: "arrow.clockwise", Action: action("restart")})
	// HerdrApp.swift:4333-4355: local agents, on a server with
	// agent_session_transfer or with a transfer under way.
	targets := sessionTransferTargets(a, in.Caps)
	active := a.SessionTransfer != nil && !transferConclusive(a.SessionTransfer.Phase)
	if source, ok := sessionTransferSource(a); ok && a.MachineID == nil && len(targets) > 0 &&
		(herdrapi.CapabilityAgentSessionTransfer.Supported(in.Caps) || active) {
		label := "Switch harness"
		if len(targets) == 1 {
			label = "Switch to " + harnessDisplayName(targets[0])
		}
		sub := make([]menuEntry, 0, len(targets))
		for _, t := range targets {
			act := action("transfer")
			act.Source = string(source)
			act.Target = &AgentActionTarget{ID: string(t), DisplayName: harnessDisplayName(t)}
			sub = append(sub, menuEntry{Label: harnessDisplayName(t), Icon: "arrow.right", Action: act})
		}
		out = append(out, menuEntry{Label: label, Icon: "arrow.left.arrow.right", Sub: sub})
	}
	// HerdrApp.swift:4368-4384: the agent's kind's accounts, the current
	// one included and marked.
	var swap []menuEntry
	for _, acct := range in.Accounts {
		if a.Agent == nil || acct.Kind != *a.Agent {
			continue
		}
		current := a.Account != nil && acct.ID == *a.Account
		label, icon := acct.Label, "person.crop.circle"
		if current {
			label, icon = label+" (current)", "person.crop.circle.fill"
		}
		if !acct.Active {
			label += " (exhausted)"
		}
		act := action("swap")
		act.Account = &AgentActionAccount{ID: acct.ID, Label: acct.Label}
		swap = append(swap, menuEntry{Label: label, Icon: icon, Action: act})
	}
	if len(swap) > 0 {
		out = append(out, menuEntry{Label: "Swap subscription", Icon: "arrow.left.arrow.right", Sub: swap})
	}
	// HerdrApp.swift:4390.
	return append(out, menuEntry{Label: "Archive", Icon: "archivebox", Action: action("archive")})
}

// sessionTransferSource is herdrup's (HerdrApp.swift:4204-4215): an
// unfinished transfer's source, else the agent's own native harness.
func sessionTransferSource(a herdrapi.AgentInfo) (herdrapi.AgentSessionTransferHarness, bool) {
	if t := a.SessionTransfer; t != nil && !transferConclusive(t.Phase) {
		return t.Source, true
	}
	switch strings.ToLower(deref(a.Agent)) {
	case "claude":
		return herdrapi.AgentSessionTransferHarnessClaude, true
	case "codex":
		return herdrapi.AgentSessionTransferHarnessCodex, true
	case "omp":
		return herdrapi.AgentSessionTransferHarnessOmp, true
	}
	return "", false
}

// sessionTransferTargets is herdrup's (HerdrApp.swift:4217-4228): an
// unfinished transfer's target, else every other harness the server
// transfers between.
func sessionTransferTargets(a herdrapi.AgentInfo, caps *herdrapi.ServerCapabilities) []herdrapi.AgentSessionTransferHarness {
	if t := a.SessionTransfer; t != nil && !transferConclusive(t.Phase) {
		return []herdrapi.AgentSessionTransferHarness{t.Target}
	}
	harnesses := transferHarnesses(caps)
	source, ok := sessionTransferSource(a)
	if !ok || !slices.Contains(harnesses, source) {
		return nil
	}
	var out []herdrapi.AgentSessionTransferHarness
	for _, h := range []herdrapi.AgentSessionTransferHarness{herdrapi.AgentSessionTransferHarnessClaude, herdrapi.AgentSessionTransferHarnessCodex, herdrapi.AgentSessionTransferHarnessOmp} {
		if h != source && slices.Contains(harnesses, h) {
			out = append(out, h)
		}
	}
	return out
}

// transferHarnesses are the harnesses the server transfers between
// (HerdrApp.swift:4910-4929): none without agent_session_transfer, the
// known ones it lists, or Claude Code and Codex for a server that predates
// the list.
func transferHarnesses(caps *herdrapi.ServerCapabilities) []herdrapi.AgentSessionTransferHarness {
	if !herdrapi.CapabilityAgentSessionTransfer.Supported(caps) {
		return nil
	}
	if len(caps.AgentSessionTransferHarnesses) == 0 {
		return []herdrapi.AgentSessionTransferHarness{herdrapi.AgentSessionTransferHarnessClaude, herdrapi.AgentSessionTransferHarnessCodex}
	}
	var out []herdrapi.AgentSessionTransferHarness
	for _, h := range caps.AgentSessionTransferHarnesses {
		if h.Known() {
			out = append(out, h)
		}
	}
	return out
}

// transferConclusive is AgentSessionTransferPhase.isConclusive
// (Sources/HerdrKit/Wire.swift:203-208).
func transferConclusive(p herdrapi.AgentSessionTransferPhase) bool {
	switch p {
	case herdrapi.AgentSessionTransferPhaseCompleted, herdrapi.AgentSessionTransferPhaseRolledBack, herdrapi.AgentSessionTransferPhaseFailed:
		return true
	}
	return false
}

// harnessDisplayName is AgentSessionTransferHarness.displayName
// (Sources/HerdrKit/Wire.swift:154-161).
func harnessDisplayName(h herdrapi.AgentSessionTransferHarness) string {
	switch h {
	case herdrapi.AgentSessionTransferHarnessClaude:
		return "Claude Code"
	case herdrapi.AgentSessionTransferHarnessCodex:
		return "Codex"
	case herdrapi.AgentSessionTransferHarnessOmp:
		return "Oh My Pi"
	}
	return string(h)
}

// paneMenu is the agent page's ••• menu (App/HerdrApp.swift:6227-6281):
// the copy section (PaneHeaderControls.swift:80-101) with the desktop's
// Copy selection after it, the Text size section (105-119), then for an
// agent Share with someone, Avatar…, Mute or Unmute notifications and
// Close agent. owner is a connection of the owner's, not a guest's.
func paneMenu(o PaneMenuOptions, owner, canEditAvatar, muted bool) []menuEntry {
	pane := func(action string) *PaneAction { return &PaneAction{PaneID: o.PaneID, Action: action} }
	out := []menuEntry{
		{Label: "Copy screen", Icon: "doc.on.doc", Pane: pane("copy-screen")},
		{Label: "Copy recent output", Icon: "doc.on.clipboard", Pane: pane("copy-recent")},
		// The desktop's own: herdrup has no such item, so no icon to copy.
		{Label: "Copy selection", Pane: pane("copy-selection"), Disabled: !o.HasSelection},
		{Separator: true},
		{Label: "Text size", Disabled: true},
		{Label: "Increase", Icon: "textformat.size.larger", Pane: pane("text-increase")},
		{Label: "Decrease", Icon: "textformat.size.smaller", Pane: pane("text-decrease")},
		{Label: "Reset", Icon: "arrow.counterclockwise", Pane: pane("text-reset")},
	}
	if o.Plain {
		return out
	}
	out = append(out, menuEntry{Separator: true})
	// HerdrApp.swift:6247-6252, agents only.
	if o.CanShare {
		out = append(out, menuEntry{Label: "Share with someone", Icon: "person.badge.plus", Pane: pane("share")})
	}
	// HerdrApp.swift:6253-6255; AgentAvatarViews.swift:277-281.
	if canEditAvatar {
		out = append(out, menuEntry{Label: "Avatar…", Icon: "person.crop.circle", Pane: pane("avatar")})
	}
	if !owner {
		return out
	}
	// HerdrApp.swift:6256-6261.
	if muted {
		out = append(out, menuEntry{Label: "Unmute notifications", Icon: "bell", Pane: pane("unmute")})
	} else {
		out = append(out, menuEntry{Label: "Mute notifications", Icon: "bell.slash", Pane: pane("mute")})
	}
	// HerdrApp.swift:6262-6269.
	return append(out, menuEntry{Label: "Close agent", Icon: "xmark.circle", Pane: pane("close")})
}

// AgentMenu shows an agent row's context menu (right-click); it reports
// whether there was one. The owner's live agents have one.
func (d *Desk) AgentMenu(ctx context.Context, paneID string) bool {
	d.mu.Lock()
	l := d.link
	if l == nil || l.guest != nil || l.ctx == nil {
		d.mu.Unlock()
		return false
	}
	i := slices.IndexFunc(l.agents, func(a herdrapi.AgentInfo) bool { return a.PaneID == paneID })
	if i < 0 || l.agents[i].Archived != nil {
		d.mu.Unlock()
		return false
	}
	in := agentMenuInput{Info: l.agents[i], Caps: l.caps}
	g := l.groups
	d.mu.Unlock()
	if g != nil {
		in.Groups = g.document()
	}
	d.sessions.mu.Lock()
	in.Accounts = slices.Clone(d.sessions.accountList)
	d.sessions.mu.Unlock()
	return d.popup(ctx, l, g, agentRowMenu(in))
}

// PaneMenu shows the agent page's ••• menu; it reports whether it could.
func (d *Desk) PaneMenu(ctx context.Context, o PaneMenuOptions) bool {
	d.mu.Lock()
	l := d.link
	if l == nil || o.PaneID == "" {
		d.mu.Unlock()
		return false
	}
	owner := l.guest == nil
	canEditAvatar := owner && !o.Plain && herdrapi.CapabilityAgentAvatar.Supported(l.caps)
	d.mu.Unlock()
	return d.popup(ctx, l, nil, paneMenu(o, owner, canEditAvatar, d.PaneMuted(o.PaneID)))
}

// chooseAgentAction carries out a row menu item: stop and archive here
// (herdrup run(.stop), run(.archive), HerdrApp.swift:2214-2232), the rest
// in the page's dialogs.
func (d *Desk) chooseAgentAction(l *link, a AgentAction) {
	var run func(context.Context, string) error
	switch a.Kind {
	case "stop":
		run = d.StopAgent
	case "archive":
		run = d.ArchiveAgent
	default:
		_ = AgentActionRequested.Broadcast(a)
		return
	}
	go func() {
		if err := run(l.ctx, a.PaneID); err != nil && l.ctx.Err() == nil {
			d.AlertAgentFailure("Couldn't "+a.Kind+" "+a.Title, err.Error())
		}
	}()
}

// choosePaneAction carries out a ••• item: mute and unmute are stored, then
// sent; close closes the pane (herdrup's Close agent,
// HerdrApp.swift:6262-6269) and is sent once it has; the rest are sent.
func (d *Desk) choosePaneAction(l *link, p PaneAction) {
	switch p.Action {
	case "mute", "unmute":
		if err := d.SetPaneMuted(p.PaneID, p.Action == "mute"); err != nil {
			d.AlertAgentFailure("Couldn't change notifications", err.Error())
			return
		}
	case "close":
		go func() {
			if err := d.StopAgent(l.ctx, p.PaneID); err != nil {
				if l.ctx.Err() == nil {
					d.AlertAgentFailure("Couldn't close "+d.agentTitle(l, p.PaneID), err.Error())
				}
				return
			}
			_ = PaneActionChosen.Broadcast(p)
		}()
		return
	}
	_ = PaneActionChosen.Broadcast(p)
}

// agentTitle is the pane's row title, the pane id once it is off the list.
func (d *Desk) agentTitle(l *link, paneID string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, a := range l.agents {
		if a.PaneID == paneID {
			return herdr.DisplayName(a)
		}
	}
	return paneID
}

// AlertAgentFailure shows an agent action that failed as a native warning:
// herdrup's "couldn't <verb> <title>: <error>" (perform,
// HerdrApp.swift:2245-2253), title and detail apart.
func (d *Desk) AlertAgentFailure(title, detail string) {
	d.failure(title, detail)
}

func alertAgentFailure(title, detail string) {
	_, _ = mygo.Dialog.Message(mygo.MessageOptions{Type: mygo.MessageWarning, Message: title, Detail: detail})
}

// agentLink is the owner's client for an action on paneID, the agent as
// last listed (only its pane id when it is not listed), and the watch the
// action belongs to.
func (d *Desk) agentLink(paneID string) (*engine.Client, herdrapi.AgentInfo, context.Context, error) {
	info := herdrapi.AgentInfo{PaneID: paneID}
	d.mu.Lock()
	defer d.mu.Unlock()
	l := d.link
	if l == nil || l.ctx == nil {
		return nil, info, nil, errors.New("not connected")
	}
	if l.guest != nil {
		return nil, info, nil, errors.New("only the agent's owner can change it")
	}
	if paneID == "" {
		return nil, info, nil, errors.New("no agent")
	}
	client, err := l.engineLocked()
	if err != nil {
		return nil, info, nil, err
	}
	if i := slices.IndexFunc(l.agents, func(a herdrapi.AgentInfo) bool { return a.PaneID == paneID }); i >= 0 {
		info = l.agents[i]
	}
	return client, info, l.ctx, nil
}

// StopAgent closes the agent's pane: herdrup's Stop agent and Close agent
// (pane.close, HerdrApp.swift:2219-2222 and 6262-6269).
func (d *Desk) StopAgent(ctx context.Context, paneID string) error {
	client, _, lifetime, err := d.agentLink(paneID)
	if err != nil {
		return err
	}
	ctx, cancel := viewRequest(ctx, lifetime)
	defer cancel()
	return client.PaneClose(ctx, paneID)
}

// ArchiveAgent archives the agent, attributed to herdrup
// (HerdrApp.swift:2223-2232).
func (d *Desk) ArchiveAgent(ctx context.Context, paneID string) error {
	client, _, lifetime, err := d.agentLink(paneID)
	if err != nil {
		return err
	}
	ctx, cancel := viewRequest(ctx, lifetime)
	defer cancel()
	_, err = client.AgentArchive(ctx, herdrapi.AgentArchiveParams{Target: paneID, Reason: new(appArchiveReason), By: new(appArchiveActor)})
	return err
}

// RenameAgent sets the agent's name, coerced to herdr's grammar
// (AgentName.normalize), then reloads the folders, which the server moved
// to the new name (RenameSheet, HerdrApp.swift:3568-3586). It returns the
// name saved.
func (d *Desk) RenameAgent(ctx context.Context, paneID, name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" { // RenameSheet.canSave
		return "", errors.New("enter a name")
	}
	client, _, lifetime, err := d.agentLink(paneID)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, lifetime)
	defer cancel()
	saved := normalizeAgentName(trimmed)
	res, err := client.AgentRename(ctx, paneID, saved)
	d.mu.Lock()
	var g *groupsStore
	if d.link != nil && d.link.ctx == lifetime {
		g = d.link.groups
	}
	d.mu.Unlock()
	if g != nil {
		g.refresh(lifetime, true)
	}
	if err != nil {
		return "", err
	}
	if res.Agent.Name != nil {
		saved = *res.Agent.Name
	}
	return saved, nil
}

// RestartAgent reopens the agent's session with --resume: in place for
// accountID "", else on that account, herdrup's Swap subscription
// (HerdrApp.swift:3434-3473).
func (d *Desk) RestartAgent(ctx context.Context, paneID, accountID string) error {
	client, _, lifetime, err := d.agentLink(paneID)
	if err != nil {
		return err
	}
	ctx, cancel := viewRequest(ctx, lifetime)
	defer cancel()
	return client.AgentRestart(ctx, paneID, accountID)
}

// SetAgentAvatar sets or clears the agent's picture (agent.avatar.set,
// HerdrClient.swift:1402-1461) on its avatarTarget. Errors read as
// AgentAvatarSheet.describe's (AgentAvatarViews.swift:446-458).
func (d *Desk) SetAgentAvatar(ctx context.Context, paneID string, c AvatarChoice) error {
	p, err := avatarParams(c)
	if err != nil {
		return err
	}
	client, info, lifetime, err := d.agentLink(paneID)
	if err != nil {
		return err
	}
	p.Target = avatarTarget(info)
	ctx, cancel := viewRequest(ctx, lifetime)
	defer cancel()
	_, err = client.AgentAvatarSet(ctx, p)
	return describeAvatarError(err)
}

// avatarParams encodes c as herdrup's AgentAvatarSetParams
// (HerdrClient.swift:1402-1429): default is an explicit null.
func avatarParams(c AvatarChoice) (herdrapi.AgentAvatarSetParams, error) {
	switch c.Kind {
	case "default":
		return herdrapi.AgentAvatarSetParams{Avatar: &herdrapi.AgentAvatarChoice{}}, nil
	case "mascot":
		if c.Mascot == "" {
			return herdrapi.AgentAvatarSetParams{}, errors.New("no mascot chosen")
		}
		return herdrapi.AgentAvatarSetParams{Avatar: &herdrapi.AgentAvatarChoice{Value: herdrapi.AgentAvatarChoiceMascot{Mascot: c.Mascot}}}, nil
	case "image":
		if c.ImageBase64 == "" || c.Mime == "" {
			return herdrapi.AgentAvatarSetParams{}, errors.New("no photo chosen")
		}
		return herdrapi.AgentAvatarSetParams{Avatar: &herdrapi.AgentAvatarChoice{Value: herdrapi.AgentAvatarChoiceImage{}}, ImageBase64: new(c.ImageBase64), Mime: new(c.Mime)}, nil
	}
	return herdrapi.AgentAvatarSetParams{}, errors.New("unknown picture kind " + c.Kind)
}

// avatarTarget is AgentInfo.avatarTarget
// (Sources/HerdrKit/AgentAvatarDescriptor.swift:124-128): a local agent's
// terminal id, which outlives its pane, else its pane id.
func avatarTarget(a herdrapi.AgentInfo) string {
	if a.MachineID == nil && a.TerminalID != "" {
		return a.TerminalID
	}
	if a.PaneID != "" {
		return a.PaneID
	}
	if a.TerminalID != "" {
		return a.TerminalID
	}
	return deref(a.Name)
}

// describeAvatarError is AgentAvatarSheet.describe
// (App/AgentAvatarViews.swift:446-458).
func describeAvatarError(err error) error {
	if err == nil {
		return nil
	}
	var unsupported *engine.ErrUnsupported
	if errors.As(err, &unsupported) {
		return errors.New("this server doesn't support agent pictures.")
	}
	var api *bridge.APIError
	if errors.As(err, &api) {
		switch api.Code {
		case "avatar_too_large":
			return errors.New("the photo is too large.")
		case "invalid_avatar":
			return errors.New("the server refused it.")
		}
		return errors.New(api.Message)
	}
	return err
}

// PrepareSessionTransfer stages the agent's session for harness to
// (prepareAgentSessionTransfer, HerdrClient.swift:1347-1362), on accountID
// or, for "", the harness's default account. It returns the reply,
// {"agent": AgentInfo}, as JSON.
func (d *Desk) PrepareSessionTransfer(ctx context.Context, paneID, to, accountID string) (string, error) {
	return d.transferSession(ctx, paneID, to, accountID, "")
}

// ConfirmSessionTransfer switches the agent to the prepared transfer
// transferID (confirmAgentSessionTransfer, HerdrClient.swift:1364-1383).
func (d *Desk) ConfirmSessionTransfer(ctx context.Context, paneID, to, accountID, transferID string) (string, error) {
	if transferID == "" {
		return "", errors.New("no prepared transfer")
	}
	return d.transferSession(ctx, paneID, to, accountID, transferID)
}

func (d *Desk) transferSession(ctx context.Context, paneID, to, accountID, transferID string) (string, error) {
	if to == "" {
		return "", errors.New("no target harness")
	}
	client, _, lifetime, err := d.agentLink(paneID)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, lifetime)
	defer cancel()
	p := herdrapi.AgentTransferSessionParams{Target: paneID, To: herdrapi.AgentSessionTransferHarness(to)}
	if accountID != "" {
		p.Account = &accountID
	}
	if transferID != "" {
		p.TransferID, p.Confirm = &transferID, new(true)
	}
	res, err := client.AgentTransferSession(ctx, p)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(res)
	return string(data), err
}

// TransferAgentInfo lists the agents again and returns, as JSON, the one on
// paneID or, as a transfer may move it, with terminalID (the review sheet's
// polls, App/AgentSessionTransferSheet.swift:547-640); "" when neither is
// listed.
func (d *Desk) TransferAgentInfo(ctx context.Context, paneID, terminalID string) (string, error) {
	client, _, lifetime, err := d.agentLink(paneID)
	if err != nil {
		return "", err
	}
	ctx, cancel := viewRequest(ctx, lifetime)
	defer cancel()
	res, err := client.AgentList(ctx, herdrapi.AgentListParams{})
	if err != nil {
		return "", err
	}
	i := slices.IndexFunc(res.Agents, func(a herdrapi.AgentInfo) bool {
		return a.PaneID == paneID || (terminalID != "" && a.TerminalID == terminalID)
	})
	if i < 0 {
		return "", nil
	}
	data, err := json.Marshal(res.Agents[i])
	return string(data), err
}

// TransferAccounts returns accounts.list as JSON, {"accounts": […]}, for
// the review sheet's account picker.
func (d *Desk) TransferAccounts(ctx context.Context) (string, error) {
	client, at, err := d.herdrClient()
	if err != nil {
		return "", err
	}
	d.mu.Lock()
	lifetime := at.link.ctx
	d.mu.Unlock()
	if lifetime == nil {
		return "", errors.New("not connected")
	}
	ctx, cancel := viewRequest(ctx, lifetime)
	defer cancel()
	return accountJSON(client.AccountsList(ctx))
}

// menuIcons are menu icons by SF Symbol name, nil for one that could not
// be drawn.
var menuIcons struct {
	sync.Mutex
	m map[string]*mygo.MenuIcon
}

// menuIcon is the SF Symbol name as a menu icon, drawn as the page draws
// symbols and tinted as menu text. macOS only: elsewhere Symbols draws
// SVG stand-ins, which menus cannot show.
func menuIcon(name string) *mygo.MenuIcon {
	if name == "" || runtime.GOOS != "darwin" {
		return nil
	}
	menuIcons.Lock()
	defer menuIcons.Unlock()
	if icon, ok := menuIcons.m[name]; ok {
		return icon
	}
	if menuIcons.m == nil {
		menuIcons.m = map[string]*mygo.MenuIcon{}
	}
	icon, err := drawMenuIcon(name)
	if err != nil {
		log.Printf("menu icon %s: %v", name, err)
	}
	menuIcons.m[name] = icon
	return icon
}

func drawMenuIcon(name string) (*mygo.MenuIcon, error) {
	img, err := Symbols{}.Image(name, 15, "regular", 2)
	if err != nil {
		return nil, err
	}
	b64, ok := strings.CutPrefix(img.DataURL, "data:image/png;base64,")
	if !ok {
		return nil, errors.New("not a PNG")
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, err
	}
	return mygo.NewMenuIcon(data, true)
}
