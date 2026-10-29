package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
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

// Gram, the owner's message channel with the agents, as herdrup's GramView
// drives it (App/GramView.swift) over HerdrKit's GramInbox: a list held
// between loads with its digest, polled while the page shows, the unread
// badge polled while it does not, optimistic posts, delete tombstones and
// reads that an older answer cannot undo. The page draws GramSnapshot and
// is told of every change by GramChanged.

// Gram timing, as herdrup's: the inbox every 6 s while Gram shows and every
// 30 s after a failed load (pollLoop), the badge every 15 s while it does
// not (HerdrApp), and a refresh acknowledgement for 3 s.
var (
	gramPollVisible = 6 * time.Second
	gramPollFailing = 30 * time.Second
	gramPollBadge   = 15 * time.Second
	gramAckFor      = 3 * time.Second
	// gramWaitStep and gramWaitSteps bound how long an older-page fetch
	// waits for a head load to finish (herdrup waitWhile: 2 s).
	gramWaitStep  = 100 * time.Millisecond
	gramWaitSteps = 20
)

// Page sizes (GramView.pageSize, maxRefreshLimit).
const (
	gramPageSize        = 40
	gramMaxRefreshLimit = 500
)

// Banner texts, exactly herdrup's.
const (
	gramUnavailableNow    = "Gram is unavailable right now."
	gramRefreshFailed     = "Refresh failed. Showing the last loaded messages."
	gramNotDeployed       = "Gram isn't available on this server yet."
	gramNotDeployedOrLost = "Gram isn't available on this server yet, or the messages couldn't load."
	gramOlderFailed       = "Couldn't load older messages."
)

// GramFile is an attachment's metadata as a row shows it.
type GramFile struct {
	Name string `json:"name"`
	Mime string `json:"mime"`
	Size uint64 `json:"size"`
	// SizeLabel is herdrup's displaySize: "N B", "N KB" or "N.N MB".
	SizeLabel string `json:"sizeLabel"`
	IsImage   bool   `json:"isImage"`
	// Preview is an image the feed fetches on its own (GramImage): at most
	// 8 MiB.
	Preview bool `json:"preview"`
}

// GramMessage is one row of the feed.
type GramMessage struct {
	ID string `json:"id"`
	// FromAgent is an agent's message to you; false for your own post.
	FromAgent bool `json:"fromAgent"`
	// From is the sender's routing name, which a reply is addressed to.
	From string `json:"from"`
	// Name is the sender's bare agent name, as the sender line and the
	// avatar show it.
	Name string `json:"name"`
	// SenderName is the sender with a federated alias read as its machine
	// label.
	SenderName string `json:"senderName"`
	// Machine is the sender's machine for "name · machine": its label or
	// alias, else this connection's machine; "" for your own posts.
	Machine string `json:"machine"`
	// To is the agent your post was addressed to; "" for the queue.
	To string `json:"to,omitempty"`
	// GrabbedBy is the agent that claimed your queue post.
	GrabbedBy     string `json:"grabbedBy,omitempty"`
	Text          string `json:"text"`
	CreatedUnixMs uint64 `json:"createdUnixMs"`
	// Unread is an agent's message you have not read.
	Unread      bool      `json:"unread"`
	File        *GramFile `json:"file,omitempty"`
	ExpiredFile *GramFile `json:"expiredFile,omitempty"`
	// AttachmentPreview is the attachment in a one-line preview: its name,
	// or "<name> (expired)".
	AttachmentPreview string `json:"attachmentPreview,omitempty"`
	Saved             bool   `json:"saved"`
	// Pending is your post before a list has shown it.
	Pending bool `json:"pending"`
	// StatusVerb and StatusRest are your post's status line, the verb in
	// semibold: "Grabbed" "by X", "Delivered" "to X" or "Unclaimed" "in
	// the shared queue".
	StatusVerb string `json:"statusVerb,omitempty"`
	StatusRest string `json:"statusRest,omitempty"`
}

// GramAgent is an agent that has written in Gram, for the @ list and the
// agents sheet.
type GramAgent struct {
	// From is the routing name a post to it is addressed to.
	From    string `json:"from"`
	Name    string `json:"name"`
	Machine string `json:"machine"`
}

// GramAttachment is a staged file's chip.
type GramAttachment struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	Mime    string `json:"mime"`
	IsImage bool   `json:"isImage"`
	Size    int64  `json:"size"`
	// State is the chip's state: ready, waiting, uploading, uploaded,
	// uploadFailed, sending, sent or failed.
	State string `json:"state"`
	// Label is the chip's status line, e.g. "42% · 3.1 MB".
	Label string `json:"label"`
	// Fraction is a running upload's share when Determinate.
	Fraction      float64 `json:"fraction"`
	Determinate   bool    `json:"determinate"`
	Indeterminate bool    `json:"indeterminate"`
	Failed        bool    `json:"failed"`
}

// GramSnapshot is Gram as the page draws it.
type GramSnapshot struct {
	// Phase is "idle" (no connection), "loading", "loaded" or
	// "unavailable". A list already held is shown, never a spinner.
	Phase string `json:"phase"`
	// Unavailable is the unavailable state's text.
	Unavailable string `json:"unavailable,omitempty"`
	// Messages are newest first: your posts not listed yet, then the
	// held list, without deleted ones.
	Messages    []GramMessage `json:"messages"`
	UnreadCount int           `json:"unreadCount"`
	// HasMore reports older messages beyond those held.
	HasMore      bool `json:"hasMore"`
	LoadingOlder bool `json:"loadingOlder"`
	// OlderError is the sentinel's failure, "Couldn't load older messages."
	OlderError string `json:"olderError,omitempty"`
	// Status is the banner over the composer: the first of a send error,
	// a Read-all note, a refresh acknowledgement ("Refreshing…", "Up to
	// date", "Refreshed") and a refresh failure.
	Status         string `json:"status,omitempty"`
	Refreshing     bool   `json:"refreshing"`
	MarkingAllRead bool   `json:"markingAllRead"`
	// Agents have written in Gram, most recent first.
	Agents []GramAgent `json:"agents"`
	// Saved are this device's saved messages, newest first.
	Saved []gramstore.SavedGram `json:"saved"`
	// LocalMachine labels this connection's machine.
	LocalMachine string           `json:"localMachine"`
	Attachments  []GramAttachment `json:"attachments"`
	Sending      bool             `json:"sending"`
	// SendProgress is the byte share of the uploads a send waits on, when
	// SendProgressShown.
	SendProgress      float64 `json:"sendProgress"`
	SendProgressShown bool    `json:"sendProgressShown"`
	// DraftPosted counts posts that carried the draft's text; the page
	// clears its draft when it moves.
	DraftPosted int  `json:"draftPosted"`
	Visible     bool `json:"visible"`
}

// GramUploadProgress is a staged file's upload moving.
type GramUploadProgress struct {
	Path string `json:"path"`
	// Fraction is the share sent, 0 when not measurable.
	Fraction float64 `json:"fraction"`
	// State is the chip state (GramAttachment.State); "removed" once the
	// file left the composer.
	State string `json:"state"`
	Label string `json:"label"`
}

// GramDownloadProgress is a file download moving: State "downloading",
// "done" or "failed".
type GramDownloadProgress struct {
	ID    string `json:"id"`
	Done  uint64 `json:"done"`
	Size  uint64 `json:"size"`
	State string `json:"state"`
	// Label is "<done> of <size>".
	Label string `json:"label"`
}

// AvatarFace is a Gram sender's avatar: the roster agent's, else the
// initial tile of its bare name.
type AvatarFace struct {
	Avatar  herdr.Avatar `json:"avatar"`
	Initial string       `json:"initial"`
	Tint    int          `json:"tint"`
}

var (
	// GramChanged is sent with the snapshot whenever Gram changes.
	GramChanged = mygo.NewEvent[GramSnapshot]("gram:changed")
	// GramUploadChanged is sent as a staged file's upload moves, at most
	// once per percent.
	GramUploadChanged = mygo.NewEvent[GramUploadProgress]("gram:upload")
	// GramDownloadChanged is sent as a file download moves.
	GramDownloadChanged = mygo.NewEvent[GramDownloadProgress]("gram:download")
)

// gramDesk is Gram's state for one connection. Its fields are guarded by
// mu, which is never held while d.mu is taken.
type gramDesk struct {
	mu sync.Mutex
	// link is the connection the state belongs to; nil when disconnected.
	link *link
	// ctx ends when the state is reset, stopping its downloads.
	ctx    context.Context
	cancel context.CancelFunc
	// epoch counts resets, so a download finishing late is not kept.
	epoch   int
	machine string // the connection's machine, for local senders

	inbox gramstore.Inbox
	// pending are your posts not yet in a list; deleted are tombstones of
	// confirmed deletes until a list also omits them.
	pending []herdrapi.GramMessageInfo
	deleted map[string]bool

	phase       string
	unavailable string
	// The banner's slots, in herdrup's precedence.
	sendError, markAllNote, refreshAck, refreshNote string
	ackToken                                        int
	failures                                        int
	loading, refreshQueued, refreshing              bool
	loadingOlder                                    bool
	olderError                                      string
	pageSlot                                        chan struct{}
	markingAll                                      bool
	markingRead                                     map[string]bool
	badge                                           int
	visible                                         bool
	wake                                            chan struct{}

	composer *gramstore.Composer
	// lastUpload is the last upload event per path, to send one a percent.
	lastUpload map[string]GramUploadProgress
	flights    map[string]*gramFlight
	// slots bound the feed's own image fetches (GramImagePreview).
	slots chan struct{}

	ec        *engine.Client
	ecClient  *bridge.Client
	ecSession string

	// onPublish observes snapshots, for tests.
	onPublish func(GramSnapshot)
}

func (g *gramDesk) init() {
	if g.wake == nil {
		g.wake = make(chan struct{}, 1)
		g.pageSlot = make(chan struct{}, 1)
		g.slots = make(chan struct{}, 2)
	}
}

// gramReset starts Gram afresh for l (nil when disconnected), on machine.
// The held list, the composer and the downloads in flight belong to the
// previous connection and are dropped.
func (d *Desk) gramReset(l *link, machine string) {
	g := &d.gram
	g.mu.Lock()
	g.init()
	if g.cancel != nil {
		g.cancel()
	}
	old := g.composer
	g.link, g.machine = l, machine
	g.ctx, g.cancel = context.WithCancel(context.Background())
	g.epoch++
	g.inbox = gramstore.Inbox{}
	g.pending, g.deleted, g.markingRead = nil, map[string]bool{}, map[string]bool{}
	g.phase, g.unavailable = "loading", ""
	g.sendError, g.markAllNote, g.refreshAck, g.refreshNote = "", "", "", ""
	g.ackToken++
	g.failures, g.badge = 0, 0
	g.loading, g.refreshQueued, g.refreshing, g.markingAll = false, false, false, false
	g.loadingOlder, g.olderError = false, ""
	g.flights, g.lastUpload = map[string]*gramFlight{}, map[string]GramUploadProgress{}
	g.ec, g.ecClient, g.ecSession = nil, nil, ""
	g.composer = nil
	if l != nil {
		g.composer = d.newGramComposer(l)
	} else {
		g.phase = "idle"
	}
	d.publishGramLocked()
	g.mu.Unlock()
	if old != nil {
		old.Close()
	}
}

// gramEngine is an engine client on the current session of l.
func (d *Desk) gramEngine(l *link) (*engine.Client, error) {
	d.mu.Lock()
	var c *bridge.Client
	var session string
	if d.link == l && l != nil {
		c, session = l.client, l.session
	}
	d.mu.Unlock()
	if c == nil {
		return nil, errNotConnected
	}
	g := &d.gram
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.link == l && g.ec != nil && g.ecClient == c && g.ecSession == session {
		return g.ec, nil
	}
	view, err := c.ForSession(session)
	if err != nil {
		return nil, err
	}
	ec := engine.New(engine.Bridge(view))
	if g.link == l {
		g.ec, g.ecClient, g.ecSession = ec, c, session
	}
	return ec, nil
}

// gramLink is the connection Gram's state belongs to, or errNotConnected.
func (d *Desk) gramLink() (*link, error) {
	g := &d.gram
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.link == nil {
		return nil, errNotConnected
	}
	return g.link, nil
}

// visibleLocked is the feed: pending posts, then the held list without
// them, without deleted messages. g.mu must be held.
func (g *gramDesk) visibleLocked() []herdrapi.GramMessageInfo {
	pendingIDs := make(map[string]bool, len(g.pending))
	out := make([]herdrapi.GramMessageInfo, 0, len(g.pending)+len(g.inbox.Messages()))
	for _, m := range g.pending {
		pendingIDs[m.ID] = true
		if !g.deleted[m.ID] {
			out = append(out, m)
		}
	}
	for _, m := range g.inbox.Messages() {
		if !pendingIDs[m.ID] && !g.deleted[m.ID] {
			out = append(out, m)
		}
	}
	return out
}

func (g *gramDesk) findLocked(id string) (herdrapi.GramMessageInfo, bool) {
	for _, m := range g.visibleLocked() {
		if m.ID == id {
			return m, true
		}
	}
	return herdrapi.GramMessageInfo{}, false
}

func gramFile(f *herdrapi.GramFileInfo) *GramFile {
	if f == nil {
		return nil
	}
	image := strings.HasPrefix(strings.ToLower(f.Mime), "image/")
	return &GramFile{Name: f.Name, Mime: f.Mime, Size: f.Size, SizeLabel: gramstore.DisplaySize(f.Size),
		IsImage: image, Preview: image && f.Size <= gramPreviewMaxBytes}
}

func gramRow(m herdrapi.GramMessageInfo, local string, saved, pending bool) GramMessage {
	r := GramMessage{
		ID: m.ID, FromAgent: m.Direction == herdrapi.GramDirectionAgentToOwner, From: m.From,
		Name: gramstore.AgentName(m.From), SenderName: gramstore.SenderName(m), Text: m.Text,
		CreatedUnixMs: m.CreatedUnixMs, Unread: gramstore.IsUnread(m), File: gramFile(m.File),
		AttachmentPreview: gramstore.AttachmentPreview(m), Saved: saved, Pending: pending,
	}
	if m.File == nil {
		r.ExpiredFile = gramFile(m.ExpiredFile)
	}
	if m.To != nil {
		r.To = *m.To
	}
	if m.GrabbedBy != nil {
		r.GrabbedBy = *m.GrabbedBy
	}
	if r.FromAgent {
		r.Machine = gramstore.SenderMachine(m)
		if r.Machine == "" {
			r.Machine = local
		}
		return r
	}
	switch {
	case r.GrabbedBy != "":
		r.StatusVerb, r.StatusRest = "Grabbed", "by "+gramstore.AgentName(r.GrabbedBy)
	case r.To != "":
		r.StatusVerb, r.StatusRest = "Delivered", "to "+gramstore.AgentName(r.To)
	default:
		r.StatusVerb, r.StatusRest = "Unclaimed", "in the shared queue"
	}
	return r
}

// snapshotLocked builds the snapshot. g.mu must be held.
func (d *Desk) snapshotLocked() GramSnapshot {
	g := &d.gram
	saved := d.savedGrams()
	ids := saved.IDs()
	s := GramSnapshot{
		Phase: g.phase, Unavailable: g.unavailable, UnreadCount: g.badge, HasMore: g.inbox.HasMore(),
		LoadingOlder: g.loadingOlder, OlderError: g.olderError, Refreshing: g.refreshing,
		MarkingAllRead: g.markingAll, Saved: saved.List(), LocalMachine: g.machine, Visible: g.visible,
		Messages: []GramMessage{}, Agents: []GramAgent{}, Attachments: []GramAttachment{},
	}
	if s.Phase == "" {
		s.Phase = "idle"
	}
	for _, text := range []string{g.sendError, g.markAllNote, g.refreshAck, g.refreshNote} {
		if text != "" {
			s.Status = text
			break
		}
	}
	pendingIDs := map[string]bool{}
	for _, m := range g.pending {
		pendingIDs[m.ID] = true
	}
	seen := map[string]bool{}
	for _, m := range g.visibleLocked() {
		row := gramRow(m, g.machine, ids[m.ID], pendingIDs[m.ID])
		s.Messages = append(s.Messages, row)
		if row.FromAgent && !seen[m.From] {
			seen[m.From] = true
			s.Agents = append(s.Agents, GramAgent{From: m.From, Name: row.Name, Machine: row.Machine})
		}
	}
	if g.composer != nil {
		st := g.composer.Snapshot()
		s.Sending, s.DraftPosted = st.Sending, st.DraftPosted
		s.SendProgress, s.SendProgressShown = st.Progress, st.ProgressOK
		for _, c := range st.Chips {
			s.Attachments = append(s.Attachments, gramChip(c))
		}
	}
	return s
}

func gramChip(c gramstore.Chip) GramAttachment {
	f, ok := c.State.Progress()
	return GramAttachment{
		Path: c.Path, Name: c.Name, Mime: c.Mime, IsImage: c.IsImage, Size: c.Size,
		State: string(c.State.Kind), Label: c.State.Label(c.Size), Fraction: f, Determinate: ok,
		Indeterminate: c.State.Indeterminate(), Failed: c.State.Failed(),
	}
}

// publishGramLocked sends the snapshot. g.mu must be held, so a later
// change cannot be overtaken by an earlier one.
func (d *Desk) publishGramLocked() {
	s := d.snapshotLocked()
	GramChanged.Broadcast(s)
	if d.gram.onPublish != nil {
		d.gram.onPublish(s)
	}
}

func (d *Desk) publishGram() {
	d.gram.mu.Lock()
	defer d.gram.mu.Unlock()
	d.publishGramLocked()
}

// GramState returns Gram as the page draws it.
func (d *Desk) GramState() GramSnapshot {
	d.gram.mu.Lock()
	defer d.gram.mu.Unlock()
	return d.snapshotLocked()
}

// GramSetVisible tells Gram whether its page shows. While it shows the
// inbox is polled every 6 s (30 s after a failure); while it does not, the
// unread badge every 15 s, and staged uploads nothing waits on pause.
func (d *Desk) GramSetVisible(visible bool) {
	g := &d.gram
	g.mu.Lock()
	g.init()
	was := g.visible
	g.visible = visible
	c := g.composer
	if was != visible {
		d.publishGramLocked()
	}
	g.mu.Unlock()
	if was == visible {
		return
	}
	if c != nil {
		if visible {
			c.Resume()
		} else {
			c.Pause()
		}
	}
	select {
	case g.wake <- struct{}{}:
	default:
	}
}

// watchGram polls Gram for connection ctx of l until it ends.
func (d *Desk) watchGram(ctx context.Context, l *link) {
	g := &d.gram
	for {
		g.mu.Lock()
		if g.link != l {
			g.mu.Unlock()
			return
		}
		visible, wake := g.visible, g.wake
		g.mu.Unlock()
		var wait time.Duration
		if visible {
			d.gramLoad(ctx, l)
			g.mu.Lock()
			wait = gramPollVisible
			if g.failures > 0 {
				wait = gramPollFailing
			}
			g.mu.Unlock()
		} else {
			d.gramBadge(ctx, l)
			wait = gramPollBadge
		}
		select {
		case <-ctx.Done():
			return
		case <-wake:
		case <-time.After(wait):
		}
	}
}

// gramBadge reads the unread count while Gram does not show: an
// unconditional unread_only list, counted by the daemon's unread_count.
func (d *Desk) gramBadge(ctx context.Context, l *link) {
	ec, err := d.gramEngine(l)
	if err != nil {
		return
	}
	listing, err := ec.GramList(ctx, herdrapi.GramListParams{UnreadOnly: true})
	if err != nil {
		return
	}
	n, ok := gramstore.FromList(listing.List, listing.Unchanged).BadgeCount()
	g := &d.gram
	g.mu.Lock()
	defer g.mu.Unlock()
	if !ok || g.link != l || g.badge == n {
		return
	}
	g.badge = n
	d.publishGramLocked()
}

type gramOutcome int

const (
	gramUnchanged gramOutcome = iota
	gramUpdated
	gramFailed
)

// gramLoad is one head load, unless one is already running.
func (d *Desk) gramLoad(ctx context.Context, l *link) gramOutcome {
	g := &d.gram
	g.mu.Lock()
	if g.link != l || g.loading {
		g.mu.Unlock()
		return gramUnchanged
	}
	g.loading = true
	return d.gramLoadLocked(ctx, l)
}

// gramLoadLocked runs a head load that has set g.loading, entered with
// g.mu held; it returns with g.mu released. The list asked for covers what
// is held (a changed answer replaces it), conditional on the held digest.
func (d *Desk) gramLoadLocked(ctx context.Context, l *link) (outcome gramOutcome) {
	g := &d.gram
	if g.inbox.HasLoaded() && g.phase == "loading" {
		g.phase = "loaded"
	}
	if !g.inbox.HasLoaded() && len(g.visibleLocked()) == 0 {
		g.phase = "loading"
	}
	asked := g.inbox.ReadStamp()
	params := herdrapi.GramListParams{Limit: new(uint64(min(max(gramPageSize, len(g.inbox.Messages())), gramMaxRefreshLimit)))}
	if digest := g.inbox.ConditionalDigest(); digest != "" {
		params.IfUnchangedDigest = new(digest)
	}
	d.publishGramLocked()
	g.mu.Unlock()

	var listing engine.GramListing
	ec, err := d.gramEngine(l)
	if err == nil {
		listing, err = ec.GramList(ctx, params)
	}
	var answer gramstore.Answer
	if err == nil {
		answer = gramstore.FromList(listing.List, listing.Unchanged)
		if _, xerr := d.savedGrams().ExpireFiles(answer.Messages); xerr != nil {
			d.alertSaved(xerr)
		}
	}

	g.mu.Lock()
	queued := false
	defer func() {
		g.mu.Unlock()
		if queued {
			go d.gramRefresh(context.WithoutCancel(ctx), l)
		}
	}()
	if g.link != l {
		return gramUnchanged
	}
	g.loading = false
	queued, g.refreshQueued = g.refreshQueued, false
	if err != nil {
		g.failures++
		empty := len(g.visibleLocked()) == 0
		var api *bridge.APIError
		switch {
		case errors.As(err, &api) && api.Code == "gram_unavailable" && empty:
			g.phase, g.unavailable = "unavailable", gramNotDeployed
		case errors.As(err, &api) && api.Code == "gram_unavailable":
			g.refreshNote = gramUnavailableNow
		case empty:
			g.phase, g.unavailable = "unavailable", gramNotDeployedOrLost
		default:
			g.refreshNote = gramRefreshFailed
		}
		d.publishGramLocked()
		return gramFailed
	}
	changed := g.inbox.Apply(answer, asked)
	g.phase, g.unavailable, g.refreshNote, g.failures = "loaded", "", "", 0
	if !changed && answer.Unchanged {
		d.publishGramLocked()
		return gramUnchanged
	}
	g.badge = g.inbox.UnreadCount()
	server := map[string]bool{}
	for _, m := range g.inbox.Messages() {
		server[m.ID] = true
	}
	g.pending = slices.DeleteFunc(g.pending, func(m herdrapi.GramMessageInfo) bool { return server[m.ID] })
	for id := range g.deleted {
		if !server[id] {
			delete(g.deleted, id)
		}
	}
	d.publishGramLocked()
	return gramUpdated
}

// ack shows a refresh acknowledgement, cleared after 3 s unless it is
// replaced first or does not expire. g.mu must be held.
func (d *Desk) ackLocked(l *link, text string, expiring bool) {
	g := &d.gram
	g.refreshAck = text
	if text == "" || !expiring {
		return
	}
	g.ackToken++
	token := g.ackToken
	time.AfterFunc(gramAckFor, func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		if g.link == l && g.ackToken == token && g.refreshAck == text {
			g.refreshAck = ""
			d.publishGramLocked()
		}
	})
}

// GramRefresh loads the inbox now, as Refresh does: never dropped (a tap
// during a load runs after it, "Refreshing…" meanwhile) and acknowledged
// "Up to date" or "Refreshed"; a failure shows its own note.
func (d *Desk) GramRefresh(ctx context.Context) error {
	l, err := d.gramLink()
	if err != nil {
		return err
	}
	d.gramRefresh(ctx, l)
	return nil
}

func (d *Desk) gramRefresh(ctx context.Context, l *link) {
	g := &d.gram
	g.mu.Lock()
	if g.link != l {
		g.mu.Unlock()
		return
	}
	if g.loading {
		g.refreshQueued = true
		d.ackLocked(l, "Refreshing…", false)
		d.publishGramLocked()
		g.mu.Unlock()
		return
	}
	g.loading, g.refreshing = true, true
	outcome := d.gramLoadLocked(ctx, l)
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.link != l {
		return
	}
	g.refreshing = false
	switch outcome {
	case gramUnchanged:
		d.ackLocked(l, "Up to date", true)
	case gramUpdated:
		d.ackLocked(l, "Refreshed", true)
	default:
		d.ackLocked(l, "", true)
	}
	d.publishGramLocked()
}

// GramLoadOlder fetches the page older than everything held, as the feed's
// top sentinel does, and reports whether the list grew. A page built on a
// cursor a head load has since replaced is dropped and asked for once more.
func (d *Desk) GramLoadOlder(ctx context.Context) (bool, error) {
	l, err := d.gramLink()
	if err != nil {
		return false, err
	}
	g := &d.gram
	select {
	case g.pageSlot <- struct{}{}:
	case <-ctx.Done():
		return false, ctx.Err()
	}
	defer func() { <-g.pageSlot }()
	g.mu.Lock()
	g.loadingOlder, g.olderError = true, ""
	d.publishGramLocked()
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		if g.link == l {
			g.loadingOlder = false
			d.publishGramLocked()
		}
		g.mu.Unlock()
	}()
	ec, err := d.gramEngine(l)
	if err != nil {
		return false, err
	}
	for range 2 {
		for range gramWaitSteps {
			g.mu.Lock()
			busy := g.loading
			g.mu.Unlock()
			if !busy {
				break
			}
			time.Sleep(gramWaitStep)
		}
		g.mu.Lock()
		cursor, generation, asked := g.inbox.NextCursor(), g.inbox.Generation(), g.inbox.ReadStamp()
		g.mu.Unlock()
		if cursor == "" {
			return false, nil
		}
		listing, err := ec.GramList(ctx, herdrapi.GramListParams{Limit: new(uint64(gramPageSize)), BeforeID: &cursor})
		if err != nil {
			if ctx.Err() != nil {
				return false, err
			}
			g.mu.Lock()
			if g.link == l {
				g.olderError = gramOlderFailed
			}
			g.mu.Unlock()
			return false, err
		}
		answer := gramstore.FromList(listing.List, listing.Unchanged)
		g.mu.Lock()
		if g.link != l {
			g.mu.Unlock()
			return false, nil
		}
		grew := g.inbox.AppendPage(answer, generation, asked)
		stale := g.inbox.Generation() != generation
		g.mu.Unlock()
		if grew {
			if _, err := d.savedGrams().ExpireFiles(answer.Messages); err != nil {
				d.alertSaved(err)
			}
			return true, nil
		}
		if !stale {
			return false, nil
		}
	}
	return false, nil
}

// GramMarkRead marks an unread message read once it shows; the local copy
// flips only after herdr confirms.
func (d *Desk) GramMarkRead(ctx context.Context, id string) error {
	l, err := d.gramLink()
	if err != nil {
		return err
	}
	g := &d.gram
	g.mu.Lock()
	m, ok := g.findLocked(id)
	if !ok || !gramstore.IsUnread(m) || g.markingRead[id] {
		g.mu.Unlock()
		return nil
	}
	g.markingRead[id] = true
	g.mu.Unlock()
	ec, err := d.gramEngine(l)
	if err == nil {
		err = ec.GramMarkRead(ctx, herdrapi.GramMarkReadParams{ID: &id})
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.link != l {
		return err
	}
	delete(g.markingRead, id)
	if err != nil {
		return err // left unread; the next poll shows it again
	}
	g.inbox.MarkRead(id)
	g.badge = g.inbox.UnreadCount()
	d.publishGramLocked()
	return nil
}

// GramMarkAllRead marks every unread message read, older than the held
// list too: the ids come from an unread_only list, each marked by its own
// gram.mark_read, in two passes so an id another mark had in flight is
// tried again. Failures are reported as "N of M could not be marked read."
func (d *Desk) GramMarkAllRead(ctx context.Context) error {
	l, err := d.gramLink()
	if err != nil {
		return err
	}
	g := &d.gram
	g.mu.Lock()
	if g.markingAll {
		g.mu.Unlock()
		return nil
	}
	g.markingAll, g.markAllNote = true, ""
	d.publishGramLocked()
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		if g.link == l {
			g.markingAll = false
			d.publishGramLocked()
		}
		g.mu.Unlock()
	}()
	ec, err := d.gramEngine(l)
	if err != nil {
		return err
	}
	var pending []string
	if listing, err := ec.GramList(ctx, herdrapi.GramListParams{UnreadOnly: true}); err == nil {
		for _, m := range gramstore.FromList(listing.List, listing.Unchanged).Messages {
			if gramstore.IsUnread(m) {
				pending = append(pending, m.ID)
			}
		}
	} else {
		g.mu.Lock()
		for _, m := range g.inbox.Messages() {
			if gramstore.IsUnread(m) {
				pending = append(pending, m.ID)
			}
		}
		g.mu.Unlock()
	}
	marked := map[string]bool{}
	attempted, failed := 0, 0
	for range 2 {
		var inFlight []string
		for _, id := range pending {
			g.mu.Lock()
			if g.link != l {
				g.mu.Unlock()
				return errNotConnected
			}
			if g.markingRead[id] {
				inFlight = append(inFlight, id)
				g.mu.Unlock()
				continue
			}
			if i := slices.IndexFunc(g.inbox.Messages(), func(m herdrapi.GramMessageInfo) bool { return m.ID == id }); i >= 0 && !gramstore.IsUnread(g.inbox.Messages()[i]) {
				g.mu.Unlock()
				continue
			}
			g.markingRead[id] = true
			attempted++
			g.mu.Unlock()
			err := ec.GramMarkRead(ctx, herdrapi.GramMarkReadParams{ID: &id})
			g.mu.Lock()
			if err == nil {
				marked[id] = true
				g.inbox.MarkRead(id)
			} else {
				failed++
			}
			delete(g.markingRead, id)
			g.mu.Unlock()
		}
		pending = inFlight
		if len(pending) == 0 {
			break
		}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.link != l {
		return errNotConnected
	}
	for id := range marked {
		g.inbox.MarkRead(id)
	}
	g.badge = g.inbox.UnreadCount()
	if failed > 0 {
		g.markAllNote = fmt.Sprintf("%d of %d could not be marked read.", failed, attempted)
	}
	return nil
}

// GramDelete deletes a message for good. The row goes at once and stays
// gone until a list agrees; its downloaded file goes with it.
func (d *Desk) GramDelete(ctx context.Context, id string) error {
	l, err := d.gramLink()
	if err != nil {
		return err
	}
	ec, err := d.gramEngine(l)
	if err == nil {
		err = ec.GramDelete(ctx, herdrapi.GramDeleteParams{ID: id})
	}
	g := &d.gram
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.link != l {
		return err
	}
	if err != nil {
		var api *bridge.APIError
		if errors.As(err, &api) {
			g.sendError = "Couldn't delete: " + api.Message
		} else {
			g.sendError = "Couldn't delete. Try again."
		}
		d.publishGramLocked()
		return err
	}
	g.deleted[id] = true
	g.inbox.Remove(id)
	g.pending = slices.DeleteFunc(g.pending, func(m herdrapi.GramMessageInfo) bool { return m.ID == id })
	d.gramCache().Remove(id)
	d.publishGramLocked()
	return nil
}

// savedGrams is this device's saved messages.
func (d *Desk) savedGrams() *gramstore.Saved {
	d.savedOnce.Do(func() {
		d.saved = gramstore.NewSaved(filepath.Join(d.dir, "saved-grams.json"))
	})
	return d.saved
}

func (d *Desk) alertSaved(err error) {
	if d.alert != nil {
		go d.alert("Couldn't update the saved messages: " + err.Error())
	}
}

// GramSetSaved saves a copy of a message on this device, or forgets it.
func (d *Desk) GramSetSaved(id string, saved bool) error {
	g := &d.gram
	g.mu.Lock()
	defer g.mu.Unlock()
	var err error
	if saved {
		m, ok := g.findLocked(id)
		if !ok {
			return fmt.Errorf("no gram message %q", id)
		}
		_, err = d.savedGrams().Save(m, gramstore.SenderName(m))
	} else {
		_, err = d.savedGrams().Remove(id)
	}
	if err != nil {
		return err
	}
	d.publishGramLocked()
	return nil
}

// GramSaved returns this device's saved messages, newest first.
func (d *Desk) GramSaved() []gramstore.SavedGram { return d.savedGrams().List() }

// GramSenderAvatar is the avatar of a Gram sender's routing name: the
// roster agent it names (a federated name on its own machine), else the
// initial tile of its bare name. A photo is fetched with AvatarImage.
func (d *Desk) GramSenderAvatar(name string) AvatarFace {
	bare := gramstore.AgentName(name)
	face := AvatarFace{Avatar: herdr.Avatar{Kind: "initial"}, Initial: herdr.Initial(bare), Tint: herdr.TintIndex(bare)}
	d.mu.Lock()
	var agents []herdrapi.AgentInfo
	if d.link != nil {
		agents = d.link.agents
	}
	d.mu.Unlock()
	if a, ok := gramstore.AgentForSender(name, agents); ok {
		face.Avatar = herdr.AvatarOf(a)
	}
	return face
}

// GramCopyText puts text on the clipboard (a message's Copy, a code
// block's Copy).
func (d *Desk) GramCopyText(text string) { d.writeClipboard(text) }

// GramMenuChoice is the item chosen from a message's context menu.
type GramMenuChoice struct {
	ID   string `json:"id"`
	Item string `json:"item"`
}

// GramMenuChosen is sent when an item of a message's context menu is
// chosen; the page acts on it (Save to Files needs its call for the save
// dialog's window).
var GramMenuChosen = mygo.NewEvent[GramMenuChoice]("gram:menu")

// GramMenu shows a message's context menu (right-click) with items, the
// page's labels in its order, and reports the one chosen through
// GramMenuChosen. It reports whether there was a menu to show.
func (d *Desk) GramMenu(ctx context.Context, id string, items []string) bool {
	if len(items) == 0 {
		return false
	}
	entries := make([]*mygo.MenuItem, 0, len(items))
	for _, label := range items {
		entries = append(entries, &mygo.MenuItem{Label: label, Click: func(*mygo.MenuItem, *mygo.Window) {
			GramMenuChosen.Broadcast(GramMenuChoice{ID: id, Item: label})
		}})
	}
	mygo.NewMenu(entries).Popup(mygo.CallerWindow(ctx))
	return true
}
