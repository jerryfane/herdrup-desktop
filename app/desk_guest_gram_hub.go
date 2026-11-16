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
// so each polls as the owner's Gram does; every other poll is a relay connect,
// and the relay allows a network 30 a minute for everything a guest does, so
// those hosts share about 12 a minute between them.
func guestGramPolls(multi bool, singles int) (visible, badge time.Duration) {
	if multi || singles <= 1 {
		return gramPollVisible, max(gramPollBadge, 30*time.Second)
	}
	return max(gramPollVisible, time.Duration(singles)*5*time.Second), max(30*time.Second, time.Duration(singles)*10*time.Second)
}

// startGuestGram starts the combined guest Gram, or brings a running one up
// to date with the saved shared agents.
func (d *Desk) startGuestGram() {
	h := d.guestGram.Load()
	if h == nil {
		ctx, cancel := context.WithCancel(context.Background())
		h = &guestGramHub{d: d, ctx: ctx, cancel: cancel, links: map[string]*link{}, grants: map[string]GuestGramGrant{}, snaps: map[string]GramSnapshot{}}
		if !d.guestGram.CompareAndSwap(nil, h) {
			cancel()
			h = d.guestGram.Load()
		}
	}
	h.sync()
}

// stopGuestGram ends the combined guest Gram (the owner connected, or nothing
// is shared any more).
func (d *Desk) stopGuestGram() {
	h := d.guestGram.Swap(nil)
	if h == nil {
		return
	}
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
	GuestGramChanged.Broadcast(GuestGramSnapshot{Grants: []GuestGramState{}})
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
	h.order = h.order[:0]
	for _, access := range list {
		id := access.ID()
		saved[id] = true
		h.order = append(h.order, id)
		if h.links[id] != nil {
			continue
		}
		access := access
		transport := guest.NewTransport(access, identity, d.guestClock)
		ctx, cancel := context.WithCancel(h.ctx)
		l := &link{id: "guest-gram:" + id, guest: transport, guestClient: engine.New(transport), access: &access, ctx: ctx, cancelGram: cancel}
		l.gram = &gramDesk{hub: h, prefix: id + guestGramSep}
		h.links[id] = l
		h.grants[id] = GuestGramGrant{ID: id, Agent: access.AgentName, Owner: access.OwnerName, Machine: access.MachineLabel}
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
		go h.run(l)
	}
	h.publish()
}

// run reads one shared agent: its first agent list says whether its owner
// shares Gram; then its Gram is polled until the grant is dropped.
func (h *guestGramHub) run(l *link) {
	d := h.d
	ctx := l.ctx
	defer l.guest.Close()
	stop := context.AfterFunc(ctx, func() { _ = l.guest.Close() })
	defer stop()
	id := l.access.ID()
	for ctx.Err() == nil {
		_, _, err := l.guestClient.GuestAgentList(ctx)
		if ctx.Err() != nil {
			return
		}
		if err == nil {
			break
		}
		h.setGrant(id, func(g *GuestGramGrant) { g.Error = err.Error() })
		if errors.Is(err, guest.ErrRevoked) {
			return
		}
		wait := 30 * time.Second
		if errors.Is(err, guest.ErrRateLimited) {
			wait = max(wait, l.guest.RateLimitedUntil().Sub(d.guestClock.Now()))
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
	features := l.guest.Features()
	h.setGrant(id, func(g *GuestGramGrant) { g.Ready, g.Gram, g.Error = true, features.Gram, "" })
	if !features.Gram {
		return
	}
	d.gramReset(l, l.access.MachineLabel)
	h.mu.Lock()
	visible := h.visible
	h.mu.Unlock()
	h.repoll()
	if visible {
		d.gramSetVisibleOn(l.gram, true)
	}
	d.watchGram(ctx, l)
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
		visible, badge := guestGramPolls(l.guest.Features().MultiRequest, singles)
		g := l.gram
		g.mu.Lock()
		g.pollVisible, g.pollBadge = visible, badge
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
	s := GuestGramSnapshot{Active: true, Grants: make([]GuestGramState, 0, len(h.order)), Recipient: h.recipient}
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

// GuestGramSetRecipient chooses the shared agent the composer posts to; its
// files upload to that agent's host, so the page changes it only while no
// file is attached.
func (d *Desk) GuestGramSetRecipient(grant string) error {
	h := d.guestGram.Load()
	if h == nil {
		return errNotConnected
	}
	if l := h.link(grant); l == nil || l.gram == nil {
		return errors.New("This shared agent doesn't share Gram")
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
		go d.gramRefresh(context.WithoutCancel(ctx), l)
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

// gramComposerLink is the connection the composer posts through: the chosen
// shared agent's while the combined guest Gram runs, else Desk.gram's.
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
