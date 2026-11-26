package main

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/gramstore"
	"github.com/jerryfane/herdrup-desktop/internal/guest"
)

// One Gram for a guest (themartianapp/herdrup#697): every saved shared agent's
// Gram, each with its own state (gramDesk) on a link of its own beside the
// agent page's, published together as GuestGramChanged. The page merges them
// (src/guestGramMerge.ts, the rule agreed with iOS). A message id is
// "<grant>\x1f<id>" here, so the Gram calls that take one reach its grant.

// guestGramSep joins a grant id and a message id; neither holds it.
const guestGramSep = "\x1f"

// GuestGramGrant is one shared agent of the combined guest Gram.
type GuestGramGrant struct {
	ID      string `json:"id"`
	Agent   string `json:"agent"`
	Owner   string `json:"owner"`
	Machine string `json:"machine"`
	// Terminal is the shared agent's terminal, which tells two same-named
	// agents on one machine apart.
	Terminal string `json:"terminal"`
	// Gram: the owner shares Gram with this agent's guests. Known once the
	// grant's first request was answered (Ready).
	Gram  bool `json:"gram"`
	Ready bool `json:"ready"`
	// Error is why the grant can't be read, "" while it can.
	Error string `json:"error,omitempty"`
}

// GuestGramState is one shared agent's Gram for the combined guest Gram.
type GuestGramState struct {
	Grant GuestGramGrant `json:"grant"`
	Gram  GramSnapshot   `json:"gram"`
}

// GuestGramSnapshot is the combined guest Gram: every saved shared agent, in
// the order saved, and the agent the composer posts to.
type GuestGramSnapshot struct {
	Active    bool             `json:"active"`
	Grants    []GuestGramState `json:"grants"`
	Recipient string           `json:"recipient"`
	// Saved is this device's saved messages, newest first (one list for
	// every shared agent; a shared agent's under its "<grant>\x1f<id>").
	Saved []gramstore.SavedGram `json:"saved"`
}

var GuestGramChanged = mygo.NewEvent[GuestGramSnapshot]("guest-gram:changed")

// guestGramHub holds the shared agents' Gram. Lock order: a gramDesk's mu,
// then h.mu; never d.mu under h.mu.
type guestGramHub struct {
	d      *Desk
	cancel context.CancelFunc
	ctx    context.Context

	mu        sync.Mutex
	order     []string
	links     map[string]*link
	grants    map[string]GuestGramGrant
	snaps     map[string]GramSnapshot
	visible   bool
	recipient string
}

// Polling for N shared agents: a host with multi_request reuses its session,
// so each polls as the owner's Gram does (its badge every 30 s). On every
// other host each relay request is a connect, and the relay allows a network
// 30 a minute for everything a guest does: those hosts share about 12 a
// minute between them, so each request costs singles × 5 s of wait (a hidden
// badge walks every page; watchGram waits by the requests it made).
func guestGramPolls(multi bool, singles int) (visible, badge, cost time.Duration) {
	if multi {
		return gramPollVisible, max(gramPollBadge, 30*time.Second), 0
	}
	return gramPollVisible, max(gramPollBadge, 30*time.Second), time.Duration(max(singles, 1)) * 5 * time.Second
}

// guestGramRediscover is how often a shared agent whose owner doesn't share
// Gram is asked again, so turning sharing on later offers its Gram (one
// connect each time).
var guestGramRediscover = 2 * time.Minute

// installGuestGram is the combined guest Gram, made now if none runs. d.mu
// must be held: ConnectGuest installs it with its link, and syncs it with the
// saved shared agents after; only a connection change detaches it.
func (d *Desk) installGuestGram() *guestGramHub {
	h := d.guestGram.Load()
	if h == nil {
		ctx, cancel := context.WithCancel(context.Background())
		h = &guestGramHub{d: d, ctx: ctx, cancel: cancel, links: map[string]*link{}, grants: map[string]GuestGramGrant{}, snaps: map[string]GramSnapshot{}}
		d.guestGram.Store(h)
	}
	return h
}

// detachGuestGram takes the combined guest Gram out of use and tells the page
// it is gone; nil when none ran. Its reads run on until stop.
func (d *Desk) detachGuestGram() *guestGramHub {
	h := d.guestGram.Swap(nil)
	if h != nil {
		GuestGramChanged.Broadcast(GuestGramSnapshot{Grants: []GuestGramState{}})
	}
	return h
}

// stop ends a detached hub's reads. It returns its links, closed, whose work
// may still be ending (Disconnect waits for it).
func (h *guestGramHub) stop() []*link {
	h.cancel()
	h.mu.Lock()
	links := make([]*link, 0, len(h.links))
	for _, l := range h.links {
		links = append(links, l)
	}
	h.mu.Unlock()
	// After h.mu: closing takes each grant's g.mu (lock order).
	for _, l := range links {
		closeLink(l)
	}
	return links
}

// syncGuestGram brings a running combined guest Gram up to date with the
// saved shared agents (one accepted or forgotten).
func (d *Desk) syncGuestGram() {
	if h := d.guestGram.Load(); h != nil {
		h.sync()
	}
}

// sync adds a link for each newly saved shared agent and drops forgotten ones.
func (h *guestGramHub) sync() {
	d := h.d
	list, err := d.guestStore.List()
	if err != nil {
		return
	}
	identity, err := guest.ExistingIdentity(filepath.Join(d.dir, "guest-identity"))
	if err != nil && len(list) > 0 {
		return
	}
	saved := map[string]bool{}
	var started, dropped []*link
	h.mu.Lock()
	// Stopped (a Disconnect between ConnectGuest's install and this sync):
	// stop has its links, and it gets no more.
	if h.ctx.Err() != nil {
		h.mu.Unlock()
		return
	}
	h.order = h.order[:0]
	for _, access := range list {
		id := access.ID()
		saved[id] = true
		h.order = append(h.order, id)
		if h.links[id] != nil {
			continue
		}
		access := access
		transport := guest.NewTransport(access, identity, d.guestClock, d.guestStatements())
		ctx, cancel := context.WithCancel(h.ctx)
		l := &link{id: "guest-gram:" + id, guest: transport, guestClient: engine.New(transport), access: &access, ctx: ctx, cancelGram: cancel}
		l.gram = &gramDesk{hub: h, prefix: id + guestGramSep}
		h.links[id] = l
		h.grants[id] = GuestGramGrant{ID: id, Agent: access.AgentName, Owner: access.OwnerName, Machine: access.MachineLabel, Terminal: access.AgentTarget}
		started = append(started, l)
	}
	for id, l := range h.links {
		if !saved[id] {
			dropped = append(dropped, l)
			delete(h.links, id)
			delete(h.grants, id)
			delete(h.snaps, id)
		}
	}
	if h.recipient != "" && !saved[h.recipient] {
		h.recipient = ""
	}
	h.mu.Unlock()
	for _, l := range dropped {
		closeLink(l)
	}
	for _, l := range started {
		// Refused once Disconnect closed it: nothing reads it.
		if !l.work.Go(func() { h.run(l) }) {
			_ = l.guest.Close()
		}
	}
	h.publish()
}

// run reads one shared agent: an agent list says whether its owner shares
// Gram (each admission's hello reads it anew), asked again every
// guestGramRediscover while not; while shared, its Gram is polled, and when
// the owner stops sharing it (watchGram returns) run asks again, until the
// grant is dropped.
func (h *guestGramHub) run(l *link) {
	d := h.d
	ctx := l.ctx
	defer l.guest.Close()
	stop := context.AfterFunc(ctx, func() { _ = l.guest.Close() })
	defer stop()
	id := l.access.ID()
	for ctx.Err() == nil {
		if !h.discoverGram(ctx, l, id) {
			return
		}
		// Its Gram (composer, held list) exists before the page is told it
		// shares Gram: a post or a pick of it as recipient never meets
		// "not connected".
		if d.guestGramSettingUp != nil {
			d.guestGramSettingUp(id)
		}
		d.gramReset(l, l.access.MachineLabel)
		h.setGrant(id, func(g *GuestGramGrant) { g.Gram = true })
		h.mu.Lock()
		visible := h.visible
		h.mu.Unlock()
		h.repoll()
		if visible {
			d.gramSetVisibleOn(l.gram, true)
		}
		d.watchGram(ctx, l)
		if ctx.Err() != nil {
			return
		}
		h.withdrawn(l, id)
	}
}

// withdrawn is a shared agent whose owner stopped sharing Gram: its files
// attached can no longer be posted (its host refuses Gram), so its Gram is
// reset (the composer and its uploads go), and it stops being the recipient,
// so "to" falls back to an agent that shares Gram.
func (h *guestGramHub) withdrawn(l *link, id string) {
	h.d.gramReset(l, l.access.MachineLabel)
	h.mu.Lock()
	if h.recipient == id {
		h.recipient = ""
	}
	h.mu.Unlock()
	h.setGrant(id, func(g *GuestGramGrant) { g.Gram = false })
}

// discoverGram lists the shared agent's agents until its owner shares Gram
// (true), or the grant ends (false).
func (h *guestGramHub) discoverGram(ctx context.Context, l *link, id string) bool {
	d := h.d
	for ctx.Err() == nil {
		_, _, err := l.guestClient.GuestAgentList(ctx)
		if ctx.Err() != nil {
			return false
		}
		wait := guestGramRediscover
		if err != nil {
			h.setGrant(id, func(g *GuestGramGrant) { g.Error = err.Error() })
			if errors.Is(err, guest.ErrRevoked) {
				return false
			}
			wait = 30 * time.Second
			if errors.Is(err, guest.ErrRateLimited) {
				wait = max(wait, l.guest.RateLimitedUntil().Sub(d.guestClock.Now()))
			}
		} else {
			// Each admission reads the owner's sharing anew (the hello's
			// features): ask again later while Gram is off. Gram on is
			// published by run, once the shared agent's Gram is set up.
			features := l.guest.Features()
			h.setGrant(id, func(g *GuestGramGrant) { g.Ready, g.Error = true, ""; g.Gram = g.Gram && features.Gram })
			if features.Gram {
				return true
			}
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(wait):
		}
	}
	return false
}

// repoll spaces the shared agents' polls by how many share a host without
// session reuse (guestGramPolls).
func (h *guestGramHub) repoll() {
	h.mu.Lock()
	links := make([]*link, 0, len(h.links))
	singles := 0
	for _, l := range h.links {
		links = append(links, l)
		if !l.guest.Features().MultiRequest {
			singles++
		}
	}
	h.mu.Unlock()
	for _, l := range links {
		visible, badge, cost := guestGramPolls(l.guest.Features().MultiRequest, singles)
		g := l.gram
		g.mu.Lock()
		g.pollVisible, g.pollBadge, g.requestCost = visible, badge, cost
		g.mu.Unlock()
	}
}

func (h *guestGramHub) setGrant(id string, change func(*GuestGramGrant)) {
	h.mu.Lock()
	grant, ok := h.grants[id]
	if ok {
		change(&grant)
		h.grants[id] = grant
	}
	h.mu.Unlock()
	if ok {
		h.publish()
	}
}

// closeLink ends a shared agent's reads and its composer (uploads in flight
// are discarded), as gramReset does for the owner's.
func closeLink(l *link) {
	l.cancelGram()
	g := l.gram
	g.mu.Lock()
	old := g.composer
	g.composer = nil
	if g.cancel != nil {
		g.cancel()
	}
	g.mu.Unlock()
	if old != nil {
		old.Close()
	}
}

// update keeps a shared agent's snapshot and publishes them all. g.mu is held.
func (h *guestGramHub) update(g *gramDesk, s GramSnapshot) {
	id := strings.TrimSuffix(g.prefix, guestGramSep)
	h.mu.Lock()
	if _, ok := h.grants[id]; ok {
		h.snaps[id] = s
	}
	h.mu.Unlock()
	h.publish()
}

func (h *guestGramHub) snapshot() GuestGramSnapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := GuestGramSnapshot{Active: true, Grants: make([]GuestGramState, 0, len(h.order)), Recipient: h.recipient, Saved: h.d.savedGrams().List()}
	for _, id := range h.order {
		grant, ok := h.grants[id]
		if !ok {
			continue
		}
		snap, ok := h.snaps[id]
		if !ok {
			snap = GramSnapshot{Phase: "loading", Messages: []GramMessage{}, Agents: []GramAgent{}, Attachments: []GramAttachment{}}
		}
		s.Grants = append(s.Grants, GuestGramState{Grant: grant, Gram: snap})
	}
	return s
}

func (h *guestGramHub) publish() {
	if h.d.guestGram.Load() != h {
		return
	}
	GuestGramChanged.Broadcast(h.snapshot())
}

// link is the shared agent id's link, or nil.
func (h *guestGramHub) link(id string) *link {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.links[id]
}

// GuestGramState returns the combined guest Gram (Active false while none runs).
func (d *Desk) GuestGramState() GuestGramSnapshot {
	if h := d.guestGram.Load(); h != nil {
		return h.snapshot()
	}
	return GuestGramSnapshot{Grants: []GuestGramState{}}
}

// GuestGramSetVisible tells every shared agent's Gram whether the Gram tab
// shows (GramSetVisible).
func (d *Desk) GuestGramSetVisible(visible bool) {
	h := d.guestGram.Load()
	if h == nil {
		return
	}
	h.mu.Lock()
	h.visible = visible
	links := make([]*link, 0, len(h.links))
	for _, l := range h.links {
		links = append(links, l)
	}
	h.mu.Unlock()
	for _, l := range links {
		d.gramSetVisibleOn(l.gram, visible)
	}
}

// GuestGramSetRecipient chooses the shared agent the composer posts to. Files
// already attached have uploaded to the current one's host and go with it, so
// the recipient holds until they are sent or removed.
func (d *Desk) GuestGramSetRecipient(grant string) error {
	h := d.guestGram.Load()
	if h == nil {
		return errNotConnected
	}
	if l := h.link(grant); l == nil || l.gram == nil {
		return errors.New("This shared agent doesn't share Gram")
	}
	h.mu.Lock()
	current := h.links[h.recipient]
	h.mu.Unlock()
	if current != nil && current.access.ID() != grant {
		g := current.gram
		g.mu.Lock()
		attached := g.composer != nil && len(g.composer.Snapshot().Chips) > 0
		g.mu.Unlock()
		if attached {
			return errors.New("Send or remove the attached files before writing to another agent")
		}
	}
	h.mu.Lock()
	h.recipient = grant
	h.mu.Unlock()
	h.publish()
	return nil
}

// GuestGramLoadOlder pages the shared agents the page names (the merge's
// plan: those at or above the safe floor), together, and reports whether any
// list grew.
func (d *Desk) GuestGramLoadOlder(ctx context.Context, grants []string) (bool, error) {
	h := d.guestGram.Load()
	if h == nil {
		return false, errNotConnected
	}
	type result struct {
		grew bool
		err  error
	}
	results := make([]result, len(grants))
	var wg sync.WaitGroup
	for i, id := range grants {
		l := h.link(id)
		if l == nil || l.gram == nil {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			grew, err := d.gramLoadOlder(ctx, l)
			results[i] = result{grew, err}
		}()
	}
	wg.Wait()
	var errs []error
	grew := false
	for _, r := range results {
		grew = grew || r.grew
		if r.err != nil {
			errs = append(errs, r.err)
		}
	}
	return grew, errors.Join(errs...)
}

// GuestGramRefresh refreshes the named shared agents (every one when none).
func (d *Desk) GuestGramRefresh(ctx context.Context, grants []string) {
	for _, l := range d.guestGramLinks(grants) {
		l.work.Go(func() { d.gramRefresh(context.WithoutCancel(ctx), l) })
	}
}

// GuestGramMarkAllRead marks the named shared agents' messages read (every
// one when none).
func (d *Desk) GuestGramMarkAllRead(ctx context.Context, grants []string) error {
	var errs []error
	for _, l := range d.guestGramLinks(grants) {
		errs = append(errs, d.gramMarkAllRead(ctx, l))
	}
	return errors.Join(errs...)
}

func (d *Desk) guestGramLinks(grants []string) []*link {
	h := d.guestGram.Load()
	if h == nil {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	out := []*link{}
	for _, id := range h.order {
		l := h.links[id]
		if l == nil || l.gram == nil || len(grants) > 0 && !slices.Contains(grants, id) {
			continue
		}
		out = append(out, l)
	}
	return out
}

// gramLinkFor is the connection a Gram message id belongs to and its id
// there: a shared agent's for "<grant>\x1f<id>" while the combined guest Gram
// runs, else Desk.gram's.
func (d *Desk) gramLinkFor(id string) (*link, string, error) {
	if grant, raw, ok := strings.Cut(id, guestGramSep); ok {
		if h := d.guestGram.Load(); h != nil {
			if l := h.link(grant); l != nil && l.gram != nil {
				return l, raw, nil
			}
		}
		return nil, "", errNotConnected
	}
	l, err := d.gramLink()
	return l, id, err
}

// gramComposerLink is the connection a composer call goes through: in the
// combined guest Gram the shared agent the page routed it to (h.recipient,
// which the page sets to the "to" it shows before a file or a post leaves,
// and which holds while files are attached), else Desk.gram's.
func (d *Desk) gramComposerLink() (*link, error) {
	if h := d.guestGram.Load(); h != nil {
		h.mu.Lock()
		l := h.links[h.recipient]
		h.mu.Unlock()
		if l == nil || l.gram == nil {
			return nil, errors.New("Choose who the message goes to")
		}
		return l, nil
	}
	return d.gramLink()
}

// attachmentLink is the connection a Chat attachment downloads through: the
// shared agent the page shows, by its combined guest Gram link (the agent
// page's own has no Gram state), else the owner's Gram connection.
func (d *Desk) attachmentLink() (*link, error) {
	// The share's ID is read under d.mu: runGuest rewrites the access (its agent's name) under it.
	d.mu.Lock()
	active := d.link
	shared := active != nil && active.guest != nil
	var shareID string
	if shared {
		shareID = active.access.ID()
	}
	d.mu.Unlock()
	if shared {
		if h := d.guestGram.Load(); h != nil {
			if l := h.link(shareID); l != nil && l.gram != nil {
				return l, nil
			}
		}
		return nil, errors.New("Gram is not enabled for this shared agent")
	}
	return d.gramLink()
}
