package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"github.com/jerryfane/herdrup-desktop/internal/bridge"
	"github.com/jerryfane/herdrup-desktop/internal/engine"
	"github.com/jerryfane/herdrup-desktop/internal/herdr"
	"github.com/jerryfane/herdrup-desktop/internal/herdrapi"
)

// The owner's agent folders and stars (herdrup#552, App/AgentGroupsStore
// .swift) and which folders are open on this device.

// FolderNaming asks the window for a folder name: a new folder holding
// Member ("new"), or a new name for Folder ("rename"), as herdrup's
// "New folder" and "Rename folder" alerts.
type FolderNaming struct {
	// Kind is "new" or "rename".
	Kind   string `json:"kind"`
	Folder string `json:"folder"`
	Member string `json:"member"`
	// Name is the field's text to start with: the folder's name for a
	// rename, "" for a new folder.
	Name string `json:"name"`
}

// FolderNamingRequested is sent when a menu asks for a folder name; the
// window answers with Desk.NameFolder.
var FolderNamingRequested = mygo.NewEvent[FolderNaming]("folder-naming:requested")

// groupsRefreshInterval is how often a connected list re-reads the
// document, so another device's change shows without reconnecting.
const groupsRefreshInterval = 60 * time.Second

// Save failures, as herdrup words them (AgentGroupsStore.send).
const (
	groupsConflictMessage = "Your folders changed on another device at the same time. Try again."
	groupsAlertTitle      = "Couldn't save folders"
)

// groupsStore is the folder document of one connection and session. It is
// made anew for every connection and session switch, so each loads the
// document again. Nothing shows until the server advertises agent_groups
// and the first agent.groups.get answered: an older server, or a guest,
// sees the plain list.
//
// An edit shows at once: the document is the server's last one with this
// device's unsent edits applied. Edits are sent one at a time; on
// groups_conflict the edit is applied once more to the server's current
// document and sent again. An edit that still fails is dropped and alert
// says why.
type groupsStore struct {
	// changed is called, without the store's lock, when what the list
	// shows changed. alert shows a save that failed.
	changed func()
	alert   func(message string)
	// open persists the open folders.
	open *openFolders
	key  string

	mu        sync.Mutex
	client    *engine.Client
	supported bool
	confirmed *herdr.Groups
	pending   []herdr.Edit
	sending   bool
	fetching  bool
	lastFetch time.Time
	now       func() time.Time
}

func newGroupsStore(open *openFolders, key string, changed func(), alert func(string)) *groupsStore {
	return &groupsStore{open: open, key: key, changed: changed, alert: alert, now: time.Now}
}

// attach binds the store to the connection and the ping's capabilities.
func (s *groupsStore) attach(c *engine.Client, pong herdrapi.ResponseResultPong) {
	s.mu.Lock()
	s.client = c
	s.supported = herdrapi.CapabilityAgentGroups.Supported(pong.Capabilities)
	s.mu.Unlock()
}

// document is what the list draws: nil while folders are unavailable.
func (s *groupsStore) document() *herdr.Groups {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.documentLocked()
}

func (s *groupsStore) documentLocked() *herdr.Groups {
	if !s.supported || s.confirmed == nil {
		return nil
	}
	g := *s.confirmed
	for _, e := range s.pending {
		g = e.Apply(g)
	}
	return &g
}

// view is the board's layout with this store's folders.
func (s *groupsStore) view() herdr.View {
	return herdr.View{Groups: s.document(), Open: s.open.get(s.key)}
}

// off hides everything, for a server that turned out not to have folders
// or a guest.
func (s *groupsStore) off() {
	s.mu.Lock()
	s.supported, s.confirmed, s.pending = false, nil, nil
	s.mu.Unlock()
	s.changed()
}

// refresh loads the document on first use, then at most once a minute
// unless force. It is skipped while an edit is unsent, so a read cannot
// undo it on screen.
func (s *groupsStore) refresh(ctx context.Context, force bool) {
	s.mu.Lock()
	now := s.now()
	if !s.supported || s.client == nil || s.fetching || len(s.pending) > 0 ||
		(!force && !s.lastFetch.IsZero() && now.Sub(s.lastFetch) < groupsRefreshInterval) {
		s.mu.Unlock()
		return
	}
	s.fetching = true
	c := s.client
	s.mu.Unlock()

	fetched, err := c.AgentGroupsGet(ctx)

	s.mu.Lock()
	s.fetching = false
	if err != nil {
		s.mu.Unlock()
		if groupsOff(err) {
			s.off()
		}
		// A transport hiccup keeps what is shown; a later list retries.
		return
	}
	s.lastFetch = now
	// A save that answered meanwhile may hold a newer revision.
	if !s.supported || len(s.pending) > 0 || (s.confirmed != nil && fetched.Revision < s.confirmed.Revision) {
		s.mu.Unlock()
		return
	}
	before := s.documentLocked()
	s.confirmed = &fetched
	after := s.documentLocked()
	s.mu.Unlock()
	if before == nil || !herdr.GroupsEqual(*before, *after) {
		s.changed()
	}
}

// groupsOff reports an error that means folders are not available: a
// server that predates agent.groups, or a guest.
func groupsOff(err error) bool {
	var unsupported *engine.ErrUnsupported
	var api *bridge.APIError
	return errors.As(err, &unsupported) || (errors.As(err, &api) && api.Code == "guest_forbidden")
}

// apply shows e at once and queues it for the server.
func (s *groupsStore) apply(ctx context.Context, e herdr.Edit) {
	s.mu.Lock()
	if s.documentLocked() == nil {
		s.mu.Unlock()
		return
	}
	s.pending = append(s.pending, e)
	start := !s.sending
	s.sending = true
	s.mu.Unlock()
	s.changed()
	if start {
		go s.send(ctx)
	}
}

// createFolder adds a folder named raw (trimmed, at most 64 characters)
// holding member, and opens it on this device so the agent just moved
// stays in sight.
func (s *groupsStore) createFolder(ctx context.Context, raw, member string) {
	name := herdr.FolderName(raw)
	if name == "" {
		return
	}
	id := herdr.NewFolderID()
	s.open.set(s.key, id, true)
	s.apply(ctx, herdr.Edit{Kind: herdr.EditAddFolder, Folder: id, Text: name, Name: member})
}

// setOpen opens or closes a folder on this device.
func (s *groupsStore) setOpen(id string, open bool) {
	if s.open.set(s.key, id, open) {
		s.changed()
	}
}

// send saves the pending edits one at a time (AgentGroupsDocument.commit).
func (s *groupsStore) send(ctx context.Context) {
	for {
		s.mu.Lock()
		if len(s.pending) == 0 || s.confirmed == nil || s.client == nil {
			s.sending = false
			s.mu.Unlock()
			return
		}
		e, base, c := s.pending[0], *s.confirmed, s.client
		s.mu.Unlock()

		saved, failure, off := commit(ctx, c, e, base)
		if off {
			s.mu.Lock()
			s.sending = false
			s.mu.Unlock()
			s.off()
			return
		}
		s.mu.Lock()
		if saved != nil {
			s.confirmed = saved
		}
		if len(s.pending) > 0 {
			s.pending = s.pending[1:]
		}
		s.mu.Unlock()
		s.changed()
		if failure != "" && s.alert != nil {
			s.alert(failure)
		}
	}
}

// commit sends e made on base. On groups_conflict it applies e once more
// to the server's current document and sends that; a second conflict
// gives up with the newest document. A replay that fails otherwise still
// returns the document the conflict reported, the newest the server has
// confirmed (#37). An edit that changes nothing is not sent. off is true
// when the server has no folders for this connection.
func commit(ctx context.Context, c *engine.Client, e herdr.Edit, base herdr.Groups) (saved *herdr.Groups, failure string, off bool) {
	set := func(g herdr.Groups) (herdr.Groups, error) {
		return c.AgentGroupsSet(ctx, herdrapi.AgentGroupsSetParams{Revision: g.Revision, Folders: g.Folders, Stars: nonNil(g.Stars)})
	}
	next := e.Apply(base)
	if herdr.GroupsEqual(next, base) {
		return &base, "", false
	}
	r, err := set(next)
	// known is the newest document the server has confirmed, nil while
	// that is still base.
	var known *herdr.Groups
	var conflict *engine.GroupsConflictError
	if errors.As(err, &conflict) {
		current := conflict.Current
		known = &current
		replayed := e.Apply(current)
		if herdr.GroupsEqual(replayed, current) {
			return known, "", false
		}
		r, err = set(replayed)
		if errors.As(err, &conflict) {
			return &conflict.Current, groupsConflictMessage, false
		}
	}
	var api *bridge.APIError
	switch {
	case err == nil:
		return &r, "", false
	case groupsOff(err):
		return nil, "", true
	case errors.As(err, &api) && api.Code == "invalid_groups":
		return known, "The server refused the change: " + api.Message, false
	}
	return known, "Couldn't save folders: " + err.Error(), false
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// openFoldersKey is where the open folders of a machine's session are
// kept: herdrup's HostKey.canonical(host, port), plus "#session" for a
// named session (SessionChoice.storeKey).
func openFoldersKey(host string, port int, session string) string {
	h := strings.TrimSpace(host)
	if strings.HasPrefix(h, "[") && strings.HasSuffix(h, "]") {
		h = h[1 : len(h)-1]
	}
	h = strings.TrimRight(strings.ToLower(h), ".")
	key := h + ":" + strconv.Itoa(port)
	if session != "" && session != "default" {
		key += "#" + session
	}
	return key
}

// openFolders is open-folders.json: the folder ids open on this device,
// per machine and session, sorted. Never synced.
type openFolders struct {
	path string

	mu     sync.Mutex
	loaded bool
	byKey  map[string][]string
}

func (o *openFolders) loadLocked() {
	if o.loaded {
		return
	}
	o.loaded = true
	o.byKey = map[string][]string{}
	data, err := os.ReadFile(o.path)
	if err != nil {
		return
	}
	_ = json.Unmarshal(data, &o.byKey)
}

// get returns the open folders of key.
func (o *openFolders) get(key string) map[string]bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.loadLocked()
	open := map[string]bool{}
	for _, id := range o.byKey[key] {
		open[id] = true
	}
	return open
}

// set opens or closes id under key and saves the file; it reports whether
// anything changed.
func (o *openFolders) set(key, id string, open bool) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.loadLocked()
	ids := o.byKey[key]
	has := slices.Contains(ids, id)
	if has == open {
		return false
	}
	if open {
		ids = append(slices.Clone(ids), id)
		slices.Sort(ids)
	} else {
		ids = slices.DeleteFunc(slices.Clone(ids), func(s string) bool { return s == id })
	}
	if len(ids) == 0 {
		delete(o.byKey, key)
	} else {
		o.byKey[key] = ids
	}
	// Open folders are a convenience: a failed write only forgets them.
	if data, err := json.MarshalIndent(o.byKey, "", "  "); err == nil {
		_ = os.WriteFile(o.path, data, 0o600)
	}
	return true
}

// ---- Bound methods ----

// groupsLink returns the current connection's folders, nil without one.
func (d *Desk) groupsLink() (*link, *groupsStore) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.link == nil || d.link.groups == nil {
		return nil, nil
	}
	return d.link, d.link.groups
}

// SetFolderOpen opens or closes a folder on this device.
func (d *Desk) SetFolderOpen(id string, open bool) {
	if _, g := d.groupsLink(); g != nil {
		g.setOpen(id, open)
	}
}

// NameFolder answers a FolderNamingRequested: it creates the folder or
// renames it. A name with nothing left once trimmed does nothing.
func (d *Desk) NameFolder(n FolderNaming, text string) {
	l, g := d.groupsLink()
	if g == nil {
		return
	}
	switch n.Kind {
	case "new":
		g.createFolder(l.ctx, text, n.Member)
	case "rename":
		if name := herdr.FolderName(text); name != "" {
			g.apply(l.ctx, herdr.Edit{Kind: herdr.EditRenameFolder, Folder: n.Folder, Text: name})
		}
	}
}

// SearchBoard is the board for a sidebar search: the agents query matches,
// every folder open, no empty folders (herdrup rosterLayout). Nil before
// the first list.
func (d *Desk) SearchBoard(query string) *herdr.Board {
	d.mu.Lock()
	l := d.link
	if l == nil || l.groups == nil || d.board == nil {
		d.mu.Unlock()
		return nil
	}
	// Both read under d.mu: SelectSession replaces l.groups (and l.agents)
	// under the same lock, so reading l.groups after unlocking could see nil.
	agents, groups := l.agents, l.groups
	d.mu.Unlock()
	v := groups.view()
	v.Query = query
	b := herdr.BuildBoard(agents, v)
	return &b
}

// menuEntry is one context-menu item: an edit to apply, a folder name to
// ask for, or a submenu.
type menuEntry struct {
	Label  string
	Edit   *herdr.Edit
	Naming *FolderNaming
	Sub    []menuEntry
}

// agentMenu is an agent row's folder items (herdrup HerdrApp.swift agent
// context menu and folderMenuItems): Star or Unstar, then "Move to folder"
// with every other folder, "New folder…", and "Remove from <folder>" when
// it is in one. None without folders or for an agent with no name.
func agentMenu(g *herdr.Groups, name string) []menuEntry {
	if g == nil || name == "" {
		return nil
	}
	starred := herdr.IsStarred(*g, name)
	star := menuEntry{Label: "Star", Edit: &herdr.Edit{Kind: herdr.EditSetStar, Name: name, Star: true}}
	if starred {
		star = menuEntry{Label: "Unstar", Edit: &herdr.Edit{Kind: herdr.EditSetStar, Name: name}}
	}
	current := herdr.FolderOf(*g, name)
	var sub []menuEntry
	for _, f := range herdr.OrderedFolders(*g) {
		if current != nil && f.ID == current.ID {
			continue
		}
		sub = append(sub, menuEntry{Label: f.Name, Edit: &herdr.Edit{Kind: herdr.EditMove, Name: name, Folder: f.ID}})
	}
	sub = append(sub, menuEntry{Label: "New folder…", Naming: &FolderNaming{Kind: "new", Member: name}})
	if current != nil {
		sub = append(sub, menuEntry{Label: "Remove from " + current.Name, Edit: &herdr.Edit{Kind: herdr.EditRemoveFromFolder, Name: name}})
	}
	return []menuEntry{star, {Label: "Move to folder", Sub: sub}}
}

// folderMenu is a folder row's menu (herdrup folderRow): Rename, Move up
// unless first, Move down unless last, Delete folder.
func folderMenu(g *herdr.Groups, id string) []menuEntry {
	if g == nil {
		return nil
	}
	ordered := herdr.OrderedFolders(*g)
	i := slices.IndexFunc(ordered, func(f herdrapi.AgentGroupFolder) bool { return f.ID == id })
	if i < 0 {
		return nil
	}
	out := []menuEntry{{Label: "Rename", Naming: &FolderNaming{Kind: "rename", Folder: id, Name: ordered[i].Name}}}
	if i > 0 {
		out = append(out, menuEntry{Label: "Move up", Edit: &herdr.Edit{Kind: herdr.EditMoveFolder, Folder: id, By: -1}})
	}
	if i < len(ordered)-1 {
		out = append(out, menuEntry{Label: "Move down", Edit: &herdr.Edit{Kind: herdr.EditMoveFolder, Folder: id, By: 1}})
	}
	return append(out, menuEntry{Label: "Delete folder", Edit: &herdr.Edit{Kind: herdr.EditDeleteFolder, Folder: id}})
}

// choose carries out a menu entry.
func (d *Desk) choose(l *link, g *groupsStore, e menuEntry) {
	switch {
	case e.Edit != nil:
		g.apply(l.ctx, *e.Edit)
	case e.Naming != nil:
		_ = FolderNamingRequested.Broadcast(*e.Naming)
	}
}

func (d *Desk) menuItems(l *link, g *groupsStore, entries []menuEntry) []*mygo.MenuItem {
	items := make([]*mygo.MenuItem, 0, len(entries))
	for _, e := range entries {
		item := &mygo.MenuItem{Label: e.Label}
		if e.Sub != nil {
			item.Submenu = d.menuItems(l, g, e.Sub)
		} else {
			item.Click = func(*mygo.MenuItem, *mygo.Window) { d.choose(l, g, e) }
		}
		items = append(items, item)
	}
	return items
}

// popup shows entries as a context menu at the mouse; it reports whether
// there was anything to show.
func (d *Desk) popup(ctx context.Context, l *link, g *groupsStore, entries []menuEntry) bool {
	if len(entries) == 0 {
		return false
	}
	mygo.NewMenu(d.menuItems(l, g, entries)).Popup(mygo.CallerWindow(ctx))
	return true
}

// AgentMenu shows an agent row's context menu (right-click); it reports
// whether there was one.
func (d *Desk) AgentMenu(ctx context.Context, paneID string) bool {
	l, g := d.groupsLink()
	if g == nil {
		return false
	}
	d.mu.Lock()
	name := ""
	for _, a := range l.agents {
		if a.PaneID == paneID && a.Name != nil {
			name = *a.Name
		}
	}
	d.mu.Unlock()
	return d.popup(ctx, l, g, agentMenu(g.document(), name))
}

// FolderMenu shows a folder row's context menu (right-click); it reports
// whether there was one.
func (d *Desk) FolderMenu(ctx context.Context, id string) bool {
	l, g := d.groupsLink()
	if g == nil {
		return false
	}
	return d.popup(ctx, l, g, folderMenu(g.document(), id))
}

// alertGroups shows a folder save that failed, as herdrup's "Couldn't save
// folders" alert.
func alertGroups(message string) {
	_, _ = mygo.Dialog.Message(mygo.MessageOptions{Type: mygo.MessageWarning, Message: groupsAlertTitle, Detail: message})
}
